import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Calendar,
  CheckCircle2,
  CreditCard,
  FileText,
  ImagePlus,
  Loader2,
  Mail,
  Send,
  ShieldCheck,
  Store,
  X,
} from 'lucide-react';
import { ChangeRequest, ChangeRequestFieldKey, PayoutMethod, UserProfile } from '../../types';
import {
  CHANGE_REQUEST_FIELD_LABELS,
  fetchPendingChangeRequests,
  getMaskedCurrentValueForField,
  submitLockedChangeRequest,
} from '../../lib/lockedFieldsService';
import { checkShopNameAvailability } from '../../lib/shopNameService';
import { normalizeShopName } from '../../utils/shopName';
import { ImageUploadField } from '../common/ImageUploadField';

interface ChangeRequestFormProps {
  user: UserProfile;
  initialField?: ChangeRequestFieldKey;
  onSubmitted?: (message: string, requestId?: string) => void;
  onCancel?: () => void;
}

const BD_BANKS = [
  'Islami Bank Bangladesh PLC',
  'Dutch-Bangla Bank PLC (DBBL)',
  'BRAC Bank PLC',
  'City Bank PLC',
  'Prime Bank PLC',
  'Eastern Bank PLC (EBL)',
  'Sonali Bank PLC',
  'Pubali Bank PLC',
  'Agrani Bank PLC',
  'Janata Bank PLC',
  'Bank Asia PLC',
  'Mutual Trust Bank PLC (MTB)',
  'Standard Chartered Bank',
  'Other',
];

const FIELD_OPTIONS: Array<{
  key: ChangeRequestFieldKey;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  { key: 'shopName', icon: Store },
  { key: 'email', icon: Mail },
  { key: 'nid', icon: FileText },
  { key: 'nid_image', icon: ImagePlus },
  { key: 'birth_certificate', icon: FileText },
  { key: 'dob', icon: Calendar },
  { key: 'payout', icon: CreditCard },
];

export const ChangeRequestForm: React.FC<ChangeRequestFormProps> = ({
  user,
  initialField = 'shopName',
  onSubmitted,
  onCancel,
}) => {
  const existingPayouts: PayoutMethod[] = useMemo(
    () => (Array.isArray(user.payoutMethods) ? user.payoutMethods : []),
    [user.payoutMethods]
  );

  const [fieldKey, setFieldKey] = useState<ChangeRequestFieldKey>(initialField);
  const [pendingList, setPendingList] = useState<ChangeRequest[]>([]);
  const [checkingPending, setCheckingPending] = useState(false);

  // Field values
  const [newShopName, setNewShopName] = useState('');
  const [shopCheck, setShopCheck] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const [newEmail, setNewEmail] = useState('');
  const [newDob, setNewDob] = useState(user.dob || '');
  const [nidNumber, setNidNumber] = useState('');
  const [nidFrontUrl, setNidFrontUrl] = useState('');
  const [nidBackUrl, setNidBackUrl] = useState('');
  const [birthCertNumber, setBirthCertNumber] = useState('');
  const [birthCertUrl, setBirthCertUrl] = useState('');

  // Payout action: add / edit / remove
  const [payoutAction, setPayoutAction] = useState<'add' | 'edit' | 'remove'>('add');
  const [targetPayoutId, setTargetPayoutId] = useState<string>('');
  const [payoutType, setPayoutType] = useState<'bKash' | 'Nagad' | 'Rocket' | 'Upay' | 'Bank'>('bKash');
  const [payoutAccountNumber, setPayoutAccountNumber] = useState('');
  const [payoutAccountHolder, setPayoutAccountHolder] = useState(
    user.accountHolderName || user.fullName || ''
  );
  const [payoutBankName, setPayoutBankName] = useState(user.bankName || BD_BANKS[0]);
  const [payoutCustomBank, setPayoutCustomBank] = useState('');
  const [payoutBranchName, setPayoutBranchName] = useState(user.branchName || '');
  const [payoutRoutingNumber, setPayoutRoutingNumber] = useState(user.routingNumber || '');
  const [makeDefaultPayout, setMakeDefaultPayout] = useState(true);

  const [reason, setReason] = useState('');
  const [proofUrl, setProofUrl] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showConfirmSheet, setShowConfirmSheet] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    setFieldKey(initialField);
    setError(null);
  }, [initialField]);

  const loadPending = async () => {
    if (!user.uid) return;
    setCheckingPending(true);
    try {
      const list = await fetchPendingChangeRequests(user.uid);
      setPendingList(list);
    } catch {
      setPendingList([]);
    } finally {
      setCheckingPending(false);
    }
  };

  useEffect(() => {
    loadPending();
  }, [user.uid]);

  useEffect(() => {
    if (existingPayouts.length > 0 && !targetPayoutId) {
      setTargetPayoutId(existingPayouts[0].id);
    }
  }, [existingPayouts, targetPayoutId]);

  useEffect(() => {
    if (payoutAction !== 'edit' || !targetPayoutId) return;
    const found = existingPayouts.find((p) => p.id === targetPayoutId);
    if (found) {
      setPayoutType(found.type);
      setPayoutAccountNumber(found.accountNumber || '');
      setPayoutAccountHolder(found.accountHolderName || user.fullName || '');
      if (found.bankName) {
        if (BD_BANKS.includes(found.bankName)) {
          setPayoutBankName(found.bankName);
        } else {
          setPayoutBankName('Other');
          setPayoutCustomBank(found.bankName);
        }
      }
      setPayoutBranchName(found.branchName || '');
      setPayoutRoutingNumber(found.routingNumber || '');
      setMakeDefaultPayout(Boolean(found.isDefault));
    }
  }, [payoutAction, targetPayoutId, existingPayouts, user.fullName]);

  useEffect(() => {
    if (fieldKey !== 'shopName') {
      setShopCheck('idle');
      return;
    }
    const clean = newShopName.trim();
    if (!clean || clean.length < 2 || normalizeShopName(clean) === normalizeShopName(user.shopName || '')) {
      setShopCheck('idle');
      return;
    }
    setShopCheck('checking');
    const timer = setTimeout(async () => {
      try {
        const res = await checkShopNameAvailability(clean, user.uid);
        setShopCheck(res.available ? 'available' : 'taken');
      } catch {
        setShopCheck('idle');
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [fieldKey, newShopName, user.shopName, user.uid]);

  const pendingForField = useMemo(
    () => pendingList.find((r) => r.fieldKey === fieldKey),
    [pendingList, fieldKey]
  );

  const maskedOldValue = useMemo(
    () => getMaskedCurrentValueForField(user, fieldKey),
    [user, fieldKey]
  );

  const buildPayloadPreview = (): {
    requestedValueSummary: string;
    requestedData: Record<string, any>;
    requestedPayoutEntry?: any;
    newDocumentUrl?: string;
  } | null => {
    setError(null);

    if (pendingForField) {
      setError('This field already has a pending request. Cancel it first to submit a new one.');
      return null;
    }

    if (!reason.trim() || reason.trim().length < 5) {
      setError('Please write a brief reason (minimum 5 characters). কারণ লিখুন।');
      return null;
    }

    if (fieldKey === 'shopName') {
      const clean = newShopName.trim();
      if (clean.length < 2) {
        setError('Shop name must be at least 2 characters.');
        return null;
      }
      if (normalizeShopName(clean) === normalizeShopName(user.shopName || '')) {
        setError('Please enter a different shop name from your current one.');
        return null;
      }
      if (shopCheck === 'taken') {
        setError('This shop name is already taken by another reseller.');
        return null;
      }
      return {
        requestedValueSummary: clean,
        requestedData: { shopName: clean },
      };
    }

    if (fieldKey === 'email') {
      const clean = newEmail.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
        setError('Please enter a valid email address. সঠিক ইমেইল দিন।');
        return null;
      }
      if (clean === (user.email || '').trim().toLowerCase()) {
        setError('Please enter a different email address from your current one.');
        return null;
      }
      return {
        requestedValueSummary: clean,
        requestedData: { email: clean },
      };
    }

    if (fieldKey === 'dob') {
      if (!newDob) {
        setError('Please select the requested date of birth.');
        return null;
      }
      return {
        requestedValueSummary: newDob,
        requestedData: { dob: newDob },
      };
    }

    if (fieldKey === 'nid') {
      const clean = nidNumber.trim();
      if (!/^\d{10}$|^\d{13}$|^\d{17}$/.test(clean)) {
        setError('NID number must be 10, 13, or 17 digits.');
        return null;
      }
      return {
        requestedValueSummary: `NID: ${clean}`,
        requestedData: {
          documentType: 'nid',
          nidNumber: clean,
        },
      };
    }

    if (fieldKey === 'nid_image') {
      if (!nidFrontUrl) {
        setError('Please upload the new NID photo. এনআইডির নতুন ছবি আপলোড করুন।');
        return null;
      }
      return {
        requestedValueSummary: nidBackUrl ? 'New NID Front & Back images' : 'New NID Front image',
        newDocumentUrl: nidFrontUrl,
        requestedData: {
          documentType: 'nid',
          nidFrontUrl,
          ...(nidBackUrl ? { nidBackUrl } : {}),
        },
      };
    }

    if (fieldKey === 'birth_certificate') {
      if (!birthCertNumber.trim() && !birthCertUrl) {
        setError('Enter new Birth Certificate number or upload photo.');
        return null;
      }
      return {
        requestedValueSummary: birthCertNumber.trim()
          ? `Cert No: ${birthCertNumber.trim()}`
          : 'New Birth Certificate Document',
        newDocumentUrl: birthCertUrl || '',
        requestedData: {
          documentType: 'birth_certificate',
          ...(birthCertNumber.trim() ? { birthCertificateNumber: birthCertNumber.trim() } : {}),
          ...(birthCertUrl ? { birthCertificateUrl: birthCertUrl } : {}),
        },
      };
    }

    if (fieldKey === 'payout') {
      if (payoutAction === 'remove') {
        const target = existingPayouts.find((p) => p.id === targetPayoutId);
        if (!target) {
          setError('Please select a payout account to remove.');
          return null;
        }
        return {
          requestedValueSummary: `Remove ${target.type} (•••• ${target.accountNumber.slice(-4)})`,
          requestedData: {},
          requestedPayoutEntry: {
            action: 'remove',
            targetPayoutId: target.id,
            type: target.type,
            accountNumber: target.accountNumber,
          },
        };
      }

      const cleanAcct = payoutAccountNumber.trim();
      if (!cleanAcct || cleanAcct.length < 6) {
        setError('Please enter a valid payout account or mobile wallet number.');
        return null;
      }
      if (payoutType !== 'Bank' && !/^01[3-9]\d{8}$/.test(cleanAcct)) {
        setError(`${payoutType} number must be a valid 11-digit BD number (01XXXXXXXXX).`);
        return null;
      }
      const bankFinal =
        payoutType === 'Bank'
          ? payoutBankName === 'Other'
            ? payoutCustomBank.trim()
            : payoutBankName
          : null;
      if (payoutType === 'Bank' && !bankFinal) {
        setError('Please specify bank name.');
        return null;
      }

      const verb = payoutAction === 'edit' ? 'Update' : 'Add';
      return {
        requestedValueSummary:
          payoutType === 'Bank'
            ? `${verb} Bank: ${bankFinal} (${cleanAcct})`
            : `${verb} ${payoutType}: ${cleanAcct}`,
        requestedData: {
          payoutMethod: payoutType.toLowerCase(),
          accountNumber: cleanAcct,
          accountHolderName: payoutAccountHolder.trim() || user.fullName || '',
        },
        requestedPayoutEntry: {
          action: payoutAction,
          ...(payoutAction === 'edit' && targetPayoutId ? { targetPayoutId } : {}),
          type: payoutType,
          accountNumber: cleanAcct,
          accountHolderName: payoutAccountHolder.trim() || user.fullName || '',
          bankName: bankFinal,
          branchName: payoutType === 'Bank' ? payoutBranchName.trim() || null : null,
          routingNumber: payoutType === 'Bank' ? payoutRoutingNumber.trim() || null : null,
          isDefault: makeDefaultPayout,
        },
      };
    }

    return null;
  };

  const handleOpenConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    const preview = buildPayloadPreview();
    if (!preview) return;
    setShowConfirmSheet(true);
  };

  const handleConfirmSubmit = async () => {
    const preview = buildPayloadPreview();
    if (!preview) {
      setShowConfirmSheet(false);
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const res = await submitLockedChangeRequest({
        user,
        fieldKey,
        oldValueMasked: maskedOldValue,
        newValue: preview.requestedValueSummary,
        newDocumentUrl: preview.newDocumentUrl || proofUrl || '',
        currentValueSummary: maskedOldValue,
        requestedValueSummary: preview.requestedValueSummary,
        currentData: {
          shopName: user.shopName || '',
          email: user.email || '',
          dob: user.dob || '',
        },
        requestedData: preview.requestedData,
        requestedPayoutEntry: preview.requestedPayoutEntry,
        reason: reason.trim(),
        proofUrl: proofUrl || preview.newDocumentUrl || '',
      });

      setShowConfirmSheet(false);
      setReason('');
      setProofUrl('');
      setNewShopName('');
      setNewEmail('');
      setNidNumber('');
      setNidFrontUrl('');
      setNidBackUrl('');
      setBirthCertNumber('');
      setBirthCertUrl('');
      setPayoutAccountNumber('');
      await loadPending();

      const label = CHANGE_REQUEST_FIELD_LABELS[fieldKey]?.en || 'Change';
      onSubmitted?.(
        `Request ${res.requestId} submitted for ${label}. Super Admin will review it shortly.`,
        res.requestId
      );
    } catch (err: any) {
      setError(err?.message || 'Could not submit request. Please try again.');
      setShowConfirmSheet(false);
    } finally {
      setSubmitting(false);
    }
  };

  const fieldLabelObj = CHANGE_REQUEST_FIELD_LABELS[fieldKey];

  return (
    <div className="space-y-3 text-[12.5px]">
      <form onSubmit={handleOpenConfirm} className="space-y-3">
        {/* Field Selector Chips */}
        <div>
          <label className="block text-[11px] font-bold text-slate-600 uppercase tracking-wider mb-1.5">
            What do you want to change? • কী পরিবর্তন করতে চান?
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {FIELD_OPTIONS.map((opt) => {
              const IconComp = opt.icon;
              const isSelected = fieldKey === opt.key;
              const isFieldPending = pendingList.some((r) => r.fieldKey === opt.key);
              const meta = CHANGE_REQUEST_FIELD_LABELS[opt.key];
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => {
                    setFieldKey(opt.key);
                    setError(null);
                  }}
                  className={`min-h-[40px] px-2.5 py-1.5 rounded-xl border text-left flex items-center gap-1.5 transition-all cursor-pointer ${
                    isSelected
                      ? 'bg-[#04203F] border-[#04203F] text-white shadow-xs'
                      : 'bg-white border-slate-200 text-slate-700 hover:border-[#0E9AA7]/60'
                  }`}
                >
                  <IconComp
                    className={`w-3.5 h-3.5 shrink-0 ${isSelected ? 'text-[#3DD055]' : 'text-[#0E9AA7]'}`}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-[11.5px] font-bold truncate leading-tight">{meta.en}</div>
                    <div
                      className={`text-[9.5px] truncate leading-tight ${
                        isSelected ? 'text-slate-300' : 'text-slate-400'
                      }`}
                    >
                      {isFieldPending ? 'Pending' : meta.bn}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Current Value (Masked) */}
        <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold text-slate-500 shrink-0">
            Current ({fieldLabelObj.en}):
          </span>
          <span className="text-[12px] font-mono font-bold text-slate-800 truncate">
            {maskedOldValue}
          </span>
        </div>

        {/* Duplicate Pending Blocker */}
        {checkingPending ? (
          <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 text-[12px] text-slate-600 flex items-center gap-2">
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[#0E9AA7]" />
            <span>Checking existing requests...</span>
          </div>
        ) : (
          pendingForField && (
            <div className="p-2.5 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 text-[11.5px] flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-bold">
                  Pending request exists ({pendingForField.requestId || pendingForField.id.slice(0, 8)})
                </p>
                <p className="text-[11px] text-amber-800">
                  Requested: {pendingForField.newValue || pendingForField.requestedValueSummary}. Cancel it in My Requests if you want to submit another.
                </p>
              </div>
            </div>
          )
        )}

        {/* Dynamic Value Inputs */}
        {fieldKey === 'shopName' && (
          <div className="space-y-1">
            <label className="block text-[12px] font-bold text-slate-700">
              New Shop Name • নতুন দোকানের নাম <span className="text-rose-500">*</span>
            </label>
            <input
              type="text"
              value={newShopName}
              onChange={(e) => setNewShopName(e.target.value)}
              placeholder="Enter new unique shop name"
              className="w-full h-10 px-3 rounded-xl border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E9AA7]/25 focus:border-[#0E9AA7]"
            />
            {shopCheck === 'checking' && (
              <p className="text-[11px] text-slate-500">Checking availability...</p>
            )}
            {shopCheck === 'available' && (
              <p className="text-[11px] text-emerald-600 font-semibold flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" /> Available
              </p>
            )}
            {shopCheck === 'taken' && (
              <p className="text-[11px] text-rose-600 font-semibold">
                Already taken — try another name
              </p>
            )}
          </div>
        )}

        {fieldKey === 'email' && (
          <div className="space-y-1">
            <label className="block text-[12px] font-bold text-slate-700">
              New Email Address • নতুন ইমেইল <span className="text-rose-500">*</span>
            </label>
            <input
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="name@example.com"
              className="w-full h-10 px-3 rounded-xl border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E9AA7]/25 focus:border-[#0E9AA7]"
            />
          </div>
        )}

        {fieldKey === 'dob' && (
          <div className="space-y-1">
            <label className="block text-[12px] font-bold text-slate-700">
              New Date of Birth • নতুন জন্ম তারিখ <span className="text-rose-500">*</span>
            </label>
            <input
              type="date"
              value={newDob}
              onChange={(e) => setNewDob(e.target.value)}
              className="w-full h-10 px-3 rounded-xl border border-slate-200 text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E9AA7]/25 focus:border-[#0E9AA7]"
            />
          </div>
        )}

        {fieldKey === 'nid' && (
          <div className="space-y-2">
            <div>
              <label className="block text-[12px] font-bold text-slate-700 mb-1">
                New NID Number (10 / 13 / 17 digits) • নতুন এনআইডি নম্বর{' '}
                <span className="text-rose-500">*</span>
              </label>
              <input
                type="text"
                inputMode="numeric"
                value={nidNumber}
                onChange={(e) => setNidNumber(e.target.value.replace(/\D/g, ''))}
                placeholder="e.g. 1995XXXXXXXXX"
                className="w-full h-10 px-3 rounded-xl border border-slate-200 font-mono text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E9AA7]/25 focus:border-[#0E9AA7]"
              />
            </div>
            <ImageUploadField
              label="NID Photo (Supporting Proof)"
              helperText="সাপোর্টিং ডকুমেন্ট (ঐচ্ছিক, ৩০ MB পর্যন্ত)"
              value={proofUrl}
              onChange={(url) => setProofUrl(url)}
              storagePath={`changeRequests/${user.uid}`}
              size="sm"
            />
          </div>
        )}

        {fieldKey === 'nid_image' && (
          <div className="space-y-2.5">
            <ImageUploadField
              label="New NID Front Photo • এনআইডি সামনের ছবি"
              required
              value={nidFrontUrl}
              onChange={(url) => setNidFrontUrl(url)}
              storagePath={`changeRequests/${user.uid}`}
              size="sm"
            />
            <ImageUploadField
              label="New NID Back Photo (Optional) • পেছনের ছবি"
              value={nidBackUrl}
              onChange={(url) => setNidBackUrl(url)}
              storagePath={`changeRequests/${user.uid}`}
              size="sm"
            />
          </div>
        )}

        {fieldKey === 'birth_certificate' && (
          <div className="space-y-2.5">
            <div>
              <label className="block text-[12px] font-bold text-slate-700 mb-1">
                New Birth Certificate Number • জন্ম নিবন্ধন নম্বর
              </label>
              <input
                type="text"
                value={birthCertNumber}
                onChange={(e) => setBirthCertNumber(e.target.value)}
                placeholder="17-digit number"
                className="w-full h-10 px-3 rounded-xl border border-slate-200 font-mono text-[13px] focus:outline-none focus:ring-2 focus:ring-[#0E9AA7]/25 focus:border-[#0E9AA7]"
              />
            </div>
            <ImageUploadField
              label="New Birth Certificate Photo • জন্ম নিবন্ধন ছবি"
              value={birthCertUrl}
              onChange={(url) => setBirthCertUrl(url)}
              storagePath={`changeRequests/${user.uid}`}
              size="sm"
            />
          </div>
        )}

        {fieldKey === 'payout' && (
          <div className="space-y-2.5">
            {/* Add / Edit / Remove mode */}
            <div className="grid grid-cols-3 gap-1.5 bg-slate-100 p-1 rounded-xl">
              {(
                [
                  { id: 'add', label: 'Add New' },
                  { id: 'edit', label: 'Edit Existing', disabled: existingPayouts.length === 0 },
                  { id: 'remove', label: 'Remove', disabled: existingPayouts.length === 0 },
                ] as const
              ).map((act) => (
                <button
                  key={act.id}
                  type="button"
                  disabled={'disabled' in act && Boolean(act.disabled)}
                  onClick={() => setPayoutAction(act.id)}
                  className={`h-8 rounded-lg text-[11.5px] font-bold transition cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                    payoutAction === act.id
                      ? 'bg-white text-[#04203F] shadow-2xs'
                      : 'text-slate-600'
                  }`}
                >
                  {act.label}
                </button>
              ))}
            </div>

            {payoutAction !== 'add' && existingPayouts.length > 0 && (
              <div>
                <label className="block text-[11.5px] font-bold text-slate-700 mb-1">
                  Select Existing Payout Account
                </label>
                <select
                  value={targetPayoutId}
                  onChange={(e) => setTargetPayoutId(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-[12.5px]"
                >
                  {existingPayouts.map((pm) => (
                    <option key={pm.id} value={pm.id}>
                      {pm.type} — •••• {pm.accountNumber.slice(-4)}
                      {pm.isDefault ? ' (Default)' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {payoutAction !== 'remove' && (
              <>
                <div className="grid grid-cols-5 gap-1">
                  {(['bKash', 'Nagad', 'Rocket', 'Upay', 'Bank'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setPayoutType(m)}
                      className={`h-9 rounded-lg border text-[11px] font-bold cursor-pointer ${
                        payoutType === m
                          ? 'bg-[#0E9AA7] border-[#0E9AA7] text-white'
                          : 'bg-white border-slate-200 text-slate-700'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[11.5px] font-bold text-slate-700 mb-1">
                      Account / Mobile Number <span className="text-rose-500">*</span>
                    </label>
                    <input
                      type="text"
                      value={payoutAccountNumber}
                      onChange={(e) => setPayoutAccountNumber(e.target.value)}
                      placeholder={payoutType === 'Bank' ? 'Account No' : '01XXXXXXXXX'}
                      className="w-full h-10 px-3 rounded-xl border border-slate-200 font-mono text-[12.5px]"
                    />
                  </div>
                  <div>
                    <label className="block text-[11.5px] font-bold text-slate-700 mb-1">
                      Account Holder Name
                    </label>
                    <input
                      type="text"
                      value={payoutAccountHolder}
                      onChange={(e) => setPayoutAccountHolder(e.target.value)}
                      className="w-full h-10 px-3 rounded-xl border border-slate-200 text-[12.5px]"
                    />
                  </div>
                </div>

                {payoutType === 'Bank' && (
                  <div className="space-y-2">
                    <select
                      value={payoutBankName}
                      onChange={(e) => setPayoutBankName(e.target.value)}
                      className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white text-[12.5px]"
                    >
                      {BD_BANKS.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                    {payoutBankName === 'Other' && (
                      <input
                        type="text"
                        value={payoutCustomBank}
                        onChange={(e) => setPayoutCustomBank(e.target.value)}
                        placeholder="Enter bank name"
                        className="w-full h-10 px-3 rounded-xl border border-slate-200 text-[12.5px]"
                      />
                    )}
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={payoutBranchName}
                        onChange={(e) => setPayoutBranchName(e.target.value)}
                        placeholder="Branch name"
                        className="w-full h-10 px-3 rounded-xl border border-slate-200 text-[12.5px]"
                      />
                      <input
                        type="text"
                        value={payoutRoutingNumber}
                        onChange={(e) => setPayoutRoutingNumber(e.target.value)}
                        placeholder="Routing number"
                        className="w-full h-10 px-3 rounded-xl border border-slate-200 font-mono text-[12.5px]"
                      />
                    </div>
                  </div>
                )}

                <label className="inline-flex items-center gap-2 text-[11.5px] font-semibold text-slate-700 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={makeDefaultPayout}
                    onChange={(e) => setMakeDefaultPayout(e.target.checked)}
                    className="w-4 h-4 rounded accent-[#0E9AA7]"
                  />
                  <span>Set as default payout method</span>
                </label>
              </>
            )}
          </div>
        )}

        {/* Reason (Always required) */}
        <div>
          <label className="block text-[12px] font-bold text-slate-700 mb-1">
            Reason for Change • পরিবর্তনের কারণ <span className="text-rose-500">*</span>
          </label>
          <textarea
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Explain why you need this update..."
            className="w-full px-3 py-2 rounded-xl border border-slate-200 text-[12.5px] resize-none focus:outline-none focus:ring-2 focus:ring-[#0E9AA7]/25 focus:border-[#0E9AA7]"
          />
        </div>

        {/* Supporting Document (if not already an image field) */}
        {fieldKey !== 'nid_image' && fieldKey !== 'birth_certificate' && fieldKey !== 'nid' && (
          <ImageUploadField
            label="Supporting Proof (Optional) • সাপোর্টিং ছবি"
            helperText="Gallery or camera (up to 30 MB, compressed automatically)"
            value={proofUrl}
            onChange={(url) => setProofUrl(url)}
            storagePath={`changeRequests/${user.uid}`}
            size="xs"
          />
        )}

        {error && (
          <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-[12px] font-semibold flex items-start gap-2">
            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-1">
          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="h-10 px-4 rounded-xl border border-slate-200 bg-white text-slate-700 text-[12.5px] font-bold hover:bg-slate-50 cursor-pointer"
            >
              Cancel
            </button>
          )}
          <button
            type="submit"
            disabled={Boolean(pendingForField) || submitting || shopCheck === 'taken'}
            className="h-10 px-4 rounded-xl bg-[#04203F] hover:bg-[#0B2D52] disabled:bg-slate-200 disabled:text-slate-400 text-white text-[12.5px] font-bold flex items-center gap-1.5 cursor-pointer disabled:cursor-not-allowed transition"
          >
            <Send className="w-3.5 h-3.5" />
            <span>Review & Submit • আবেদন করুন</span>
          </button>
        </div>
      </form>

      {/* Confirm Sheet */}
      {showConfirmSheet && (
        <div
          className="fixed inset-0 z-[80] bg-slate-900/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => !submitting && setShowConfirmSheet(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white rounded-t-2xl sm:rounded-2xl p-4 space-y-3 shadow-2xl border border-slate-200"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-5 h-5 text-[#0E9AA7]" />
                <h4 className="text-[15px] font-bold text-[#04203F]">
                  Confirm Change Request
                </h4>
              </div>
              <button
                type="button"
                disabled={submitting}
                onClick={() => setShowConfirmSheet(false)}
                className="p-1 text-slate-400 hover:text-slate-700 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="rounded-xl bg-slate-50 border border-slate-200 p-3 space-y-1.5 text-[12px]">
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Field:</span>
                <span className="font-bold text-slate-900">{fieldLabelObj.en}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">Current:</span>
                <span className="font-mono text-slate-700 truncate">{maskedOldValue}</span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-slate-500">New:</span>
                <span className="font-bold text-[#04203F] text-right">
                  {buildPayloadPreview()?.requestedValueSummary}
                </span>
              </div>
              <div className="pt-1 border-t border-slate-200">
                <span className="text-slate-500 block">Reason:</span>
                <span className="text-slate-800">{reason.trim()}</span>
              </div>
            </div>

            <p className="text-[11px] text-slate-500">
              Your existing verified value stays active until Super Admin approves this request.
            </p>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={submitting}
                onClick={() => setShowConfirmSheet(false)}
                className="flex-1 h-10 rounded-xl border border-slate-200 text-slate-700 font-bold text-[12.5px] cursor-pointer"
              >
                Edit
              </button>
              <button
                type="button"
                disabled={submitting}
                onClick={handleConfirmSubmit}
                className="flex-1 h-10 rounded-xl bg-[#04203F] hover:bg-[#0B2D52] text-white font-bold text-[12.5px] flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
              >
                {submitting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Submitting...</span>
                  </>
                ) : (
                  <span>Confirm Submit</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
