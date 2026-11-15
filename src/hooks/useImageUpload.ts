import { useState, useCallback, useRef } from 'react';
import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
  UploadTask,
} from 'firebase/storage';
import { auth, storage } from '../lib/firebase';

export const MAX_RAW_IMAGE_BYTES = 30 * 1024 * 1024; // 30 MB before compression
export const MAX_COMPRESSED_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB max uploaded (compressed) file
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5 MB max for non-image PDF attachments
export const TARGET_COMPRESSED_BYTES = 490 * 1024; // Target under 500 KB
export const RETRY_COMPRESSION_THRESHOLD_BYTES = 800 * 1024; // Retry lower quality if over 800 KB
export const MAX_LONGEST_SIDE_PX = 1280;

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
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return 'ইন্টারনেট সংযোগ নেই। সংযোগ চালু করে আবার চেষ্টা করুন। (No internet connection. Please try again.)';
  }
  const code = String(err?.code || '');
  const msg = String(err?.message || '');

  if (
    code === 'storage/unauthorized' ||
    code === 'storage/unauthenticated' ||
    msg.toLowerCase().includes('permission') ||
    msg.toLowerCase().includes('unauthorized')
  ) {
    return 'আপলোডের অনুমতি নেই। অনুগ্রহ করে অ্যাডমিন বা লগইন স্ট্যাটাস যাচাই করুন। (Permission denied.)';
  }
  if (code === 'storage/canceled') {
    return 'আপলোড বাতিল করা হয়েছে। (Upload was canceled.)';
  }
  if (code === 'storage/quota-exceeded') {
    return 'স্টোরেজ সীমা পূর্ণ হয়েছে। (Storage quota exceeded.)';
  }
  if (
    code === 'storage/retry-limit-exceeded' ||
    code === 'storage/server-file-wrong-size' ||
    msg.toLowerCase().includes('network') ||
    msg.toLowerCase().includes('offline') ||
    msg.toLowerCase().includes('fetch')
  ) {
    return 'ইন্টারনেট সংযোগে সমস্যা হয়েছে। আবার চেষ্টা করুন। (Network error while uploading. Please try again.)';
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
      console.warn('[useImageUpload] Old storage file cleanup skipped:', code || err?.message);
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
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error(
      'ইন্টারনেট সংযোগ নেই। সংযোগ চালু করে আবার চেষ্টা করুন। (No internet connection.)'
    );
  }

  validateImageFile(file);

  if (!auth.currentUser) {
    throw new Error(
      'ছবি আপলোড করতে অনুগ্রহ করে লগইন করুন। (Please sign in to upload images.)'
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

  return new Promise<UploadResult>((resolve, reject) => {
    const task = uploadBytesResumable(storageRef, blob, metadata);
    options.onTaskCreated?.(task);

    task.on(
      'state_changed',
      (snapshot) => {
        if (snapshot.totalBytes > 0) {
          const transferPct = (snapshot.bytesTransferred / snapshot.totalBytes) * 93;
          options.onProgress?.(Math.min(98, Math.round(5 + transferPct)));
        }
      },
      (err) => {
        reject(new Error(mapStorageError(err)));
      },
      async () => {
        try {
          const downloadUrl = await getDownloadURL(task.snapshot.ref);
          options.onProgress?.(100);
          resolve({ downloadUrl, storagePath: fullPath });
        } catch (urlErr: any) {
          reject(new Error(mapStorageError(urlErr)));
        }
      }
    );
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

  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    throw new Error(
      'ইন্টারনেট সংযোগ নেই। সংযোগ চালু করে আবার চেষ্টা করুন। (No internet connection.)'
    );
  }
  if (!auth.currentUser) {
    throw new Error('আপলোড করতে অনুগ্রহ করে লগইন করুন। (Please sign in to upload files.)');
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

  return new Promise<UploadResult>((resolve, reject) => {
    const task = uploadBytesResumable(storageRef, file, {
      contentType: file.type,
      cacheControl: 'private,max-age=3600',
    });

    task.on(
      'state_changed',
      (snapshot) => {
        if (snapshot.totalBytes > 0) {
          options.onProgress?.(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 98));
        }
      },
      (err) => reject(new Error(mapStorageError(err))),
      async () => {
        try {
          const downloadUrl = await getDownloadURL(task.snapshot.ref);
          options.onProgress?.(100);
          resolve({ downloadUrl, storagePath: fullPath });
        } catch (err: any) {
          reject(new Error(mapStorageError(err)));
        }
      }
    );
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
  const [error, setError] = useState('');
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const [justUploaded, setJustUploaded] = useState(false);
  const activeTaskRef = useRef<UploadTask | null>(null);

  const clearError = useCallback(() => setError(''), []);

  const uploadImage = useCallback(
    async (file: File, previousUrl?: string | null): Promise<UploadResult | null> => {
      setError('');
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
            setProgress(0);
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

        setJustUploaded(true);
        setTimeout(() => setJustUploaded(false), 3000);
        options.onSuccess?.(result);
        return result;
      } catch (err: any) {
        const friendly = mapStorageError(err);
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

  const removeImage = useCallback(async (currentUrl?: string | null) => {
    setError('');
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
    clearError,
    setError,
    uploadImage,
    removeImage,
    cancelUpload,
  };
}
