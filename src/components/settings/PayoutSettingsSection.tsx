import React, { useState, useEffect } from 'react';
import { collection, query, where, getDocs } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { UserProfile, PayoutMethod, ChangeRequest } from '../../types';
import { triggerHaptic } from '../../lib/nativeFeedback';
import { DENSITY_TOKENS as DT } from '../../utils/densityTokens';
import { useScrollToTop } from '../../utils/scrollToTop';
import {
  CreditCard, CheckCircle2, AlertCircle, Clock, Eye, EyeOff, Lock, Send
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { PageHeader } from '../common/PageHeader';
import { ChangeRequestModal } from '../common/ChangeRequestModal';
import { LockTooltipIcon } from '../common/LockTooltipIcon';
import { fetchPendingChangeRequests } from '../../lib/lockedFieldsService';

interface PayoutSettingsSectionProps {
  user: UserProfile;
  canAccessFullApp?: boolean;
  onOpenLockedModal?: (featureName?: string) => void;
  onRefreshUser?: () => void;
  onBack?: () => void;
  hideHeader?: boolean;
}

type PayoutType = 'bKash' | 'Nagad' | 'Rocket' | 'Upay' | 'Bank';

const METHOD_CONFIG: Record<PayoutType, { initial: string; bg: string; text: string; border: string; label: string }> = {
  bKash: { initial: 'bK', bg: 'bg-pink-50', text: 'text-pink-700', border: 'border-pink-200/80', label: 'bKash Wallet' },
  Nagad: { initial: 'NG', bg: 'bg-orange-50', text: 'text-orange-700', border: 'border-orange-200/80', label: 'Nagad Wallet' },
  Rocket: { initial: 'RK', bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200/80', label: 'Rocket Wallet' },
  Upay: { initial: 'UP', bg: 'bg-amber-50', text: 'text-amber-800', border: 'border-amber-200/80', label: 'Upay Wallet' },
  Bank: { initial: 'BK', bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200/80', label: 'Bank Account' },
};

export const PayoutSettingsSection: React.FC<PayoutSettingsSectionProps> = ({
  user,
  canAccessFullApp = true,
  onOpenLockedModal,
  onBack,
  hideHeader = false,
}) => {
  const payoutMethods: PayoutMethod[] = user.payoutMethods || [];
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [revealedIds, setRevealedIds] = useState<Record<string, boolean>>({});
  const [isChangeModalOpen, setIsChangeModalOpen] = useState(false);
  const [pendingRequest, setPendingRequest] = useState<ChangeRequest | null>(null);
  const [hasLegacyPending, setHasLegacyPending] = useState(false);

  useScrollToTop([]);

  const isRestricted = !canAccessFullApp || user.status === 'pending';

  const loadPendingStatus = async () => {
    try {
      const pendingList = await fetchPendingChangeRequests(user.uid);
      const payoutPending = pendingList.find((r) => r.fieldKey === 'payout') || null;
      setPendingRequest(payoutPending);

      const legacyQ = query(
        collection(db, 'payoutChangeRequests'),
        where('resellerId', '==', user.uid),
        where('status', '==', 'pending')
      );
      const legacySnap = await getDocs(legacyQ);
      setHasLegacyPending(!legacySnap.empty);
    } catch {
      // Ignore silent check errors
    }
  };

  useEffect(() => {
    loadPendingStatus();
  }, [user.uid]);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 4000);
  };

  const maskAccountNumber = (num: string): string => {
    if (!num) return '••••';
    const clean = num.replace(/\s+/g, '');
    if (clean.length <= 4) return clean;
    return `•••• •••• ${clean.slice(-4)}`;
  };

  const handleToggleReveal = (id: string, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    triggerHaptic('light');

    if (revealedIds[id]) {
      setRevealedIds((prev) => ({ ...prev, [id]: false }));
      return;
    }

    setRevealedIds((prev) => ({ ...prev, [id]: true }));
    setTimeout(() => {
      setRevealedIds((prev) => ({ ...prev, [id]: false }));
    }, 5000);
  };

  const handleOpenRequestChange = () => {
    triggerHaptic('light');
    if (isRestricted) {
      if (onOpenLockedModal) onOpenLockedModal('Payout Methods');
      else showToast('Payout accounts require approved reseller status', 'error');
      return;
    }
    setIsChangeModalOpen(true);
  };

  return (
    <div className="space-y-3 pb-8">
      <AnimatePresence>
        {toastMessage && (
          <motion.div
            initial={{ opacity: 0, y: -12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            className={`fixed top-4 left-4 right-4 z-[9999] max-w-sm mx-auto p-3 rounded-2xl shadow-lg border text-xs font-bold flex items-center gap-2 ${
              toastMessage.type === 'success'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200 shadow-emerald-500/10'
                : 'bg-rose-50 text-rose-800 border-rose-200 shadow-rose-500/10'
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

      {!hideHeader ? (
        <PageHeader
          title="Payout Settings"
          subtitle="Locked verified bank & mobile banking accounts"
          onBack={onBack}
          rightAction={
            <button
              type="button"
              onClick={handleOpenRequestChange}
              className={`${DT.smallButton} bg-[#04203F] text-white hover:bg-[#0E9AA7]`}
            >
              <Send className="w-3.5 h-3.5" />
              <span>Request a change</span>
            </button>
          }
        />
      ) : (
        <div className="flex justify-end pt-1">
          <button
            type="button"
            onClick={handleOpenRequestChange}
            className={`${DT.smallButton} bg-[#04203F] text-white hover:bg-[#0E9AA7]`}
          >
            <Send className="w-3.5 h-3.5" />
            <span>Request a change</span>
          </button>
        </div>
      )}

      {/* Pending Change Request Indicator */}
      {(pendingRequest || hasLegacyPending) && (
        <div className="p-3 rounded-[14px] bg-teal-50/80 border border-teal-200/80 text-[11px] text-[#04203F] flex items-start gap-2 shadow-2xs">
          <Clock className="w-4 h-4 text-[#0E9AA7] shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">Pending Payout Change Request</p>
            <p className="text-[10.5px] text-slate-600 mt-0.5">
              {pendingRequest
                ? `Requested: ${pendingRequest.requestedValueSummary} — awaiting Super Admin review.`
                : 'Your payout update request is currently awaiting Super Admin review.'}
            </p>
          </div>
        </div>
      )}

      {/* Registered Accounts Grouped Card (Read-only) */}
      <div className="space-y-1">
        <div className="flex items-center justify-between px-1">
          <div className="flex items-center gap-1">
            <span className={DT.settingsGroupLabel}>REGISTERED ACCOUNTS ({payoutMethods.length})</span>
            <LockTooltipIcon size="xs" />
          </div>
        </div>

        {payoutMethods.length === 0 ? (
          <div className="bg-white/70 backdrop-blur-xl border border-white/80 rounded-[14px] p-6 text-center space-y-3 shadow-2xs">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 text-emerald-600 border border-emerald-200/60 flex items-center justify-center mx-auto">
              <CreditCard className="w-5 h-5" />
            </div>
            <div>
              <h4 className="text-[13px] font-bold text-[#04203F]">No Payout Methods Registered</h4>
              <p className="text-[11px] text-slate-500 mt-1 max-w-xs mx-auto leading-tight">
                {user.accountNumber
                  ? `Primary account: ${(user.payoutMethod || 'payout').toUpperCase()} (${maskAccountNumber(user.accountNumber)})`
                  : 'Submit a payout change request to have Super Admin add your bKash, Nagad, Rocket, Upay, or Bank account.'}
              </p>
            </div>
            <button
              type="button"
              onClick={handleOpenRequestChange}
              className={`${DT.primaryButton} max-w-xs mx-auto`}
            >
              <Send className="w-3.5 h-3.5" />
              <span>Request a change</span>
            </button>
          </div>
        ) : (
          <div className={DT.settingsGroupCard}>
            {payoutMethods.map((pm) => {
              const cfg = METHOD_CONFIG[pm.type] || METHOD_CONFIG.Bank;
              const isRevealed = Boolean(revealedIds[pm.id]);
              const verificationState = pm.payoutVerified || (pm.verified ? 'verified' : 'pending');

              return (
                <div key={pm.id} className={DT.settingsRow}>
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className={`w-8 h-8 rounded-xl font-black text-xs flex items-center justify-center shrink-0 border ${cfg.bg} ${cfg.text} ${cfg.border}`}>
                      {cfg.initial}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className={DT.settingsRowTitle}>{cfg.label}</span>
                        {pm.isDefault && (
                          <span className="text-[9px] font-extrabold uppercase px-1.5 py-0.2 rounded bg-emerald-600 text-white tracking-wider">
                            Default
                          </span>
                        )}
                        {verificationState === 'verified' ? (
                          <span className="text-[9px] font-bold px-1.5 py-0.2 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 flex items-center gap-1">
                            <CheckCircle2 className="w-2.5 h-2.5 text-emerald-600" />
                            <span>Verified</span>
                          </span>
                        ) : verificationState === 'rejected' ? (
                          <span className="text-[9px] font-bold px-1.5 py-0.2 rounded-full bg-rose-50 text-rose-700 border border-rose-200 flex items-center gap-1">
                            <AlertCircle className="w-2.5 h-2.5 text-rose-600" />
                            <span>Rejected</span>
                          </span>
                        ) : (
                          <span className="text-[9px] font-bold px-1.5 py-0.2 rounded-full bg-amber-50 text-amber-800 border border-amber-200 flex items-center gap-1">
                            <Clock className="w-2.5 h-2.5 text-amber-600" />
                            <span>Pending Review</span>
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className="font-mono text-[11px] font-bold text-slate-700 tabular-nums">
                          {isRevealed ? pm.accountNumber : maskAccountNumber(pm.accountNumber)}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => handleToggleReveal(pm.id, e)}
                          className="p-1 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
                          title={isRevealed ? 'Hide number' : 'Show full number for 5s'}
                        >
                          {isRevealed ? <EyeOff className="w-3 h-3 text-[#0E9AA7]" /> : <Eye className="w-3 h-3" />}
                        </button>
                      </div>

                      <p className="text-[10px] text-slate-400 truncate mt-0.2">
                        {pm.type === 'Bank' && pm.bankName ? `${pm.bankName} • ` : ''}
                        {pm.accountHolderName || user.fullName || 'Account Holder'}
                      </p>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 shrink-0 ml-2">
                    <LockTooltipIcon />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Payout Rules & Threshold Info Card */}
      <div className="space-y-1 pt-1">
        <span className={DT.settingsGroupLabel}>WITHDRAWAL & PROCESSING RULES</span>
        <div className="bg-white/70 backdrop-blur-xl border border-white/80 rounded-[14px] p-3.5 space-y-2.5 text-xs text-slate-600 shadow-2xs">
          <div className="flex items-center justify-between border-b border-slate-100/80 pb-2">
            <span className="font-semibold text-slate-500 text-[11px]">Minimum Withdrawal</span>
            <span className="font-mono font-bold text-[#04203F] text-[12px]">৳500 BDT</span>
          </div>
          <div className="flex items-center justify-between border-b border-slate-100/80 pb-2">
            <span className="font-semibold text-slate-500 text-[11px]">Processing Turnaround</span>
            <span className="font-bold text-emerald-700 text-[11px]">24 – 48 Hours</span>
          </div>
          <div className="flex items-center justify-between border-b border-slate-100/80 pb-2">
            <span className="font-semibold text-slate-500 text-[11px]">Automated Batch Disbursal</span>
            <span className="font-bold text-[#0E9AA7] text-[11px]">bKash, Nagad, Rocket</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-500 text-[11px]">Bank Wire Method</span>
            <span className="font-medium text-slate-700 text-[11px]">BEFTN / NPSB Routing</span>
          </div>
        </div>
      </div>

      <ChangeRequestModal
        isOpen={isChangeModalOpen}
        onClose={() => setIsChangeModalOpen(false)}
        user={user}
        initialField="payout"
        onSubmitted={(msg) => {
          showToast(msg, 'success');
          loadPendingStatus();
        }}
      />
    </div>
  );
};
