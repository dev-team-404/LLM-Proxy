/**
 * LLM Proxy Routes
 *
 * Proxies /v1/* requests to actual LLM endpoints.
 * Authenticates via API tokens (Bearer sk-xxx).
 * Supports round-robin, failover, circuit breaker, streaming SSE,
 * context window auto-recovery, budget checks, and request logging.
 */

import { Router, Response } from 'express';
import { prisma, redis } from '../index.js';
import { authenticateApiToken, TokenAuthenticatedRequest } from '../middleware/tokenAuth.js';
import { checkRateLimit } from '../middleware/rateLimiter.js';
import { recordUsage, checkBudget } from '../services/usage.service.js';
import { logRequest } from '../services/requestLog.service.js';
import { isEndpointAvailable, recordEndpointSuccess, recordEndpointFailure } from '../services/circuitBreaker.service.js';
import { recordTokenRateLimit } from '../middleware/rateLimiter.js';

export const proxyRoutes = Router();

// ============================================
// Constants
// ============================================

const REQUEST_TIMEOUT_MS = 120000; // 2 minutes

// ============================================
// Types
// ============================================

interface EndpointInfo {
  endpointUrl: string;
  apiKey: string | null;
  modelName: string;
  extraHeaders: Record<string, string> | null;
  extraBody: Record<string, any> | null;
}

// ============================================
// Helper Functions
// ============================================

/**
 * Resolve a model by name, alias, or id.
 */
async function resolveModel(modelName: string) {
  return prisma.model.findFirst({
    where: {
      OR: [{ name: modelName }, { alias: modelName }, { id: modelName }],
      enabled: true,
    },
  });
}

/**
 * Get all endpoints for a model (parent + subModels).
 * If no subModels exist, returns only the parent endpoint.
 */
async function getModelEndpoints(modelId: string, parentEndpoint: EndpointInfo): Promise<EndpointInfo[]> {
  const subModels = await prisma.subModel.findMany({
    where: { parentId: modelId, enabled: true },
    orderBy: { sortOrder: 'asc' },
    select: { endpointUrl: true, apiKey: true, modelName: true, extraHeaders: true, extraBody: true },
  });

  if (subModels.length === 0) {
    return [parentEndpoint];
  }

  return [
    parentEndpoint,
    ...subModels.map(s => ({
      endpointUrl: s.endpointUrl,
      apiKey: s.apiKey,
      modelName: s.modelName || parentEndpoint.modelName,
      extraHeaders: s.extraHeaders as Record<string, string> | null,
      extraBody: s.extraBody as Record<string, any> | null,
    })),
  ];
}

/**
 * Round-robin start index, stored in Redis.
 * Falls back to 0 (parent) on Redis failure.
 */
async function getRoundRobinIndex(modelId: string, endpointCount: number): Promise<number> {
  if (endpointCount <= 1) return 0;

  try {
    const key = `model_rr:${modelId}`;
    const index = await redis.incr(key);
    if (index === 1) {
      await redis.expire(key, 7 * 24 * 60 * 60);
    }
    return (index - 1) % endpointCount;
  } catch (error) {
    console.error('[RoundRobin] Redis error, falling back to parent endpoint:', error);
    return 0;
  }
}

/**
 * Build the /chat/completions URL from an endpoint base URL.
 */
function buildChatCompletionsUrl(endpointUrl: string): string {
  let url = endpointUrl.trim();
  if (url.endsWith('/chat/completions')) return url;
  if (url.endsWith('/')) url = url.slice(0, -1);
  if (url.endsWith('/v1')) return `${url}/chat/completions`;
  return `${url}/chat/completions`;
}

/**
 * Build the /embeddings URL from an endpoint base URL.
 */
function buildEmbeddingsUrl(endpointUrl: string): string {
  let url = endpointUrl.trim();
  if (url.endsWith('/embeddings')) return url;
  if (url.endsWith('/')) url = url.slice(0, -1);
  if (url.endsWith('/v1')) return `${url}/embeddings`;
  // Strip /chat/completions if present
  if (url.endsWith('/chat/completions')) {
    url = url.replace(/\/chat\/completions$/, '');
  }
  return `${url}/embeddings`;
}

/**
 * Build the /rerank URL from an endpoint base URL.
 * vLLM serves rerank at /v1/rerank (Jina-compatible) and /v2/rerank (Cohere-compatible).
 * We use /v1/rerank (Jina format) by default.
 */
function buildRerankUrl(endpointUrl: string): string {
  let url = endpointUrl.trim();
  if (url.endsWith('/rerank')) return url;
  if (url.endsWith('/')) url = url.slice(0, -1);
  if (url.endsWith('/v1')) return `${url}/rerank`;
  // Strip known suffixes
  if (url.endsWith('/chat/completions')) {
    url = url.replace(/\/chat\/completions$/, '');
  } else if (url.endsWith('/embeddings')) {
    url = url.replace(/\/embeddings$/, '');
  }
  return `${url}/rerank`;
}

/**
 * Check if the error is a max_tokens "must be at least" error.
 */
function isMaxTokensError(errorText: string): boolean {
  return errorText.includes('max_tokens') && errorText.includes('must be at least');
}

/**
 * Check if the error is a context window exceeded error.
 */
function isContextWindowExceededError(errorText: string): boolean {
  const lower = errorText.toLowerCase();
  return (
    lower.includes('contextwindowexceedederror') ||
    (lower.includes('max_tokens') && lower.includes('too large')) ||
    (lower.includes('max_completion_tokens') && lower.includes('too large')) ||
    (lower.includes('context length') && lower.includes('input tokens'))
  );
}

/**
 * Build request headers for an LLM endpoint call.
 */
function buildHeaders(endpoint: EndpointInfo): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (endpoint.apiKey) {
    headers['Authorization'] = `Bearer ${endpoint.apiKey}`;
  }

  if (endpoint.extraHeaders) {
    for (const [key, value] of Object.entries(endpoint.extraHeaders)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey !== 'content-type' && lowerKey !== 'authorization') {
        headers[key] = value;
      }
    }
  }

  return headers;
}

/**
 * Log LLM errors with structured debugging info.
 */
function logLLMError(
  context: string,
  url: string,
  status: number,
  errorBody: string,
  requestBody: any,
  req: TokenAuthenticatedRequest,
  modelName: string
) {
  const messages = requestBody.messages || [];
  const tools = requestBody.tools || [];

  const messageSummary = messages.map((m: any, i: number) => {
    const contentLen = typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content || '').length;
    const toolCalls = m.tool_calls ? ` tool_calls=${m.tool_calls.length}` : '';
    return `  [${i}] role=${m.role} content_len=${contentLen}${toolCalls}`;
  }).join('\n');

  const toolsSummary = tools.length > 0
    ? tools.map((t: any, i: number) => {
        const fn = t.function || t;
        const paramLen = JSON.stringify(fn.parameters || {}).length;
        return `  [${i}] ${fn.name || 'unknown'} params_len=${paramLen}`;
      }).join('\n')
    : '  (none)';

  const maxErrorLen = 2000;
  const truncatedError = errorBody.length > maxErrorLen
    ? errorBody.substring(0, maxErrorLen) + `... (truncated, total ${errorBody.length} chars)`
    : errorBody;

  console.error(
    `[LLM-Error] ${context}\n` +
    `  User: ${req.user?.loginid || 'unknown'} (${req.user?.username || 'unknown'})\n` +
    `  Token: ${req.apiTokenId || 'none'}\n` +
    `  Model: ${modelName}\n` +
    `  URL: ${url}\n` +
    `  Status: ${status}\n` +
    `  Request Body Size: ${JSON.stringify(requestBody).length} bytes\n` +
    `  Messages (${messages.length}):\n${messageSummary}\n` +
    `  Tools (${tools.length}):\n${toolsSummary}\n` +
    `  stream: ${requestBody.stream || false} | max_tokens: ${requestBody.max_tokens || 'default'} | temperature: ${requestBody.temperature ?? 'default'}\n` +
    `  LLM Response Body:\n${truncatedError}`
  );
}

// ============================================
// Non-Streaming Request Handler
// ============================================

/**
 * Handle non-streaming chat completion.
 * @returns true = response sent (success or client error), false = server/network error (failover needed)
 */
async function handleNonStreamingRequest(
  res: Response,
  req: TokenAuthenticatedRequest,
  model: { id: string; name: string; endpointUrl: string; apiKey: string | null },
  requestBody: any,
  headers: Record<string, string>,
  modelName: string
): Promise<{ handled: boolean; statusCode?: number; data?: any; inputTokens?: number; outputTokens?: number; latencyMs?: number; errorMessage?: string }> {
  const url = buildChatCompletionsUrl(model.endpointUrl);
  console.log(`[Proxy] user=${req.user?.loginid || 'unknown'} token=${req.apiTokenId || 'none'} model=${model.name} endpoint=${url} (non-streaming)`);

  try {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      const latencyMs = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        logLLMError('Non-Streaming', url, response.status, errorText, requestBody, req, modelName);

        // Context window exceeded -> retry without max_tokens
        if (response.status === 400 && isContextWindowExceededError(errorText) && (requestBody.max_tokens || requestBody.max_completion_tokens)) {
          console.log(`[Proxy] Context window exceeded, retrying without max_tokens (was ${requestBody.max_tokens || requestBody.max_completion_tokens})`);
          const { max_tokens: _mt, max_completion_tokens: _mct, ...bodyWithoutMaxTokens } = requestBody;
          const retryController = new AbortController();
          const retryTimeoutId = setTimeout(() => retryController.abort(), REQUEST_TIMEOUT_MS);
          try {
            const retryResponse = await fetch(url, {
              method: 'POST',
              headers,
              body: JSON.stringify(bodyWithoutMaxTokens),
              signal: retryController.signal,
            });
            clearTimeout(retryTimeoutId);
            const retryLatencyMs = Date.now() - startTime;

            if (retryResponse.ok) {
              const data = await retryResponse.json() as {
                usage?: { prompt_tokens?: number; completion_tokens?: number };
                [key: string]: unknown;
              };
              const inputTokens = data.usage?.prompt_tokens || 0;
              const outputTokens = data.usage?.completion_tokens || 0;
              res.json(data);
              return { handled: true, statusCode: 200, data, inputTokens, outputTokens, latencyMs: retryLatencyMs };
            }
            // Retry also failed -> return original error
            const retryErrorText = await retryResponse.text();
            try {
              const errorJson = JSON.parse(retryErrorText);
              res.status(retryResponse.status).json(errorJson);
            } catch {
              res.status(retryResponse.status).send(retryErrorText);
            }
            return { handled: true, statusCode: retryResponse.status, errorMessage: retryErrorText, latencyMs: retryLatencyMs };
          } catch {
            clearTimeout(retryTimeoutId);
            // Retry network error -> fall through to return original error
          }
        }

        // 4xx client error -> send response, no failover
        if (response.status >= 400 && response.status < 500) {
          if (response.status === 400 && isMaxTokensError(errorText)) {
            const errBody = {
              error: {
                type: 'invalid_request_error',
                message: 'The input prompt exceeds the model\'s maximum context length. Please reduce the input size.',
              },
            };
            res.status(400).json(errBody);
            return { handled: true, statusCode: 400, errorMessage: errorText, latencyMs };
          }
          // Pass through upstream error as-is
          try {
            const errorJson = JSON.parse(errorText);
            res.status(response.status).json(errorJson);
          } catch {
            res.status(response.status).send(errorText);
          }
          return { handled: true, statusCode: response.status, errorMessage: errorText, latencyMs };
        }

        // 5xx server error -> failover possible
        console.error(`[Failover] Endpoint ${url} returned ${response.status}, will try next`);
        return { handled: false, statusCode: response.status, errorMessage: errorText, latencyMs };
      }

      // Success
      const data = await response.json() as {
        usage?: { prompt_tokens?: number; completion_tokens?: number };
        [key: string]: unknown;
      };

      const inputTokens = data.usage?.prompt_tokens || 0;
      const outputTokens = data.usage?.completion_tokens || 0;

      res.json(data);
      return { handled: true, statusCode: 200, data, inputTokens, outputTokens, latencyMs };

    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw fetchError;
    }

  } catch (error) {
    console.error(`[Failover] Endpoint ${url} connection failed:`, error instanceof Error ? error.message : error);
    return { handled: false, errorMessage: error instanceof Error ? error.message : 'Connection failed' };
  }
}

// ============================================
// Streaming Request Handler
// ============================================

/**
 * Handle streaming chat completion.
 * @returns result with handled flag and usage data
 */
async function handleStreamingRequest(
  res: Response,
  req: TokenAuthenticatedRequest,
  model: { id: string; name: string; endpointUrl: string; apiKey: string | null },
  requestBody: any,
  headers: Record<string, string>,
  modelName: string
): Promise<{ handled: boolean; statusCode?: number; inputTokens?: number; outputTokens?: number; latencyMs?: number; errorMessage?: string }> {
  const url = buildChatCompletionsUrl(model.endpointUrl);
  console.log(`[Proxy] user=${req.user?.loginid || 'unknown'} token=${req.apiTokenId || 'none'} model=${model.name} endpoint=${url} (streaming)`);

  const startTime = Date.now();
  let sseStarted = false;

  try {
    let contextWindowRetried = false;
    const requestWithUsage = {
      ...requestBody,
      stream_options: { include_usage: true },
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: globalThis.Response;

    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestWithUsage),
        signal: controller.signal,
      });

      // stream_options not supported -> retry without it
      if (!response.ok && response.status === 400) {
        const errorText = await response.text();

        if (isMaxTokensError(errorText)) {
          clearTimeout(timeoutId);
          const errBody = {
            error: {
              type: 'invalid_request_error',
              message: 'The input prompt exceeds the model\'s maximum context length. Please reduce the input size.',
            },
          };
          res.status(400).json(errBody);
          return { handled: true, statusCode: 400, errorMessage: errorText, latencyMs: Date.now() - startTime };
        }

        // Context window exceeded -> retry without max_tokens
        if (isContextWindowExceededError(errorText) && (requestBody.max_tokens || requestBody.max_completion_tokens)) {
          contextWindowRetried = true;
          console.log(`[Proxy] Context window exceeded (streaming), retrying without max_tokens (was ${requestBody.max_tokens || requestBody.max_completion_tokens})`);
          const { max_tokens: _mt, max_completion_tokens: _mct, stream_options: _so, ...bodyWithoutMaxTokens } = requestBody;
          response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...bodyWithoutMaxTokens, stream: true, stream_options: { include_usage: true } }),
            signal: controller.signal,
          });
        } else {
          console.log('[Proxy] Retrying without stream_options');
          response = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(requestBody),
            signal: controller.signal,
          });
        }
      }

      clearTimeout(timeoutId);

    } catch (fetchError) {
      clearTimeout(timeoutId);
      throw fetchError;
    }

    if (!response.ok) {
      const errorText = await response.text();
      logLLMError('Streaming', url, response.status, errorText, requestBody, req, modelName);

      // Context window exceeded (second check, for requests that came through without stream_options)
      if (!contextWindowRetried && response.status === 400 && isContextWindowExceededError(errorText) && (requestBody.max_tokens || requestBody.max_completion_tokens)) {
        console.log(`[Proxy] Context window exceeded (streaming, 2nd check), retrying without max_tokens`);
        const { max_tokens: _mt, max_completion_tokens: _mct, ...bodyWithoutMaxTokens } = requestBody;
        try {
          const retryController = new AbortController();
          const retryTimeoutId = setTimeout(() => retryController.abort(), REQUEST_TIMEOUT_MS);
          const retryResponse = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({ ...bodyWithoutMaxTokens, stream: true, stream_options: { include_usage: true } }),
            signal: retryController.signal,
          });
          clearTimeout(retryTimeoutId);
          if (retryResponse.ok) {
            response = retryResponse;
          } else {
            const retryErrorText = await retryResponse.text();
            try {
              const errorJson = JSON.parse(retryErrorText);
              res.status(retryResponse.status).json(errorJson);
            } catch {
              res.status(retryResponse.status).send(retryErrorText);
            }
            return { handled: true, statusCode: retryResponse.status, errorMessage: retryErrorText, latencyMs: Date.now() - startTime };
          }
        } catch {
          // Retry failed -> return original error
          try {
            const errorJson = JSON.parse(errorText);
            res.status(response.status).json(errorJson);
          } catch {
            res.status(response.status).send(errorText);
          }
          return { handled: true, statusCode: response.status, errorMessage: errorText, latencyMs: Date.now() - startTime };
        }
      } else {
        // 4xx client error -> send response, no failover
        if (response.status >= 400 && response.status < 500) {
          if (response.status === 400 && isMaxTokensError(errorText)) {
            const errBody = {
              error: {
                type: 'invalid_request_error',
                message: 'The input prompt exceeds the model\'s maximum context length. Please reduce the input size.',
              },
            };
            res.status(400).json(errBody);
            return { handled: true, statusCode: 400, errorMessage: errorText, latencyMs: Date.now() - startTime };
          }
          // Pass through upstream error as-is
          try {
            const errorJson = JSON.parse(errorText);
            res.status(response.status).json(errorJson);
          } catch {
            res.status(response.status).send(errorText);
          }
          return { handled: true, statusCode: response.status, errorMessage: errorText, latencyMs: Date.now() - startTime };
        }

        // 5xx server error -> failover possible
        console.error(`[Failover] Endpoint ${url} returned ${response.status}, will try next`);
        return { handled: false, statusCode: response.status, errorMessage: errorText, latencyMs: Date.now() - startTime };
      }
    }

    // === SSE streaming start (no failover possible after this point) ===
    sseStarted = true;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const reader = response.body?.getReader();
    if (!reader) {
      // SSE headers already sent, cannot use res.status() — write error as SSE event
      res.write(`data: ${JSON.stringify({ error: { type: 'server_error', message: 'Failed to get response stream' } })}\n\n`);
      res.end();
      return { handled: true, statusCode: 500, errorMessage: 'Failed to get response stream' };
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let usageData: { prompt_tokens?: number; completion_tokens?: number } | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        buffer += chunk;

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const dataStr = line.slice(6);

            if (dataStr === '[DONE]') {
              res.write('data: [DONE]\n\n');
              continue;
            }

            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.usage) {
                usageData = parsed.usage;
              }
            } catch {
              // Not valid JSON, ignore
            }

            res.write(`data: ${dataStr}\n\n`);
          } else if (line.trim()) {
            res.write(`${line}\n`);
          }
        }
      }

      if (buffer.trim()) {
        res.write(`${buffer}\n`);
      }

    } finally {
      reader.releaseLock();
    }

    const latencyMs = Date.now() - startTime;
    const inputTokens = usageData?.prompt_tokens || 0;
    const outputTokens = usageData?.completion_tokens || 0;

    if (!usageData) {
      console.log('[Usage] No usage data in streaming response');
    }

    res.end();
    return { handled: true, statusCode: 200, inputTokens, outputTokens, latencyMs };

  } catch (error) {
    if (sseStarted) {
      console.error(`[Streaming] Error after SSE started, ending response:`, error instanceof Error ? error.message : error);
      try { res.end(); } catch {}
      return { handled: true, statusCode: 500, errorMessage: error instanceof Error ? error.message : 'Stream error' };
    }
    console.error(`[Failover] Endpoint ${url} connection failed:`, error instanceof Error ? error.message : error);
    return { handled: false, errorMessage: error instanceof Error ? error.message : 'Connection failed' };
  }
}

// ============================================
// Routes
// ============================================

/**
 * GET /v1/models
 * List available models (filtered by token's allowedModels).
 */
proxyRoutes.get('/models', authenticateApiToken, async (req: TokenAuthenticatedRequest, res: Response) => {
  try {
    const models = await prisma.model.findMany({
      where: { enabled: true },
      select: {
        id: true,
        name: true,
        alias: true,
        displayName: true,
        maxTokens: true,
        sortOrder: true,
      },
      orderBy: [
        { sortOrder: 'asc' },
        { displayName: 'asc' },
      ],
    });

    // Filter by allowedModels if the token has restrictions
    const allowedModels = req.apiToken?.allowedModels;
    const filtered = allowedModels && allowedModels.length > 0
      ? models.filter(m => allowedModels.includes(m.id))
      : models;

    res.json({
      object: 'list',
      data: filtered.map(model => ({
        id: model.name,
        object: 'model',
        created: Date.now(),
        owned_by: 'llm-gateway',
        permission: [],
        root: model.name,
        parent: null,
        _gateway: {
          id: model.id,
          alias: model.alias,
          displayName: model.displayName,
          maxTokens: model.maxTokens,
        },
      })),
    });
  } catch (error) {
    console.error('Get models error:', error);
    res.status(500).json({ error: { type: 'server_error', message: 'Failed to get models' } });
  }
});

/**
 * GET /v1/models/:modelName
 * Get specific model info.
 */
proxyRoutes.get('/models/:modelName', authenticateApiToken, async (req: TokenAuthenticatedRequest, res: Response) => {
  try {
    const { modelName } = req.params;

    const model = await prisma.model.findFirst({
      where: {
        OR: [{ name: modelName }, { alias: modelName }, { id: modelName }],
        enabled: true,
      },
      select: {
        id: true,
        name: true,
        alias: true,
        displayName: true,
        maxTokens: true,
      },
    });

    if (!model) {
      res.status(404).json({ error: { type: 'not_found', message: `Model '${modelName}' not found` } });
      return;
    }

    // Check allowedModels
    if (req.apiToken?.allowedModels?.length && req.apiToken.allowedModels.length > 0 && !req.apiToken.allowedModels.includes(model.id)) {
      res.status(403).json({
        error: { type: 'permission_error', message: `Your API key does not have access to model '${modelName}'` },
      });
      return;
    }

    res.json({
      id: model.name,
      object: 'model',
      created: Date.now(),
      owned_by: 'llm-gateway',
      permission: [],
      root: model.name,
      parent: null,
      _gateway: {
        id: model.id,
        alias: model.alias,
        displayName: model.displayName,
        maxTokens: model.maxTokens,
      },
    });
  } catch (error) {
    console.error('Get model error:', error);
    res.status(500).json({ error: { type: 'server_error', message: 'Failed to get model' } });
  }
});

/**
 * POST /v1/chat/completions
 * Proxy chat completion request to actual LLM.
 */
proxyRoutes.post('/chat/completions', authenticateApiToken, checkRateLimit, async (req: TokenAuthenticatedRequest, res: Response) => {
  const startTime = Date.now();

  try {
    const { model: modelName, messages, stream, ...otherParams } = req.body;

    if (!modelName || !messages) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'model and messages are required' } });
      return;
    }

    // Resolve model by name, alias, or id
    const model = await resolveModel(modelName);

    if (!model) {
      res.status(404).json({ error: { type: 'not_found', message: `Model '${modelName}' not found or disabled` } });
      return;
    }

    // Check allowedModels
    if (req.apiToken?.allowedModels?.length && req.apiToken.allowedModels.length > 0 && !req.apiToken.allowedModels.includes(model.id)) {
      res.status(403).json({
        error: { type: 'permission_error', message: `Your API key does not have access to model '${modelName}'` },
      });
      return;
    }

    // Budget check
    const budgetCheck = await checkBudget(req.userId!, req.apiTokenId || null, req.user?.deptname);
    if (!budgetCheck.allowed) {
      res.status(429).json({
        error: { type: 'budget_exceeded', message: budgetCheck.reason },
      });
      return;
    }

    // Get endpoints (parent + subModels) for round-robin and failover
    // upstreamModelName overrides what model name is sent to the upstream LLM provider
    const endpoints = await getModelEndpoints(model.id, {
      endpointUrl: model.endpointUrl,
      apiKey: model.apiKey,
      modelName: model.upstreamModelName || model.name,
      extraHeaders: model.extraHeaders as Record<string, string> | null,
      extraBody: model.extraBody as Record<string, any> | null,
    });
    const startIdx = await getRoundRobinIndex(model.id, endpoints.length);

    if (endpoints.length > 1) {
      console.log(`[RoundRobin] Model "${model.name}" has ${endpoints.length} endpoints, starting at index ${startIdx}`);
    }

    // Failover loop with circuit breaker
    let lastError: string | undefined;

    for (let attempt = 0; attempt < endpoints.length; attempt++) {
      const idx = (startIdx + attempt) % endpoints.length;
      const endpoint = endpoints[idx]!;

      // Circuit breaker check
      if (!await isEndpointAvailable(endpoint.endpointUrl)) {
        console.log(`[CircuitBreaker] Skipping ${endpoint.endpointUrl}`);
        continue;
      }

      if (attempt > 0) {
        console.log(`[Failover] Model "${model.name}" trying endpoint ${attempt + 1}/${endpoints.length}: ${endpoint.endpointUrl}`);
      }

      // Merge: extraBody defaults (model config) → then client otherParams override
      const llmRequestBody = {
        model: endpoint.modelName,
        messages,
        stream: stream || false,
        ...(endpoint.extraBody || {}),
        ...otherParams,
      };

      const headers = buildHeaders(endpoint);

      const effectiveModel = {
        ...model,
        endpointUrl: endpoint.endpointUrl,
        apiKey: endpoint.apiKey,
      };

      let result: { handled: boolean; statusCode?: number; data?: any; inputTokens?: number; outputTokens?: number; latencyMs?: number; errorMessage?: string };

      if (stream) {
        result = await handleStreamingRequest(res, req, effectiveModel, llmRequestBody, headers, modelName);
      } else {
        result = await handleNonStreamingRequest(res, req, effectiveModel, llmRequestBody, headers, modelName);
      }

      if (result.handled) {
        // Record circuit breaker success
        await recordEndpointSuccess(endpoint.endpointUrl);

        // Record usage if we got token counts
        if (result.inputTokens || result.outputTokens) {
          recordUsage({
            userId: req.userId!,
            loginid: req.user?.loginid || 'unknown',
            modelId: model.id,
            apiTokenId: req.apiTokenId || null,
            inputTokens: result.inputTokens || 0,
            outputTokens: result.outputTokens || 0,
            latencyMs: result.latencyMs,
            deptname: req.user?.deptname || '',
            businessUnit: req.user?.businessUnit || null,
          }).catch((err) => {
            console.error('[Usage] Failed to record usage:', err);
          });
          // Record TPM/TPH rate limit counters
          if (req.apiTokenId) {
            recordTokenRateLimit(req.apiTokenId, result.outputTokens || 0).catch(() => {});
          }
        }

        // Log request (fire-and-forget)
        logRequest({
          apiTokenId: req.apiTokenId || null,
          userId: req.userId || null,
          modelName,
          resolvedModel: model.name,
          method: 'POST',
          path: '/v1/chat/completions',
          statusCode: result.statusCode || 200,
          requestBody: req.body,
          responseBody: result.data || null,
          inputTokens: result.inputTokens || null,
          outputTokens: result.outputTokens || null,
          latencyMs: result.latencyMs || null,
          errorMessage: result.errorMessage || null,
          userAgent: req.headers['user-agent'] || null,
          ipAddress: req.ip || null,
          stream: !!stream,
        }).catch(() => {});

        return;
      }

      // Endpoint failed -> record failure and try next
      await recordEndpointFailure(endpoint.endpointUrl);
      lastError = result.errorMessage || `Endpoint ${endpoint.endpointUrl} failed`;
    }

    // All endpoints failed
    console.error(`[Failover] All ${endpoints.length} endpoints failed for model "${model.name}"`);

    const latencyMs = Date.now() - startTime;
    res.status(503).json({
      error: {
        type: 'service_unavailable',
        message: `All ${endpoints.length} endpoint(s) failed. Please try again later.`,
      },
    });

    // Log the failure
    logRequest({
      apiTokenId: req.apiTokenId || null,
      userId: req.userId || null,
      modelName,
      resolvedModel: model.name,
      method: 'POST',
      path: '/v1/chat/completions',
      statusCode: 503,
      requestBody: req.body,
      responseBody: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs,
      errorMessage: lastError || 'All endpoints failed',
      userAgent: req.headers['user-agent'] || null,
      ipAddress: req.ip || null,
      stream: !!stream,
    }).catch(() => {});

  } catch (error) {
    console.error('Chat completion proxy error:', error);

    const latencyMs = Date.now() - startTime;
    const { model: modelName, stream } = req.body || {};

    if (!res.headersSent) {
      res.status(500).json({ error: { type: 'server_error', message: 'Failed to process chat completion' } });
    }

    logRequest({
      apiTokenId: req.apiTokenId || null,
      userId: req.userId || null,
      modelName: modelName || 'unknown',
      resolvedModel: null,
      method: 'POST',
      path: '/v1/chat/completions',
      statusCode: 500,
      requestBody: req.body,
      responseBody: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      userAgent: req.headers['user-agent'] || null,
      ipAddress: req.ip || null,
      stream: !!stream,
    }).catch(() => {});
  }
});

/**
 * POST /v1/embeddings
 * Proxy embeddings request to actual LLM.
 */
proxyRoutes.post('/embeddings', authenticateApiToken, checkRateLimit, async (req: TokenAuthenticatedRequest, res: Response) => {
  const startTime = Date.now();

  try {
    const { model: modelName, input, ...otherParams } = req.body;

    if (!modelName || !input) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'model and input are required' } });
      return;
    }

    // Resolve model
    const model = await resolveModel(modelName);

    if (!model) {
      res.status(404).json({ error: { type: 'not_found', message: `Model '${modelName}' not found or disabled` } });
      return;
    }

    // Check allowedModels
    if (req.apiToken?.allowedModels?.length && req.apiToken.allowedModels.length > 0 && !req.apiToken.allowedModels.includes(model.id)) {
      res.status(403).json({
        error: { type: 'permission_error', message: `Your API key does not have access to model '${modelName}'` },
      });
      return;
    }

    // Budget check
    const budgetCheck = await checkBudget(req.userId!, req.apiTokenId || null, req.user?.deptname);
    if (!budgetCheck.allowed) {
      res.status(429).json({
        error: { type: 'budget_exceeded', message: budgetCheck.reason },
      });
      return;
    }

    // Get endpoints for round-robin and failover
    const endpoints = await getModelEndpoints(model.id, {
      endpointUrl: model.endpointUrl,
      apiKey: model.apiKey,
      modelName: model.upstreamModelName || model.name,
      extraHeaders: model.extraHeaders as Record<string, string> | null,
      extraBody: model.extraBody as Record<string, any> | null,
    });
    const startIdx = await getRoundRobinIndex(model.id, endpoints.length);

    let lastError: string | undefined;

    for (let attempt = 0; attempt < endpoints.length; attempt++) {
      const idx = (startIdx + attempt) % endpoints.length;
      const endpoint = endpoints[idx]!;

      // Circuit breaker check
      if (!await isEndpointAvailable(endpoint.endpointUrl)) {
        console.log(`[CircuitBreaker] Skipping ${endpoint.endpointUrl}`);
        continue;
      }

      if (attempt > 0) {
        console.log(`[Failover] Embeddings model "${model.name}" trying endpoint ${attempt + 1}/${endpoints.length}: ${endpoint.endpointUrl}`);
      }

      const url = buildEmbeddingsUrl(endpoint.endpointUrl);
      console.log(`[Proxy] user=${req.user?.loginid || 'unknown'} token=${req.apiTokenId || 'none'} model=${model.name} endpoint=${url} (embeddings)`);

      const embeddingsBody = {
        model: endpoint.modelName,
        input,
        ...otherParams,
      };

      const headers = buildHeaders(endpoint);

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(embeddingsBody),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const latencyMs = Date.now() - startTime;

        if (!response.ok) {
          const errorText = await response.text();
          logLLMError('Embeddings', url, response.status, errorText, embeddingsBody, req, modelName);

          // 4xx -> pass through, no failover
          if (response.status >= 400 && response.status < 500) {
            try {
              const errorJson = JSON.parse(errorText);
              res.status(response.status).json(errorJson);
            } catch {
              res.status(response.status).send(errorText);
            }

            logRequest({
              apiTokenId: req.apiTokenId || null,
              userId: req.userId || null,
              modelName,
              resolvedModel: model.name,
              method: 'POST',
              path: '/v1/embeddings',
              statusCode: response.status,
              requestBody: req.body,
              responseBody: null,
              inputTokens: null,
              outputTokens: null,
              latencyMs,
              errorMessage: errorText,
              userAgent: req.headers['user-agent'] || null,
              ipAddress: req.ip || null,
              stream: false,
            }).catch(() => {});

            await recordEndpointSuccess(endpoint.endpointUrl); // 4xx is not an endpoint failure
            return;
          }

          // 5xx -> failover
          console.error(`[Failover] Embeddings endpoint ${url} returned ${response.status}, will try next`);
          await recordEndpointFailure(endpoint.endpointUrl);
          lastError = errorText;
          continue;
        }

        // Success
        const data = await response.json() as {
          usage?: { prompt_tokens?: number; total_tokens?: number };
          [key: string]: unknown;
        };

        await recordEndpointSuccess(endpoint.endpointUrl);

        const inputTokens = data.usage?.prompt_tokens || data.usage?.total_tokens || 0;

        // Record usage
        if (inputTokens > 0) {
          recordUsage({
            userId: req.userId!,
            loginid: req.user?.loginid || 'unknown',
            modelId: model.id,
            apiTokenId: req.apiTokenId || null,
            inputTokens,
            outputTokens: 0,
            latencyMs,
            deptname: req.user?.deptname || '',
            businessUnit: req.user?.businessUnit || null,
          }).catch((err) => {
            console.error('[Usage] Failed to record embeddings usage:', err);
          });
        }

        // Log request
        logRequest({
          apiTokenId: req.apiTokenId || null,
          userId: req.userId || null,
          modelName,
          resolvedModel: model.name,
          method: 'POST',
          path: '/v1/embeddings',
          statusCode: 200,
          requestBody: req.body,
          responseBody: data,
          inputTokens,
          outputTokens: 0,
          latencyMs,
          errorMessage: null,
          userAgent: req.headers['user-agent'] || null,
          ipAddress: req.ip || null,
          stream: false,
        }).catch(() => {});

        res.json(data);
        return;

      } catch (error) {
        console.error(`[Failover] Embeddings endpoint ${url} connection failed:`, error instanceof Error ? error.message : error);
        await recordEndpointFailure(endpoint.endpointUrl);
        lastError = error instanceof Error ? error.message : 'Connection failed';
        continue;
      }
    }

    // All endpoints failed
    const latencyMs = Date.now() - startTime;
    console.error(`[Failover] All ${endpoints.length} endpoints failed for embeddings model "${model.name}"`);
    res.status(503).json({
      error: {
        type: 'service_unavailable',
        message: `All ${endpoints.length} endpoint(s) failed. Please try again later.`,
      },
    });

    logRequest({
      apiTokenId: req.apiTokenId || null,
      userId: req.userId || null,
      modelName,
      resolvedModel: model.name,
      method: 'POST',
      path: '/v1/embeddings',
      statusCode: 503,
      requestBody: req.body,
      responseBody: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs,
      errorMessage: lastError || 'All endpoints failed',
      userAgent: req.headers['user-agent'] || null,
      ipAddress: req.ip || null,
      stream: false,
    }).catch(() => {});

  } catch (error) {
    console.error('Embeddings proxy error:', error);
    const latencyMs = Date.now() - startTime;

    if (!res.headersSent) {
      res.status(500).json({ error: { type: 'server_error', message: 'Failed to process embeddings request' } });
    }

    logRequest({
      apiTokenId: req.apiTokenId || null,
      userId: req.userId || null,
      modelName: req.body?.model || 'unknown',
      resolvedModel: null,
      method: 'POST',
      path: '/v1/embeddings',
      statusCode: 500,
      requestBody: req.body,
      responseBody: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      userAgent: req.headers['user-agent'] || null,
      ipAddress: req.ip || null,
      stream: false,
    }).catch(() => {});
  }
});

/**
 * POST /v1/rerank
 * Proxy rerank request to actual LLM (vLLM Jina-compatible format).
 *
 * Request body:
 *   model (required) - model name/alias
 *   query (required) - search query string
 *   documents (required) - array of document strings or { text: string } objects
 *   top_n (optional) - max results to return
 *   return_documents (optional) - include document text in response (default false)
 *
 * Response:
 *   { id, model, results: [{ index, relevance_score, document? }], usage }
 */
proxyRoutes.post('/rerank', authenticateApiToken, checkRateLimit, async (req: TokenAuthenticatedRequest, res: Response) => {
  const startTime = Date.now();

  try {
    const { model: modelName, query, documents, top_n, return_documents, ...otherParams } = req.body;

    // ---- Input validation ----
    if (!modelName) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'model is required' } });
      return;
    }
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'query is required and must be a string' } });
      return;
    }
    if (!documents || !Array.isArray(documents) || documents.length === 0) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'documents is required and must be a non-empty array' } });
      return;
    }
    if (top_n !== undefined && (typeof top_n !== 'number' || !Number.isInteger(top_n) || top_n < 1)) {
      res.status(400).json({ error: { type: 'invalid_request_error', message: 'top_n must be a positive integer' } });
      return;
    }

    // ---- Resolve model ----
    const model = await resolveModel(modelName);
    if (!model) {
      res.status(404).json({ error: { type: 'not_found', message: `Model '${modelName}' not found or disabled` } });
      return;
    }

    // ---- Check allowedModels ----
    if (req.apiToken?.allowedModels?.length && req.apiToken.allowedModels.length > 0 && !req.apiToken.allowedModels.includes(model.id)) {
      res.status(403).json({
        error: { type: 'permission_error', message: `Your API key does not have access to model '${modelName}'` },
      });
      return;
    }

    // ---- Budget check ----
    const budgetCheck = await checkBudget(req.userId!, req.apiTokenId || null, req.user?.deptname);
    if (!budgetCheck.allowed) {
      res.status(429).json({
        error: { type: 'budget_exceeded', message: budgetCheck.reason },
      });
      return;
    }

    // ---- Get endpoints with failover ----
    const parentEndpoint: EndpointInfo = {
      endpointUrl: model.endpointUrl,
      apiKey: model.apiKey,
      modelName: model.upstreamModelName || model.name,
      extraHeaders: model.extraHeaders as Record<string, string> | null,
      extraBody: model.extraBody as Record<string, any> | null,
    };

    const endpoints = await getModelEndpoints(model.id, parentEndpoint);
    const startIdx = await getRoundRobinIndex(model.id, endpoints.length);
    let lastError: string | null = null;

    for (let attempt = 0; attempt < endpoints.length; attempt++) {
      const idx = (startIdx + attempt) % endpoints.length;
      const endpoint = endpoints[idx]!;

      // Circuit breaker check
      if (!await isEndpointAvailable(endpoint.endpointUrl)) {
        console.log(`[CircuitBreaker] Skipping ${endpoint.endpointUrl}`);
        continue;
      }

      if (attempt > 0) {
        console.log(`[Failover] Rerank model "${model.name}" trying endpoint ${attempt + 1}/${endpoints.length}: ${endpoint.endpointUrl}`);
      }

      const url = buildRerankUrl(endpoint.endpointUrl);
      console.log(`[Proxy] user=${req.user?.loginid || 'unknown'} token=${req.apiTokenId || 'none'} model=${model.name} endpoint=${url} (rerank)`);

      const rerankBody: Record<string, unknown> = {
        model: endpoint.modelName,
        query,
        documents,
      };
      if (top_n !== undefined) rerankBody.top_n = top_n;
      if (return_documents !== undefined) rerankBody.return_documents = return_documents;
      // Pass through any extra params the client sent
      for (const [key, value] of Object.entries(otherParams)) {
        if (!(key in rerankBody)) rerankBody[key] = value;
      }

      const headers = buildHeaders(endpoint);

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(rerankBody),
          signal: controller.signal,
        });

        clearTimeout(timeoutId);
        const latencyMs = Date.now() - startTime;

        if (!response.ok) {
          const errorText = await response.text();
          console.error(
            `[LLM-Error] Rerank\n` +
            `  User: ${req.user?.loginid || 'unknown'}\n` +
            `  Token: ${req.apiTokenId || 'none'}\n` +
            `  Model: ${modelName}\n` +
            `  URL: ${url}\n` +
            `  Status: ${response.status}\n` +
            `  Error: ${errorText.substring(0, 2000)}`
          );

          // 4xx -> pass through, no failover
          if (response.status >= 400 && response.status < 500) {
            try {
              const errorJson = JSON.parse(errorText);
              res.status(response.status).json(errorJson);
            } catch {
              res.status(response.status).send(errorText);
            }

            logRequest({
              apiTokenId: req.apiTokenId || null,
              userId: req.userId || null,
              modelName,
              resolvedModel: model.name,
              method: 'POST',
              path: '/v1/rerank',
              statusCode: response.status,
              requestBody: req.body,
              responseBody: null,
              inputTokens: null,
              outputTokens: null,
              latencyMs,
              errorMessage: errorText,
              userAgent: req.headers['user-agent'] || null,
              ipAddress: req.ip || null,
              stream: false,
            }).catch(() => {});

            await recordEndpointSuccess(endpoint.endpointUrl);
            return;
          }

          // 5xx -> failover
          console.error(`[Failover] Rerank endpoint ${url} returned ${response.status}, will try next`);
          await recordEndpointFailure(endpoint.endpointUrl);
          lastError = errorText;
          continue;
        }

        // ---- Success ----
        const data = await response.json() as {
          usage?: { total_tokens?: number; prompt_tokens?: number };
          [key: string]: unknown;
        };

        await recordEndpointSuccess(endpoint.endpointUrl);

        const inputTokens = data.usage?.prompt_tokens || data.usage?.total_tokens || 0;

        // Record usage (rerank has no output tokens)
        if (inputTokens > 0) {
          recordUsage({
            userId: req.userId!,
            loginid: req.user?.loginid || 'unknown',
            modelId: model.id,
            apiTokenId: req.apiTokenId || null,
            inputTokens,
            outputTokens: 0,
            latencyMs,
            deptname: req.user?.deptname || '',
            businessUnit: req.user?.businessUnit || null,
          }).catch((err) => {
            console.error('[Usage] Failed to record rerank usage:', err);
          });
        }

        // Log request
        logRequest({
          apiTokenId: req.apiTokenId || null,
          userId: req.userId || null,
          modelName,
          resolvedModel: model.name,
          method: 'POST',
          path: '/v1/rerank',
          statusCode: 200,
          requestBody: req.body,
          responseBody: data,
          inputTokens,
          outputTokens: 0,
          latencyMs,
          errorMessage: null,
          userAgent: req.headers['user-agent'] || null,
          ipAddress: req.ip || null,
          stream: false,
        }).catch(() => {});

        res.json(data);
        return;

      } catch (error) {
        console.error(`[Failover] Rerank endpoint ${url} connection failed:`, error instanceof Error ? error.message : error);
        await recordEndpointFailure(endpoint.endpointUrl);
        lastError = error instanceof Error ? error.message : 'Connection failed';
        continue;
      }
    }

    // ---- All endpoints failed ----
    const latencyMs = Date.now() - startTime;
    console.error(`[Failover] All ${endpoints.length} endpoints failed for rerank model "${model.name}"`);
    res.status(503).json({
      error: {
        type: 'service_unavailable',
        message: `All ${endpoints.length} endpoint(s) failed. Please try again later.`,
      },
    });

    logRequest({
      apiTokenId: req.apiTokenId || null,
      userId: req.userId || null,
      modelName,
      resolvedModel: model.name,
      method: 'POST',
      path: '/v1/rerank',
      statusCode: 503,
      requestBody: req.body,
      responseBody: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs,
      errorMessage: lastError || 'All endpoints failed',
      userAgent: req.headers['user-agent'] || null,
      ipAddress: req.ip || null,
      stream: false,
    }).catch(() => {});

  } catch (error) {
    console.error('Rerank proxy error:', error);
    const latencyMs = Date.now() - startTime;

    if (!res.headersSent) {
      res.status(500).json({ error: { type: 'server_error', message: 'Failed to process rerank request' } });
    }

    logRequest({
      apiTokenId: req.apiTokenId || null,
      userId: req.userId || null,
      modelName: req.body?.model || 'unknown',
      resolvedModel: null,
      method: 'POST',
      path: '/v1/rerank',
      statusCode: 500,
      requestBody: req.body,
      responseBody: null,
      inputTokens: null,
      outputTokens: null,
      latencyMs,
      errorMessage: error instanceof Error ? error.message : 'Unknown error',
      userAgent: req.headers['user-agent'] || null,
      ipAddress: req.ip || null,
      stream: false,
    }).catch(() => {});
  }
});

/**
 * POST /v1/completions
 * Legacy completions endpoint (not implemented).
 */
proxyRoutes.post('/completions', authenticateApiToken, async (_req: TokenAuthenticatedRequest, res: Response) => {
  res.status(501).json({
    error: { type: 'not_implemented', message: 'Legacy completions endpoint not implemented. Use /v1/chat/completions instead.' },
  });
});

/**
 * GET /v1/health
 * Health check endpoint (no auth required).
 */
proxyRoutes.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    await redis.ping();

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Health check failed:', error);
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});
