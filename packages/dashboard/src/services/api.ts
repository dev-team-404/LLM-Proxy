import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// Auth interceptor: attach Bearer token from localStorage
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('llm_proxy_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor: redirect to login on 401 (expired/invalid token)
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      localStorage.removeItem('llm_proxy_token');
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

// ==================== Auth ====================
export const auth = {
  login: (token: string) =>
    api.post('/auth/login', {}, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((r) => r.data),

  getMe: () => api.get('/auth/me').then((r) => r.data),

  check: () => api.get('/auth/check').then((r) => r.data),

  refresh: () => api.post('/auth/refresh').then((r) => r.data),
};

// ==================== Tokens (My) ====================
export const tokens = {
  list: () => api.get('/tokens').then((r) => r.data),

  create: (name: string, expiresAt?: string) =>
    api.post('/tokens', { name, expiresAt }).then((r) => r.data),

  update: (id: string, data: { name?: string; enabled?: boolean }) =>
    api.patch(`/tokens/${id}`, data).then((r) => r.data),

  delete: (id: string) => api.delete(`/tokens/${id}`).then((r) => r.data),
};

// ==================== My Usage ====================
export const myUsage = {
  summary: () => api.get('/my-usage/summary').then((r) => r.data),

  daily: (days = 30) =>
    api.get('/my-usage/daily', { params: { days } }).then((r) => r.data),

  byModel: (days = 30) =>
    api.get('/my-usage/by-model', { params: { days } }).then((r) => r.data),

  byToken: (days = 30) =>
    api.get('/my-usage/by-token', { params: { days } }).then((r) => r.data),

  recent: (limit = 50, offset = 0) =>
    api.get('/my-usage/recent', { params: { limit, offset } }).then((r) => r.data),

  budget: () => api.get('/my-usage/budget').then((r) => r.data),
};

// ==================== Models ====================
export const models = {
  list: () => api.get('/models').then((r) => r.data),
};

// ==================== Admin ====================
export const admin = {
  // ---- Models ----
  models: {
    list: () => api.get('/admin/models').then((r) => r.data),

    create: (data: Record<string, unknown>) =>
      api.post('/admin/models', data).then((r) => r.data),

    update: (id: string, data: Record<string, unknown>) =>
      api.put(`/admin/models/${id}`, data).then((r) => r.data),

    delete: (id: string, force?: boolean) =>
      api.delete(`/admin/models/${id}${force ? '?force=true' : ''}`).then((r) => r.data),

    reorder: (modelIds: string[]) =>
      api.put('/admin/models/reorder', { modelIds }).then((r) => r.data),

    test: (data: { endpointUrl: string; apiKey?: string; extraHeaders?: Record<string, string>; modelName?: string }) =>
      api.post('/admin/models/test', data).then((r) => r.data),

    getSubModels: (modelId: string) =>
      api.get(`/admin/models/${modelId}/sub-models`).then((r) => r.data),

    createSubModel: (modelId: string, data: Record<string, unknown>) =>
      api.post(`/admin/models/${modelId}/sub-models`, data).then((r) => r.data),

    updateSubModel: (modelId: string, subId: string, data: Record<string, unknown>) =>
      api.put(`/admin/models/${modelId}/sub-models/${subId}`, data).then((r) => r.data),

    deleteSubModel: (modelId: string, subId: string) =>
      api.delete(`/admin/models/${modelId}/sub-models/${subId}`).then((r) => r.data),
  },

  // ---- Users ----
  users: {
    list: (params?: { page?: number; limit?: number; search?: string }) =>
      api.get('/admin/users', { params }).then((r) => r.data),

    get: (id: string) => api.get(`/admin/users/${id}`).then((r) => r.data),

    ban: (id: string, reason?: string) =>
      api.post(`/admin/users/${id}/ban`, { reason }).then((r) => r.data),

    unban: (id: string) =>
      api.post(`/admin/users/${id}/unban`).then((r) => r.data),

    setBudget: (id: string, budget: number | null) =>
      api.put(`/admin/users/${id}/budget`, { budget }).then((r) => r.data),

    setAdminRole: (id: string, role: string | null) =>
      api.post(`/admin/users/${id}/set-admin-role`, { role }).then((r) => r.data),
  },

  // ---- Tokens ----
  tokens: {
    list: (params?: Record<string, unknown>) =>
      api.get('/admin/tokens', { params }).then((r) => r.data),

    get: (id: string) => api.get(`/admin/tokens/${id}`).then((r) => r.data),

    update: (id: string, data: Record<string, unknown>) =>
      api.patch(`/admin/tokens/${id}`, data).then((r) => r.data),

    delete: (id: string) =>
      api.delete(`/admin/tokens/${id}`).then((r) => r.data),

    setRateLimits: (id: string, data: { rpmLimit?: number | null; tpmLimit?: number | null; tphLimit?: number | null; tpdLimit?: number | null }) =>
      api.put(`/admin/tokens/${id}/rate-limits`, data).then((r) => r.data),

    setBudget: (id: string, budget: number | null) =>
      api.put(`/admin/tokens/${id}/budget`, { budget }).then((r) => r.data),

    setModels: (id: string, modelIds: string[]) =>
      api.put(`/admin/tokens/${id}/models`, { modelIds }).then((r) => r.data),
  },

  // ---- Stats ----
  stats: {
    overview: () => api.get('/admin/stats/overview').then((r) => r.data),

    daily: (params?: Record<string, unknown>) =>
      api.get('/admin/stats/daily', { params }).then((r) => r.data),

    byUser: (params?: Record<string, unknown>) =>
      api.get('/admin/stats/by-user', { params }).then((r) => r.data),

    byModel: (params?: Record<string, unknown>) =>
      api.get('/admin/stats/by-model', { params }).then((r) => r.data),

    byDept: (params?: Record<string, unknown>) =>
      api.get('/admin/stats/by-dept', { params }).then((r) => r.data),

    byToken: (params?: Record<string, unknown>) =>
      api.get('/admin/stats/by-token', { params }).then((r) => r.data),

    dau: (params?: Record<string, unknown>) =>
      api.get('/admin/stats/daily-active-users', { params }).then((r) => r.data),

    cumulativeUsers: (params?: Record<string, unknown>) =>
      api.get('/admin/stats/cumulative-users', { params }).then((r) => r.data),

    modelDailyTrend: (params?: Record<string, unknown>) =>
      api.get('/admin/stats/model-daily-trend', { params }).then((r) => r.data),

    deptDailyTrend: (params?: Record<string, unknown>) =>
      api.get('/admin/stats/dept-daily-trend', { params }).then((r) => r.data),

    latency: () => api.get('/admin/stats/latency').then((r) => r.data),

    latencyHistory: (params?: Record<string, unknown>) =>
      api.get('/admin/stats/latency/history', { params }).then((r) => r.data),
  },

  // ---- Logs ----
  logs: {
    list: (params?: Record<string, unknown>) =>
      api.get('/admin/logs', { params }).then((r) => r.data),

    get: (id: string) => api.get(`/admin/logs/${id}`).then((r) => r.data),

    cleanup: (retentionDays: number) =>
      api.delete('/admin/logs/cleanup', { params: { retentionDays } }).then((r) => r.data),
  },

  // ---- System ----
  system: {
    health: () => api.get('/admin/system/health').then((r) => r.data),

    endpoints: () => api.get('/admin/system/endpoints').then((r) => r.data),

    checkEndpoint: (modelId: string) =>
      api.post(`/admin/system/endpoints/${modelId}/check`).then((r) => r.data),

    checkAllEndpoints: () =>
      api.post('/admin/system/endpoints/check-all').then((r) => r.data),

    errorRates: () => api.get('/admin/system/error-rates').then((r) => r.data),
  },

  // ---- Rate Limits ----
  rateLimits: {
    get: () => api.get('/admin/rate-limits').then((r) => r.data),

    update: (data: { rpmLimit?: number; tpmLimit?: number; tphLimit?: number; tpdLimit?: number }) =>
      api.put('/admin/rate-limits', data).then((r) => r.data),
  },

  // ---- Admins ----
  admins: {
    list: () => api.get('/admin/admins').then((r) => r.data),

    create: (data: { loginid: string; role?: string }) =>
      api.post('/admin/admins', data).then((r) => r.data),

    update: (id: string, data: { role: string }) =>
      api.put(`/admin/admins/${id}`, data).then((r) => r.data),

    delete: (id: string) =>
      api.delete(`/admin/admins/${id}`).then((r) => r.data),
  },

  // ---- Audit ----
  audit: {
    list: (params?: { loginid?: string; action?: string; targetType?: string; startDate?: string; endDate?: string; page?: number; limit?: number }) =>
      api.get('/admin/audit', { params }).then((r) => r.data),
  },

  // ---- Department Budgets ----
  deptBudgets: {
    list: () => api.get('/admin/dept-budgets').then((r) => r.data),

    departments: () => api.get('/admin/dept-budgets/departments').then((r) => r.data),

    create: (data: { deptname: string; monthlyOutputTokenBudget: number; rpmLimit?: number | null; tpmLimit?: number | null; tphLimit?: number | null; tpdLimit?: number | null }) =>
      api.post('/admin/dept-budgets', data).then((r) => r.data),

    update: (id: string, data: { monthlyOutputTokenBudget?: number; rpmLimit?: number | null; tpmLimit?: number | null; tphLimit?: number | null; tpdLimit?: number | null; enabled?: boolean }) =>
      api.put(`/admin/dept-budgets/${id}`, data).then((r) => r.data),

    delete: (id: string) =>
      api.delete(`/admin/dept-budgets/${id}`).then((r) => r.data),
  },
};

// ==================== Holidays ====================
export const holidays = {
  list: (params?: { year?: number; month?: number }) =>
    api.get('/holidays', { params }).then((r) => r.data),

  dates: (days = 365) =>
    api.get('/holidays/dates', { params: { days } }).then((r) => r.data),

  create: (data: { date: string; name: string; type?: string }) =>
    api.post('/holidays', data).then((r) => r.data),

  bulkCreate: (data: { holidays: Array<{ date: string; name: string; type?: string }> }) =>
    api.post('/holidays/bulk', data).then((r) => r.data),

  update: (id: string, data: { name?: string; type?: string }) =>
    api.put(`/holidays/${id}`, data).then((r) => r.data),

  delete: (id: string) =>
    api.delete(`/holidays/${id}`).then((r) => r.data),
};

// ==================== LLM Test ====================
export const llmTest = {
  listPairs: () => api.get('/llm-test/pairs').then((r) => r.data),

  getPair: (id: string) =>
    api.get(`/llm-test/pairs/${id}`).then((r) => r.data),

  createPair: (data: Record<string, unknown>) =>
    api.post('/llm-test/pairs', data).then((r) => r.data),

  updatePair: (id: string, data: Record<string, unknown>) =>
    api.put(`/llm-test/pairs/${id}`, data).then((r) => r.data),

  deletePair: (id: string) =>
    api.delete(`/llm-test/pairs/${id}`).then((r) => r.data),

  runTest: (id: string) =>
    api.post(`/llm-test/pairs/${id}/run`).then((r) => r.data),

  getResults: (id: string, params?: { limit?: number; offset?: number; days?: number }) =>
    api.get(`/llm-test/pairs/${id}/results`, { params }).then((r) => r.data),

  chartData: (params?: { pairIds?: string; days?: number }) =>
    api.get('/llm-test/results/chart', { params }).then((r) => r.data),

  stats: () => api.get('/llm-test/stats').then((r) => r.data),
};

// Convenience namespace re-export for legacy admin pages
// Allows: import { api } from './services/api' then api.admin.stats.overview()
const apiNamespace = {
  auth,
  tokens,
  myUsage,
  models,
  admin,
  holidays,
  llmTest,
};

export { apiNamespace as api };

export default api;
