import React, { useState, useRef, useEffect } from 'react';
import { Lock } from 'lucide-react';

interface LockTooltipIconProps {
  message?: string;
  size?: 'xs' | 'sm';
  className?: string;
}

export const LockTooltipIcon: React.FC<LockTooltipIconProps> = ({
  message = 'Request a change from Settings',
  size = 'sm',
  className = '',
}) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const handleOutsideClick = (e: MouseEvent | TouchEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };

    const timer = window.setTimeout(() => setOpen(false), 3500);
    document.addEventListener('mousedown', handleOutsideClick);
    document.addEventListener('touchstart', handleOutsideClick, { passive: true });
    document.addEventListener('keydown', handleEscape);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', handleOutsideClick);
      document.removeEventListener('touchstart', handleOutsideClick);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const iconSize = size === 'xs' ? 'w-3 h-3' : 'w-3.5 h-3.5';

  return (
    <span ref={wrapperRef} className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((prev) => !prev);
        }}
        title={message}
        aria-label={message}
        className="p-0.5 rounded-md text-slate-400 hover:text-slate-600 focus:outline-none focus:ring-1 focus:ring-[#0E9AA7] transition-colors cursor-pointer"
      >
        <Lock className={iconSize} />
      </button>

      {open && (
        <span
          role="tooltip"
          onClick={(e) => e.stopPropagation()}
          className="absolute left-1/2 -translate-x-1/2 bottom-full mb-1.5 z-50 px-2.5 py-1.5 rounded-lg bg-[#04203F] text-white text-[11px] font-medium whitespace-nowrap shadow-lg pointer-events-auto"
        >
          {message}
          <span className="absolute left-1/2 -translate-x-1/2 top-full w-2 h-2 bg-[#04203F] rotate-45 -mt-1" />
        </span>
      )}
    </span>
  );
};
