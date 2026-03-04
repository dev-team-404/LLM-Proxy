/**
 * Image Cleanup Scheduler
 *
 * 1시간 간격으로 만료된 이미지 파일 + DB 레코드를 삭제한다.
 * Worker 1에서만 실행 (llm-test.service.ts 패턴 동일).
 */

import { cleanupExpiredImages } from './imageStorage.service.js';

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let initialTimeout: ReturnType<typeof setTimeout> | null = null;

async function cleanupTick(): Promise<void> {
  try {
    const result = await cleanupExpiredImages();
    if (result.deletedCount > 0) {
      console.log(
        `[ImageCleanup] Deleted ${result.deletedCount} expired images (freed ${(result.freedBytes / 1024 / 1024).toFixed(1)} MB)`,
      );
    }
  } catch (error) {
    console.error('[ImageCleanup] Error during cleanup:', error);
  }
}

export function startImageCleanupScheduler(): void {
  if (cleanupTimer) return;
  console.log('[ImageCleanup] Scheduler started (interval: 1h)');
  // First run after 30 seconds
  initialTimeout = setTimeout(cleanupTick, 30_000);
  cleanupTimer = setInterval(cleanupTick, CLEANUP_INTERVAL_MS);
}

export function stopImageCleanupScheduler(): void {
  if (initialTimeout) {
    clearTimeout(initialTimeout);
    initialTimeout = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
    console.log('[ImageCleanup] Scheduler stopped');
  }
}
