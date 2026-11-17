import React, { useState, useEffect, useRef, useId } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  CheckCircle2,
  RotateCw,
  AlertCircle,
  Mail,
  Check,
  Edit2,
  Lock,
  RefreshCw,
} from 'lucide-react';
import {
  sendEmailOtpCall,
  verifyEmailOtpCall,
  maskEmail,
  formatOtpErrorMessage,
} from '../../../lib/emailOtpService';
import { triggerHaptic } from '../../../lib/nativeFeedback';

interface OtpVerificationInputProps {
  email: string;
  isVerified: boolean;
  onVerifiedChange: (verified: boolean) => void;
  onEmailChange?: (newEmail: string) => void;
  disabled?: boolean;
  isResubmit?: boolean;
  shakeField?: boolean;
  onFocus?: () => void;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const OtpVerificationInput: React.FC<OtpVerificationInputProps> = ({
  email,
  isVerified,
  onVerifiedChange,
  onEmailChange,
  disabled = false,
  isResubmit = false,
  shakeField = false,
  onFocus,
}) => {
  const prefersReducedMotion = useReducedMotion();
  const emailInputId = useId();
  const otpGroupId = useId();

  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [isSending, setIsSending] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [codeSent, setCodeSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [expiresIn, setExpiresIn] = useState(600);
  const [attemptsLeft, setAttemptsLeft] = useState<number>(5);
  const [hasWrongAttempt, setHasWrongAttempt] = useState(false);
  const [isLocked, setIsLocked] = useState(false);

  const [errorMessage, setErrorMessage] = useState('');
  const [retryAction, setRetryAction] = useState<'send' | 'verify' | null>(null);
  const [isShaking, setIsShaking] = useState(false);
  const [isEditingEmail, setIsEditingEmail] = useState(false);
  const [showSuccessFlash, setShowSuccessFlash] = useState(false);

  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);
  const emailInputRef = useRef<HTMLInputElement | null>(null);
  const lastSubmittedCodeRef = useRef<string>('');
  const lastSentEmailRef = useRef<string>('');
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanEmail = String(email || '').trim().toLowerCase();
  const isEmailValid = EMAIL_REGEX.test(cleanEmail);
  const isSameEmailCooldown = cooldown > 0 && cleanEmail === lastSentEmailRef.current;

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      if (successTimerRef.current) clearTimeout(successTimerRef.current);
      if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    };
  }, []);

  // Cooldown countdown timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  // Expiration countdown timer
  useEffect(() => {
    if (expiresIn <= 0 || !codeSent || isVerified) return;
    const timer = setInterval(() => {
      setExpiresIn((prev) => {
        if (prev <= 1) {
          setErrorMessage(
            'কোডের মেয়াদ শেষ হয়ে গেছে। নতুন কোড পাঠান। (Verification code expired. Please request a new code.)'
          );
          setRetryAction('send');
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresIn, codeSent, isVerified]);

  const scrollTargetIntoView = (el: HTMLElement | null) => {
    if (!el) return;
    setTimeout(() => {
      el.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'nearest',
      });
    }, 80);
  };

  const formatTimer = (seconds: number) => {
    const safe = Math.max(0, seconds);
    const m = Math.floor(safe / 60);
    const s = safe % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  // Send / Resend OTP
  const handleSendOtp = async () => {
    if (!cleanEmail || !isEmailValid) {
      setErrorMessage(
        'সঠিক ইমেইল ঠিকানা লিখুন। (Please enter a valid email address.)'
      );
      setRetryAction(null);
      return;
    }

    triggerHaptic('light');
    setIsSending(true);
    setErrorMessage('');
    setRetryAction(null);
    setIsEditingEmail(false);

    try {
      const response = await sendEmailOtpCall(cleanEmail);
      lastSentEmailRef.current = cleanEmail;
      setCodeSent(true);
      setCooldown(response.cooldownSeconds || 60);
      setExpiresIn(response.expiresInSeconds || 600);
      setAttemptsLeft(5);
      setHasWrongAttempt(false);
      setIsLocked(false);
      setDigits(['', '', '', '', '', '']);

      setTimeout(() => {
        const firstBox = inputRefs.current[0];
        firstBox?.focus();
        scrollTargetIntoView(firstBox);
      }, prefersReducedMotion ? 20 : 180);
    } catch (err: any) {
      console.error('[OtpVerificationInput] Send error:', err);
      const formatted = formatOtpErrorMessage(err);
      setErrorMessage(formatted.message);

      if (formatted.isLocked || err?.isLocked) {
        setIsLocked(true);
        setRetryAction(null);
      } else if (
        formatted.code === 'network' ||
        formatted.code === 'internal' ||
        formatted.code === 'unavailable'
      ) {
        setRetryAction('send');
      } else {
        setRetryAction(null);
      }
    } finally {
      setIsSending(false);
    }
  };

  // Handle single digit or multi-digit OS autofill input
  const handleDigitChange = (index: number, val: string) => {
    if (isVerifying || isLocked || showSuccessFlash) return;

    const cleanedAll = val.replace(/\D/g, '');
    setErrorMessage('');
    setRetryAction(null);

    // Support OS/browser autofill injecting multiple digits at once
    if (cleanedAll.length > 1) {
      const slice = cleanedAll.slice(0, 6).split('');
      const newDigits = ['', '', '', '', '', ''];
      for (let i = 0; i < slice.length; i++) {
        newDigits[i] = slice[i];
      }
      setDigits(newDigits);
      if (slice.length === 6) {
        triggerVerifyOtp(newDigits.join(''));
      } else {
        inputRefs.current[Math.min(slice.length, 5)]?.focus();
      }
      return;
    }

    const cleaned = cleanedAll.slice(-1);
    const newDigits = [...digits];
    newDigits[index] = cleaned;
    setDigits(newDigits);

    if (cleaned && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }

    const fullCode = newDigits.join('');
    if (fullCode.length === 6) {
      triggerVerifyOtp(fullCode);
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (isVerifying || isLocked || showSuccessFlash) return;

    if (e.key === 'Backspace') {
      if (digits[index]) {
        const newDigits = [...digits];
        newDigits[index] = '';
        setDigits(newDigits);
      } else if (index > 0) {
        const newDigits = [...digits];
        newDigits[index - 1] = '';
        setDigits(newDigits);
        inputRefs.current[index - 1]?.focus();
      }
      e.preventDefault();
      return;
    }

    if (e.key === 'ArrowLeft' && index > 0) {
      inputRefs.current[index - 1]?.focus();
      e.preventDefault();
    } else if (e.key === 'ArrowRight' && index < 5) {
      inputRefs.current[index + 1]?.focus();
      e.preventDefault();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    if (isVerifying || isLocked || showSuccessFlash) return;
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (!pasted) return;

    setErrorMessage('');
    setRetryAction(null);

    const newDigits = ['', '', '', '', '', ''];
    for (let i = 0; i < pasted.length; i++) {
      newDigits[i] = pasted[i];
    }
    setDigits(newDigits);

    if (pasted.length === 6) {
      triggerVerifyOtp(pasted);
    } else {
      inputRefs.current[Math.min(pasted.length, 5)]?.focus();
    }
  };

  // Trigger verify strictly against server
  const triggerVerifyOtp = async (codeToVerify?: string) => {
    const fullCode = (codeToVerify || digits.join('')).trim();
    if (fullCode.length !== 6) {
      setErrorMessage(
        'সম্পূর্ণ ৬ সংখ্যার কোডটি লিখুন। (Please enter all 6 digits.)'
      );
      setRetryAction(null);
      return;
    }

    if (isLocked || attemptsLeft <= 0) {
      setIsLocked(true);
      setErrorMessage(
        'অতিরিক্ত ভুল চেষ্টার কারণে সাময়িকভাবে লক করা হয়েছে। অনুগ্রহ করে কিছুক্ষণ পর চেষ্টা করুন। (Temporarily locked due to too many wrong attempts.)'
      );
      setRetryAction(null);
      return;
    }

    lastSubmittedCodeRef.current = fullCode;
    triggerHaptic('medium');
    setIsVerifying(true);
    setErrorMessage('');
    setRetryAction(null);

    try {
      const res = await verifyEmailOtpCall(cleanEmail, fullCode);
      if (res.verified) {
        triggerHaptic('heavy');
        setHasWrongAttempt(false);
        setShowSuccessFlash(true);
        onVerifiedChange(true);

        if (successTimerRef.current) clearTimeout(successTimerRef.current);
        successTimerRef.current = setTimeout(
          () => {
            setShowSuccessFlash(false);
          },
          prefersReducedMotion ? 220 : 650
        );
      }
    } catch (err: any) {
      console.error('[OtpVerificationInput] Verify error:', err);
      const formatted = formatOtpErrorMessage(err);
      const nextAttempts =
        typeof err?.attemptsLeft === 'number'
          ? err.attemptsLeft
          : typeof formatted.attemptsLeft === 'number'
          ? formatted.attemptsLeft
          : undefined;

      if (formatted.isLocked || err?.isLocked || nextAttempts === 0) {
        setIsLocked(true);
        setAttemptsLeft(0);
        setHasWrongAttempt(true);
        setErrorMessage(formatted.message);
        setRetryAction(null);
        setIsShaking(true);
        triggerHaptic('heavy');
        if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
        shakeTimerRef.current = setTimeout(() => {
          setIsShaking(false);
        }, prefersReducedMotion ? 150 : 520);
      } else if (formatted.isWrongCode) {
        setHasWrongAttempt(true);
        setAttemptsLeft((prev) =>
          typeof nextAttempts === 'number' ? nextAttempts : Math.max(0, prev - 1)
        );
        setErrorMessage('');
        setRetryAction(null);

        setIsShaking(true);
        triggerHaptic('heavy');
        if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
        shakeTimerRef.current = setTimeout(() => {
          setIsShaking(false);
          setDigits(['', '', '', '', '', '']);
          inputRefs.current[0]?.focus();
        }, prefersReducedMotion ? 150 : 550);
      } else {
        setErrorMessage(formatted.message);
        if (
          formatted.code === 'network' ||
          formatted.code === 'internal' ||
          formatted.code === 'unavailable'
        ) {
          setRetryAction('verify');
        } else {
          setRetryAction(null);
        }
      }

      onVerifiedChange(false);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleChangeEmailClick = () => {
    if (disabled || isResubmit) return;
    if (successTimerRef.current) clearTimeout(successTimerRef.current);
    setShowSuccessFlash(false);
    setIsEditingEmail(true);
    setCodeSent(false);
    setDigits(['', '', '', '', '', '']);
    setHasWrongAttempt(false);
    setIsLocked(false);
    setErrorMessage('');
    setRetryAction(null);
    onVerifiedChange(false);

    setTimeout(() => {
      emailInputRef.current?.focus();
      scrollTargetIntoView(emailInputRef.current);
    }, 60);
  };

  const handleRetry = () => {
    if (retryAction === 'verify' && lastSubmittedCodeRef.current.length === 6) {
      triggerVerifyOtp(lastSubmittedCodeRef.current);
    } else {
      handleSendOtp();
    }
  };

  // Collapsed compact verified state (after the green check flash completes)
  if (isVerified && !showSuccessFlash) {
    return (
      <motion.div
        initial={prefersReducedMotion ? false : { opacity: 0, y: -4 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: prefersReducedMotion ? 0 : 0.22 }}
        className="p-3.5 sm:p-4 rounded-2xl bg-emerald-500/[0.09] backdrop-blur-[24px] border border-[#3DD055]/35"
      >
        <div className="flex items-center justify-between gap-2.5 flex-wrap">
          <div className="flex items-center gap-2.5 min-w-0">
            <motion.div
              initial={prefersReducedMotion ? false : { scale: 0.7 }}
              animate={{ scale: 1 }}
              transition={{ duration: prefersReducedMotion ? 0 : 0.2 }}
              className="w-8 h-8 rounded-xl bg-[#3DD055]/20 border border-[#3DD055]/40 flex items-center justify-center shrink-0"
            >
              <CheckCircle2 className="w-4 h-4 text-[#3DD055]" />
            </motion.div>
            <div className="min-w-0">
              <div className="text-[12.5px] font-bold text-[#3DD055] flex items-center gap-1.5 leading-snug">
                <span>Email verified (ইমেইল যাচাই হয়েছে)</span>
              </div>
              <p className="text-[12px] text-slate-200 font-medium truncate">
                {email}
              </p>
            </div>
          </div>

          {!isResubmit && !disabled && (
            <button
              type="button"
              onClick={handleChangeEmailClick}
              className="min-h-[36px] px-2.5 rounded-lg text-[11.5px] font-semibold text-slate-200 hover:text-white hover:bg-white/10 border border-white/15 transition-colors flex items-center gap-1 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E9AA7]"
            >
              <Edit2 className="w-3 h-3 text-[#0E9AA7]" />
              <span>Change email (পরিবর্তন)</span>
            </button>
          )}
        </div>
      </motion.div>
    );
  }

  const emailStatus = showSuccessFlash
    ? 'verified'
    : codeSent && !isEditingEmail
    ? 'sent'
    : 'unverified';

  const isEmailInputLocked =
    disabled || isResubmit || showSuccessFlash || (codeSent && !isEditingEmail);

  return (
    <motion.div
      animate={
        shakeField && !prefersReducedMotion
          ? { x: [0, -6, 6, -4, 4, 0] }
          : undefined
      }
      transition={{ duration: 0.36 }}
      className="p-3 sm:p-4 rounded-2xl bg-white/[0.06] backdrop-blur-[24px] border border-white/15 space-y-3"
    >
      {/* 1. Email Address Field - Own Full-Width Row */}
      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <label
            htmlFor={emailInputId}
            className="text-[12px] font-bold text-slate-200 flex items-center gap-1.5"
          >
            <Mail className="w-3.5 h-3.5 text-[#0E9AA7] shrink-0" />
            <span>Email Address (ইমেইল ঠিকানা)</span>
            <span className="text-[#3DD055]" aria-hidden="true">
              *
            </span>
          </label>

          {codeSent && !isEditingEmail && !isResubmit && !disabled && !showSuccessFlash && (
            <button
              type="button"
              onClick={handleChangeEmailClick}
              className="min-h-[32px] px-2 rounded-lg text-[11px] font-bold text-[#0E9AA7] hover:text-[#3DD055] hover:bg-white/[0.06] flex items-center gap-1 cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E9AA7]"
            >
              <Edit2 className="w-3 h-3" />
              <span>Change email (পরিবর্তন)</span>
            </button>
          )}
        </div>

        <input
          ref={emailInputRef}
          id={emailInputId}
          type="email"
          autoComplete="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          disabled={isEmailInputLocked}
          placeholder="e.g. reseller@gmail.com"
          value={email}
          onFocus={(e) => {
            scrollTargetIntoView(e.currentTarget);
            onFocus?.();
          }}
          onChange={(e) => {
            const nextVal = e.target.value;
            onEmailChange?.(nextVal);
            if (isVerified) {
              onVerifiedChange(false);
            }
            if (codeSent) {
              setCodeSent(false);
              setDigits(['', '', '', '', '', '']);
              setHasWrongAttempt(false);
              setIsLocked(false);
            }
            setErrorMessage('');
            setRetryAction(null);
          }}
          className={`w-full h-[46px] px-3.5 rounded-xl text-[14px] sm:text-[15px] font-semibold outline-none transition-all focus-visible:ring-2 focus-visible:ring-[#0E9AA7] ${
            isEmailInputLocked
              ? 'bg-white/[0.04] border border-white/10 text-slate-300 cursor-not-allowed'
              : 'bg-white/[0.08] border border-white/20 text-white placeholder-slate-400 focus:border-[#0E9AA7] focus:ring-2 focus:ring-[#0E9AA7]/40'
          }`}
        />

        {/* Compact Status Line Directly Under Email Field */}
        <div className="flex items-center justify-between gap-2 px-0.5 text-[11.5px] font-semibold">
          {emailStatus === 'verified' ? (
            <span className="text-[#3DD055] flex items-center gap-1.5">
              <CheckCircle2 className="w-3.5 h-3.5 text-[#3DD055] shrink-0" />
              <span>Verified (যাচাই সম্পন্ন)</span>
            </span>
          ) : emailStatus === 'sent' ? (
            <span className="text-[#0E9AA7] flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-[#0E9AA7] shrink-0" />
              <span>Code sent (কোড পাঠানো হয়েছে)</span>
            </span>
          ) : (
            <span className="text-slate-400">
              Not verified (যাচাই করা হয়নি)
            </span>
          )}
        </div>

        {/* Separate Full-Width Send Code Button Below Field (36-44px height) */}
        {(!codeSent || isEditingEmail) && !showSuccessFlash && (
          <button
            type="button"
            disabled={isSending || disabled || !isEmailValid || isSameEmailCooldown}
            onClick={handleSendOtp}
            className={`w-full h-[42px] mt-1 rounded-xl text-[13px] font-bold transition-all flex items-center justify-center gap-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3DD055] ${
              isSending || disabled || !isEmailValid || isSameEmailCooldown
                ? 'bg-white/[0.08] border border-white/10 text-slate-400 cursor-not-allowed'
                : 'bg-gradient-to-r from-[#0E9AA7] to-[#3DD055] text-white hover:brightness-110 active:scale-[0.99] cursor-pointer shadow-sm'
            }`}
          >
            {isSending ? (
              <>
                <RotateCw className="w-4 h-4 animate-spin" />
                <span>Sending code... (কোড পাঠানো হচ্ছে...)</span>
              </>
            ) : (
              <span>
                {isSameEmailCooldown
                  ? `Wait ${formatTimer(cooldown)} to resend`
                  : 'Send code (কোড পাঠান)'}
              </span>
            )}
          </button>
        )}
      </div>

      {/* 2. Inline OTP Step (Smooth Slide-Down) */}
      <AnimatePresence initial={false}>
        {(codeSent && (!isVerified || showSuccessFlash)) && (
          <motion.div
            key="otp-panel"
            initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, height: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.24, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="pt-2 border-t border-white/10 space-y-3">
              {/* Short Privacy-Preserving Instruction */}
              <div className="space-y-0.5 text-[12px] leading-relaxed">
                <p className="text-slate-200 font-medium">
                  We sent a 6-digit code to{' '}
                  <span className="font-mono font-bold text-[#3DD055] break-all">
                    {maskEmail(cleanEmail)}
                  </span>
                  . Check Spam/Junk if you do not see it.
                </p>
                <p className="text-[11px] text-slate-400">
                  ইমেইলের ইনবক্স বা Spam/Junk ফোল্ডারে পাঠানো ৬ সংখ্যার কোডটি নিচে লিখুন।
                </p>
              </div>

              {/* 6 Separate Digit Boxes */}
              <motion.div
                role="group"
                aria-labelledby={otpGroupId}
                animate={
                  isShaking && !prefersReducedMotion
                    ? { x: [0, -7, 7, -5, 5, -2, 2, 0] }
                    : { x: 0 }
                }
                transition={{ duration: 0.42 }}
                className="flex items-center justify-center gap-1.5 sm:gap-2 py-0.5"
              >
                <span id={otpGroupId} className="sr-only">
                  6-digit email verification code
                </span>
                {digits.map((digit, idx) => {
                  const boxDisabled = isVerifying || isLocked || showSuccessFlash;
                  return (
                    <input
                      key={idx}
                      ref={(el) => {
                        inputRefs.current[idx] = el;
                      }}
                      type="text"
                      inputMode="numeric"
                      autoComplete={idx === 0 ? 'one-time-code' : 'off'}
                      pattern="[0-9]*"
                      aria-label={`Digit ${idx + 1} of 6`}
                      value={digit}
                      onFocus={(e) => {
                        e.currentTarget.select();
                        scrollTargetIntoView(e.currentTarget);
                      }}
                      onChange={(e) => handleDigitChange(idx, e.target.value)}
                      onKeyDown={(e) => handleKeyDown(idx, e)}
                      onPaste={handlePaste}
                      disabled={boxDisabled}
                      className={`w-[42px] max-[359px]:w-[calc((100%-25px)/6)] h-[52px] sm:w-[48px] sm:h-[56px] rounded-xl text-center text-[20px] font-black outline-none transition-colors tabular-nums shrink-0 ${
                        showSuccessFlash
                          ? 'border-2 border-[#3DD055] bg-[#3DD055]/20 text-[#3DD055]'
                          : isShaking || (hasWrongAttempt && isLocked)
                          ? 'border-2 border-rose-500 bg-rose-500/20 text-rose-200'
                          : digit
                          ? 'border-2 border-[#0E9AA7] bg-white/[0.12] text-white focus:border-[#0E9AA7] focus:ring-2 focus:ring-[#0E9AA7]/45'
                          : 'border border-white/20 bg-white/[0.08] text-white focus:border-[#0E9AA7] focus:ring-2 focus:ring-[#0E9AA7]/45'
                      } ${boxDisabled && !showSuccessFlash ? 'opacity-65 cursor-not-allowed' : ''}`}
                    />
                  );
                })}
              </motion.div>

              {/* Wrong-Code Attempts Remaining (Shown ONLY After a Wrong Code) */}
              {hasWrongAttempt && !isLocked && !showSuccessFlash && (
                <div
                  role="alert"
                  className="text-center text-[12px] font-semibold text-rose-300"
                >
                  Wrong code, {attemptsLeft} {attemptsLeft === 1 ? 'attempt' : 'attempts'} left
                  <span className="block text-[11px] text-rose-300/90">
                    ভুল কোড, আর {attemptsLeft} বার চেষ্টা করা যাবে
                  </span>
                </div>
              )}

              {/* Success Check Flash Message */}
              {showSuccessFlash && (
                <motion.div
                  initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.94 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="flex items-center justify-center gap-2 text-[12.5px] font-bold text-[#3DD055]"
                >
                  <CheckCircle2 className="w-4 h-4 text-[#3DD055]" />
                  <span>Verified! (যাচাই সম্পন্ন হয়েছে!)</span>
                </motion.div>
              )}

              {/* Timers Row: Resend m:ss & Expiration m:ss */}
              {!showSuccessFlash && (
                <div className="flex items-center justify-between gap-2 flex-wrap text-[11.5px] text-slate-300 px-0.5 tabular-nums">
                  <div>
                    {cooldown > 0 ? (
                      <span className="text-slate-400 font-medium">
                        Resend code in <span className="text-slate-200 font-semibold">{formatTimer(cooldown)}</span>
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={handleSendOtp}
                        disabled={isSending || isLocked}
                        className="min-h-[36px] px-1 font-bold text-[#0E9AA7] hover:text-[#3DD055] underline underline-offset-2 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0E9AA7] rounded"
                      >
                        Resend code (আবার পাঠান)
                      </button>
                    )}
                  </div>

                  <div className="text-slate-300 font-medium">
                    Code expires in{' '}
                    <span className={`font-bold ${expiresIn <= 60 ? 'text-amber-300' : 'text-white'}`}>
                      {formatTimer(expiresIn)}
                    </span>
                  </div>
                </div>
              )}

              {/* Full-Width Verify Button (36-44px height) */}
              {!showSuccessFlash && (
                <button
                  type="button"
                  disabled={isVerifying || isLocked || expiresIn <= 0 || digits.join('').length !== 6}
                  onClick={() => triggerVerifyOtp()}
                  className="w-full h-[42px] rounded-xl text-[13px] font-bold text-white bg-gradient-to-r from-[#0E9AA7] to-[#3DD055] hover:brightness-110 active:scale-[0.99] disabled:opacity-40 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 cursor-pointer shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3DD055]"
                >
                  {isVerifying ? (
                    <>
                      <RotateCw className="w-4 h-4 animate-spin" />
                      <span>Verifying... (যাচাই হচ্ছে...)</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-4 h-4" />
                      <span>Verify (যাচাই করুন)</span>
                    </>
                  )}
                </button>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Lockout Notice (visible regardless of whether codeSent is true or false) */}
      {isLocked && (
        <div
          role="alert"
          className="p-2.5 rounded-xl bg-rose-500/15 border border-rose-500/35 text-rose-200 text-[11.5px] font-medium flex items-start gap-2"
        >
          <Lock className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>
            অতিরিক্ত ভুল চেষ্টার কারণে সাময়িকভাবে লক করা হয়েছে। অনুগ্রহ করে ১৫ মিনিট পর আবার চেষ্টা করুন। (Too many wrong attempts. Locked for 15 minutes.)
          </span>
        </div>
      )}

      {/* Friendly Network / Server Error Feedback with Retry */}
      <AnimatePresence>
        {errorMessage && !isLocked && (
          <motion.div
            role="alert"
            initial={prefersReducedMotion ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.18 }}
            className="p-2.5 rounded-xl bg-rose-500/15 border border-rose-500/35 text-rose-200 text-[11.5px] font-medium flex items-center justify-between gap-2.5 flex-wrap"
          >
            <div className="flex items-start gap-2 flex-1 min-w-[180px]">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span className="leading-snug">{errorMessage}</span>
            </div>

            {retryAction && (
              <button
                type="button"
                disabled={isSending || isVerifying}
                onClick={handleRetry}
                className="min-h-[36px] px-3 rounded-lg bg-rose-500/25 hover:bg-rose-500/35 border border-rose-400/40 text-white text-[11.5px] font-bold flex items-center gap-1.5 cursor-pointer transition-colors shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Retry (আবার চেষ্টা করুন)</span>
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
};
