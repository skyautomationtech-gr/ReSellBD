import React, { useState, useEffect } from 'react';
import { doc, getDoc, runTransaction, serverTimestamp, updateDoc } from 'firebase/firestore';
import { auth, db } from '../../lib/firebase';
import { PayoutMethod, UserProfile, UserRole, UserStatus } from '../../types';
import { formatResellerId, generateRandomResellerSuffix } from '../../lib/resellerIdHelper';
import { ADMIN_PERMISSIONS_LIST } from '../../lib/adminManagementService';
import {
  sendResellerPasswordResetCall,
  setResellerTemporaryPasswordCall,
  updateResellerLockedFieldsCall,
} from '../../lib/lockedFieldsService';
import { notifyResellerStatusEmail } from '../../lib/resellerStatusEmailService';
import { 
  X, Shield, User, Store, Phone, Mail, MapPin, CreditCard, 
  Percent, FileText, CheckCircle2, AlertCircle, Key, Lock,
  Building2, Landmark, Smartphone, Save, MessageCircle, Tag, Loader2, Send, Copy, Plus, Trash2
} from 'lucide-react';
import { checkShopNameAvailability } from '../../lib/shopNameService';
import { normalizeShopName } from '../../utils/shopName';
import { ImageUploadField } from '../common/ImageUploadField';

import { fetchUserLoginHistory, LoginHistoryItem } from '../../lib/deviceSecurity';

const SOLE_SUPER_ADMIN_EMAIL = 'skyautomationtech@gmail.com';

interface EditUserModalProps {
  isOpen: boolean;
  onClose: () => void;
  targetUser: UserProfile | null;
  currentUser?: UserProfile;
  onUserUpdated: () => void;
}

export const EditUserModal: React.FC<EditUserModalProps> = ({
  isOpen,
  onClose,
  targetUser,
  currentUser,
  onUserUpdated,
}) => {
  const isSuperAdmin = currentUser?.role === 'super_admin';

  const [formData, setFormData] = useState({
    fullName: '',
    shopName: '',
    mobile: '',
    whatsappNumber: '',
    email: '',
    role: 'reseller' as UserRole,
    status: 'approved' as UserStatus,
    rejectReason: '',
    division: '',
    district: '',
    upazila: '',
    address: '',
    dob: '',
    documentType: 'nid' as 'nid' | 'birth_certificate',
    nidNumber: '',
    nidUrl: '',
    nidFrontUrl: '',
    nidBackUrl: '',
    birthCertificateNumber: '',
    birthCertificateUrl: '',
    profilePhotoUrl: '',
    shopPhotoUrl: '',
    customCommissionRate: '',
    payoutMethod: 'bkash' as 'bkash' | 'nagad' | 'rocket' | 'bank' | 'upay',
    accountHolderName: '',
    bankName: '',
    branchName: '',
    routingNumber: '',
    accountNumber: '',
    bkashNumber: '',
    nagadNumber: '',
    rocketNumber: '',
    upayNumber: '',
    adminNotes: '',
  });

  const [payoutMethodsList, setPayoutMethodsList] = useState<PayoutMethod[]>([]);
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [activeTab, setActiveTab] = useState<'profile' | 'location' | 'financial' | 'documents' | 'security'>('profile');
  const [userLogins, setUserLogins] = useState<LoginHistoryItem[]>([]);
  const [loadingLogins, setLoadingLogins] = useState(false);

  // Super Admin Password Management (Strictly in memory, cleared on close/target change)
  const [sendingResetLink, setSendingResetLink] = useState(false);
  const [resetLinkStatus, setResetLinkStatus] = useState<string | null>(null);
  const [customTempPassword, setCustomTempPassword] = useState('');
  const [settingTempPassword, setSettingTempPassword] = useState(false);
  const [generatedTempPassword, setGeneratedTempPassword] = useState<string | null>(null);
  const [copiedTempPass, setCopiedTempPass] = useState(false);
  const [passwordMgmtError, setPasswordMgmtError] = useState<string | null>(null);

  // Live shop name check state
  const [shopNameCheck, setShopNameCheck] = useState<{
    status: 'idle' | 'checking' | 'available' | 'taken';
    message: string;
  }>({ status: 'idle', message: '' });

  useEffect(() => {
    const raw = (formData.shopName || '').trim();
    if (!raw || raw.length < 2 || !targetUser) {
      setShopNameCheck({ status: 'idle', message: '' });
      return;
    }
    // If same as target user's current shop name, allow
    if (normalizeShopName(raw) === normalizeShopName(targetUser.shopName || '')) {
      setShopNameCheck({ status: 'available', message: 'Current name' });
      return;
    }

    setShopNameCheck({ status: 'checking', message: 'Checking...' });
    const timer = setTimeout(async () => {
      try {
        const res = await checkShopNameAvailability(raw, targetUser.uid);
        if (res.available) {
          setShopNameCheck({ status: 'available', message: 'Shop name is available' });
        } else {
          setShopNameCheck({ status: 'taken', message: 'This shop name is already taken. Please choose a different name.' });
        }
      } catch (_e) {
        setShopNameCheck({ status: 'idle', message: '' });
      }
    }, 600);

    return () => clearTimeout(timer);
  }, [formData.shopName, targetUser]);

  useEffect(() => {
    if (targetUser && activeTab === 'security') {
      setLoadingLogins(true);
      fetchUserLoginHistory(targetUser.uid)
        .then(setUserLogins)
        .finally(() => setLoadingLogins(false));
    }
  }, [targetUser, activeTab]);

  useEffect(() => {
    if (targetUser) {
      setFormData({
        fullName: targetUser.fullName || '',
        shopName: targetUser.shopName || '',
        mobile: targetUser.mobile || '',
        whatsappNumber: targetUser.whatsappNumber || targetUser.mobile || '',
        email: targetUser.email || '',
        role: targetUser.role || 'reseller',
        status: targetUser.status || 'approved',
        rejectReason: targetUser.rejectReason || '',
        division: targetUser.division || '',
        district: targetUser.district || '',
        upazila: targetUser.upazila || '',
        address: targetUser.address || '',
        dob: targetUser.dob || '',
        documentType: targetUser.documentType || 'nid',
        nidNumber: targetUser.nidNumber || '',
        nidUrl: targetUser.nidUrl || '',
        nidFrontUrl: targetUser.nidFrontUrl || targetUser.nidUrl || '',
        nidBackUrl: targetUser.nidBackUrl || '',
        birthCertificateNumber: targetUser.birthCertificateNumber || '',
        birthCertificateUrl: targetUser.birthCertificateUrl || '',
        profilePhotoUrl: targetUser.profilePhotoUrl || '',
        shopPhotoUrl: targetUser.shopPhotoUrl || '',
        customCommissionRate: targetUser.customCommissionRate !== undefined ? String(targetUser.customCommissionRate) : '',
        payoutMethod: targetUser.payoutMethod || 'bkash',
        accountHolderName: targetUser.accountHolderName || targetUser.fullName || '',
        bankName: targetUser.bankName || '',
        branchName: targetUser.branchName || '',
        routingNumber: targetUser.routingNumber || '',
        accountNumber: targetUser.accountNumber || '',
        bkashNumber: targetUser.bkashNumber || '',
        nagadNumber: targetUser.nagadNumber || '',
        rocketNumber: targetUser.rocketNumber || '',
        upayNumber: targetUser.upayNumber || '',
        adminNotes: targetUser.adminNotes || '',
      });
      setPayoutMethodsList(Array.isArray(targetUser.payoutMethods) ? targetUser.payoutMethods : []);
      setGeneratedTempPassword(null);
      setCustomTempPassword('');
      setResetLinkStatus(null);
      setPasswordMgmtError(null);
      setCopiedTempPass(false);
      setSuccessMsg('');
      setErrorMsg('');
    }
  }, [targetUser, isOpen]);

  if (!isOpen || !targetUser) return null;

  const isTargetSoleSuperAdmin =
    (targetUser.email || '').toLowerCase().trim() === SOLE_SUPER_ADMIN_EMAIL;

  const handleCloseClean = () => {
    setGeneratedTempPassword(null);
    setCustomTempPassword('');
    setPasswordMgmtError(null);
    setResetLinkStatus(null);
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isSuperAdmin) {
      setErrorMsg('Only Super Admin is authorized to edit Reseller & Admin details.');
      return;
    }

    if (shopNameCheck.status === 'taken') {
      setErrorMsg('This shop name is already taken. Please choose a different name.');
      return;
    }

    setSaving(true);
    setSuccessMsg('');
    setErrorMsg('');

    try {
      const cleanShopName = formData.shopName.trim();
      const newEmail = formData.email.trim().toLowerCase();

      // 1. Collect any changed LOCKED fields and apply them via Super Admin Cloud Function
      const lockedUpdates: Record<string, any> = {};
      if (cleanShopName !== (targetUser.shopName || '').trim()) {
        lockedUpdates.shopName = cleanShopName;
      }
      if (newEmail !== (targetUser.email || '').trim().toLowerCase()) {
        lockedUpdates.email = newEmail;
      }
      if ((formData.dob || '').trim() !== (targetUser.dob || '').trim()) {
        lockedUpdates.dob = (formData.dob || '').trim();
      }
      if (formData.documentType !== (targetUser.documentType || 'nid')) {
        lockedUpdates.documentType = formData.documentType;
      }
      if ((formData.nidNumber || '').trim() !== (targetUser.nidNumber || '').trim()) {
        lockedUpdates.nidNumber = (formData.nidNumber || '').trim();
      }
      if ((formData.nidFrontUrl || '').trim() !== (targetUser.nidFrontUrl || targetUser.nidUrl || '').trim()) {
        lockedUpdates.nidFrontUrl = (formData.nidFrontUrl || '').trim();
        lockedUpdates.nidUrl = (formData.nidFrontUrl || '').trim();
      }
      if ((formData.nidBackUrl || '').trim() !== (targetUser.nidBackUrl || '').trim()) {
        lockedUpdates.nidBackUrl = (formData.nidBackUrl || '').trim();
      }
      if ((formData.birthCertificateNumber || '').trim() !== (targetUser.birthCertificateNumber || '').trim()) {
        lockedUpdates.birthCertificateNumber = (formData.birthCertificateNumber || '').trim();
      }
      if ((formData.birthCertificateUrl || '').trim() !== (targetUser.birthCertificateUrl || '').trim()) {
        lockedUpdates.birthCertificateUrl = (formData.birthCertificateUrl || '').trim();
      }
      if (formData.payoutMethod !== (targetUser.payoutMethod || 'bkash')) {
        lockedUpdates.payoutMethod = formData.payoutMethod;
      }
      if ((formData.accountHolderName || '').trim() !== (targetUser.accountHolderName || targetUser.fullName || '').trim()) {
        lockedUpdates.accountHolderName = (formData.accountHolderName || '').trim();
      }
      if ((formData.bankName || '').trim() !== (targetUser.bankName || '').trim()) {
        lockedUpdates.bankName = (formData.bankName || '').trim();
      }
      if ((formData.branchName || '').trim() !== (targetUser.branchName || '').trim()) {
        lockedUpdates.branchName = (formData.branchName || '').trim();
      }
      if ((formData.routingNumber || '').trim() !== (targetUser.routingNumber || '').trim()) {
        lockedUpdates.routingNumber = (formData.routingNumber || '').trim();
      }
      if ((formData.accountNumber || '').trim() !== (targetUser.accountNumber || '').trim()) {
        lockedUpdates.accountNumber = (formData.accountNumber || '').trim();
      }
      if ((formData.bkashNumber || '').trim() !== (targetUser.bkashNumber || '').trim()) {
        lockedUpdates.bkashNumber = (formData.bkashNumber || '').trim();
      }
      if ((formData.nagadNumber || '').trim() !== (targetUser.nagadNumber || '').trim()) {
        lockedUpdates.nagadNumber = (formData.nagadNumber || '').trim();
      }
      if ((formData.rocketNumber || '').trim() !== (targetUser.rocketNumber || '').trim()) {
        lockedUpdates.rocketNumber = (formData.rocketNumber || '').trim();
      }
      if ((formData.upayNumber || '').trim() !== (targetUser.upayNumber || '').trim()) {
        lockedUpdates.upayNumber = (formData.upayNumber || '').trim();
      }
      if (JSON.stringify(payoutMethodsList) !== JSON.stringify(targetUser.payoutMethods || [])) {
        lockedUpdates.payoutMethods = payoutMethodsList;
      }

      if (Object.keys(lockedUpdates).length > 0) {
        await updateResellerLockedFieldsCall(targetUser.uid, lockedUpdates);
      }

      // 2. Non-locked operational fields via Firestore updateDoc
      const effectiveRole: UserRole = isTargetSoleSuperAdmin
        ? 'super_admin'
        : formData.role === 'admin'
        ? 'admin'
        : 'reseller';

      const updatePayload: Record<string, any> = {
        fullName: (formData.fullName || '').trim(),
        mobile: (formData.mobile || '').trim(),
        whatsappNumber: (formData.whatsappNumber || '').trim(),
        status: isTargetSoleSuperAdmin ? 'approved' : (formData.status || 'approved'),
        rejectReason: !isTargetSoleSuperAdmin && formData.status === 'rejected' ? (formData.rejectReason || '').trim() : null,
        division: (formData.division || '').trim(),
        district: (formData.district || '').trim(),
        upazila: (formData.upazila || '').trim(),
        address: (formData.address || '').trim(),
        profilePhotoUrl: (formData.profilePhotoUrl || '').trim(),
        shopPhotoUrl: (formData.shopPhotoUrl || '').trim(),
        adminNotes: (formData.adminNotes || '').trim(),
        customCommissionRate: formData.customCommissionRate !== '' ? Number(formData.customCommissionRate) : null,
        updatedAt: serverTimestamp(),
      };

      if (!isTargetSoleSuperAdmin) {
        updatePayload.role = effectiveRole;

        if (effectiveRole === 'admin') {
          if (!targetUser.adminId) {
            let assignedAdminId = `ADM-${String(Math.floor(1000 + Math.random() * 8999))}`;
            try {
              assignedAdminId = await runTransaction(db, async (tx) => {
                const counterRef = doc(db, 'counters', 'adminId');
                const snap = await tx.get(counterRef);
                const nextCount = snap.exists() ? Number(snap.data()?.lastCount || 0) + 1 : 1;
                tx.set(counterRef, { lastCount: nextCount, updatedAt: serverTimestamp() }, { merge: true });
                return `ADM-${String(nextCount).padStart(4, '0')}`;
              });
            } catch {
              // Keep generated fallback
            }
            updatePayload.adminId = assignedAdminId;
          }

          if (!Array.isArray(targetUser.permissions) || targetUser.permissions.length === 0) {
            updatePayload.permissions = ADMIN_PERMISSIONS_LIST.filter((p) => p.defaultChecked).map((p) => p.id);
          }
        }

        if (effectiveRole === 'reseller' && !targetUser.resellerId && !targetUser.resellerCode) {
          let assignedResellerId = generateRandomResellerSuffix();
          try {
            const counterSnap = await getDoc(doc(db, 'counters', 'resellerId'));
            if (counterSnap.exists()) {
              const nextNum = Number(counterSnap.data()?.lastCount || 0) + 1;
              assignedResellerId = `RSB-${String(nextNum).padStart(6, '0')}`;
            }
          } catch {
            // Keep generated fallback
          }
          updatePayload.resellerId = assignedResellerId;
          updatePayload.resellerCode = assignedResellerId;
        }
      }

      const targetPath = `users/${targetUser.uid}`;
      try {
        await updateDoc(doc(db, 'users', targetUser.uid), updatePayload);
      } catch (fsErr: any) {
        const errInfo = {
          error: fsErr instanceof Error ? fsErr.message : String(fsErr),
          operationType: 'update',
          path: targetPath,
          authInfo: {
            userId: auth.currentUser?.uid,
            email: auth.currentUser?.email,
          },
        };
        console.error('Firestore Error: ', JSON.stringify(errInfo));
        throw fsErr;
      }

      if (effectiveRole === 'reseller' && updatePayload.status !== targetUser.status) {
        await notifyResellerStatusEmail({
          uid: targetUser.uid,
          beforeStatus: targetUser.status,
          afterStatus: updatePayload.status,
        });
      }

      setSuccessMsg('User details updated successfully!');
      onUserUpdated();
      setTimeout(() => {
        onClose();
      }, 1200);
    } catch (err: any) {
      console.error('Error updating user:', err);
      const rawMsg = err?.message || 'Failed to update user details.';
      if (rawMsg.toLowerCase().includes('missing or insufficient permissions')) {
        setErrorMsg(
          'Missing or insufficient permissions. অনুগ্রহ করে পুনরায় Super Admin OTP দিয়ে সেশন রিফ্রেশ করে চেষ্টা করুন।'
        );
      } else {
        setErrorMsg(rawMsg);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 overflow-y-auto">
      <div className="bg-white rounded-3xl shadow-2xl max-w-2xl w-full my-8 overflow-hidden border border-slate-200 flex flex-col max-h-[90vh]">
        
        {/* Header */}
        <div className="bg-gradient-to-r from-slate-900 via-indigo-950 to-blue-900 text-white p-6 relative">
          <button
            type="button"
            onClick={handleCloseClean}
            className="absolute top-5 right-5 text-slate-300 hover:text-white bg-white/10 hover:bg-white/20 p-2 rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>

          <div className="flex items-center gap-4">
            {formData.profilePhotoUrl ? (
              <img
                src={formData.profilePhotoUrl}
                alt={formData.fullName}
                className="w-16 h-16 rounded-2xl object-cover border-2 border-white/30 shadow-md"
              />
            ) : (
              <div className="w-16 h-16 rounded-2xl bg-white/20 border-2 border-white/30 flex items-center justify-center text-white font-bold text-xl shadow-md">
                {formData.fullName.charAt(0) || 'U'}
              </div>
            )}
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xl font-bold">{formData.fullName || 'User Profile'}</h2>
                <span className={`text-[10px] font-bold px-2.5 py-0.5 rounded-full uppercase tracking-wider ${
                  formData.role === 'super_admin' 
                    ? 'bg-purple-500/30 text-purple-200 border border-purple-400/30'
                    : formData.role === 'admin'
                    ? 'bg-blue-500/30 text-blue-200 border border-blue-400/30'
                    : 'bg-emerald-500/30 text-emerald-200 border border-emerald-400/30'
                }`}>
                  {formData.role.replace('_', ' ')}
                </span>
              </div>
              <p className="text-xs text-blue-200 mt-1 flex items-center gap-1.5 flex-wrap">
                <Store className="w-3.5 h-3.5 opacity-80" />
                <span>{formData.shopName || 'No Shop Name'}</span>
                {formData.role === 'reseller' && (
                  <>
                    <span className="opacity-40">•</span>
                    <span className="font-mono font-bold text-amber-300 bg-black/20 px-1.5 py-0.5 rounded">
                      ID: {formatResellerId(targetUser)}
                    </span>
                  </>
                )}
              </p>
            </div>
          </div>

          {!isSuperAdmin && (
            <div className="mt-4 bg-amber-500/20 border border-amber-400/30 rounded-xl p-2.5 flex items-center gap-2 text-xs text-amber-100">
              <Lock className="w-4 h-4 text-amber-300 shrink-0" />
              <span>Editing user details is strictly allowed for <strong>Super Admin</strong> only. Viewing in Read-Only mode.</span>
            </div>
          )}
        </div>

        {/* Tab Buttons */}
        <div className="flex border-b border-slate-200 bg-slate-50/80 px-6 pt-3 gap-2 overflow-x-auto text-xs font-semibold">
          <button
            type="button"
            onClick={() => setActiveTab('profile')}
            className={`pb-3 px-3 transition-colors border-b-2 flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'profile'
                ? 'border-blue-600 text-blue-600 font-bold'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <User className="w-3.5 h-3.5" />
            Account & Role
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('location')}
            className={`pb-3 px-3 transition-colors border-b-2 flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'location'
                ? 'border-blue-600 text-blue-600 font-bold'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <MapPin className="w-3.5 h-3.5" />
            Address & Location
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('financial')}
            className={`pb-3 px-3 transition-colors border-b-2 flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'financial'
                ? 'border-blue-600 text-blue-600 font-bold'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <CreditCard className="w-3.5 h-3.5" />
            Commission & Payouts
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('documents')}
            className={`pb-3 px-3 transition-colors border-b-2 flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'documents'
                ? 'border-blue-600 text-blue-600 font-bold'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <FileText className="w-3.5 h-3.5" />
            NID & Media
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('security')}
            className={`pb-3 px-3 transition-colors border-b-2 flex items-center gap-1.5 whitespace-nowrap ${
              activeTab === 'security'
                ? 'border-blue-600 text-blue-600 font-bold'
                : 'border-transparent text-slate-600 hover:text-slate-900'
            }`}
          >
            <Shield className="w-3.5 h-3.5" />
            Security & Logins
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-6 flex-1 overflow-y-auto space-y-5">
          {successMsg && (
            <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 rounded-xl p-3 text-xs font-semibold flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
              <span>{successMsg}</span>
            </div>
          )}

          {errorMsg && (
            <div className="bg-rose-50 border border-rose-200 text-rose-800 rounded-xl p-3 text-xs font-semibold flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* TAB 1: Profile & Role */}
          {activeTab === 'profile' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Full Name *
                  </label>
                  <input
                    type="text"
                    required
                    disabled={!isSuperAdmin}
                    value={formData.fullName}
                    onChange={(e) => setFormData({ ...formData, fullName: e.target.value })}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70 disabled:cursor-not-allowed"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center justify-between">
                    <span>Shop / Business Name *</span>
                    {shopNameCheck.status === 'available' && (
                      <span className="text-[10px] text-emerald-600 font-bold flex items-center gap-0.5">
                        <CheckCircle2 className="w-3 h-3 text-emerald-600" /> Available
                      </span>
                    )}
                    {shopNameCheck.status === 'taken' && (
                      <span className="text-[10px] text-red-600 font-bold flex items-center gap-0.5">
                        <AlertCircle className="w-3 h-3 text-red-600" /> Taken
                      </span>
                    )}
                  </label>
                  <input
                    type="text"
                    required
                    disabled={!isSuperAdmin}
                    value={formData.shopName}
                    onChange={(e) => setFormData({ ...formData, shopName: e.target.value })}
                    className={`w-full px-3.5 py-2.5 bg-slate-50 border rounded-xl text-xs focus:bg-white disabled:opacity-70 disabled:cursor-not-allowed transition-all ${
                      shopNameCheck.status === 'taken'
                        ? 'border-red-400 focus:ring-2 focus:ring-red-400'
                        : shopNameCheck.status === 'available'
                        ? 'border-emerald-500 focus:ring-2 focus:ring-emerald-400'
                        : 'border-slate-300 focus:ring-2 focus:ring-blue-600'
                    }`}
                  />
                  {shopNameCheck.status === 'checking' && (
                    <p className="text-[11px] text-amber-600 flex items-center gap-1 font-medium mt-1">
                      <Loader2 className="w-3 h-3 animate-spin text-amber-500 shrink-0" />
                      Checking availability...
                    </p>
                  )}
                  {shopNameCheck.status === 'available' && (
                    <p className="text-[11px] text-emerald-600 flex items-center gap-1 font-medium mt-1">
                      <CheckCircle2 className="w-3 h-3 text-emerald-500 shrink-0" />
                      Shop name is available
                    </p>
                  )}
                  {shopNameCheck.status === 'taken' && (
                    <p className="text-[11px] text-red-600 flex items-center gap-1 font-medium mt-1">
                      <AlertCircle className="w-3 h-3 text-red-500 shrink-0" />
                      This shop name is already taken. Please choose a different name.
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Mobile Phone *
                  </label>
                  <input
                    type="text"
                    required
                    disabled={!isSuperAdmin}
                    value={formData.mobile}
                    onChange={(e) => setFormData({ ...formData, mobile: e.target.value })}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70 disabled:cursor-not-allowed"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center justify-between">
                    <span className="flex items-center gap-1 text-emerald-700">
                      <MessageCircle className="w-3.5 h-3.5 inline" />
                      <span>WhatsApp Number</span>
                    </span>
                    {isSuperAdmin && (
                      <button
                        type="button"
                        onClick={() => setFormData({ ...formData, whatsappNumber: formData.mobile })}
                        className="text-[10px] text-emerald-600 hover:text-emerald-700 font-medium"
                      >
                        Copy mobile
                      </button>
                    )}
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.whatsappNumber}
                    onChange={(e) => setFormData({ ...formData, whatsappNumber: e.target.value })}
                    placeholder="01712345678"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-emerald-600 focus:bg-white disabled:opacity-70 disabled:cursor-not-allowed font-mono"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Email Address *
                  </label>
                  <input
                    type="email"
                    required
                    disabled={!isSuperAdmin}
                    value={formData.email}
                    onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70 disabled:cursor-not-allowed"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Account Role {targetUser?.email?.toLowerCase().trim() === 'skyautomationtech@gmail.com' ? '(Permanent Super Admin)' : '(Super Admin Only)'}
                  </label>
                  {targetUser?.email?.toLowerCase().trim() === 'skyautomationtech@gmail.com' ? (
                    <div className="w-full px-3.5 py-2.5 bg-amber-50 border border-amber-300 rounded-xl text-xs font-bold text-amber-900 flex items-center gap-2">
                      <span>👑 Permanent Sole Super Admin</span>
                    </div>
                  ) : (
                    <select
                      disabled={!isSuperAdmin}
                      value={formData.role === 'super_admin' ? 'admin' : formData.role}
                      onChange={(e) => setFormData({ ...formData, role: e.target.value as UserRole })}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-800 focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70 disabled:cursor-not-allowed"
                    >
                      <option value="reseller">Reseller Account</option>
                      <option value="admin">Admin Staff Account</option>
                    </select>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Account Status
                  </label>
                  {targetUser?.email?.toLowerCase().trim() === 'skyautomationtech@gmail.com' ? (
                    <div className="w-full px-3.5 py-2.5 bg-emerald-50 border border-emerald-300 rounded-xl text-xs font-bold text-emerald-800 flex items-center gap-2">
                      <span>✅ Approved (Permanent Active)</span>
                    </div>
                  ) : (
                    <select
                      disabled={!isSuperAdmin}
                      value={formData.status}
                      onChange={(e) => setFormData({ ...formData, status: e.target.value as UserStatus })}
                      className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold text-slate-800 focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70 disabled:cursor-not-allowed"
                    >
                      <option value="approved">Approved (Active)</option>
                      <option value="pending">Pending Approval</option>
                      <option value="suspended">Suspended</option>
                      <option value="rejected">Rejected</option>
                    </select>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
                    <Lock className="w-3 h-3 text-amber-600" />
                    <span>Date of Birth (Super Admin Only)</span>
                  </label>
                  <input
                    type="date"
                    disabled={!isSuperAdmin}
                    value={formData.dob}
                    onChange={(e) => setFormData({ ...formData, dob: e.target.value })}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-mono focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70 disabled:cursor-not-allowed"
                  />
                </div>
              </div>

              {formData.status === 'rejected' && (
                <div>
                  <label className="block text-xs font-semibold text-rose-700 mb-1">
                    Rejection Reason
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.rejectReason}
                    onChange={(e) => setFormData({ ...formData, rejectReason: e.target.value })}
                    placeholder="Enter explicit reason for rejection..."
                    className="w-full px-3.5 py-2 bg-rose-50 border border-rose-200 text-rose-900 rounded-xl text-xs focus:ring-2 focus:ring-rose-500"
                  />
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Internal Super Admin Remarks & Notes
                </label>
                <textarea
                  rows={2}
                  disabled={!isSuperAdmin}
                  value={formData.adminNotes}
                  onChange={(e) => setFormData({ ...formData, adminNotes: e.target.value })}
                  placeholder="Super Admin internal notes regarding performance, agreements, or background check..."
                  className="w-full p-3 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70 resize-none"
                />
              </div>
            </div>
          )}

          {/* TAB 2: Location & Address */}
          {activeTab === 'location' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Division
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.division}
                    onChange={(e) => setFormData({ ...formData, division: e.target.value })}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    District
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.district}
                    onChange={(e) => setFormData({ ...formData, district: e.target.value })}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Upazila / Thana
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.upazila}
                    onChange={(e) => setFormData({ ...formData, upazila: e.target.value })}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Full Street Address & Shop Location
                </label>
                <textarea
                  rows={3}
                  disabled={!isSuperAdmin}
                  value={formData.address}
                  onChange={(e) => setFormData({ ...formData, address: e.target.value })}
                  className="w-full p-3 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70 resize-none"
                />
              </div>
            </div>
          )}

          {/* TAB 3: Financial & Commission */}
          {activeTab === 'financial' && (
            <div className="space-y-4">
              <div className="bg-blue-50/70 border border-blue-200 rounded-2xl p-4">
                <div className="flex items-center gap-2 mb-1">
                  <Percent className="w-4 h-4 text-blue-600" />
                  <h4 className="text-xs font-bold text-blue-900">Custom Commission Rate Override</h4>
                </div>
                <p className="text-[11px] text-blue-700 mb-3 leading-relaxed">
                  Override the global system commission for this specific user. Leave blank to use default global/category rates.
                </p>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    disabled={!isSuperAdmin}
                    value={formData.customCommissionRate}
                    onChange={(e) => setFormData({ ...formData, customCommissionRate: e.target.value })}
                    placeholder="e.g. 12.5"
                    className="w-36 px-3.5 py-2 bg-white border border-blue-300 rounded-xl text-xs font-bold text-blue-900 focus:ring-2 focus:ring-blue-600"
                  />
                  <span className="text-xs font-bold text-blue-800">% Special Reseller Rate</span>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
                    <Lock className="w-3 h-3 text-amber-600" />
                    <span>Default Payout Method</span>
                  </label>
                  <select
                    disabled={!isSuperAdmin}
                    value={formData.payoutMethod}
                    onChange={(e) => setFormData({ ...formData, payoutMethod: e.target.value as any })}
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  >
                    <option value="bkash">bKash</option>
                    <option value="nagad">Nagad</option>
                    <option value="rocket">Rocket</option>
                    <option value="upay">Upay</option>
                    <option value="bank">Bank Transfer</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
                    <User className="w-3.5 h-3.5 text-slate-400" />
                    Account Holder Name
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.accountHolderName}
                    onChange={(e) => setFormData({ ...formData, accountHolderName: e.target.value })}
                    placeholder="Account holder legal name"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
                    <Landmark className="w-3.5 h-3.5 text-slate-400" />
                    Bank Name
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.bankName}
                    onChange={(e) => setFormData({ ...formData, bankName: e.target.value })}
                    placeholder="e.g. Dutch Bangla Bank Ltd"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
                    <Building2 className="w-3.5 h-3.5 text-slate-400" />
                    Primary / Bank Account Number
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.accountNumber}
                    onChange={(e) => setFormData({ ...formData, accountNumber: e.target.value })}
                    placeholder="Account Number"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Bank Branch Name
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.branchName}
                    onChange={(e) => setFormData({ ...formData, branchName: e.target.value })}
                    placeholder="Branch"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Routing Number
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.routingNumber}
                    onChange={(e) => setFormData({ ...formData, routingNumber: e.target.value })}
                    placeholder="9-digit routing #"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-mono focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1 text-pink-600">
                    <Smartphone className="w-3.5 h-3.5 text-pink-500" />
                    bKash Personal / Merchant
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.bkashNumber}
                    onChange={(e) => setFormData({ ...formData, bkashNumber: e.target.value })}
                    placeholder="017xxxxxxxx"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1 text-amber-600">
                    <Smartphone className="w-3.5 h-3.5 text-amber-500" />
                    Nagad Account
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.nagadNumber}
                    onChange={(e) => setFormData({ ...formData, nagadNumber: e.target.value })}
                    placeholder="018xxxxxxxx"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1 text-purple-600">
                    <Smartphone className="w-3.5 h-3.5 text-purple-500" />
                    Rocket Account
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.rocketNumber}
                    onChange={(e) => setFormData({ ...formData, rocketNumber: e.target.value })}
                    placeholder="019xxxxxxxx"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1 text-amber-700">
                    <Smartphone className="w-3.5 h-3.5 text-amber-600" />
                    Upay Account
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={formData.upayNumber}
                    onChange={(e) => setFormData({ ...formData, upayNumber: e.target.value })}
                    placeholder="01xxxxxxxxx"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  />
                </div>
              </div>

              {/* Saved Payout Methods List */}
              <div className="pt-3 border-t border-slate-200 space-y-2">
                <div className="flex items-center justify-between">
                  <h5 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                    <CreditCard className="w-3.5 h-3.5 text-[#0E9AA7]" />
                    <span>Saved Payout Methods ({payoutMethodsList.length})</span>
                  </h5>
                  {isSuperAdmin && (
                    <button
                      type="button"
                      onClick={() => {
                        const acc = (
                          formData.payoutMethod === 'bkash'
                            ? formData.bkashNumber
                            : formData.payoutMethod === 'nagad'
                            ? formData.nagadNumber
                            : formData.payoutMethod === 'rocket'
                            ? formData.rocketNumber
                            : formData.payoutMethod === 'upay'
                            ? formData.upayNumber
                            : formData.accountNumber
                        ).trim();
                        if (!acc) {
                          setErrorMsg('Enter the account number above first before adding to Saved Payout Methods.');
                          return;
                        }
                        const typeMap: Record<string, PayoutMethod['type']> = {
                          bkash: 'bKash',
                          nagad: 'Nagad',
                          rocket: 'Rocket',
                          upay: 'Upay',
                          bank: 'Bank',
                        };
                        const newItem: PayoutMethod = {
                          id: `pm_${Date.now().toString(36)}`,
                          type: typeMap[formData.payoutMethod] || 'bKash',
                          accountNumber: acc,
                          accountHolderName: formData.accountHolderName.trim() || formData.fullName.trim(),
                          bankName: formData.payoutMethod === 'bank' ? formData.bankName.trim() || null : null,
                          branchName: formData.payoutMethod === 'bank' ? formData.branchName.trim() || null : null,
                          routingNumber: formData.payoutMethod === 'bank' ? formData.routingNumber.trim() || null : null,
                          isDefault: payoutMethodsList.length === 0,
                          verified: true,
                          payoutVerified: 'verified',
                          addedAt: new Date().toISOString(),
                        };
                        setPayoutMethodsList((prev) => [...prev, newItem]);
                      }}
                      className="text-[11px] font-bold text-[#0E9AA7] hover:underline flex items-center gap-1 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" /> Add from fields above
                    </button>
                  )}
                </div>
                {payoutMethodsList.length === 0 ? (
                  <p className="text-[11px] text-slate-400 italic">No structured payoutMethods entries yet.</p>
                ) : (
                  <div className="space-y-1.5">
                    {payoutMethodsList.map((pm) => (
                      <div key={pm.id} className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between gap-2 text-xs">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-slate-900">{pm.type}</span>
                            {pm.isDefault && (
                              <span className="text-[9px] font-extrabold px-1.5 py-0.2 rounded bg-emerald-600 text-white uppercase">
                                Default
                              </span>
                            )}
                          </div>
                          <p className="font-mono text-[11px] text-slate-600 truncate">
                            {pm.accountNumber} {pm.bankName ? `• ${pm.bankName}` : ''}
                          </p>
                        </div>
                        {isSuperAdmin && (
                          <div className="flex items-center gap-1.5 shrink-0">
                            {!pm.isDefault && (
                              <button
                                type="button"
                                onClick={() =>
                                  setPayoutMethodsList((prev) =>
                                    prev.map((x) => ({ ...x, isDefault: x.id === pm.id }))
                                  )
                                }
                                className="px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 text-[10px] font-bold border border-emerald-200 cursor-pointer"
                              >
                                Make Default
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                setPayoutMethodsList((prev) => {
                                  const next = prev.filter((x) => x.id !== pm.id);
                                  if (next.length > 0 && !next.some((x) => x.isDefault)) {
                                    next[0].isDefault = true;
                                  }
                                  return next;
                                });
                              }}
                              className="p-1.5 rounded-lg bg-rose-50 text-rose-600 hover:bg-rose-100 cursor-pointer"
                              title="Remove payout method"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 4: Identity & Media */}
          {activeTab === 'documents' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1 flex items-center gap-1">
                    <Lock className="w-3 h-3 text-amber-600" />
                    <span>Identity Document Type</span>
                  </label>
                  <select
                    disabled={!isSuperAdmin}
                    value={formData.documentType}
                    onChange={(e) =>
                      setFormData({ ...formData, documentType: e.target.value as 'nid' | 'birth_certificate' })
                    }
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-semibold focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  >
                    <option value="nid">National ID (NID)</option>
                    <option value="birth_certificate">Birth Certificate</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    {formData.documentType === 'birth_certificate'
                      ? 'Birth Certificate Number'
                      : 'National ID (NID) Number'}
                  </label>
                  <input
                    type="text"
                    disabled={!isSuperAdmin}
                    value={
                      formData.documentType === 'birth_certificate'
                        ? formData.birthCertificateNumber
                        : formData.nidNumber
                    }
                    onChange={(e) =>
                      setFormData(
                        formData.documentType === 'birth_certificate'
                          ? { ...formData, birthCertificateNumber: e.target.value }
                          : { ...formData, nidNumber: e.target.value }
                      )
                    }
                    placeholder="Enter document number"
                    className="w-full px-3.5 py-2.5 bg-slate-50 border border-slate-300 rounded-xl text-xs font-mono focus:ring-2 focus:ring-blue-600 focus:bg-white disabled:opacity-70"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2">
                <ImageUploadField
                  label="Profile Photo"
                  value={formData.profilePhotoUrl}
                  onChange={(url) => setFormData((prev) => ({ ...prev, profilePhotoUrl: url }))}
                  storagePath={`users/${targetUser.uid}/profile`}
                  theme="light"
                  size="sm"
                  aspect="wide"
                  captureMode="user"
                  disabled={!isSuperAdmin}
                  allowUrlFallback={isSuperAdmin}
                  placeholderText="No Photo"
                />

                <ImageUploadField
                  label="Shop Photo"
                  value={formData.shopPhotoUrl}
                  onChange={(url) => setFormData((prev) => ({ ...prev, shopPhotoUrl: url }))}
                  storagePath={`users/${targetUser.uid}/shop`}
                  theme="light"
                  size="sm"
                  aspect="wide"
                  captureMode="environment"
                  disabled={!isSuperAdmin}
                  allowUrlFallback={isSuperAdmin}
                  placeholderText="No Photo"
                />

                {formData.documentType === 'birth_certificate' ? (
                  <ImageUploadField
                    label="Birth Certificate Image"
                    value={formData.birthCertificateUrl}
                    onChange={(url) => setFormData((prev) => ({ ...prev, birthCertificateUrl: url }))}
                    storagePath={`users/${targetUser.uid}/nid`}
                    theme="light"
                    size="sm"
                    aspect="wide"
                    captureMode="environment"
                    disabled={!isSuperAdmin}
                    allowUrlFallback={isSuperAdmin}
                    placeholderText="No Birth Cert"
                  />
                ) : (
                  <>
                    <ImageUploadField
                      label="NID Front Image"
                      value={formData.nidFrontUrl}
                      onChange={(url) => setFormData((prev) => ({ ...prev, nidFrontUrl: url, nidUrl: url }))}
                      storagePath={`users/${targetUser.uid}/nid`}
                      theme="light"
                      size="sm"
                      aspect="wide"
                      captureMode="environment"
                      disabled={!isSuperAdmin}
                      allowUrlFallback={isSuperAdmin}
                      placeholderText="No NID Front"
                    />
                    <ImageUploadField
                      label="NID Back Image"
                      value={formData.nidBackUrl}
                      onChange={(url) => setFormData((prev) => ({ ...prev, nidBackUrl: url }))}
                      storagePath={`users/${targetUser.uid}/nid`}
                      theme="light"
                      size="sm"
                      aspect="wide"
                      captureMode="environment"
                      disabled={!isSuperAdmin}
                      allowUrlFallback={isSuperAdmin}
                      placeholderText="No NID Back"
                    />
                  </>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: Security, Password Management & Login Activity */}
          {activeTab === 'security' && (
            <div className="space-y-5">
              {/* Super Admin Exclusive Password Management */}
              {isSuperAdmin && !isTargetSoleSuperAdmin && (
                <div className="p-4 rounded-2xl bg-slate-900 text-white space-y-3.5 border border-slate-800 shadow-sm">
                  <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-2.5">
                    <div className="flex items-center gap-2">
                      <Key className="w-4 h-4 text-[#3DD055]" />
                      <h4 className="text-xs font-extrabold uppercase tracking-wider">
                        Password Management (Super Admin)
                      </h4>
                    </div>
                    {targetUser.mustChangePassword && (
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-400/30">
                        Forced Change Pending
                      </span>
                    )}
                  </div>

                  {passwordMgmtError && (
                    <div className="p-2.5 rounded-xl bg-rose-500/20 border border-rose-400/30 text-rose-200 text-[11px] flex items-center gap-2">
                      <AlertCircle className="w-4 h-4 shrink-0" />
                      <span>{passwordMgmtError}</span>
                    </div>
                  )}

                  {resetLinkStatus && (
                    <div className="p-2.5 rounded-xl bg-emerald-500/20 border border-emerald-400/30 text-emerald-200 text-[11px] flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4 text-[#3DD055] shrink-0" />
                      <span>{resetLinkStatus}</span>
                    </div>
                  )}

                  {/* Option 1: Send Password Reset Email */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-white/5 border border-white/10 rounded-xl p-3">
                    <div>
                      <p className="text-xs font-bold">Send Password Reset Email</p>
                      <p className="text-[10.5px] text-slate-300">
                        Generates an official reset link and emails it directly to {targetUser.email}.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={sendingResetLink}
                      onClick={async () => {
                        setSendingResetLink(true);
                        setPasswordMgmtError(null);
                        setResetLinkStatus(null);
                        try {
                          const res = await sendResellerPasswordResetCall(targetUser.uid);
                          setResetLinkStatus(res.message || 'Password reset email sent.');
                        } catch (err: any) {
                          setPasswordMgmtError(err?.message || 'Failed to send password reset email.');
                        } finally {
                          setSendingResetLink(false);
                        }
                      }}
                      className="px-3.5 py-2 rounded-xl bg-[#0E9AA7] hover:bg-[#0c8591] text-white text-[11px] font-bold flex items-center justify-center gap-1.5 shrink-0 disabled:opacity-50 cursor-pointer"
                    >
                      {sendingResetLink ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                      <span>Send Reset Email</span>
                    </button>
                  </div>

                  {/* Option 2: Set Temporary Password */}
                  <div className="bg-white/5 border border-white/10 rounded-xl p-3 space-y-2.5">
                    <div>
                      <p className="text-xs font-bold">Set Temporary Password (Force Change on Next Login)</p>
                      <p className="text-[10.5px] text-slate-300">
                        Revokes active sessions, forces password change at next sign-in, and notifies the user by email.
                      </p>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="text"
                        value={customTempPassword}
                        onChange={(e) => setCustomTempPassword(e.target.value)}
                        placeholder="Optional custom password (leave blank to auto-generate)"
                        className="flex-1 h-9 px-3 rounded-xl bg-slate-950/70 border border-white/15 text-xs font-mono text-white placeholder-slate-400 outline-none focus:border-[#3DD055]"
                      />
                      <button
                        type="button"
                        disabled={settingTempPassword}
                        onClick={async () => {
                          setSettingTempPassword(true);
                          setPasswordMgmtError(null);
                          setGeneratedTempPassword(null);
                          try {
                            const res = await setResellerTemporaryPasswordCall(
                              targetUser.uid,
                              customTempPassword.trim() || undefined
                            );
                            setGeneratedTempPassword(res.tempPassword);
                            setCustomTempPassword('');
                            setCopiedTempPass(false);
                            onUserUpdated();
                          } catch (err: any) {
                            setPasswordMgmtError(err?.message || 'Failed to set temporary password.');
                          } finally {
                            setSettingTempPassword(false);
                          }
                        }}
                        className="px-3.5 py-2 rounded-xl bg-[#3DD055] hover:bg-[#34ba4a] text-slate-950 text-[11px] font-extrabold flex items-center justify-center gap-1.5 shrink-0 disabled:opacity-50 cursor-pointer"
                      >
                        {settingTempPassword ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Key className="w-3.5 h-3.5" />}
                        <span>Set Temporary Password</span>
                      </button>
                    </div>

                    {generatedTempPassword && (
                      <div className="p-3 rounded-xl bg-emerald-500/15 border border-emerald-400/40 space-y-1.5">
                        <p className="text-[10.5px] font-bold text-emerald-300">
                          One-Time Temporary Password (Shown Once — Not Saved Anywhere):
                        </p>
                        <div className="flex items-center justify-between gap-2 bg-slate-950/80 px-3 py-2 rounded-lg border border-white/10">
                          <code className="font-mono text-sm font-extrabold text-[#3DD055] tracking-wide select-all">
                            {generatedTempPassword}
                          </code>
                          <button
                            type="button"
                            onClick={() => {
                              navigator.clipboard.writeText(generatedTempPassword);
                              setCopiedTempPass(true);
                              setTimeout(() => setCopiedTempPass(false), 2000);
                            }}
                            className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-[10.5px] font-bold flex items-center gap-1 cursor-pointer"
                          >
                            <Copy className="w-3 h-3" />
                            <span>{copiedTempPass ? 'Copied' : 'Copy'}</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <h4 className="text-xs font-bold text-slate-800 flex items-center gap-1.5">
                  <Shield className="w-4 h-4 text-emerald-600" />
                  <span>Login Activity (Last 20 Logins)</span>
                </h4>
                <span className="text-[10px] text-slate-400 font-mono">
                  {userLogins.length} recorded session(s)
                </span>
              </div>

              {loadingLogins ? (
                <div className="p-8 text-center text-xs text-slate-400">
                  Loading login sessions...
                </div>
              ) : userLogins.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-400 bg-slate-50 rounded-2xl border border-dashed border-slate-200">
                  No login history recorded yet for this account.
                </div>
              ) : (
                <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                  {userLogins.map((lh) => {
                    const timeObj = lh.timestamp?.toDate ? lh.timestamp.toDate() : new Date(lh.timestamp || 0);
                    return (
                      <div key={lh.id} className="p-3 bg-slate-50 border border-slate-200 rounded-xl text-xs space-y-1">
                        <div className="flex items-center justify-between font-mono text-[10px] text-slate-500">
                          <span className="font-bold text-slate-700">{timeObj.toLocaleString('en-GB')}</span>
                          <div className="flex items-center gap-1.5">
                            {lh.isNewDevice && (
                              <span className="bg-amber-100 text-amber-800 text-[9px] font-extrabold px-1.5 py-0.5 rounded border border-amber-300">
                                NEW DEVICE
                              </span>
                            )}
                            <span className="text-emerald-700 font-bold">Authorized</span>
                          </div>
                        </div>
                        <div className="flex items-center justify-between pt-0.5">
                          <p className="font-medium text-slate-800 text-[11px] truncate flex items-center gap-1.5">
                            <Smartphone className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                            <span>{lh.deviceModel || 'Unknown Device'}</span>
                          </p>
                          <span className="text-[10px] font-mono text-slate-500 uppercase px-1.5 py-0.5 bg-white border border-slate-200 rounded">
                            {lh.platform || 'web'} {lh.osVersion ? `(${lh.osVersion})` : ''}
                          </span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Footer Actions */}
          <div className="border-t border-slate-200 pt-4 flex items-center justify-between gap-3">
            <span className="text-[11px] text-slate-500 italic">
              {isSuperAdmin ? 'Super Admin editing mode enabled' : 'Read-only mode'}
            </span>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={handleCloseClean}
                className="px-4 py-2.5 rounded-xl border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-slate-50 transition-colors"
              >
                Close
              </button>

              {isSuperAdmin && (
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold shadow-md transition-colors flex items-center gap-2 disabled:opacity-50"
                >
                  <Save className="w-4 h-4" />
                  <span>{saving ? 'Saving...' : 'Save User Details'}</span>
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};
