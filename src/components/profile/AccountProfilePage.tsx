import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import {
  AlertCircle,
  ArrowLeft,
  Calendar,
  Camera,
  Check,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Copy,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  FileText,
  Home,
  Loader2,
  Lock,
  Mail,
  MapPin,
  Navigation,
  Phone,
  Plus,
  RefreshCw,
  Send,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Star,
  Store,
  Trash2,
  User,
  X,
} from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { db } from '../../lib/firebase';
import {
  ChangeRequestFieldKey,
  SavedAddress,
  UserProfile,
} from '../../types';
import {
  BdDistrict,
  BdDivision,
  BdUnionWard,
  BdUpazilaThana,
  getDistricts,
  getDivisions,
  getUnionsOrWards,
  getUpazilasAndThanas,
} from '../../data/bd/geocodeService';
import { SearchableSelect, SelectOption } from '../auth/register/SearchableSelect';
import { ProfilePhotoUploader, ProfilePhotoUploaderHandle } from '../settings/ProfilePhotoUploader';
import { ChangeRequestModal } from '../common/ChangeRequestModal';
import { maskSensitiveValue } from '../../lib/lockedFieldsService';
import { formatResellerId } from '../../lib/resellerIdHelper';
import { logAuditAction } from '../../lib/auditLogger';
import { triggerHaptic } from '../../lib/nativeFeedback';
import {
  formatOtpErrorMessage,
  maskEmail,
  sendEmailOtpCall,
  verifyEmailOtpCall,
} from '../../lib/emailOtpService';

interface AccountProfilePageProps {
  user: UserProfile;
  canAccessFullApp?: boolean;
  onOpenLockedModal?: (featureName?: string) => void;
  onOpenEditProfile: () => void;
  onOpenVerifiedInfo: () => void;
  onOpenChangeRequests: () => void;
  pendingChangeCount?: number;
  initialFocusTarget?:
    | 'overview'
    | 'view_profile'
    | 'photo'
    | 'full_name'
    | 'email_verify'
    | 'phone'
    | 'address'
    | 'account_info'
    | null;
  onConsumeFocusTarget?: () => void;
}

const BD_MOBILE_REGEX = /^01[3-9]\d{8}$/;

function normalizeBdPhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '');
  if (digits.startsWith('+880')) return `0${digits.slice(4)}`;
  if (digits.startsWith('880') && digits.length >= 13) return `0${digits.slice(3)}`;
  return digits.replace(/[^\d]/g, '');
}

function toDateObj(val: any): Date | null {
  if (!val) return null;
  if (typeof val?.toDate === 'function') return val.toDate();
  if (typeof val?.seconds === 'number') return new Date(val.seconds * 1000);
  const parsed = new Date(val);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDhakaDateTime(val: any): string {
  const d = toDateObj(val);
  if (!d) return 'Not available';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(d);
  } catch {
    return d.toLocaleString('en-GB', { hour12: true });
  }
}

function buildInitialSavedAddresses(p: UserProfile): SavedAddress[] {
  const existing = Array.isArray(p.savedAddresses) ? p.savedAddresses.filter(Boolean) : [];
  if (existing.length > 0) {
    const hasDefault = existing.some((a) => a.isDefault);
    return existing.map((a, idx) => ({
      ...a,
      id: a.id || `addr_${idx}`,
      isDefault: hasDefault ? Boolean(a.isDefault) : idx === 0,
    }));
  }

  if (p.division || p.district || p.upazila || p.address) {
    return [
      {
        id: 'primary_shop',
        label: 'Shop Address',
        division: p.division || '',
        district: p.district || '',
        upazila: p.upazila || '',
        union: p.union || p.ward || '',
        postalCode: p.postalCode || '',
        address: p.address || '',
        landmark: p.landmark || '',
        coordinates: p.coordinates || null,
        isDefault: true,
      },
    ];
  }

  return [];
}

function getStatusBadgeMeta(status?: UserProfile['status']) {
  switch (status) {
    case 'approved':
      return {
        label: 'Approved',
        chipClass: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        dotClass: 'bg-emerald-500',
        shortNote: 'Your reseller account is active and verified.',
      };
    case 'suspended':
      return {
        label: 'Suspended',
        chipClass: 'bg-rose-50 text-rose-700 border-rose-200',
        dotClass: 'bg-rose-500',
        shortNote: 'Account access is currently restricted.',
      };
    case 'rejected':
      return {
        label: 'Rejected',
        chipClass: 'bg-rose-50 text-rose-800 border-rose-200',
        dotClass: 'bg-rose-600',
        shortNote: 'Application was not approved.',
      };
    case 'pending':
    default:
      return {
        label: 'Pending',
        chipClass: 'bg-slate-100 text-slate-700 border-slate-200',
        dotClass: 'bg-slate-500',
        shortNote: 'Under verification review by ReSellBD team.',
      };
  }
}

export const AccountProfilePage: React.FC<AccountProfilePageProps> = ({
  user,
  canAccessFullApp = true,
  onOpenLockedModal,
  onOpenEditProfile,
  onOpenVerifiedInfo,
  onOpenChangeRequests,
  pendingChangeCount = 0,
  initialFocusTarget = null,
  onConsumeFocusTarget,
}) => {
  const prefersReducedMotion = useReducedMotion();
  const [profile, setProfile] = useState<UserProfile>(user);
  const [loading, setLoading] = useState<boolean>(true);
  const [loadError, setLoadError] = useState<string>('');
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);

  // Refs & modals
  const photoUploaderRef = useRef<ProfilePhotoUploaderHandle>(null);
  const addressSectionRef = useRef<HTMLDivElement | null>(null);
  const accountInfoRef = useRef<HTMLElement | null>(null);
  const [showPersonalSummary, setShowPersonalSummary] = useState(false);
  const [summaryPreviewUrl, setSummaryPreviewUrl] = useState<string | null>(null);
  const [changeRequestField, setChangeRequestField] = useState<ChangeRequestFieldKey | null>(null);

  // Copy & mask states
  const [copiedId, setCopiedId] = useState(false);
  const [showFullEmail, setShowFullEmail] = useState(false);

  // 4. Change Full Name sheet
  const [showNameSheet, setShowNameSheet] = useState(false);
  const [nameInput, setNameInput] = useState(user.fullName || '');
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState('');

  // 5. Email OTP Verification sheet
  const [showEmailOtpSheet, setShowEmailOtpSheet] = useState(false);
  const [otpDigits, setOtpDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [otpSent, setOtpSent] = useState(false);
  const [otpSending, setOtpSending] = useState(false);
  const [otpVerifying, setOtpVerifying] = useState(false);
  const [otpCooldown, setOtpCooldown] = useState(0);
  const [otpError, setOtpError] = useState('');
  const otpRefs = useRef<(HTMLInputElement | null)[]>([]);

  // 7. Change Phone Number (2-step sheet)
  const [showPhoneSheet, setShowPhoneSheet] = useState(false);
  const [phoneStep, setPhoneStep] = useState<'input' | 'confirm'>('input');
  const [phoneInput, setPhoneInput] = useState('');
  const [syncWhatsapp, setSyncWhatsapp] = useState(true);
  const [checkingPhone, setCheckingPhone] = useState(false);
  const [savingPhone, setSavingPhone] = useState(false);
  const [phoneError, setPhoneError] = useState('');

  // 8. Address Management state + Add/Edit sheet
  const [showAddressSheet, setShowAddressSheet] = useState(false);
  const [editingAddressId, setEditingAddressId] = useState<string | null>(null);
  const [addrLabel, setAddrLabel] = useState('Shop Address');
  const [addrDivision, setAddrDivision] = useState('');
  const [addrDistrict, setAddrDistrict] = useState('');
  const [addrUpazila, setAddrUpazila] = useState('');
  const [addrUnion, setAddrUnion] = useState('');
  const [addrPostalCode, setAddrPostalCode] = useState('');
  const [addrStreet, setAddrStreet] = useState('');
  const [addrLandmark, setAddrLandmark] = useState('');
  const [addrLat, setAddrLat] = useState('');
  const [addrLng, setAddrLng] = useState('');
  const [addrIsDefault, setAddrIsDefault] = useState(false);
  const [addrError, setAddrError] = useState('');
  const [savingAddress, setSavingAddress] = useState(false);
  const [busyAddressId, setBusyAddressId] = useState<string | null>(null);
  const [locatingGps, setLocatingGps] = useState(false);

  // Bangladesh Geo Data options (from bangladesh-geo-data via geocodeService)
  const [divisions, setDivisions] = useState<BdDivision[]>([]);
  const [districts, setDistricts] = useState<BdDistrict[]>([]);
  const [upazilas, setUpazilas] = useState<BdUpazilaThana[]>([]);
  const [unions, setUnions] = useState<BdUnionWard[]>([]);

  // 9. Account Status explanation sheet
  const [showStatusSheet, setShowStatusSheet] = useState(false);

  const showToastMsg = useCallback((text: string, type: 'success' | 'error' = 'success') => {
    setToast({ text, type });
    window.setTimeout(() => {
      setToast((curr) => (curr?.text === text ? null : curr));
    }, 3200);
  }, []);

  const broadcastProfileUpdate = useCallback((partial: Partial<UserProfile>, refetch = false) => {
    setProfile((prev) => ({ ...prev, ...partial }));
    window.dispatchEvent(
      new CustomEvent('sky_profile_updated', {
        detail: { partial, refetch },
      })
    );
  }, []);

  // Load fresh user document from Firestore
  const loadFreshProfile = useCallback(async () => {
    if (!user?.uid) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError('');
    try {
      const snap = await getDoc(doc(db, 'users', user.uid));
      if (snap.exists()) {
        const fresh = { uid: snap.id, ...snap.data() } as UserProfile;
        setProfile(fresh);
      } else {
        setProfile(user);
      }
    } catch (err: any) {
      console.error('[AccountProfilePage] Error loading profile:', err);
      setLoadError(err?.message || 'Unable to refresh profile details. Showing saved details.');
      setProfile(user);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    loadFreshProfile();
  }, [loadFreshProfile]);

  useEffect(() => {
    setProfile((prev) => ({ ...prev, ...user }));
  }, [user]);

  // Handle Hub search deep-link targets once hydrated
  useEffect(() => {
    if (!initialFocusTarget || loading) return;
    if (initialFocusTarget === 'view_profile') {
      setShowPersonalSummary(true);
    } else if (initialFocusTarget === 'photo') {
      photoUploaderRef.current?.open();
    } else if (initialFocusTarget === 'full_name') {
      setNameInput(profile.fullName || '');
      setNameError('');
      setShowNameSheet(true);
    } else if (initialFocusTarget === 'email_verify') {
      if (!profile.emailVerified) {
        setOtpDigits(['', '', '', '', '', '']);
        setOtpSent(false);
        setOtpError('');
        setShowEmailOtpSheet(true);
      }
    } else if (initialFocusTarget === 'phone') {
      setPhoneStep('input');
      setPhoneInput('');
      setPhoneError('');
      setShowPhoneSheet(true);
    } else if (initialFocusTarget === 'address') {
      addressSectionRef.current?.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    } else if (initialFocusTarget === 'account_info') {
      accountInfoRef.current?.scrollIntoView({
        behavior: prefersReducedMotion ? 'auto' : 'smooth',
        block: 'start',
      });
    }
    onConsumeFocusTarget?.();
  }, [initialFocusTarget, loading, onConsumeFocusTarget, prefersReducedMotion, profile.emailVerified, profile.fullName]);

  // Email OTP resend cooldown ticker
  useEffect(() => {
    if (otpCooldown <= 0) return;
    const t = window.setInterval(() => {
      setOtpCooldown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [otpCooldown]);

  // Geo cascading loaders for Address Management
  useEffect(() => {
    if (!showAddressSheet) return;
    getDivisions().then(setDivisions).catch(() => {});
  }, [showAddressSheet]);

  useEffect(() => {
    if (!showAddressSheet || !addrDivision) {
      setDistricts([]);
      return;
    }
    const divObj = divisions.find(
      (d) => d.name.toLowerCase() === addrDivision.toLowerCase() || d.id === addrDivision
    );
    if (!divObj) {
      setDistricts([]);
      return;
    }
    getDistricts(divObj.id).then(setDistricts).catch(() => {});
  }, [showAddressSheet, addrDivision, divisions]);

  useEffect(() => {
    if (!showAddressSheet || !addrDistrict) {
      setUpazilas([]);
      return;
    }
    const distObj = districts.find(
      (d) => d.name.toLowerCase() === addrDistrict.toLowerCase() || d.id === addrDistrict
    );
    if (!distObj) {
      setUpazilas([]);
      return;
    }
    getUpazilasAndThanas(distObj.id).then(setUpazilas).catch(() => {});
  }, [showAddressSheet, addrDistrict, districts]);

  useEffect(() => {
    if (!showAddressSheet || !addrUpazila) {
      setUnions([]);
      return;
    }
    const upaObj = upazilas.find(
      (u) => u.name.toLowerCase() === addrUpazila.toLowerCase() || u.id === addrUpazila
    );
    if (!upaObj) {
      setUnions([]);
      return;
    }
    getUnionsOrWards(upaObj).then(setUnions).catch(() => {});
  }, [showAddressSheet, addrUpazila, upazilas]);

  // Saved addresses derived list (default shop address always first)
  const savedAddresses = useMemo(() => {
    const list = buildInitialSavedAddresses(profile);
    return [...list].sort((a, b) => (a.isDefault ? -1 : b.isDefault ? 1 : 0));
  }, [profile]);

  const defaultAddress = savedAddresses[0] || null;
  const shortResellerId = formatResellerId(profile);
  const avatarUrl = profile.profilePhotoUrl || profile.shopPhotoUrl || profile.shopLogoUrl || '';
  const statusMeta = getStatusBadgeMeta(profile.status);
  const isRestricted = !canAccessFullApp || profile.status === 'pending';

  // Completion status & actionable checklist
  const completionData = useMemo(() => {
    const items: Array<{
      id: string;
      label: string;
      done: boolean;
      actionLabel: string;
      onFix: () => void;
    }> = [
      {
        id: 'photo',
        label: 'Profile or shop photo',
        done: Boolean(avatarUrl),
        actionLabel: 'Add photo',
        onFix: () => photoUploaderRef.current?.open(),
      },
      {
        id: 'name',
        label: 'Full legal name',
        done: Boolean(profile.fullName && profile.fullName.trim().length >= 2),
        actionLabel: 'Update',
        onFix: () => {
          setNameInput(profile.fullName || '');
          setNameError('');
          setShowNameSheet(true);
        },
      },
      {
        id: 'email_verified',
        label: 'Email OTP verified',
        done: Boolean(profile.emailVerified),
        actionLabel: 'Verify now',
        onFix: () => {
          setOtpDigits(['', '', '', '', '', '']);
          setOtpSent(false);
          setOtpError('');
          setShowEmailOtpSheet(true);
        },
      },
      {
        id: 'address',
        label: 'Complete shop address',
        done: Boolean(
          profile.division && profile.district && profile.upazila && profile.address?.trim()
        ),
        actionLabel: 'Add address',
        onFix: () => openAddressForm(null),
      },
      {
        id: 'social',
        label: 'Business page or bio',
        done: Boolean(
          profile.facebookPage?.trim() ||
            profile.websiteUrl?.trim() ||
            profile.shopBio?.trim()
        ),
        actionLabel: 'Edit profile',
        onFix: onOpenEditProfile,
      },
      {
        id: 'identity',
        label: 'Identity verification doc',
        done: Boolean(
          profile.nidFrontUrl ||
            profile.nidUrl ||
            profile.birthCertificateUrl ||
            profile.documentsSubmitted
        ),
        actionLabel: 'Request',
        onFix: () =>
          setChangeRequestField(
            profile.documentType === 'birth_certificate' ? 'birth_certificate' : 'nid'
          ),
      },
    ];

    const doneCount = items.filter((i) => i.done).length;
    const pct = Math.round((doneCount / items.length) * 100);
    const missing = items.filter((i) => !i.done);
    return { items, doneCount, total: items.length, pct, missing };
  }, [avatarUrl, onOpenEditProfile, profile]);

  const handleCopyId = async () => {
    if (!shortResellerId) return;
    triggerHaptic('light');
    try {
      await navigator.clipboard?.writeText(shortResellerId);
      setCopiedId(true);
      showToastMsg('Reseller ID copied', 'success');
      window.setTimeout(() => setCopiedId(false), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  // --- Action 4: Save Full Name ---
  const openFullNameSheet = () => {
    triggerHaptic('light');
    if (isRestricted) {
      onOpenLockedModal?.('Change Full Name');
      return;
    }
    setNameInput(profile.fullName || '');
    setNameError('');
    setShowNameSheet(true);
  };

  const handleSaveFullName = async () => {
    const cleaned = nameInput.trim().replace(/\s+/g, ' ');
    if (cleaned.length < 2 || cleaned.length > 60) {
      setNameError('Full name must be between 2 and 60 characters.');
      return;
    }
    if (cleaned === (profile.fullName || '').trim()) {
      setShowNameSheet(false);
      return;
    }

    setSavingName(true);
    setNameError('');
    triggerHaptic('medium');
    try {
      await updateDoc(doc(db, 'users', profile.uid), {
        fullName: cleaned,
        updatedAt: serverTimestamp(),
      });
      await logAuditAction(
        profile.uid,
        cleaned,
        profile.role || 'reseller',
        'UPDATE_FULL_NAME',
        profile.uid,
        JSON.stringify({ previousName: profile.fullName || '', newName: cleaned })
      );
      broadcastProfileUpdate({ fullName: cleaned });
      triggerHaptic('success');
      showToastMsg('Full name updated', 'success');
      setShowNameSheet(false);
    } catch (err: any) {
      console.error('Error updating full name:', err);
      setNameError(err?.message || 'Failed to update full name. Please retry.');
      triggerHaptic('error');
    } finally {
      setSavingName(false);
    }
  };

  // --- Action 5: Verify Email OTP Flow ---
  const handleSendEmailOtp = async () => {
    const cleanEmail = String(profile.email || '').trim().toLowerCase();
    if (!cleanEmail) {
      setOtpError('No registered email found on this account.');
      return;
    }
    setOtpSending(true);
    setOtpError('');
    triggerHaptic('light');
    try {
      const resp = await sendEmailOtpCall(cleanEmail);
      setOtpSent(true);
      setOtpCooldown(resp.cooldownSeconds || 60);
      setOtpDigits(['', '', '', '', '', '']);
      window.setTimeout(() => otpRefs.current[0]?.focus(), 80);
    } catch (err: any) {
      const formatted = formatOtpErrorMessage(err);
      setOtpError(formatted.message);
    } finally {
      setOtpSending(false);
    }
  };

  const handleVerifyEmailOtp = async (overrideCode?: string) => {
    const cleanEmail = String(profile.email || '').trim().toLowerCase();
    const code = (overrideCode ?? otpDigits.join('')).trim();
    if (!/^\d{6}$/.test(code)) {
      setOtpError('Please enter the 6-digit verification code.');
      return;
    }
    setOtpVerifying(true);
    setOtpError('');
    triggerHaptic('medium');
    try {
      const res = await verifyEmailOtpCall(cleanEmail, code);
      if (!res?.verified) {
        throw new Error('Verification did not succeed.');
      }

      const nowIso = new Date().toISOString();
      await updateDoc(doc(db, 'users', profile.uid), {
        emailVerified: true,
        emailVerifiedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      await logAuditAction(
        profile.uid,
        profile.fullName || profile.shopName || 'Reseller',
        profile.role || 'reseller',
        'VERIFY_EMAIL_OTP',
        profile.uid,
        `Verified email ${maskEmail(cleanEmail)} via OTP`
      );

      broadcastProfileUpdate({ emailVerified: true, emailVerifiedAt: nowIso });
      triggerHaptic('success');
      showToastMsg('Email verified successfully', 'success');
      setShowEmailOtpSheet(false);
    } catch (err: any) {
      const formatted = formatOtpErrorMessage(err);
      setOtpError(formatted.message || err?.message || 'Verification failed.');
      triggerHaptic('error');
    } finally {
      setOtpVerifying(false);
    }
  };

  const handleOtpDigitInput = (idx: number, val: string) => {
    const cleaned = val.replace(/\D/g, '');
    setOtpError('');
    if (cleaned.length > 1) {
      const slice = cleaned.slice(0, 6).split('');
      const next = ['', '', '', '', '', ''];
      slice.forEach((c, i) => {
        next[i] = c;
      });
      setOtpDigits(next);
      if (slice.length === 6) {
        handleVerifyEmailOtp(next.join(''));
      } else {
        otpRefs.current[Math.min(5, slice.length)]?.focus();
      }
      return;
    }

    const next = [...otpDigits];
    next[idx] = cleaned.slice(-1);
    setOtpDigits(next);
    if (cleaned && idx < 5) {
      otpRefs.current[idx + 1]?.focus();
    }
    if (next.join('').length === 6) {
      handleVerifyEmailOtp(next.join(''));
    }
  };

  // --- Action 7: Change Phone Number (BD format + duplicate check + confirmation + audit log) ---
  const openPhoneSheet = () => {
    triggerHaptic('light');
    if (isRestricted) {
      onOpenLockedModal?.('Change Phone Number');
      return;
    }
    setPhoneStep('input');
    setPhoneInput('');
    setPhoneError('');
    setSyncWhatsapp(
      !profile.whatsappNumber || profile.whatsappNumber === profile.mobile
    );
    setShowPhoneSheet(true);
  };

  const handleCheckPhoneDuplicate = async () => {
    const normalized = normalizeBdPhone(phoneInput);
    if (!BD_MOBILE_REGEX.test(normalized)) {
      setPhoneError('Enter a valid 11-digit BD mobile number (01[3-9]XXXXXXXX).');
      return;
    }
    if (normalized === normalizeBdPhone(profile.mobile || '')) {
      setPhoneError('This is already your active phone number.');
      return;
    }

    setCheckingPhone(true);
    setPhoneError('');
    try {
      const q = query(collection(db, 'users'), where('mobile', '==', normalized));
      const snap = await getDocs(q);
      const duplicate = snap.docs.find((d) => d.id !== profile.uid);
      if (duplicate) {
        setPhoneError('This phone number is already linked to another ReSellBD account.');
        return;
      }
      setPhoneInput(normalized);
      setPhoneStep('confirm');
    } catch (err: any) {
      console.error('Duplicate phone check error:', err);
      setPhoneError(err?.message || 'Unable to verify number availability. Please try again.');
    } finally {
      setCheckingPhone(false);
    }
  };

  const handleConfirmPhoneChange = async () => {
    const newMobile = normalizeBdPhone(phoneInput);
    if (!BD_MOBILE_REGEX.test(newMobile)) {
      setPhoneStep('input');
      setPhoneError('Invalid phone number.');
      return;
    }

    setSavingPhone(true);
    setPhoneError('');
    triggerHaptic('medium');
    try {
      const updatePayload: Record<string, any> = {
        mobile: newMobile,
        updatedAt: serverTimestamp(),
      };
      if (syncWhatsapp) {
        updatePayload.whatsappNumber = newMobile;
        updatePayload.whatsapp = newMobile;
      }

      await updateDoc(doc(db, 'users', profile.uid), updatePayload);
      await logAuditAction(
        profile.uid,
        profile.fullName || profile.shopName || 'Reseller',
        profile.role || 'reseller',
        'UPDATE_PHONE_NUMBER',
        profile.uid,
        JSON.stringify({
          previousMobile: profile.mobile || '',
          newMobile,
          syncedWhatsapp: syncWhatsapp,
        })
      );

      broadcastProfileUpdate({
        mobile: newMobile,
        ...(syncWhatsapp ? { whatsappNumber: newMobile, whatsapp: newMobile } : {}),
      });
      triggerHaptic('success');
      showToastMsg('Phone number updated', 'success');
      setShowPhoneSheet(false);
    } catch (err: any) {
      console.error('Error updating phone number:', err);
      setPhoneError(err?.message || 'Failed to save new phone number.');
      triggerHaptic('error');
    } finally {
      setSavingPhone(false);
    }
  };

  // --- Action 8: Address Management ---
  function openAddressForm(target: SavedAddress | null) {
    triggerHaptic('light');
    if (isRestricted) {
      onOpenLockedModal?.('Address Management');
      return;
    }
    setAddrError('');
    if (target) {
      setEditingAddressId(target.id);
      setAddrLabel(target.label || 'Shop Address');
      setAddrDivision(target.division || '');
      setAddrDistrict(target.district || '');
      setAddrUpazila(target.upazila || '');
      setAddrUnion(target.union || '');
      setAddrPostalCode(target.postalCode || '');
      setAddrStreet(target.address || '');
      setAddrLandmark(target.landmark || '');
      setAddrLat(
        target.coordinates?.lat != null ? String(target.coordinates.lat) : ''
      );
      setAddrLng(
        target.coordinates?.lng != null ? String(target.coordinates.lng) : ''
      );
      setAddrIsDefault(Boolean(target.isDefault));
    } else {
      setEditingAddressId(null);
      setAddrLabel(savedAddresses.length === 0 ? 'Shop Address' : 'Warehouse / Outlet');
      setAddrDivision('');
      setAddrDistrict('');
      setAddrUpazila('');
      setAddrUnion('');
      setAddrPostalCode('');
      setAddrStreet('');
      setAddrLandmark('');
      setAddrLat('');
      setAddrLng('');
      setAddrIsDefault(savedAddresses.length === 0);
    }
    setShowAddressSheet(true);
  }

  const persistSavedAddresses = async (
    nextList: SavedAddress[],
    auditAction: string,
    summary: string
  ) => {
    const normalized = nextList.map((a, idx) => ({
      ...a,
      isDefault: nextList.some((x) => x.isDefault) ? Boolean(a.isDefault) : idx === 0,
    }));
    const def = normalized.find((a) => a.isDefault) || normalized[0] || null;

    const payload: Record<string, any> = {
      savedAddresses: normalized,
      updatedAt: serverTimestamp(),
    };
    if (def) {
      payload.division = def.division;
      payload.district = def.district;
      payload.upazila = def.upazila;
      payload.union = def.union || '';
      payload.postalCode = def.postalCode || '';
      payload.address = def.address;
      payload.landmark = def.landmark || '';
      payload.coordinates = def.coordinates || null;
    }

    await updateDoc(doc(db, 'users', profile.uid), payload);
    await logAuditAction(
      profile.uid,
      profile.fullName || profile.shopName || 'Reseller',
      profile.role || 'reseller',
      auditAction,
      profile.uid,
      summary
    );

    broadcastProfileUpdate({
      savedAddresses: normalized,
      ...(def
        ? {
            division: def.division,
            district: def.district,
            upazila: def.upazila,
            union: def.union || '',
            postalCode: def.postalCode || '',
            address: def.address,
            landmark: def.landmark || '',
            coordinates: def.coordinates || null,
          }
        : {}),
    });
  };

  const handleSaveAddress = async () => {
    setAddrError('');
    if (!addrDivision.trim()) return setAddrError('Please select a division.');
    if (!addrDistrict.trim()) return setAddrError('Please select a district.');
    if (!addrUpazila.trim()) return setAddrError('Please select an upazila or thana.');
    if (!addrStreet.trim()) return setAddrError('Please enter street / house / village address.');
    if (addrPostalCode.trim() && !/^\d{4}$/.test(addrPostalCode.trim())) {
      return setAddrError('Postal code must be 4 digits.');
    }

    let parsedCoords: { lat: number; lng: number } | null = null;
    const latStr = addrLat.trim();
    const lngStr = addrLng.trim();
    if (latStr || lngStr) {
      const latNum = Number(latStr);
      const lngNum = Number(lngStr);
      if (
        Number.isNaN(latNum) ||
        Number.isNaN(lngNum) ||
        latNum < -90 ||
        latNum > 90 ||
        lngNum < -180 ||
        lngNum > 180
      ) {
        return setAddrError('Enter valid latitude and longitude coordinates.');
      }
      parsedCoords = { lat: Number(latNum.toFixed(6)), lng: Number(lngNum.toFixed(6)) };
    }

    setSavingAddress(true);
    triggerHaptic('medium');
    try {
      const entryId = editingAddressId || `addr_${Date.now()}`;
      const newEntry: SavedAddress = {
        id: entryId,
        label: addrLabel.trim() || 'Saved Address',
        division: addrDivision.trim(),
        district: addrDistrict.trim(),
        upazila: addrUpazila.trim(),
        union: addrUnion.trim() || null,
        postalCode: addrPostalCode.trim() || null,
        address: addrStreet.trim(),
        landmark: addrLandmark.trim() || null,
        coordinates: parsedCoords,
        isDefault: addrIsDefault || savedAddresses.length === 0,
        updatedAt: new Date().toISOString(),
      };

      let nextList: SavedAddress[];
      if (editingAddressId) {
        nextList = savedAddresses.map((a) => (a.id === editingAddressId ? newEntry : a));
      } else {
        nextList = [...savedAddresses, newEntry];
      }

      if (newEntry.isDefault) {
        nextList = nextList.map((a) => ({ ...a, isDefault: a.id === entryId }));
      }

      await persistSavedAddresses(
        nextList,
        editingAddressId ? 'UPDATE_SAVED_ADDRESS' : 'ADD_SAVED_ADDRESS',
        `${editingAddressId ? 'Updated' : 'Added'} address (${newEntry.label})`
      );

      triggerHaptic('success');
      showToastMsg(
        editingAddressId ? 'Address updated' : 'Address added',
        'success'
      );
      setShowAddressSheet(false);
    } catch (err: any) {
      console.error('Error saving address:', err);
      setAddrError(err?.message || 'Could not save address. Please retry.');
      triggerHaptic('error');
    } finally {
      setSavingAddress(false);
    }
  };

  const handleSetDefaultAddress = async (targetId: string) => {
    if (busyAddressId) return;
    setBusyAddressId(targetId);
    triggerHaptic('light');
    try {
      const nextList = savedAddresses.map((a) => ({
        ...a,
        isDefault: a.id === targetId,
      }));
      await persistSavedAddresses(
        nextList,
        'SET_DEFAULT_ADDRESS',
        `Set default address ${targetId}`
      );
      showToastMsg('Default address updated', 'success');
    } catch (err: any) {
      showToastMsg(err?.message || 'Failed to update default address', 'error');
    } finally {
      setBusyAddressId(null);
    }
  };

  const handleDeleteAddress = async (targetId: string) => {
    if (savedAddresses.length <= 1 || busyAddressId) {
      showToastMsg('At least one address is required on your profile', 'error');
      return;
    }
    setBusyAddressId(targetId);
    triggerHaptic('medium');
    try {
      const remaining = savedAddresses.filter((a) => a.id !== targetId);
      if (!remaining.some((a) => a.isDefault) && remaining.length > 0) {
        remaining[0] = { ...remaining[0], isDefault: true };
      }
      await persistSavedAddresses(
        remaining,
        'DELETE_SAVED_ADDRESS',
        `Removed saved address ${targetId}`
      );
      showToastMsg('Address removed', 'success');
    } catch (err: any) {
      showToastMsg(err?.message || 'Failed to remove address', 'error');
    } finally {
      setBusyAddressId(null);
    }
  };

  const handleUseCurrentGps = () => {
    if (!navigator.geolocation) {
      setAddrError('Location access is not supported on this device.');
      return;
    }
    setLocatingGps(true);
    setAddrError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setAddrLat(pos.coords.latitude.toFixed(6));
        setAddrLng(pos.coords.longitude.toFixed(6));
        setLocatingGps(false);
        triggerHaptic('success');
      },
      () => {
        setLocatingGps(false);
        setAddrError('Could not detect GPS location. You can enter coordinates manually.');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  const divisionOptions: SelectOption[] = useMemo(
    () => divisions.map((d) => ({ id: d.id, name: d.name, bn_name: d.bn_name })),
    [divisions]
  );
  const districtOptions: SelectOption[] = useMemo(
    () => districts.map((d) => ({ id: d.id, name: d.name, bn_name: d.bn_name })),
    [districts]
  );
  const upazilaOptions: SelectOption[] = useMemo(
    () =>
      upazilas.map((u) => ({
        id: u.id,
        name: u.name,
        bn_name: u.bn_name,
        badge: u.badge,
        isCity: u.isCity,
        cityCorpId: u.cityCorpId,
      })),
    [upazilas]
  );
  const unionOptions: SelectOption[] = useMemo(
    () =>
      unions.map((u) => ({
        id: u.id,
        name: u.name,
        bn_name: u.bn_name,
        postOffice: u.postOffice,
        postalCode: u.postalCode,
        subtitle: u.postOffice ? `Post: ${u.postOffice} (${u.postalCode || ''})` : undefined,
      })),
    [unions]
  );

  // Sub-page: Read-Only Personal Information / View Profile
  if (showPersonalSummary) {
    const docThumbs = [
      profile.nidFrontUrl ? { label: 'NID Front', url: profile.nidFrontUrl } : null,
      profile.nidBackUrl ? { label: 'NID Back', url: profile.nidBackUrl } : null,
      !profile.nidFrontUrl && profile.nidUrl ? { label: 'NID Copy', url: profile.nidUrl } : null,
      profile.birthCertificateUrl
        ? { label: 'Birth Certificate', url: profile.birthCertificateUrl }
        : null,
    ].filter(Boolean) as Array<{ label: string; url: string }>;

    const defaultPayout =
      profile.payoutMethods?.find((m) => m.isDefault) || profile.payoutMethods?.[0];
    const payoutSummary = defaultPayout
      ? `${defaultPayout.type} • ${maskSensitiveValue(defaultPayout.accountNumber)}`
      : profile.accountNumber
      ? `${(profile.payoutMethod || 'Payout').toUpperCase()} • ${maskSensitiveValue(
          profile.accountNumber
        )}`
      : 'Not added';

    return (
      <div className="max-w-xl mx-auto min-h-0 space-y-2">
        {/* Sub-page Slim Header */}
        <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] p-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={() => setShowPersonalSummary(false)}
              className="w-9 h-9 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-slate-700 flex items-center justify-center shrink-0 cursor-pointer"
              aria-label="Back to Account and Profile"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <h2 className="text-[16px] font-bold text-[#04203F] truncate leading-tight">
                Personal Information
              </h2>
              <p className="text-[11.5px] font-medium text-slate-500 truncate leading-tight">
                Read-only summary • sensitive numbers masked
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setShowPersonalSummary(false);
              onOpenEditProfile();
            }}
            className="h-9 px-3 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-[#04203F] text-[12px] font-semibold inline-flex items-center gap-1 shrink-0 cursor-pointer"
          >
            <Edit3 className="w-3.5 h-3.5" />
            <span>Edit</span>
          </button>
        </div>

        {/* Summary Rows */}
        <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] divide-y divide-slate-100 overflow-hidden">
          <div className="min-h-[52px] px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-slate-500">Full Name</span>
            <span className="text-[14px] font-semibold text-slate-900 text-right truncate">
              {profile.fullName || 'Not set'}
            </span>
          </div>

          <div className="min-h-[52px] px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[12px] font-medium text-slate-500">Shop Name</span>
              <Lock className="w-3 h-3 text-slate-400 shrink-0" />
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[14px] font-semibold text-slate-900 truncate">
                {profile.shopName || 'Not set'}
              </span>
              <button
                type="button"
                onClick={() => setChangeRequestField('shopName')}
                className="h-9 px-2.5 rounded-[10px] bg-teal-50 hover:bg-teal-100 text-[#0E9AA7] text-[11px] font-semibold shrink-0 cursor-pointer"
              >
                Request a change
              </button>
            </div>
          </div>

          <div className="min-h-[52px] px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-slate-500">Reseller ID</span>
            <span className="text-[13px] font-mono font-bold text-[#04203F] tabular-nums">
              {shortResellerId}
            </span>
          </div>

          <div className="min-h-[52px] px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-slate-500">Gender</span>
            <span className="text-[13px] font-semibold text-slate-800 capitalize">
              {profile.gender || 'Not specified'}
            </span>
          </div>

          <div className="min-h-[52px] px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-medium text-slate-500">Date of Birth</span>
              <Lock className="w-3 h-3 text-slate-400 shrink-0" />
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[13px] font-mono font-semibold text-slate-800">
                {profile.dob ? maskSensitiveValue(profile.dob, 4) : 'Not set'}
              </span>
              <button
                type="button"
                onClick={() => setChangeRequestField('dob')}
                className="h-9 px-2.5 rounded-[10px] bg-teal-50 hover:bg-teal-100 text-[#0E9AA7] text-[11px] font-semibold shrink-0 cursor-pointer"
              >
                Request a change
              </button>
            </div>
          </div>

          <div className="min-h-[52px] px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="text-[12px] font-medium text-slate-500">Email</span>
              <Lock className="w-3 h-3 text-slate-400 shrink-0" />
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[13px] font-mono font-semibold text-slate-800 truncate">
                {maskSensitiveValue(profile.email)}
              </span>
              <button
                type="button"
                onClick={() => setChangeRequestField('email')}
                className="h-9 px-2.5 rounded-[10px] bg-teal-50 hover:bg-teal-100 text-[#0E9AA7] text-[11px] font-semibold shrink-0 cursor-pointer"
              >
                Request a change
              </button>
            </div>
          </div>

          <div className="min-h-[52px] px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-slate-500">Phone</span>
            <span className="text-[13px] font-mono font-semibold text-slate-800">
              {profile.mobile || 'Not set'}
            </span>
          </div>

          <div className="min-h-[52px] px-3 py-2 flex items-center justify-between gap-2">
            <span className="text-[12px] font-medium text-slate-500">WhatsApp</span>
            <span className="text-[13px] font-mono font-semibold text-slate-800">
              {profile.whatsappNumber || profile.whatsapp || profile.mobile || 'Not set'}
            </span>
          </div>

          {profile.alternatePhone && (
            <div className="min-h-[52px] px-3 py-2 flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium text-slate-500">Alternate Phone</span>
              <span className="text-[13px] font-mono font-semibold text-slate-800">
                {profile.alternatePhone}
              </span>
            </div>
          )}

          <div className="px-3 py-2.5 space-y-1">
            <span className="text-[12px] font-medium text-slate-500 block">Primary Shop Address</span>
            <p className="text-[13px] font-medium text-slate-900 leading-snug break-words">
              {defaultAddress
                ? [
                    defaultAddress.address,
                    defaultAddress.union,
                    defaultAddress.upazila,
                    defaultAddress.district,
                    defaultAddress.division,
                    defaultAddress.postalCode ? `- ${defaultAddress.postalCode}` : '',
                  ]
                    .filter(Boolean)
                    .join(', ')
                : 'Not set'}
            </p>
          </div>

          {(profile.shopBio || profile.businessHours || profile.facebookPage) && (
            <div className="px-3 py-2.5 space-y-1.5">
              <span className="text-[12px] font-medium text-slate-500 block">
                Shop Bio & Channels
              </span>
              {profile.shopBio && (
                <p className="text-[12.5px] text-slate-700 leading-snug break-words">
                  {profile.shopBio}
                </p>
              )}
              {profile.businessHours && (
                <p className="text-[11.5px] text-slate-500">Hours: {profile.businessHours}</p>
              )}
              {profile.facebookPage && (
                <a
                  href={profile.facebookPage}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[12px] font-semibold text-[#0E9AA7] hover:underline break-all"
                >
                  <span>Facebook Page</span>
                  <ExternalLink className="w-3 h-3 shrink-0" />
                </a>
              )}
            </div>
          )}

          <div className="min-h-[52px] px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[12px] font-medium text-slate-500">Payout Account</span>
              <Lock className="w-3 h-3 text-slate-400 shrink-0" />
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[12.5px] font-mono font-semibold text-slate-800 truncate">
                {payoutSummary}
              </span>
              <button
                type="button"
                onClick={() => setChangeRequestField('payout')}
                className="h-9 px-2.5 rounded-[10px] bg-teal-50 hover:bg-teal-100 text-[#0E9AA7] text-[11px] font-semibold shrink-0 cursor-pointer"
              >
                Request a change
              </button>
            </div>
          </div>

          <div className="min-h-[52px] px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="text-[12px] font-medium text-slate-500">
                {profile.documentType === 'birth_certificate' ? 'Birth Certificate No.' : 'NID Number'}
              </span>
              <Lock className="w-3 h-3 text-slate-400 shrink-0" />
            </div>
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-[12.5px] font-mono font-semibold text-slate-800">
                {profile.documentType === 'birth_certificate'
                  ? maskSensitiveValue(profile.birthCertificateNumber)
                  : maskSensitiveValue(profile.nidNumber)}
              </span>
              <button
                type="button"
                onClick={() =>
                  setChangeRequestField(
                    profile.documentType === 'birth_certificate' ? 'birth_certificate' : 'nid'
                  )
                }
                className="h-9 px-2.5 rounded-[10px] bg-teal-50 hover:bg-teal-100 text-[#0E9AA7] text-[11px] font-semibold shrink-0 cursor-pointer"
              >
                Request a change
              </button>
            </div>
          </div>

          {/* Document Small Thumbnails */}
          <div className="px-3 py-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12px] font-medium text-slate-500 flex items-center gap-1">
                <span>Identity Documents</span>
                <Lock className="w-3 h-3 text-slate-400" />
              </span>
              <button
                type="button"
                onClick={() =>
                  setChangeRequestField(
                    profile.documentType === 'birth_certificate'
                      ? 'birth_certificate'
                      : 'nid_image'
                  )
                }
                className="h-9 px-2.5 rounded-[10px] bg-teal-50 hover:bg-teal-100 text-[#0E9AA7] text-[11px] font-semibold cursor-pointer"
              >
                Request a change
              </button>
            </div>

            {docThumbs.length > 0 ? (
              <div className="flex items-center gap-2 flex-wrap">
                {docThumbs.map((docItem) => (
                  <button
                    key={docItem.label}
                    type="button"
                    onClick={() => setSummaryPreviewUrl(docItem.url)}
                    className="group flex flex-col items-center gap-1 cursor-pointer"
                    aria-label={`Preview ${docItem.label}`}
                  >
                    <img
                      src={docItem.url}
                      alt={docItem.label}
                      className="w-16 h-11 rounded-[10px] object-cover border border-slate-200 bg-slate-100 group-hover:opacity-90"
                    />
                    <span className="text-[10px] font-medium text-slate-500">
                      {docItem.label}
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-[12px] text-slate-400">No document thumbnails uploaded.</p>
            )}
          </div>
        </div>

        {/* Thumbnail Lightbox */}
        {summaryPreviewUrl && (
          <div
            className="fixed inset-0 z-[80] bg-slate-900/80 backdrop-blur-xs flex items-center justify-center p-4"
            onClick={() => setSummaryPreviewUrl(null)}
          >
            <div
              className="relative max-w-md w-full bg-white rounded-[12px] p-2 shadow-2xl"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={() => setSummaryPreviewUrl(null)}
                className="absolute top-3 right-3 w-9 h-9 rounded-full bg-slate-900/80 text-white flex items-center justify-center cursor-pointer"
                aria-label="Close document preview"
              >
                <X className="w-4 h-4" />
              </button>
              <img
                src={summaryPreviewUrl}
                alt="Identity document preview"
                className="w-full max-h-[75vh] object-contain rounded-[10px]"
              />
            </div>
          </div>
        )}

        <ChangeRequestModal
          isOpen={Boolean(changeRequestField)}
          onClose={() => setChangeRequestField(null)}
          user={profile}
          initialField={changeRequestField || 'shopName'}
          onSubmitted={(msg) => showToastMsg(msg, 'success')}
        />
      </div>
    );
  }

  // Initial Skeleton State
  if (loading) {
    return (
      <div
        className="max-w-xl mx-auto min-h-0 space-y-2"
        aria-busy="true"
        aria-label="Loading account and profile"
      >
        <div className="bg-white/85 rounded-[12px] border border-slate-200/80 p-3 flex items-center gap-3 animate-pulse motion-reduce:animate-none">
          <div className="w-12 h-12 rounded-[12px] bg-slate-200 shrink-0" />
          <div className="flex-1 space-y-1.5">
            <div className="h-4 w-36 bg-slate-200 rounded" />
            <div className="h-3 w-28 bg-slate-100 rounded" />
          </div>
        </div>
        {[4, 3, 2, 4].map((rows, sIdx) => (
          <div key={sIdx} className="space-y-2 pt-1">
            <div className="h-3.5 w-32 bg-slate-200/80 rounded mx-1 animate-pulse motion-reduce:animate-none" />
            <div className="bg-white/85 rounded-[12px] border border-slate-200/80 divide-y divide-slate-100 overflow-hidden">
              {Array.from({ length: rows }).map((_, rIdx) => (
                <div
                  key={rIdx}
                  className="min-h-[54px] px-3 py-2 flex items-center gap-2.5 animate-pulse motion-reduce:animate-none"
                >
                  <div className="w-9 h-9 rounded-[10px] bg-slate-100 shrink-0" />
                  <div className="flex-1 space-y-1.5">
                    <div className="h-3.5 w-32 bg-slate-200 rounded" />
                    <div className="h-3 w-44 bg-slate-100 rounded" />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="max-w-xl mx-auto min-h-0 space-y-2">
      {/* Inline Feedback Toast */}
      {toast && (
        <div
          role="status"
          className={`px-3 py-2 rounded-[12px] border text-[12px] font-semibold flex items-center gap-2 ${
            toast.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          {toast.type === 'success' ? (
            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
          ) : (
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
          )}
          <span className="flex-1">{toast.text}</span>
        </div>
      )}

      {/* Error State Banner with Retry */}
      {loadError && (
        <div className="px-3 py-2.5 rounded-[12px] bg-rose-50 border border-rose-200 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            <span className="text-[12px] font-medium text-rose-800 truncate">{loadError}</span>
          </div>
          <button
            type="button"
            onClick={loadFreshProfile}
            className="h-9 px-3 rounded-[10px] bg-rose-600 hover:bg-rose-700 text-white text-[11.5px] font-semibold inline-flex items-center gap-1 shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Retry</span>
          </button>
        </div>
      )}

      {/* ==================================================
          SECTION A — PROFILE OVERVIEW
         ================================================== */}
      <section aria-labelledby="sec-profile-overview" className="space-y-2">
        <h2
          id="sec-profile-overview"
          className="px-1 text-[13px] font-bold text-[#04203F] tracking-tight"
        >
          Profile Overview
        </h2>

        {/* Compact Overview Card */}
        <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] p-3 shadow-[0_1px_4px_rgba(4,32,63,0.03)] flex items-center justify-between gap-2.5">
          <div className="flex items-center gap-2.5 min-w-0 flex-1">
            <button
              type="button"
              onClick={() => photoUploaderRef.current?.open()}
              className="relative w-12 h-12 rounded-[12px] bg-slate-100 border border-slate-200 shrink-0 cursor-pointer group focus:outline-none focus:ring-2 focus:ring-[#0E9AA7]/40"
              aria-label="Change profile photo"
            >
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={profile.fullName || 'Reseller'}
                  className="w-full h-full object-cover rounded-[12px]"
                />
              ) : (
                <div className="w-full h-full rounded-[12px] bg-[#04203F] text-white flex items-center justify-center font-bold text-[15px]">
                  {(profile.fullName || profile.shopName || 'R').charAt(0).toUpperCase()}
                </div>
              )}
              <span className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-white border border-slate-200 shadow-xs flex items-center justify-center text-slate-700">
                <Camera className="w-2.5 h-2.5" />
              </span>
            </button>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 min-w-0">
                <span className="text-[14px] font-bold text-[#04203F] truncate leading-tight">
                  {profile.fullName || 'Reseller'}
                </span>
                {profile.status === 'approved' && (
                  <CheckCircle2
                    className="w-3.5 h-3.5 text-emerald-600 shrink-0"
                    aria-label="Verified"
                  />
                )}
              </div>
              <p className="text-[11.5px] font-medium text-slate-500 truncate leading-tight mt-0.5">
                {profile.shopName || 'ReSellBD Shop'}
              </p>
              <div className="flex items-center gap-1.5 flex-wrap mt-1">
                {shortResellerId && (
                  <span className="text-[11px] font-mono font-semibold text-slate-600 tabular-nums">
                    ID: {shortResellerId}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setShowStatusSheet(true)}
                  className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[8px] border text-[10.5px] font-semibold cursor-pointer ${statusMeta.chipClass}`}
                >
                  <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dotClass}`} />
                  <span>{statusMeta.label}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Section A Actions List */}
        <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] divide-y divide-slate-100 overflow-hidden shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
          {/* 1. Personal Information / View Profile */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setShowPersonalSummary(true);
            }}
            className="w-full min-h-[54px] px-3 py-2 flex items-center gap-2.5 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer"
          >
            <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
              <User className="w-[18px] h-[18px]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                Personal Information
              </div>
              <div className="text-[11.5px] text-slate-500 truncate mt-0.5 leading-tight">
                View full profile, masked IDs & documents
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
          </button>

          {/* 2. Edit Profile */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onOpenEditProfile();
            }}
            className="w-full min-h-[54px] px-3 py-2 flex items-center gap-2.5 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer"
          >
            <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
              <Edit3 className="w-[18px] h-[18px]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                Edit Profile
              </div>
              <div className="text-[11.5px] text-slate-500 truncate mt-0.5 leading-tight">
                Bio, shop banner, alternate phone & links
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
          </button>

          {/* 3. Change Profile Photo */}
          <button
            type="button"
            onClick={() => photoUploaderRef.current?.open()}
            className="w-full min-h-[54px] px-3 py-2 flex items-center gap-2.5 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer"
          >
            <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
              <Camera className="w-[18px] h-[18px]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                  Change Profile Photo
                </span>
                {isRestricted && <Lock className="w-3 h-3 text-slate-400 shrink-0" />}
              </div>
              <div className="text-[11.5px] text-slate-500 truncate mt-0.5 leading-tight">
                Camera or gallery • auto-compressed
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
          </button>

          {/* 4. Change Full Name */}
          <button
            type="button"
            onClick={openFullNameSheet}
            className="w-full min-h-[54px] px-3 py-2 flex items-center gap-2.5 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer"
          >
            <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
              <FileText className="w-[18px] h-[18px]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                  Change Full Name
                </span>
                {isRestricted && <Lock className="w-3 h-3 text-slate-400 shrink-0" />}
              </div>
              <div className="text-[11.5px] text-slate-500 truncate mt-0.5 leading-tight">
                {profile.fullName || 'Not set'}
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
          </button>

          {/* Existing Verified Information & Change Requests (preserved reachability) */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onOpenVerifiedInfo();
            }}
            className="w-full min-h-[54px] px-3 py-2 flex items-center gap-2.5 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer"
          >
            <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
              <ShieldCheck className="w-[18px] h-[18px]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                Verified Information
              </div>
              <div className="text-[11.5px] text-slate-500 truncate mt-0.5 leading-tight">
                Locked shop name, NID, DOB & payout details
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
          </button>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onOpenChangeRequests();
            }}
            className="w-full min-h-[54px] px-3 py-2 flex items-center gap-2.5 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer"
          >
            <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
              <ShieldAlert className="w-[18px] h-[18px]" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                Change Requests
              </div>
              <div className="text-[11.5px] text-slate-500 truncate mt-0.5 leading-tight">
                Request updates to locked info & track status
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {pendingChangeCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-teal-50 text-[#0E9AA7] border border-teal-200 text-[10px] font-bold tabular-nums">
                  {pendingChangeCount}
                </span>
              )}
              <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
            </div>
          </button>
        </div>
      </section>

      {/* ==================================================
          SECTION B — CONTACT
         ================================================== */}
      <section aria-labelledby="sec-contact" className="space-y-2 pt-1">
        <h2
          id="sec-contact"
          className="px-1 text-[13px] font-bold text-[#04203F] tracking-tight"
        >
          Contact
        </h2>

        <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] divide-y divide-slate-100 overflow-hidden shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
          {/* 5a. Email Address (mask/unmask toggle, read-only) */}
          <div className="min-h-[54px] px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <Mail className="w-[18px] h-[18px]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                    Email Address
                  </span>
                  <Lock className="w-3 h-3 text-slate-400 shrink-0" aria-label="Locked field" />
                </div>
                <div className="text-[11.5px] font-mono text-slate-600 truncate mt-0.5 leading-tight">
                  {profile.email
                    ? showFullEmail
                      ? profile.email
                      : maskEmail(profile.email)
                    : 'Not registered'}
                </div>
              </div>
            </div>

            {profile.email && (
              <button
                type="button"
                onClick={() => setShowFullEmail((v) => !v)}
                className="w-9 h-9 rounded-[10px] bg-slate-100 hover:bg-slate-200/80 text-slate-600 flex items-center justify-center shrink-0 cursor-pointer"
                aria-label={showFullEmail ? 'Mask email address' : 'Show full email address'}
                title={showFullEmail ? 'Hide email' : 'Show email'}
              >
                {showFullEmail ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            )}
          </div>

          {/* 5b. Email Verified Status Row */}
          <div className="min-h-[54px] px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <CheckCircle2
                  className={`w-[18px] h-[18px] ${
                    profile.emailVerified ? 'text-emerald-600' : 'text-slate-400'
                  }`}
                />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                  Email verified
                </div>
                <div className="text-[11.5px] text-slate-500 truncate mt-0.5 leading-tight">
                  {profile.emailVerified
                    ? profile.emailVerifiedAt
                      ? `Verified • ${formatDhakaDateTime(profile.emailVerifiedAt)}`
                      : 'Verified via OTP'
                    : 'Verification pending'}
                </div>
              </div>
            </div>

            {profile.emailVerified ? (
              <span className="inline-flex items-center gap-1 h-9 px-2.5 rounded-[10px] bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11.5px] font-semibold shrink-0">
                <Check className="w-3.5 h-3.5" />
                <span>Verified</span>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => {
                  triggerHaptic('light');
                  setOtpDigits(['', '', '', '', '', '']);
                  setOtpSent(false);
                  setOtpError('');
                  setShowEmailOtpSheet(true);
                }}
                className="h-9 px-3 rounded-[10px] bg-[#04203F] hover:bg-[#0E9AA7] text-white text-[12px] font-semibold shrink-0 transition-colors cursor-pointer"
              >
                Verify now
              </button>
            )}
          </div>

          {/* 6. Change Email Address (Locked -> Change Request) */}
          <div className="min-h-[54px] px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <Send className="w-[18px] h-[18px]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1">
                  <span className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                    Change Email Address
                  </span>
                  <Lock className="w-3 h-3 text-slate-400 shrink-0" />
                </div>
                <div className="text-[11.5px] text-slate-500 truncate mt-0.5 leading-tight">
                  Protected account email
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={() => {
                triggerHaptic('light');
                setChangeRequestField('email');
              }}
              className="h-9 px-2.5 rounded-[10px] bg-teal-50 hover:bg-teal-100 border border-teal-200/70 text-[#0E9AA7] text-[11.5px] font-semibold shrink-0 cursor-pointer"
            >
              Request a change
            </button>
          </div>

          {/* 7. Phone Number & Change Phone Number */}
          <div className="min-h-[54px] px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <Phone className="w-[18px] h-[18px]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                    Phone Number
                  </span>
                  {isRestricted && <Lock className="w-3 h-3 text-slate-400 shrink-0" />}
                </div>
                <div className="text-[11.5px] font-mono text-slate-600 truncate mt-0.5 leading-tight">
                  {profile.mobile || 'Not set'}
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={openPhoneSheet}
              className="h-9 px-3 rounded-[10px] bg-slate-100 hover:bg-slate-200/80 text-[#04203F] text-[12px] font-semibold shrink-0 cursor-pointer"
            >
              Change
            </button>
          </div>
        </div>
      </section>

      {/* ==================================================
          SECTION C — ADDRESS
         ================================================== */}
      <section
        ref={addressSectionRef}
        aria-labelledby="sec-address"
        className="space-y-2 pt-1"
      >
        <div className="px-1 flex items-center justify-between gap-2">
          <h2 id="sec-address" className="text-[13px] font-bold text-[#04203F] tracking-tight">
            Address Management
          </h2>
          <button
            type="button"
            onClick={() => openAddressForm(null)}
            className="h-9 px-2.5 rounded-[10px] bg-white/90 hover:bg-white border border-slate-200 text-[#04203F] text-[12px] font-semibold inline-flex items-center gap-1 cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 text-[#0E9AA7]" />
            <span>Add address</span>
          </button>
        </div>

        <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] divide-y divide-slate-100 overflow-hidden shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
          {savedAddresses.length === 0 ? (
            <div className="p-4 text-center space-y-2">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-500 flex items-center justify-center mx-auto">
                <MapPin className="w-[18px] h-[18px]" />
              </div>
              <div>
                <p className="text-[13px] font-semibold text-slate-800">No saved addresses yet</p>
                <p className="text-[11.5px] text-slate-500 mt-0.5">
                  Add your shop or pickup address for courier deliveries
                </p>
              </div>
              <button
                type="button"
                onClick={() => openAddressForm(null)}
                className="h-9 px-3.5 rounded-[10px] bg-[#04203F] text-white text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Shop Address</span>
              </button>
            </div>
          ) : (
            savedAddresses.map((addr) => {
              const hasCoords =
                addr.coordinates?.lat != null && addr.coordinates?.lng != null;
              const isBusy = busyAddressId === addr.id;
              const locationLine = [
                addr.union,
                addr.upazila,
                addr.district,
                addr.division,
                addr.postalCode ? `(${addr.postalCode})` : '',
              ]
                .filter(Boolean)
                .join(', ');

              return (
                <div key={addr.id} className="px-3 py-2.5 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0 mt-0.5">
                        {addr.isDefault ? (
                          <Store className="w-[18px] h-[18px] text-[#0E9AA7]" />
                        ) : (
                          <Home className="w-[18px] h-[18px]" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                            {addr.label || (addr.isDefault ? 'Shop Address' : 'Address')}
                          </span>
                          {addr.isDefault && (
                            <span className="px-1.5 py-0.5 rounded-[6px] bg-teal-50 text-[#0E9AA7] border border-teal-200 text-[10px] font-bold">
                              Default
                            </span>
                          )}
                        </div>
                        <p className="text-[12px] text-slate-700 leading-snug mt-0.5 break-words">
                          {addr.address}
                        </p>
                        {locationLine && (
                          <p className="text-[11.5px] text-slate-500 leading-snug mt-0.5 break-words">
                            {locationLine}
                          </p>
                        )}
                        {addr.landmark && (
                          <p className="text-[11px] text-slate-400 mt-0.5 truncate">
                            Near: {addr.landmark}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Compact Action Row */}
                  <div className="flex items-center gap-1.5 flex-wrap pl-[46px]">
                    {hasCoords && addr.coordinates && (
                      <a
                        href={`https://www.google.com/maps?q=${addr.coordinates.lat},${addr.coordinates.lng}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="h-9 px-2.5 rounded-[10px] bg-slate-100 hover:bg-slate-200/80 text-[#04203F] text-[11.5px] font-semibold inline-flex items-center gap-1"
                      >
                        <MapPin className="w-3.5 h-3.5 text-[#0E9AA7]" />
                        <span>Map</span>
                        <ExternalLink className="w-3 h-3 text-slate-400" />
                      </a>
                    )}

                    {!addr.isDefault && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleSetDefaultAddress(addr.id)}
                        className="h-9 px-2.5 rounded-[10px] bg-slate-100 hover:bg-slate-200/80 text-[#04203F] text-[11.5px] font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                      >
                        {isBusy ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Star className="w-3.5 h-3.5 text-[#0E9AA7]" />
                        )}
                        <span>Set default</span>
                      </button>
                    )}

                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => openAddressForm(addr)}
                      className="h-9 px-2.5 rounded-[10px] bg-slate-100 hover:bg-slate-200/80 text-slate-700 text-[11.5px] font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                      <span>Edit</span>
                    </button>

                    {savedAddresses.length > 1 && (
                      <button
                        type="button"
                        disabled={isBusy}
                        onClick={() => handleDeleteAddress(addr.id)}
                        className="h-9 px-2.5 rounded-[10px] bg-rose-50 hover:bg-rose-100 text-rose-700 text-[11.5px] font-semibold inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                        aria-label={`Delete ${addr.label || 'address'}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        <span>Delete</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* ==================================================
          SECTION D — ACCOUNT INFO (READ-ONLY)
         ================================================== */}
      <section ref={accountInfoRef} aria-labelledby="sec-account-info" className="space-y-2 pt-1">
        <h2
          id="sec-account-info"
          className="px-1 text-[13px] font-bold text-[#04203F] tracking-tight"
        >
          Account Info
        </h2>

        <div className="bg-white/85 backdrop-blur-xl border border-slate-200/80 rounded-[12px] divide-y divide-slate-100 overflow-hidden shadow-[0_1px_4px_rgba(4,32,63,0.03)]">
          {/* 9a. Reseller ID (short form without SGR-) */}
          <div className="min-h-[54px] px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <Shield className="w-[18px] h-[18px]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                  Reseller ID
                </div>
                <div className="text-[11.5px] font-mono text-slate-600 tabular-nums truncate mt-0.5 leading-tight">
                  {shortResellerId || 'Assigning...'}
                </div>
              </div>
            </div>

            {shortResellerId && (
              <button
                type="button"
                onClick={handleCopyId}
                className="h-9 px-2.5 rounded-[10px] bg-slate-100 hover:bg-slate-200/80 text-slate-800 text-[11.5px] font-semibold inline-flex items-center gap-1 shrink-0 cursor-pointer"
                aria-label="Copy Reseller ID"
              >
                {copiedId ? (
                  <>
                    <CheckCheck className="w-3.5 h-3.5 text-emerald-600" />
                    <span className="text-emerald-700">Copied</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5 text-slate-500" />
                    <span>Copy</span>
                  </>
                )}
              </button>
            )}
          </div>

          {/* 9b. Account Status (with explanation sheet) */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setShowStatusSheet(true);
            }}
            className="w-full min-h-[54px] px-3 py-2 flex items-center justify-between gap-2 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer"
          >
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-[18px] h-[18px]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                  Account Status
                </div>
                <div className="text-[11.5px] text-slate-500 truncate mt-0.5 leading-tight">
                  {statusMeta.shortNote}
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-[8px] border text-[11px] font-semibold ${statusMeta.chipClass}`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${statusMeta.dotClass}`} />
                <span>{statusMeta.label}</span>
              </span>
              <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
            </div>
          </button>

          {/* 9c. Account Registration Date (Asia/Dhaka, 12-hour time) */}
          <div className="min-h-[54px] px-3 py-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <Calendar className="w-[18px] h-[18px]" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="text-[14px] font-semibold text-slate-900 truncate leading-tight">
                  Account Registration Date
                </div>
                <div className="text-[11.5px] text-slate-500 truncate mt-0.5 leading-tight">
                  Asia/Dhaka (12-hour)
                </div>
              </div>
            </div>
            <span className="text-[11.5px] font-mono font-semibold text-slate-700 text-right shrink-0">
              {formatDhakaDateTime(profile.createdAt || profile.submittedAt)}
            </span>
          </div>

          {/* 9d. Profile Completion Status (progress bar + interactive checklist) */}
          <div className="px-3 py-2.5 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                  <Sparkles className="w-[18px] h-[18px] text-[#0E9AA7]" />
                </div>
                <div className="min-w-0">
                  <div className="text-[14px] font-semibold text-slate-900 leading-tight">
                    Profile Completion Status
                  </div>
                  <div className="text-[11.5px] text-slate-500 leading-tight mt-0.5">
                    {completionData.doneCount} of {completionData.total} steps completed
                  </div>
                </div>
              </div>
              <span className="text-[13px] font-extrabold text-[#0E9AA7] tabular-nums shrink-0">
                {completionData.pct}%
              </span>
            </div>

            <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[#0E9AA7] to-[#3DD055] rounded-full transition-all duration-300 motion-reduce:transition-none"
                style={{ width: `${completionData.pct}%` }}
              />
            </div>

            <div className="divide-y divide-slate-100/80 pt-0.5">
              {completionData.items.map((item) => (
                <div
                  key={item.id}
                  className="py-1.5 flex items-center justify-between gap-2 min-h-[38px]"
                >
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    {item.done ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                    ) : (
                      <span className="w-4 h-4 rounded-full border-2 border-slate-300 shrink-0" />
                    )}
                    <span
                      className={`text-[12px] truncate ${
                        item.done ? 'text-slate-500 font-medium' : 'text-slate-800 font-semibold'
                      }`}
                    >
                      {item.label}
                    </span>
                  </div>

                  {!item.done && (
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('light');
                        item.onFix();
                      }}
                      className="h-9 px-2.5 rounded-[10px] bg-teal-50 hover:bg-teal-100 text-[#0E9AA7] text-[11px] font-semibold inline-flex items-center gap-1 shrink-0 cursor-pointer"
                    >
                      <span>{item.actionLabel}</span>
                      <ChevronRight className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ==================================================
          REUSED PROFILE PHOTO UPLOADER MODAL (NO DUPLICATE TRIGGER)
         ================================================== */}
      <ProfilePhotoUploader
        ref={photoUploaderRef}
        user={profile}
        canAccessFullApp={canAccessFullApp}
        onOpenLockedModal={onOpenLockedModal}
        hideTrigger={true}
        onPhotoUpdated={(url) => {
          broadcastProfileUpdate({
            profilePhotoUrl: url,
            shopPhotoUrl: url,
            shopLogoUrl: url,
          });
        }}
        showToast={showToastMsg}
      />

      {/* ==================================================
          SHEET: CHANGE FULL NAME (2–60 chars)
         ================================================== */}
      {showNameSheet && (
        <div
          className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/55 backdrop-blur-xs"
          onClick={() => !savingName && setShowNameSheet(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white rounded-t-[16px] sm:rounded-[14px] border border-slate-200 p-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-2xl space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-150 motion-reduce:animate-none"
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div>
                <h3 className="text-[15px] font-bold text-[#04203F]">Change Full Name</h3>
                <p className="text-[11.5px] text-slate-500">Must be 2 to 60 characters</p>
              </div>
              <button
                type="button"
                disabled={savingName}
                onClick={() => setShowNameSheet(false)}
                className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-600 flex items-center justify-center cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {nameError && (
              <div className="p-2.5 rounded-[12px] bg-rose-50 border border-rose-200 text-[12px] font-medium text-rose-700 flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{nameError}</span>
              </div>
            )}

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <label className="text-[12px] font-bold text-slate-700">Full Name</label>
                <span className="text-[11px] font-mono text-slate-400 tabular-nums">
                  {nameInput.trim().length}/60
                </span>
              </div>
              <input
                type="text"
                value={nameInput}
                maxLength={60}
                onChange={(e) => {
                  setNameInput(e.target.value);
                  setNameError('');
                }}
                placeholder="Enter your full legal name"
                className="w-full h-10 px-3 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] text-[13px] text-[#04203F] bg-white outline-none"
              />
            </div>

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                disabled={savingName}
                onClick={() => setShowNameSheet(false)}
                className="flex-1 h-10 rounded-[12px] bg-slate-100 hover:bg-slate-200 text-slate-700 text-[12.5px] font-bold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={savingName}
                onClick={handleSaveFullName}
                className="flex-1 h-10 rounded-[12px] bg-[#04203F] hover:bg-[#0E9AA7] text-white text-[12.5px] font-bold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {savingName ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <span>Save Name</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================
          SHEET: VERIFY EMAIL VIA EXISTING EMAIL OTP FLOW
         ================================================== */}
      {showEmailOtpSheet && (
        <div
          className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/55 backdrop-blur-xs"
          onClick={() => !otpSending && !otpVerifying && setShowEmailOtpSheet(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white rounded-t-[16px] sm:rounded-[14px] border border-slate-200 p-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-2xl space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-150 motion-reduce:animate-none"
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div>
                <h3 className="text-[15px] font-bold text-[#04203F]">Verify Email Address</h3>
                <p className="text-[11.5px] text-slate-500 font-mono truncate">
                  {maskEmail(profile.email)}
                </p>
              </div>
              <button
                type="button"
                disabled={otpSending || otpVerifying}
                onClick={() => setShowEmailOtpSheet(false)}
                className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-600 flex items-center justify-center cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {otpError && (
              <div className="p-2.5 rounded-[12px] bg-rose-50 border border-rose-200 text-[12px] font-medium text-rose-700 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{otpError}</span>
              </div>
            )}

            {!otpSent ? (
              <div className="space-y-3">
                <p className="text-[12px] text-slate-600 leading-relaxed">
                  We will send a 6-digit verification code to{' '}
                  <span className="font-mono font-semibold text-[#04203F]">
                    {maskEmail(profile.email)}
                  </span>{' '}
                  to confirm ownership on ReSellBD.
                </p>
                <button
                  type="button"
                  disabled={otpSending}
                  onClick={handleSendEmailOtp}
                  className="w-full h-10 rounded-[12px] bg-[#04203F] hover:bg-[#0E9AA7] text-white text-[12.5px] font-bold inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  {otpSending ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Sending Code...</span>
                    </>
                  ) : (
                    <>
                      <Mail className="w-4 h-4" />
                      <span>Send Verification Code</span>
                    </>
                  )}
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-[12px] text-slate-600">
                  Enter the 6-digit code sent to your inbox:
                </p>

                <div className="grid grid-cols-6 gap-1.5">
                  {otpDigits.map((d, idx) => (
                    <input
                      key={idx}
                      ref={(el) => {
                        otpRefs.current[idx] = el;
                      }}
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={d}
                      onChange={(e) => handleOtpDigitInput(idx, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Backspace' && !d && idx > 0) {
                          otpRefs.current[idx - 1]?.focus();
                        }
                      }}
                      className="h-10 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] text-center text-[15px] font-mono font-bold text-[#04203F] bg-white outline-none"
                      aria-label={`Digit ${idx + 1}`}
                    />
                  ))}
                </div>

                <div className="flex items-center justify-between text-[11.5px]">
                  <span className="text-slate-500">Didn&apos;t receive it?</span>
                  <button
                    type="button"
                    disabled={otpCooldown > 0 || otpSending}
                    onClick={handleSendEmailOtp}
                    className="h-9 px-2 font-semibold text-[#0E9AA7] disabled:text-slate-400 cursor-pointer"
                  >
                    {otpCooldown > 0 ? `Resend in ${otpCooldown}s` : 'Resend code'}
                  </button>
                </div>

                <button
                  type="button"
                  disabled={otpVerifying || otpDigits.join('').length !== 6}
                  onClick={() => handleVerifyEmailOtp()}
                  className="w-full h-10 rounded-[12px] bg-[#04203F] hover:bg-[#0E9AA7] text-white text-[12.5px] font-bold inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-45"
                >
                  {otpVerifying ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Verifying...</span>
                    </>
                  ) : (
                    <span>Verify Email</span>
                  )}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================================================
          SHEET: CHANGE PHONE NUMBER (BD VALIDATION + DUP CHECK + CONFIRM)
         ================================================== */}
      {showPhoneSheet && (
        <div
          className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/55 backdrop-blur-xs"
          onClick={() => !checkingPhone && !savingPhone && setShowPhoneSheet(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white rounded-t-[16px] sm:rounded-[14px] border border-slate-200 p-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-2xl space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-150 motion-reduce:animate-none"
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div>
                <h3 className="text-[15px] font-bold text-[#04203F]">Change Phone Number</h3>
                <p className="text-[11.5px] text-slate-500">
                  {phoneStep === 'input'
                    ? 'Step 1 of 2 • Enter a valid BD number'
                    : 'Step 2 of 2 • Confirm phone update'}
                </p>
              </div>
              <button
                type="button"
                disabled={checkingPhone || savingPhone}
                onClick={() => setShowPhoneSheet(false)}
                className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-600 flex items-center justify-center cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {phoneError && (
              <div className="p-2.5 rounded-[12px] bg-rose-50 border border-rose-200 text-[12px] font-medium text-rose-700 flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{phoneError}</span>
              </div>
            )}

            {phoneStep === 'input' ? (
              <div className="space-y-3">
                <div className="px-3 py-2 rounded-[12px] bg-slate-50 border border-slate-200/80 flex items-center justify-between text-[12px]">
                  <span className="text-slate-500">Current number</span>
                  <span className="font-mono font-bold text-[#04203F]">
                    {profile.mobile || 'Not set'}
                  </span>
                </div>

                <div className="space-y-1">
                  <label className="text-[12px] font-bold text-slate-700">
                    New Mobile Number (01[3-9]XXXXXXXX)
                  </label>
                  <input
                    type="tel"
                    inputMode="tel"
                    value={phoneInput}
                    onChange={(e) => {
                      setPhoneInput(e.target.value);
                      setPhoneError('');
                    }}
                    placeholder="017XXXXXXXX"
                    className="w-full h-10 px-3 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] font-mono text-[13px] text-[#04203F] bg-white outline-none"
                  />
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={checkingPhone}
                    onClick={() => setShowPhoneSheet(false)}
                    className="flex-1 h-10 rounded-[12px] bg-slate-100 hover:bg-slate-200 text-slate-700 text-[12.5px] font-bold cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={checkingPhone}
                    onClick={handleCheckPhoneDuplicate}
                    className="flex-1 h-10 rounded-[12px] bg-[#04203F] hover:bg-[#0E9AA7] text-white text-[12.5px] font-bold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {checkingPhone ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Checking...</span>
                      </>
                    ) : (
                      <span>Continue</span>
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-3">
                <div className="rounded-[12px] bg-slate-50 border border-slate-200/80 divide-y divide-slate-200/70">
                  <div className="px-3 py-2 flex items-center justify-between text-[12px]">
                    <span className="text-slate-500">Previous</span>
                    <span className="font-mono font-semibold text-slate-600 line-through">
                      {profile.mobile || 'Not set'}
                    </span>
                  </div>
                  <div className="px-3 py-2 flex items-center justify-between text-[12px]">
                    <span className="text-slate-600 font-semibold">New Number</span>
                    <span className="font-mono font-bold text-[#04203F]">{phoneInput}</span>
                  </div>
                </div>

                <label className="flex items-center gap-2 text-[12px] font-medium text-slate-700 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={syncWhatsapp}
                    onChange={(e) => setSyncWhatsapp(e.target.checked)}
                    className="w-4 h-4 accent-[#0E9AA7] rounded"
                  />
                  <span>Also update WhatsApp number to {phoneInput}</span>
                </label>

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    disabled={savingPhone}
                    onClick={() => setPhoneStep('input')}
                    className="flex-1 h-10 rounded-[12px] bg-slate-100 hover:bg-slate-200 text-slate-700 text-[12.5px] font-bold cursor-pointer"
                  >
                    Back
                  </button>
                  <button
                    type="button"
                    disabled={savingPhone}
                    onClick={handleConfirmPhoneChange}
                    className="flex-1 h-10 rounded-[12px] bg-[#04203F] hover:bg-[#0E9AA7] text-white text-[12.5px] font-bold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                  >
                    {savingPhone ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Saving...</span>
                      </>
                    ) : (
                      <span>Confirm Update</span>
                    )}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================================================
          SHEET: ADD / EDIT SAVED ADDRESS (bangladesh-geo-data)
         ================================================== */}
      {showAddressSheet && (
        <div
          className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/55 backdrop-blur-xs"
          onClick={() => !savingAddress && setShowAddressSheet(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md max-h-[88dvh] flex flex-col bg-white rounded-t-[16px] sm:rounded-[14px] border border-slate-200 shadow-2xl overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-150 motion-reduce:animate-none"
          >
            <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between shrink-0">
              <div>
                <h3 className="text-[15px] font-bold text-[#04203F]">
                  {editingAddressId ? 'Edit Address' : 'Add Address'}
                </h3>
                <p className="text-[11.5px] text-slate-500">
                  Bangladesh division, district, upazila & union
                </p>
              </div>
              <button
                type="button"
                disabled={savingAddress}
                onClick={() => setShowAddressSheet(false)}
                className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-600 flex items-center justify-center cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5">
              {addrError && (
                <div className="p-2.5 rounded-[12px] bg-rose-50 border border-rose-200 text-[12px] font-medium text-rose-700 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{addrError}</span>
                </div>
              )}

              <div className="space-y-1">
                <label className="text-[12px] font-bold text-slate-700">Address Label</label>
                <input
                  type="text"
                  value={addrLabel}
                  onChange={(e) => setAddrLabel(e.target.value)}
                  placeholder="e.g. Shop Address, Warehouse, Home"
                  className="w-full h-10 px-3 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] text-[13px] text-[#04203F] bg-white outline-none"
                />
              </div>

              <SearchableSelect
                theme="light"
                label="Division"
                required
                placeholder="Select Division"
                options={divisionOptions}
                value={addrDivision}
                allowCustom={false}
                onChange={(opt) => {
                  setAddrDivision(opt?.name || '');
                  setAddrDistrict('');
                  setAddrUpazila('');
                  setAddrUnion('');
                }}
              />

              <SearchableSelect
                theme="light"
                label="District"
                required
                disabled={!addrDivision}
                placeholder="Select District"
                options={districtOptions}
                value={addrDistrict}
                allowCustom={false}
                onChange={(opt) => {
                  setAddrDistrict(opt?.name || '');
                  setAddrUpazila('');
                  setAddrUnion('');
                }}
              />

              <SearchableSelect
                theme="light"
                label="Upazila / Thana"
                required
                disabled={!addrDistrict}
                placeholder="Select Upazila or Thana"
                options={upazilaOptions}
                value={addrUpazila}
                allowCustom={false}
                onChange={(opt) => {
                  setAddrUpazila(opt?.name || '');
                  setAddrUnion('');
                }}
              />

              <SearchableSelect
                theme="light"
                label="Union / Ward"
                disabled={!addrUpazila}
                placeholder="Select Union or Ward"
                options={unionOptions}
                value={addrUnion}
                customValue={addrUnion}
                onCustomChange={(val) => setAddrUnion(val)}
                onChange={(opt, customTxt) => {
                  if (opt) {
                    setAddrUnion(opt.name);
                    if (opt.postalCode) setAddrPostalCode(opt.postalCode);
                  } else if (typeof customTxt === 'string') {
                    setAddrUnion(customTxt);
                  } else {
                    setAddrUnion('');
                  }
                }}
              />

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="text-[12px] font-bold text-slate-700">Postal Code</label>
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={4}
                    value={addrPostalCode}
                    onChange={(e) => setAddrPostalCode(e.target.value)}
                    placeholder="1216"
                    className="w-full h-10 px-3 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] font-mono text-[13px] text-[#04203F] bg-white outline-none"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[12px] font-bold text-slate-700">Landmark</label>
                  <input
                    type="text"
                    value={addrLandmark}
                    onChange={(e) => setAddrLandmark(e.target.value)}
                    placeholder="Near market / mosque"
                    className="w-full h-10 px-3 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] text-[13px] text-[#04203F] bg-white outline-none"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[12px] font-bold text-slate-700">
                  House / Road / Village Address <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  value={addrStreet}
                  onChange={(e) => setAddrStreet(e.target.value)}
                  placeholder="House #, Road #, Block / Village"
                  className="w-full h-10 px-3 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] text-[13px] text-[#04203F] bg-white outline-none"
                />
              </div>

              {/* Optional Map Coordinates */}
              <div className="space-y-1.5 pt-1">
                <div className="flex items-center justify-between gap-2">
                  <label className="text-[12px] font-bold text-slate-700">
                    Map Coordinates (Optional)
                  </label>
                  <button
                    type="button"
                    disabled={locatingGps}
                    onClick={handleUseCurrentGps}
                    className="h-9 px-2.5 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-[#0E9AA7] text-[11px] font-semibold inline-flex items-center gap-1 cursor-pointer"
                  >
                    {locatingGps ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Navigation className="w-3.5 h-3.5" />
                    )}
                    <span>Use current GPS</span>
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={addrLat}
                    onChange={(e) => setAddrLat(e.target.value)}
                    placeholder="Latitude (e.g. 23.8103)"
                    className="w-full h-10 px-3 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] font-mono text-[12px] text-[#04203F] bg-white outline-none"
                  />
                  <input
                    type="text"
                    inputMode="decimal"
                    value={addrLng}
                    onChange={(e) => setAddrLng(e.target.value)}
                    placeholder="Longitude (e.g. 90.4125)"
                    className="w-full h-10 px-3 rounded-[12px] border border-slate-200 focus:border-[#0E9AA7] font-mono text-[12px] text-[#04203F] bg-white outline-none"
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 pt-1 text-[12.5px] font-semibold text-[#04203F] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={addrIsDefault}
                  onChange={(e) => setAddrIsDefault(e.target.checked)}
                  className="w-4 h-4 accent-[#0E9AA7] rounded"
                />
                <span>Set as default shop address</span>
              </label>
            </div>

            <div className="px-4 py-3 border-t border-slate-100 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] flex items-center gap-2 shrink-0 bg-white">
              <button
                type="button"
                disabled={savingAddress}
                onClick={() => setShowAddressSheet(false)}
                className="flex-1 h-10 rounded-[12px] bg-slate-100 hover:bg-slate-200 text-slate-700 text-[12.5px] font-bold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={savingAddress}
                onClick={handleSaveAddress}
                className="flex-1 h-10 rounded-[12px] bg-[#04203F] hover:bg-[#0E9AA7] text-white text-[12.5px] font-bold inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                {savingAddress ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Saving...</span>
                  </>
                ) : (
                  <span>Save Address</span>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ==================================================
          SHEET: ACCOUNT STATUS EXPLANATION
         ================================================== */}
      {showStatusSheet && (
        <div
          className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/55 backdrop-blur-xs"
          onClick={() => setShowStatusSheet(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white rounded-t-[16px] sm:rounded-[14px] border border-slate-200 p-4 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] shadow-2xl space-y-3 animate-in fade-in slide-in-from-bottom-4 duration-150 motion-reduce:animate-none"
          >
            <div className="flex items-center justify-between pb-2 border-b border-slate-100">
              <div>
                <h3 className="text-[15px] font-bold text-[#04203F]">Account Status Guide</h3>
                <p className="text-[11.5px] text-slate-500">
                  Current status: <span className="font-semibold text-[#04203F]">{statusMeta.label}</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowStatusSheet(false)}
                className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-600 flex items-center justify-center cursor-pointer"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {(profile.rejectReason || profile.suspensionReason) && (
              <div className="p-2.5 rounded-[12px] bg-rose-50 border border-rose-200 text-[12px] text-rose-800">
                <span className="font-bold">Admin note: </span>
                <span>{profile.rejectReason || profile.suspensionReason}</span>
              </div>
            )}

            <div className="divide-y divide-slate-100 rounded-[12px] border border-slate-200/80 overflow-hidden">
              {[
                {
                  key: 'pending',
                  title: 'Pending',
                  desc: 'Documents and account details are under review by ReSellBD admins.',
                  dot: 'bg-slate-500',
                },
                {
                  key: 'approved',
                  title: 'Approved',
                  desc: 'Full reseller access unlocked for orders, wallet withdrawals, and tools.',
                  dot: 'bg-emerald-500',
                },
                {
                  key: 'suspended',
                  title: 'Suspended',
                  desc: 'Temporarily or permanently restricted due to policy or security review.',
                  dot: 'bg-rose-500',
                },
                {
                  key: 'rejected',
                  title: 'Rejected',
                  desc: 'Application was declined. Review the reason and contact support.',
                  dot: 'bg-rose-700',
                },
              ].map((s) => {
                const isCurrent = (profile.status || 'pending') === s.key;
                return (
                  <div
                    key={s.key}
                    className={`px-3 py-2.5 space-y-0.5 ${isCurrent ? 'bg-slate-50/90' : 'bg-white'}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[13px] font-bold text-[#04203F] flex items-center gap-1.5">
                        <span className={`w-2 h-2 rounded-full ${s.dot}`} />
                        <span>{s.title}</span>
                      </span>
                      {isCurrent && (
                        <span className="text-[10px] font-bold text-[#0E9AA7] bg-teal-50 px-2 py-0.5 rounded-[6px] border border-teal-200">
                          Current
                        </span>
                      )}
                    </div>
                    <p className="text-[11.5px] text-slate-500 leading-snug">{s.desc}</p>
                  </div>
                );
              })}
            </div>

            <button
              type="button"
              onClick={() => setShowStatusSheet(false)}
              className="w-full h-10 rounded-[12px] bg-[#04203F] text-white text-[12.5px] font-bold cursor-pointer"
            >
              Got it
            </button>
          </div>
        </div>
      )}

      {/* ==================================================
          EXISTING CHANGE REQUEST MODAL FOR LOCKED FIELDS
         ================================================== */}
      <ChangeRequestModal
        isOpen={Boolean(changeRequestField)}
        onClose={() => setChangeRequestField(null)}
        user={profile}
        initialField={changeRequestField || 'email'}
        onSubmitted={(msg) => showToastMsg(msg, 'success')}
      />
    </div>
  );
};
