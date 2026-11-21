import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Building2,
  CheckCircle2,
  ChevronRight,
  Clock,
  CreditCard,
  Edit3,
  Eye,
  EyeOff,
  Headphones,
  History,
  Lock,
  Plus,
  RefreshCw,
  ShieldCheck,
  Star,
  Trash2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ChangeRequest, PayoutMethod, UserProfile } from '../../types';
import { triggerHaptic } from '../../lib/nativeFeedback';
import { useScrollToTop } from '../../utils/scrollToTop';
import { PageHeader } from '../common/PageHeader';
import { ChangeRequestModal } from '../common/ChangeRequestModal';
import {
  PayoutHistoryEntry,
  PayoutPrefillConfig,
  fetchUserPayoutHistory,
  isPayoutMethodPending,
  maskSensitiveValue,
} from '../../lib/lockedFieldsService';

export type PayoutFocusTarget = 'accounts' | 'default' | 'add' | 'verification' | 'history';

interface PayoutSettingsSectionProps {
  user: UserProfile;
  canAccessFullApp?: boolean;
  onOpenLockedModal?: (featureName?: string) => void;
  onRefreshUser?: () => void;
  onBack?: () => void;
  onContactSupport?: () => void;
  hideHeader?: boolean;
  initialFocusTarget?: PayoutFocusTarget | null;
  onConsumeFocusTarget?: () => void;
}

type PayoutType = 'bKash' | 'Nagad' | 'Rocket' | 'Upay' | 'Bank';
type HistoryFilter = 'all' | 'pending' | 'approved' | 'rejected';

const METHOD_CONFIG: Record<
  PayoutType,
  { initial: string; bg: string; text: string; border: string; label: string; ruleHint: string }
> = {
  bKash: {
    initial: 'bK',
    bg: 'bg-pink-50',
    text: 'text-pink-700',
    border: 'border-pink-200/80',
    label: 'bKash',
    ruleHint: 'Requires valid 11-digit BD number (01[3-9]XXXXXXXX).',
  },
  Nagad: {
    initial: 'NG',
    bg: 'bg-orange-50',
    text: 'text-orange-700',
    border: 'border-orange-200/80',
    label: 'Nagad',
    ruleHint: 'Requires valid 11-digit BD number (01[3-9]XXXXXXXX).',
  },
  Rocket: {
    initial: 'RK',
    bg: 'bg-purple-50',
    text: 'text-purple-700',
    border: 'border-purple-200/80',
    label: 'Rocket',
    ruleHint: 'Requires valid 11-digit BD number (01[3-9]XXXXXXXX).',
  },
  Upay: {
    initial: 'UP',
    bg: 'bg-sky-50',
    text: 'text-sky-700',
    border: 'border-sky-200/80',
    label: 'Upay',
    ruleHint: 'Requires valid 11-digit BD number (01[3-9]XXXXXXXX).',
  },
  Bank: {
    initial: 'BK',
    bg: 'bg-blue-50',
    text: 'text-blue-700',
    border: 'border-blue-200/80',
    label: 'Bank',
    ruleHint: 'Requires account number, bank name, and account holder name.',
  },
};

const HISTORY_PAGE_SIZE = 5;

function normalizeLegacyPayoutType(raw?: string | null): PayoutType {
  const lower = String(raw || '').trim().toLowerCase();
  if (lower === 'bkash') return 'bKash';
  if (lower === 'nagad') return 'Nagad';
  if (lower === 'rocket') return 'Rocket';
  if (lower === 'upay') return 'Upay';
  return 'Bank';
}

function formatShortDate(val: any): string {
  if (!val) return 'On file';
  try {
    const d =
      typeof val.toDate === 'function'
        ? val.toDate()
        : val.seconds
        ? new Date(val.seconds * 1000)
        : new Date(val);
    if (Number.isNaN(d.getTime())) return 'On file';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    }).format(d);
  } catch {
    return 'On file';
  }
}

export const PayoutSettingsSection: React.FC<PayoutSettingsSectionProps> = ({
  user,
  canAccessFullApp = true,
  onOpenLockedModal,
  onRefreshUser,
  onBack,
  onContactSupport,
  hideHeader = false,
  initialFocusTarget = null,
  onConsumeFocusTarget,
}) => {
  const shouldReduceMotion = useReducedMotion();
  useScrollToTop([]);

  const accountsRef = useRef<HTMLDivElement>(null);
  const defaultRef = useRef<HTMLDivElement>(null);
  const verificationRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);

  const [toastMessage, setToastMessage] = useState<{
    text: string;
    type: 'success' | 'error' | 'info';
  } | null>(null);
  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});
  const [selectedMethodId, setSelectedMethodId] = useState<string | null>(null);

  // Change Request modal state
  const [isChangeModalOpen, setIsChangeModalOpen] = useState(false);
  const [payoutPrefill, setPayoutPrefill] = useState<PayoutPrefillConfig | null>(null);

  // History + pending requests state
  const [historyEntries, setHistoryEntries] = useState<PayoutHistoryEntry[]>([]);
  const [pendingUnified, setPendingUnified] = useState<ChangeRequest[]>([]);
  const [pendingLegacy, setPendingLegacy] = useState<any[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all');
  const [visibleHistoryCount, setVisibleHistoryCount] = useState(HISTORY_PAGE_SIZE);

  const isRestricted = !canAccessFullApp || user.status === 'pending';

  // Normalize payout methods list (safe read-only fallback if only legacy single fields exist)
  const payoutMethods: PayoutMethod[] = useMemo(() => {
    if (Array.isArray(user.payoutMethods) && user.payoutMethods.length > 0) {
      return user.payoutMethods;
    }
    if (user.accountNumber) {
      const legacyType = normalizeLegacyPayoutType(user.payoutMethod);
      return [
        {
          id: 'legacy_primary',
          type: legacyType,
          accountNumber: user.accountNumber,
          accountHolderName: user.accountHolderName || user.fullName || '',
          bankName: legacyType === 'Bank' ? user.bankName || null : null,
          branchName: legacyType === 'Bank' ? user.branchName || null : null,
          routingNumber: legacyType === 'Bank' ? user.routingNumber || null : null,
          isDefault: true,
          verified: user.status === 'approved',
          payoutVerified: user.status === 'approved' ? 'verified' : 'pending',
          addedAt: user.createdAt,
        },
      ];
    }
    return [];
  }, [user]);

  const defaultMethod = useMemo(
    () => payoutMethods.find((m) => m.isDefault) || payoutMethods[0] || null,
    [payoutMethods]
  );

  const selectedMethod = useMemo(
    () => payoutMethods.find((m) => m.id === selectedMethodId) || null,
    [payoutMethods, selectedMethodId]
  );

  const showToast = useCallback(
    (text: string, type: 'success' | 'error' | 'info' = 'success') => {
      setToastMessage({ text, type });
      window.setTimeout(() => setToastMessage(null), 4000);
    },
    []
  );

  const loadPayoutHistory = useCallback(async () => {
    if (!user?.uid) {
      setLoadingHistory(false);
      return;
    }
    setLoadingHistory(true);
    setHistoryError(null);
    try {
      const res = await fetchUserPayoutHistory(user.uid, user.role);
      setHistoryEntries(res.entries);
      setPendingUnified(res.pendingUnified);
      setPendingLegacy(res.pendingLegacy);
    } catch (err: any) {
      setHistoryError(err?.message || 'Unable to load payout change history.');
    } finally {
      setLoadingHistory(false);
    }
  }, [user?.uid, user?.role]);

  useEffect(() => {
    loadPayoutHistory();
  }, [loadPayoutHistory]);

  const openChangeRequestWith = useCallback(
    (config: PayoutPrefillConfig) => {
      triggerHaptic('light');
      if (isRestricted) {
        if (onOpenLockedModal) onOpenLockedModal('Payout Settings');
        else showToast('Payout actions unlock after reseller approval.', 'error');
        return;
      }
      setSelectedMethodId(null);
      setPayoutPrefill({ ...config, lockFieldSelector: true });
      setIsChangeModalOpen(true);
    },
    [isRestricted, onOpenLockedModal, showToast]
  );

  // Handle focus target deep-links from Account Hub search
  useEffect(() => {
    if (!initialFocusTarget) return;
    if (initialFocusTarget === 'add') {
      openChangeRequestWith({ mode: 'add', makeDefault: payoutMethods.length === 0 });
      onConsumeFocusTarget?.();
      return;
    }
    const targetRef =
      initialFocusTarget === 'default'
        ? defaultRef
        : initialFocusTarget === 'verification'
        ? verificationRef
        : initialFocusTarget === 'history'
        ? historyRef
        : accountsRef;
    if (targetRef.current) {
      targetRef.current.scrollIntoView({
        behavior: shouldReduceMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    }
    onConsumeFocusTarget?.();
  }, [
    initialFocusTarget,
    onConsumeFocusTarget,
    openChangeRequestWith,
    payoutMethods.length,
    shouldReduceMotion,
  ]);

  const handleToggleReveal = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    triggerHaptic('light');
    if (revealedIds[id]) {
      setRevealedIds((prev) => ({ ...prev, [id]: false }));
      return;
    }
    setRevealedIds((prev) => ({ ...prev, [id]: true }));
    window.setTimeout(() => {
      setRevealedIds((prev) => ({ ...prev, [id]: false }));
    }, 5000);
  };

  // Resolve per-method verification status + attribution (who verified & when)
  const getMethodVerificationMeta = useCallback(
    (pm: PayoutMethod) => {
      const pendingReq = isPayoutMethodPending(pm, pendingUnified, pendingLegacy);
      const isExplicitVerified = pm.payoutVerified === 'verified' || pm.verified === true;
      const isExplicitPending = pm.payoutVerified === 'pending' || Boolean(pendingReq);

      // Look up latest approved history entry for this method to surface who/when
      const approvedMatch = historyEntries.find(
        (h) =>
          h.status === 'approved' &&
          (h.targetPayoutId === pm.id ||
            (h.methodType &&
              h.methodType.toLowerCase() === pm.type.toLowerCase() &&
              h.accountNumber &&
              h.accountNumber.replace(/\D/g, '') === pm.accountNumber.replace(/\D/g, '')))
      );

      if (isExplicitVerified) {
        const verifiedBy =
          pm.verifiedBy || approvedMatch?.decidedBy || 'Super Admin';
        const verifiedWhen = pm.verifiedAt
          ? formatShortDate(pm.verifiedAt)
          : approvedMatch?.decidedAtLabel || formatShortDate(pm.addedAt || user.createdAt);
        return {
          status: 'verified' as const,
          label: 'Verified by admin',
          chipClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
          verifiedBy,
          verifiedWhen,
          pendingReq,
        };
      }

      if (isExplicitPending) {
        return {
          status: 'pending' as const,
          label: 'Pending',
          chipClass: 'bg-teal-50 text-[#0E9AA7] border-teal-200',
          verifiedBy: null,
          verifiedWhen: null,
          pendingReq,
        };
      }

      return {
        status: 'not_verified' as const,
        label: 'Not verified',
        chipClass: 'bg-slate-100 text-slate-600 border-slate-200',
        verifiedBy: null,
        verifiedWhen: null,
        pendingReq,
      };
    },
    [historyEntries, pendingLegacy, pendingUnified, user.createdAt]
  );

  // Overall verification summary
  const verificationSummary = useMemo(() => {
    if (payoutMethods.length === 0) {
      return {
        status: 'not_verified' as const,
        label: 'Not verified',
        chipClass: 'bg-slate-100 text-slate-600 border-slate-200',
        verifiedBy: null,
        verifiedWhen: null,
        needsAttention: true,
      };
    }

    const metas = payoutMethods.map((pm) => ({ pm, meta: getMethodVerificationMeta(pm) }));
    const defMeta = defaultMethod
      ? metas.find((m) => m.pm.id === defaultMethod.id)?.meta
      : metas[0]?.meta;
    const anyNotVerified = metas.some((m) => m.meta.status === 'not_verified');
    const anyPending = metas.some((m) => m.meta.status === 'pending');
    const verifiedOne = metas.find((m) => m.meta.status === 'verified')?.meta;

    if (defMeta?.status === 'verified' && !anyNotVerified && !anyPending) {
      return {
        status: 'verified' as const,
        label: 'Verified by admin',
        chipClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        verifiedBy: defMeta.verifiedBy,
        verifiedWhen: defMeta.verifiedWhen,
        needsAttention: false,
      };
    }

    if (anyPending && !anyNotVerified) {
      return {
        status: 'pending' as const,
        label: 'Pending',
        chipClass: 'bg-teal-50 text-[#0E9AA7] border-teal-200',
        verifiedBy: verifiedOne?.verifiedBy || null,
        verifiedWhen: verifiedOne?.verifiedWhen || null,
        needsAttention: true,
      };
    }

    return {
      status: verifiedOne ? ('pending' as const) : ('not_verified' as const),
      label: verifiedOne && anyPending ? 'Pending' : anyNotVerified ? 'Not verified' : 'Pending',
      chipClass: anyNotVerified
        ? 'bg-slate-100 text-slate-600 border-slate-200'
        : 'bg-teal-50 text-[#0E9AA7] border-teal-200',
      verifiedBy: verifiedOne?.verifiedBy || null,
      verifiedWhen: verifiedOne?.verifiedWhen || null,
      needsAttention: true,
    };
  }, [defaultMethod, getMethodVerificationMeta, payoutMethods]);

  const filteredHistory = useMemo(() => {
    if (historyFilter === 'all') return historyEntries;
    return historyEntries.filter((item) => item.status === historyFilter);
  }, [historyEntries, historyFilter]);

  const visibleHistory = useMemo(
    () => filteredHistory.slice(0, visibleHistoryCount),
    [filteredHistory, visibleHistoryCount]
  );

  const hasMoreHistory = visibleHistory.length < filteredHistory.length;

  const handleRequestChangeDefault = () => {
    if (payoutMethods.length === 0) {
      openChangeRequestWith({
        mode: 'add',
        makeDefault: true,
        reason: 'Request to add and set a default payout method',
      });
      return;
    }
    const nonDefault = payoutMethods.find(
      (pm) => !pm.isDefault && !isPayoutMethodPending(pm, pendingUnified, pendingLegacy)
    );
    if (nonDefault) {
      openChangeRequestWith({
        mode: 'set_default',
        targetPayoutId: nonDefault.id,
        makeDefault: true,
        reason: `Request to set ${nonDefault.type} (•••• ${nonDefault.accountNumber.slice(-4)}) as my default payout method`,
      });
      return;
    }
    if (payoutMethods.length >= 2) {
      showToast('A pending change request already targets your other payout account.', 'info');
      return;
    }
    openChangeRequestWith({
      mode: 'add',
      makeDefault: true,
      reason: 'Request to add another payout account and set it as default',
    });
  };

  return (
    <div className="space-y-3 min-h-0 max-w-2xl mx-auto">
      {/* Toast Notification */}
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: -10 }}
            className={`fixed top-4 left-4 right-4 z-[9999] max-w-sm mx-auto p-3 rounded-[12px] shadow-lg border text-[12px] font-semibold flex items-center gap-2 ${
              toastMessage.type === 'success'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : toastMessage.type === 'error'
                ? 'bg-rose-50 text-rose-800 border-rose-200'
                : 'bg-slate-900 text-white border-slate-700'
            }`}
          >
            {toastMessage.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            )}
            <span className="flex-1">{toastMessage.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Optional standalone header */}
      {!hideHeader && (
        <PageHeader
          title="Payout Settings"
          subtitle="Locked payout accounts managed by Super Admin"
          onBack={onBack}
        />
      )}

      {/* Compact Locked Policy Bar + Request to Add CTA */}
      <div className="rounded-[12px] bg-white/85 backdrop-blur-md border border-slate-200/80 px-3 py-2.5 flex flex-wrap items-center justify-between gap-2 shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-[#04203F] border border-slate-200/80 flex items-center justify-center shrink-0">
            <Lock className="w-4 h-4 text-[#0E9AA7]" />
          </div>
          <div className="min-w-0">
            <p className="text-[13px] font-bold text-[#04203F] leading-tight truncate">
              Payout Details Locked
            </p>
            <p className="text-[11px] text-slate-500 leading-tight truncate mt-0.5">
              Changes apply only after Super Admin review
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() =>
            openChangeRequestWith({
              mode: 'add',
              makeDefault: payoutMethods.length === 0,
              reason: 'Request to add a new payout account',
            })
          }
          className="h-9 px-3 rounded-[12px] bg-[#04203F] hover:bg-[#0E9AA7] text-white text-[12px] font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Request to add</span>
        </button>
      </div>

      {/* ==========================================
          1. REGISTERED PAYOUT ACCOUNTS
         ========================================== */}
      <section ref={accountsRef} className="space-y-1.5">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-[13px] font-bold text-[#04203F] tracking-tight">
            Registered Payout Accounts ({payoutMethods.length})
          </h3>
          <span className="text-[11px] text-slate-400 font-medium">Tap row for details</span>
        </div>

        {loadingHistory && payoutMethods.length === 0 ? (
          <div className="rounded-[12px] bg-white/85 backdrop-blur-md border border-slate-200/80 divide-y divide-slate-100 overflow-hidden">
            {[0, 1].map((idx) => (
              <div
                key={idx}
                className="min-h-[60px] px-3 py-2.5 flex items-center gap-2.5 animate-pulse motion-reduce:animate-none"
              >
                <div className="w-9 h-9 rounded-[10px] bg-slate-200 shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-32 bg-slate-200 rounded" />
                  <div className="h-3 w-44 bg-slate-100 rounded" />
                </div>
              </div>
            ))}
          </div>
        ) : payoutMethods.length === 0 ? (
          <div className="rounded-[12px] bg-white/85 backdrop-blur-md border border-slate-200/80 p-4 text-center space-y-2.5 shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
            <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-[#0E9AA7] border border-slate-200/80 flex items-center justify-center mx-auto">
              <CreditCard className="w-4 h-4" />
            </div>
            <div>
              <p className="text-[14px] font-semibold text-[#04203F]">No Payout Accounts Yet</p>
              <p className="text-[11.5px] text-slate-500 mt-0.5 max-w-xs mx-auto">
                Submit a request to have Super Admin register your bKash, Nagad, Rocket, Upay, or Bank account.
              </p>
            </div>
            <button
              type="button"
              onClick={() =>
                openChangeRequestWith({
                  mode: 'add',
                  makeDefault: true,
                  reason: 'Request to register my first payout account',
                })
              }
              className="h-9 px-4 rounded-[12px] bg-[#04203F] hover:bg-[#0E9AA7] text-white text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Request to add</span>
            </button>
          </div>
        ) : (
          <div className="rounded-[12px] bg-white/85 backdrop-blur-md border border-slate-200/80 divide-y divide-slate-100 overflow-hidden shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
            {payoutMethods.map((pm) => {
              const cfg = METHOD_CONFIG[pm.type] || METHOD_CONFIG.Bank;
              const isRevealed = Boolean(revealedIds[pm.id]);
              const vMeta = getMethodVerificationMeta(pm);
              const isMethodBlocked = Boolean(vMeta.pendingReq);
              const maskedNum = maskSensitiveValue(pm.accountNumber);

              return (
                <div
                  key={pm.id}
                  className="px-3 py-2.5 flex flex-col gap-2 hover:bg-slate-50/70 transition-colors"
                >
                  {/* Top row: clickable left detail trigger + sibling reveal trigger */}
                  <div className="min-h-[56px] flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('light');
                        setSelectedMethodId(pm.id);
                      }}
                      className="flex-1 min-w-0 flex items-center gap-2.5 text-left cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-[#0E9AA7]/40 rounded-[10px]"
                    >
                      {/* Logo-less brand monogram tile */}
                      <div
                        className={`w-9 h-9 rounded-[10px] border font-black text-[12px] tracking-tight flex items-center justify-center shrink-0 select-none ${cfg.bg} ${cfg.text} ${cfg.border}`}
                      >
                        {cfg.initial}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[14px] font-semibold text-[#04203F] leading-tight">
                            {cfg.label}
                          </span>
                          {pm.isDefault && (
                            <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-[6px] bg-[#04203F] text-white leading-none">
                              Default
                            </span>
                          )}
                          <span
                            className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-[6px] border leading-none inline-flex items-center gap-1 ${vMeta.chipClass}`}
                          >
                            {vMeta.status === 'verified' ? (
                              <CheckCircle2 className="w-2.5 h-2.5" />
                            ) : vMeta.status === 'pending' ? (
                              <Clock className="w-2.5 h-2.5" />
                            ) : (
                              <AlertCircle className="w-2.5 h-2.5" />
                            )}
                            <span>{vMeta.label}</span>
                          </span>
                        </div>

                        <p className="text-[11.5px] text-slate-600 truncate mt-0.5 leading-tight">
                          {pm.accountHolderName || user.fullName || 'Account Holder'}
                          {pm.type === 'Bank' && pm.bankName ? ` • ${pm.bankName}` : ''}
                        </p>

                        <p className="font-mono text-[11.5px] font-semibold text-slate-700 tabular-nums mt-0.5 leading-tight">
                          {isRevealed ? pm.accountNumber : maskedNum}
                        </p>
                      </div>
                    </button>

                    {/* Sibling controls: 5s number reveal + sheet Chevron */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={(e) => handleToggleReveal(pm.id, e)}
                        className="w-9 h-9 rounded-[10px] border border-slate-200/80 bg-white hover:bg-slate-50 text-slate-500 hover:text-[#04203F] flex items-center justify-center cursor-pointer transition-colors"
                        aria-label={isRevealed ? 'Hide full number' : 'Show full number for 5 seconds'}
                        title={isRevealed ? 'Hide number' : 'Show full number (5s)'}
                      >
                        {isRevealed ? (
                          <EyeOff className="w-3.5 h-3.5 text-[#0E9AA7]" />
                        ) : (
                          <Eye className="w-3.5 h-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          setSelectedMethodId(pm.id);
                        }}
                        className="w-8 h-9 rounded-[10px] text-slate-400 hover:text-[#04203F] hover:bg-slate-100 flex items-center justify-center cursor-pointer transition-colors"
                        aria-label={`View ${cfg.label} details`}
                      >
                        <ChevronRight className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Per-method Pending Blocker Notice */}
                  {isMethodBlocked && vMeta.pendingReq && (
                    <div className="px-2.5 py-1.5 rounded-[10px] bg-teal-50/80 border border-teal-200/80 text-[11px] text-[#04203F] flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5 text-[#0E9AA7] shrink-0" />
                      <span className="truncate">
                        Pending request{' '}
                        <span className="font-mono font-bold">
                          {vMeta.pendingReq.requestId || 'Active'}
                        </span>
                        {' — '}edit/removal locked until Super Admin reviews.
                      </span>
                    </div>
                  )}

                  {/* Row Actions: Request edit & Request removal */}
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={isMethodBlocked}
                      onClick={() =>
                        openChangeRequestWith({
                          mode: 'edit',
                          targetPayoutId: pm.id,
                          methodType: pm.type,
                          makeDefault: pm.isDefault,
                          reason: `Request to update my ${pm.type} (•••• ${pm.accountNumber.slice(-4)}) payout details`,
                        })
                      }
                      className="flex-1 h-9 px-2.5 rounded-[10px] border border-slate-200 bg-white hover:bg-slate-50 text-[#04203F] text-[11.5px] font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
                    >
                      <Edit3 className="w-3.5 h-3.5 text-[#0E9AA7]" />
                      <span>Request edit</span>
                    </button>
                    <button
                      type="button"
                      disabled={isMethodBlocked}
                      onClick={() =>
                        openChangeRequestWith({
                          mode: 'remove',
                          targetPayoutId: pm.id,
                          methodType: pm.type,
                          reason: '',
                        })
                      }
                      className="flex-1 h-9 px-2.5 rounded-[10px] border border-rose-200/80 bg-rose-50/50 hover:bg-rose-50 text-rose-700 text-[11.5px] font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Request removal</span>
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ==========================================
          2. DEFAULT PAYOUT METHOD
         ========================================== */}
      <section ref={defaultRef} className="space-y-1.5">
        <h3 className="text-[13px] font-bold text-[#04203F] tracking-tight px-1">
          Default Payout Method
        </h3>
        <div className="rounded-[12px] bg-white/85 backdrop-blur-md border border-slate-200/80 p-3 flex flex-wrap items-center justify-between gap-2.5 shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
          {defaultMethod ? (
            <>
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <div
                  className={`w-9 h-9 rounded-[10px] border font-black text-[12px] flex items-center justify-center shrink-0 ${
                    (METHOD_CONFIG[defaultMethod.type] || METHOD_CONFIG.Bank).bg
                  } ${(METHOD_CONFIG[defaultMethod.type] || METHOD_CONFIG.Bank).text} ${
                    (METHOD_CONFIG[defaultMethod.type] || METHOD_CONFIG.Bank).border
                  }`}
                >
                  {(METHOD_CONFIG[defaultMethod.type] || METHOD_CONFIG.Bank).initial}
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[14px] font-semibold text-[#04203F] truncate">
                      {defaultMethod.type} •{' '}
                      <span className="font-mono">
                        {maskSensitiveValue(defaultMethod.accountNumber)}
                      </span>
                    </span>
                    <Star className="w-3.5 h-3.5 text-[#0E9AA7] fill-[#0E9AA7] shrink-0" />
                  </div>
                  <p className="text-[11.5px] text-slate-500 truncate mt-0.5">
                    Used automatically for wallet withdrawal requests
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleRequestChangeDefault}
                className="h-9 px-3 rounded-[12px] border border-slate-200 bg-slate-50 hover:bg-slate-100 text-[#04203F] text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors shrink-0"
              >
                <Star className="w-3.5 h-3.5 text-[#0E9AA7]" />
                <span>Request to change default</span>
              </button>
            </>
          ) : (
            <div className="w-full flex flex-wrap items-center justify-between gap-2">
              <p className="text-[12px] text-slate-500">
                No default payout method assigned yet.
              </p>
              <button
                type="button"
                onClick={handleRequestChangeDefault}
                className="h-9 px-3 rounded-[12px] border border-slate-200 bg-slate-50 hover:bg-slate-100 text-[#04203F] text-[12px] font-semibold cursor-pointer"
              >
                Request to change default
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ==========================================
          3. PAYOUT ACCOUNT VERIFICATION
         ========================================== */}
      <section ref={verificationRef} className="space-y-1.5">
        <h3 className="text-[13px] font-bold text-[#04203F] tracking-tight px-1">
          Payout Account Verification
        </h3>
        <div className="rounded-[12px] bg-white/85 backdrop-blur-md border border-slate-200/80 p-3 space-y-2.5 shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 border border-slate-200/80 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-4 h-4 text-[#0E9AA7]" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[14px] font-semibold text-[#04203F]">
                    Verification Status
                  </span>
                  <span
                    className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-[6px] border ${verificationSummary.chipClass}`}
                  >
                    {verificationSummary.label}
                  </span>
                </div>
                {verificationSummary.verifiedBy ? (
                  <p className="text-[11.5px] text-slate-600 mt-0.5">
                    Verified by <span className="font-semibold text-[#04203F]">{verificationSummary.verifiedBy}</span>
                    {verificationSummary.verifiedWhen ? ` • ${verificationSummary.verifiedWhen}` : ''}
                  </p>
                ) : (
                  <p className="text-[11.5px] text-slate-500 mt-0.5">
                    Awaiting Super Admin verification check
                  </p>
                )}
              </div>
            </div>
          </div>

          {verificationSummary.needsAttention && (
            <div className="pt-2 border-t border-slate-100 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <p className="text-[11.5px] text-slate-600 leading-snug">
                Admin needs an active account registered under your matching NID/profile name (with optional wallet screenshot or bank leaf proof) to verify payouts.
              </p>
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  onContactSupport?.();
                }}
                className="h-9 px-3 rounded-[12px] border border-slate-200 bg-slate-50 hover:bg-slate-100 text-[#04203F] text-[12px] font-semibold inline-flex items-center justify-center gap-1.5 cursor-pointer shrink-0 transition-colors"
              >
                <Headphones className="w-3.5 h-3.5 text-[#0E9AA7]" />
                <span>Contact support</span>
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ==========================================
          4. PAYOUT ACCOUNT CHANGE HISTORY
         ========================================== */}
      <section ref={historyRef} className="space-y-1.5">
        <div className="flex items-center justify-between gap-2 px-1">
          <h3 className="text-[13px] font-bold text-[#04203F] tracking-tight flex items-center gap-1.5">
            <History className="w-3.5 h-3.5 text-[#0E9AA7]" />
            <span>Payout Change History</span>
          </h3>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              loadPayoutHistory();
            }}
            disabled={loadingHistory}
            className="h-7 px-2 rounded-[8px] text-[11px] font-semibold text-slate-600 hover:bg-slate-200/60 inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-3 h-3 ${loadingHistory ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>

        {/* Filter Bar */}
        <div className="grid grid-cols-4 gap-1 bg-slate-200/70 p-1 rounded-[12px]">
          {(
            [
              { id: 'all', label: 'All' },
              { id: 'pending', label: 'Pending' },
              { id: 'approved', label: 'Approved' },
              { id: 'rejected', label: 'Rejected' },
            ] as const
          ).map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => {
                triggerHaptic('light');
                setHistoryFilter(f.id);
                setVisibleHistoryCount(HISTORY_PAGE_SIZE);
              }}
              className={`h-8 rounded-[9px] text-[11.5px] font-semibold cursor-pointer transition-colors ${
                historyFilter === f.id
                  ? 'bg-white text-[#04203F] shadow-2xs'
                  : 'text-slate-600 hover:text-[#04203F]'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Timeline Content */}
        {loadingHistory ? (
          <div className="rounded-[12px] bg-white/85 backdrop-blur-md border border-slate-200/80 divide-y divide-slate-100 overflow-hidden">
            {[0, 1, 2].map((idx) => (
              <div
                key={idx}
                className="p-3 space-y-1.5 animate-pulse motion-reduce:animate-none"
              >
                <div className="flex justify-between">
                  <div className="h-3 w-24 bg-slate-200 rounded" />
                  <div className="h-4 w-16 bg-slate-100 rounded" />
                </div>
                <div className="h-3.5 w-48 bg-slate-200 rounded" />
                <div className="h-3 w-40 bg-slate-100 rounded" />
              </div>
            ))}
          </div>
        ) : historyError ? (
          <div className="rounded-[12px] bg-white/85 backdrop-blur-md border border-rose-200 p-4 text-center space-y-2">
            <p className="text-[12.5px] font-semibold text-rose-700">{historyError}</p>
            <button
              type="button"
              onClick={loadPayoutHistory}
              className="h-9 px-3.5 rounded-[12px] bg-rose-50 hover:bg-rose-100 text-rose-700 text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Retry</span>
            </button>
          </div>
        ) : visibleHistory.length === 0 ? (
          <div className="rounded-[12px] bg-white/85 backdrop-blur-md border border-slate-200/80 p-4 text-center space-y-1">
            <p className="text-[13px] font-semibold text-[#04203F]">
              {historyFilter === 'all'
                ? 'No payout change history yet'
                : `No ${historyFilter} payout requests`}
            </p>
            <p className="text-[11.5px] text-slate-500">
              All payout add, edit, default switch, and removal requests appear here.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="rounded-[12px] bg-white/85 backdrop-blur-md border border-slate-200/80 divide-y divide-slate-100 overflow-hidden shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
              {visibleHistory.map((item) => {
                const statusBadge =
                  item.status === 'approved'
                    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    : item.status === 'rejected'
                    ? 'bg-rose-50 text-rose-700 border-rose-200'
                    : item.status === 'cancelled'
                    ? 'bg-slate-100 text-slate-500 border-slate-200'
                    : 'bg-teal-50 text-[#0E9AA7] border-teal-200';
                const statusLabel =
                  item.status === 'approved'
                    ? 'Approved'
                    : item.status === 'rejected'
                    ? 'Rejected'
                    : item.status === 'cancelled'
                    ? 'Cancelled'
                    : 'Pending';

                return (
                  <div key={item.id} className="px-3 py-2.5 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] text-slate-500 font-medium">
                        {item.dateLabel} •{' '}
                        <span className="font-mono text-slate-600">{item.requestId}</span>
                      </span>
                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-[6px] border shrink-0 ${statusBadge}`}
                      >
                        {statusLabel}
                      </span>
                    </div>
                    <p className="text-[13px] font-semibold text-[#04203F] leading-snug">
                      {item.whatChanged}
                    </p>
                    {item.oldValueMasked && item.oldValueMasked !== 'No payout method' && (
                      <p className="text-[11px] text-slate-500">
                        Previous: <span className="font-mono">{item.oldValueMasked}</span>
                      </p>
                    )}
                    {item.adminResponse ? (
                      <p
                        className={`text-[11.5px] leading-snug ${
                          item.status === 'rejected' ? 'text-rose-700' : 'text-slate-600'
                        }`}
                      >
                        Admin response: {item.adminResponse}
                      </p>
                    ) : (
                      item.status === 'pending' && (
                        <p className="text-[11px] text-slate-500">
                          Awaiting Super Admin review
                        </p>
                      )
                    )}
                  </div>
                );
              })}
            </div>

            {hasMoreHistory && (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  setVisibleHistoryCount((c) => c + HISTORY_PAGE_SIZE);
                }}
                className="w-full h-9 rounded-[12px] border border-slate-200 bg-white/85 hover:bg-slate-50 text-[#04203F] text-[12px] font-semibold cursor-pointer transition-colors"
              >
                Load more ({filteredHistory.length - visibleHistory.length} remaining)
              </button>
            )}
          </div>
        )}
      </section>

      {/* ==========================================
          5. WITHDRAWAL & PROCESSING RULES
         ========================================== */}
      <section className="space-y-1.5 pt-0.5">
        <h3 className="text-[13px] font-bold text-[#04203F] tracking-tight px-1">
          Withdrawal & Processing Rules
        </h3>
        <div className="rounded-[12px] bg-white/85 backdrop-blur-md border border-slate-200/80 px-3 py-2.5 space-y-2 text-[12px] text-slate-600 shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
          <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
            <span className="text-slate-500">Minimum Withdrawal</span>
            <span className="font-mono font-bold text-[#04203F]">৳500 BDT</span>
          </div>
          <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
            <span className="text-slate-500">Processing Turnaround</span>
            <span className="font-semibold text-emerald-700">24 – 48 Hours</span>
          </div>
          <div className="flex items-center justify-between border-b border-slate-100 pb-1.5">
            <span className="text-slate-500">Mobile Wallets</span>
            <span className="font-semibold text-[#0E9AA7]">bKash, Nagad, Rocket, Upay</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-500">Bank Transfer</span>
            <span className="font-medium text-slate-700">BEFTN / NPSB Routing</span>
          </div>
        </div>
      </section>

      {/* ==========================================
          SPECIFIC METHOD DETAIL SHEET (bKash / Nagad / Rocket / Upay / Bank)
         ========================================== */}
      <AnimatePresence>
        {selectedMethod && (
          <div
            className="fixed inset-0 z-[65] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/60 backdrop-blur-xs"
            onClick={() => setSelectedMethodId(null)}
          >
            <motion.div
              initial={shouldReduceMotion ? { opacity: 1 } : { opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              exit={shouldReduceMotion ? { opacity: 0 } : { opacity: 0, y: 18 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md bg-white rounded-t-[16px] sm:rounded-[14px] border border-slate-200 shadow-2xl overflow-hidden pb-[env(safe-area-inset-bottom,0px)]"
            >
              {(() => {
                const cfg = METHOD_CONFIG[selectedMethod.type] || METHOD_CONFIG.Bank;
                const vMeta = getMethodVerificationMeta(selectedMethod);
                const isRevealed = Boolean(revealedIds[selectedMethod.id]);
                const isBlocked = Boolean(vMeta.pendingReq);

                return (
                  <div className="p-4 space-y-3">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div
                          className={`w-10 h-10 rounded-[10px] border font-black text-[13px] flex items-center justify-center shrink-0 ${cfg.bg} ${cfg.text} ${cfg.border}`}
                        >
                          {cfg.initial}
                        </div>
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <h4 className="text-[15px] font-bold text-[#04203F]">
                              {cfg.label} Account
                            </h4>
                            {selectedMethod.isDefault && (
                              <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-[6px] bg-[#04203F] text-white">
                                Default
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-slate-500">{cfg.ruleHint}</p>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => setSelectedMethodId(null)}
                        className="w-8 h-8 rounded-[10px] text-slate-400 hover:text-slate-700 hover:bg-slate-100 flex items-center justify-center cursor-pointer shrink-0"
                        aria-label="Close details"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="rounded-[12px] bg-slate-50 border border-slate-200/80 p-3 space-y-2 text-[12px]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">Holder Name</span>
                        <span className="font-semibold text-[#04203F] text-right">
                          {selectedMethod.accountHolderName || user.fullName || 'Account Holder'}
                        </span>
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">Account Number</span>
                        <div className="flex items-center gap-1.5">
                          <span className="font-mono font-bold text-[#04203F] tabular-nums">
                            {isRevealed
                              ? selectedMethod.accountNumber
                              : maskSensitiveValue(selectedMethod.accountNumber)}
                          </span>
                          <button
                            type="button"
                            onClick={(e) => handleToggleReveal(selectedMethod.id, e)}
                            className="p-1 rounded text-slate-400 hover:text-[#04203F] cursor-pointer"
                            aria-label={isRevealed ? 'Hide number' : 'Reveal number'}
                          >
                            {isRevealed ? (
                              <EyeOff className="w-3.5 h-3.5 text-[#0E9AA7]" />
                            ) : (
                              <Eye className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      </div>

                      {selectedMethod.type === 'Bank' && (
                        <>
                          <div className="flex items-center justify-between gap-2">
                            <span className="text-slate-500 flex items-center gap-1">
                              <Building2 className="w-3 h-3" />
                              <span>Bank Name</span>
                            </span>
                            <span className="font-semibold text-[#04203F] text-right">
                              {selectedMethod.bankName || 'Not specified'}
                            </span>
                          </div>
                          {selectedMethod.branchName && (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-slate-500">Branch</span>
                              <span className="font-medium text-slate-700 text-right">
                                {selectedMethod.branchName}
                              </span>
                            </div>
                          )}
                          {selectedMethod.routingNumber && (
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-slate-500">Routing No</span>
                              <span className="font-mono font-medium text-slate-700">
                                {selectedMethod.routingNumber}
                              </span>
                            </div>
                          )}
                        </>
                      )}

                      <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-200/70">
                        <span className="text-slate-500">Verification</span>
                        <span
                          className={`text-[10.5px] font-semibold px-2 py-0.5 rounded-[6px] border ${vMeta.chipClass}`}
                        >
                          {vMeta.label}
                        </span>
                      </div>

                      {vMeta.verifiedBy && (
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-slate-500">Verified By</span>
                          <span className="font-medium text-slate-700 text-right">
                            {vMeta.verifiedBy}
                            {vMeta.verifiedWhen ? ` • ${vMeta.verifiedWhen}` : ''}
                          </span>
                        </div>
                      )}

                      <div className="flex items-center justify-between gap-2">
                        <span className="text-slate-500">Added Date</span>
                        <span className="font-medium text-slate-700">
                          {formatShortDate(selectedMethod.addedAt || user.createdAt)}
                        </span>
                      </div>
                    </div>

                    {isBlocked && vMeta.pendingReq && (
                      <div className="p-2.5 rounded-[12px] bg-teal-50/80 border border-teal-200 text-[11.5px] text-[#04203F] flex items-center gap-2">
                        <Clock className="w-4 h-4 text-[#0E9AA7] shrink-0" />
                        <span>
                          Request{' '}
                          <span className="font-mono font-bold">
                            {vMeta.pendingReq.requestId || 'Pending'}
                          </span>{' '}
                          is currently awaiting Super Admin review for this method.
                        </span>
                      </div>
                    )}

                    <div className="space-y-2 pt-1">
                      {!selectedMethod.isDefault && (
                        <button
                          type="button"
                          disabled={isBlocked}
                          onClick={() =>
                            openChangeRequestWith({
                              mode: 'set_default',
                              targetPayoutId: selectedMethod.id,
                              methodType: selectedMethod.type,
                              makeDefault: true,
                              reason: `Request to set ${selectedMethod.type} (•••• ${selectedMethod.accountNumber.slice(-4)}) as my default payout method`,
                            })
                          }
                          className="w-full h-10 rounded-[12px] bg-[#04203F] hover:bg-[#0E9AA7] text-white text-[12px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
                        >
                          <Star className="w-3.5 h-3.5" />
                          <span>Request to change default</span>
                        </button>
                      )}
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          disabled={isBlocked}
                          onClick={() =>
                            openChangeRequestWith({
                              mode: 'edit',
                              targetPayoutId: selectedMethod.id,
                              methodType: selectedMethod.type,
                              makeDefault: selectedMethod.isDefault,
                              reason: `Request to update ${selectedMethod.type} (•••• ${selectedMethod.accountNumber.slice(-4)})`,
                            })
                          }
                          className="h-10 rounded-[12px] border border-slate-200 bg-white hover:bg-slate-50 text-[#04203F] text-[12px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
                        >
                          <Edit3 className="w-3.5 h-3.5 text-[#0E9AA7]" />
                          <span>Request edit</span>
                        </button>
                        <button
                          type="button"
                          disabled={isBlocked}
                          onClick={() =>
                            openChangeRequestWith({
                              mode: 'remove',
                              targetPayoutId: selectedMethod.id,
                              methodType: selectedMethod.type,
                              reason: '',
                            })
                          }
                          className="h-10 rounded-[12px] border border-rose-200 bg-rose-50/70 hover:bg-rose-100/70 text-rose-700 text-[12px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45 disabled:cursor-not-allowed transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Request removal</span>
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })()}
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Locked Change Request Modal */}
      <ChangeRequestModal
        isOpen={isChangeModalOpen}
        onClose={() => setIsChangeModalOpen(false)}
        user={user}
        initialField="payout"
        payoutPrefill={payoutPrefill}
        lockFieldSelector={true}
        onSubmitted={(msg) => {
          showToast(msg, 'success');
          loadPayoutHistory();
          onRefreshUser?.();
        }}
      />
    </div>
  );
};
