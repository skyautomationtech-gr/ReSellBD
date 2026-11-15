import React, { useId, useRef, useState } from 'react';
import {
  Camera,
  CheckCircle2,
  ImagePlus,
  Link2,
  RefreshCw,
  Trash2,
  UploadCloud,
  AlertCircle,
  Loader2,
  X,
} from 'lucide-react';
import { useImageUpload, CompressOptions } from '../../hooks/useImageUpload';

export interface ImageUploadFieldProps {
  value: string;
  onChange: (url: string, storagePath?: string) => void;
  storagePath: string;
  label?: string;
  helperText?: string;
  theme?: 'light' | 'glass' | 'dark';
  size?: 'xs' | 'sm' | 'md' | 'lg';
  aspect?: 'square' | 'wide';
  disabled?: boolean;
  required?: boolean;
  allowUrlFallback?: boolean;
  captureMode?: 'environment' | 'user';
  placeholderText?: string;
  compressOptions?: CompressOptions;
  onUploadError?: (msg: string) => void;
  className?: string;
}

const SIZE_CLASSES: Record<'xs' | 'sm' | 'md' | 'lg', { square: string; wide: string }> = {
  xs: { square: 'w-16 h-16', wide: 'w-full h-20' },
  sm: { square: 'w-20 h-20', wide: 'w-full h-24' },
  md: { square: 'w-24 h-24', wide: 'w-full h-28' },
  lg: { square: 'w-28 h-28', wide: 'w-full h-36' },
};

export const ImageUploadField: React.FC<ImageUploadFieldProps> = ({
  value,
  onChange,
  storagePath,
  label,
  helperText,
  theme = 'light',
  size = 'md',
  aspect = 'square',
  disabled = false,
  required = false,
  allowUrlFallback = false,
  captureMode = 'environment',
  placeholderText,
  compressOptions,
  onUploadError,
  className = '',
}) => {
  const inputId = useId();
  const galleryInputRef = useRef<HTMLInputElement | null>(null);
  const cameraInputRef = useRef<HTMLInputElement | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [showUrlInput, setShowUrlInput] = useState(false);

  const {
    isPreparing,
    isUploading,
    progress,
    error,
    localPreviewUrl,
    justUploaded,
    clearError,
    uploadImage,
    removeImage,
  } = useImageUpload({
    storagePath,
    compress: compressOptions,
    onSuccess: (res) => {
      onChange(res.downloadUrl, res.storagePath);
    },
    onError: (msg) => {
      onUploadError?.(msg);
    },
  });

  const isBusy = isPreparing || isUploading;
  const displaySrc = localPreviewUrl || value || '';
  const isDark = theme === 'dark';
  const isGlass = theme === 'glass';

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0 || disabled || isBusy) return;
    const file = files[0];
    await uploadImage(file, value);
  };

  const handleGalleryChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleFiles(e.target.files);
    e.target.value = '';
  };

  const handleCameraChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    await handleFiles(e.target.files);
    e.target.value = '';
  };

  const handleRemove = async () => {
    if (disabled || isBusy) return;
    const oldVal = value;
    onChange('', '');
    await removeImage(oldVal);
  };

  const handleDragEnter = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled && !isBusy) setIsDragging(true);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled && !isBusy && !isDragging) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (disabled || isBusy) return;
    await handleFiles(e.dataTransfer.files);
  };

  const boxSizeClass = SIZE_CLASSES[size][aspect];
  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (Math.min(100, Math.max(0, progress)) / 100) * circumference;

  const containerSurface = isDark
    ? isDragging
      ? 'border-[#0E9AA7] bg-[#0E9AA7]/15'
      : 'border-white/15 bg-white/[0.04]'
    : isGlass
      ? isDragging
        ? 'border-[#0E9AA7] bg-teal-50/70 backdrop-blur-xl'
        : 'border-white/80 bg-white/75 backdrop-blur-xl'
      : isDragging
        ? 'border-[#0E9AA7] bg-teal-50/60'
        : 'border-slate-200 bg-slate-50/80';

  const previewSurface = isDark
    ? 'border-white/15 bg-black/40 text-slate-400'
    : 'border-slate-200 bg-white text-slate-400';

  const primaryBtnClass = isDark
    ? 'bg-white/10 hover:bg-white/15 text-white border-white/15'
    : 'bg-white hover:bg-slate-100 text-slate-800 border-slate-200 shadow-2xs';

  const secondaryBtnClass = isDark
    ? 'bg-[#0E9AA7]/20 hover:bg-[#0E9AA7]/30 text-[#5EEAD4] border-[#0E9AA7]/35'
    : 'bg-teal-50 hover:bg-teal-100 text-[#04203F] border-teal-200';

  const dangerBtnClass = isDark
    ? 'bg-rose-500/15 hover:bg-rose-500/25 text-rose-300 border-rose-500/30'
    : 'bg-rose-50 hover:bg-rose-100 text-rose-700 border-rose-200';

  return (
    <div className={`space-y-1.5 min-w-0 ${className}`}>
      {label && (
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor={inputId}
            className={`block text-xs font-semibold truncate ${
              isDark ? 'text-slate-300' : 'text-slate-700'
            }`}
          >
            {label}
            {required && <span className="text-rose-500 ml-0.5">*</span>}
          </label>
          {justUploaded && (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#3DD055] shrink-0 animate-in fade-in duration-200">
              <CheckCircle2 className="w-3 h-3" />
              <span>আপলোড হয়েছে</span>
            </span>
          )}
        </div>
      )}

      {/* Hidden Gallery & Camera File Inputs */}
      <input
        id={inputId}
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        onChange={handleGalleryChange}
        disabled={disabled || isBusy}
        className="hidden"
      />
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture={captureMode}
        onChange={handleCameraChange}
        disabled={disabled || isBusy}
        className="hidden"
      />

      {/* Drop Zone & Compact Preview Card */}
      <div
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`rounded-2xl border transition-all p-2.5 ${containerSurface} ${
          isDragging ? 'ring-2 ring-[#0E9AA7]/40 border-dashed' : ''
        } ${disabled ? 'opacity-65 cursor-not-allowed' : ''}`}
      >
        <div
          className={`flex ${
            aspect === 'wide' ? 'flex-col gap-2.5' : 'flex-wrap sm:flex-nowrap items-center gap-3'
          }`}
        >
          {/* Preview Box (Preparing state, instant compressed preview, progress ring, success tick, or placeholder) */}
          <div
            onClick={() => {
              if (!disabled && !isBusy && !displaySrc) {
                galleryInputRef.current?.click();
              }
            }}
            className={`relative shrink-0 rounded-xl overflow-hidden border flex items-center justify-center ${boxSizeClass} ${previewSurface} ${
              !displaySrc && !disabled && !isBusy
                ? 'cursor-pointer border-dashed hover:border-[#0E9AA7] transition-colors'
                : ''
            }`}
          >
            {displaySrc ? (
              <img
                src={displaySrc}
                alt={label || 'Uploaded preview'}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="flex flex-col items-center justify-center p-2 text-center select-none">
                {isDragging ? (
                  <UploadCloud className="w-6 h-6 text-[#0E9AA7] animate-bounce" />
                ) : (
                  <ImagePlus className="w-5 h-5 opacity-70" />
                )}
                <span className="text-[9px] font-medium mt-1 leading-tight opacity-80">
                  {isDragging ? 'ছাড়ুন' : placeholderText || 'ছবি নেই'}
                </span>
              </div>
            )}

            {/* Preparing Overlay while decoding & compressing camera photo */}
            {isPreparing && (
              <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-[2px] flex flex-col items-center justify-center text-white px-1 text-center">
                <Loader2 className="w-5 h-5 animate-spin text-[#5EEAD4]" />
                <span className="text-[9px] font-bold leading-tight mt-1">
                  Preparing photo...
                </span>
              </div>
            )}

            {/* Progress Ring Overlay while uploading compressed image */}
            {!isPreparing && isUploading && (
              <div className="absolute inset-0 bg-slate-950/65 backdrop-blur-[2px] flex flex-col items-center justify-center text-white">
                <svg className="w-11 h-11 -rotate-90" viewBox="0 0 48 48">
                  <circle
                    cx="24"
                    cy="24"
                    r={radius}
                    fill="none"
                    stroke="rgba(255,255,255,0.22)"
                    strokeWidth="3.5"
                  />
                  <circle
                    cx="24"
                    cy="24"
                    r={radius}
                    fill="none"
                    stroke="#3DD055"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={strokeDashoffset}
                    className="transition-all duration-150"
                  />
                </svg>
                <span className="absolute text-[10px] font-extrabold font-mono">
                  {progress}%
                </span>
              </div>
            )}

            {/* Small Success Tick Badge */}
            {!isBusy && justUploaded && displaySrc && (
              <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-[#3DD055] text-white flex items-center justify-center shadow-md">
                <CheckCircle2 className="w-3.5 h-3.5" />
              </div>
            )}
          </div>

          {/* Controls & Info */}
          <div className="flex-1 min-w-0 space-y-2">
            {isPreparing ? (
              <p className="text-[11px] font-bold text-[#0E9AA7]">
                ছবি প্রস্তুত হচ্ছে... (Preparing photo...)
              </p>
            ) : isDragging ? (
              <p className="text-[11px] font-bold text-[#0E9AA7]">
                ছবি এখানে ছেড়ে দিন (Drop image here)
              </p>
            ) : (
              <p
                className={`text-[10px] leading-snug ${
                  isDark ? 'text-slate-400' : 'text-slate-500'
                }`}
              >
                {helperText || 'গ্যালারি, ক্যামেরা বা ড্র্যাগ করে ছবি দিন (সর্বোচ্চ ৩০ MB)'}
              </p>
            )}

            {/* Action Buttons (Gallery / Replace, Take photo, Remove) */}
            {!disabled && (
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => galleryInputRef.current?.click()}
                  disabled={isBusy}
                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[11px] font-bold transition-colors cursor-pointer disabled:opacity-50 ${primaryBtnClass}`}
                >
                  {value ? (
                    <>
                      <RefreshCw className="w-3 h-3" />
                      <span>পরিবর্তন (Replace)</span>
                    </>
                  ) : (
                    <>
                      <ImagePlus className="w-3 h-3" />
                      <span>গ্যালারি (Choose)</span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => cameraInputRef.current?.click()}
                  disabled={isBusy}
                  className={`inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border text-[11px] font-bold transition-colors cursor-pointer disabled:opacity-50 ${secondaryBtnClass}`}
                >
                  <Camera className="w-3 h-3" />
                  <span>ছবি তুলুন (Camera)</span>
                </button>

                {value && !isBusy && (
                  <button
                    type="button"
                    onClick={handleRemove}
                    className={`inline-flex items-center gap-1 px-2 py-1.5 rounded-lg border text-[11px] font-bold transition-colors cursor-pointer ${dangerBtnClass}`}
                    title="Remove image"
                  >
                    <Trash2 className="w-3 h-3" />
                    <span>মুছুন (Remove)</span>
                  </button>
                )}
              </div>
            )}

            {/* Optional Super Admin-only URL fallback toggle */}
            {allowUrlFallback && !disabled && (
              <div className="pt-0.5">
                {!showUrlInput ? (
                  <button
                    type="button"
                    onClick={() => setShowUrlInput(true)}
                    className={`inline-flex items-center gap-1 text-[10px] underline-offset-2 hover:underline cursor-pointer ${
                      isDark ? 'text-slate-400 hover:text-slate-200' : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    <Link2 className="w-2.5 h-2.5" />
                    <span>Paste a link instead (লিংক দিন)</span>
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5 pt-1">
                    <input
                      type="url"
                      value={value}
                      onChange={(e) => {
                        clearError();
                        onChange(e.target.value);
                      }}
                      placeholder="https://..."
                      className={`flex-1 min-w-0 px-2.5 py-1 rounded-lg border text-[11px] outline-none ${
                        isDark
                          ? 'bg-white/5 border-white/15 text-white placeholder-slate-500 focus:border-[#0E9AA7]'
                          : 'bg-white border-slate-300 text-slate-800 placeholder-slate-400 focus:border-[#0E9AA7]'
                      }`}
                    />
                    <button
                      type="button"
                      onClick={() => setShowUrlInput(false)}
                      className={`p-1 rounded-lg border cursor-pointer ${primaryBtnClass}`}
                      title="Close link input"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Friendly Bilingual Error Message */}
      {error && (
        <div
          className={`flex items-start gap-1.5 px-2.5 py-1.5 rounded-xl border text-[11px] font-medium ${
            isDark
              ? 'bg-rose-500/15 border-rose-500/30 text-rose-200'
              : 'bg-rose-50 border-rose-200 text-rose-700'
          }`}
        >
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span className="flex-1 leading-snug">{error}</span>
          <button
            type="button"
            onClick={clearError}
            className="opacity-70 hover:opacity-100 cursor-pointer"
            aria-label="Dismiss error"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      )}
    </div>
  );
};
