import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { X, Shield, CheckCircle2, ChevronDown, AlertCircle } from 'lucide-react';
import { PolicyDoc } from '../../../data/defaultPolicies';

interface PolicyModalProps {
  isOpen: boolean;
  policy: PolicyDoc | null;
  onClose: () => void;
  onScrolledToBottom: (policyKey: 'terms' | 'privacy') => void;
  alreadyScrolled: boolean;
}

export const PolicyModal: React.FC<PolicyModalProps> = ({
  isOpen,
  policy,
  onClose,
  onScrolledToBottom,
  alreadyScrolled,
}) => {
  const [lang, setLang] = useState<'bn' | 'en'>('bn');
  const scrollRef = useRef<HTMLDivElement>(null);
  const endSentinelRef = useRef<HTMLDivElement>(null);
  const hasNotifiedRef = useRef<boolean>(alreadyScrolled);
  const [scrolledToBottom, setScrolledToBottom] = useState<boolean>(alreadyScrolled);

  const policyKey = policy?.key;

  const unlockPolicy = useCallback(() => {
    setScrolledToBottom(true);
    if (policyKey && !hasNotifiedRef.current) {
      hasNotifiedRef.current = true;
      onScrolledToBottom(policyKey);
    }
  }, [policyKey, onScrolledToBottom]);

  // Reset modal scroll state whenever opening or switching between Terms and Privacy
  useEffect(() => {
    if (!isOpen || !policyKey) return;
    hasNotifiedRef.current = Boolean(alreadyScrolled);
    setScrolledToBottom(Boolean(alreadyScrolled));
    if (scrollRef.current && !alreadyScrolled) {
      scrollRef.current.scrollTop = 0;
    }
  }, [isOpen, policyKey, alreadyScrolled]);

  const checkIfAtBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return false;
    // Also unlocks immediately if the full document fits on screen without a scrollbar (e.g. tall desktop windows)
    const fitsWithoutScroll = el.scrollHeight <= el.clientHeight + 24;
    const reachedBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 40;
    if (fitsWithoutScroll || reachedBottom) {
      unlockPolicy();
      return true;
    }
    return false;
  }, [unlockPolicy]);

  // Check overflow & observe bottom sentinel after opening or switching language
  useEffect(() => {
    if (!isOpen || !policyKey) return;

    const rafId = window.requestAnimationFrame(() => {
      checkIfAtBottom();
    });
    const timerId = window.setTimeout(() => {
      checkIfAtBottom();
    }, 120);

    const rootEl = scrollRef.current;
    const targetEl = endSentinelRef.current;
    let observer: IntersectionObserver | null = null;

    if (rootEl && targetEl && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          if (entries.some((entry) => entry.isIntersecting)) {
            unlockPolicy();
          }
        },
        { root: rootEl, threshold: 0.1 }
      );
      observer.observe(targetEl);
    }

    const handleResize = () => checkIfAtBottom();
    window.addEventListener('resize', handleResize);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(timerId);
      window.removeEventListener('resize', handleResize);
      observer?.disconnect();
    };
  }, [isOpen, policyKey, lang, checkIfAtBottom, unlockPolicy]);

  // Lock body scroll and allow Escape key to close while open
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, onClose]);

  const handleScroll = () => {
    checkIfAtBottom();
  };

  if (!isOpen || !policy) return null;

  const title = lang === 'bn' ? policy.titleBn : policy.titleEn;
  const sections = lang === 'bn' ? policy.sectionsBn : policy.sectionsEn;

  const modalContent = (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-6 bg-black/80 backdrop-blur-md"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <motion.div
        key={policy.key}
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className="w-full max-w-2xl max-h-[90dvh] flex flex-col rounded-3xl bg-[#09152C]/95 border border-white/20 shadow-[0_20px_50px_rgba(0,0,0,0.75)] backdrop-blur-2xl overflow-hidden text-white"
      >
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-white/10 flex items-center justify-between gap-3 bg-white/[0.03] shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#0E9AA7] to-[#3DD055] flex items-center justify-center shrink-0 shadow-md">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <div className="truncate">
              <h2 className="text-sm sm:text-base font-extrabold truncate text-white">{title}</h2>
              <div className="flex items-center gap-2 text-[10px] text-slate-400">
                <span>Version {policy.version}</span>
                <span>•</span>
                <span>{policy.lastUpdated}</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {/* Language Switcher */}
            <div className="flex items-center rounded-xl bg-white/10 p-0.5 border border-white/15">
              <button
                type="button"
                onClick={() => setLang('bn')}
                className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                  lang === 'bn'
                    ? 'bg-gradient-to-r from-[#0E9AA7] to-[#3DD055] text-white shadow-xs'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                বাংলা
              </button>
              <button
                type="button"
                onClick={() => setLang('en')}
                className={`px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                  lang === 'en'
                    ? 'bg-gradient-to-r from-[#0E9AA7] to-[#3DD055] text-white shadow-xs'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                English
              </button>
            </div>

            {/* Close Button */}
            <button
              type="button"
              onClick={onClose}
              aria-label="Close document"
              className="p-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-slate-300 hover:text-white transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Legal Notice Header */}
        <div className="px-4 py-2.5 bg-amber-500/10 border-b border-amber-500/20 flex items-center gap-2 text-[11px] text-amber-300 shrink-0">
          <AlertCircle className="w-4 h-4 shrink-0 text-amber-400" />
          <span className="leading-tight">{policy.legalDisclaimer}</span>
        </div>

        {/* Scrollable Body */}
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="flex-1 min-h-0 overflow-y-auto p-4 sm:p-6 space-y-4 text-xs sm:text-sm text-slate-200 leading-relaxed scrollbar-thin scrollbar-thumb-white/20"
        >
          {sections.map((sec, idx) => (
            <div key={idx} className="p-3.5 rounded-2xl bg-white/[0.04] border border-white/10 space-y-1.5">
              <h3 className="font-bold text-white text-xs sm:text-sm flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#3DD055]" />
                {sec.title}
              </h3>
              <p className="text-slate-300 text-xs sm:text-[13px] leading-relaxed">
                {sec.content}
              </p>
            </div>
          ))}

          <div ref={endSentinelRef} className="py-4 text-center text-xs text-slate-400">
            — End of Document —
          </div>
        </div>

        {/* Footer with Scroll Status & Confirm */}
        <div className="p-4 border-t border-white/10 bg-white/[0.02] flex flex-col sm:flex-row items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-2 text-xs">
            {scrolledToBottom ? (
              <span className="text-[#3DD055] font-bold flex items-center gap-1">
                <CheckCircle2 className="w-4 h-4 shrink-0" /> You have reviewed the full document. Checkbox unlocked!
              </span>
            ) : (
              <span className="text-amber-400 font-medium flex items-center gap-1">
                <ChevronDown className="w-4 h-4 animate-bounce shrink-0" /> Please scroll to the bottom of the document to unlock agreement.
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              if (scrolledToBottom) {
                unlockPolicy();
                onClose();
              } else {
                const el = scrollRef.current;
                if (el) {
                  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
                  // Ensure unlock triggers cleanly after smooth scroll or immediately if non-scrollable
                  window.setTimeout(() => {
                    if (!checkIfAtBottom()) {
                      el.scrollTop = el.scrollHeight;
                      unlockPolicy();
                    }
                  }, 420);
                } else {
                  unlockPolicy();
                }
              }
            }}
            className={`w-full sm:w-auto px-5 py-2.5 rounded-xl font-bold text-xs transition-all cursor-pointer shrink-0 ${
              scrolledToBottom
                ? 'bg-gradient-to-r from-[#0E9AA7] to-[#3DD055] text-white shadow-md hover:brightness-110'
                : 'bg-white/15 text-slate-200 hover:bg-white/25'
            }`}
          >
            {scrolledToBottom ? 'I Have Read & Understand' : 'Scroll to Bottom'}
          </button>
        </div>
      </motion.div>
    </div>
  );

  if (typeof document !== 'undefined') {
    return createPortal(modalContent, document.body);
  }
  return modalContent;
};

