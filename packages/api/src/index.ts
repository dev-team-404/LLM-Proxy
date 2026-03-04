/**
 * LLM Gateway API Server
 *
 * Cluster-mode dual-port Express server:
 * - Master: forks workers, monitors and auto-restarts on crash
 * - Workers: each runs Express on shared ports
 *   - Port 3000: LLM Proxy (API Token auth)
 *   - Port 3001: Dashboard API (SSO/JWT auth)
 */

import cluster from 'node:cluster';
import os from 'node:os';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { PrismaClient } from '@prisma/client';
import { createRedisClient } from './services/redis.service.js';
import { requestLogger } from './middleware/requestLogger.js';
import { proxyRoutes } from './routes/proxy.routes.js';
import { authRoutes } from './routes/auth.routes.js';
import { tokenRoutes } from './routes/token.routes.js';
import { myUsageRoutes } from './routes/my-usage.routes.js';
import { modelsRoutes } from './routes/models.routes.js';
import { adminRoutes } from './routes/admin.routes.js';
import { holidaysRoutes } from './routes/holidays.routes.js';
import { llmTestRoutes } from './routes/llm-test.routes.js';
import { startLLMTestScheduler, stopLLMTestScheduler } from './services/llm-test.service.js';
import { startImageCleanupScheduler, stopImageCleanupScheduler } from './services/imageCleanup.service.js';
import { ensureStorageDir } from './services/imageStorage.service.js';

import 'dotenv/config';

const PROXY_PORT = process.env['PROXY_PORT'] || 3000;
const DASHBOARD_PORT = process.env['DASHBOARD_PORT'] || 3001;
const NUM_WORKERS = Math.max(2, Math.min(os.cpus().length, 8)); // 2~8 workers

// ============================================
// Shared instances (created per-worker, exported for routes)
// ============================================
export const prisma = new PrismaClient();
export const redis = createRedisClient();

// ============================================
// Cluster Master
// ============================================
if (cluster.isPrimary) {
  console.log(`[Master] PID ${process.pid} starting ${NUM_WORKERS} workers...`);

  for (let i = 0; i < NUM_WORKERS; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(`[Master] Worker ${worker.process.pid} died (code=${code}, signal=${signal}). Restarting in 1s...`);
    setTimeout(() => cluster.fork(), 1000);
  });

  const shutdownMaster = () => {
    console.log('[Master] Shutting down all workers...');
    for (const id in cluster.workers) {
      cluster.workers[id]?.process.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 5000);
  };
  process.on('SIGTERM', shutdownMaster);
  process.on('SIGINT', shutdownMaster);

} else {
  // ============================================
  // Cluster Worker
  // ============================================

  // Crash protection
  process.on('uncaughtException', (err) => {
    console.error(`[Worker ${process.pid}] Uncaught exception:`, err);
    // Gracefully exit so master restarts a fresh worker
    setTimeout(() => process.exit(1), 3000);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(`[Worker ${process.pid}] Unhandled rejection:`, reason);
    // Log but don't crash - most rejections are non-fatal
  });

  // ============================================
  // Proxy App (Port 3000) - API Token auth
  // ============================================
  const proxyApp = express();
  proxyApp.set('trust proxy', 1);
  proxyApp.use(helmet());
  proxyApp.use(cors());
  proxyApp.use(express.json({ limit: '50mb' }));
  proxyApp.use(requestLogger);
  proxyApp.use(morgan('combined'));

  proxyApp.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      await redis.ping();
      res.json({ status: 'healthy', timestamp: new Date().toISOString(), worker: process.pid });
    } catch {
      res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString() });
    }
  });

  proxyApp.use('/v1', proxyRoutes);

  proxyApp.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Proxy error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        error: { type: 'server_error', message: 'Internal server error' },
      });
    }
  });

  proxyApp.use((_req, res) => {
    res.status(404).json({ error: 'Not found. Use /v1/ endpoints.' });
  });

  // ============================================
  // Dashboard App (Port 3001) - SSO/JWT auth
  // ============================================
  const dashboardApp = express();
  dashboardApp.set('trust proxy', 1);
  dashboardApp.use(helmet());
  dashboardApp.use(cors({
    origin: process.env['CORS_ORIGIN'] || true,
    credentials: true,
  }));
  dashboardApp.use(express.json({ limit: '10mb' }));
  dashboardApp.use(requestLogger);
  dashboardApp.use(morgan('combined'));

  dashboardApp.get('/health', async (_req, res) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      await redis.ping();
      res.json({ status: 'healthy', timestamp: new Date().toISOString(), worker: process.pid });
    } catch {
      res.status(503).json({ status: 'unhealthy', timestamp: new Date().toISOString() });
    }
  });

  dashboardApp.use('/auth', authRoutes);
  dashboardApp.use('/tokens', tokenRoutes);
  dashboardApp.use('/my-usage', myUsageRoutes);
  dashboardApp.use('/models', modelsRoutes);
  dashboardApp.use('/admin', adminRoutes);
  dashboardApp.use('/holidays', holidaysRoutes);
  dashboardApp.use('/llm-test', llmTestRoutes);

  dashboardApp.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('Error:', err);
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Internal server error',
        message: process.env['NODE_ENV'] === 'development' ? err.message : undefined,
      });
    }
  });

  dashboardApp.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
  });

  // ============================================
  // Worker Startup
  // ============================================
  async function ensureDefaultRateLimits() {
    const existing = await prisma.rateLimitConfig.findUnique({ where: { key: 'default' } });
    if (!existing) {
      await prisma.rateLimitConfig.create({
        data: {
          key: 'default',
          rpmLimit: parseInt(process.env['DEFAULT_RPM'] || '0'),
          tpmLimit: parseInt(process.env['DEFAULT_TPM'] || '0'),
          tphLimit: parseInt(process.env['DEFAULT_TPH'] || '0'),
          tpdLimit: parseInt(process.env['DEFAULT_TPD'] || '0'),
        },
      });
      console.log(`[Worker ${process.pid}] Default rate limits created (0 = unlimited)`);
    }
  }

  async function shutdown() {
    console.log(`[Worker ${process.pid}] Shutting down...`);
    stopLLMTestScheduler();
    stopImageCleanupScheduler();
    await prisma.$disconnect();
    await redis.quit();
    process.exit(0);
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  try {
    await prisma.$connect();
    console.log(`[Worker ${process.pid}] Database connected`);

    await redis.ping();
    console.log(`[Worker ${process.pid}] Redis connected`);

    // Ensure image storage directory exists (all workers need it)
    ensureStorageDir();

    // Only first worker initializes defaults and schedulers
    if (cluster.worker?.id === 1) {
      await ensureDefaultRateLimits();
      startLLMTestScheduler();
      startImageCleanupScheduler();
    }

    const proxyServer = proxyApp.listen(PROXY_PORT, () => {
      console.log(`[Worker ${process.pid}] LLM Proxy API on port ${PROXY_PORT}`);
    });
    proxyServer.keepAliveTimeout = 65000;
    proxyServer.headersTimeout = 66000;

    const dashboardServer = dashboardApp.listen(DASHBOARD_PORT, () => {
      console.log(`[Worker ${process.pid}] Dashboard API on port ${DASHBOARD_PORT}`);
    });
    dashboardServer.keepAliveTimeout = 65000;
    dashboardServer.headersTimeout = 66000;
  } catch (error) {
    console.error(`[Worker ${process.pid}] Failed to start:`, error);
    process.exit(1);
  }
}
