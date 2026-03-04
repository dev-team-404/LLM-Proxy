import { useState, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Edit2,
  Trash2,
  ChevronDown,
  ChevronRight,
  GripVertical,
  ArrowUp,
  ArrowDown,
  Play,
  CheckCircle,
  XCircle,
  Loader2,
  AlertTriangle,
  RefreshCw,
  X,
  Server,
  Eye,
  ToggleLeft,
  ToggleRight,
} from 'lucide-react';
import { api } from '../services/api';

interface TestResult {
  passed: boolean;
  latencyMs: number;
  message: string;
  request?: Record<string, unknown>;
  response?: Record<string, unknown> | string;
}

interface SubModel {
  id: string;
  modelName: string;
  endpointUrl: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  sortOrder: number;
  enabled: boolean;
}

type ModelType = 'CHAT' | 'EMBEDDING' | 'RERANKING';

interface Model {
  id: string;
  name: string;
  displayName: string;
  alias?: string;
  upstreamModelName?: string;
  endpointUrl: string;
  apiKey?: string;
  extraHeaders?: Record<string, string>;
  extraBody?: Record<string, any>;
  maxTokens?: number;
  enabled: boolean;
  isHealthy?: boolean;
  sortOrder?: number;
  type?: ModelType;
}

interface ModelFormData {
  name: string;
  displayName: string;
  alias: string;
  upstreamModelName: string;
  endpointUrl: string;
  apiKey: string;
  extraHeaders: string;
  extraBody: string;
  maxTokens: string;
  enabled: boolean;
  type: ModelType;
}

interface SubModelFormData {
  modelName: string;
  endpointUrl: string;
  apiKey: string;
  extraHeaders: string;
  extraBody: string;
  enabled: boolean;
  sortOrder: string;
}

const emptyForm: ModelFormData = {
  name: '',
  displayName: '',
  alias: '',
  upstreamModelName: '',
  endpointUrl: '',
  apiKey: '',
  extraHeaders: '{}',
  extraBody: '{}',
  maxTokens: '',
  enabled: true,
  type: 'CHAT',
};

const emptySubModelForm: SubModelFormData = {
  modelName: '',
  endpointUrl: '',
  apiKey: '',
  extraHeaders: '{}',
  extraBody: '{}',
  enabled: true,
  sortOrder: '0',
};

function TestResultDisplay({ label, result }: { label: string; result?: TestResult }) {
  const [expanded, setExpanded] = useState(false);
  if (!result) return null;
  const hasDetail = result.request || result.response;
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-sm">
        {result.passed ? (
          <CheckCircle className="w-4 h-4 text-green-500 flex-shrink-0" />
        ) : (
          <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
        )}
        <span className="font-medium text-gray-700">{label}:</span>
        <span className={result.passed ? 'text-green-600' : 'text-red-600'}>
          {result.passed ? `통과 (${result.latencyMs}ms)` : result.message.substring(0, 150)}
        </span>
        {hasDetail && (
          <button
            type="button"
            onClick={() => setExpanded(!expanded)}
            className="ml-auto text-xs text-blue-500 hover:text-blue-700 flex-shrink-0"
          >
            {expanded ? '접기' : '상세'}
          </button>
        )}
      </div>
      {expanded && hasDetail && (
        <div className="ml-6 space-y-2">
          {result.request && (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-0.5">Request Body</p>
              <pre className="text-xs bg-gray-100 rounded p-2 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-all">
                {JSON.stringify(result.request, null, 2)}
              </pre>
            </div>
          )}
          {result.response && (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-0.5">Response Body</p>
              <pre className="text-xs bg-gray-100 rounded p-2 overflow-x-auto max-h-60 overflow-y-auto whitespace-pre-wrap break-all">
                {typeof result.response === 'string' ? result.response : JSON.stringify(result.response, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ModelDialog({
  open,
  onClose,
  onSubmit,
  initialData,
  title,
  loading,
  isNew,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: ModelFormData) => void;
  initialData: ModelFormData;
  title: string;
  loading: boolean;
  isNew: boolean;
}) {
  const [form, setForm] = useState<ModelFormData>(initialData);
  const [headersError, setHeadersError] = useState('');
  const [testResults, setTestResults] = useState<{
    chatCompletion?: TestResult;
    toolCallA?: TestResult;
    toolCallB?: TestResult;
    toolCallC?: TestResult;
    toolCallD?: TestResult;
    allPassed?: boolean;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [endpointChanged, setEndpointChanged] = useState(false);
  const [vlTestResult, setVlTestResult] = useState<{
    visionDescribe?: TestResult;
    visionJudge?: TestResult;
    passed?: boolean;
  } | null>(null);
  const [vlTesting, setVlTesting] = useState(false);
  const [embeddingTestResult, setEmbeddingTestResult] = useState<{ embedding?: TestResult; passed?: boolean } | null>(null);
  const [embeddingTesting, setEmbeddingTesting] = useState(false);
  const [rerankTestResult, setRerankTestResult] = useState<{ rerank?: TestResult; passed?: boolean } | null>(null);
  const [rerankTesting, setRerankTesting] = useState(false);

  // Track initial endpoint values for edit mode
  const [initialEndpoint, setInitialEndpoint] = useState('');
  const [initialApiKey, setInitialApiKey] = useState('');
  const [initialHeaders, setInitialHeaders] = useState('');

  useEffect(() => {
    if (open) {
      setForm(initialData);
      setHeadersError('');
      setTestResults(null);
      setEndpointChanged(false);
      setInitialEndpoint(initialData.endpointUrl);
      setInitialApiKey(initialData.apiKey);
      setInitialHeaders(initialData.extraHeaders);
      setVlTestResult(null);
      setVlTesting(false);
      setEmbeddingTestResult(null);
      setEmbeddingTesting(false);
      setRerankTestResult(null);
      setRerankTesting(false);
    }
  }, [open, initialData]);

  // Detect endpoint-related changes in edit mode
  useEffect(() => {
    if (!isNew) {
      const changed =
        form.endpointUrl !== initialEndpoint ||
        form.apiKey !== initialApiKey ||
        form.extraHeaders !== initialHeaders;
      if (changed && !endpointChanged) {
        setEndpointChanged(true);
        setTestResults(null);
      }
    }
  }, [form.endpointUrl, form.apiKey, form.extraHeaders, initialEndpoint, initialApiKey, initialHeaders, isNew, endpointChanged]);

  if (!open) return null;

  const runTest = async () => {
    setTesting(true);
    setTestResults(null);
    try {
      const result = await api.admin.models.test({
        endpointUrl: form.endpointUrl,
        modelName: form.upstreamModelName || form.name,
        apiKey: form.apiKey || undefined,
        extraHeaders: form.extraHeaders ? JSON.parse(form.extraHeaders) : undefined,
      });
      setTestResults(result);
    } catch {
      const fail: TestResult = { passed: false, latencyMs: 0, message: 'Test request failed' };
      setTestResults({
        chatCompletion: fail, toolCallA: fail, toolCallB: fail, toolCallC: fail, toolCallD: fail,
        allPassed: false,
      });
    } finally {
      setTesting(false);
    }
  };

  const runVLTest = async () => {
    setVlTesting(true);
    setVlTestResult(null);
    try {
      const result = await api.admin.models.testVL({
        endpointUrl: form.endpointUrl,
        modelName: form.upstreamModelName || form.name,
        apiKey: form.apiKey || undefined,
        extraHeaders: form.extraHeaders ? JSON.parse(form.extraHeaders) : undefined,
      });
      setVlTestResult(result);
    } catch {
      setVlTestResult({
        visionDescribe: { passed: false, latencyMs: 0, message: 'VL test request failed' },
        visionJudge: { passed: false, latencyMs: 0, message: 'VL test request failed' },
        passed: false,
      });
    } finally {
      setVlTesting(false);
    }
  };

  const runEmbeddingTest = async () => {
    setEmbeddingTesting(true);
    setEmbeddingTestResult(null);
    try {
      const result = await api.admin.models.testEmbedding({
        endpointUrl: form.endpointUrl,
        modelName: form.upstreamModelName || form.name,
        apiKey: form.apiKey || undefined,
        extraHeaders: form.extraHeaders ? JSON.parse(form.extraHeaders) : undefined,
      });
      setEmbeddingTestResult(result);
    } catch {
      setEmbeddingTestResult({ embedding: { passed: false, latencyMs: 0, message: 'Embedding test request failed' }, passed: false });
    } finally {
      setEmbeddingTesting(false);
    }
  };

  const runRerankTest = async () => {
    setRerankTesting(true);
    setRerankTestResult(null);
    try {
      const result = await api.admin.models.testRerank({
        endpointUrl: form.endpointUrl,
        modelName: form.upstreamModelName || form.name,
        apiKey: form.apiKey || undefined,
        extraHeaders: form.extraHeaders ? JSON.parse(form.extraHeaders) : undefined,
      });
      setRerankTestResult(result);
    } catch {
      setRerankTestResult({ rerank: { passed: false, latencyMs: 0, message: 'Rerank test request failed' }, passed: false });
    } finally {
      setRerankTesting(false);
    }
  };

  // For new models: test must pass. For edits with endpoint changes: test must pass.
  const needsTest = isNew || endpointChanged;
  const testPassed = (() => {
    switch (form.type) {
      case 'EMBEDDING': return embeddingTestResult?.passed === true;
      case 'RERANKING': return rerankTestResult?.passed === true;
      default: return testResults?.allPassed === true;
    }
  })();
  const canSave = !needsTest || testPassed;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (form.extraHeaders.trim()) {
        JSON.parse(form.extraHeaders);
      }
      if (form.extraBody.trim()) {
        JSON.parse(form.extraBody);
      }
      setHeadersError('');
      onSubmit(form);
    } catch {
      setHeadersError('유효한 JSON 형식이 아닙니다.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">모델 이름 *</label>
            <input
              type="text"
              required
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
              placeholder="gpt-4o"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">표시 이름 *</label>
            <input
              type="text"
              required
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
              placeholder="GPT-4o"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">별칭 (Alias)</label>
            <input
              type="text"
              value={form.alias}
              onChange={(e) => setForm({ ...form, alias: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
              placeholder="gpt4o"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Upstream 모델명</label>
            <input
              type="text"
              value={form.upstreamModelName}
              onChange={(e) => setForm({ ...form, upstreamModelName: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
              placeholder="비워두면 모델 이름과 동일"
            />
            <p className="mt-1 text-xs text-gray-400">LLM 제공자에게 전달되는 모델명. vLLM 등에서 실제 호스팅되는 이름이 다를 때 설정</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">모델 유형 *</label>
            <select
              value={form.type}
              onChange={(e) => {
                const newType = e.target.value as ModelType;
                setForm({ ...form, type: newType });
                setTestResults(null);
                setEmbeddingTestResult(null);
                setRerankTestResult(null);
                setVlTestResult(null);
              }}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
            >
              <option value="CHAT">Chat (채팅 모델)</option>
              <option value="EMBEDDING">Embedding (임베딩 모델)</option>
              <option value="RERANKING">Reranking (리랭킹 모델)</option>
            </select>
            <p className="mt-1 text-xs text-gray-400">
              {form.type === 'CHAT' && 'Chat Completion + Tool Call 테스트를 진행합니다.'}
              {form.type === 'EMBEDDING' && 'Embedding API 테스트를 진행합니다.'}
              {form.type === 'RERANKING' && 'Rerank API 테스트를 진행합니다.'}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">엔드포인트 URL *</label>
            <input
              type="url"
              required
              value={form.endpointUrl}
              onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
              placeholder="https://api.openai.com/v1"
            />
            <p className="mt-1 text-xs text-gray-400">
              {form.type === 'CHAT' && 'v1/ 또는 v1/chat/completions 형식 모두 사용 가능'}
              {form.type === 'EMBEDDING' && 'v1/ 또는 v1/embeddings 형식 모두 사용 가능'}
              {form.type === 'RERANKING' && 'v1/ 또는 v1/rerank 형식 모두 사용 가능'}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
              placeholder="sk-..."
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">추가 헤더 (JSON)</label>
            <textarea
              value={form.extraHeaders}
              onChange={(e) => setForm({ ...form, extraHeaders: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none font-mono text-sm"
              rows={3}
              placeholder='{"X-Custom-Header": "value"}'
            />
            {headersError && <p className="text-red-500 text-xs mt-1">{headersError}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">추가 Body 파라미터 (JSON)</label>
            <textarea
              value={form.extraBody}
              onChange={(e) => setForm({ ...form, extraBody: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none font-mono text-sm"
              rows={3}
              placeholder='{"chat_template_kwargs": {"thinking": true}}'
            />
            <p className="mt-1 text-xs text-gray-400">요청 body에 기본으로 포함될 파라미터. 클라이언트가 동일 키를 보내면 클라이언트 값이 우선</p>
          </div>
          {form.type === 'CHAT' && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">최대 토큰</label>
              <input
                type="number"
                value={form.maxTokens}
                onChange={(e) => setForm({ ...form, maxTokens: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
                placeholder="4096"
              />
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="enabled"
              checked={form.enabled}
              onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
              className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
            />
            <label htmlFor="enabled" className="text-sm font-medium text-gray-700">활성화</label>
          </div>

          {/* Endpoint Test Section - conditional by model type */}
          {form.type === 'CHAT' && (
            <>
              <div className="border-t pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-gray-700">엔드포인트 테스트</h4>
                  <button
                    type="button"
                    onClick={runTest}
                    disabled={testing || !form.endpointUrl}
                    className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                  >
                    {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    테스트 실행
                  </button>
                </div>

                {testResults && (
                  <div className="space-y-2 bg-gray-50 rounded-lg p-3">
                    <TestResultDisplay label="Chat Completion" result={testResults.chatCompletion} />
                    <TestResultDisplay label="ToolCall-A (temp=0, required)" result={testResults.toolCallA} />
                    <TestResultDisplay label="ToolCall-B (temp=0, auto)" result={testResults.toolCallB} />
                    <TestResultDisplay label="ToolCall-C (default, required)" result={testResults.toolCallC} />
                    <TestResultDisplay label="ToolCall-D (default, auto)" result={testResults.toolCallD} />
                  </div>
                )}

                {needsTest && !testPassed && (
                  <p className="text-xs text-amber-600 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {isNew ? '새 모델 추가 시 Chat 테스트 + Tool Call 1개 이상 통과해야 합니다.' : '엔드포인트 설정이 변경되었습니다. 재테스트가 필요합니다.'}
                  </p>
                )}
              </div>

              {/* VL (Vision-Language) Test Section */}
              <div className="border-t pt-3 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-gray-700">
                    VL (Vision-Language) 테스트
                    <span className="ml-2 text-xs font-normal text-gray-400">(선택사항)</span>
                  </h4>
                  <button
                    type="button"
                    onClick={runVLTest}
                    disabled={vlTesting || !form.endpointUrl}
                    className="px-3 py-1.5 text-sm bg-purple-500 text-white rounded-lg hover:bg-purple-600 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                  >
                    {vlTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                    VL 테스트
                  </button>
                </div>

                {vlTestResult && (
                  <div className="space-y-2 bg-purple-50 rounded-lg p-3">
                    <TestResultDisplay label="VL-Describe (이미지 설명)" result={vlTestResult.visionDescribe} />
                    <TestResultDisplay label="VL-Judge (설명 평가)" result={vlTestResult.visionJudge} />
                    <div className="flex items-center gap-2 text-sm pt-1 border-t border-purple-100">
                      {vlTestResult.passed ? (
                        <>
                          <CheckCircle className="w-4 h-4 text-green-500" />
                          <span className="text-green-600 font-medium">VL 테스트 통과</span>
                        </>
                      ) : (
                        <>
                          <XCircle className="w-4 h-4 text-red-500" />
                          <span className="text-red-600 font-medium">VL 테스트 실패</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {form.type === 'EMBEDDING' && (
            <div className="border-t pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-gray-700">Embedding 테스트</h4>
                <button
                  type="button"
                  onClick={runEmbeddingTest}
                  disabled={embeddingTesting || !form.endpointUrl}
                  className="px-3 py-1.5 text-sm bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                >
                  {embeddingTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  테스트 실행
                </button>
              </div>

              {embeddingTestResult && (
                <div className="space-y-2 bg-emerald-50 rounded-lg p-3">
                  <TestResultDisplay label="Embedding" result={embeddingTestResult.embedding} />
                </div>
              )}

              {needsTest && !testPassed && (
                <p className="text-xs text-amber-600 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {isNew ? 'Embedding 모델 추가 시 Embedding 테스트를 통과해야 합니다.' : '엔드포인트 설정이 변경되었습니다. 재테스트가 필요합니다.'}
                </p>
              )}
            </div>
          )}

          {form.type === 'RERANKING' && (
            <div className="border-t pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-gray-700">Rerank 테스트</h4>
                <button
                  type="button"
                  onClick={runRerankTest}
                  disabled={rerankTesting || !form.endpointUrl}
                  className="px-3 py-1.5 text-sm bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                >
                  {rerankTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  테스트 실행
                </button>
              </div>

              {rerankTestResult && (
                <div className="space-y-2 bg-orange-50 rounded-lg p-3">
                  <TestResultDisplay label="Rerank" result={rerankTestResult.rerank} />
                </div>
              )}

              {needsTest && !testPassed && (
                <p className="text-xs text-amber-600 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  {isNew ? 'Reranking 모델 추가 시 Rerank 테스트를 통과해야 합니다.' : '엔드포인트 설정이 변경되었습니다. 재테스트가 필요합니다.'}
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={loading || !canSave}
              className="px-4 py-2 text-sm text-white bg-brand-500 rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              저장
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SubModelDialog({
  open,
  onClose,
  onSubmit,
  parentModel,
  loading,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (data: SubModelFormData) => void;
  parentModel: Model;
  loading: boolean;
}) {
  const [form, setForm] = useState<SubModelFormData>(emptySubModelForm);
  const [headersError, setHeadersError] = useState('');
  const [testResults, setTestResults] = useState<{
    chatCompletion?: TestResult;
    toolCallA?: TestResult;
    toolCallB?: TestResult;
    toolCallC?: TestResult;
    toolCallD?: TestResult;
    allPassed?: boolean;
  } | null>(null);
  const [testing, setTesting] = useState(false);
  const [vlTestResult, setVlTestResult] = useState<{
    visionDescribe?: TestResult;
    visionJudge?: TestResult;
    passed?: boolean;
  } | null>(null);
  const [vlTesting, setVlTesting] = useState(false);
  const [embeddingTestResult, setEmbeddingTestResult] = useState<{ embedding?: TestResult; passed?: boolean } | null>(null);
  const [embeddingTesting, setEmbeddingTesting] = useState(false);
  const [rerankTestResult, setRerankTestResult] = useState<{ rerank?: TestResult; passed?: boolean } | null>(null);
  const [rerankTesting, setRerankTesting] = useState(false);

  const parentType: ModelType = parentModel.type || 'CHAT';

  useEffect(() => {
    if (open) {
      setForm(emptySubModelForm);
      setHeadersError('');
      setTestResults(null);
      setVlTestResult(null);
      setVlTesting(false);
      setEmbeddingTestResult(null);
      setEmbeddingTesting(false);
      setRerankTestResult(null);
      setRerankTesting(false);
    }
  }, [open]);

  if (!open) return null;

  const getTestParams = () => ({
    endpointUrl: form.endpointUrl,
    modelName: form.modelName || parentModel.upstreamModelName || parentModel.name,
    apiKey: form.apiKey || parentModel.apiKey || undefined,
    extraHeaders: form.extraHeaders ? JSON.parse(form.extraHeaders) : parentModel.extraHeaders || undefined,
  });

  const runTest = async () => {
    setTesting(true);
    setTestResults(null);
    try {
      const result = await api.admin.models.test(getTestParams());
      setTestResults(result);
    } catch {
      const fail: TestResult = { passed: false, latencyMs: 0, message: 'Test request failed' };
      setTestResults({
        chatCompletion: fail, toolCallA: fail, toolCallB: fail, toolCallC: fail, toolCallD: fail,
        allPassed: false,
      });
    } finally {
      setTesting(false);
    }
  };

  const runVLTest = async () => {
    setVlTesting(true);
    setVlTestResult(null);
    try {
      const result = await api.admin.models.testVL(getTestParams());
      setVlTestResult(result);
    } catch {
      setVlTestResult({
        visionDescribe: { passed: false, latencyMs: 0, message: 'VL test request failed' },
        visionJudge: { passed: false, latencyMs: 0, message: 'VL test request failed' },
        passed: false,
      });
    } finally {
      setVlTesting(false);
    }
  };

  const runEmbeddingTest = async () => {
    setEmbeddingTesting(true);
    setEmbeddingTestResult(null);
    try {
      const result = await api.admin.models.testEmbedding(getTestParams());
      setEmbeddingTestResult(result);
    } catch {
      setEmbeddingTestResult({ embedding: { passed: false, latencyMs: 0, message: 'Embedding test request failed' }, passed: false });
    } finally {
      setEmbeddingTesting(false);
    }
  };

  const runRerankTest = async () => {
    setRerankTesting(true);
    setRerankTestResult(null);
    try {
      const result = await api.admin.models.testRerank(getTestParams());
      setRerankTestResult(result);
    } catch {
      setRerankTestResult({ rerank: { passed: false, latencyMs: 0, message: 'Rerank test request failed' }, passed: false });
    } finally {
      setRerankTesting(false);
    }
  };

  const testPassed = (() => {
    switch (parentType) {
      case 'EMBEDDING': return embeddingTestResult?.passed === true;
      case 'RERANKING': return rerankTestResult?.passed === true;
      default: return testResults?.allPassed === true;
    }
  })();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      if (form.extraHeaders.trim()) {
        JSON.parse(form.extraHeaders);
      }
      if (form.extraBody.trim()) {
        JSON.parse(form.extraBody);
      }
      setHeadersError('');
      onSubmit(form);
    } catch {
      setHeadersError('유효한 JSON 형식이 아닙니다.');
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-6 border-b">
          <div>
            <h2 className="text-lg font-semibold">서브모델 추가</h2>
            <p className="text-sm text-gray-500 mt-0.5">부모 모델: {parentModel.displayName}</p>
          </div>
          <button onClick={onClose} className="p-1 hover:bg-gray-100 rounded">
            <X className="w-5 h-5" />
          </button>
        </div>
        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">모델 이름</label>
            <input
              type="text"
              value={form.modelName}
              onChange={(e) => setForm({ ...form, modelName: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
              placeholder={`비워두면 "${parentModel.name}" 사용`}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">엔드포인트 URL *</label>
            <input
              type="url"
              required
              value={form.endpointUrl}
              onChange={(e) => setForm({ ...form, endpointUrl: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
              placeholder="https://api.openai.com/v1"
            />
            <p className="mt-1 text-xs text-gray-400">
              {parentType === 'EMBEDDING' && 'v1/ 또는 v1/embeddings 형식 모두 사용 가능'}
              {parentType === 'RERANKING' && 'v1/ 또는 v1/rerank 형식 모두 사용 가능'}
              {parentType === 'CHAT' && 'v1/ 또는 v1/chat/completions 형식 모두 사용 가능'}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
            <input
              type="password"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
              placeholder="비워두면 부모 모델 키 사용"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">추가 헤더 (JSON)</label>
            <textarea
              value={form.extraHeaders}
              onChange={(e) => setForm({ ...form, extraHeaders: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none font-mono text-sm"
              rows={2}
              placeholder='{"X-Custom-Header": "value"}'
            />
            {headersError && <p className="text-red-500 text-xs mt-1">{headersError}</p>}
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">추가 Body 파라미터 (JSON)</label>
            <textarea
              value={form.extraBody}
              onChange={(e) => setForm({ ...form, extraBody: e.target.value })}
              className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none font-mono text-sm"
              rows={2}
              placeholder='{"chat_template_kwargs": {"thinking": true}}'
            />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">정렬 순서</label>
              <input
                type="number"
                value={form.sortOrder}
                onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent outline-none"
              />
            </div>
            <div className="flex items-end">
              <div className="flex items-center gap-2 pb-2">
                <input
                  type="checkbox"
                  id="sub-enabled"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  className="w-4 h-4 rounded border-gray-300 text-brand-600 focus:ring-brand-500"
                />
                <label htmlFor="sub-enabled" className="text-sm font-medium text-gray-700">활성화</label>
              </div>
            </div>
          </div>

          {/* Endpoint Test Section - conditional by parent model type */}
          {parentType === 'CHAT' && (
            <>
              <div className="border-t pt-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-gray-700">엔드포인트 테스트</h4>
                  <button
                    type="button"
                    onClick={runTest}
                    disabled={testing || !form.endpointUrl}
                    className="px-3 py-1.5 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                  >
                    {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                    테스트 실행
                  </button>
                </div>

                {testResults && (
                  <div className="space-y-2 bg-gray-50 rounded-lg p-3">
                    <TestResultDisplay label="Chat Completion" result={testResults.chatCompletion} />
                    <TestResultDisplay label="ToolCall-A (temp=0, required)" result={testResults.toolCallA} />
                    <TestResultDisplay label="ToolCall-B (temp=0, auto)" result={testResults.toolCallB} />
                    <TestResultDisplay label="ToolCall-C (default, required)" result={testResults.toolCallC} />
                    <TestResultDisplay label="ToolCall-D (default, auto)" result={testResults.toolCallD} />
                  </div>
                )}

                {!testPassed && (
                  <p className="text-xs text-amber-600 flex items-center gap-1">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    서브모델 추가 시 Chat 테스트 + Tool Call 1개 이상 통과해야 합니다.
                  </p>
                )}
              </div>

              <div className="border-t pt-3 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-sm font-semibold text-gray-700">
                    VL (Vision-Language) 테스트
                    <span className="ml-2 text-xs font-normal text-gray-400">(선택사항)</span>
                  </h4>
                  <button
                    type="button"
                    onClick={runVLTest}
                    disabled={vlTesting || !form.endpointUrl}
                    className="px-3 py-1.5 text-sm bg-purple-500 text-white rounded-lg hover:bg-purple-600 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                  >
                    {vlTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Eye className="w-3.5 h-3.5" />}
                    VL 테스트
                  </button>
                </div>

                {vlTestResult && (
                  <div className="space-y-2 bg-purple-50 rounded-lg p-3">
                    <TestResultDisplay label="VL-Describe (이미지 설명)" result={vlTestResult.visionDescribe} />
                    <TestResultDisplay label="VL-Judge (설명 평가)" result={vlTestResult.visionJudge} />
                    <div className="flex items-center gap-2 text-sm pt-1 border-t border-purple-100">
                      {vlTestResult.passed ? (
                        <>
                          <CheckCircle className="w-4 h-4 text-green-500" />
                          <span className="text-green-600 font-medium">VL 테스트 통과</span>
                        </>
                      ) : (
                        <>
                          <XCircle className="w-4 h-4 text-red-500" />
                          <span className="text-red-600 font-medium">VL 테스트 실패</span>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {parentType === 'EMBEDDING' && (
            <div className="border-t pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-gray-700">Embedding 테스트</h4>
                <button
                  type="button"
                  onClick={runEmbeddingTest}
                  disabled={embeddingTesting || !form.endpointUrl}
                  className="px-3 py-1.5 text-sm bg-emerald-500 text-white rounded-lg hover:bg-emerald-600 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                >
                  {embeddingTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  테스트 실행
                </button>
              </div>
              {embeddingTestResult && (
                <div className="space-y-2 bg-emerald-50 rounded-lg p-3">
                  <TestResultDisplay label="Embedding" result={embeddingTestResult.embedding} />
                </div>
              )}
              {!testPassed && (
                <p className="text-xs text-amber-600 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  서브모델 추가 시 Embedding 테스트를 통과해야 합니다.
                </p>
              )}
            </div>
          )}

          {parentType === 'RERANKING' && (
            <div className="border-t pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-semibold text-gray-700">Rerank 테스트</h4>
                <button
                  type="button"
                  onClick={runRerankTest}
                  disabled={rerankTesting || !form.endpointUrl}
                  className="px-3 py-1.5 text-sm bg-orange-500 text-white rounded-lg hover:bg-orange-600 disabled:opacity-50 flex items-center gap-1.5 transition-colors"
                >
                  {rerankTesting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                  테스트 실행
                </button>
              </div>
              {rerankTestResult && (
                <div className="space-y-2 bg-orange-50 rounded-lg p-3">
                  <TestResultDisplay label="Rerank" result={rerankTestResult.rerank} />
                </div>
              )}
              {!testPassed && (
                <p className="text-xs text-amber-600 flex items-center gap-1">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  서브모델 추가 시 Rerank 테스트를 통과해야 합니다.
                </p>
              )}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
            >
              취소
            </button>
            <button
              type="submit"
              disabled={loading || !testPassed}
              className="px-4 py-2 text-sm text-white bg-brand-500 rounded-lg hover:bg-brand-600 transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {loading && <Loader2 className="w-4 h-4 animate-spin" />}
              추가
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SubModelRow({
  modelId,
  sub,
}: {
  modelId: string;
  sub: SubModel;
}) {
  const queryClient = useQueryClient();

  const deleteMut = useMutation({
    mutationFn: () => api.admin.models.deleteSubModel(modelId, sub.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'models', 'subModels', modelId] });
    },
    onError: () => alert('서브모델 삭제에 실패했습니다.'),
  });

  return (
    <tr className="border-b border-gray-50 bg-gray-50/50">
      <td className="py-2 px-4" />
      <td className="py-2 px-4 text-sm text-gray-600 pl-10">{sub.modelName || '-'}</td>
      <td className="py-2 px-4" />
      <td className="py-2 px-4 text-sm text-gray-500 font-mono text-xs">{sub.endpointUrl}</td>
      <td className="py-2 px-4 text-sm text-gray-600">{sub.sortOrder}</td>
      <td className="py-2 px-4">
        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
          sub.enabled ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'
        }`}>
          {sub.enabled ? '활성' : '비활성'}
        </span>
      </td>
      <td className="py-2 px-4" />
      <td className="py-2 px-4">
        <button
          onClick={() => {
            if (confirm('이 서브모델을 삭제하시겠습니까?')) deleteMut.mutate();
          }}
          className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </td>
    </tr>
  );
}

export default function AdminModels() {
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [editModel, setEditModel] = useState<Model | null>(null);
  const [expandedModel, setExpandedModel] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [addSubModelFor, setAddSubModelFor] = useState<Model | null>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'models'],
    queryFn: () => api.admin.models.list(),
  });

  const createMut = useMutation({
    mutationFn: (formData: ModelFormData) =>
      api.admin.models.create({
        name: formData.name,
        displayName: formData.displayName,
        alias: formData.alias || undefined,
        upstreamModelName: formData.upstreamModelName || undefined,
        endpointUrl: formData.endpointUrl,
        apiKey: formData.apiKey || undefined,
        extraHeaders: formData.extraHeaders ? JSON.parse(formData.extraHeaders) : undefined,
        extraBody: formData.extraBody ? JSON.parse(formData.extraBody) : undefined,
        maxTokens: formData.maxTokens ? parseInt(formData.maxTokens) : undefined,
        enabled: formData.enabled,
        type: formData.type,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
      setShowCreate(false);
    },
    onError: () => alert('모델 생성에 실패했습니다.'),
  });

  const updateMut = useMutation({
    mutationFn: ({ id, formData }: { id: string; formData: ModelFormData }) =>
      api.admin.models.update(id, {
        name: formData.name,
        displayName: formData.displayName,
        alias: formData.alias || null,
        upstreamModelName: formData.upstreamModelName || null,
        endpointUrl: formData.endpointUrl,
        apiKey: formData.apiKey || null,
        extraHeaders: formData.extraHeaders ? JSON.parse(formData.extraHeaders) : undefined,
        extraBody: formData.extraBody ? JSON.parse(formData.extraBody) : undefined,
        maxTokens: formData.maxTokens ? parseInt(formData.maxTokens) : undefined,
        enabled: formData.enabled,
        type: formData.type,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
      setEditModel(null);
    },
    onError: () => alert('모델 수정에 실패했습니다.'),
  });

  const deleteMut = useMutation({
    mutationFn: ({ id, force }: { id: string; force?: boolean }) => api.admin.models.delete(id, force),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
    },
    onError: (error: any, variables) => {
      const data = error?.response?.data;
      if (data?.usageLogs !== undefined && !variables.force) {
        const msg = `이 모델에 사용 로그가 ${data.usageLogs}건 있습니다.\n그래도 삭제하시겠습니까?`;
        if (confirm(msg)) {
          deleteMut.mutate({ id: variables.id, force: true });
        }
      } else {
        alert('모델 삭제에 실패했습니다.');
      }
    },
  });

  const testMut = useMutation({
    mutationFn: (model: Model) => {
      const params = {
        endpointUrl: model.endpointUrl,
        modelName: model.upstreamModelName || model.name,
        apiKey: model.apiKey,
        extraHeaders: model.extraHeaders,
      };
      switch (model.type) {
        case 'EMBEDDING': return api.admin.models.testEmbedding(params);
        case 'RERANKING': return api.admin.models.testRerank(params);
        default: return api.admin.models.test(params);
      }
    },
    onSuccess: (data: any, model: Model) => {
      setTestingId(null);
      if (model.type === 'EMBEDDING') {
        alert(data.passed ? 'Embedding 테스트 통과!' : `Embedding 테스트 실패: ${data.embedding?.message}`);
      } else if (model.type === 'RERANKING') {
        alert(data.passed ? 'Rerank 테스트 통과!' : `Rerank 테스트 실패: ${data.rerank?.message}`);
      } else {
        const toolResults = [data.toolCallA, data.toolCallB, data.toolCallC, data.toolCallD];
        const toolPassCount = toolResults.filter((t: any) => t?.passed).length;
        if (data.allPassed) {
          if (toolPassCount === 4) {
            alert('모든 테스트 통과! (5/5)');
          } else {
            alert(`테스트 통과! (Chat + ToolCall ${toolPassCount}/4)\n일부 Tool Call 시나리오가 실패했지만 등록 가능합니다.`);
          }
        } else {
          const msgs: string[] = [];
          if (!data.chatCompletion?.passed) msgs.push(`Chat: ${data.chatCompletion?.message}`);
          if (!data.toolCallA?.passed) msgs.push(`ToolCall-A: ${data.toolCallA?.message}`);
          if (!data.toolCallB?.passed) msgs.push(`ToolCall-B: ${data.toolCallB?.message}`);
          if (!data.toolCallC?.passed) msgs.push(`ToolCall-C: ${data.toolCallC?.message}`);
          if (!data.toolCallD?.passed) msgs.push(`ToolCall-D: ${data.toolCallD?.message}`);
          alert(`테스트 실패:\n${msgs.join('\n')}`);
        }
      }
    },
    onError: () => {
      setTestingId(null);
      alert('엔드포인트 테스트 실패.');
    },
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.admin.models.update(id, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
    },
    onError: () => alert('모델 상태 변경에 실패했습니다.'),
  });

  const reorderMut = useMutation({
    mutationFn: (ids: string[]) => api.admin.models.reorder(ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'models'] });
    },
  });

  const createSubModelMut = useMutation({
    mutationFn: ({ modelId, data }: { modelId: string; data: SubModelFormData }) =>
      api.admin.models.createSubModel(modelId, {
        modelName: data.modelName || undefined,
        endpointUrl: data.endpointUrl,
        apiKey: data.apiKey || undefined,
        extraHeaders: data.extraHeaders ? JSON.parse(data.extraHeaders) : undefined,
        extraBody: data.extraBody ? JSON.parse(data.extraBody) : undefined,
        enabled: data.enabled,
        sortOrder: data.sortOrder ? parseInt(data.sortOrder) : undefined,
      }),
    onSuccess: (_, { modelId }) => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'models', 'subModels', modelId] });
      setAddSubModelFor(null);
    },
    onError: () => alert('서브모델 추가에 실패했습니다.'),
  });

  const models: Model[] = data?.models ?? [];

  const moveModel = useCallback(
    (index: number, direction: 'up' | 'down') => {
      const ids = models.map((m) => m.id);
      const newIndex = direction === 'up' ? index - 1 : index + 1;
      if (newIndex < 0 || newIndex >= ids.length) return;
      [ids[index], ids[newIndex]] = [ids[newIndex], ids[index]];
      reorderMut.mutate(ids);
    },
    [models, reorderMut.mutate]
  );

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-96 gap-4">
        <AlertTriangle className="w-12 h-12 text-red-400" />
        <p className="text-gray-600">모델 목록을 불러오는데 실패했습니다.</p>
        <button onClick={() => refetch()} className="px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 flex items-center gap-2">
          <RefreshCw className="w-4 h-4" /> 다시 시도
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">모델 관리</h1>
        <button
          onClick={() => setShowCreate(true)}
          className="px-4 py-2 bg-brand-500 text-white rounded-lg hover:bg-brand-600 transition-colors flex items-center gap-2 text-sm"
        >
          <Plus className="w-4 h-4" />
          모델 추가
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-14 bg-white rounded-xl shadow-card animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 bg-gray-50">
                  <th className="w-10 py-3 px-4" />
                  <th className="text-left py-3 px-4 font-medium text-gray-500">모델 이름</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-500">유형</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-500">엔드포인트</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-500">최대 토큰</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-500">상태</th>
                  <th className="text-left py-3 px-4 font-medium text-gray-500">건강</th>
                  <th className="text-right py-3 px-4 font-medium text-gray-500">작업</th>
                </tr>
              </thead>
              <tbody>
                {models.map((model, index) => (
                  <ModelRow
                    key={model.id}
                    model={model}
                    index={index}
                    totalCount={models.length}
                    expandedModel={expandedModel}
                    testingId={testingId}
                    onToggleExpand={(id) => setExpandedModel(expandedModel === id ? null : id)}
                    onEdit={(m) => setEditModel(m)}
                    onDelete={(id) => {
                      if (confirm('이 모델을 삭제하시겠습니까?')) deleteMut.mutate({ id });
                    }}
                    onTest={(m) => {
                      setTestingId(m.id);
                      testMut.mutate(m);
                    }}
                    onMove={moveModel}
                    onAddSubModel={(m) => setAddSubModelFor(m)}
                    onToggle={(id, enabled) => toggleMut.mutate({ id, enabled })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Create Dialog */}
      <ModelDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onSubmit={(formData) => createMut.mutate(formData)}
        initialData={emptyForm}
        title="모델 추가"
        loading={createMut.isPending}
        isNew={true}
      />

      {/* Edit Dialog */}
      {editModel && (
        <ModelDialog
          open={!!editModel}
          onClose={() => setEditModel(null)}
          onSubmit={(formData) => updateMut.mutate({ id: editModel.id, formData })}
          initialData={{
            name: editModel.name,
            displayName: editModel.displayName,
            alias: editModel.alias || '',
            upstreamModelName: editModel.upstreamModelName || '',
            endpointUrl: editModel.endpointUrl,
            apiKey: editModel.apiKey || '',
            extraHeaders: editModel.extraHeaders ? JSON.stringify(editModel.extraHeaders, null, 2) : '{}',
            extraBody: editModel.extraBody ? JSON.stringify(editModel.extraBody, null, 2) : '{}',
            maxTokens: editModel.maxTokens?.toString() || '',
            enabled: editModel.enabled,
            type: editModel.type || 'CHAT',
          }}
          title="모델 수정"
          loading={updateMut.isPending}
          isNew={false}
        />
      )}

      {/* SubModel Dialog */}
      {addSubModelFor && (
        <SubModelDialog
          open={!!addSubModelFor}
          onClose={() => setAddSubModelFor(null)}
          onSubmit={(data) => createSubModelMut.mutate({ modelId: addSubModelFor.id, data })}
          parentModel={addSubModelFor}
          loading={createSubModelMut.isPending}
        />
      )}
    </div>
  );
}

function ModelRow({
  model,
  index,
  totalCount,
  expandedModel,
  testingId,
  onToggleExpand,
  onEdit,
  onDelete,
  onTest,
  onMove,
  onAddSubModel,
  onToggle,
}: {
  model: Model;
  index: number;
  totalCount: number;
  expandedModel: string | null;
  testingId: string | null;
  onToggleExpand: (id: string) => void;
  onEdit: (m: Model) => void;
  onDelete: (id: string) => void;
  onTest: (m: Model) => void;
  onMove: (index: number, direction: 'up' | 'down') => void;
  onAddSubModel: (m: Model) => void;
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const isExpanded = expandedModel === model.id;

  const { data: subModelsData } = useQuery({
    queryKey: ['admin', 'models', 'subModels', model.id],
    queryFn: () => api.admin.models.getSubModels(model.id),
    enabled: isExpanded,
  });

  const subModels: SubModel[] = subModelsData?.subModels ?? [];

  return (
    <>
      <tr className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
        <td className="py-3 px-4">
          <div className="flex flex-col items-center gap-1">
            <button
              onClick={() => onMove(index, 'up')}
              disabled={index === 0}
              className="p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-30"
            >
              <ArrowUp className="w-3 h-3" />
            </button>
            <GripVertical className="w-4 h-4 text-gray-300" />
            <button
              onClick={() => onMove(index, 'down')}
              disabled={index === totalCount - 1}
              className="p-0.5 text-gray-400 hover:text-gray-600 disabled:opacity-30"
            >
              <ArrowDown className="w-3 h-3" />
            </button>
          </div>
        </td>
        <td className="py-3 px-4">
          <button
            onClick={() => onToggleExpand(model.id)}
            className="flex items-center gap-2 hover:text-brand-600 transition-colors"
          >
            {isExpanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            <div>
              <p className="font-medium text-gray-900">{model.displayName}</p>
              <p className="text-xs text-gray-500 font-mono">{model.name}</p>
            </div>
          </button>
        </td>
        <td className="py-3 px-4">
          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${
            model.type === 'EMBEDDING' ? 'bg-emerald-100 text-emerald-700' :
            model.type === 'RERANKING' ? 'bg-orange-100 text-orange-700' :
            'bg-blue-100 text-blue-700'
          }`}>
            {model.type === 'EMBEDDING' ? 'Embedding' :
             model.type === 'RERANKING' ? 'Reranking' : 'Chat'}
          </span>
        </td>
        <td className="py-3 px-4 text-xs font-mono text-gray-500 max-w-[200px] truncate">{model.endpointUrl}</td>
        <td className="py-3 px-4 text-gray-600">{model.type === 'CHAT' || !model.type ? (model.maxTokens ?? '-') : '-'}</td>
        <td className="py-3 px-4">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onToggle(model.id, !model.enabled);
            }}
            className="flex items-center gap-1 hover:bg-gray-100 rounded px-1 py-0.5 transition-colors"
            title={model.enabled ? '비활성화' : '활성화'}
          >
            {model.enabled ? (
              <ToggleRight className="w-5 h-5 text-green-500" />
            ) : (
              <ToggleLeft className="w-5 h-5 text-gray-400" />
            )}
            <span className={`text-xs font-medium ${model.enabled ? 'text-green-600' : 'text-gray-400'}`}>
              {model.enabled ? '활성' : '비활성'}
            </span>
          </button>
        </td>
        <td className="py-3 px-4">
          {model.isHealthy === undefined ? (
            <span className="text-gray-400 text-xs">-</span>
          ) : model.isHealthy ? (
            <CheckCircle className="w-4 h-4 text-green-500" />
          ) : (
            <XCircle className="w-4 h-4 text-red-500" />
          )}
        </td>
        <td className="py-3 px-4">
          <div className="flex items-center justify-end gap-1">
            <button
              onClick={() => onTest(model)}
              disabled={testingId === model.id}
              className="p-1.5 text-blue-500 hover:bg-blue-50 rounded transition-colors disabled:opacity-50"
              title="엔드포인트 테스트"
            >
              {testingId === model.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            </button>
            <button
              onClick={() => onEdit(model)}
              className="p-1.5 text-gray-500 hover:bg-gray-100 rounded transition-colors"
              title="수정"
            >
              <Edit2 className="w-4 h-4" />
            </button>
            <button
              onClick={() => onDelete(model.id)}
              className="p-1.5 text-red-400 hover:bg-red-50 rounded transition-colors"
              title="삭제"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        </td>
      </tr>
      {isExpanded && (
        <>
          {subModels.map((sub) => (
            <SubModelRow key={sub.id} modelId={model.id} sub={sub} />
          ))}
          <tr className="bg-gray-50/30 border-b">
            <td />
            <td colSpan={7} className="py-2 px-4">
              <button
                onClick={() => onAddSubModel(model)}
                className="text-xs text-brand-600 hover:text-brand-700 flex items-center gap-1"
              >
                <Server className="w-3 h-3" />
                서브모델 추가 (로드밸런싱)
              </button>
            </td>
          </tr>
        </>
      )}
    </>
  );
}
