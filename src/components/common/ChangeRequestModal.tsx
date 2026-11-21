import React from 'react';
import { Lock, X } from 'lucide-react';
import { ChangeRequestFieldKey, UserProfile } from '../../types';
import { PayoutPrefillConfig } from '../../lib/lockedFieldsService';
import { ChangeRequestForm } from '../settings/ChangeRequestForm';

interface ChangeRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: UserProfile;
  initialField?: ChangeRequestFieldKey;
  payoutPrefill?: PayoutPrefillConfig | null;
  lockFieldSelector?: boolean;
  onSubmitted?: (message: string) => void;
}

export const ChangeRequestModal: React.FC<ChangeRequestModalProps> = ({
  isOpen,
  onClose,
  user,
  initialField = 'shopName',
  payoutPrefill = null,
  lockFieldSelector = false,
  onSubmitted,
}) => {
  if (!isOpen) return null;

  const formKey = payoutPrefill
    ? `payout_${payoutPrefill.mode}_${payoutPrefill.targetPayoutId || 'new'}_${payoutPrefill.methodType || ''}`
    : initialField;

  return (
    <div
      className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/65 backdrop-blur-xs"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 max-h-[90dvh] flex flex-col overflow-hidden text-xs"
      >
        {/* Slim Header */}
        <div className="px-4 py-3 bg-[#04203F] text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-white/10 border border-white/20 flex items-center justify-center text-[#3DD055] shrink-0">
              <Lock className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-[15px] font-bold leading-tight">
                Request a Change • পরিবর্তনের আবেদন
              </h3>
              <p className="text-[11px] text-slate-300 truncate">
                Verified by Super Admin • সুপার অ্যাডমিন রিভিউ করবে
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10 cursor-pointer shrink-0"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Body (Zero yellow banners) */}
        <div className="p-4 overflow-y-auto overscroll-contain">
          <ChangeRequestForm
            key={formKey}
            user={user}
            initialField={payoutPrefill ? 'payout' : initialField}
            payoutPrefill={payoutPrefill}
            lockFieldSelector={lockFieldSelector || Boolean(payoutPrefill?.lockFieldSelector)}
            onCancel={onClose}
            onSubmitted={(msg) => {
              onSubmitted?.(msg);
              onClose();
            }}
          />
        </div>
      </div>
    </div>
  );
};
