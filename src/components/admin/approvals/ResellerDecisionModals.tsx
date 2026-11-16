import React, { useState, useEffect } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, X, Loader2, ShieldCheck } from 'lucide-react';
import { UserProfile } from '../../../types';
import { formatResellerId } from '../../../lib/resellerIdHelper';

export const CORRECTION_SECTIONS = [
  { id: 'Personal Details', label: 'Personal Details' },
  { id: 'Contact Information', label: 'Contact Info' },
  { id: 'Shop Address', label: 'Shop Address' },
  { id: 'Shop & Business Links', label: 'Shop & Links' },
  { id: 'Payout Information', label: 'Payout Methods' },
  { id: 'Documents & Photos', label: 'Documents & Photos' },
];

export const PRESET_REASONS: Record<'reject' | 'request_changes', string[]> = {
  request_changes: [
    'NID front or back photo is blurry/unreadable',
    'Shop photo or logo does not clearly show the business',
    'Full address or landmark is incomplete',
    'Payout account holder name does not match applicant',
    'Business social link is invalid or unreachable',
  ],
  reject: [
    'Duplicate account detected with existing phone/NID/shop',
    'Invalid or forged NID / birth certificate document',
    'Unreachable phone number & WhatsApp during verification',
    'Shop details failed verification criteria',
    'Incomplete or inaccurate registration information',
  ],
};

interface ApproveConfirmSheetProps {
  user: UserProfile | null;
  checklistCount: number;
  checklistTotal: number;
  hasDuplicates: boolean;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const ApproveConfirmSheet: React.FC<ApproveConfirmSheetProps> = ({
  user,
  checklistCount,
  checklistTotal,
  hasDuplicates,
  submitting,
  onCancel,
  onConfirm,
}) => {
  if (!user) return null;

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-slate-950/55 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Approve Reseller Account"
    >
      <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl border border-slate-200 shadow-2xl overflow-hidden animate-in fade-in duration-150">
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-600 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-[#04203F]">Approve Reseller Account</h3>
              <p className="text-[11px] text-slate-500">Unlocks wholesale pricing, ordering & wallet features</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-3 text-[13px]">
          <div className="rounded-xl bg-slate-50 border border-slate-200/80 px-3.5 py-2.5 space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="font-bold text-[#04203F] truncate">{user.fullName}</span>
              <span className="font-mono text-[11px] font-bold text-slate-600 tabular-nums shrink-0">
                {formatResellerId(user)}
              </span>
            </div>
            <p className="text-[12px] text-slate-600 truncate">
              {user.shopName} · {user.mobile}
            </p>
          </div>

          {checklistCount < checklistTotal && (
            <div className="rounded-xl bg-amber-50 border border-amber-200 px-3.5 py-2.5 flex items-start gap-2 text-[12px] text-amber-800">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <span>
                Admin checklist: <strong>{checklistCount}/{checklistTotal}</strong> items ticked. Make sure NID, photo, address, and payout details are verified.
              </span>
            </div>
          )}

          {hasDuplicates && (
            <div className="rounded-xl bg-rose-50 border border-rose-200 px-3.5 py-2.5 flex items-start gap-2 text-[12px] text-rose-800">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <span>
                Duplicate records detected for this account. Confirm this is not a duplicate registration before approving.
              </span>
            </div>
          )}

          <p className="text-[12px] text-slate-500">
            Status will be set to <strong>Approved</strong>, an automatic welcome email will be queued, and an audit log entry will be saved.
          </p>
        </div>

        <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="min-h-[40px] px-4 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[12px] font-semibold cursor-pointer whitespace-nowrap"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={submitting}
            className="min-h-[40px] px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-[12px] font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-60 whitespace-nowrap"
          >
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
            <span>Confirm Approve</span>
          </button>
        </div>
      </div>
    </div>
  );
};

interface RejectOrChangesModalProps {
  mode: 'reject' | 'request_changes' | null;
  user: UserProfile | null;
  submitting: boolean;
  onClose: () => void;
  onConfirm: (reason: string, sections: string[], mode: 'reject' | 'request_changes') => void;
}

export const RejectOrChangesModal: React.FC<RejectOrChangesModalProps> = ({
  mode,
  user,
  submitting,
  onClose,
  onConfirm,
}) => {
  const [reason, setReason] = useState('');
  const [selectedSections, setSelectedSections] = useState<string[]>([]);
  const [validationError, setValidationError] = useState('');

  useEffect(() => {
    setReason('');
    setSelectedSections([]);
    setValidationError('');
  }, [mode, user?.uid]);

  if (!mode || !user) return null;

  const isChanges = mode === 'request_changes';
  const presets = PRESET_REASONS[mode];

  const toggleSection = (sectionId: string) => {
    setSelectedSections((prev) =>
      prev.includes(sectionId) ? prev.filter((s) => s !== sectionId) : [...prev, sectionId]
    );
    setValidationError('');
  };

  const applyPresetReason = (preset: string) => {
    setReason((prev) => {
      const trimmed = prev.trim();
      if (!trimmed) return preset;
      if (trimmed.includes(preset)) return trimmed;
      return `${trimmed}; ${preset}`;
    });
    setValidationError('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim()) {
      setValidationError(
        isChanges
          ? 'Please enter instructions or select a preset reason for the requested changes.'
          : 'Please enter or select a rejection reason.'
      );
      return;
    }
    if (isChanges && selectedSections.length === 0) {
      setValidationError('Please select at least one section that needs correction.');
      return;
    }
    onConfirm(reason.trim(), selectedSections, mode);
  };

  return (
    <div
      className="fixed inset-0 z-[90] flex items-end sm:items-center justify-center bg-slate-950/55 backdrop-blur-xs p-0 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-label={isChanges ? 'Request Changes' : 'Reject Reseller Application'}
    >
      <form
        onSubmit={handleSubmit}
        className="bg-white w-full sm:max-w-lg rounded-t-2xl sm:rounded-2xl border border-slate-200 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]"
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div
              className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
                isChanges
                  ? 'bg-amber-50 border-amber-200 text-amber-600'
                  : 'bg-rose-50 border-rose-200 text-rose-600'
              }`}
            >
              {isChanges ? <AlertTriangle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
            </div>
            <div className="min-w-0">
              <h3 className="text-[15px] font-bold text-[#04203F] truncate">
                {isChanges ? 'Request Application Changes' : 'Reject Reseller Application'}
              </h3>
              <p className="text-[11px] text-slate-500 truncate">
                {user.fullName} ({user.shopName}) · {formatResellerId(user)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto text-[12.5px]">
          {validationError && (
            <div className="rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-rose-700 text-[12px] font-medium">
              {validationError}
            </div>
          )}

          <div>
            <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1.5">
              Sections Needing Correction {isChanges ? '*' : '(Optional)'}
            </label>
            <div className="grid grid-cols-2 gap-2">
              {CORRECTION_SECTIONS.map((sec) => {
                const checked = selectedSections.includes(sec.id);
                return (
                  <label
                    key={sec.id}
                    className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-[12px] cursor-pointer transition-colors min-h-[38px] ${
                      checked
                        ? isChanges
                          ? 'bg-amber-50 border-amber-300 text-amber-900 font-semibold'
                          : 'bg-rose-50 border-rose-300 text-rose-900 font-semibold'
                        : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleSection(sec.id)}
                      className="rounded accent-rose-600 w-3.5 h-3.5 shrink-0"
                    />
                    <span className="truncate">{sec.label}</span>
                  </label>
                );
              })}
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1.5">
              Quick Reason Presets
            </label>
            <div className="flex flex-wrap gap-1.5">
              {presets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => applyPresetReason(preset)}
                  className="text-left text-[11.5px] px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 transition-colors cursor-pointer"
                >
                  + {preset}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1.5">
              {isChanges ? 'Correction Note for Reseller *' : 'Rejection Reason *'}
            </label>
            <textarea
              rows={3}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (validationError) setValidationError('');
              }}
              placeholder={
                isChanges
                  ? 'Explain clearly what needs to be fixed before resubmitting...'
                  : 'Provide a clear rejection reason...'
              }
              className="w-full p-3 rounded-xl border border-slate-300 text-[13px] text-slate-900 focus:outline-none focus:ring-2 focus:ring-[#0E9AA7]/25 focus:border-[#0E9AA7] resize-none"
            />
            <p className="text-[11px] text-slate-500 mt-1">
              The reseller will see this reason, receive an email notification, and can edit & resubmit their application.
            </p>
          </div>
        </div>

        <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-100 flex items-center justify-end gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="min-h-[40px] px-4 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[12px] font-semibold cursor-pointer whitespace-nowrap"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting}
            className={`min-h-[40px] px-4 rounded-xl text-white text-[12px] font-bold flex items-center gap-1.5 cursor-pointer disabled:opacity-60 whitespace-nowrap ${
              isChanges
                ? 'bg-amber-600 hover:bg-amber-700'
                : 'bg-rose-600 hover:bg-rose-700'
            }`}
          >
            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>{isChanges ? 'Send Change Request' : 'Confirm Rejection'}</span>
          </button>
        </div>
      </form>
    </div>
  );
};
