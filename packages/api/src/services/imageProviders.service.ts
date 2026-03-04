/**
 * Image Provider Adapters
 *
 * 각 이미지 생성 provider별로 다른 프로토콜을 사용하여
 * 이미지를 생성하고 Buffer로 반환하는 어댑터 모음.
 *
 * Supported providers:
 *   OPENAI  - POST /v1/images/generations (OpenAI DALL-E)
 *   COMFYUI - POST /prompt → poll /history → GET /view
 *   GEMINI  - POST /v1beta/models/{model}:generateContent
 *   PIXABAY - GET /api/?key=...&q=...
 *   PEXELS  - GET /v1/search?query=... (Authorization header)
 */

import { randomUUID } from 'node:crypto';

// ============================================
// Types
// ============================================

export interface ImageEndpointInfo {
  endpointUrl: string;
  apiKey: string | null;
  modelName: string;
  extraHeaders: Record<string, string> | null;
  extraBody: Record<string, any> | null;
}

export interface ImageProviderResult {
  imageBuffer: Buffer;
  mimeType: string;
  revisedPrompt?: string;
}

export interface ImageGenOptions {
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  style?: string;
  negativePrompt?: string;
}

// ============================================
// Main Dispatcher
// ============================================

export async function generateImages(
  provider: string,
  endpoint: ImageEndpointInfo,
  options: ImageGenOptions,
): Promise<ImageProviderResult[]> {
  const p = (provider || 'OPENAI').toUpperCase();
  switch (p) {
    case 'OPENAI':
      return generateWithOpenAI(endpoint, options);
    case 'COMFYUI':
      return generateWithComfyUI(endpoint, options);
    case 'GEMINI':
      return generateWithGemini(endpoint, options);
    case 'PIXABAY':
      return searchPixabay(endpoint, options);
    case 'PEXELS':
      return searchPexels(endpoint, options);
    default:
      throw new Error(`Unsupported image provider: ${provider}`);
  }
}

// ============================================
// OPENAI Adapter
// ============================================

function buildImagesGenerationsUrl(endpointUrl: string): string {
  let url = endpointUrl.trim();
  if (url.endsWith('/images/generations')) return url;
  if (url.endsWith('/')) url = url.slice(0, -1);
  if (url.endsWith('/v1')) return `${url}/images/generations`;
  if (url.endsWith('/chat/completions')) {
    url = url.replace(/\/chat\/completions$/, '');
  } else if (url.endsWith('/embeddings')) {
    url = url.replace(/\/embeddings$/, '');
  } else if (url.endsWith('/rerank')) {
    url = url.replace(/\/rerank$/, '');
  }
  return `${url}/images/generations`;
}

async function generateWithOpenAI(
  endpoint: ImageEndpointInfo,
  options: ImageGenOptions,
): Promise<ImageProviderResult[]> {
  const url = buildImagesGenerationsUrl(endpoint.endpointUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (endpoint.apiKey) headers['Authorization'] = `Bearer ${endpoint.apiKey}`;
  if (endpoint.extraHeaders) {
    for (const [k, v] of Object.entries(endpoint.extraHeaders)) {
      const lk = k.toLowerCase();
      if (lk !== 'content-type' && lk !== 'authorization') headers[k] = v;
    }
  }

  const body: Record<string, any> = {
    model: endpoint.modelName,
    prompt: options.prompt,
    response_format: 'b64_json',
  };
  if (options.n) body.n = options.n;
  if (options.size) body.size = options.size;
  if (options.quality) body.quality = options.quality;
  if (options.style) body.style = options.style;
  if (endpoint.extraBody) {
    const { workflow, positiveNodeId, negativeNodeId, outputFolder, defaultNegative, ...rest } = endpoint.extraBody;
    Object.assign(body, rest);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      data?: Array<{ url?: string; b64_json?: string; revised_prompt?: string }>;
    };

    if (!data.data || !Array.isArray(data.data) || data.data.length === 0) {
      throw new Error('OpenAI returned empty data');
    }

    const results: ImageProviderResult[] = [];
    for (const item of data.data) {
      let imageBuffer: Buffer | null = null;
      let mimeType = 'image/png';

      if (item.b64_json) {
        imageBuffer = Buffer.from(item.b64_json, 'base64');
      } else if (item.url) {
        const dlCtrl = new AbortController();
        const dlTimeout = setTimeout(() => dlCtrl.abort(), 30_000);
        try {
          const dl = await fetch(item.url, { signal: dlCtrl.signal });
          if (dl.ok) {
            const ct = dl.headers.get('content-type');
            if (ct && ct.startsWith('image/')) mimeType = ct.split(';')[0]!;
            imageBuffer = Buffer.from(await dl.arrayBuffer());
          }
        } catch (e) {
          console.warn(`[ImageProvider/OpenAI] Failed to download image from ${item.url}:`, e);
        } finally {
          clearTimeout(dlTimeout);
        }
      }

      if (imageBuffer) {
        results.push({ imageBuffer, mimeType, revisedPrompt: item.revised_prompt });
      }
    }

    if (results.length === 0) {
      throw new Error('Failed to retrieve any images from OpenAI response');
    }

    return results;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================
// COMFYUI Adapter
// ============================================

async function generateWithComfyUI(
  endpoint: ImageEndpointInfo,
  options: ImageGenOptions,
): Promise<ImageProviderResult[]> {
  const baseUrl = endpoint.endpointUrl.replace(/\/+$/, '');
  const extra = endpoint.extraBody || {};

  // Load workflow from extraBody
  const workflow = extra.workflow;
  if (!workflow || typeof workflow !== 'object') {
    throw new Error('ComfyUI requires workflow JSON in extraBody.workflow');
  }

  // Deep clone workflow to avoid mutation
  const prompt = JSON.parse(JSON.stringify(workflow));

  // Patch CLIPTextEncode nodes (prompt injection)
  const positiveNodeId = extra.positiveNodeId || '45';
  const negativeNodeId = extra.negativeNodeId || '';
  const defaultNegative = extra.defaultNegative || '';

  for (const [nid, node] of Object.entries(prompt) as [string, any][]) {
    if (node.class_type === 'CLIPTextEncode') {
      if (nid === positiveNodeId) {
        node.inputs.text = options.prompt;
      } else if (negativeNodeId && nid === negativeNodeId) {
        node.inputs.text = options.negativePrompt || defaultNegative;
      }
    }
    // Randomize KSampler seed for unique images each generation
    if (node.class_type === 'KSampler' && node.inputs?.seed !== undefined) {
      node.inputs.seed = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER);
    }
  }

  // Generate unique client_id
  const clientId = `proxy_${randomUUID().slice(0, 8)}`;
  const outputFolder = extra.outputFolder || 'api_generated';

  // Headers (ComfyUI usually doesn't need auth, but support it)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (endpoint.apiKey) headers['Authorization'] = `Bearer ${endpoint.apiKey}`;
  if (endpoint.extraHeaders) Object.assign(headers, endpoint.extraHeaders);

  // Step 1: POST /prompt
  const promptPayload = {
    prompt,
    output_folder: outputFolder,
    client_id: clientId,
  };

  const promptResponse = await fetch(`${baseUrl}/prompt`, {
    method: 'POST',
    headers,
    body: JSON.stringify(promptPayload),
  });

  if (!promptResponse.ok) {
    const errText = await promptResponse.text();
    throw new Error(`ComfyUI /prompt failed ${promptResponse.status}: ${errText.slice(0, 500)}`);
  }

  const promptData = (await promptResponse.json()) as { prompt_id: string };
  const promptId = promptData.prompt_id;

  // Step 2: Poll /history
  const deadline = Date.now() + 120_000; // 120 seconds timeout
  let historyEntry: any = null;

  while (Date.now() < deadline) {
    const pollCtrl = new AbortController();
    const pollTimeout = setTimeout(() => pollCtrl.abort(), 10_000);
    try {
      const historyResponse = await fetch(`${baseUrl}/history`, { headers, signal: pollCtrl.signal });
      clearTimeout(pollTimeout);
      if (historyResponse.ok) {
        const history = (await historyResponse.json()) as Record<string, any>;
        const entry = history[promptId];
        if (entry) {
          const completed = entry.status?.completed;
          if (completed) {
            historyEntry = entry;
            break;
          }
          if (entry.status?.status === 'error') {
            throw new Error(`ComfyUI error: ${JSON.stringify(entry.error || 'unknown')}`);
          }
        }
      }
    } catch (e: any) {
      clearTimeout(pollTimeout);
      if (e.message?.includes('ComfyUI error')) throw e; // Re-throw ComfyUI errors
      // Ignore poll timeout/network errors, retry
    }
    await sleep(1000);
  }

  if (!historyEntry) {
    throw new Error(`ComfyUI prompt ${promptId} timed out after 120s`);
  }

  // Step 3: Download image from /view
  const outputs = historyEntry.outputs || {};
  const results: ImageProviderResult[] = [];

  for (const outNode of Object.values(outputs) as any[]) {
    for (const outData of Object.values(outNode) as any[]) {
      if (!Array.isArray(outData)) continue;
      for (const item of outData) {
        if (typeof item !== 'object' || !item.filename) continue;

        const filename = item.filename;
        const subfolder = item.subfolder || '';
        const serverPath = subfolder ? `output/${subfolder}/${filename}` : `output/${filename}`;
        const viewUrl = `${baseUrl}/view?filename=${encodeURIComponent(serverPath)}`;

        const imgResponse = await fetch(viewUrl, { headers });
        if (imgResponse.ok) {
          const ct = imgResponse.headers.get('content-type');
          const mimeType = (ct && ct.startsWith('image/')) ? ct.split(';')[0]! : 'image/png';
          const imageBuffer = Buffer.from(await imgResponse.arrayBuffer());
          results.push({ imageBuffer, mimeType });
        }

        // Only take the first image per request
        if (results.length >= (options.n || 1)) break;
      }
      if (results.length >= (options.n || 1)) break;
    }
    if (results.length >= (options.n || 1)) break;
  }

  if (results.length === 0) {
    throw new Error('Could not locate IMAGE output in ComfyUI history entry');
  }

  return results;
}

// ============================================
// GEMINI Adapter
// ============================================

async function generateWithGemini(
  endpoint: ImageEndpointInfo,
  options: ImageGenOptions,
): Promise<ImageProviderResult[]> {
  let baseUrl = endpoint.endpointUrl.replace(/\/+$/, '');
  const modelName = endpoint.modelName || 'gemini-2.0-flash-exp';

  // Build URL: {baseUrl}/v1beta/models/{model}:generateContent?key={apiKey}
  // If user already put the full URL, detect and use it
  let url: string;
  if (baseUrl.includes(':generateContent')) {
    url = baseUrl;
  } else {
    // Strip trailing path segments if any
    if (baseUrl.endsWith('/v1beta') || baseUrl.endsWith('/v1')) {
      url = `${baseUrl}/models/${modelName}:generateContent`;
    } else {
      url = `${baseUrl}/v1beta/models/${modelName}:generateContent`;
    }
  }

  // API key in query param (Gemini style)
  if (endpoint.apiKey) {
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}key=${endpoint.apiKey}`;
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (endpoint.extraHeaders) Object.assign(headers, endpoint.extraHeaders);

  const body = {
    contents: [{ parts: [{ text: options.prompt }] }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE'],
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{
            text?: string;
            inlineData?: { mimeType: string; data: string };
          }>;
        };
      }>;
    };

    const results: ImageProviderResult[] = [];
    const candidates = data.candidates || [];

    for (const candidate of candidates) {
      const parts = candidate.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData && part.inlineData.data) {
          const imageBuffer = Buffer.from(part.inlineData.data, 'base64');
          results.push({
            imageBuffer,
            mimeType: part.inlineData.mimeType || 'image/png',
          });
        }
      }
    }

    if (results.length === 0) {
      throw new Error('Gemini returned no image data in response');
    }

    return results.slice(0, options.n || 1);
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================
// PIXABAY Adapter
// ============================================

async function searchPixabay(
  endpoint: ImageEndpointInfo,
  options: ImageGenOptions,
): Promise<ImageProviderResult[]> {
  const baseUrl = endpoint.endpointUrl.replace(/\/+$/, '');
  const apiKey = endpoint.apiKey;
  if (!apiKey) throw new Error('Pixabay requires an API key');

  const perPage = options.n || 1;
  const query = encodeURIComponent(options.prompt);
  const url = `${baseUrl}?key=${apiKey}&q=${query}&per_page=${perPage}&image_type=photo`;

  const headers: Record<string, string> = {};
  if (endpoint.extraHeaders) Object.assign(headers, endpoint.extraHeaders);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Pixabay API error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      hits?: Array<{ largeImageURL?: string; webformatURL?: string }>;
    };

    if (!data.hits || data.hits.length === 0) {
      throw new Error(`Pixabay: no images found for "${options.prompt}"`);
    }

    const results: ImageProviderResult[] = [];
    for (const hit of data.hits.slice(0, perPage)) {
      const imgUrl = hit.largeImageURL || hit.webformatURL;
      if (!imgUrl) continue;

      const dlCtrl = new AbortController();
      const dlTimeout = setTimeout(() => dlCtrl.abort(), 30_000);
      try {
        const dl = await fetch(imgUrl, { signal: dlCtrl.signal });
        if (dl.ok) {
          const ct = dl.headers.get('content-type');
          const mimeType = (ct && ct.startsWith('image/')) ? ct.split(';')[0]! : 'image/jpeg';
          const imageBuffer = Buffer.from(await dl.arrayBuffer());
          results.push({ imageBuffer, mimeType });
        }
      } catch (e) {
        console.warn(`[ImageProvider] Failed to download image from ${imgUrl}:`, e);
      } finally {
        clearTimeout(dlTimeout);
      }
    }

    if (results.length === 0) {
      throw new Error('Failed to download any images from Pixabay');
    }

    return results;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================
// PEXELS Adapter
// ============================================

async function searchPexels(
  endpoint: ImageEndpointInfo,
  options: ImageGenOptions,
): Promise<ImageProviderResult[]> {
  let baseUrl = endpoint.endpointUrl.replace(/\/+$/, '');
  const apiKey = endpoint.apiKey;
  if (!apiKey) throw new Error('Pexels requires an API key');

  const perPage = options.n || 1;
  const query = encodeURIComponent(options.prompt);

  // Build search URL
  let url: string;
  if (baseUrl.includes('/v1/search')) {
    url = `${baseUrl}?query=${query}&per_page=${perPage}`;
  } else {
    url = `${baseUrl}/v1/search?query=${query}&per_page=${perPage}`;
  }

  const headers: Record<string, string> = {
    'Authorization': apiKey,
  };
  if (endpoint.extraHeaders) Object.assign(headers, endpoint.extraHeaders);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30_000);

  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Pexels API error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await response.json()) as {
      photos?: Array<{ src?: { large?: string; original?: string } }>;
    };

    if (!data.photos || data.photos.length === 0) {
      throw new Error(`Pexels: no images found for "${options.prompt}"`);
    }

    const results: ImageProviderResult[] = [];
    for (const photo of data.photos.slice(0, perPage)) {
      const imgUrl = photo.src?.large || photo.src?.original;
      if (!imgUrl) continue;

      const dlCtrl = new AbortController();
      const dlTimeout = setTimeout(() => dlCtrl.abort(), 30_000);
      try {
        const dl = await fetch(imgUrl, { signal: dlCtrl.signal });
        if (dl.ok) {
          const ct = dl.headers.get('content-type');
          const mimeType = (ct && ct.startsWith('image/')) ? ct.split(';')[0]! : 'image/jpeg';
          const imageBuffer = Buffer.from(await dl.arrayBuffer());
          results.push({ imageBuffer, mimeType });
        }
      } catch (e) {
        console.warn(`[ImageProvider] Failed to download image from ${imgUrl}:`, e);
      } finally {
        clearTimeout(dlTimeout);
      }
    }

    if (results.length === 0) {
      throw new Error('Failed to download any images from Pexels');
    }

    return results;
  } finally {
    clearTimeout(timeoutId);
  }
}

// ============================================
// Helpers
// ============================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
