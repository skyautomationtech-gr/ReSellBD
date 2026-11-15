import { useState, useCallback, useRef } from 'react';
import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
  UploadTask,
} from 'firebase/storage';
import { auth, storage } from '../lib/firebase';

export const MAX_RAW_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB before compression
export const TARGET_COMPRESSED_BYTES = 490 * 1024; // Target under 500 KB
export const MAX_LONGEST_SIDE_PX = 1280;

const IMAGE_EXT_REGEX = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif)$/i;

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
  if (file.type && file.type.startsWith('image/')) return true;
  if (!file.type && IMAGE_EXT_REGEX.test(file.name || '')) return true;
  return false;
}

export function validateImageFile(file: File, maxBytes = MAX_RAW_IMAGE_BYTES): void {
  if (!file || !isImageFile(file)) {
    throw new Error(
      'ভুল ফাইল ফরম্যাট! শুধুমাত্র ছবি (JPG, PNG, WEBP) আপলোড করুন। (Wrong file type. Please choose an image file.)'
    );
  }
  if (file.size > maxBytes) {
    const maxMb = Math.round((maxBytes / (1024 * 1024)) * 10) / 10;
    throw new Error(
      `ছবির সাইজ ${maxMb} MB-এর বেশি হতে পারবে না। (File is too large. Max allowed size is ${maxMb} MB.)`
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

function loadHtmlImageFromFile(file: File): Promise<{ img: HTMLImageElement; revoke: () => void }> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({
        img,
        revoke: () => {
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
      reject(
        new Error(
          'ছবিটি পড়া যায়নি। অন্য একটি ছবি নির্বাচন করুন। (Could not read this image file.)'
        )
      );
    };
    img.src = objectUrl;
  });
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

  const { img, revoke } = await loadHtmlImageFromFile(file);
  try {
    const srcWidth = Math.max(1, img.naturalWidth || img.width);
    const srcHeight = Math.max(1, img.naturalHeight || img.height);
    const longest = Math.max(srcWidth, srcHeight);
    let scale = longest > maxSide ? maxSide / longest : 1;

    const useWebp = supportsWebpEncoding();
    const mimeType = useWebp ? 'image/webp' : 'image/jpeg';
    const ext = useWebp ? 'webp' : 'jpg';

    let width = Math.max(1, Math.round(srcWidth * scale));
    let height = Math.max(1, Math.round(srcHeight * scale));

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return {
        blob: file,
        ext: file.name.split('.').pop() || 'jpg',
      };
    }

    const render = async (w: number, h: number, q: number): Promise<Blob> => {
      canvas.width = w;
      canvas.height = h;
      ctx.clearRect(0, 0, w, h);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      if (mimeType === 'image/jpeg') {
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, w, h);
      }
      ctx.drawImage(img, 0, 0, w, h);
      return canvasToBlob(canvas, mimeType, q);
    };

    const qualitySteps = [initialQuality, 0.7, 0.58, 0.46];
    let bestBlob = await render(width, height, qualitySteps[0]);

    for (let i = 1; i < qualitySteps.length && bestBlob.size > targetMaxBytes; i++) {
      bestBlob = await render(width, height, qualitySteps[i]);
    }

    // If still above targetMaxBytes (e.g. high-detail photo), progressively reduce dimensions
    let shrinkPass = 0;
    while (bestBlob.size > targetMaxBytes && shrinkPass < 3 && Math.max(width, height) > 360) {
      shrinkPass += 1;
      width = Math.max(1, Math.round(width * 0.78));
      height = Math.max(1, Math.round(height * 0.78));
      bestBlob = await render(width, height, 0.65);
    }

    return { blob: bestBlob, ext };
  } finally {
    revoke();
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

  options.onProgress?.(5);
  const { blob, ext } = await compressImageToBlob(file, options.compress);
  options.onProgress?.(18);

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
          const transferPct = (snapshot.bytesTransferred / snapshot.totalBytes) * 80;
          options.onProgress?.(Math.min(98, Math.round(18 + transferPct)));
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
  if (file.size > MAX_RAW_IMAGE_BYTES) {
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

      let previewObjectUrl: string | null = null;
      try {
        validateImageFile(file);
        previewObjectUrl = URL.createObjectURL(file);
        setLocalPreviewUrl(previewObjectUrl);
        setIsUploading(true);
        setProgress(5);

        const result = await uploadImageToStorage(file, options.storagePath, {
          compress: options.compress,
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
