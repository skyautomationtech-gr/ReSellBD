import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  CreditCard,
  FileText,
  Loader2,
  Lock,
  Mail,
  Send,
  ShieldAlert,
  Store,
  Calendar,
  X,
} from 'lucide-react';
import { ChangeRequestFieldKey, UserProfile } from '../../types';
import {
  CHANGE_REQUEST_FIELD_LABELS,
  LOCKED_FIELD_NOTICE_BN,
  LOCKED_FIELD_NOTICE_EN,
  fetchPendingChangeRequests,
  submitLockedChangeRequest,
} from '../../lib/lockedFieldsService';
import { checkShopNameAvailability } from '../../lib/shopNameService';
import { normalizeShopName } from '../../utils/shopName';
import { ImageUploadField } from './ImageUploadField';

interface ChangeRequestModalProps {
  isOpen: boolean;
  onClose: () => void;
  user: UserProfile;
  initialField?: ChangeRequestFieldKey;
  onSubmitted?: (message: string) => void;
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

export const ChangeRequestModal: React.FC<ChangeRequestModalProps> = ({
  isOpen,
  onClose,
  user,
  initialField = 'shopName',
  onSubmitted,
}) => {
  const [fieldKey, setFieldKey] = useState<ChangeRequestFieldKey>(initialField);
  const [hasPending, setHasPending] = useState(false);
  const [checkingPending, setCheckingPending] = useState(false);

  // Field-specific values
  const [newShopName, setNewShopName] = useState(user.shopName || '');
  const [shopCheck, setShopCheck] = useState<'idle' | 'checking' | 'available' | 'taken'>('idle');
  const [newEmail, setNewEmail] = useState('');
  const [newDob, setNewDob] = useState(user.dob || '');
  const [nidNumber, setNidNumber] = useState(user.nidNumber || '');
  const [nidFrontUrl, setNidFrontUrl] = useState('');
  const [nidBackUrl, setNidBackUrl] = useState('');
  const [birthCertNumber, setBirthCertNumber] = useState(user.birthCertificateNumber || '');
  const [birthCertUrl, setBirthCertUrl] = useState('');

  // Payout fields
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setFieldKey(initialField);
    setNewShopName(user.shopName || '');
    setNewEmail('');
    setNewDob(user.dob || '');
    setNidNumber(user.nidNumber || '');
    setNidFrontUrl('');
    setNidBackUrl('');
    setBirthCertNumber(user.birthCertificateNumber || '');
    setBirthCertUrl('');
    setPayoutAccountNumber('');
    setPayoutAccountHolder(user.accountHolderName || user.fullName || '');
    setReason('');
    setProofUrl('');
    setError(null);
    setSuccessMsg(null);
  }, [isOpen, initialField, user]);

  useEffect(() => {
    if (!isOpen || !user.uid) return;
    let cancelled = false;
    setCheckingPending(true);
    fetchPendingChangeRequests(user.uid)
      .then((list) => {
        if (!cancelled) {
          setHasPending(list.some((item) => item.fieldKey === fieldKey));
        }
      })
      .catch(() => {
        if (!cancelled) setHasPending(false);
      })
      .finally(() => {
        if (!cancelled) setCheckingPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, user.uid, fieldKey]);

  useEffect(() => {
    if (!isOpen || fieldKey !== 'shopName') {
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
    }, 500);
    return () => clearTimeout(timer);
  }, [isOpen, fieldKey, newShopName, user.shopName, user.uid]);

  if (!isOpen) return null;

  const getCurrentSummary = (): string => {
    switch (fieldKey) {
      case 'shopName':
        return user.shopName || 'Not set';
      case 'email':
        return user.email || 'Not set';
      case 'dob':
        return user.dob || 'Not set';
      case 'nid':
        return user.nidNumber ? `NID: ${user.nidNumber}` : user.nidFrontUrl ? 'NID submitted' : 'Not submitted';
      case 'birth_certificate':
        return user.birthCertificateNumber
          ? `Cert #: ${user.birthCertificateNumber}`
          : user.birthCertificateUrl
          ? 'Birth certificate submitted'
          : 'Not submitted';
      case 'payout': {
        const list = user.payoutMethods || [];
        const def = list.find((m) => m.isDefault) || list[0];
        if (def) return `${def.type}: ${def.accountNumber}`;
        if (user.accountNumber) return `${(user.payoutMethod || 'payout').toUpperCase()}: ${user.accountNumber}`;
        return 'No payout account on file';
      }
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (hasPending) {
      setError('You already have a pending change request for this section.');
      return;
    }
    if (!reason.trim() || reason.trim().length < 5) {
      setError('Please provide a clear reason (at least 5 characters) for this change.');
      return;
    }

    let requestedData: Record<string, any> = {};
    let requestedValueSummary = '';
    let requestedPayoutEntry: any = undefined;

    if (fieldKey === 'shopName') {
      const clean = newShopName.trim();
      if (clean.length < 2) {
        setError('Shop name must be at least 2 characters.');
        return;
      }
      if (normalizeShopName(clean) === normalizeShopName(user.shopName || '')) {
        setError('Please enter a different shop name.');
        return;
      }
      if (shopCheck === 'taken') {
        setError('That shop name is already taken by another reseller.');
        return;
      }
      requestedData = { shopName: clean };
      requestedValueSummary = clean;
    } else if (fieldKey === 'email') {
      const cleanEmail = newEmail.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
        setError('Please enter a valid email address.');
        return;
      }
      if (cleanEmail === (user.email || '').trim().toLowerCase()) {
        setError('New email must be different from your current email.');
        return;
      }
      requestedData = { email: cleanEmail };
      requestedValueSummary = cleanEmail;
    } else if (fieldKey === 'dob') {
      if (!newDob) {
        setError('Please select the correct date of birth.');
        return;
      }
      if (!proofUrl) {
        setError('Please upload a supporting ID/Birth Certificate photo to verify Date of Birth.');
        return;
      }
      requestedData = { dob: newDob };
      requestedValueSummary = newDob;
    } else if (fieldKey === 'nid') {
      const cleanNid = nidNumber.trim();
      if (!cleanNid && !nidFrontUrl) {
        setError('Enter the corrected NID number or upload a new NID photo.');
        return;
      }
      requestedData = {
        documentType: 'nid',
        ...(cleanNid ? { nidNumber: cleanNid } : {}),
        ...(nidFrontUrl ? { nidFrontUrl, nidUrl: nidFrontUrl } : {}),
        ...(nidBackUrl ? { nidBackUrl } : {}),
      };
      requestedValueSummary = [
        cleanNid ? `NID: ${cleanNid}` : null,
        nidFrontUrl ? 'New Front Photo' : null,
        nidBackUrl ? 'New Back Photo' : null,
      ]
        .filter(Boolean)
        .join(' • ');
    } else if (fieldKey === 'birth_certificate') {
      const cleanCert = birthCertNumber.trim();
      if (!cleanCert && !birthCertUrl) {
        setError('Enter the Birth Certificate number or upload a clear Birth Certificate photo.');
        return;
      }
      requestedData = {
        documentType: 'birth_certificate',
        ...(cleanCert ? { birthCertificateNumber: cleanCert } : {}),
        ...(birthCertUrl ? { birthCertificateUrl: birthCertUrl, nidUrl: birthCertUrl } : {}),
      };
      requestedValueSummary = [
        cleanCert ? `Cert #: ${cleanCert}` : null,
        birthCertUrl ? 'New Document Photo' : null,
      ]
        .filter(Boolean)
        .join(' • ');
    } else if (fieldKey === 'payout') {
      const cleanAcc = payoutAccountNumber.trim();
      if (payoutType !== 'Bank' && !/^01\d{9}$/.test(cleanAcc)) {
        setError(`Enter a valid 11-digit ${payoutType} number starting with 01.`);
        return;
      }
      if (payoutType === 'Bank') {
        const finalBank = payoutBankName === 'Other' ? payoutCustomBank.trim() : payoutBankName;
        if (!finalBank || !cleanAcc || !payoutAccountHolder.trim()) {
          setError('Bank name, account holder name, and account number are required.');
          return;
        }
        requestedPayoutEntry = {
          id: `pm_${Date.now().toString(36)}`,
          type: 'Bank',
          accountNumber: cleanAcc,
          accountHolderName: payoutAccountHolder.trim(),
          bankName: finalBank,
          branchName: payoutBranchName.trim() || null,
          routingNumber: payoutRoutingNumber.trim() || null,
          isDefault: makeDefaultPayout,
          verified: true,
          payoutVerified: 'verified',
        };
        requestedValueSummary = `Bank (${finalBank}) • ${cleanAcc}`;
      } else {
        requestedPayoutEntry = {
          id: `pm_${Date.now().toString(36)}`,
          type: payoutType,
          accountNumber: cleanAcc,
          accountHolderName: payoutAccountHolder.trim() || user.fullName || '',
          isDefault: makeDefaultPayout,
          verified: true,
          payoutVerified: 'verified',
        };
        requestedValueSummary = `${payoutType} • ${cleanAcc}${makeDefaultPayout ? ' (Default)' : ''}`;
      }
      requestedData = {
        payoutMethod: payoutType.toLowerCase(),
        accountNumber: cleanAcc,
        accountHolderName: payoutAccountHolder.trim() || user.fullName || '',
      };
    }

    setSubmitting(true);
    try {
      await submitLockedChangeRequest({
        user,
        fieldKey,
        currentValueSummary: getCurrentSummary(),
        requestedValueSummary,
        requestedData,
        requestedPayoutEntry,
        reason,
        proofUrl,
      });

      const okText = `Your ${CHANGE_REQUEST_FIELD_LABELS[fieldKey].en} change request has been sent to Super Admin for review.`;
      setSuccessMsg(okText);
      onSubmitted?.(okText);
      setTimeout(() => {
        onClose();
      }, 1500);
    } catch (err: any) {
      setError(err?.message || 'Failed to submit change request.');
    } finally {
      setSubmitting(false);
    }
  };

  const fieldTabs: Array<{ key: ChangeRequestFieldKey; label: string; icon: React.ReactNode }> = [
    { key: 'shopName', label: 'Shop Name', icon: <Store className="w-3.5 h-3.5" /> },
    { key: 'email', label: 'Email', icon: <Mail className="w-3.5 h-3.5" /> },
    { key: 'dob', label: 'Birth Date', icon: <Calendar className="w-3.5 h-3.5" /> },
    { key: 'nid', label: 'NID', icon: <FileText className="w-3.5 h-3.5" /> },
    { key: 'birth_certificate', label: 'Birth Cert', icon: <FileText className="w-3.5 h-3.5" /> },
    { key: 'payout', label: 'Payout', icon: <CreditCard className="w-3.5 h-3.5" /> },
  ];

  return (
    <div className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/65 backdrop-blur-xs">
      <div className="w-full max-w-lg bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl border border-slate-200 max-h-[90vh] flex flex-col overflow-hidden text-xs">
        {/* Header */}
        <div className="px-4 py-3.5 bg-[#04203F] text-white flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-8 h-8 rounded-xl bg-white/10 border border-white/20 flex items-center justify-center text-[#3DD055] shrink-0">
              <Lock className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-[14px] font-bold leading-tight">Request a Change (পরিবর্তনের আবেদন)</h3>
              <p className="text-[10.5px] text-slate-300 truncate">
                Reviewed exclusively by Super Admin
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg bg-white/10 hover:bg-white/20 text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <form onSubmit={handleSubmit} className="p-4 space-y-3.5 overflow-y-auto flex-1">
          {/* Bilingual Security Notice */}
          <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-900 space-y-1">
            <p className="font-bold text-[11px] flex items-center gap-1.5">
              <ShieldAlert className="w-3.5 h-3.5 text-amber-600 shrink-0" />
              <span>{LOCKED_FIELD_NOTICE_EN}</span>
            </p>
            <p className="text-[10.5px] text-amber-800">{LOCKED_FIELD_NOTICE_BN}</p>
          </div>

          {/* Field Switcher */}
          <div>
            <label className="block text-[10px] font-bold text-slate-500 uppercase mb-1.5">
              Which locked information needs updating?
            </label>
            <div className="flex flex-wrap gap-1.5">
              {fieldTabs.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => {
                    setFieldKey(tab.key);
                    setError(null);
                  }}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-[11px] font-bold border transition-all cursor-pointer ${
                    fieldKey === tab.key
                      ? 'bg-[#04203F] text-white border-[#04203F] shadow-xs'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {tab.icon}
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Current Value Summary */}
          <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-2">
            <span className="text-[11px] font-semibold text-slate-500">Current on file:</span>
            <span className="text-[11.5px] font-bold text-slate-800 font-mono truncate max-w-[65%]">
              {getCurrentSummary()}
            </span>
          </div>

          {checkingPending && (
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-[#0E9AA7]" />
              <span>Checking existing requests...</span>
            </div>
          )}

          {hasPending && (
            <div className="p-3 rounded-xl bg-blue-50 border border-blue-200 text-blue-900 text-[11px] font-semibold">
              You already have a pending request for{' '}
              <strong>{CHANGE_REQUEST_FIELD_LABELS[fieldKey].en}</strong> waiting for Super Admin review.
            </div>
          )}

          {error && (
            <div className="p-2.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-[11px] font-semibold flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {successMsg && (
            <div className="p-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-[11px] font-bold flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {/* Field-specific inputs */}
          {fieldKey === 'shopName' && (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold text-slate-700">New Requested Shop Name *</label>
              <input
                type="text"
                value={newShopName}
                onChange={(e) => setNewShopName(e.target.value)}
                placeholder="Enter unique new shop name"
                className="w-full h-9 px-3 rounded-xl border border-slate-300 bg-slate-50 text-xs font-semibold outline-none focus:ring-2 focus:ring-[#0E9AA7]"
                required
              />
              {shopCheck === 'checking' && (
                <p className="text-[10.5px] text-amber-600">Checking shop name availability...</p>
              )}
              {shopCheck === 'available' && (
                <p className="text-[10.5px] text-emerald-600 font-semibold">Shop name is available.</p>
              )}
              {shopCheck === 'taken' && (
                <p className="text-[10.5px] text-rose-600 font-semibold">
                  This shop name is already taken.
                </p>
              )}
            </div>
          )}

          {fieldKey === 'email' && (
            <div className="space-y-1.5">
              <label className="block text-[11px] font-bold text-slate-700">New Email Address *</label>
              <input
                type="email"
                value={newEmail}
                onChange={(e) => setNewEmail(e.target.value)}
                placeholder="newemail@example.com"
                className="w-full h-9 px-3 rounded-xl border border-slate-300 bg-slate-50 text-xs font-mono outline-none focus:ring-2 focus:ring-[#0E9AA7]"
                required
              />
              <p className="text-[10px] text-slate-500">
                When approved by Super Admin, your login email updates and notifications will be sent to both addresses.
              </p>
            </div>
          )}

          {fieldKey === 'dob' && (
            <div className="space-y-2.5">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Correct Date of Birth *
                </label>
                <input
                  type="date"
                  value={newDob}
                  onChange={(e) => setNewDob(e.target.value)}
                  className="w-full h-9 px-3 rounded-xl border border-slate-300 bg-slate-50 text-xs font-mono outline-none focus:ring-2 focus:ring-[#0E9AA7]"
                  required
                />
              </div>
              <ImageUploadField
                label="Supporting Document Photo (NID / Birth Certificate) *"
                value={proofUrl}
                onChange={(url) => setProofUrl(url)}
                storagePath={`changeRequests/${user.uid}`}
                theme="light"
                size="sm"
                placeholderText="প্রমাণপত্র"
                helperText="Upload clear proof matching the requested Date of Birth"
              />
            </div>
          )}

          {fieldKey === 'nid' && (
            <div className="space-y-2.5">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Corrected NID Number
                </label>
                <input
                  type="text"
                  value={nidNumber}
                  onChange={(e) => setNidNumber(e.target.value)}
                  placeholder="Enter 10 or 17 digit NID number"
                  className="w-full h-9 px-3 rounded-xl border border-slate-300 bg-slate-50 text-xs font-mono outline-none focus:ring-2 focus:ring-[#0E9AA7]"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <ImageUploadField
                  label="New NID Front Photo"
                  value={nidFrontUrl}
                  onChange={(url) => setNidFrontUrl(url)}
                  storagePath={`changeRequests/${user.uid}`}
                  theme="light"
                  size="sm"
                  placeholderText="NID সামনের অংশ"
                />
                <ImageUploadField
                  label="New NID Back Photo"
                  value={nidBackUrl}
                  onChange={(url) => setNidBackUrl(url)}
                  storagePath={`changeRequests/${user.uid}`}
                  theme="light"
                  size="sm"
                  placeholderText="NID পেছনের অংশ"
                />
              </div>
            </div>
          )}

          {fieldKey === 'birth_certificate' && (
            <div className="space-y-2.5">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Birth Certificate Number
                </label>
                <input
                  type="text"
                  value={birthCertNumber}
                  onChange={(e) => setBirthCertNumber(e.target.value)}
                  placeholder="Enter 17-digit Birth Registration number"
                  className="w-full h-9 px-3 rounded-xl border border-slate-300 bg-slate-50 text-xs font-mono outline-none focus:ring-2 focus:ring-[#0E9AA7]"
                />
              </div>
              <ImageUploadField
                label="New Birth Certificate Photo"
                value={birthCertUrl}
                onChange={(url) => setBirthCertUrl(url)}
                storagePath={`changeRequests/${user.uid}`}
                theme="light"
                size="sm"
                placeholderText="জন্ম নিবন্ধন"
              />
            </div>
          )}

          {fieldKey === 'payout' && (
            <div className="space-y-2.5">
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Payout Method *
                </label>
                <div className="grid grid-cols-5 gap-1.5">
                  {(['bKash', 'Nagad', 'Rocket', 'Upay', 'Bank'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setPayoutType(m)}
                      className={`py-2 rounded-xl text-[11px] font-bold border transition-all cursor-pointer ${
                        payoutType === m
                          ? 'bg-[#0E9AA7] text-white border-[#0E9AA7]'
                          : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  {payoutType === 'Bank' ? 'Account Holder Name *' : 'Account Holder Name'}
                </label>
                <input
                  type="text"
                  value={payoutAccountHolder}
                  onChange={(e) => setPayoutAccountHolder(e.target.value)}
                  placeholder="Legal name matching account"
                  className="w-full h-9 px-3 rounded-xl border border-slate-300 bg-slate-50 text-xs font-semibold outline-none focus:ring-2 focus:ring-[#0E9AA7]"
                />
              </div>

              {payoutType === 'Bank' && (
                <>
                  <div>
                    <label className="block text-[11px] font-bold text-slate-700 mb-1">
                      Bank Name *
                    </label>
                    <select
                      value={payoutBankName}
                      onChange={(e) => setPayoutBankName(e.target.value)}
                      className="w-full h-9 px-3 rounded-xl border border-slate-300 bg-slate-50 text-xs font-semibold outline-none"
                    >
                      {BD_BANKS.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </div>
                  {payoutBankName === 'Other' && (
                    <input
                      type="text"
                      value={payoutCustomBank}
                      onChange={(e) => setPayoutCustomBank(e.target.value)}
                      placeholder="Enter custom bank name"
                      className="w-full h-9 px-3 rounded-xl border border-slate-300 bg-slate-50 text-xs font-semibold outline-none"
                    />
                  )}
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">Branch</label>
                      <input
                        type="text"
                        value={payoutBranchName}
                        onChange={(e) => setPayoutBranchName(e.target.value)}
                        placeholder="Branch name"
                        className="w-full h-9 px-3 rounded-xl border border-slate-300 bg-slate-50 text-xs outline-none"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-bold text-slate-700 mb-1">Routing #</label>
                      <input
                        type="text"
                        value={payoutRoutingNumber}
                        onChange={(e) => setPayoutRoutingNumber(e.target.value)}
                        placeholder="Optional"
                        className="w-full h-9 px-3 rounded-xl border border-slate-300 bg-slate-50 text-xs font-mono outline-none"
                      />
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  {payoutType === 'Bank' ? 'Bank Account Number *' : `${payoutType} Number (11 digits) *`}
                </label>
                <input
                  type="text"
                  value={payoutAccountNumber}
                  onChange={(e) => setPayoutAccountNumber(e.target.value)}
                  placeholder={payoutType === 'Bank' ? 'Account number' : '01XXXXXXXXX'}
                  className="w-full h-9 px-3 rounded-xl border border-slate-300 bg-slate-50 text-xs font-mono outline-none focus:ring-2 focus:ring-[#0E9AA7]"
                  required
                />
              </div>

              <label className="flex items-center gap-2 text-[11px] font-semibold text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={makeDefaultPayout}
                  onChange={(e) => setMakeDefaultPayout(e.target.checked)}
                  className="rounded border-slate-300 text-[#0E9AA7] focus:ring-[#0E9AA7]"
                />
                <span>Set as default payout method when approved</span>
              </label>
            </div>
          )}

          {/* Reason & Optional Proof */}
          <div>
            <label className="block text-[11px] font-bold text-slate-700 mb-1">
              Reason for Change *
            </label>
            <textarea
              rows={2}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Explain why this verified detail needs to be updated..."
              className="w-full p-2.5 rounded-xl border border-slate-300 bg-slate-50 text-xs outline-none focus:ring-2 focus:ring-[#0E9AA7]"
              required
            />
          </div>

          {fieldKey !== 'dob' && (
            <ImageUploadField
              label="Supporting Proof / Screenshot (Optional)"
              value={proofUrl}
              onChange={(url) => setProofUrl(url)}
              storagePath={`changeRequests/${user.uid}`}
              theme="light"
              size="xs"
              placeholderText="প্রমাণপত্র"
            />
          )}

          {/* Submit Row */}
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || hasPending || shopCheck === 'taken'}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#04203F] hover:bg-[#0E9AA7] text-white font-bold shadow-xs transition-colors disabled:opacity-50 cursor-pointer"
            >
              {submitting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5" />
              )}
              <span>{submitting ? 'Submitting...' : 'Submit Change Request'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
