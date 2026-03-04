import { Router, Response } from 'express';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prisma } from '../index.js';
import { AuthenticatedRequest, requireWriteAccess } from '../middleware/dashboardAuth.js';

export const adminModelsRoutes = Router();

// ============================================
// VL Test Image: load once at module scope
// ============================================
let vlTestImageBase64: string | null = null;
try {
  const imagePath = join(process.cwd(), 'image.png');
  const imageBuffer = readFileSync(imagePath);
  vlTestImageBase64 = imageBuffer.toString('base64');
  console.log(`[VLTest] Test image loaded (${(imageBuffer.length / 1024).toFixed(0)} KB)`);
} catch (err) {
  console.warn('[VLTest] Could not load image.png for VL testing:', err);
}

// ============================================
// Helper: Health check a model endpoint
// ============================================
interface TestResult {
  passed: boolean;
  latencyMs: number;
  message: string;
  statusCode?: number;
  request?: Record<string, unknown>;
  response?: Record<string, unknown> | string;
}

function normalizeChatCompletionsUrl(endpointUrl: string): string {
  let url = endpointUrl.trim().replace(/\/+$/, '');
  if (url.endsWith('/chat/completions')) return url;
  if (url.endsWith('/v1')) return `${url}/chat/completions`;
  return `${url}/chat/completions`;
}

async function runSingleTest(
  testName: string,
  endpointUrl: string,
  apiKey: string | null | undefined,
  extraHeaders: Record<string, string> | null | undefined,
  body: Record<string, unknown>,
  validateToolCall = false
): Promise<TestResult> {
  const url = normalizeChatCompletionsUrl(endpointUrl);
  const model = body.model || 'unknown';
  const start = Date.now();

  // Sanitize request body for logging/frontend (truncate base64 images)
  const logBody = JSON.parse(JSON.stringify(body, (key, value) => {
    if (key === 'url' && typeof value === 'string' && value.startsWith('data:image/')) {
      return value.substring(0, 40) + '...[base64 truncated]';
    }
    return value;
  }));
  console.log(`[EndpointTest] ${testName} 시작 | model=${model} | url=${url}`);
  console.log(`[EndpointTest] ${testName} Request Body:`, JSON.stringify(logBody, null, 2));

  const fail = (latencyMs: number, message: string, extra?: { statusCode?: number; responseBody?: any }) => {
    const result: TestResult = {
      passed: false, latencyMs, message,
      statusCode: extra?.statusCode,
      request: logBody,
      response: extra?.responseBody,
    };
    console.error(`[EndpointTest] ${testName} FAIL | model=${model} | ${latencyMs}ms | ${message}`);
    if (extra?.responseBody) {
      console.error(`[EndpointTest] ${testName} Response Body:`, typeof extra.responseBody === 'string' ? extra.responseBody : JSON.stringify(extra.responseBody, null, 2));
    }
    return result;
  };

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (extraHeaders) Object.assign(headers, extraHeaders);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    const latencyMs = Date.now() - start;
    const rawText = await response.text().catch(() => '');

    // Try parse JSON
    let responseBody: Record<string, any> | null = null;
    try { responseBody = JSON.parse(rawText); } catch { /* keep null */ }

    if (!response.ok) {
      return fail(latencyMs, `HTTP ${response.status}: ${rawText.substring(0, 500)}`, { statusCode: response.status, responseBody: responseBody || rawText.substring(0, 1000) });
    }

    if (validateToolCall) {
      if (!responseBody) {
        return fail(latencyMs, 'Failed to parse response JSON', { statusCode: response.status, responseBody: rawText.substring(0, 1000) });
      }

      const choice = responseBody.choices?.[0];
      if (!choice) {
        return fail(latencyMs, 'No choices in response', { statusCode: response.status, responseBody });
      }

      const toolCalls = choice.message?.tool_calls;
      if (!toolCalls || !Array.isArray(toolCalls) || toolCalls.length === 0) {
        const content = choice.message?.content || '';
        if (content.includes('<tool_call>') || content.includes('<function')) {
          return fail(latencyMs, 'Model returns XML-style tool calls instead of OpenAI-compatible tool_calls format', { statusCode: response.status, responseBody });
        }
        return fail(latencyMs, `No tool_calls in response (finish_reason=${choice.finish_reason}). Model may not support function calling`, { statusCode: response.status, responseBody });
      }

      const tc = toolCalls[0];
      if (!tc.function?.name || typeof tc.function.arguments !== 'string') {
        return fail(latencyMs, 'Invalid tool_call structure: missing function.name or function.arguments', { statusCode: response.status, responseBody });
      }

      try {
        JSON.parse(tc.function.arguments);
      } catch {
        return fail(latencyMs, `tool_call arguments is not valid JSON: ${tc.function.arguments.substring(0, 200)}`, { statusCode: response.status, responseBody });
      }

      console.log(`[EndpointTest] ${testName} PASS | model=${model} | ${latencyMs}ms | function=${tc.function.name} args=${tc.function.arguments}`);
      console.log(`[EndpointTest] ${testName} Response Body:`, JSON.stringify(responseBody, null, 2));
      return { passed: true, latencyMs, message: 'OK', statusCode: response.status, request: logBody, response: responseBody };
    }

    console.log(`[EndpointTest] ${testName} PASS | model=${model} | ${latencyMs}ms`);
    console.log(`[EndpointTest] ${testName} Response Body:`, rawText.substring(0, 500));
    return { passed: true, latencyMs, message: 'OK', statusCode: response.status, request: logBody, response: responseBody || rawText.substring(0, 500) };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[EndpointTest] ${testName} ERROR | model=${model} | ${latencyMs}ms | ${msg}`);
    return { passed: false, latencyMs, message: msg, request: logBody };
  }
}

async function testEndpointHealth(
  endpointUrl: string,
  apiKey?: string | null,
  extraHeaders?: Record<string, string> | null,
  modelName?: string | null
): Promise<{
  chatCompletion: TestResult;
  toolCallA: TestResult;
  toolCallB: TestResult;
  toolCallC: TestResult;
  toolCallD: TestResult;
  allPassed: boolean;
}> {
  const model = modelName || 'gpt-4';

  const chatBody = {
    model,
    messages: [{ role: 'user', content: 'Hello' }],
    stream: false,
  };

  const toolBase = {
    model,
    messages: [{ role: 'user', content: 'What is the weather in Seoul?' }],
    tools: [{
      type: 'function',
      function: {
        name: 'get_weather',
        description: 'Get current weather for a given city',
        parameters: {
          type: 'object',
          properties: { location: { type: 'string', description: 'City name' } },
          required: ['location'],
        },
      },
    }],
    stream: false,
  };

  // 4 Tool Call scenarios
  const toolBodyA = { ...toolBase, temperature: 0, tool_choice: 'required' };
  const toolBodyB = { ...toolBase, temperature: 0 };
  const toolBodyC = { ...toolBase, tool_choice: 'required' };
  const toolBodyD = { ...toolBase };

  console.log(`[EndpointTest] ========== 테스트 시작 (5건) | model=${model} | endpoint=${endpointUrl} ==========`);

  const [chatCompletion, toolCallA, toolCallB, toolCallC, toolCallD] = await Promise.all([
    runSingleTest('ChatCompletion', endpointUrl, apiKey, extraHeaders, chatBody),
    runSingleTest('ToolCall-A (temp=0,required)', endpointUrl, apiKey, extraHeaders, toolBodyA, true),
    runSingleTest('ToolCall-B (temp=0,auto)', endpointUrl, apiKey, extraHeaders, toolBodyB, true),
    runSingleTest('ToolCall-C (default,required)', endpointUrl, apiKey, extraHeaders, toolBodyC, true),
    runSingleTest('ToolCall-D (default,auto)', endpointUrl, apiKey, extraHeaders, toolBodyD, true),
  ]);

  const toolCallPassCount = [toolCallA, toolCallB, toolCallC, toolCallD].filter(t => t.passed).length;
  const allPassed = chatCompletion.passed && toolCallPassCount >= 1;
  console.log(`[EndpointTest] ========== 테스트 완료 | model=${model} | chat=${chatCompletion.passed ? 'PASS' : 'FAIL'} | A=${toolCallA.passed ? 'PASS' : 'FAIL'} | B=${toolCallB.passed ? 'PASS' : 'FAIL'} | C=${toolCallC.passed ? 'PASS' : 'FAIL'} | D=${toolCallD.passed ? 'PASS' : 'FAIL'} | toolCall=${toolCallPassCount}/4 | result=${allPassed ? 'PASS' : 'FAIL'} ==========`);

  return { chatCompletion, toolCallA, toolCallB, toolCallC, toolCallD, allPassed };
}

// ============================================
// VL (Vision-Language) Test
// ============================================
async function testVisionLanguage(
  endpointUrl: string,
  apiKey?: string | null,
  extraHeaders?: Record<string, string> | null,
  modelName?: string | null
): Promise<{
  visionDescribe: TestResult;
  visionJudge: TestResult;
  passed: boolean;
}> {
  const model = modelName || 'gpt-4';

  if (!vlTestImageBase64) {
    const failResult: TestResult = {
      passed: false, latencyMs: 0,
      message: 'VL test image not loaded. Ensure image.png exists in project root.',
    };
    return { visionDescribe: failResult, visionJudge: failResult, passed: false };
  }

  console.log(`[VLTest] ========== VL 테스트 시작 | model=${model} | endpoint=${endpointUrl} ==========`);

  // Step 1: Send image and ask for description
  const describeBody = {
    model,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this image in detail.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${vlTestImageBase64}` } },
      ],
    }],
    stream: false,
  };

  const visionDescribe = await runSingleTest('VL-Describe', endpointUrl, apiKey, extraHeaders, describeBody);

  if (!visionDescribe.passed) {
    console.error(`[VLTest] VL-Describe 실패, Judge 단계 건너뜀`);
    const judgeSkip: TestResult = { passed: false, latencyMs: 0, message: 'Skipped: VL-Describe step failed' };
    return { visionDescribe, visionJudge: judgeSkip, passed: false };
  }

  // Extract description from response
  const responseObj = visionDescribe.response as Record<string, any>;
  const description = responseObj?.choices?.[0]?.message?.content || '';

  if (!description || typeof description !== 'string' || description.trim().length < 10) {
    console.error(`[VLTest] VL-Describe 응답이 비어있거나 너무 짧음: "${(description || '').substring(0, 100)}"`);
    const emptyResult: TestResult = {
      passed: false, latencyMs: visionDescribe.latencyMs,
      message: `VL description is empty or too short: "${(description || '').substring(0, 100)}"`,
      request: visionDescribe.request, response: visionDescribe.response,
    };
    return { visionDescribe: emptyResult, visionJudge: { passed: false, latencyMs: 0, message: 'Skipped' }, passed: false };
  }

  // Step 2: Ask the SAME model to judge
  const referenceAnswer = 'The image shows a hand gripping/holding Korean won banknotes (500 won, 1000 won bills) in an illustrated/cartoon style with a yellow background.';

  const judgeBody = {
    model,
    messages: [{
      role: 'user',
      content: `You are an image description evaluator. Compare the model's description against a reference answer.

Reference answer: "${referenceAnswer}"

Model's description: "${description}"

Key elements to check:
1. Mentions hand(s) or holding/gripping
2. Mentions Korean money/banknotes/won/currency
3. Mentions illustration/cartoon/drawing style or yellow background
4. Mentions specific denominations (500 and/or 1000)

If the description captures at least 3 of these 4 elements, respond with exactly "PASS". Otherwise respond with exactly "FAIL" followed by a brief explanation.`,
    }],
    temperature: 0,
    stream: false,
  };

  const visionJudge = await runSingleTest('VL-Judge', endpointUrl, apiKey, extraHeaders, judgeBody);

  if (!visionJudge.passed) {
    console.error(`[VLTest] VL-Judge 요청 실패`);
    return { visionDescribe, visionJudge, passed: false };
  }

  // Check judge verdict
  const judgeResponse = visionJudge.response as Record<string, any>;
  const judgeContent = (judgeResponse?.choices?.[0]?.message?.content || '').trim();
  const judgeOk = judgeContent.toUpperCase().startsWith('PASS');

  if (!judgeOk) {
    console.error(`[VLTest] VL-Judge 판정: FAIL | ${judgeContent.substring(0, 300)}`);
    const failJudge: TestResult = {
      ...visionJudge,
      passed: false,
      message: `VL Judge: ${judgeContent.substring(0, 300)}`,
    };
    return { visionDescribe, visionJudge: failJudge, passed: false };
  }

  console.log(`[VLTest] ========== VL 테스트 통과 | model=${model} ==========`);
  return { visionDescribe, visionJudge, passed: true };
}

// ============================================
// Embedding Test
// ============================================
function normalizeEmbeddingsUrl(endpointUrl: string): string {
  let url = endpointUrl.trim().replace(/\/+$/, '');
  if (url.endsWith('/embeddings')) return url;
  url = url.replace(/\/chat\/completions$/, '');
  if (url.endsWith('/v1')) return `${url}/embeddings`;
  return `${url}/v1/embeddings`;
}

async function testEmbedding(
  endpointUrl: string,
  apiKey?: string | null,
  extraHeaders?: Record<string, string> | null,
  modelName?: string | null
): Promise<{ embedding: TestResult; passed: boolean }> {
  const model = modelName || 'unknown';
  const url = normalizeEmbeddingsUrl(endpointUrl);
  const start = Date.now();
  const body = { model, input: 'Hello world' };

  console.log(`[EmbeddingTest] ========== 테스트 시작 | model=${model} | url=${url} ==========`);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (extraHeaders) Object.assign(headers, extraHeaders);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(timeout);

    const latencyMs = Date.now() - start;
    const rawText = await response.text().catch(() => '');
    let responseBody: Record<string, any> | null = null;
    try { responseBody = JSON.parse(rawText); } catch { /* keep null */ }

    if (!response.ok) {
      console.error(`[EmbeddingTest] FAIL | ${latencyMs}ms | HTTP ${response.status}`);
      return { embedding: { passed: false, latencyMs, message: `HTTP ${response.status}: ${rawText.substring(0, 500)}`, statusCode: response.status, request: body, response: responseBody || rawText.substring(0, 1000) }, passed: false };
    }

    const embeddingData = responseBody?.data?.[0]?.embedding;
    if (!Array.isArray(embeddingData) || embeddingData.length === 0) {
      console.error(`[EmbeddingTest] FAIL | Invalid response structure`);
      return { embedding: { passed: false, latencyMs, message: 'Response does not contain valid embedding (expected data[0].embedding as number array)', statusCode: response.status, request: body, response: responseBody || undefined }, passed: false };
    }
    if (typeof embeddingData[0] !== 'number') {
      return { embedding: { passed: false, latencyMs, message: `Embedding values are not numbers (got ${typeof embeddingData[0]})`, statusCode: response.status, request: body, response: responseBody || undefined }, passed: false };
    }

    console.log(`[EmbeddingTest] PASS | ${latencyMs}ms | dim=${embeddingData.length}`);
    return { embedding: { passed: true, latencyMs, message: `OK (dim=${embeddingData.length})`, statusCode: response.status, request: body, response: responseBody || undefined }, passed: true };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[EmbeddingTest] ERROR | ${latencyMs}ms | ${msg}`);
    return { embedding: { passed: false, latencyMs, message: msg, request: body }, passed: false };
  }
}

// ============================================
// Rerank Test
// ============================================
function normalizeRerankUrl(endpointUrl: string): string {
  let url = endpointUrl.trim().replace(/\/+$/, '');
  if (url.endsWith('/rerank')) return url;
  url = url.replace(/\/chat\/completions$/, '');
  if (url.endsWith('/v1')) return `${url}/rerank`;
  return `${url}/v1/rerank`;
}

async function testRerank(
  endpointUrl: string,
  apiKey?: string | null,
  extraHeaders?: Record<string, string> | null,
  modelName?: string | null
): Promise<{ rerank: TestResult; passed: boolean }> {
  const model = modelName || 'unknown';
  const url = normalizeRerankUrl(endpointUrl);
  const start = Date.now();
  const body = {
    model,
    query: 'What is machine learning?',
    documents: [
      'Machine learning is a subset of artificial intelligence that enables systems to learn from data.',
      'The weather is nice today with clear skies.',
    ],
  };

  console.log(`[RerankTest] ========== 테스트 시작 | model=${model} | url=${url} ==========`);

  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (extraHeaders) Object.assign(headers, extraHeaders);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
    clearTimeout(timeout);

    const latencyMs = Date.now() - start;
    const rawText = await response.text().catch(() => '');
    let responseBody: Record<string, any> | null = null;
    try { responseBody = JSON.parse(rawText); } catch { /* keep null */ }

    if (!response.ok) {
      console.error(`[RerankTest] FAIL | ${latencyMs}ms | HTTP ${response.status}`);
      return { rerank: { passed: false, latencyMs, message: `HTTP ${response.status}: ${rawText.substring(0, 500)}`, statusCode: response.status, request: body, response: responseBody || rawText.substring(0, 1000) }, passed: false };
    }

    const results = responseBody?.results;
    if (!Array.isArray(results) || results.length === 0) {
      console.error(`[RerankTest] FAIL | Invalid response structure`);
      return { rerank: { passed: false, latencyMs, message: 'Response does not contain valid results array', statusCode: response.status, request: body, response: responseBody || undefined }, passed: false };
    }

    const firstResult = results[0];
    if (firstResult.relevance_score === undefined && firstResult.score === undefined) {
      return { rerank: { passed: false, latencyMs, message: 'Results do not contain relevance_score or score field', statusCode: response.status, request: body, response: responseBody || undefined }, passed: false };
    }

    console.log(`[RerankTest] PASS | ${latencyMs}ms | results=${results.length}`);
    return { rerank: { passed: true, latencyMs, message: `OK (${results.length} results)`, statusCode: response.status, request: body, response: responseBody || undefined }, passed: true };
  } catch (error) {
    const latencyMs = Date.now() - start;
    const msg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[RerankTest] ERROR | ${latencyMs}ms | ${msg}`);
    return { rerank: { passed: false, latencyMs, message: msg, request: body }, passed: false };
  }
}

// ============================================
// Model CRUD
// ============================================

/**
 * GET /admin/models - List all models (including disabled)
 */
adminModelsRoutes.get('/', async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const models = await prisma.model.findMany({
      orderBy: { sortOrder: 'asc' },
      include: {
        subModels: { orderBy: { sortOrder: 'asc' } },
        _count: { select: { usageLogs: true } },
      },
    });
    res.json({ models });
  } catch (error) {
    console.error('Error listing models:', error);
    res.status(500).json({ error: 'Failed to list models' });
  }
});

/**
 * POST /admin/models - Create a new model
 */
adminModelsRoutes.post('/', requireWriteAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      name,
      displayName,
      alias,
      upstreamModelName,
      endpointUrl,
      apiKey,
      extraHeaders,
      extraBody,
      maxTokens,
      enabled,
      type,
    } = req.body as {
      name?: string;
      displayName?: string;
      alias?: string;
      upstreamModelName?: string | null;
      endpointUrl?: string;
      apiKey?: string;
      extraHeaders?: Record<string, string>;
      extraBody?: Record<string, any>;
      maxTokens?: number;
      enabled?: boolean;
      type?: 'CHAT' | 'EMBEDDING' | 'RERANKING';
    };

    if (!name || !displayName || !endpointUrl) {
      res.status(400).json({ error: 'name, displayName, and endpointUrl are required' });
      return;
    }

    // Check uniqueness
    const existingName = await prisma.model.findUnique({ where: { name } });
    if (existingName) {
      res.status(409).json({ error: 'A model with this name already exists' });
      return;
    }

    if (alias) {
      const existingAlias = await prisma.model.findUnique({ where: { alias } });
      if (existingAlias) {
        res.status(409).json({ error: 'A model with this alias already exists' });
        return;
      }
    }

    // Get next sort order
    const maxSort = await prisma.model.aggregate({ _max: { sortOrder: true } });
    const nextSortOrder = (maxSort._max.sortOrder ?? -1) + 1;

    const model = await prisma.model.create({
      data: {
        name,
        displayName,
        alias: alias || undefined,
        upstreamModelName: upstreamModelName || undefined,
        endpointUrl,
        apiKey: apiKey || undefined,
        extraHeaders: extraHeaders || undefined,
        extraBody: extraBody || undefined,
        maxTokens: maxTokens ?? 128000,
        enabled: enabled ?? true,
        type: type || 'CHAT',
        sortOrder: nextSortOrder,
        createdBy: req.adminId || undefined,
      },
      include: { subModels: true },
    });

    await prisma.auditLog.create({
      data: {
        adminId: req.adminId || undefined,
        loginid: req.user!.loginid,
        action: 'CREATE_MODEL',
        target: model.id,
        targetType: 'Model',
        details: { name, displayName, endpointUrl, enabled: model.enabled },
        ipAddress: req.ip,
      },
    });

    res.status(201).json({ model });
  } catch (error) {
    console.error('Error creating model:', error);
    res.status(500).json({ error: 'Failed to create model' });
  }
});

/**
 * PUT /admin/models/reorder - Reorder models
 */
adminModelsRoutes.put('/reorder', requireWriteAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { modelIds } = req.body as { modelIds?: string[] };

    if (!Array.isArray(modelIds) || modelIds.length === 0) {
      res.status(400).json({ error: 'modelIds array is required' });
      return;
    }

    await prisma.$transaction(
      modelIds.map((id, index) =>
        prisma.model.update({
          where: { id },
          data: { sortOrder: index },
        })
      )
    );

    await prisma.auditLog.create({
      data: {
        adminId: req.adminId || undefined,
        loginid: req.user!.loginid,
        action: 'REORDER_MODELS',
        targetType: 'Model',
        details: { modelIds },
        ipAddress: req.ip,
      },
    });

    res.json({ message: 'Models reordered successfully' });
  } catch (error) {
    console.error('Error reordering models:', error);
    res.status(500).json({ error: 'Failed to reorder models' });
  }
});

/**
 * PUT /admin/models/:id - Update model
 */
adminModelsRoutes.put('/:id', requireWriteAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const {
      name,
      displayName,
      alias,
      upstreamModelName,
      endpointUrl,
      apiKey,
      extraHeaders,
      extraBody,
      maxTokens,
      enabled,
      type,
    } = req.body as {
      name?: string;
      displayName?: string;
      alias?: string | null;
      upstreamModelName?: string | null;
      endpointUrl?: string;
      apiKey?: string | null;
      extraHeaders?: Record<string, string> | null;
      extraBody?: Record<string, any> | null;
      maxTokens?: number;
      enabled?: boolean;
      type?: 'CHAT' | 'EMBEDDING' | 'RERANKING';
    };

    const existing = await prisma.model.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ error: 'Model not found' });
      return;
    }

    // Check name uniqueness if changed
    if (name && name !== existing.name) {
      const nameConflict = await prisma.model.findUnique({ where: { name } });
      if (nameConflict) {
        res.status(409).json({ error: 'A model with this name already exists' });
        return;
      }
    }

    // Check alias uniqueness if changed
    if (alias !== undefined && alias !== existing.alias) {
      if (alias) {
        const aliasConflict = await prisma.model.findUnique({ where: { alias } });
        if (aliasConflict && aliasConflict.id !== id) {
          res.status(409).json({ error: 'A model with this alias already exists' });
          return;
        }
      }
    }

    const data: Record<string, unknown> = {};
    if (name !== undefined) data.name = name;
    if (displayName !== undefined) data.displayName = displayName;
    if (alias !== undefined) data.alias = alias || null;
    if (upstreamModelName !== undefined) data.upstreamModelName = upstreamModelName || null;
    if (endpointUrl !== undefined) data.endpointUrl = endpointUrl;
    if (apiKey !== undefined) data.apiKey = apiKey || null;
    if (extraHeaders !== undefined) data.extraHeaders = extraHeaders;
    if (extraBody !== undefined) data.extraBody = extraBody;
    if (maxTokens !== undefined) data.maxTokens = maxTokens;
    if (enabled !== undefined) data.enabled = enabled;
    if (type !== undefined) data.type = type;

    const model = await prisma.model.update({
      where: { id },
      data,
      include: { subModels: { orderBy: { sortOrder: 'asc' } } },
    });

    await prisma.auditLog.create({
      data: {
        adminId: req.adminId || undefined,
        loginid: req.user!.loginid,
        action: 'UPDATE_MODEL',
        target: model.id,
        targetType: 'Model',
        details: JSON.parse(JSON.stringify({ changes: data })),
        ipAddress: req.ip,
      },
    });

    res.json({ model });
  } catch (error) {
    console.error('Error updating model:', error);
    res.status(500).json({ error: 'Failed to update model' });
  }
});

/**
 * DELETE /admin/models/:id - Delete model
 * Use ?force=true to delete models with existing usage logs
 */
adminModelsRoutes.delete('/:id', requireWriteAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const force = req.query.force === 'true';

    const existing = await prisma.model.findUnique({
      where: { id },
      include: { _count: { select: { usageLogs: true, dailyUsageStats: true } } },
    });
    if (!existing) {
      res.status(404).json({ error: 'Model not found' });
      return;
    }

    const hasUsage = existing._count.usageLogs > 0 || existing._count.dailyUsageStats > 0;
    if (hasUsage && !force) {
      res.status(400).json({
        error: 'Model has existing usage logs. Use ?force=true to delete anyway.',
        usageLogs: existing._count.usageLogs,
        dailyUsageStats: existing._count.dailyUsageStats,
      });
      return;
    }

    if (hasUsage && force) {
      // Delete related records first
      await prisma.$transaction([
        prisma.dailyUsageStat.deleteMany({ where: { modelId: id } }),
        prisma.usageLog.deleteMany({ where: { modelId: id } }),
        prisma.subModel.deleteMany({ where: { parentId: id } }),
        prisma.model.delete({ where: { id } }),
      ]);
    } else {
      await prisma.$transaction([
        prisma.subModel.deleteMany({ where: { parentId: id } }),
        prisma.model.delete({ where: { id } }),
      ]);
    }

    await prisma.auditLog.create({
      data: {
        adminId: req.adminId || undefined,
        loginid: req.user!.loginid,
        action: 'DELETE_MODEL',
        target: id,
        targetType: 'Model',
        details: { name: existing.name, forced: force },
        ipAddress: req.ip,
      },
    });

    res.json({ message: 'Model deleted successfully' });
  } catch (error) {
    console.error('Error deleting model:', error);
    res.status(500).json({ error: 'Failed to delete model' });
  }
});

/**
 * POST /admin/models/test - Test endpoint health
 */
adminModelsRoutes.post('/test', requireWriteAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { endpointUrl, apiKey, extraHeaders, modelName } = req.body as {
      endpointUrl?: string;
      apiKey?: string;
      extraHeaders?: Record<string, string>;
      modelName?: string;
    };

    if (!endpointUrl) {
      res.status(400).json({ error: 'endpointUrl is required' });
      return;
    }

    const result = await testEndpointHealth(endpointUrl, apiKey, extraHeaders, modelName);
    res.json(result);
  } catch (error) {
    console.error('Error testing endpoint:', error);
    res.status(500).json({ error: 'Failed to test endpoint' });
  }
});

/**
 * POST /admin/models/test-vl - Test VL (Vision-Language) capability
 */
adminModelsRoutes.post('/test-vl', requireWriteAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { endpointUrl, apiKey, extraHeaders, modelName } = req.body as {
      endpointUrl?: string;
      apiKey?: string;
      extraHeaders?: Record<string, string>;
      modelName?: string;
    };

    if (!endpointUrl) {
      res.status(400).json({ error: 'endpointUrl is required' });
      return;
    }

    const result = await testVisionLanguage(endpointUrl, apiKey, extraHeaders, modelName);
    res.json(result);
  } catch (error) {
    console.error('Error testing VL endpoint:', error);
    res.status(500).json({ error: 'Failed to test VL endpoint' });
  }
});

/**
 * POST /admin/models/test-embedding - Test embedding endpoint
 */
adminModelsRoutes.post('/test-embedding', requireWriteAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { endpointUrl, apiKey, extraHeaders, modelName } = req.body as {
      endpointUrl?: string;
      apiKey?: string;
      extraHeaders?: Record<string, string>;
      modelName?: string;
    };
    if (!endpointUrl) { res.status(400).json({ error: 'endpointUrl is required' }); return; }
    const result = await testEmbedding(endpointUrl, apiKey, extraHeaders, modelName);
    res.json(result);
  } catch (error) {
    console.error('Error testing embedding endpoint:', error);
    res.status(500).json({ error: 'Failed to test embedding endpoint' });
  }
});

/**
 * POST /admin/models/test-rerank - Test rerank endpoint
 */
adminModelsRoutes.post('/test-rerank', requireWriteAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { endpointUrl, apiKey, extraHeaders, modelName } = req.body as {
      endpointUrl?: string;
      apiKey?: string;
      extraHeaders?: Record<string, string>;
      modelName?: string;
    };
    if (!endpointUrl) { res.status(400).json({ error: 'endpointUrl is required' }); return; }
    const result = await testRerank(endpointUrl, apiKey, extraHeaders, modelName);
    res.json(result);
  } catch (error) {
    console.error('Error testing rerank endpoint:', error);
    res.status(500).json({ error: 'Failed to test rerank endpoint' });
  }
});

// ============================================
// Sub-Model Management
// ============================================

/**
 * GET /admin/models/:modelId/sub-models - List sub-models
 */
adminModelsRoutes.get('/:modelId/sub-models', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { modelId } = req.params;

    const model = await prisma.model.findUnique({ where: { id: modelId } });
    if (!model) {
      res.status(404).json({ error: 'Parent model not found' });
      return;
    }

    const subModels = await prisma.subModel.findMany({
      where: { parentId: modelId },
      orderBy: { sortOrder: 'asc' },
    });

    res.json({ subModels });
  } catch (error) {
    console.error('Error listing sub-models:', error);
    res.status(500).json({ error: 'Failed to list sub-models' });
  }
});

/**
 * POST /admin/models/:modelId/sub-models - Create sub-model
 */
adminModelsRoutes.post('/:modelId/sub-models', requireWriteAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { modelId } = req.params;
    const { modelName, endpointUrl, apiKey, extraHeaders, extraBody, enabled, sortOrder } = req.body as {
      modelName?: string;
      endpointUrl?: string;
      apiKey?: string;
      extraHeaders?: Record<string, string>;
      extraBody?: Record<string, any>;
      enabled?: boolean;
      sortOrder?: number;
    };

    const model = await prisma.model.findUnique({ where: { id: modelId } });
    if (!model) {
      res.status(404).json({ error: 'Parent model not found' });
      return;
    }

    if (!endpointUrl) {
      res.status(400).json({ error: 'endpointUrl is required' });
      return;
    }

    let finalSortOrder: number;
    if (sortOrder !== undefined) {
      finalSortOrder = sortOrder;
    } else {
      const maxSort = await prisma.subModel.aggregate({
        where: { parentId: modelId },
        _max: { sortOrder: true },
      });
      finalSortOrder = (maxSort._max.sortOrder ?? -1) + 1;
    }

    const subModel = await prisma.subModel.create({
      data: {
        parentId: modelId,
        modelName: modelName || undefined,
        endpointUrl,
        apiKey: apiKey || undefined,
        extraHeaders: extraHeaders || undefined,
        extraBody: extraBody || undefined,
        enabled: enabled ?? true,
        sortOrder: finalSortOrder,
      },
    });

    await prisma.auditLog.create({
      data: {
        adminId: req.adminId || undefined,
        loginid: req.user!.loginid,
        action: 'CREATE_SUB_MODEL',
        target: subModel.id,
        targetType: 'SubModel',
        details: { parentModelId: modelId, parentModelName: model.name, endpointUrl },
        ipAddress: req.ip,
      },
    });

    res.status(201).json({ subModel });
  } catch (error) {
    console.error('Error creating sub-model:', error);
    res.status(500).json({ error: 'Failed to create sub-model' });
  }
});

/**
 * PUT /admin/models/:modelId/sub-models/:subId - Update sub-model
 */
adminModelsRoutes.put('/:modelId/sub-models/:subId', requireWriteAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { modelId, subId } = req.params;
    const { modelName, endpointUrl, apiKey, extraHeaders, extraBody, enabled, sortOrder } = req.body as {
      modelName?: string | null;
      endpointUrl?: string;
      apiKey?: string | null;
      extraHeaders?: Record<string, string> | null;
      extraBody?: Record<string, any> | null;
      enabled?: boolean;
      sortOrder?: number;
    };

    const existing = await prisma.subModel.findFirst({
      where: { id: subId, parentId: modelId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Sub-model not found' });
      return;
    }

    const data: Record<string, unknown> = {};
    if (modelName !== undefined) data.modelName = modelName || null;
    if (endpointUrl !== undefined) data.endpointUrl = endpointUrl;
    if (apiKey !== undefined) data.apiKey = apiKey || null;
    if (extraHeaders !== undefined) data.extraHeaders = extraHeaders;
    if (extraBody !== undefined) data.extraBody = extraBody;
    if (enabled !== undefined) data.enabled = enabled;
    if (sortOrder !== undefined) data.sortOrder = sortOrder;

    const subModel = await prisma.subModel.update({
      where: { id: subId },
      data,
    });

    await prisma.auditLog.create({
      data: {
        adminId: req.adminId || undefined,
        loginid: req.user!.loginid,
        action: 'UPDATE_SUB_MODEL',
        target: subId,
        targetType: 'SubModel',
        details: JSON.parse(JSON.stringify({ parentModelId: modelId, changes: data })),
        ipAddress: req.ip,
      },
    });

    res.json({ subModel });
  } catch (error) {
    console.error('Error updating sub-model:', error);
    res.status(500).json({ error: 'Failed to update sub-model' });
  }
});

/**
 * DELETE /admin/models/:modelId/sub-models/:subId - Delete sub-model
 */
adminModelsRoutes.delete('/:modelId/sub-models/:subId', requireWriteAccess, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { modelId, subId } = req.params;

    const existing = await prisma.subModel.findFirst({
      where: { id: subId, parentId: modelId },
    });
    if (!existing) {
      res.status(404).json({ error: 'Sub-model not found' });
      return;
    }

    await prisma.subModel.delete({ where: { id: subId } });

    await prisma.auditLog.create({
      data: {
        adminId: req.adminId || undefined,
        loginid: req.user!.loginid,
        action: 'DELETE_SUB_MODEL',
        target: subId,
        targetType: 'SubModel',
        details: { parentModelId: modelId, endpointUrl: existing.endpointUrl },
        ipAddress: req.ip,
      },
    });

    res.json({ message: 'Sub-model deleted successfully' });
  } catch (error) {
    console.error('Error deleting sub-model:', error);
    res.status(500).json({ error: 'Failed to delete sub-model' });
  }
});
