import { useState, useCallback, useRef } from 'react';
import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
  UploadTask,
} from 'firebase/storage';
import { app, auth, storage } from '../lib/firebase';

export const MAX_RAW_IMAGE_BYTES = 30 * 1024 * 1024; // 30 MB before compression
export const MAX_COMPRESSED_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB max uploaded (compressed) file
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB max for non-image PDF attachments
export const TARGET_COMPRESSED_BYTES = 490 * 1024; // Target under 500 KB
export const RETRY_COMPRESSION_THRESHOLD_BYTES = 800 * 1024; // Retry lower quality if over 800 KB
export const MAX_LONGEST_SIDE_PX = 1280;
export const UPLOAD_STALL_TIMEOUT_MS = 20 * 1000; // 20 seconds without progress change
export const UPLOAD_OVERALL_TIMEOUT_MS = 90 * 1000; // 90 seconds overall upload limit

export const STORAGE_NOT_CONFIGURED_MESSAGE =
  'স্টোরেজ কনফিগার করা নেই। (Storage is not configured)';
export const UPLOAD_TIMEOUT_MESSAGE =
  'আপলোড করতে অনেক সময় লাগছে। ইন্টারনেট চেক করে আবার চেষ্টা করুন। (Upload is taking too long. Check your internet and try again.)';

export function getConfiguredStorageBucket(): string {
  const fromApp = typeof app?.options?.storageBucket === 'string' ? app.options.storageBucket.trim() : '';
  const fromStorage =
    typeof storage?.app?.options?.storageBucket === 'string'
      ? storage.app.options.storageBucket.trim()
      : '';
  return fromApp || fromStorage;
}

export const IS_STORAGE_CONFIGURED = Boolean(getConfiguredStorageBucket());

if (!IS_STORAGE_CONFIGURED) {
  console.error(
    '[useImageUpload] Firebase config error: storageBucket is empty. Storage is not configured.'
  );
}

const IMAGE_EXT_REGEX = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;
export const UNSUPPORTED_IMAGE_FORMAT_ERROR =
  'এই ছবির ফরম্যাটটি সাপোর্ট করে না। অনুগ্রহ করে JPG বা PNG ছবি দিন, অথবা ক্যামেরা সেটিংস JPG করুন। (This photo format is not supported. Please choose a JPG or PNG photo, or set the camera to JPG.)';

export interface UploadResult {
  downloadUrl: string;
  storagePath: string;
}

export interface CompressOptions {
  maxLongestSide?: number;
  initialQuality?: number;
  targetMaxBytes?: number;
}

let webpSupportCache: boolean | null = null;
function supportsWebpEncoding(): boolean {
  if (webpSupportCache !== null) return webpSupportCache;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    webpSupportCache = canvas.toDataURL('image/webp').startsWith('data:image/webp');
  } catch {
    webpSupportCache = false;
  }
  return webpSupportCache;
}

export function isImageFile(file: File): boolean {
  if (!file) return false;
  const type = (file.type || '').toLowerCase();
  if (type.startsWith('image/')) return true;
  if ((!type || type === 'application/octet-stream') && IMAGE_EXT_REGEX.test(file.name || '')) {
    return true;
  }
  return false;
}

function formatSizeMb(bytes: number, maxMb: number): string {
  const rawMb = bytes / (1024 * 1024);
  const roundedWhole = Math.round(rawMb);
  if (roundedWhole <= maxMb) {
    return (Math.ceil(rawMb * 10) / 10).toFixed(1);
  }
  if (rawMb >= 10 && Math.abs(rawMb - roundedWhole) < 0.25) {
    return String(roundedWhole);
  }
  return (Math.round(rawMb * 10) / 10).toFixed(1).replace(/\.0$/, '');
}

export function validateImageFile(file: File, maxBytes = MAX_RAW_IMAGE_BYTES): void {
  if (!file || !isImageFile(file)) {
    throw new Error(
      'ভুল ফাইল ফরম্যাট! শুধুমাত্র ছবি (JPG, PNG, WEBP) আপলোড করুন। (Wrong file type. Please choose an image file.)'
    );
  }
  if (file.size > maxBytes) {
    const maxMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
    const sizeText = formatSizeMb(file.size, maxMb);
    throw new Error(
      `ছবিটি ${sizeText} MB। সর্বোচ্চ ${maxMb} MB হতে পারবে। (Photo is ${sizeText} MB. Maximum is ${maxMb} MB.)`
    );
  }
}

export function mapStorageError(err: any): string {
  const code = String(err?.code || '').trim();
  const msg = String(err?.message || '');
  const lowerMsg = msg.toLowerCase();

  // Log ONLY the storage error code for debugging (no tokens, URLs, or secrets)
  if (code) {
    console.error('[useImageUpload] Firebase Storage error code:', code);
  } else if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    console.error('[useImageUpload] Firebase Storage error code: storage/network-offline');
  } else if (msg) {
    console.error('[useImageUpload] Firebase Storage error code: storage/client-error');
  }

  if (err?.isTimeout || code === 'storage/stalled-20s' || code === 'storage/timeout-90s') {
    return UPLOAD_TIMEOUT_MESSAGE;
  }

  if (!getConfiguredStorageBucket()) {
    return STORAGE_NOT_CONFIGURED_MESSAGE;
  }

  if (code === 'storage/unauthorized' || code === 'storage/unauthenticated') {
    return 'আপলোডের অনুমতি নেই। অনুগ্রহ করে অ্যাকাউন্ট বা পারমিশন যাচাই করুন। (Upload not allowed (permission))';
  }

  if (
    code === 'storage/unknown' ||
    code === 'storage/bucket-not-found' ||
    code === 'storage/project-not-found' ||
    code === 'storage/no-default-bucket'
  ) {
    return 'স্টোরেজ সঠিকভাবে সেটআপ করা নেই। (Storage is not set up correctly)';
  }

  if (code === 'storage/canceled') {
    return 'আপলোড বাতিল করা হয়েছে। (Upload was canceled)';
  }

  if (
    (typeof navigator !== 'undefined' && navigator.onLine === false) ||
    code === 'storage/retry-limit-exceeded' ||
    code === 'storage/server-file-wrong-size' ||
    lowerMsg.includes('network') ||
    lowerMsg.includes('offline') ||
    lowerMsg.includes('fetch') ||
    lowerMsg.includes('internet')
  ) {
    return 'ইন্টারনেট সংযোগ নেই। সংযোগ চালু করে আবার চেষ্টা করুন। (No internet)';
  }

  if (code === 'storage/quota-exceeded') {
    return 'স্টোরেজ সীমা পূর্ণ হয়েছে। (Storage quota exceeded)';
  }

  if (lowerMsg.includes('permission') || lowerMsg.includes('unauthorized')) {
    return 'আপলোডের অনুমতি নেই। (Upload not allowed (permission))';
  }

  if (msg) return msg;
  return 'ছবি আপলোড করা যায়নি। আবার চেষ্টা করুন। (Failed to upload image. Please try again.)';
}

function generateUniqueFileName(ext: string): string {
  const randomPart =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().replace(/-/g, '').slice(0, 12)
      : `${Math.random().toString(36).slice(2, 10)}${Math.random().toString(36).slice(2, 6)}`;
  const cleanExt = ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  return `${Date.now()}_${randomPart}.${cleanExt}`;
}

interface DecodedImageSource {
  source: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
  cleanup: () => void;
}

function loadHtmlImageFromFile(file: File): Promise<DecodedImageSource> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({
        source: img,
        width: Math.max(1, img.naturalWidth || img.width),
        height: Math.max(1, img.naturalHeight || img.height),
        cleanup: () => {
          try {
            URL.revokeObjectURL(objectUrl);
          } catch {
            // ignore
          }
        },
      });
    };
    img.onerror = () => {
      try {
        URL.revokeObjectURL(objectUrl);
      } catch {
        // ignore
      }
      reject(new Error(UNSUPPORTED_IMAGE_FORMAT_ERROR));
    };
    img.src = objectUrl;
  });
}

async function decodeImageSource(file: File): Promise<DecodedImageSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: 'from-image',
      } as ImageBitmapOptions);
      return {
        source: bitmap,
        width: Math.max(1, bitmap.width),
        height: Math.max(1, bitmap.height),
        cleanup: () => {
          try {
            bitmap.close();
          } catch {
            // ignore
          }
        },
      };
    } catch {
      // Fallback to HTMLImageElement (handles older browsers lacking options dict or rejects cleanly for HEIC/HEIF)
    }
  }
  return loadHtmlImageFromFile(file);
}

function canvasToBlob(canvas: HTMLCanvasElement, mimeType: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error('Image encoding failed.'));
        }
      },
      mimeType,
      quality
    );
  });
}

export async function compressImageToBlob(
  file: File,
  options: CompressOptions = {}
): Promise<{ blob: Blob; ext: string }> {
  validateImageFile(file);

  const maxSide = options.maxLongestSide ?? MAX_LONGEST_SIDE_PX;
  const initialQuality = options.initialQuality ?? 0.8;
  const targetMaxBytes = options.targetMaxBytes ?? TARGET_COMPRESSED_BYTES;

  const decoded = await decodeImageSource(file);

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    decoded.cleanup();
    if (file.size <= MAX_COMPRESSED_IMAGE_BYTES) {
      return {
        blob: file,
        ext: file.name.split('.').pop() || 'jpg',
      };
    }
    throw new Error(UNSUPPORTED_IMAGE_FORMAT_ERROR);
  }

  try {
    const longest = Math.max(decoded.width, decoded.height);
    const scale = longest > maxSide ? maxSide / longest : 1;

    const useWebp = supportsWebpEncoding();
    const mimeType = useWebp ? 'image/webp' : 'image/jpeg';
    const ext = useWebp ? 'webp' : 'jpg';

    let width = Math.max(1, Math.round(decoded.width * scale));
    let height = Math.max(1, Math.round(decoded.height * scale));

    canvas.width = width;
    canvas.height = height;
    ctx.clearRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    if (mimeType === 'image/jpeg') {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(decoded.source, 0, 0, width, height);
    // Release full-resolution camera bitmap from memory immediately after drawing to resized canvas
    decoded.cleanup();

    // Start around 0.8 aiming for < 500 KB; retry 0.7 then 0.6 if still > target (or > 800 KB)
    const qualitySteps = [initialQuality, 0.7, 0.6, 0.5];
    let bestBlob = await canvasToBlob(canvas, mimeType, qualitySteps[0]);

    for (let i = 1; i < qualitySteps.length && bestBlob.size > targetMaxBytes; i++) {
      if (bestBlob.size > RETRY_COMPRESSION_THRESHOLD_BYTES || bestBlob.size > targetMaxBytes) {
        bestBlob = await canvasToBlob(canvas, mimeType, qualitySteps[i]);
      }
    }

    // If still above targetMaxBytes (e.g. ultra-detailed photo), progressively reduce dimensions
    let shrinkPass = 0;
    while (bestBlob.size > targetMaxBytes && shrinkPass < 3 && Math.max(width, height) > 360) {
      shrinkPass += 1;
      const nextW = Math.max(1, Math.round(width * 0.78));
      const nextH = Math.max(1, Math.round(height * 0.78));
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = nextW;
      tmpCanvas.height = nextH;
      const tmpCtx = tmpCanvas.getContext('2d');
      if (!tmpCtx) break;
      tmpCtx.imageSmoothingEnabled = true;
      tmpCtx.imageSmoothingQuality = 'high';
      if (mimeType === 'image/jpeg') {
        tmpCtx.fillStyle = '#FFFFFF';
        tmpCtx.fillRect(0, 0, nextW, nextH);
      }
      tmpCtx.drawImage(canvas, 0, 0, nextW, nextH);
      canvas.width = nextW;
      canvas.height = nextH;
      ctx.drawImage(tmpCanvas, 0, 0);
      tmpCanvas.width = 0;
      tmpCanvas.height = 0;
      width = nextW;
      height = nextH;
      bestBlob = await canvasToBlob(canvas, mimeType, 0.6);
    }

    if (bestBlob.size > MAX_COMPRESSED_IMAGE_BYTES) {
      const maxMb = Math.round(MAX_COMPRESSED_IMAGE_BYTES / (1024 * 1024));
      throw new Error(
        `কম্প্রেস করার পরও ছবির সাইজ ${maxMb} MB-এর বেশি। অনুগ্রহ করে অন্য ছবি দিন। (Compressed photo still exceeds the ${maxMb} MB upload limit.)`
      );
    }

    return { blob: bestBlob, ext };
  } finally {
    decoded.cleanup();
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function isManagedStorageUrl(url?: string | null): boolean {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('/')) return false;
  return (
    trimmed.includes('firebasestorage.googleapis.com') ||
    trimmed.includes('firebasestorage.app') ||
    trimmed.startsWith('gs://')
  );
}

export async function deleteStorageFileByUrl(urlOrPath?: string | null): Promise<void> {
  if (!urlOrPath || typeof urlOrPath !== 'string') return;
  const trimmed = urlOrPath.trim();
  if (!trimmed || trimmed.startsWith('data:') || trimmed.startsWith('blob:')) return;

  // Allow either direct Firebase Storage download URLs or raw storage relative paths (e.g. "products/123/file.webp")
  const isRawStoragePath = !trimmed.includes('://') && !trimmed.startsWith('/');
  if (!isManagedStorageUrl(trimmed) && !isRawStoragePath) return;

  try {
    const fileRef = ref(storage, trimmed);
    await deleteObject(fileRef);
  } catch (err: any) {
    const code = String(err?.code || '');
    if (code !== 'storage/object-not-found' && code !== 'storage/invalid-argument') {
      console.warn('[useImageUpload] Old storage file cleanup skipped, code:', code || 'storage/cleanup-failed');
    }
  }
}

function isPrivateStoragePath(cleanFolder: string): boolean {
  return (
    cleanFolder.includes('/nid') ||
    cleanFolder.startsWith('payments/') ||
    cleanFolder.startsWith('payouts/') ||
    cleanFolder.startsWith('withdrawals/') ||
    cleanFolder.startsWith('support/') ||
    cleanFolder.startsWith('feedback/')
  );
}

function runResumableUploadWithTimeouts(
  task: UploadTask,
  options: {
    onProgress?: (pct: number) => void;
    progressStart?: number;
    progressSpan?: number;
  } = {}
): Promise<UploadResult> {
  const startPct = options.progressStart ?? 5;
  const spanPct = options.progressSpan ?? 93;

  return new Promise<UploadResult>((resolve, reject) => {
    let settled = false;
    let abortedByTimeout = false;
    let lastBytesTransferred = -1;
    let lastReportedPct = -1;
    let stallTimerId: ReturnType<typeof setTimeout> | null = null;
    let overallTimerId: ReturnType<typeof setTimeout> | null = null;

    const cleanupTimers = () => {
      if (stallTimerId) {
        clearTimeout(stallTimerId);
        stallTimerId = null;
      }
      if (overallTimerId) {
        clearTimeout(overallTimerId);
        overallTimerId = null;
      }
    };

    const failWithTimeout = (reason: 'stall' | 'overall') => {
      if (settled) return;
      settled = true;
      abortedByTimeout = true;
      cleanupTimers();
      const timeoutCode = reason === 'overall' ? 'storage/timeout-90s' : 'storage/stalled-20s';
      console.error('[useImageUpload] Firebase Storage error code:', timeoutCode);
      try {
        task.cancel();
      } catch {
        // ignore cancel errors
      }
      const timeoutErr = new Error(UPLOAD_TIMEOUT_MESSAGE) as Error & {
        isTimeout?: boolean;
        code?: string;
      };
      timeoutErr.isTimeout = true;
      timeoutErr.code = timeoutCode;
      reject(timeoutErr);
    };

    const resetStallTimer = () => {
      if (stallTimerId) clearTimeout(stallTimerId);
      stallTimerId = setTimeout(() => failWithTimeout('stall'), UPLOAD_STALL_TIMEOUT_MS);
    };

    overallTimerId = setTimeout(() => failWithTimeout('overall'), UPLOAD_OVERALL_TIMEOUT_MS);
    resetStallTimer();

    task.on(
      'state_changed',
      (snapshot) => {
        if (settled) return;
        const pct =
          snapshot.totalBytes > 0
            ? Math.min(98, Math.round(startPct + (snapshot.bytesTransferred / snapshot.totalBytes) * spanPct))
            : startPct;

        if (snapshot.bytesTransferred > lastBytesTransferred || pct > lastReportedPct) {
          lastBytesTransferred = snapshot.bytesTransferred;
          lastReportedPct = pct;
          resetStallTimer();
        }
        options.onProgress?.(pct);
      },
      (err) => {
        if (settled || abortedByTimeout) return;
        settled = true;
        cleanupTimers();
        reject(new Error(mapStorageError(err)));
      },
      async () => {
        if (settled) return;
        if (stallTimerId) {
          clearTimeout(stallTimerId);
          stallTimerId = null;
        }
        try {
          const downloadUrl = await getDownloadURL(task.snapshot.ref);
          if (settled) return;
          settled = true;
          cleanupTimers();
          options.onProgress?.(100);
          resolve({ downloadUrl, storagePath: task.snapshot.ref.fullPath });
        } catch (urlErr: any) {
          if (settled) return;
          settled = true;
          cleanupTimers();
          reject(new Error(mapStorageError(urlErr)));
        }
      }
    );
  });
}

export async function uploadImageToStorage(
  file: File,
  storageFolder: string,
  options: {
    onPreparing?: () => void;
    onPrepared?: (compressedBlob: Blob) => void;
    onProgress?: (pct: number) => void;
    compress?: CompressOptions;
    onTaskCreated?: (task: UploadTask) => void;
  } = {}
): Promise<UploadResult> {
  if (!getConfiguredStorageBucket()) {
    console.error('[useImageUpload] Firebase Storage error code: storage/not-configured');
    throw new Error(STORAGE_NOT_CONFIGURED_MESSAGE);
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    console.error('[useImageUpload] Firebase Storage error code: storage/network-offline');
    throw new Error('ইন্টারনেট সংযোগ নেই। সংযোগ চালু করে আবার চেষ্টা করুন। (No internet)');
  }

  validateImageFile(file);

  if (!auth.currentUser) {
    console.error('[useImageUpload] Firebase Storage error code: storage/unauthenticated');
    throw new Error(
      'আপলোডের অনুমতি নেই। ছবি আপলোড করতে অনুগ্রহ করে লগইন করুন। (Upload not allowed (permission))'
    );
  }

  options.onPreparing?.();
  const { blob, ext } = await compressImageToBlob(file, options.compress);
  options.onPrepared?.(blob);
  options.onProgress?.(5);

  const cleanFolder = storageFolder.replace(/^\/+|\/+$/g, '') || 'uploads';
  const fileName = generateUniqueFileName(ext);
  const fullPath = `${cleanFolder}/${fileName}`;
  const storageRef = ref(storage, fullPath);

  const metadata = {
    contentType: blob.type || (ext === 'webp' ? 'image/webp' : 'image/jpeg'),
    cacheControl: isPrivateStoragePath(cleanFolder)
      ? 'private,max-age=3600'
      : 'public,max-age=31536000',
  };

  const task = uploadBytesResumable(storageRef, blob, metadata);
  options.onTaskCreated?.(task);

  return runResumableUploadWithTimeouts(task, {
    onProgress: options.onProgress,
    progressStart: 5,
    progressSpan: 93,
  });
}

export async function uploadAttachmentToStorage(
  file: File,
  storageFolder: string,
  options: {
    onProgress?: (pct: number) => void;
    allowedMimeTypes?: string[];
  } = {}
): Promise<UploadResult> {
  if (isImageFile(file)) {
    return uploadImageToStorage(file, storageFolder, options);
  }

  if (!getConfiguredStorageBucket()) {
    console.error('[useImageUpload] Firebase Storage error code: storage/not-configured');
    throw new Error(STORAGE_NOT_CONFIGURED_MESSAGE);
  }

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    console.error('[useImageUpload] Firebase Storage error code: storage/network-offline');
    throw new Error('ইন্টারনেট সংযোগ নেই। সংযোগ চালু করে আবার চেষ্টা করুন। (No internet)');
  }
  if (!auth.currentUser) {
    console.error('[useImageUpload] Firebase Storage error code: storage/unauthenticated');
    throw new Error(
      'আপলোডের অনুমতি নেই। আপলোড করতে অনুগ্রহ করে লগইন করুন। (Upload not allowed (permission))'
    );
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new Error('ফাইলের সাইজ ৫ MB-এর বেশি হতে পারবে না। (File size exceeds 5 MB limit.)');
  }

  const allowed = options.allowedMimeTypes || ['application/pdf'];
  if (!allowed.includes(file.type)) {
    throw new Error(
      'ভুল ফাইল ফরম্যাট! শুধুমাত্র ছবি বা PDF ফাইল আপলোড করুন। (Unsupported file type.)'
    );
  }

  const ext = file.name.split('.').pop() || 'pdf';
  const cleanFolder = storageFolder.replace(/^\/+|\/+$/g, '') || 'uploads';
  const fullPath = `${cleanFolder}/${generateUniqueFileName(ext)}`;
  const storageRef = ref(storage, fullPath);

  const task = uploadBytesResumable(storageRef, file, {
    contentType: file.type,
    cacheControl: 'private,max-age=3600',
  });

  return runResumableUploadWithTimeouts(task, {
    onProgress: options.onProgress,
    progressStart: 0,
    progressSpan: 98,
  });
}

export interface UseImageUploadOptions {
  storagePath: string;
  compress?: CompressOptions;
  onSuccess?: (result: UploadResult) => void;
  onError?: (message: string) => void;
}

export function useImageUpload(options: UseImageUploadOptions) {
  const [isPreparing, setIsPreparing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState(() =>
    IS_STORAGE_CONFIGURED ? '' : STORAGE_NOT_CONFIGURED_MESSAGE
  );
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [justUploaded, setJustUploaded] = useState(false);
  const [canRetry, setCanRetry] = useState(false);
  const activeTaskRef = useRef<UploadTask | null>(null);
  const lastFailedUploadRef = useRef<{ file: File; previousUrl?: string | null } | null>(null);

  const clearError = useCallback(() => {
    setError(IS_STORAGE_CONFIGURED ? '' : STORAGE_NOT_CONFIGURED_MESSAGE);
    setCanRetry(false);
  }, []);

  const uploadImage = useCallback(
    async (file: File, previousUrl?: string | null): Promise<UploadResult | null> => {
      if (!getConfiguredStorageBucket()) {
        console.error('[useImageUpload] Firebase Storage error code: storage/not-configured');
        setIsPreparing(false);
        setIsUploading(false);
        setProgress(0);
        setLocalPreviewUrl(null);
        setCanRetry(false);
        setError(STORAGE_NOT_CONFIGURED_MESSAGE);
        options.onError?.(STORAGE_NOT_CONFIGURED_MESSAGE);
        return null;
      }

      setError('');
      setCanRetry(false);
      setJustUploaded(false);
      setProgress(0);

      let previewObjectUrl: string | null = null;
      try {
        validateImageFile(file);
        setIsPreparing(true);

        const result = await uploadImageToStorage(file, options.storagePath, {
          compress: options.compress,
          onPreparing: () => {
            setIsPreparing(true);
            setIsUploading(false);
          },
          onPrepared: (compressedBlob) => {
            previewObjectUrl = URL.createObjectURL(compressedBlob);
            setLocalPreviewUrl(previewObjectUrl);
            setIsPreparing(false);
            setIsUploading(true);
            setProgress(5);
          },
          onProgress: (pct) => setProgress(pct),
          onTaskCreated: (task) => {
            activeTaskRef.current = task;
          },
        });

        // Clean up the replaced Firebase Storage file after new upload succeeds
        if (previousUrl && previousUrl !== result.downloadUrl) {
          await deleteStorageFileByUrl(previousUrl);
        }

        lastFailedUploadRef.current = null;
        setCanRetry(false);
        setJustUploaded(true);
        setTimeout(() => setJustUploaded(false), 3000);
        options.onSuccess?.(result);
        return result;
      } catch (err: any) {
        const friendly = err?.message || mapStorageError(err);
        lastFailedUploadRef.current = { file, previousUrl };
        setCanRetry(true);
        setError(friendly);
        options.onError?.(friendly);
        return null;
      } finally {
        activeTaskRef.current = null;
        setIsPreparing(false);
        setIsUploading(false);
        setProgress(0);
        if (previewObjectUrl) {
          try {
            URL.revokeObjectURL(previewObjectUrl);
          } catch {
            // ignore
          }
        }
        setLocalPreviewUrl(null);
      }
    },
    [options]
  );

  const retryUpload = useCallback(async (): Promise<UploadResult | null> => {
    const failed = lastFailedUploadRef.current;
    if (!failed) return null;
    return uploadImage(failed.file, failed.previousUrl);
  }, [uploadImage]);

  const removeImage = useCallback(async (currentUrl?: string | null) => {
    lastFailedUploadRef.current = null;
    setCanRetry(false);
    setError(IS_STORAGE_CONFIGURED ? '' : STORAGE_NOT_CONFIGURED_MESSAGE);
    setJustUploaded(false);
    if (currentUrl) {
      await deleteStorageFileByUrl(currentUrl);
    }
  }, []);

  const cancelUpload = useCallback(() => {
    if (activeTaskRef.current) {
      try {
        activeTaskRef.current.cancel();
      } catch {
        // ignore
      }
    }
  }, []);

  return {
    isPreparing,
    isUploading,
    progress,
    error,
    localPreviewUrl,
    justUploaded,
    canRetry,
    clearError,
    setError,
    uploadImage,
    retryUpload,
    removeImage,
    cancelUpload,
  };
}
