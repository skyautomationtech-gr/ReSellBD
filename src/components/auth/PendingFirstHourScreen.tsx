import React, { useEffect, useState } from 'react';
import { doc, getDoc } from 'firebase/firestore';
import { Check, Clock, LogOut, MailCheck, MessageCircle } from 'lucide-react';
import { db } from '../../lib/firebase';
import { UserProfile } from '../../types';
import { triggerHaptic } from '../../lib/nativeFeedback';
import resellbdLogo from '../../assets/images/logo.png';

interface PendingFirstHourScreenProps {
  user: UserProfile;
  submittedAtMs: number | null;
  remainingMs: number;
  progressRatio: number;
  onLogout: () => void;
}

const DEFAULT_SUPPORT_PHONE = '01700000000';

function buildWhatsAppSupportUrl(phoneRaw: string, resellerId?: string, shopName?: string): string {
  const digits = phoneRaw.replace(/\D/g, '');
  let waNumber = digits;
  if (digits.startsWith('880')) {
    waNumber = digits;
  } else if (digits.startsWith('0')) {
    waNumber = `88${digits}`;
  } else if (digits.length > 0) {
    waNumber = `880${digits}`;
  } else {
    waNumber = '8801700000000';
  }

  const identity = [shopName, resellerId].filter(Boolean).join(' · ');
  const message = identity
    ? `Hello ReSellBD Support, my reseller account (${identity}) is currently under review.`
    : 'Hello ReSellBD Support, my reseller account is currently under review.';

  return `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`;
}

function formatSubmittedTimestamp(ms: number | null): string {
  if (!ms) return 'Just now';
  try {
    return new Intl.DateTimeFormat('en-US', {
      day: 'numeric',
      month: 'short',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(ms));
  } catch {
    return 'Just now';
  }
}

export const PendingFirstHourScreen: React.FC<PendingFirstHourScreenProps> = ({
  user,
  submittedAtMs,
  remainingMs,
  progressRatio,
  onLogout,
}) => {
  const [supportPhone, setSupportPhone] = useState<string>(DEFAULT_SUPPORT_PHONE);

  // Load current company support WhatsApp number from settings/general (silent fallback to default)
  useEffect(() => {
    let active = true;
    getDoc(doc(db, 'settings', 'general'))
      .then((snap) => {
        if (!active || !snap.exists()) return;
        const data = snap.data();
        const raw = typeof data?.phoneNumbers === 'string' ? data.phoneNumbers.split(',')[0].trim() : '';
        if (raw) setSupportPhone(raw);
      })
      .catch(() => {
        // Silent fallback
      });
    return () => {
      active = false;
    };
  }, []);

  const totalSecondsLeft = Math.max(0, Math.ceil(remainingMs / 1000));
  const minsLeftRounded = Math.max(1, Math.ceil(remainingMs / 60000));
  const displayMinutes = Math.floor(totalSecondsLeft / 60);
  const displaySeconds = totalSecondsLeft % 60;
  const formattedClock = `${String(displayMinutes).padStart(2, '0')}:${String(displaySeconds).padStart(2, '0')}`;

  const timeLeftEnglish =
    totalSecondsLeft < 60
      ? 'Less than 1 minute left'
      : `About ${minsLeftRounded} ${minsLeftRounded === 1 ? 'minute' : 'minutes'} left`;

  const timeLeftBangla =
    totalSecondsLeft < 60 ? '১ মিনিটেরও কম বাকি' : `প্রায় ${minsLeftRounded} মিনিট বাকি`;

  // Ring geometry (SVG 96x96)
  const radius = 38;
  const circumference = 2 * Math.PI * radius;
  // Ring fills smoothly from 0% -> 100% over the 60-minute window
  const clampedProgress = Math.min(1, Math.max(0.03, progressRatio));
  const strokeDashoffset = circumference * (1 - clampedProgress);

  const resellerIdDisplay = user.resellerId || user.resellerCode || 'Assigning...';
  const shopNameDisplay = user.shopName || user.fullName || 'Your Shop';
  const submittedTimeDisplay = formatSubmittedTimestamp(submittedAtMs);
  const whatsappUrl = buildWhatsAppSupportUrl(
    supportPhone,
    user.resellerId || user.resellerCode,
    user.shopName
  );

  return (
    <div className="min-h-[100dvh] w-full bg-[#04203F] text-white relative overflow-y-auto overflow-x-hidden flex items-center justify-center px-3.5 py-5 sm:p-6">
      {/* Soft Brand Ambient Backdrop (Navy #04203F, Teal #0E9AA7, Green #3DD055) */}
      <div aria-hidden="true" className="fixed inset-0 pointer-events-none overflow-hidden">
        <div className="absolute -top-28 -left-24 w-80 h-80 rounded-full bg-[#0E9AA7]/20 blur-3xl" />
        <div className="absolute -bottom-28 -right-24 w-80 h-80 rounded-full bg-[#3DD055]/14 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_15%,rgba(14,154,167,0.14),transparent_60%)]" />
      </div>

      {/* Single Compact Glass Surface (Responsive 320px–430px) */}
      <main className="relative z-10 w-full max-w-[420px] rounded-3xl bg-white/[0.07] backdrop-blur-2xl border border-white/15 shadow-[0_24px_60px_rgba(2,12,27,0.55)] p-4.5 sm:p-6 space-y-5">
        {/* 1. ReSellBD Logo & Title (Bangla + English) */}
        <header className="flex flex-col items-center text-center space-y-3">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-2xl bg-white shadow-md flex items-center justify-center p-1.5 shrink-0">
              <img
                src={resellbdLogo}
                alt="ReSellBD Logo"
                className="w-full h-full object-contain"
              />
            </div>
            <span className="text-[17px] font-extrabold tracking-tight text-white">
              ReSellBD
            </span>
          </div>

          <div className="space-y-1">
            <h1 className="text-xl sm:text-[22px] font-extrabold tracking-tight text-white text-balance leading-snug">
              Your account is under review
            </h1>
            <p className="text-[13px] font-semibold text-[#7CE7F0] leading-snug">
              আপনার অ্যাকাউন্ট রিভিউ করা হচ্ছে
            </p>
          </div>
        </header>

        {/* 2. Animated Progress Ring & First-Hour Countdown */}
        <section
          aria-label="Review time estimate"
          className="pt-4 border-t border-white/10 flex items-center gap-4"
        >
          <div className="relative w-[88px] h-[88px] sm:w-[96px] sm:h-[96px] shrink-0 flex items-center justify-center">
            <svg
              className="w-full h-full -rotate-90"
              viewBox="0 0 96 96"
              aria-hidden="true"
            >
              <defs>
                <linearGradient id="pendingHourRingGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor="#0E9AA7" />
                  <stop offset="100%" stopColor="#3DD055" />
                </linearGradient>
              </defs>
              <circle
                cx="48"
                cy="48"
                r={radius}
                fill="none"
                stroke="rgba(255,255,255,0.12)"
                strokeWidth="6"
              />
              <circle
                cx="48"
                cy="48"
                r={radius}
                fill="none"
                stroke="url(#pendingHourRingGrad)"
                strokeWidth="6"
                strokeLinecap="round"
                strokeDasharray={circumference}
                strokeDashoffset={strokeDashoffset}
                className="transition-[stroke-dashoffset] duration-700 ease-out motion-reduce:transition-none"
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
              <span className="text-[15px] sm:text-base font-extrabold font-mono tabular-nums tracking-tight text-white leading-none">
                {formattedClock}
              </span>
              <span className="text-[10px] font-medium text-slate-300 mt-1 leading-none">
                left
              </span>
            </div>
          </div>

          <div className="min-w-0 flex-1 space-y-1">
            <p className="text-sm sm:text-[15px] font-bold text-white tabular-nums leading-snug">
              {timeLeftEnglish}
            </p>
            <p className="text-[12px] font-semibold text-[#3DD055] tabular-nums leading-snug">
              {timeLeftBangla}
            </p>
            <p className="text-[12px] text-slate-300 leading-snug pt-0.5">
              We usually review accounts within 1 hour
            </p>
          </div>
        </section>

        {/* 3. Account Summary (Reseller ID, Shop Name, Submitted Time) */}
        <section
          aria-label="Submitted details"
          className="pt-3.5 border-t border-white/10 space-y-2 text-[12.5px]"
        >
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-400 shrink-0">Reseller ID</span>
            <span className="font-mono font-bold tabular-nums text-white truncate">
              {resellerIdDisplay}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-400 shrink-0">Shop name</span>
            <span className="font-semibold text-white truncate text-right">
              {shopNameDisplay}
            </span>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-slate-400 shrink-0">Submitted</span>
            <span className="font-medium tabular-nums text-slate-200 truncate text-right">
              {submittedTimeDisplay}
            </span>
          </div>
        </section>

        {/* 4. Simple 3-Step Tracker: Submitted -> Under review -> Decision */}
        <section aria-label="Verification progress" className="pt-4 border-t border-white/10">
          <div className="grid grid-cols-3 gap-1.5 relative">
            {/* Connecting tracks */}
            <div
              aria-hidden="true"
              className="absolute top-3.5 left-[18%] right-[18%] h-[2px] bg-white/15 -z-0"
            >
              <div className="h-full w-1/2 bg-gradient-to-r from-[#3DD055] to-[#0E9AA7]" />
            </div>

            {/* Step 1: Submitted */}
            <div className="relative z-10 flex flex-col items-center text-center">
              <div className="w-7 h-7 rounded-full bg-[#3DD055]/20 border border-[#3DD055] text-[#3DD055] flex items-center justify-center shadow-xs">
                <Check className="w-3.5 h-3.5 stroke-[2.75]" />
              </div>
              <span className="text-[11px] font-semibold text-slate-200 mt-1.5 leading-tight">
                Submitted
              </span>
              <span className="text-[10px] text-slate-400 leading-tight mt-0.5">
                জমা হয়েছে
              </span>
            </div>

            {/* Step 2: Under review (Current) */}
            <div className="relative z-10 flex flex-col items-center text-center">
              <div className="w-7 h-7 rounded-full bg-[#0E9AA7] border-2 border-[#7CE7F0] text-white flex items-center justify-center shadow-[0_0_16px_rgba(14,154,167,0.55)]">
                <Clock className="w-3.5 h-3.5 animate-[spin_10s_linear_infinite] motion-reduce:animate-none" />
              </div>
              <span className="text-[11px] font-bold text-[#7CE7F0] mt-1.5 leading-tight">
                Under review
              </span>
              <span className="text-[10px] text-[#7CE7F0]/85 leading-tight mt-0.5">
                রিভিউ চলছে
              </span>
            </div>

            {/* Step 3: Decision */}
            <div className="relative z-10 flex flex-col items-center text-center">
              <div className="w-7 h-7 rounded-full bg-[#04203F] border border-white/25 text-slate-400 flex items-center justify-center">
                <MailCheck className="w-3.5 h-3.5" />
              </div>
              <span className="text-[11px] font-medium text-slate-400 mt-1.5 leading-tight">
                Decision
              </span>
              <span className="text-[10px] text-slate-500 leading-tight mt-0.5">
                সিদ্ধান্ত
              </span>
            </div>
          </div>
        </section>

        {/* 5. What Happens Next */}
        <section
          aria-label="What happens next"
          className="pt-3.5 border-t border-white/10 space-y-1.5 text-[12px] text-slate-200 leading-relaxed"
        >
          <p className="font-semibold text-white text-[12.5px]">
            What happens next (পরবর্তী ধাপ)
          </p>
          <p className="text-slate-300">
            You will receive an email as soon as your account is approved or rejected. After 1 hour, you can explore the app with limited access while review finishes.
          </p>
          <p className="text-[11.5px] text-slate-400">
            অনুমোদন বা বাতিল হলে ইমেইলে জানানো হবে এবং ১ ঘণ্টা পর সীমিত অ্যাক্সেসে অ্যাপ দেখতে পারবেন।
          </p>
        </section>

        {/* 6. Actions: Contact support & Sign out (no refresh button — auto-updates) */}
        <footer className="pt-2 grid grid-cols-1 min-[340px]:grid-cols-2 gap-2.5">
          <a
            href={whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => triggerHaptic('light')}
            className="min-h-[44px] px-4 py-2.5 rounded-xl bg-[#0E9AA7] hover:bg-[#0c8793] active:scale-[0.98] text-white text-[13px] font-bold flex items-center justify-center gap-2 transition-all shadow-md shadow-[#0E9AA7]/25 whitespace-nowrap"
          >
            <MessageCircle className="w-4 h-4 shrink-0" />
            <span>Contact support</span>
          </a>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onLogout();
            }}
            className="min-h-[44px] px-4 py-2.5 rounded-xl bg-white/10 hover:bg-white/15 active:scale-[0.98] border border-white/15 text-slate-100 text-[13px] font-bold flex items-center justify-center gap-2 transition-all cursor-pointer whitespace-nowrap"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            <span>Sign out</span>
          </button>
        </footer>
      </main>
    </div>
  );
};
