import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import {
  AlertCircle,
  ArrowLeft,
  Building2,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Globe,
  ImagePlus,
  Loader2,
  MapPin,
  Phone,
  RefreshCw,
  Save,
  Send,
  ShieldCheck,
  Sparkles,
  Store,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { db } from '../../lib/firebase';
import { ChangeRequestFieldKey, UserProfile } from '../../types';
import { BANGLADESH_GEO } from '../../data/bangladeshGeo';
import { deleteStorageFileByUrl, useImageUpload } from '../../hooks/useImageUpload';
import { ImageUploadField } from '../common/ImageUploadField';
import { LockTooltipIcon } from '../common/LockTooltipIcon';
import { ChangeRequestModal } from '../common/ChangeRequestModal';
import { getMaskedCurrentValueForField } from '../../lib/lockedFieldsService';
import { formatResellerId } from '../../lib/resellerIdHelper';
import { logAuditAction } from '../../lib/auditLogger';
import { triggerHaptic } from '../../lib/nativeFeedback';

interface ResellerEditProfilePageProps {
  user: UserProfile;
  onBack: () => void;
  onSaved?: (updatedFields: Partial<UserProfile>) => void;
}

interface EditProfileFormState {
  profilePhotoUrl: string;
  shopCoverUrl: string;
  fullName: string;
  shopBio: string;
  languagePreference: 'en' | 'bn';
  mobile: string;
  whatsappNumber: string;
  alternatePhone: string;
  preferredContactMethod: 'whatsapp' | 'phone' | 'email' | 'chat';
  division: string;
  district: string;
  upazila: string;
  union: string;
  postalCode: string;
  address: string;
  landmark: string;
  businessHours: string;
  facebookPage: string;
  websiteUrl: string;
  tiktokUrl: string;
  instagramUrl: string;
  youtubeUrl: string;
}

type SectionKey = 'photo' | 'personal' | 'contact' | 'address' | 'business' | 'verified';

const BD_MOBILE_REGEX = /^01[3-9]\d{8}$/;

function normalizePhoneInput(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+880')) return `0${digits.slice(4)}`;
  if (digits.startsWith('880') && digits.length >= 13) return `0${digits.slice(3)}`;
  return digits;
}

function isValidHttpUrl(val: string): boolean {
  const trimmed = val.trim();
  if (!trimmed) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildInitialState(user: UserProfile): EditProfileFormState {
  const mobile = user.mobile || '';
  const whatsapp = user.whatsappNumber || user.whatsapp || '';
  return {
    profilePhotoUrl: user.profilePhotoUrl || user.shopPhotoUrl || user.shopLogoUrl || '',
    shopCoverUrl: user.shopCoverUrl || '',
    fullName: user.fullName || '',
    shopBio: (user.shopBio || '').slice(0, 160),
    languagePreference: user.languagePreference === 'bn' ? 'bn' : 'en',
    mobile,
    whatsappNumber: whatsapp,
    alternatePhone: user.alternatePhone || '',
    preferredContactMethod: user.preferredContactMethod || 'whatsapp',
    division: user.division || '',
    district: user.district || '',
    upazila: user.upazila || '',
    union: user.union || user.ward || '',
    postalCode: user.postalCode || '',
    address: user.address || '',
    landmark: user.landmark || '',
    businessHours: user.businessHours || '',
    facebookPage: user.facebookPage || '',
    websiteUrl: user.websiteUrl || '',
    tiktokUrl: user.tiktokUrl || '',
    instagramUrl: user.instagramUrl || '',
    youtubeUrl: user.youtubeUrl || '',
  };
}

export const ResellerEditProfilePage: React.FC<ResellerEditProfilePageProps> = ({
  user,
  onBack,
  onSaved,
}) => {
  const initialRef = useRef<EditProfileFormState>(buildInitialState(user));
  const [form, setForm] = useState<EditProfileFormState>(() => buildInitialState(user));
  const [sameAsMobile, setSameAsMobile] = useState<boolean>(() => {
    const m = (user.mobile || '').trim();
    const w = (user.whatsappNumber || user.whatsapp || '').trim();
    return Boolean(m && (!w || m === w));
  });

  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({
    photo: true,
    personal: true,
    contact: true,
    address: true,
    business: false,
    verified: false,
  });

  const [showAvatarSheet, setShowAvatarSheet] = useState(false);
  const [showUnsavedSheet, setShowUnsavedSheet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [changeRequestField, setChangeRequestField] = useState<ChangeRequestFieldKey | null>(null);
  const [viewportBottomOffset, setViewportBottomOffset] = useState(0);

  const avatarGalleryInputRef = useRef<HTMLInputElement | null>(null);
  const avatarCameraInputRef = useRef<HTMLInputElement | null>(null);
  const sectionRefs = useRef<Record<SectionKey, HTMLDivElement | null>>({
    photo: null,
    personal: null,
    contact: null,
    address: null,
    business: null,
    verified: null,
  });

  const showToastMsg = useCallback((text: string, type: 'success' | 'error' = 'success') => {
    setToast({ text, type });
    window.setTimeout(() => {
      setToast((curr) => (curr?.text === text ? null : curr));
    }, 3500);
  }, []);

  // Dedicated Avatar image uploader with 30MB support & compression
  const {
    isPreparing: avatarPreparing,
    isUploading: avatarUploading,
    progress: avatarProgress,
    error: avatarError,
    localPreviewUrl: avatarLocalPreview,
    clearError: clearAvatarError,
    uploadImage: uploadAvatarImage,
  } = useImageUpload({
    storagePath: `users/${user.uid}/profile`,
    compress: { maxLongestSide: 1024, initialQuality: 0.82, targetMaxBytes: 350 * 1024 },
  });

  const isAvatarBusy = avatarPreparing || avatarUploading;
  const displayedAvatarUrl = avatarLocalPreview || form.profilePhotoUrl;

  const isDirty = useMemo(() => {
    const base = initialRef.current;
    return (Object.keys(base) as Array<keyof EditProfileFormState>).some(
      (k) => String(form[k] ?? '').trim() !== String(base[k] ?? '').trim()
    );
  }, [form]);

  // Validation (Live EN + BN messages)
  const validationErrors = useMemo(() => {
    const errs: Partial<Record<keyof EditProfileFormState, string>> = {};

    if (!form.fullName.trim() || form.fullName.trim().length < 2) {
      errs.fullName = 'পূর্ণ নাম লিখুন (Full name must be at least 2 characters)';
    }

    if (form.shopBio.length > 160) {
      errs.shopBio = 'সর্বোচ্চ ১৬০ অক্ষর (Maximum 160 characters)';
    }

    const mob = normalizePhoneInput(form.mobile);
    if (!BD_MOBILE_REGEX.test(mob)) {
      errs.mobile = 'সঠিক মোবাইল নম্বর দিন যেমন 017XXXXXXXX (Valid BD mobile required)';
    }

    const wa = normalizePhoneInput(sameAsMobile ? form.mobile : form.whatsappNumber);
    if (wa && !BD_MOBILE_REGEX.test(wa)) {
      errs.whatsappNumber = 'সঠিক WhatsApp নম্বর দিন যেমন 017XXXXXXXX (Invalid WhatsApp number)';
    }

    const alt = normalizePhoneInput(form.alternatePhone);
    if (alt && !BD_MOBILE_REGEX.test(alt)) {
      errs.alternatePhone = 'সঠিক বিকল্প নম্বর দিন (Valid BD number e.g. 018XXXXXXXX)';
    }

    if (form.postalCode.trim() && !/^\d{4}$/.test(form.postalCode.trim())) {
      errs.postalCode = '৪ সংখ্যার পোস্ট কোড দিন (Postal code must be 4 digits)';
    }

    if (!form.division.trim()) {
      errs.division = 'বিভাগ নির্বাচন করুন (Division is required)';
    }
    if (!form.district.trim()) {
      errs.district = 'জেলা নির্বাচন করুন (District is required)';
    }
    if (!form.upazila.trim()) {
      errs.upazila = 'উপজেলা/থানা নির্বাচন করুন (Upazila/Thana is required)';
    }
    if (!form.address.trim()) {
      errs.address = 'বিস্তারিত ঠিকানা লিখুন (Address line is required)';
    }

    const urlFields: Array<keyof EditProfileFormState> = [
      'facebookPage',
      'websiteUrl',
      'tiktokUrl',
      'instagramUrl',
      'youtubeUrl',
    ];
    urlFields.forEach((field) => {
      const val = form[field];
      if (val && !isValidHttpUrl(val)) {
        errs[field] = 'সঠিক লিংক দিন (Start URL with https:// or http://)';
      }
    });

    return errs;
  }, [form, sameAsMobile]);

  const hasValidationErrors = Object.keys(validationErrors).length > 0;

  // Profile completion calculation + missing-item tips
  const completionInfo = useMemo(() => {
    const items: Array<{ key: string; label: string; done: boolean; section: SectionKey }> = [
      { key: 'photo', label: 'Profile photo', done: Boolean(form.profilePhotoUrl.trim()), section: 'photo' },
      { key: 'cover', label: 'Shop banner', done: Boolean(form.shopCoverUrl.trim()), section: 'photo' },
      { key: 'bio', label: 'Shop bio', done: Boolean(form.shopBio.trim()), section: 'personal' },
      { key: 'whatsapp', label: 'WhatsApp number', done: Boolean((sameAsMobile ? form.mobile : form.whatsappNumber).trim()), section: 'contact' },
      { key: 'address', label: 'Full shop address', done: Boolean(form.division && form.district && form.upazila && form.address.trim()), section: 'address' },
      { key: 'social', label: 'Business link', done: Boolean(form.facebookPage.trim() || form.websiteUrl.trim() || form.tiktokUrl.trim() || form.instagramUrl.trim() || form.youtubeUrl.trim()), section: 'business' },
      { key: 'hours', label: 'Business hours', done: Boolean(form.businessHours.trim()), section: 'business' },
    ];
    const doneCount = items.filter((i) => i.done).length;
    const pct = Math.round((doneCount / items.length) * 100);
    const missing = items.filter((i) => !i.done);
    return { pct, missing };
  }, [form, sameAsMobile]);

  // Keep WhatsApp synced when Same as Mobile is toggled ON
  useEffect(() => {
    if (sameAsMobile) {
      setForm((prev) =>
        prev.whatsappNumber === prev.mobile ? prev : { ...prev, whatsappNumber: prev.mobile }
      );
    }
  }, [sameAsMobile, form.mobile]);

  // Fullscreen shell hiding (shop header + bottom nav) & Android hardware back integration
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('sky_fullscreen_overlay', { detail: { open: true } }));
    return () => {
      window.dispatchEvent(new CustomEvent('sky_fullscreen_overlay', { detail: { open: false } }));
    };
  }, []);

  const handleBackRequest = useCallback(() => {
    if (saving || isAvatarBusy) return;
    if (isDirty) {
      setShowUnsavedSheet(true);
    } else {
      onBack();
    }
  }, [isDirty, isAvatarBusy, onBack, saving]);

  useEffect(() => {
    const onHwBack = () => {
      if (changeRequestField) {
        setChangeRequestField(null);
        return;
      }
      if (showAvatarSheet) {
        setShowAvatarSheet(false);
        return;
      }
      if (showUnsavedSheet) {
        setShowUnsavedSheet(false);
        return;
      }
      handleBackRequest();
    };
    window.addEventListener('sky_fullscreen_overlay_back', onHwBack);
    return () => window.removeEventListener('sky_fullscreen_overlay_back', onHwBack);
  }, [changeRequestField, handleBackRequest, showAvatarSheet, showUnsavedSheet]);

  // VisualViewport keyboard-safe bottom bar offset
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const updateOffset = () => {
      const keyboardHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setViewportBottomOffset(keyboardHeight);
    };
    vv.addEventListener('resize', updateOffset);
    vv.addEventListener('scroll', updateOffset);
    updateOffset();
    return () => {
      vv.removeEventListener('resize', updateOffset);
      vv.removeEventListener('scroll', updateOffset);
    };
  }, []);

  const toggleSection = (key: SectionKey) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const jumpToSection = (section: SectionKey) => {
    setOpenSections((prev) => ({ ...prev, [section]: true }));
    window.setTimeout(() => {
      sectionRefs.current[section]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 60);
  };

  const handleAvatarFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || isAvatarBusy) return;
    setShowAvatarSheet(false);
    clearAvatarError();

    // Only delete an intermediate unsaved upload immediately; keep saved Firestore photo safe until user taps Save
    const currentUnsavedUrl =
      form.profilePhotoUrl && form.profilePhotoUrl !== initialRef.current.profilePhotoUrl
        ? form.profilePhotoUrl
        : null;

    const result = await uploadAvatarImage(file, currentUnsavedUrl);
    if (result?.downloadUrl) {
      setForm((prev) => ({ ...prev, profilePhotoUrl: result.downloadUrl }));
      triggerHaptic('light');
      showToastMsg('Photo ready! Tap Save to apply.', 'success');
    }
  };

  const handleRemoveAvatar = async () => {
    setShowAvatarSheet(false);
    clearAvatarError();
    const current = form.profilePhotoUrl;
    if (current && current !== initialRef.current.profilePhotoUrl) {
      await deleteStorageFileByUrl(current);
    }
    setForm((prev) => ({ ...prev, profilePhotoUrl: '' }));
    triggerHaptic('light');
  };

  const handleSave = async () => {
    if (saving || isAvatarBusy || hasValidationErrors || !isDirty) return;
    setSaving(true);
    setSaveError('');
    triggerHaptic('medium');

    const cleanMobile = normalizePhoneInput(form.mobile);
    const cleanWhatsapp = normalizePhoneInput(sameAsMobile ? form.mobile : form.whatsappNumber) || cleanMobile;
    const cleanAlt = normalizePhoneInput(form.alternatePhone);

    // STRICT ALLOWLIST: Only non-locked, non-privileged, non-password profile fields
    const payload: Record<string, any> = {
      fullName: form.fullName.trim(),
      shopBio: form.shopBio.trim().slice(0, 160),
      languagePreference: form.languagePreference,
      mobile: cleanMobile,
      whatsappNumber: cleanWhatsapp,
      whatsapp: cleanWhatsapp,
      alternatePhone: cleanAlt,
      preferredContactMethod: form.preferredContactMethod,
      division: form.division.trim(),
      district: form.district.trim(),
      upazila: form.upazila.trim(),
      union: form.union.trim(),
      postalCode: form.postalCode.trim(),
      address: form.address.trim(),
      landmark: form.landmark.trim(),
      businessHours: form.businessHours.trim(),
      facebookPage: form.facebookPage.trim(),
      websiteUrl: form.websiteUrl.trim(),
      tiktokUrl: form.tiktokUrl.trim(),
      instagramUrl: form.instagramUrl.trim(),
      youtubeUrl: form.youtubeUrl.trim(),
      profilePhotoUrl: form.profilePhotoUrl.trim(),
      shopPhotoUrl: form.profilePhotoUrl.trim(),
      shopLogoUrl: form.profilePhotoUrl.trim(),
      shopCoverUrl: form.shopCoverUrl.trim(),
      updatedAt: serverTimestamp(),
    };

    try {
      const oldPhoto = initialRef.current.profilePhotoUrl;
      await updateDoc(doc(db, 'users', user.uid), payload);

      // Clean up replaced previous profile photo once Firestore save succeeds
      if (oldPhoto && oldPhoto !== payload.profilePhotoUrl) {
        await deleteStorageFileByUrl(oldPhoto);
      }

      await logAuditAction(
        user.uid,
        payload.fullName || user.shopName || 'Reseller',
        user.role || 'reseller',
        'UPDATE_RESELLER_PROFILE',
        user.uid,
        'Updated profile details from Edit Profile page'
      );

      initialRef.current = {
        ...form,
        mobile: cleanMobile,
        whatsappNumber: cleanWhatsapp,
        alternatePhone: cleanAlt,
      };
      setForm(initialRef.current);

      triggerHaptic('success');
      showToastMsg('✓ Profile updated! প্রোফাইল আপডেট হয়েছে', 'success');
      onSaved?.(payload as Partial<UserProfile>);
    } catch (err: any) {
      console.error('Error saving profile:', err);
      triggerHaptic('error');
      setSaveError(
        err?.message || 'Could not save profile changes. Please check your connection and retry.'
      );
    } finally {
      setSaving(false);
    }
  };

  const divisions = Object.keys(BANGLADESH_GEO);
  const districts =
    form.division && BANGLADESH_GEO[form.division]
      ? Object.keys(BANGLADESH_GEO[form.division])
      : [];
  const upazilas =
    form.division && form.district && BANGLADESH_GEO[form.division]?.[form.district]
      ? BANGLADESH_GEO[form.division][form.district]
      : [];

  const canSave = isDirty && !hasValidationErrors && !saving && !isAvatarBusy;

  const lockedItems: Array<{
    key: ChangeRequestFieldKey;
    label: string;
    value: string;
  }> = [
    {
      key: 'shopName',
      label: 'Shop Name',
      value: getMaskedCurrentValueForField(user, 'shopName'),
    },
    {
      key: 'email',
      label: 'Email Address',
      value: getMaskedCurrentValueForField(user, 'email'),
    },
    {
      key: 'dob',
      label: 'Date of Birth',
      value: getMaskedCurrentValueForField(user, 'dob'),
    },
    {
      key: user.documentType === 'birth_certificate' ? 'birth_certificate' : 'nid',
      label: user.documentType === 'birth_certificate' ? 'Birth Certificate' : 'NID Number',
      value: getMaskedCurrentValueForField(
        user,
        user.documentType === 'birth_certificate' ? 'birth_certificate' : 'nid'
      ),
    },
    {
      key: 'payout',
      label: 'Payout Account',
      value: getMaskedCurrentValueForField(user, 'payout'),
    },
  ];

  return (
    <div className="fixed inset-0 z-50 bg-slate-50 flex justify-center">
      <div className="w-full max-w-2xl h-[100dvh] bg-gradient-to-b from-slate-50 via-white to-slate-50 flex flex-col relative overflow-hidden">
        {/* Hidden inputs for Avatar Camera / Gallery */}
        <input
          ref={avatarGalleryInputRef}
          type="file"
          accept="image/*"
          onChange={handleAvatarFileSelected}
          className="hidden"
        />
        <input
          ref={avatarCameraInputRef}
          type="file"
          accept="image/*"
          capture="user"
          onChange={handleAvatarFileSelected}
          className="hidden"
        />

        {/* Slim Sticky Header */}
        <header className="shrink-0 sticky top-0 z-20 bg-white/85 backdrop-blur-xl border-b border-slate-200/80 px-3 pt-[calc(env(safe-area-inset-top,0px)+0.5rem)] pb-2 flex items-center justify-between gap-2 min-h-[54px]">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={handleBackRequest}
              className="w-9 h-9 rounded-xl bg-slate-100 hover:bg-slate-200 text-[#04203F] flex items-center justify-center shrink-0 transition-colors cursor-pointer motion-reduce:transition-none"
              aria-label="Back to Account"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <h1 className="text-[16px] font-extrabold text-[#04203F] leading-tight truncate">
                Edit Profile
              </h1>
              <p className="text-[11px] font-medium text-slate-500 truncate leading-tight">
                {user.shopName || 'Reseller'} • {formatResellerId(user)}
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="h-9 px-3.5 rounded-xl bg-[#04203F] hover:bg-[#072e58] disabled:opacity-40 disabled:cursor-not-allowed text-white text-[12px] font-bold flex items-center gap-1.5 shrink-0 transition-colors cursor-pointer motion-reduce:transition-none"
          >
            {saving ? (
              <>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>Saving</span>
              </>
            ) : (
              <>
                <Save className="w-3.5 h-3.5 text-[#3DD055]" />
                <span>Save</span>
              </>
            )}
          </button>
        </header>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overscroll-contain px-3 sm:px-4 pt-3 pb-28 space-y-3">
          {/* Save Error Banner with Retry */}
          {saveError && (
            <div className="rounded-[12px] bg-rose-50 border border-rose-200 p-3 flex items-start justify-between gap-2.5">
              <div className="flex items-start gap-2 min-w-0">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-[12px] font-bold text-rose-800">Failed to save changes</p>
                  <p className="text-[11px] text-rose-700 leading-snug break-words">{saveError}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving}
                className="shrink-0 h-8 px-2.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white text-[11px] font-bold inline-flex items-center gap-1 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Retry</span>
              </button>
            </div>
          )}

          {/* Profile Completion Card */}
          <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] p-3 shadow-2xs space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <Sparkles className="w-3.5 h-3.5 text-[#0E9AA7] shrink-0" />
                <span className="text-[12px] font-bold text-[#04203F] truncate">
                  Profile {completionInfo.pct}% complete
                </span>
              </div>
              <span className="text-[11px] font-extrabold text-[#0E9AA7] tabular-nums shrink-0">
                {completionInfo.pct === 100 ? 'Complete' : `${completionInfo.missing.length} left`}
              </span>
            </div>
            <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[#0E9AA7] to-[#3DD055] rounded-full transition-all duration-300 motion-reduce:transition-none"
                style={{ width: `${completionInfo.pct}%` }}
              />
            </div>
            {completionInfo.missing.length > 0 && (
              <div className="flex items-center gap-1.5 flex-wrap pt-0.5">
                <span className="text-[10.5px] font-medium text-slate-500">Add:</span>
                {completionInfo.missing.slice(0, 4).map((tip) => (
                  <button
                    key={tip.key}
                    type="button"
                    onClick={() => jumpToSection(tip.section)}
                    className="px-2 py-0.5 rounded-md bg-teal-50 hover:bg-teal-100 border border-teal-200/70 text-[10.5px] font-semibold text-[#04203F] transition-colors cursor-pointer"
                  >
                    + {tip.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* SECTION 1: PHOTO & SHOP BANNER */}
          <div
            ref={(el) => {
              sectionRefs.current.photo = el;
            }}
            className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] shadow-2xs overflow-hidden"
          >
            <button
              type="button"
              onClick={() => toggleSection('photo')}
              className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left bg-slate-50/70 border-b border-slate-100 cursor-pointer"
            >
              <span className="text-[13px] font-bold text-[#04203F] flex items-center gap-2">
                <Camera className="w-4 h-4 text-[#0E9AA7]" />
                <span>Photo & Shop Banner</span>
              </span>
              {openSections.photo ? (
                <ChevronUp className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              )}
            </button>

            {openSections.photo && (
              <div className="p-3.5 space-y-3.5">
                {/* Round Avatar + Camera Badge */}
                <div className="flex flex-col items-center text-center gap-2">
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => !isAvatarBusy && setShowAvatarSheet(true)}
                      disabled={isAvatarBusy}
                      className="w-24 h-24 rounded-full bg-slate-100 border-2 border-[#0E9AA7]/30 overflow-hidden flex items-center justify-center shadow-sm relative group cursor-pointer"
                      aria-label="Change profile photo or shop logo"
                    >
                      {displayedAvatarUrl ? (
                        <img
                          src={displayedAvatarUrl}
                          alt={form.fullName || 'Profile photo'}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-[#04203F] to-[#0E9AA7] text-white flex items-center justify-center font-extrabold text-2xl">
                          {(form.fullName || user.shopName || 'R').charAt(0).toUpperCase()}
                        </div>
                      )}

                      {isAvatarBusy && (
                        <div className="absolute inset-0 bg-slate-950/65 flex flex-col items-center justify-center text-white">
                          <Loader2 className="w-5 h-5 animate-spin text-[#5EEAD4]" />
                          <span className="text-[10px] font-bold mt-1">
                            {avatarPreparing ? 'Preparing' : `${avatarProgress}%`}
                          </span>
                        </div>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => !isAvatarBusy && setShowAvatarSheet(true)}
                      disabled={isAvatarBusy}
                      className="absolute bottom-0 right-0 w-8 h-8 rounded-full bg-[#04203F] hover:bg-[#0E9AA7] text-white border-2 border-white shadow-md flex items-center justify-center transition-colors cursor-pointer"
                      aria-label="Update photo"
                    >
                      <Camera className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  <div>
                    <p className="text-[12px] font-bold text-[#04203F]">
                      Profile Photo / Shop Logo
                    </p>
                    <p className="text-[11px] text-slate-500">
                      Tap photo to take or upload (up to 30 MB, auto-compressed)
                    </p>
                  </div>

                  {avatarError && (
                    <div className="w-full p-2 rounded-lg bg-rose-50 border border-rose-200 text-[11px] text-rose-700 font-medium flex items-center justify-between gap-2">
                      <span>{avatarError}</span>
                      <button
                        type="button"
                        onClick={clearAvatarError}
                        className="text-rose-500 hover:text-rose-700"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>

                {/* Optional Shop Banner / Cover Image */}
                <div className="pt-2 border-t border-slate-100">
                  <ImageUploadField
                    label="Shop Cover / Banner (Optional)"
                    value={form.shopCoverUrl}
                    onChange={(url) => setForm((prev) => ({ ...prev, shopCoverUrl: url }))}
                    storagePath={`users/${user.uid}/shop`}
                    theme="glass"
                    size="sm"
                    aspect="wide"
                    captureMode="environment"
                    placeholderText="ব্যানার নেই (Add banner)"
                    helperText="শপ কভার ছবি (গ্যালারি বা ক্যামেরা, সর্বোচ্চ ৩০ MB)"
                    compressOptions={{ maxLongestSide: 1400, initialQuality: 0.8, targetMaxBytes: 500 * 1024 }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* SECTION 2: PERSONAL */}
          <div
            ref={(el) => {
              sectionRefs.current.personal = el;
            }}
            className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] shadow-2xs overflow-hidden"
          >
            <button
              type="button"
              onClick={() => toggleSection('personal')}
              className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left bg-slate-50/70 border-b border-slate-100 cursor-pointer"
            >
              <span className="text-[13px] font-bold text-[#04203F] flex items-center gap-2">
                <User className="w-4 h-4 text-blue-600" />
                <span>Personal & Bio</span>
              </span>
              {openSections.personal ? (
                <ChevronUp className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              )}
            </button>

            {openSections.personal && (
              <div className="p-3.5 space-y-3">
                <div>
                  <label className="block text-[12px] font-bold text-slate-700 mb-1">
                    Full Name <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.fullName}
                    onChange={(e) => setForm((p) => ({ ...p, fullName: e.target.value }))}
                    placeholder="Your display name"
                    className={`w-full h-10 px-3 rounded-[12px] border text-[13px] bg-white outline-none transition-colors ${
                      validationErrors.fullName
                        ? 'border-rose-400 focus:border-rose-500'
                        : 'border-slate-200 focus:border-[#0E9AA7]'
                    }`}
                  />
                  {validationErrors.fullName && (
                    <p className="text-[11px] text-rose-600 font-medium mt-1">
                      {validationErrors.fullName}
                    </p>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[12px] font-bold text-slate-700">
                      Short Bio / About the Shop
                    </label>
                    <span
                      className={`text-[11px] font-mono tabular-nums ${
                        form.shopBio.length >= 150 ? 'text-amber-600 font-bold' : 'text-slate-400'
                      }`}
                    >
                      {form.shopBio.length}/160
                    </span>
                  </div>
                  <textarea
                    rows={3}
                    maxLength={160}
                    value={form.shopBio}
                    onChange={(e) =>
                      setForm((p) => ({ ...p, shopBio: e.target.value.slice(0, 160) }))
                    }
                    placeholder="Tell customers about your shop, products & fast delivery..."
                    className="w-full px-3 py-2 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] text-[12.5px] bg-white outline-none resize-none"
                  />
                </div>

                <div>
                  <label className="block text-[12px] font-bold text-slate-700 mb-1">
                    Language Preference
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    {[
                      { val: 'en' as const, label: 'English' },
                      { val: 'bn' as const, label: 'বাংলা (Bangla)' },
                    ].map((opt) => (
                      <button
                        key={opt.val}
                        type="button"
                        onClick={() => setForm((p) => ({ ...p, languagePreference: opt.val }))}
                        className={`h-10 rounded-[12px] border text-[12px] font-bold transition-colors cursor-pointer ${
                          form.languagePreference === opt.val
                            ? 'bg-[#04203F] text-white border-[#04203F]'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* SECTION 3: CONTACT */}
          <div
            ref={(el) => {
              sectionRefs.current.contact = el;
            }}
            className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] shadow-2xs overflow-hidden"
          >
            <button
              type="button"
              onClick={() => toggleSection('contact')}
              className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left bg-slate-50/70 border-b border-slate-100 cursor-pointer"
            >
              <span className="text-[13px] font-bold text-[#04203F] flex items-center gap-2">
                <Phone className="w-4 h-4 text-emerald-600" />
                <span>Contact Numbers</span>
              </span>
              {openSections.contact ? (
                <ChevronUp className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              )}
            </button>

            {openSections.contact && (
              <div className="p-3.5 space-y-3">
                <div>
                  <label className="block text-[12px] font-bold text-slate-700 mb-1">
                    Mobile Number <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="tel"
                    inputMode="tel"
                    value={form.mobile}
                    onChange={(e) => setForm((p) => ({ ...p, mobile: e.target.value }))}
                    placeholder="017XXXXXXXX"
                    className={`w-full h-10 px-3 rounded-[12px] border text-[13px] font-mono bg-white outline-none ${
                      validationErrors.mobile
                        ? 'border-rose-400 focus:border-rose-500'
                        : 'border-slate-200 focus:border-[#0E9AA7]'
                    }`}
                  />
                  {validationErrors.mobile && (
                    <p className="text-[11px] text-rose-600 font-medium mt-1">
                      {validationErrors.mobile}
                    </p>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <label className="text-[12px] font-bold text-slate-700">WhatsApp Number</label>
                    <label className="inline-flex items-center gap-1.5 text-[11.5px] font-semibold text-[#0E9AA7] cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={sameAsMobile}
                        onChange={(e) => setSameAsMobile(e.target.checked)}
                        className="w-3.5 h-3.5 accent-[#0E9AA7] rounded"
                      />
                      <span>Same as mobile</span>
                    </label>
                  </div>
                  <input
                    type="tel"
                    inputMode="tel"
                    disabled={sameAsMobile}
                    value={sameAsMobile ? form.mobile : form.whatsappNumber}
                    onChange={(e) => setForm((p) => ({ ...p, whatsappNumber: e.target.value }))}
                    placeholder="017XXXXXXXX"
                    className={`w-full h-10 px-3 rounded-[12px] border text-[13px] font-mono outline-none ${
                      sameAsMobile
                        ? 'bg-slate-100 text-slate-500 border-slate-200'
                        : validationErrors.whatsappNumber
                        ? 'bg-white border-rose-400'
                        : 'bg-white border-slate-200 focus:border-[#0E9AA7]'
                    }`}
                  />
                  {validationErrors.whatsappNumber && (
                    <p className="text-[11px] text-rose-600 font-medium mt-1">
                      {validationErrors.whatsappNumber}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-[12px] font-bold text-slate-700 mb-1">
                    Alternate Contact (Optional)
                  </label>
                  <input
                    type="tel"
                    inputMode="tel"
                    value={form.alternatePhone}
                    onChange={(e) => setForm((p) => ({ ...p, alternatePhone: e.target.value }))}
                    placeholder="018XXXXXXXX"
                    className={`w-full h-10 px-3 rounded-[12px] border text-[13px] font-mono bg-white outline-none ${
                      validationErrors.alternatePhone
                        ? 'border-rose-400 focus:border-rose-500'
                        : 'border-slate-200 focus:border-[#0E9AA7]'
                    }`}
                  />
                  {validationErrors.alternatePhone && (
                    <p className="text-[11px] text-rose-600 font-medium mt-1">
                      {validationErrors.alternatePhone}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-[12px] font-bold text-slate-700 mb-1">
                    Preferred Contact Method
                  </label>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
                    {(
                      [
                        { val: 'whatsapp', label: 'WhatsApp' },
                        { val: 'phone', label: 'Phone Call' },
                        { val: 'email', label: 'Email' },
                        { val: 'chat', label: 'In-App Chat' },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.val}
                        type="button"
                        onClick={() => setForm((p) => ({ ...p, preferredContactMethod: opt.val }))}
                        className={`h-9 px-2 rounded-[10px] border text-[11.5px] font-bold transition-colors cursor-pointer ${
                          form.preferredContactMethod === opt.val
                            ? 'bg-[#04203F] text-white border-[#04203F]'
                            : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                        }`}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* SECTION 4: SHOP ADDRESS */}
          <div
            ref={(el) => {
              sectionRefs.current.address = el;
            }}
            className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] shadow-2xs overflow-hidden"
          >
            <button
              type="button"
              onClick={() => toggleSection('address')}
              className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left bg-slate-50/70 border-b border-slate-100 cursor-pointer"
            >
              <span className="text-[13px] font-bold text-[#04203F] flex items-center gap-2">
                <MapPin className="w-4 h-4 text-rose-500" />
                <span>Shop Address</span>
              </span>
              {openSections.address ? (
                <ChevronUp className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              )}
            </button>

            {openSections.address && (
              <div className="p-3.5 space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div>
                    <label className="block text-[12px] font-bold text-slate-700 mb-1">
                      Division <span className="text-rose-500">*</span>
                    </label>
                    <select
                      value={form.division}
                      onChange={(e) =>
                        setForm((p) => ({
                          ...p,
                          division: e.target.value,
                          district: '',
                          upazila: '',
                        }))
                      }
                      className="w-full h-10 px-2.5 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] text-[12.5px] bg-white outline-none"
                    >
                      <option value="">Select Division</option>
                      {divisions.map((div) => (
                        <option key={div} value={div}>
                          {div}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[12px] font-bold text-slate-700 mb-1">
                      District <span className="text-rose-500">*</span>
                    </label>
                    <select
                      value={form.district}
                      disabled={!form.division}
                      onChange={(e) =>
                        setForm((p) => ({ ...p, district: e.target.value, upazila: '' }))
                      }
                      className="w-full h-10 px-2.5 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] text-[12.5px] bg-white disabled:bg-slate-100 outline-none"
                    >
                      <option value="">Select District</option>
                      {districts.map((dist) => (
                        <option key={dist} value={dist}>
                          {dist}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-[12px] font-bold text-slate-700 mb-1">
                      Upazila / Thana <span className="text-rose-500">*</span>
                    </label>
                    <select
                      value={form.upazila}
                      disabled={!form.district}
                      onChange={(e) => setForm((p) => ({ ...p, upazila: e.target.value }))}
                      className="w-full h-10 px-2.5 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] text-[12.5px] bg-white disabled:bg-slate-100 outline-none"
                    >
                      <option value="">Select Upazila</option>
                      {upazilas.map((upa) => (
                        <option key={upa} value={upa}>
                          {upa}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>

                {(validationErrors.division ||
                  validationErrors.district ||
                  validationErrors.upazila) && (
                  <p className="text-[11px] text-rose-600 font-medium">
                    {validationErrors.division ||
                      validationErrors.district ||
                      validationErrors.upazila}
                  </p>
                )}

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block text-[12px] font-bold text-slate-700 mb-1">
                      Union / Ward
                    </label>
                    <input
                      type="text"
                      value={form.union}
                      onChange={(e) => setForm((p) => ({ ...p, union: e.target.value }))}
                      placeholder="e.g. Ward 14 / Mirpur 10"
                      className="w-full h-10 px-3 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] text-[12.5px] bg-white outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[12px] font-bold text-slate-700 mb-1">
                      Postal Code (Optional)
                    </label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={4}
                      value={form.postalCode}
                      onChange={(e) => setForm((p) => ({ ...p, postalCode: e.target.value }))}
                      placeholder="1216"
                      className={`w-full h-10 px-3 rounded-[12px] border text-[12.5px] font-mono bg-white outline-none ${
                        validationErrors.postalCode
                          ? 'border-rose-400'
                          : 'border-slate-200 focus:border-[#0E9AA7]'
                      }`}
                    />
                    {validationErrors.postalCode && (
                      <p className="text-[11px] text-rose-600 font-medium mt-1">
                        {validationErrors.postalCode}
                      </p>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-[12px] font-bold text-slate-700 mb-1">
                    Address Line <span className="text-rose-500">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.address}
                    onChange={(e) => setForm((p) => ({ ...p, address: e.target.value }))}
                    placeholder="House, Road, Block / Sector"
                    className={`w-full h-10 px-3 rounded-[12px] border text-[12.5px] bg-white outline-none ${
                      validationErrors.address
                        ? 'border-rose-400'
                        : 'border-slate-200 focus:border-[#0E9AA7]'
                    }`}
                  />
                  {validationErrors.address && (
                    <p className="text-[11px] text-rose-600 font-medium mt-1">
                      {validationErrors.address}
                    </p>
                  )}
                </div>

                <div>
                  <label className="block text-[12px] font-bold text-slate-700 mb-1">
                    Landmark (Optional)
                  </label>
                  <input
                    type="text"
                    value={form.landmark}
                    onChange={(e) => setForm((p) => ({ ...p, landmark: e.target.value }))}
                    placeholder="Near metro station / mosque / market"
                    className="w-full h-10 px-3 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] text-[12.5px] bg-white outline-none"
                  />
                </div>
              </div>
            )}
          </div>

          {/* SECTION 5: BUSINESS LINKS & HOURS */}
          <div
            ref={(el) => {
              sectionRefs.current.business = el;
            }}
            className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] shadow-2xs overflow-hidden"
          >
            <button
              type="button"
              onClick={() => toggleSection('business')}
              className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left bg-slate-50/70 border-b border-slate-100 cursor-pointer"
            >
              <span className="text-[13px] font-bold text-[#04203F] flex items-center gap-2">
                <Globe className="w-4 h-4 text-indigo-600" />
                <span>Business Links & Hours</span>
              </span>
              {openSections.business ? (
                <ChevronUp className="w-4 h-4 text-slate-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              )}
            </button>

            {openSections.business && (
              <div className="p-3.5 space-y-3">
                <div>
                  <label className="block text-[12px] font-bold text-slate-700 mb-1 flex items-center gap-1">
                    <Clock className="w-3.5 h-3.5 text-slate-400" />
                    <span>Business Hours</span>
                  </label>
                  <input
                    type="text"
                    value={form.businessHours}
                    onChange={(e) => setForm((p) => ({ ...p, businessHours: e.target.value }))}
                    placeholder="e.g. Sat–Thu, 10:00 AM – 9:00 PM"
                    className="w-full h-10 px-3 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] text-[12.5px] bg-white outline-none"
                  />
                </div>

                {(
                  [
                    { key: 'facebookPage', label: 'Facebook Page URL', ph: 'https://facebook.com/yourshop' },
                    { key: 'websiteUrl', label: 'Website URL', ph: 'https://yourshop.com' },
                    { key: 'tiktokUrl', label: 'TikTok URL', ph: 'https://tiktok.com/@yourshop' },
                    { key: 'instagramUrl', label: 'Instagram URL', ph: 'https://instagram.com/yourshop' },
                    { key: 'youtubeUrl', label: 'YouTube Channel URL', ph: 'https://youtube.com/@yourshop' },
                  ] as const
                ).map((item) => (
                  <div key={item.key}>
                    <label className="block text-[12px] font-bold text-slate-700 mb-1">
                      {item.label}
                    </label>
                    <input
                      type="url"
                      value={form[item.key]}
                      onChange={(e) => setForm((p) => ({ ...p, [item.key]: e.target.value }))}
                      placeholder={item.ph}
                      className={`w-full h-10 px-3 rounded-[12px] border text-[12.5px] bg-white outline-none ${
                        validationErrors[item.key]
                          ? 'border-rose-400'
                          : 'border-slate-200 focus:border-[#0E9AA7]'
                      }`}
                    />
                    {validationErrors[item.key] && (
                      <p className="text-[11px] text-rose-600 font-medium mt-1">
                        {validationErrors[item.key]}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* SECTION 6: VERIFIED INFORMATION (READ-ONLY) */}
          <div
            ref={(el) => {
              sectionRefs.current.verified = el;
            }}
            className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] shadow-2xs overflow-hidden"
          >
            <div className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 bg-slate-50/70 border-b border-slate-100">
              <div className="flex items-center gap-1.5 min-w-0">
                <button
                  type="button"
                  onClick={() => toggleSection('verified')}
                  aria-expanded={openSections.verified}
                  className="text-[13px] font-bold text-[#04203F] flex items-center gap-1.5 text-left cursor-pointer"
                >
                  <ShieldCheck className="w-4 h-4 text-[#0E9AA7] shrink-0" />
                  <span>Verified Information</span>
                </button>
                <LockTooltipIcon size="xs" />
              </div>
              <button
                type="button"
                onClick={() => toggleSection('verified')}
                aria-expanded={openSections.verified}
                aria-label={openSections.verified ? 'Collapse Verified Information' : 'Expand Verified Information'}
                className="flex-1 flex items-center justify-end py-0.5 cursor-pointer"
              >
                {openSections.verified ? (
                  <ChevronUp className="w-4 h-4 text-slate-400" />
                ) : (
                  <ChevronDown className="w-4 h-4 text-slate-400" />
                )}
              </button>
            </div>

            {openSections.verified && (
              <div className="divide-y divide-slate-100">
                {lockedItems.map((item) => (
                  <div
                    key={item.key}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-2"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-1 text-[11px] font-bold text-slate-500">
                        <span>{item.label}</span>
                        <LockTooltipIcon size="xs" />
                      </div>
                      <p className="text-[12.5px] font-semibold text-[#04203F] font-mono truncate mt-0.5">
                        {item.value}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setChangeRequestField(item.key)}
                      className="shrink-0 h-8 px-2.5 rounded-lg bg-teal-50 hover:bg-teal-100 border border-teal-200/70 text-[#0E9AA7] text-[11px] font-bold inline-flex items-center gap-1 cursor-pointer"
                    >
                      <Send className="w-3 h-3" />
                      <span>Request a change</span>
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Keyboard-Safe Sticky Bottom Save Bar */}
        <div
          style={{ bottom: `${viewportBottomOffset}px` }}
          className="fixed left-1/2 -translate-x-1/2 w-full max-w-2xl z-20 bg-white/90 backdrop-blur-xl border-t border-slate-200/80 px-3.5 py-2.5 pb-[calc(env(safe-area-inset-bottom,0px)+0.625rem)] flex items-center gap-2.5 transition-[bottom] duration-150 motion-reduce:transition-none"
        >
          <button
            type="button"
            onClick={handleBackRequest}
            disabled={saving || isAvatarBusy}
            className="h-10 px-4 rounded-[12px] bg-slate-100 hover:bg-slate-200 text-slate-700 text-[12.5px] font-bold transition-colors cursor-pointer disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            className="flex-1 h-10 rounded-[12px] bg-[#04203F] hover:bg-[#072e58] disabled:opacity-45 disabled:cursor-not-allowed text-white text-[13px] font-extrabold flex items-center justify-center gap-2 shadow-sm transition-colors cursor-pointer motion-reduce:transition-none"
          >
            {saving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin text-teal-300" />
                <span>Saving Changes...</span>
              </>
            ) : (
              <>
                <Check className="w-4 h-4 text-[#3DD055]" />
                <span>{isDirty ? 'Save Profile Changes' : 'No Changes Yet'}</span>
              </>
            )}
          </button>
        </div>

        {/* Photo Source Action Sheet ("Take photo" / "Choose from gallery" / "Remove") */}
        {showAvatarSheet && (
          <div
            className="fixed inset-0 z-50 bg-slate-900/55 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
            onClick={() => setShowAvatarSheet(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm bg-white rounded-t-2xl sm:rounded-2xl p-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-2xl border border-slate-200 space-y-2"
            >
              <div className="flex items-center justify-between pb-1">
                <h3 className="text-[14px] font-extrabold text-[#04203F]">
                  Profile Photo / Shop Logo
                </h3>
                <button
                  type="button"
                  onClick={() => setShowAvatarSheet(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <button
                type="button"
                onClick={() => avatarCameraInputRef.current?.click()}
                className="w-full h-11 px-3.5 rounded-[12px] bg-teal-50 hover:bg-teal-100 border border-teal-200 text-[#04203F] text-[13px] font-bold flex items-center gap-2.5 cursor-pointer"
              >
                <Camera className="w-4 h-4 text-[#0E9AA7]" />
                <span>Take photo (ক্যামেরা)</span>
              </button>

              <button
                type="button"
                onClick={() => avatarGalleryInputRef.current?.click()}
                className="w-full h-11 px-3.5 rounded-[12px] bg-slate-50 hover:bg-slate-100 border border-slate-200 text-[#04203F] text-[13px] font-bold flex items-center gap-2.5 cursor-pointer"
              >
                <ImagePlus className="w-4 h-4 text-blue-600" />
                <span>Choose from gallery (গ্যালারি)</span>
              </button>

              {form.profilePhotoUrl && (
                <button
                  type="button"
                  onClick={handleRemoveAvatar}
                  className="w-full h-11 px-3.5 rounded-[12px] bg-rose-50 hover:bg-rose-100 border border-rose-200 text-rose-700 text-[13px] font-bold flex items-center gap-2.5 cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                  <span>Remove photo (ছবি মুছুন)</span>
                </button>
              )}
            </div>
          </div>
        )}

        {/* Unsaved Changes Confirm Sheet */}
        {showUnsavedSheet && (
          <div
            className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
            onClick={() => setShowUnsavedSheet(false)}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm bg-white rounded-t-2xl sm:rounded-2xl p-5 pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] shadow-2xl border border-slate-200 space-y-3"
            >
              <div className="flex items-start gap-3">
                <div className="w-9 h-9 rounded-xl bg-amber-50 border border-amber-200 text-amber-600 flex items-center justify-center shrink-0">
                  <AlertCircle className="w-4.5 h-4.5" />
                </div>
                <div>
                  <h3 className="text-[15px] font-extrabold text-[#04203F]">Unsaved changes</h3>
                  <p className="text-[12px] text-slate-600 mt-0.5 leading-snug">
                    You have unsaved profile edits. Leave without saving?
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowUnsavedSheet(false)}
                  className="flex-1 h-10 rounded-[12px] bg-slate-100 hover:bg-slate-200 text-slate-700 text-[12.5px] font-bold cursor-pointer"
                >
                  Keep Editing
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowUnsavedSheet(false);
                    onBack();
                  }}
                  className="flex-1 h-10 rounded-[12px] bg-rose-600 hover:bg-rose-700 text-white text-[12.5px] font-bold cursor-pointer"
                >
                  Discard & Exit
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Pre-filled Locked Change Request Modal */}
        <ChangeRequestModal
          isOpen={Boolean(changeRequestField)}
          onClose={() => setChangeRequestField(null)}
          user={user}
          initialField={changeRequestField || 'shopName'}
          onSubmitted={(msg) => showToastMsg(msg, 'success')}
        />

        {/* Toast Notification */}
        {toast && (
          <div
            className={`fixed bottom-20 left-1/2 -translate-x-1/2 z-[60] px-4 py-2.5 rounded-xl shadow-xl border text-[12px] font-bold flex items-center gap-2 whitespace-nowrap ${
              toast.type === 'error'
                ? 'bg-rose-600 text-white border-rose-500'
                : 'bg-[#04203F] text-white border-slate-700'
            }`}
          >
            {toast.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-[#3DD055] shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0" />
            )}
            <span>{toast.text}</span>
          </div>
        )}
      </div>
    </div>
  );
};
