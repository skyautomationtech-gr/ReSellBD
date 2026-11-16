import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bell,
  Calendar,
  CheckCircle2,
  KeyRound,
  Loader2,
  Percent,
  ShieldAlert,
  X,
} from 'lucide-react';
import { formatResellerId } from '../../../lib/resellerIdHelper';
import { isProtectedSuperAdmin } from '../../../lib/resellerDirectoryService';
import { UserProfile } from '../../../types';

/* ------------------------------------------------------------------ */
/* 1. Suspend / Block / Activate Confirmation Modal (Single & Bulk)   */
/* ------------------------------------------------------------------ */
interface SuspendActivateModalProps {
  isOpen: boolean;
  onClose: () => void;
  targets: UserProfile[];
  initialMode: 'suspend_temporary' | 'block_permanent' | 'activate';
  onConfirm: (params: {
    mode: 'suspend_temporary' | 'block_permanent' | 'activate';
    reason: string;
    suspendedUntil?: string;
  }) => Promise<void>;
}

export const SuspendActivateModal: React.FC<SuspendActivateModalProps> = ({
  isOpen,
  onClose,
  targets,
  initialMode,
  onConfirm,
}) => {
  const [mode, setMode] = useState<'suspend_temporary' | 'block_permanent' | 'activate'>(
    initialMode
  );
  const [reason, setReason] = useState('');
  const [suspendedUntil, setSuspendedUntil] = useState('');
  const [stepConfirm, setStepConfirm] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      setMode(initialMode);
      setReason('');
      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      setSuspendedUntil(nextWeek.toISOString().split('T')[0]);
      setStepConfirm(false);
      setError('');
    }
  }, [isOpen, initialMode]);

  if (!isOpen || targets.length === 0) return null;

  const eligibleTargets = targets.filter((t) => !isProtectedSuperAdmin(t));
  const isBulk = eligibleTargets.length > 1;
  const isSuspend = mode !== 'activate';

  const handlePrimaryClick = async () => {
    if (isSuspend && !reason.trim()) {
      setError('Please provide a clear reason for this restriction.');
      return;
    }
    setError('');

    // Require explicit confirmation sheet before bulk status change
    if (isBulk && !stepConfirm) {
      setStepConfirm(true);
      return;
    }

    setSubmitting(true);
    try {
      await onConfirm({
        mode,
        reason: reason.trim(),
        suspendedUntil: mode === 'suspend_temporary' ? suspendedUntil : undefined,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to update account status.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-[2px] p-4">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-md w-full p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2.5">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                mode === 'activate'
                  ? 'bg-emerald-50 text-emerald-700'
                  : mode === 'suspend_temporary'
                  ? 'bg-amber-50 text-amber-700'
                  : 'bg-rose-50 text-rose-700'
              }`}
            >
              {mode === 'activate' ? (
                <CheckCircle2 className="w-4.5 h-4.5" />
              ) : (
                <AlertTriangle className="w-4.5 h-4.5" />
              )}
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-slate-900">
                {mode === 'activate'
                  ? isBulk
                    ? `Activate ${eligibleTargets.length} Accounts`
                    : 'Activate Account'
                  : mode === 'suspend_temporary'
                  ? isBulk
                    ? `Temporarily Suspend ${eligibleTargets.length} Accounts`
                    : 'Temporarily Suspend Account'
                  : isBulk
                  ? `Permanently Block ${eligibleTargets.length} Accounts`
                  : 'Permanently Block Account'}
              </h3>
              <p className="text-[11px] text-slate-500">
                {eligibleTargets.length === 1
                  ? `${eligibleTargets[0].fullName} (${eligibleTargets[0].shopName || formatResellerId(eligibleTargets[0])})`
                  : `${eligibleTargets.length} eligible accounts selected`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {stepConfirm ? (
          <div className="rounded-xl bg-amber-50/80 border border-amber-200 p-3.5 space-y-2">
            <div className="flex items-center gap-2 text-amber-900 font-bold text-[13px]">
              <ShieldAlert className="w-4 h-4 text-amber-600 shrink-0" />
              <span>Confirm Bulk Status Change</span>
            </div>
            <p className="text-[12px] text-amber-800 leading-relaxed">
              You are about to{' '}
              <strong>
                {mode === 'activate'
                  ? 'activate / approve'
                  : mode === 'suspend_temporary'
                  ? 'temporarily suspend'
                  : 'permanently block'}
              </strong>{' '}
              <strong>{eligibleTargets.length}</strong> accounts. Status notification emails
              and audit log entries will be created automatically.
            </p>
            {reason.trim() && (
              <p className="text-[11px] text-amber-900 bg-white/70 rounded-lg px-2.5 py-1.5 border border-amber-200/70">
                Reason: {reason.trim()}
              </p>
            )}
          </div>
        ) : (
          <>
            {isSuspend && (
              <div className="space-y-1.5">
                <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                  Restriction Type
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setMode('suspend_temporary')}
                    className={`h-[36px] px-3 rounded-xl text-[12px] font-semibold border cursor-pointer ${
                      mode === 'suspend_temporary'
                        ? 'bg-amber-600 text-white border-amber-600'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    Temporary
                  </button>
                  <button
                    type="button"
                    onClick={() => setMode('block_permanent')}
                    className={`h-[36px] px-3 rounded-xl text-[12px] font-semibold border cursor-pointer ${
                      mode === 'block_permanent'
                        ? 'bg-rose-600 text-white border-rose-600'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    Permanent Block
                  </button>
                </div>
              </div>
            )}

            {mode === 'suspend_temporary' && (
              <div className="space-y-1">
                <label className="flex items-center gap-1.5 text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                  <Calendar className="w-3.5 h-3.5 text-amber-600" />
                  <span>Suspended Until (Optional)</span>
                </label>
                <input
                  type="date"
                  value={suspendedUntil}
                  min={new Date().toISOString().split('T')[0]}
                  onChange={(e) => setSuspendedUntil(e.target.value)}
                  className="w-full h-[38px] px-3 rounded-xl border border-slate-200 bg-slate-50 text-[13px] font-medium text-slate-800 outline-none focus:border-[#0E9AA7]"
                />
              </div>
            )}

            <div className="space-y-1">
              <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                {isSuspend ? (
                  <>
                    Reason for Restriction <span className="text-rose-600">*</span>
                  </>
                ) : (
                  'Activation Note (Optional)'
                )}
              </label>
              <textarea
                rows={3}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={
                  isSuspend
                    ? 'e.g., Policy violation: Repeated unconfirmed COD cancellations.'
                    : 'Optional note recorded in audit log...'
                }
                className="w-full p-2.5 rounded-xl border border-slate-200 bg-slate-50 text-[13px] text-slate-800 outline-none focus:border-[#0E9AA7] resize-none"
              />
            </div>
          </>
        )}

        {error && (
          <p className="text-[12px] font-medium text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            disabled={submitting}
            onClick={() => (stepConfirm ? setStepConfirm(false) : onClose())}
            className="flex-1 h-[38px] rounded-xl border border-slate-200 text-slate-700 text-[12px] font-semibold hover:bg-slate-50 cursor-pointer disabled:opacity-50"
          >
            {stepConfirm ? 'Back' : 'Cancel'}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={handlePrimaryClick}
            className={`flex-1 h-[38px] rounded-xl text-white text-[12px] font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50 ${
              mode === 'activate'
                ? 'bg-emerald-600 hover:bg-emerald-700'
                : mode === 'suspend_temporary'
                ? 'bg-amber-600 hover:bg-amber-700'
                : 'bg-rose-600 hover:bg-rose-700'
            }`}
          >
            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>
              {stepConfirm
                ? 'Confirm & Apply'
                : isBulk
                ? 'Review Bulk Action'
                : mode === 'activate'
                ? 'Confirm Activate'
                : 'Confirm Restriction'}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* 2. Set Custom Commission Rate Modal                                */
/* ------------------------------------------------------------------ */
interface CustomCommissionModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetUser: UserProfile | null;
  globalRateLabel: string;
  onSave: (rate: number | null) => Promise<void>;
}

export const CustomCommissionModal: React.FC<CustomCommissionModalProps> = ({
  isOpen,
  onClose,
  targetUser,
  globalRateLabel,
  onSave,
}) => {
  const [useGlobal, setUseGlobal] = useState(true);
  const [rateInput, setRateInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen && targetUser) {
      const hasCustom =
        targetUser.customCommissionRate !== undefined &&
        targetUser.customCommissionRate !== null;
      setUseGlobal(!hasCustom);
      setRateInput(hasCustom ? String(targetUser.customCommissionRate) : '');
      setError('');
    }
  }, [isOpen, targetUser]);

  if (!isOpen || !targetUser) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    let parsed: number | null = null;
    if (!useGlobal) {
      const num = Number(rateInput);
      if (rateInput.trim() === '' || Number.isNaN(num) || num < 0 || num > 100) {
        setError('Enter a valid percentage between 0 and 100.');
        return;
      }
      parsed = Math.round(num * 100) / 100;
    }

    setSaving(true);
    try {
      await onSave(parsed);
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Could not update commission rate.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-[2px] p-4">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-sm w-full p-5 space-y-4"
      >
        <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-cyan-50 text-[#0E9AA7] flex items-center justify-center">
              <Percent className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-slate-900">Commission Rate</h3>
              <p className="text-[11px] text-slate-500">
                {targetUser.fullName} · {formatResellerId(targetUser)}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => setUseGlobal(true)}
            className={`h-[36px] rounded-xl text-[12px] font-semibold border cursor-pointer ${
              useGlobal
                ? 'bg-[#04203F] text-white border-[#04203F]'
                : 'bg-slate-50 text-slate-700 border-slate-200'
            }`}
          >
            {globalRateLabel}
          </button>
          <button
            type="button"
            onClick={() => setUseGlobal(false)}
            className={`h-[36px] rounded-xl text-[12px] font-semibold border cursor-pointer ${
              !useGlobal
                ? 'bg-[#0E9AA7] text-white border-[#0E9AA7]'
                : 'bg-slate-50 text-slate-700 border-slate-200'
            }`}
          >
            Custom Rate (%)
          </button>
        </div>

        {!useGlobal && (
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">
              Custom Commission Percentage (%)
            </label>
            <input
              type="number"
              step="0.1"
              min="0"
              max="100"
              value={rateInput}
              onChange={(e) => setRateInput(e.target.value)}
              placeholder="e.g. 12.5"
              className="w-full h-[38px] px-3 rounded-xl border border-slate-200 bg-slate-50 text-[13px] font-bold tabular-nums outline-none focus:border-[#0E9AA7]"
            />
          </div>
        )}

        {error && (
          <p className="text-[12px] text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            disabled={saving}
            onClick={onClose}
            className="flex-1 h-[38px] rounded-xl border border-slate-200 text-slate-700 text-[12px] font-semibold cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving}
            className="flex-1 h-[38px] rounded-xl bg-[#04203F] hover:bg-[#073363] text-white text-[12px] font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>Save Rate</span>
          </button>
        </div>
      </form>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* 3. Send Targeted Notification Modal (Single & Bulk)                */
/* ------------------------------------------------------------------ */
interface SendNotificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  targets: UserProfile[];
  onSend: (payload: {
    title: string;
    message: string;
    type: 'general' | 'offer' | 'payment_notice' | 'maintenance';
    priority: 'normal' | 'high';
  }) => Promise<void>;
}

export const SendNotificationModal: React.FC<SendNotificationModalProps> = ({
  isOpen,
  onClose,
  targets,
  onSend,
}) => {
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [type, setType] = useState<'general' | 'offer' | 'payment_notice' | 'maintenance'>(
    'general'
  );
  const [priority, setPriority] = useState<'normal' | 'high'>('normal');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) {
      setTitle('');
      setMessage('');
      setType('general');
      setPriority('normal');
      setError('');
    }
  }, [isOpen]);

  if (!isOpen || targets.length === 0) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !message.trim()) {
      setError('Both title and message are required.');
      return;
    }
    setSending(true);
    setError('');
    try {
      await onSend({
        title: title.trim(),
        message: message.trim(),
        type,
        priority,
      });
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Failed to send notification.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-[2px] p-4">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-md w-full p-5 space-y-3.5"
      >
        <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-cyan-50 text-[#0E9AA7] flex items-center justify-center">
              <Bell className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-slate-900">Send Notification</h3>
              <p className="text-[11px] text-slate-500">
                {targets.length === 1
                  ? `To: ${targets[0].fullName} (${formatResellerId(targets[0])})`
                  : `To ${targets.length} selected accounts`}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">Category</label>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as any)}
              className="w-full h-[36px] px-2.5 rounded-xl border border-slate-200 bg-slate-50 text-[12px] outline-none focus:border-[#0E9AA7]"
            >
              <option value="general">General Notice</option>
              <option value="offer">Offer / Promo</option>
              <option value="payment_notice">Payment Notice</option>
              <option value="maintenance">System Update</option>
            </select>
          </div>
          <div>
            <label className="block text-[11px] font-bold text-slate-600 mb-1">Priority</label>
            <select
              value={priority}
              onChange={(e) => setPriority(e.target.value as any)}
              className="w-full h-[36px] px-2.5 rounded-xl border border-slate-200 bg-slate-50 text-[12px] outline-none focus:border-[#0E9AA7]"
            >
              <option value="normal">Normal</option>
              <option value="high">High Alert</option>
            </select>
          </div>
        </div>

        <div>
          <label className="block text-[11px] font-bold text-slate-600 mb-1">Title</label>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g., Payout verification reminder"
            className="w-full h-[38px] px-3 rounded-xl border border-slate-200 bg-slate-50 text-[13px] outline-none focus:border-[#0E9AA7]"
          />
        </div>

        <div>
          <label className="block text-[11px] font-bold text-slate-600 mb-1">Message</label>
          <textarea
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            placeholder="Write the message shown in the reseller's app notification center..."
            className="w-full p-2.5 rounded-xl border border-slate-200 bg-slate-50 text-[13px] outline-none focus:border-[#0E9AA7] resize-none"
          />
        </div>

        {error && (
          <p className="text-[12px] text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            disabled={sending}
            onClick={onClose}
            className="flex-1 h-[38px] rounded-xl border border-slate-200 text-slate-700 text-[12px] font-semibold cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={sending}
            className="flex-1 h-[38px] rounded-xl bg-[#04203F] hover:bg-[#073363] text-white text-[12px] font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {sending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>Send Notification</span>
          </button>
        </div>
      </form>
    </div>
  );
};

/* ------------------------------------------------------------------ */
/* 4. Super Admin Password Reset Confirmation Modal                   */
/* ------------------------------------------------------------------ */
interface ResetPasswordConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetUser: UserProfile | null;
  onConfirm: () => Promise<void>;
}

export const ResetPasswordConfirmModal: React.FC<ResetPasswordConfirmModalProps> = ({
  isOpen,
  onClose,
  targetUser,
  onConfirm,
}) => {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isOpen) setError('');
  }, [isOpen]);

  if (!isOpen || !targetUser) return null;

  const handleConfirm = async () => {
    setSending(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (err: any) {
      setError(err?.message || 'Could not send password reset email.');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-[2px] p-4">
      <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-sm w-full p-5 space-y-4">
        <div className="flex items-start justify-between gap-2 border-b border-slate-100 pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-amber-50 text-amber-700 flex items-center justify-center">
              <KeyRound className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-slate-900">Send Password Reset</h3>
              <p className="text-[11px] text-slate-500">{targetUser.email}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700 p-1 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-[12px] text-slate-600 leading-relaxed">
          Send an official Firebase password reset link to{' '}
          <strong className="text-slate-900">{targetUser.fullName}</strong> ({targetUser.email})?
        </p>

        {error && (
          <p className="text-[12px] text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
            {error}
          </p>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            disabled={sending}
            onClick={onClose}
            className="flex-1 h-[38px] rounded-xl border border-slate-200 text-slate-700 text-[12px] font-semibold cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={sending}
            onClick={handleConfirm}
            className="flex-1 h-[38px] rounded-xl bg-[#04203F] hover:bg-[#073363] text-white text-[12px] font-bold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
          >
            {sending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            <span>Send Reset Email</span>
          </button>
        </div>
      </div>
    </div>
  );
};
