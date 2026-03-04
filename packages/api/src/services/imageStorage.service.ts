/**
 * Image Storage Service
 *
 * 이미지 생성 결과를 로컬 파일시스템에 저장하고,
 * 만료된 이미지를 자동 삭제하는 서비스.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../index.js';

// ============================================
// Configuration
// ============================================
export const IMAGE_STORAGE_PATH = process.env['IMAGE_STORAGE_PATH'] || '/app/generated-images';
export const IMAGE_EXPIRY_HOURS = parseInt(process.env['IMAGE_EXPIRY_HOURS'] || '168', 10); // 7 days
export const IMAGE_BASE_URL = process.env['IMAGE_BASE_URL'] || '';

// ============================================
// Storage Directory
// ============================================
export function ensureStorageDir(): void {
  if (!fs.existsSync(IMAGE_STORAGE_PATH)) {
    fs.mkdirSync(IMAGE_STORAGE_PATH, { recursive: true });
    console.log(`[ImageStorage] Created directory: ${IMAGE_STORAGE_PATH}`);
  }
}

// ============================================
// URL Builder
// ============================================
export function buildImageUrl(fileName: string, reqHost?: string, reqProtocol?: string): string {
  if (IMAGE_BASE_URL) {
    const base = IMAGE_BASE_URL.replace(/\/$/, '');
    return `${base}/v1/images/files/${fileName}`;
  }
  // Fallback: use request Host header
  const protocol = reqProtocol || 'http';
  const host = reqHost || 'localhost:3000';
  return `${protocol}://${host}/v1/images/files/${fileName}`;
}

// ============================================
// Save Image
// ============================================
interface SaveImageOptions {
  mimeType?: string;
  modelId?: string;
  userId?: string;
  apiTokenId?: string;
  prompt?: string;
}

interface SaveImageResult {
  fileName: string;
  filePath: string;
  sizeBytes: number;
}

export async function saveImage(
  buffer: Buffer,
  options: SaveImageOptions = {},
): Promise<SaveImageResult> {
  const ext = mimeToExt(options.mimeType || 'image/png');
  const fileName = `${randomUUID()}${ext}`;
  const filePath = path.join(IMAGE_STORAGE_PATH, fileName);

  // Write file
  fs.writeFileSync(filePath, buffer);

  const sizeBytes = buffer.length;
  const expiresAt = new Date(Date.now() + IMAGE_EXPIRY_HOURS * 60 * 60 * 1000);

  // Create DB record — if this fails, delete the orphaned file
  try {
    await prisma.generatedImage.create({
      data: {
        fileName,
        mimeType: options.mimeType || 'image/png',
        sizeBytes,
        modelId: options.modelId || null,
        userId: options.userId || null,
        apiTokenId: options.apiTokenId || null,
        prompt: options.prompt || null,
        expiresAt,
      },
    });
  } catch (dbError) {
    // Rollback: remove file if DB insert failed
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    throw dbError;
  }

  return { fileName, filePath, sizeBytes };
}

// ============================================
// Cleanup Expired Images
// ============================================
export async function cleanupExpiredImages(): Promise<{ deletedCount: number; freedBytes: number }> {
  const now = new Date();

  // Find expired records
  const expired = await prisma.generatedImage.findMany({
    where: { expiresAt: { lt: now } },
    select: { id: true, fileName: true, sizeBytes: true },
  });

  if (expired.length === 0) {
    return { deletedCount: 0, freedBytes: 0 };
  }

  // Delete DB records first (safer: even if file delete fails, no dangling DB refs)
  const ids = expired.map((r) => r.id);
  await prisma.generatedImage.deleteMany({
    where: { id: { in: ids } },
  });

  // Then delete files from disk
  let freedBytes = 0;
  for (const record of expired) {
    const filePath = path.join(IMAGE_STORAGE_PATH, record.fileName);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        freedBytes += record.sizeBytes;
      }
    } catch (err) {
      console.error(`[ImageStorage] Failed to delete file ${filePath}:`, err);
    }
  }

  return { deletedCount: expired.length, freedBytes };
}

// ============================================
// Helpers
// ============================================
function mimeToExt(mime: string): string {
  switch (mime) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/webp':
      return '.webp';
    case 'image/gif':
      return '.gif';
    default:
      return '.png';
  }
}
