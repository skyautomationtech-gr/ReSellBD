import React, { useState, useEffect } from 'react';
import { Download, RotateCcw, X, ZoomIn, ZoomOut, ImageOff } from 'lucide-react';

interface DocumentLightboxModalProps {
  imageUrl: string | null;
  title?: string;
  subtitle?: string;
  onClose: () => void;
}

export const DocumentLightboxModal: React.FC<DocumentLightboxModalProps> = ({
  imageUrl,
  title = 'Document Preview',
  subtitle,
  onClose,
}) => {
  const [zoom, setZoom] = useState(1);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setZoom(1);
    setImgError(false);
  }, [imageUrl]);

  useEffect(() => {
    if (!imageUrl) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '+' || e.key === '=') setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))));
      if (e.key === '-') setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))));
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [imageUrl, onClose]);

  if (!imageUrl) return null;

  const handleDownload = async () => {
    const safeName = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'document'}.jpg`;
    try {
      if (imageUrl.startsWith('data:')) {
        const a = document.createElement('a');
        a.href = imageUrl;
        a.download = safeName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        return;
      }

      const response = await fetch(imageUrl);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = safeName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
    } catch {
      const a = document.createElement('a');
      a.href = imageUrl;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.download = safeName;
      document.body.appendChild(a);
      a.click();
      a.remove();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] bg-slate-950/90 backdrop-blur-md flex flex-col"
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-white/10 bg-slate-950/60 shrink-0">
        <div className="min-w-0">
          <h3 className="text-[14px] font-bold text-white truncate">{title}</h3>
          {subtitle && (
            <p className="text-[11px] text-slate-400 truncate">{subtitle}</p>
          )}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
            title="Zoom out"
            className="min-h-[36px] min-w-[36px] px-2 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-[12px] font-mono tabular-nums text-slate-200 px-1.5 min-w-[46px] text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setZoom((z) => Math.min(3, Number((z + 0.25).toFixed(2))))}
            title="Zoom in"
            className="min-h-[36px] min-w-[36px] px-2 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => setZoom(1)}
            title="Reset zoom"
            className="min-h-[36px] min-w-[36px] px-2 rounded-lg bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="min-h-[36px] px-3 rounded-lg bg-[#0E9AA7] hover:bg-[#0c8591] text-white text-[12px] font-semibold flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Download</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close preview"
            className="min-h-[36px] min-w-[36px] px-2 rounded-lg bg-white/15 hover:bg-white/25 text-white flex items-center justify-center transition-colors cursor-pointer ml-1"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div
        className="flex-1 overflow-auto flex items-center justify-center p-4 sm:p-8"
        onClick={onClose}
      >
        {imgError ? (
          <div
            onClick={(e) => e.stopPropagation()}
            className="bg-slate-900 border border-white/15 rounded-2xl p-8 text-center max-w-sm space-y-2"
          >
            <ImageOff className="w-8 h-8 text-slate-400 mx-auto" />
            <p className="text-[13px] font-semibold text-white">Unable to render image</p>
            <p className="text-[12px] text-slate-400">Use Download to open the original file in a new tab.</p>
          </div>
        ) : (
          <img
            src={imageUrl}
            alt={title}
            referrerPolicy="no-referrer"
            onError={() => setImgError(true)}
            onClick={(e) => {
              e.stopPropagation();
              setZoom((z) => (z === 1 ? 1.75 : 1));
            }}
            style={{
              transform: `scale(${zoom})`,
              transformOrigin: 'center center',
            }}
            className="max-w-full max-h-full object-contain rounded-xl shadow-2xl transition-transform duration-150 cursor-zoom-in select-none"
          />
        )}
      </div>
    </div>
  );
};
