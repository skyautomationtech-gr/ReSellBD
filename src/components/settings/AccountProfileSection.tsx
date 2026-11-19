import React, { useState, useEffect, useRef } from 'react';
import { doc, getDoc, updateDoc, collection, query, orderBy, limit, getDocs, serverTimestamp } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { ChangeRequestFieldKey, UserProfile } from '../../types';
import { BANGLADESH_GEO } from '../../data/bangladeshGeo';
import { ImageUploadField } from '../common/ImageUploadField';
import { ChangeRequestModal } from '../common/ChangeRequestModal';
import { LockTooltipIcon } from '../common/LockTooltipIcon';
import { deleteStorageFileByUrl } from '../../hooks/useImageUpload';
import { logAuditAction } from '../../lib/auditLogger';
import { formatResellerId } from '../../lib/resellerIdHelper';
import { DENSITY_TOKENS as DT } from '../../utils/densityTokens';
import { triggerHaptic } from '../../lib/nativeFeedback';
import { 
  User, Store, MapPin, Mail, Phone, Globe, Shield, 
  FileText, Check, Copy, ChevronRight, X, Loader2, Camera,
  AlertCircle, CheckCircle2, MessageSquare, ExternalLink,
  Calendar, Clock, ShieldAlert, Sparkles, Lock
} from 'lucide-react';
import { ProfilePhotoUploader, ProfilePhotoUploaderHandle } from './ProfilePhotoUploader';
import { useScrollToTop } from '../../utils/scrollToTop';

interface AccountProfileSectionProps {
  user: UserProfile;
  canAccessFullApp?: boolean;
  onOpenLockedModal?: (featureName?: string) => void;
  onRefreshUser?: () => void;
}

type EditModalType =
  | null
  | 'fullName'
  | 'shopLogo'
  | 'shopAddress'
  | 'businessLinks';

export const AccountProfileSection: React.FC<AccountProfileSectionProps> = ({
  user,
  canAccessFullApp = true,
  onOpenLockedModal,
  onRefreshUser,
}) => {
  const [profile, setProfile] = useState<UserProfile>(user);
  const [loading, setLoading] = useState<boolean>(true);
  const [lastLoginTime, setLastLoginTime] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<boolean>(false);
  const [activeModal, setActiveModal] = useState<EditModalType>(null);
  const [changeRequestField, setChangeRequestField] = useState<ChangeRequestFieldKey | null>(null);
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const photoUploaderRef = useRef<ProfilePhotoUploaderHandle>(null);

  // Scroll to top immediately before paint on mount
  useScrollToTop([]);

  // Form states for Bottom Sheet Modals
  // 1. Full Name
  const [formFullName, setFormFullName] = useState(user.fullName || '');
  
  // 2. Shop Logo / Photo
  const [formShopLogo, setFormShopLogo] = useState(user.shopPhotoUrl || user.shopLogoUrl || user.profilePhotoUrl || '');

  // 3. Shop Address
  const [formDivision, setFormDivision] = useState(user.division || '');
  const [formDistrict, setFormDistrict] = useState(user.district || '');
  const [formUpazila, setFormUpazila] = useState(user.upazila || '');
  const [formUnion, setFormUnion] = useState(user.union || '');
  const [formPostalCode, setFormPostalCode] = useState(user.postalCode || '');
  const [formAddress, setFormAddress] = useState(user.address || '');

  // 4. Business Social Links
  const [formFacebook, setFormFacebook] = useState(user.facebookPage || '');
  const [formTiktok, setFormTiktok] = useState(user.tiktokUrl || '');
  const [formInstagram, setFormInstagram] = useState(user.instagramUrl || '');
  const [formYoutube, setFormYoutube] = useState(user.youtubeUrl || '');

  // Modal Validation & Saving
  const [savingField, setSavingField] = useState(false);
  const [formError, setFormError] = useState('');

  const isPending = user.status === 'pending';

  // Load fresh user data and last login history on mount
  useEffect(() => {
    let isMounted = true;
    const fetchFreshProfile = async () => {
      setLoading(true);
      try {
        const userRef = doc(db, 'users', user.uid);
        const userSnap = await getDoc(userRef);
        if (userSnap.exists() && isMounted) {
          const freshData = { uid: userSnap.id, ...userSnap.data() } as UserProfile;
          setProfile(freshData);
          setFormFullName(freshData.fullName || '');
          setFormShopLogo(freshData.shopPhotoUrl || freshData.shopLogoUrl || freshData.profilePhotoUrl || '');
          setFormDivision(freshData.division || '');
          setFormDistrict(freshData.district || '');
          setFormUpazila(freshData.upazila || '');
          setFormUnion(freshData.union || '');
          setFormPostalCode(freshData.postalCode || '');
          setFormAddress(freshData.address || '');
          setFormFacebook(freshData.facebookPage || '');
          setFormTiktok(freshData.tiktokUrl || '');
          setFormInstagram(freshData.instagramUrl || '');
          setFormYoutube(freshData.youtubeUrl || '');
        }

        // Fetch last login
        const loginQuery = query(
          collection(db, 'users', user.uid, 'loginHistory'),
          orderBy('timestamp', 'desc'),
          limit(1)
        );
        const loginSnap = await getDocs(loginQuery);
        if (!loginSnap.empty && isMounted) {
          const firstLogin = loginSnap.docs[0].data();
          const d = firstLogin.timestamp?.toDate ? firstLogin.timestamp.toDate() : new Date(firstLogin.timestamp);
          setLastLoginTime(d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) + ' · ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        }
      } catch (err) {
        console.warn('Error fetching fresh profile details:', err);
      } finally {
        if (isMounted) setLoading(false);
      }
    };

    fetchFreshProfile();
    return () => { isMounted = false; };
  }, [user.uid]);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 3000);
  };

  const handleOpenEdit = (modalType: EditModalType) => {
    triggerHaptic('light');
    if (!canAccessFullApp) {
      if (onOpenLockedModal) {
        onOpenLockedModal('Profile Editing');
      } else {
        showToast('Profile editing unlocks after account verification', 'error');
      }
      return;
    }
    setFormError('');
    setActiveModal(modalType);
  };

  // Division/District/Upazila cascaded lists
  const divisionsList = Object.keys(BANGLADESH_GEO);
  const districtsList = formDivision && BANGLADESH_GEO[formDivision] ? Object.keys(BANGLADESH_GEO[formDivision]) : [];
  const upazilasList = formDivision && formDistrict && BANGLADESH_GEO[formDivision]?.[formDistrict] ? BANGLADESH_GEO[formDivision][formDistrict] : [];

  // URL Validator helper
  const isValidUrl = (url: string): boolean => {
    if (!url.trim()) return false;
    try {
      const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };

  // Save Modal Actions
  const handleSaveModal = async () => {
    setFormError('');
    setSavingField(true);
    triggerHaptic('medium');

    try {
      const userRef = doc(db, 'users', user.uid);
      const updatePayload: Record<string, any> = {
        updatedAt: serverTimestamp(),
      };

      if (activeModal === 'fullName') {
        const cleanName = formFullName.trim();
        if (!cleanName || cleanName.length < 3) {
          throw new Error('Please enter a valid full name (at least 3 characters).');
        }
        updatePayload.fullName = cleanName;
      } 
      else if (activeModal === 'shopLogo') {
        if (!formShopLogo) {
          throw new Error('Please upload a shop logo or photo.');
        }
        const prevPhoto = profile.shopPhotoUrl || profile.shopLogoUrl || profile.profilePhotoUrl;
        if (prevPhoto && prevPhoto !== formShopLogo) {
          await deleteStorageFileByUrl(prevPhoto);
        }
        updatePayload.shopPhotoUrl = formShopLogo;
        updatePayload.shopLogoUrl = formShopLogo;
        updatePayload.profilePhotoUrl = formShopLogo;
      }
      else if (activeModal === 'shopAddress') {
        if (!formDivision) throw new Error('Please select a division.');
        if (!formDistrict) throw new Error('Please select a district.');
        if (!formUpazila) throw new Error('Please select an upazila / thana.');
        if (!formAddress.trim()) throw new Error('Please enter road / house / village address.');

        updatePayload.division = formDivision;
        updatePayload.district = formDistrict;
        updatePayload.upazila = formUpazila;
        updatePayload.union = formUnion.trim() || null;
        updatePayload.postalCode = formPostalCode.trim() || null;
        updatePayload.address = formAddress.trim();
      }
      else if (activeModal === 'businessLinks') {
        const fbClean = formFacebook.trim();
        if (!fbClean) {
          throw new Error('Facebook Page URL is required for reseller business verification.');
        }
        if (!isValidUrl(fbClean)) {
          throw new Error('Please enter a valid Facebook Page URL (e.g. https://facebook.com/yourpage).');
        }

        if (formTiktok.trim() && !isValidUrl(formTiktok.trim())) {
          throw new Error('Please enter a valid TikTok profile URL.');
        }
        if (formInstagram.trim() && !isValidUrl(formInstagram.trim())) {
          throw new Error('Please enter a valid Instagram profile URL.');
        }
        if (formYoutube.trim() && !isValidUrl(formYoutube.trim())) {
          throw new Error('Please enter a valid YouTube channel URL.');
        }

        updatePayload.facebookPage = fbClean;
        updatePayload.tiktokUrl = formTiktok.trim() || null;
        updatePayload.instagramUrl = formInstagram.trim() || null;
        updatePayload.youtubeUrl = formYoutube.trim() || null;
      }

      await updateDoc(userRef, updatePayload);
      await logAuditAction(
        user.uid,
        user.fullName,
        user.role,
        'UPDATE_RESELLER_PROFILE_SECTION',
        user.uid,
        `Updated ${activeModal} details`
      );

      // Local State Update
      setProfile((prev) => ({ ...prev, ...updatePayload }));
      window.dispatchEvent(
        new CustomEvent('sky_profile_updated', { detail: { partial: updatePayload } })
      );
      showToast('✓ Profile updated successfully', 'success');
      setActiveModal(null);
      if (onRefreshUser) onRefreshUser();
    } catch (err: any) {
      console.error('Error saving profile modal:', err);
      setFormError(err.message || 'Failed to save changes. Please try again.');
    } finally {
      setSavingField(false);
    }
  };

  // Format joined date
  const joinedDateFormatted = profile.createdAt 
    ? (profile.createdAt.toDate ? profile.createdAt.toDate() : new Date(profile.createdAt)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'Not available';

  // Status helper mapping
  const statusConfig = {
    pending: { label: 'Under Review', bg: 'bg-slate-100 text-slate-700 border-slate-200', note: 'Account is awaiting admin review & verification.' },
    approved: { label: 'Active & Verified', bg: 'bg-emerald-50 text-emerald-800 border-emerald-300', note: 'Verified reseller account with complete access.' },
    rejected: { label: 'Application Rejected', bg: 'bg-rose-50 text-rose-800 border-rose-300', note: profile.rejectReason || 'Application was declined. Contact support.' },
    suspended: { label: 'Account Suspended', bg: 'bg-slate-100 text-slate-800 border-slate-300', note: profile.suspensionReason || 'Account suspended. Contact support.' },
  }[profile.status || 'pending'];

  // Documents state helper
  const hasDocuments = Boolean(
    profile.nidFrontUrl || profile.nidNumber || profile.birthCertificateUrl || profile.documentType
  );

  return (
    <div className="space-y-2 min-h-0 selection:bg-[#0E9AA7]/20">
      
      {/* Toast Notification */}
      {toastMessage && (
        <div className={`p-2.5 rounded-[12px] text-xs font-bold flex items-center gap-2 shadow-sm animate-in fade-in slide-in-from-top-2 motion-reduce:animate-none ${
          toastMessage.type === 'success' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-rose-50 text-rose-800 border border-rose-200'
        }`}>
          {toastMessage.type === 'success' ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" /> : <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />}
          <span>{toastMessage.text}</span>
        </div>
      )}

      {/* 1. TOP PROFILE CARD (Compact Glass) */}
      <div className="rounded-[12px] bg-white/85 backdrop-blur-xl border border-slate-200/80 shadow-[0_1px_4px_rgba(4,32,63,0.03)] p-3 flex items-center justify-between gap-2.5">
        <div className="flex items-center gap-2.5 min-w-0">
          {/* Logo / Photo with change button */}
          <div className="relative group shrink-0">
            <div className="w-11 h-11 rounded-[12px] overflow-hidden bg-slate-100 border border-slate-200 flex items-center justify-center">
              {profile.shopPhotoUrl || profile.shopLogoUrl || profile.profilePhotoUrl ? (
                <img
                  src={profile.shopPhotoUrl || profile.shopLogoUrl || profile.profilePhotoUrl}
                  alt={profile.shopName || profile.fullName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-[#04203F] text-white flex items-center justify-center font-bold text-base">
                  {(profile.shopName || profile.fullName || 'S').charAt(0).toUpperCase()}
                </div>
              )}
            </div>
            {canAccessFullApp && (
              <button
                type="button"
                onClick={() => photoUploaderRef.current?.open()}
                className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-[#0E9AA7] text-white flex items-center justify-center shadow-xs border border-white hover:scale-105 active:scale-95 transition-transform motion-reduce:transition-none cursor-pointer"
                title="Change Photo"
              >
                <Camera className="w-2.5 h-2.5" />
              </button>
            )}
          </div>

          {/* Shop & Owner Name */}
          <div className="min-w-0">
            <h3 className="text-[14px] font-bold text-[#04203F] truncate leading-tight">
              {profile.shopName || 'My Shop'}
            </h3>
            <p className="text-[11.5px] font-medium text-slate-500 truncate leading-tight mt-0.5">
              {profile.fullName || 'Reseller Owner'}
            </p>
            <span className={`inline-block mt-1 px-2 py-0.5 rounded-[8px] text-[10px] font-bold border ${statusConfig.bg}`}>
              {statusConfig.label}
            </span>
          </div>
        </div>

        {/* Action Button */}
        {canAccessFullApp && (
          <button
            type="button"
            onClick={() => handleOpenEdit('fullName')}
            className="h-9 px-3 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-slate-800 text-[12px] font-semibold transition-colors cursor-pointer shrink-0"
          >
            <span>Edit Name</span>
          </button>
        )}
      </div>

      {/* SKELETON PLACEHOLDER WHILE INITIAL LOAD */}
      {loading ? (
        <div className="space-y-2 animate-pulse motion-reduce:animate-none">
          <div className="h-24 bg-white/70 rounded-[12px]" />
          <div className="h-24 bg-white/70 rounded-[12px]" />
        </div>
      ) : (
        <>
          {/* 2. PERSONAL INFORMATION GROUP */}
          <div className="space-y-1.5">
            <div className="px-1 text-[13px] font-bold text-[#04203F] tracking-tight">Personal Information</div>
            <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] overflow-hidden divide-y divide-slate-100 shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
              {/* Full Name (Editable) */}
              <div 
                onClick={() => handleOpenEdit('fullName')}
                className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2 hover:bg-slate-50/80 active:bg-slate-100/70 transition-colors cursor-pointer select-none"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-[10px] bg-blue-50/70 text-blue-600 flex items-center justify-center shrink-0">
                    <User className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-slate-900 leading-tight truncate">Full Name</div>
                    <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">Owner legal account name</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[12px] font-medium text-slate-700 truncate max-w-[120px]">{profile.fullName || 'Not added'}</span>
                  {canAccessFullApp && <ChevronRight className="w-4 h-4 text-slate-400" />}
                </div>
              </div>

              {/* Date of Birth (Locked) */}
              <div
                onClick={() => setChangeRequestField('dob')}
                className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2 hover:bg-slate-50/80 transition-colors cursor-pointer select-none"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-[10px] bg-teal-50/70 text-[#0E9AA7] flex items-center justify-center shrink-0">
                    <Calendar className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="text-[14px] font-semibold text-slate-900 leading-tight truncate">Date of Birth</span>
                      <LockTooltipIcon size="xs" />
                    </div>
                    <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">Verified registration info</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[12px] font-medium text-slate-700">{profile.dob || 'Not specified'}</span>
                  <span className="text-[10.5px] font-semibold text-[#0E9AA7] bg-teal-50 px-2 py-1 rounded-[8px] border border-teal-200/70">
                    Request a change
                  </span>
                </div>
              </div>

              {/* Gender (View Only) */}
              <div className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-[10px] bg-purple-50/70 text-purple-600 flex items-center justify-center shrink-0">
                    <User className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-slate-900 leading-tight truncate">Gender</div>
                    <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">Registered gender profile</div>
                  </div>
                </div>
                <span className="capitalize text-[12px] font-medium text-slate-700 shrink-0">{profile.gender || 'Not specified'}</span>
              </div>
            </div>
          </div>

          {/* 3. SHOP GROUP */}
          <div className="space-y-1.5 pt-1">
            <div className="px-1 text-[13px] font-bold text-[#04203F] tracking-tight">Shop & Outlets</div>
            <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] overflow-hidden divide-y divide-slate-100 shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
              {/* Shop Name (Locked with Request Change) */}
              <div
                onClick={() => setChangeRequestField('shopName')}
                className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2 hover:bg-slate-50/80 transition-colors cursor-pointer select-none"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-[10px] bg-indigo-50/70 text-indigo-600 flex items-center justify-center shrink-0">
                    <Store className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="text-[14px] font-semibold text-slate-900 leading-tight truncate">Shop Name</span>
                      <LockTooltipIcon size="xs" />
                    </div>
                    <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">Verified store identity</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="font-bold text-[12px] text-[#04203F] truncate max-w-[100px]">{profile.shopName || 'Not set'}</span>
                  <span className="text-[10.5px] font-semibold text-[#0E9AA7] bg-teal-50 px-2 py-1 rounded-[8px] border border-teal-200/70">
                    Request a change
                  </span>
                </div>
              </div>

              {/* Profile & Shop Photo Uploader Row */}
              <ProfilePhotoUploader
                ref={photoUploaderRef}
                user={profile}
                canAccessFullApp={canAccessFullApp}
                onOpenLockedModal={onOpenLockedModal}
                onPhotoUpdated={(newUrl) => {
                  setProfile((prev) => ({
                    ...prev,
                    profilePhotoUrl: newUrl,
                    shopPhotoUrl: newUrl,
                    shopLogoUrl: newUrl,
                  }));
                  setFormShopLogo(newUrl);
                }}
                onRefreshUser={onRefreshUser}
                showToast={showToast}
              />

              {/* Shop Address (Editable) */}
              <div 
                onClick={() => handleOpenEdit('shopAddress')}
                className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2 hover:bg-slate-50/80 active:bg-slate-100/70 transition-colors cursor-pointer select-none"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-[10px] bg-emerald-50/70 text-emerald-600 flex items-center justify-center shrink-0">
                    <MapPin className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-slate-900 leading-tight truncate">Shop Address</div>
                    <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">
                      {profile.district && profile.division ? `${profile.upazila || ''}, ${profile.district}, ${profile.division}` : 'Set business location'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[12px] font-medium text-slate-700 truncate max-w-[100px]">
                    {profile.address || 'Not set'}
                  </span>
                  {canAccessFullApp && <ChevronRight className="w-4 h-4 text-slate-400" />}
                </div>
              </div>
            </div>
          </div>

          {/* 4. CONTACT GROUP */}
          <div className="space-y-1.5 pt-1">
            <div className="px-1 text-[13px] font-bold text-[#04203F] tracking-tight">Contact Information</div>
            <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] overflow-hidden divide-y divide-slate-100 shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
              {/* Email (Locked with Verified badge + Request Change) */}
              <div
                onClick={() => setChangeRequestField('email')}
                className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2 hover:bg-slate-50/80 transition-colors cursor-pointer select-none"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-[10px] bg-blue-50/70 text-blue-600 flex items-center justify-center shrink-0">
                    <Mail className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="text-[14px] font-semibold text-slate-900 leading-tight truncate">Email Address</span>
                      <LockTooltipIcon size="xs" />
                    </div>
                    <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">{profile.email || 'No email registered'}</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {profile.emailVerified ? (
                    <span className="text-[10.5px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-[8px] border border-emerald-200 flex items-center gap-1">
                      <Check className="w-3 h-3 text-emerald-600" />
                      <span>Verified</span>
                    </span>
                  ) : (
                    <span className="text-[10.5px] font-bold text-slate-700 bg-slate-100 px-2 py-0.5 rounded-[8px] border border-slate-200">
                      Not verified
                    </span>
                  )}
                  <span className="text-[10.5px] font-semibold text-[#0E9AA7] bg-teal-50 px-2 py-1 rounded-[8px] border border-teal-200/70">
                    Request a change
                  </span>
                </div>
              </div>

              {/* Mobile Number */}
              <div className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-[10px] bg-emerald-50/70 text-emerald-600 flex items-center justify-center shrink-0">
                    <Phone className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-slate-900 leading-tight truncate">Mobile Number</div>
                    <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">Primary OTP login phone</div>
                  </div>
                </div>
                <span className="font-mono text-[12px] font-bold text-slate-800 shrink-0">{profile.mobile || 'Not set'}</span>
              </div>

              {/* WhatsApp Number */}
              <div className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-[10px] bg-teal-50/70 text-[#0E9AA7] flex items-center justify-center shrink-0">
                    <MessageSquare className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-slate-900 leading-tight truncate">WhatsApp Number</div>
                    <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">Direct order notifications</div>
                  </div>
                </div>
                <span className="font-mono text-[12px] font-bold text-slate-800 shrink-0">
                  {profile.whatsappNumber || profile.whatsapp || profile.mobile || 'Not set'}
                </span>
              </div>
            </div>
          </div>

          {/* 5. BUSINESS GROUP (Social Media Channels) */}
          <div className="space-y-1.5 pt-1">
            <div className="px-1 text-[13px] font-bold text-[#04203F] tracking-tight">Business & Marketing Channels</div>
            <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] overflow-hidden divide-y divide-slate-100 shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
              <div 
                onClick={() => handleOpenEdit('businessLinks')}
                className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2 hover:bg-slate-50/80 active:bg-slate-100/70 transition-colors cursor-pointer select-none"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-[10px] bg-blue-50/70 text-blue-600 flex items-center justify-center shrink-0">
                    <Globe className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-slate-900 leading-tight truncate">Social Media Pages</div>
                    <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">Facebook, TikTok, Instagram & YouTube</div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[12px] font-medium text-slate-700">
                    {profile.facebookPage ? 'Configured' : 'Add Facebook'}
                  </span>
                  {canAccessFullApp && <ChevronRight className="w-4 h-4 text-slate-400" />}
                </div>
              </div>
            </div>
          </div>

          {/* 6. ACCOUNT GROUP */}
          <div className="space-y-1.5 pt-1">
            <div className="px-1 text-[13px] font-bold text-[#04203F] tracking-tight">Account Credentials</div>
            <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] overflow-hidden divide-y divide-slate-100 shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
              {/* Reseller ID with Copy */}
              <div className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-[#04203F] flex items-center justify-center shrink-0">
                    <Shield className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-slate-900 leading-tight truncate">Reseller ID</div>
                    <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">Your official account tracking code</div>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    const idToCopy = formatResellerId(profile);
                    navigator.clipboard.writeText(idToCopy);
                    setCopiedId(true);
                    triggerHaptic('light');
                    showToast('Reseller ID copied', 'success');
                    setTimeout(() => setCopiedId(false), 2000);
                  }}
                  className="h-9 inline-flex items-center gap-1 px-2.5 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-slate-800 font-mono font-bold text-[11.5px] border border-slate-200/80 transition-colors shrink-0 cursor-pointer"
                >
                  <span>{formatResellerId(profile)}</span>
                  {copiedId ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5 text-slate-400" />}
                </button>
              </div>

              {/* Account Status */}
              <div className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                    <ShieldAlert className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-slate-900 leading-tight truncate">Account Status</div>
                    <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">{statusConfig.note}</div>
                  </div>
                </div>
                <span className={`px-2 py-0.5 rounded-[8px] text-[10.5px] font-bold border shrink-0 ${statusConfig.bg}`}>
                  {statusConfig.label}
                </span>
              </div>

              {/* Joined Date */}
              <div className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2">
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-600 flex items-center justify-center shrink-0">
                    <Calendar className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold text-slate-900 leading-tight truncate">Member Since</div>
                    <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">Account registration date</div>
                  </div>
                </div>
                <span className="font-mono text-[12px] font-semibold text-slate-700 shrink-0">{joinedDateFormatted}</span>
              </div>

              {/* Last Login */}
              {lastLoginTime && (
                <div className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2.5 min-w-0">
                    <div className="w-9 h-9 rounded-[10px] bg-teal-50/70 text-[#0E9AA7] flex items-center justify-center shrink-0">
                      <Clock className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[14px] font-semibold text-slate-900 leading-tight truncate">Last Active Session</div>
                      <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">Most recent sign-in</div>
                    </div>
                  </div>
                  <span className="font-mono text-[11px] text-slate-600 shrink-0">{lastLoginTime}</span>
                </div>
              )}
            </div>
          </div>

          {/* 7. DOCUMENTS GROUP (Privacy-Safe: NEVER displays raw image back) */}
          <div className="space-y-1.5 pt-1">
            <div className="px-1 text-[13px] font-bold text-[#04203F] tracking-tight">Identity & Verification Documents</div>
            <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] overflow-hidden divide-y divide-slate-100 shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
              <div
                onClick={() =>
                  setChangeRequestField(
                    profile.documentType === 'birth_certificate' ? 'birth_certificate' : 'nid'
                  )
                }
                className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2 hover:bg-slate-50/80 active:bg-slate-100/70 transition-colors cursor-pointer select-none"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-9 h-9 rounded-[10px] bg-emerald-50/70 text-emerald-600 flex items-center justify-center shrink-0">
                    <FileText className="w-4 h-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1">
                      <span className="text-[14px] font-semibold text-slate-900 leading-tight truncate">
                        {profile.documentType === 'birth_certificate' ? 'Birth Certificate' : 'National ID (NID)'}
                      </span>
                      <LockTooltipIcon size="xs" />
                    </div>
                    <div className="text-[11.5px] font-medium text-slate-500 leading-tight mt-0.5 truncate">
                      {hasDocuments
                        ? (profile.status === 'approved' ? 'Verified & locked after registration' : 'Under verification review')
                        : 'No identity document on file'}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {hasDocuments ? (
                    <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-[6px] border border-emerald-200 flex items-center gap-1">
                      <Check className="w-3 h-3 text-emerald-600" />
                      <span>Locked</span>
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold text-rose-700 bg-rose-50 px-2 py-0.5 rounded-[6px] border border-rose-200">
                      Not submitted
                    </span>
                  )}
                  <span className="text-[10.5px] font-bold text-[#0E9AA7] bg-teal-50 px-2 py-1 rounded-[8px] border border-teal-200">
                    Request a change
                  </span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ========================================================
          BOTTOM SHEET MODALS (EDIT ACTIONS)
         ======================================================== */}
      {activeModal && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/60 backdrop-blur-xs animate-in fade-in duration-150 motion-reduce:animate-none">
          <div className="w-full max-w-md bg-white rounded-t-[16px] sm:rounded-[14px] shadow-2xl border border-slate-200 p-4 space-y-3 animate-in slide-in-from-bottom duration-200 motion-reduce:animate-none text-xs">
            
            {/* Modal Header */}
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <h4 className="text-[15px] font-bold text-[#04203F]">
                {activeModal === 'fullName' && 'Edit Full Name'}
                {activeModal === 'shopLogo' && 'Update Shop Logo / Photo'}
                {activeModal === 'shopAddress' && 'Edit Shop Address'}
                {activeModal === 'businessLinks' && 'Update Social Media Channels'}
              </h4>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                className="w-9 h-9 text-slate-400 hover:text-slate-600 rounded-[10px] bg-slate-100 flex items-center justify-center cursor-pointer"
                aria-label="Close modal"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Error Message */}
            {formError && (
              <div className="p-2.5 rounded-[12px] bg-rose-50 border border-rose-200 text-rose-700 text-[11.5px] flex items-center gap-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            {/* Modal Body 1: Full Name */}
            {activeModal === 'fullName' && (
              <div className="space-y-2">
                <label className="block text-[11px] font-bold text-slate-600 uppercase">Account Owner Full Name *</label>
                <input
                  type="text"
                  value={formFullName}
                  onChange={(e) => setFormFullName(e.target.value)}
                  placeholder="e.g. Tanvir Ahmed"
                  className={DT.inputHeight}
                />
                <p className="text-[11px] text-slate-500">
                  Please match the full legal name associated with your registered payout accounts.
                </p>
              </div>
            )}

            {/* Modal Body 2: Shop Logo / Photo */}
            {activeModal === 'shopLogo' && (
              <ImageUploadField
                label="Shop Logo / Photo (শপ লোগো)"
                value={formShopLogo}
                onChange={(url) => {
                  setFormShopLogo(url);
                  triggerHaptic('light');
                }}
                storagePath={`users/${user.uid}/shop`}
                theme="light"
                size="md"
                captureMode="user"
                placeholderText="লোগো নেই"
                helperText="গ্যালারি, ক্যামেরা বা ড্র্যাগ করে শপ লোগো দিন (সর্বোচ্চ ৩০ MB)"
              />
            )}

            {/* Modal Body 3: Shop Address */}
            {activeModal === 'shopAddress' && (
              <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
                {/* Division */}
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-500 uppercase mb-0.5">Division *</label>
                  <select
                    value={formDivision}
                    onChange={(e) => {
                      setFormDivision(e.target.value);
                      setFormDistrict('');
                      setFormUpazila('');
                    }}
                    className="w-full h-10 px-2.5 bg-slate-50 border border-slate-200 rounded-[12px] text-xs font-semibold outline-none"
                  >
                    <option value="">Select Division</option>
                    {divisionsList.map((div) => (
                      <option key={div} value={div}>{div}</option>
                    ))}
                  </select>
                </div>

                {/* District */}
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-500 uppercase mb-0.5">District *</label>
                  <select
                    value={formDistrict}
                    disabled={!formDivision}
                    onChange={(e) => {
                      setFormDistrict(e.target.value);
                      setFormUpazila('');
                    }}
                    className="w-full h-10 px-2.5 bg-slate-50 border border-slate-200 rounded-[12px] text-xs font-semibold outline-none disabled:opacity-50"
                  >
                    <option value="">Select District</option>
                    {districtsList.map((dis) => (
                      <option key={dis} value={dis}>{dis}</option>
                    ))}
                  </select>
                </div>

                {/* Upazila */}
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-500 uppercase mb-0.5">Upazila / Thana *</label>
                  <select
                    value={formUpazila}
                    disabled={!formDistrict}
                    onChange={(e) => setFormUpazila(e.target.value)}
                    className="w-full h-10 px-2.5 bg-slate-50 border border-slate-200 rounded-[12px] text-xs font-semibold outline-none disabled:opacity-50"
                  >
                    <option value="">Select Upazila</option>
                    {upazilasList.map((upz) => (
                      <option key={upz} value={upz}>{upz}</option>
                    ))}
                  </select>
                </div>

                {/* Postal Code & Union */}
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10.5px] font-bold text-slate-500 uppercase mb-0.5">Postal Code</label>
                    <input
                      type="text"
                      value={formPostalCode}
                      onChange={(e) => setFormPostalCode(e.target.value)}
                      placeholder="e.g. 1216"
                      className="w-full h-10 px-2.5 bg-slate-50 border border-slate-200 rounded-[12px] text-xs outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[10.5px] font-bold text-slate-500 uppercase mb-0.5">Union / Ward</label>
                    <input
                      type="text"
                      value={formUnion}
                      onChange={(e) => setFormUnion(e.target.value)}
                      placeholder="e.g. Ward 4"
                      className="w-full h-10 px-2.5 bg-slate-50 border border-slate-200 rounded-[12px] text-xs outline-none"
                    />
                  </div>
                </div>

                {/* Full Address */}
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-500 uppercase mb-0.5">Full Street / Village Address *</label>
                  <textarea
                    rows={2}
                    value={formAddress}
                    onChange={(e) => setFormAddress(e.target.value)}
                    placeholder="House, Road, Area, Landmark"
                    className="w-full p-2.5 bg-slate-50 border border-slate-200 rounded-[12px] text-xs outline-none"
                  />
                </div>
              </div>
            )}

            {/* Modal Body 4: Business Social Channels */}
            {activeModal === 'businessLinks' && (
              <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
                <div>
                  <label className="block text-[10.5px] font-bold text-slate-600 uppercase mb-0.5">
                    Facebook Page URL <span className="text-rose-500">* Required</span>
                  </label>
                  <input
                    type="url"
                    value={formFacebook}
                    onChange={(e) => setFormFacebook(e.target.value)}
                    placeholder="https://facebook.com/yourshop"
                    className={DT.inputHeight}
                  />
                </div>

                <div>
                  <label className="block text-[10.5px] font-bold text-slate-500 uppercase mb-0.5">TikTok Profile URL (Optional)</label>
                  <input
                    type="url"
                    value={formTiktok}
                    onChange={(e) => setFormTiktok(e.target.value)}
                    placeholder="https://tiktok.com/@yourshop"
                    className={DT.inputHeight}
                  />
                </div>

                <div>
                  <label className="block text-[10.5px] font-bold text-slate-500 uppercase mb-0.5">Instagram Profile URL (Optional)</label>
                  <input
                    type="url"
                    value={formInstagram}
                    onChange={(e) => setFormInstagram(e.target.value)}
                    placeholder="https://instagram.com/yourshop"
                    className={DT.inputHeight}
                  />
                </div>

                <div>
                  <label className="block text-[10.5px] font-bold text-slate-500 uppercase mb-0.5">YouTube Channel URL (Optional)</label>
                  <input
                    type="url"
                    value={formYoutube}
                    onChange={(e) => setFormYoutube(e.target.value)}
                    placeholder="https://youtube.com/@yourshop"
                    className={DT.inputHeight}
                  />
                </div>
              </div>
            )}

            {/* Modal Footer Actions (for standard edit modals) */}
            <div className="pt-2 flex items-center justify-end gap-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                disabled={savingField}
                className="h-9 px-3.5 rounded-[12px] bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSaveModal}
                disabled={savingField}
                className="h-9 px-4 rounded-[12px] bg-[#04203F] hover:bg-[#0E9AA7] text-white font-bold inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer disabled:opacity-50"
              >
                {savingField ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <span>Save Changes</span>
                )}
              </button>
            </div>

          </div>
        </div>
      )}

      <ChangeRequestModal
        isOpen={Boolean(changeRequestField)}
        onClose={() => setChangeRequestField(null)}
        user={profile}
        initialField={changeRequestField || 'shopName'}
        onSubmitted={(msg) => showToast(msg, 'success')}
      />

    </div>
  );
};
