import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import bcrypt from 'bcryptjs';
import {
  EmailAuthProvider,
  reauthenticateWithCredential,
  sendPasswordResetEmail,
  updatePassword,
} from 'firebase/auth';
import { doc, serverTimestamp, updateDoc } from 'firebase/firestore';
import {
  AlertCircle,
  Bell,
  Check,
  CheckCircle2,
  ChevronRight,
  Clock,
  Eye,
  EyeOff,
  Fingerprint,
  Gauge,
  Key,
  Laptop,
  Loader2,
  Lock,
  LogOut,
  Mail,
  RefreshCw,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Tablet,
  Timer,
  Trash2,
  UserCheck,
  Wifi,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { auth, db } from '../../lib/firebase';
import { SecurityPreferences, UserProfile } from '../../types';
import { logAuditAction } from '../../lib/auditLogger';
import { triggerHaptic } from '../../lib/nativeFeedback';
import { useScrollToTop } from '../../utils/scrollToTop';
import {
  DeviceItem,
  fetchUserDevices,
  fetchUserLoginHistory,
  getOrCreateDeviceId,
  LOGIN_HISTORY_RETENTION_MINUTES,
  LoginHistoryItem,
  setDeviceTrusted,
  signOutAllDevices,
  signOutSingleDevice,
  subscribeUserDevices,
  subscribeUserLoginHistory,
} from '../../lib/deviceSecurity';
import { NeumorphicPinKeypad } from '../common/NeumorphicPinKeypad';
import { PageHeader } from '../common/PageHeader';

export type SecurityFocusTarget =
  | 'password'
  | 'forgot_password'
  | 'strength_checker'
  | 'login_history'
  | 'active_devices'
  | 'trusted_devices'
  | 'app_lock'
  | 'biometric'
  | 'two_factor'
  | 'login_alerts'
  | 'session_timeout';

export interface SecuritySectionProps {
  user: UserProfile;
  canAccessFullApp?: boolean;
  onOpenLockedModal?: (featureName?: string) => void;
  onRefreshUser?: () => void;
  onLogout: () => void;
  onBack?: () => void;
  hideHeader?: boolean;
  initialFocusTarget?: SecurityFocusTarget | null;
  onConsumeFocusTarget?: () => void;
}

type ActiveModal =
  | null
  | 'changePassword'
  | 'strengthChecker'
  | 'verifyCurrentPin'
  | 'pinSetup'
  | 'lockTiming'
  | 'signOutDeviceConfirm'
  | 'logoutAllConfirm'
  | 'reauthGate';

type PinAction = 'enable' | 'change' | 'disable';

const LOCK_DELAY_OPTIONS: Array<{ ms: number; label: string; shortLabel: string }> = [
  { ms: 0, label: 'Immediately', shortLabel: 'Immediate' },
  { ms: 10000, label: 'After 10 seconds', shortLabel: '10s' },
  { ms: 30000, label: 'After 30 seconds', shortLabel: '30s' },
  { ms: 60000, label: 'After 1 minute', shortLabel: '1m' },
];

const SESSION_TIMEOUT_OPTIONS: Array<{ minutes: 0 | 15 | 30 | 60 | 240; label: string }> = [
  { minutes: 0, label: 'Never' },
  { minutes: 15, label: '15 min' },
  { minutes: 30, label: '30 min' },
  { minutes: 60, label: '1 hour' },
  { minutes: 240, label: '4 hours' },
];

const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCKOUT_SECONDS = 30;
const REAUTH_GRACE_MS = 3 * 60 * 1000;

interface PasswordAnalysis {
  score: 0 | 1 | 2 | 3 | 4;
  label: string;
  barColor: string;
  textColor: string;
  checks: {
    minLength: boolean;
    recommendedLength: boolean;
    upperLower: boolean;
    hasNumber: boolean;
    hasSymbol: boolean;
  };
  tips: string[];
}

function analyzePassword(pass: string): PasswordAnalysis {
  const checks = {
    minLength: pass.length >= 6,
    recommendedLength: pass.length >= 10,
    upperLower: /[A-Z]/.test(pass) && /[a-z]/.test(pass),
    hasNumber: /\d/.test(pass),
    hasSymbol: /[^A-Za-z0-9]/.test(pass),
  };

  if (!pass) {
    return {
      score: 0,
      label: 'Enter a password',
      barColor: 'bg-slate-200',
      textColor: 'text-slate-400',
      checks,
      tips: ['Use at least 8–10 characters mixing letters, numbers, and symbols.'],
    };
  }

  let points = 0;
  if (checks.minLength) points += 1;
  if (checks.recommendedLength) points += 1;
  if (checks.upperLower) points += 1;
  if (checks.hasNumber) points += 1;
  if (checks.hasSymbol) points += 1;

  const tips: string[] = [];
  if (!checks.recommendedLength) tips.push('Make it at least 10 characters long.');
  if (!checks.upperLower) tips.push('Mix uppercase (A–Z) and lowercase (a–z) letters.');
  if (!checks.hasNumber) tips.push('Include at least one number (0–9).');
  if (!checks.hasSymbol) tips.push('Add a symbol like ! @ # $ % for extra strength.');
  if (/(.)\1{2,}/.test(pass)) tips.push('Avoid repeating the same character three times.');

  if (points <= 1) {
    return {
      score: 1,
      label: 'Weak',
      barColor: 'bg-rose-500',
      textColor: 'text-rose-600',
      checks,
      tips,
    };
  }
  if (points === 2) {
    return {
      score: 2,
      label: 'Fair',
      barColor: 'bg-amber-500',
      textColor: 'text-amber-600',
      checks,
      tips,
    };
  }
  if (points <= 4) {
    return {
      score: 3,
      label: 'Good',
      barColor: 'bg-sky-500',
      textColor: 'text-sky-600',
      checks,
      tips,
    };
  }
  return {
    score: 4,
    label: 'Strong',
    barColor: 'bg-emerald-500',
    textColor: 'text-emerald-600',
    checks,
    tips: ['Excellent! This password is hard to guess.'],
  };
}

function toDateObj(val: any): Date | null {
  if (!val) return null;
  if (typeof val?.toDate === 'function') return val.toDate();
  if (typeof val?.seconds === 'number') return new Date(val.seconds * 1000);
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDhakaTimestamp(val: any): string {
  const d = toDateObj(val);
  if (!d) return 'Just now';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(d);
  } catch {
    return d.toLocaleTimeString('en-GB', { hour12: true });
  }
}

function formatRelativeAgo(val: any): string {
  const d = toDateObj(val);
  if (!d) return 'Active now';
  const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
  if (diffSec < 60) return 'Active now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDays = Math.floor(diffHr / 24);
  return `${diffDays}d ago`;
}

function renderDeviceIcon(type?: string) {
  if (type === 'phone') return Smartphone;
  if (type === 'tablet') return Tablet;
  return Laptop;
}

function verifyStoredPinHash(enteredPin: string, storedHash: string): boolean {
  if (!storedHash) return false;
  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$')) {
    return bcrypt.compareSync(enteredPin, storedHash);
  }
  try {
    return btoa(`${enteredPin}_sky_secret`) === storedHash;
  } catch {
    return false;
  }
}

function dispatchProfilePatch(partial: Partial<UserProfile>) {
  window.dispatchEvent(new CustomEvent('sky_profile_updated', { detail: { partial } }));
}

export const SecuritySection: React.FC<SecuritySectionProps> = ({
  user,
  canAccessFullApp = true,
  onOpenLockedModal,
  onRefreshUser,
  onLogout,
  onBack,
  hideHeader = false,
  initialFocusTarget = null,
  onConsumeFocusTarget,
}) => {
  const prefersReducedMotion = useReducedMotion();
  useScrollToTop([]);

  const isRestricted = !canAccessFullApp || user.status === 'pending';

  // Section refs for search deep-linking
  const passwordSectionRef = useRef<HTMLDivElement | null>(null);
  const forgotPasswordRowRef = useRef<HTMLDivElement | null>(null);
  const loginHistorySectionRef = useRef<HTMLDivElement | null>(null);
  const activeDevicesSectionRef = useRef<HTMLDivElement | null>(null);
  const trustedDevicesSectionRef = useRef<HTMLDivElement | null>(null);
  const appLockSectionRef = useRef<HTMLDivElement | null>(null);
  const biometricRowRef = useRef<HTMLDivElement | null>(null);
  const twoFactorRowRef = useRef<HTMLDivElement | null>(null);
  const alertsSectionRef = useRef<HTMLDivElement | null>(null);
  const sessionTimeoutSectionRef = useRef<HTMLDivElement | null>(null);

  // Toast & modal state
  const [toast, setToast] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const showToast = useCallback((text: string, type: 'success' | 'error' = 'success') => {
    setToast({ text, type });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    };
  }, []);

  const [activeModal, setActiveModal] = useState<ActiveModal>(null);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState('');

  // Section A — Password state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showCurrentPass, setShowCurrentPass] = useState(false);
  const [showNewPass, setShowNewPass] = useState(false);
  const [showConfirmPass, setShowConfirmPass] = useState(false);
  const [signOutOtherDevicesOnPwChange, setSignOutOtherDevicesOnPwChange] = useState(true);

  const [sendingResetEmail, setSendingResetEmail] = useState(false);
  const [resetCooldown, setResetCooldown] = useState(0);

  // Standalone Password Strength Checker (strictly local only)
  const [checkerPassword, setCheckerPassword] = useState('');
  const [showCheckerPass, setShowCheckerPass] = useState(false);

  // Section B — Login history & active devices
  const [currentDeviceId] = useState(() => getOrCreateDeviceId());
  const [loginHistory, setLoginHistory] = useState<LoginHistoryItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [showAllHistory, setShowAllHistory] = useState(false);
  const [historySubNonce, setHistorySubNonce] = useState(0);

  const [activeDevices, setActiveDevices] = useState<DeviceItem[]>([]);
  const [loadingDevices, setLoadingDevices] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [devicesSubNonce, setDevicesSubNonce] = useState(0);

  const [selectedDevice, setSelectedDevice] = useState<DeviceItem | null>(null);
  const [signingOutSingle, setSigningOutSingle] = useState(false);
  const [trustBusyId, setTrustBusyId] = useState<string | null>(null);

  // Swipe-left gesture state per device row
  const swipeStartRef = useRef<{ id: string; x: number; y: number } | null>(null);
  const [swipedOffsets, setSwipedOffsets] = useState<Record<string, number>>({});

  // Section C — App Lock & PIN state
  const [pinEnabled, setPinEnabled] = useState<boolean>(() => {
    try {
      return (
        localStorage.getItem(`sky_app_pin_enabled_${user.uid}`) === 'true' ||
        Boolean(user.appLockEnabled)
      );
    } catch {
      return Boolean(user.appLockEnabled);
    }
  });
  const [pinStep, setPinStep] = useState<1 | 2>(1);
  const [pinLengthChoice, setPinLengthChoice] = useState<4 | 6>(() => {
    const savedLen = Number(localStorage.getItem(`sky_app_pin_length_${user.uid}`) || user.appLockPinLength || 4);
    return savedLen === 6 ? 6 : 4;
  });
  const [inputPin, setInputPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [verifyPinInput, setVerifyPinInput] = useState('');
  const [pendingPinAction, setPendingPinAction] = useState<PinAction>('enable');

  const [pinFailedAttempts, setPinFailedAttempts] = useState(0);
  const [pinLockoutRemaining, setPinLockoutRemaining] = useState<number>(() => {
    try {
      const until = Number(localStorage.getItem(`sky_pin_lockout_until_${user.uid}`) || 0);
      if (until > Date.now()) {
        return Math.ceil((until - Date.now()) / 1000);
      }
    } catch {}
    return 0;
  });

  const [lockTimeoutMs, setLockTimeoutMs] = useState<number>(() => {
    try {
      const raw = localStorage.getItem(`sky_app_lock_timeout_${user.uid}`);
      const parsed = raw !== null ? parseInt(raw, 10) : 10000;
      return Number.isFinite(parsed) ? parsed : 10000;
    } catch {
      return 10000;
    }
  });

  // Section D — Alerts & Session Timeout Preferences
  const [securityPrefs, setSecurityPrefs] = useState<SecurityPreferences>(() => ({
    loginAlertsEnabled: user.securityPrefs?.loginAlertsEnabled ?? true,
    newDeviceAlertsEnabled: user.securityPrefs?.newDeviceAlertsEnabled ?? true,
    alertChannels: {
      push: user.securityPrefs?.alertChannels?.push ?? true,
      email: user.securityPrefs?.alertChannels?.email ?? false,
    },
    sessionTimeoutMinutes: user.securityPrefs?.sessionTimeoutMinutes ?? 0,
    sessionTimeoutAction: user.securityPrefs?.sessionTimeoutAction ?? 'lock',
  }));
  const [savingPrefs, setSavingPrefs] = useState(false);

  // Sync securityPrefs & pinEnabled if user prop updates
  useEffect(() => {
    if (user.securityPrefs) {
      setSecurityPrefs({
        loginAlertsEnabled: user.securityPrefs.loginAlertsEnabled ?? true,
        newDeviceAlertsEnabled: user.securityPrefs.newDeviceAlertsEnabled ?? true,
        alertChannels: {
          push: user.securityPrefs.alertChannels?.push ?? true,
          email: user.securityPrefs.alertChannels?.email ?? false,
        },
        sessionTimeoutMinutes: user.securityPrefs.sessionTimeoutMinutes ?? 0,
        sessionTimeoutAction: user.securityPrefs.sessionTimeoutAction ?? 'lock',
      });
    }
    const localPin = localStorage.getItem(`sky_app_pin_enabled_${user.uid}`) === 'true';
    setPinEnabled(Boolean(user.appLockEnabled || localPin));
  }, [user.uid, user.appLockEnabled, user.securityPrefs]);

  // Re-auth Gate state for sensitive operations
  const lastReauthAtRef = useRef<number>(0);
  const pendingSensitiveActionRef = useRef<(() => Promise<void> | void) | null>(null);
  const [reauthMode, setReauthMode] = useState<'pin' | 'password'>('password');
  const [reauthPin, setReauthPin] = useState('');
  const [reauthPassword, setReauthPassword] = useState('');
  const [showReauthPassword, setShowReauthPassword] = useState(false);

  const getStoredPinHash = useCallback((): string | null => {
    try {
      return localStorage.getItem(`sky_app_pin_hash_${user.uid}`) || user.appLockPinHash || null;
    } catch {
      return user.appLockPinHash || null;
    }
  }, [user.appLockPinHash, user.uid]);

  const getStoredPinLength = useCallback((): number => {
    if (user.appLockPinLength && user.appLockPinLength >= 4 && user.appLockPinLength <= 6) {
      return user.appLockPinLength;
    }
    try {
      const localLen = Number(localStorage.getItem(`sky_app_pin_length_${user.uid}`) || 4);
      if (localLen >= 4 && localLen <= 6) return localLen;
    } catch {}
    return 4;
  }, [user.appLockPinLength, user.uid]);

  // Cooldown timer for reset email
  useEffect(() => {
    if (resetCooldown <= 0) return;
    const t = window.setInterval(() => {
      setResetCooldown((p) => Math.max(0, p - 1));
    }, 1000);
    return () => window.clearInterval(t);
  }, [resetCooldown]);

  // Lockout countdown timer for PIN attempts
  useEffect(() => {
    if (pinLockoutRemaining <= 0) return;
    const t = window.setInterval(() => {
      setPinLockoutRemaining((prev) => {
        if (prev <= 1) {
          setPinFailedAttempts(0);
          setModalError('');
          try {
            localStorage.removeItem(`sky_pin_lockout_until_${user.uid}`);
          } catch {}
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => window.clearInterval(t);
  }, [pinLockoutRemaining, user.uid]);

  // Real-time Active Devices subscription
  useEffect(() => {
    setLoadingDevices(true);
    setDevicesError(null);
    const unsub = subscribeUserDevices(
      user.uid,
      (devs) => {
        setActiveDevices(devs);
        setLoadingDevices(false);
        setDevicesError(null);
      },
      () => {
        setLoadingDevices(false);
        setDevicesError('Could not load active devices.');
      }
    );
    return () => unsub();
  }, [user.uid, devicesSubNonce]);

  // Real-time Login History subscription (strictly within LOGIN_HISTORY_RETENTION_MINUTES)
  useEffect(() => {
    setLoadingHistory(true);
    setHistoryError(null);
    const unsub = subscribeUserLoginHistory(
      user.uid,
      (items) => {
        setLoginHistory(items);
        setLoadingHistory(false);
        setHistoryError(null);
      },
      () => {
        setLoadingHistory(false);
        setHistoryError('Could not load recent sign-in activity.');
      }
    );
    return () => unsub();
  }, [user.uid, historySubNonce]);

  const handleRetryDevices = async () => {
    triggerHaptic('light');
    setLoadingDevices(true);
    setDevicesError(null);
    setDevicesSubNonce((n) => n + 1);
    try {
      const res = await fetchUserDevices(user.uid);
      if (res.activeDevices.length > 0) setActiveDevices(res.activeDevices);
    } catch {}
  };

  const handleRetryHistory = async () => {
    triggerHaptic('light');
    setLoadingHistory(true);
    setHistoryError(null);
    setHistorySubNonce((n) => n + 1);
    try {
      const items = await fetchUserLoginHistory(user.uid);
      if (items.length > 0) setLoginHistory(items);
    } catch {}
  };

  // Focus / Deep-link support from ResellerAccountHub search
  useEffect(() => {
    if (!initialFocusTarget) return;

    const scrollBehavior: ScrollBehavior = prefersReducedMotion ? 'auto' : 'smooth';
    const scrollTo = (el: HTMLElement | null) => {
      if (el) {
        window.setTimeout(() => {
          el.scrollIntoView({ behavior: scrollBehavior, block: 'start' });
        }, 80);
      }
    };

    switch (initialFocusTarget) {
      case 'password':
        scrollTo(passwordSectionRef.current);
        setModalError('');
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
        setShowCurrentPass(false);
        setShowNewPass(false);
        setShowConfirmPass(false);
        setActiveModal('changePassword');
        break;
      case 'forgot_password':
        scrollTo(forgotPasswordRowRef.current || passwordSectionRef.current);
        break;
      case 'strength_checker':
        scrollTo(passwordSectionRef.current);
        setCheckerPassword('');
        setShowCheckerPass(false);
        setActiveModal('strengthChecker');
        break;
      case 'login_history':
        scrollTo(loginHistorySectionRef.current);
        break;
      case 'active_devices':
        scrollTo(activeDevicesSectionRef.current);
        break;
      case 'trusted_devices':
        scrollTo(trustedDevicesSectionRef.current);
        break;
      case 'app_lock':
        scrollTo(appLockSectionRef.current);
        break;
      case 'biometric':
        scrollTo(biometricRowRef.current || appLockSectionRef.current);
        break;
      case 'two_factor':
        scrollTo(twoFactorRowRef.current || appLockSectionRef.current);
        break;
      case 'login_alerts':
        scrollTo(alertsSectionRef.current);
        break;
      case 'session_timeout':
        scrollTo(sessionTimeoutSectionRef.current);
        break;
    }

    onConsumeFocusTarget?.();
  }, [initialFocusTarget, onConsumeFocusTarget, prefersReducedMotion]);

  // Helper: execute sensitive action behind Re-authentication Gate
  const runWithReauth = useCallback(
    (action: () => Promise<void> | void) => {
      if (isRestricted) {
        onOpenLockedModal?.('Security Settings');
        return;
      }
      if (Date.now() - lastReauthAtRef.current < REAUTH_GRACE_MS) {
        void action();
        return;
      }
      pendingSensitiveActionRef.current = action;
      const hasPin = pinEnabled && Boolean(getStoredPinHash());
      setReauthMode(hasPin ? 'pin' : 'password');
      setReauthPin('');
      setReauthPassword('');
      setShowReauthPassword(false);
      setModalError('');
      setActiveModal('reauthGate');
    },
    [getStoredPinHash, isRestricted, onOpenLockedModal, pinEnabled]
  );

  const recordPinFailure = useCallback((): string => {
    const next = pinFailedAttempts + 1;
    setPinFailedAttempts(next);
    if (next >= PIN_MAX_ATTEMPTS) {
      const until = Date.now() + PIN_LOCKOUT_SECONDS * 1000;
      try {
        localStorage.setItem(`sky_pin_lockout_until_${user.uid}`, String(until));
      } catch {}
      setPinLockoutRemaining(PIN_LOCKOUT_SECONDS);
      return `Too many wrong PIN attempts. Try again in ${PIN_LOCKOUT_SECONDS} seconds.`;
    }
    return `Incorrect PIN. ${PIN_MAX_ATTEMPTS - next} attempt${PIN_MAX_ATTEMPTS - next === 1 ? '' : 's'} left.`;
  }, [pinFailedAttempts, user.uid]);

  const handleConfirmReauth = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError('');

    if (reauthMode === 'pin') {
      if (pinLockoutRemaining > 0) {
        setModalError(`Locked out for ${pinLockoutRemaining}s.`);
        return;
      }
      const storedHash = getStoredPinHash();
      if (!storedHash) {
        setReauthMode('password');
        setModalError('No local PIN found. Please enter your account password.');
        return;
      }
      if (!verifyStoredPinHash(reauthPin.trim(), storedHash)) {
        triggerHaptic('error');
        setReauthPin('');
        setModalError(recordPinFailure());
        return;
      }
      setPinFailedAttempts(0);
      lastReauthAtRef.current = Date.now();
      const pending = pendingSensitiveActionRef.current;
      pendingSensitiveActionRef.current = null;
      setActiveModal(null);
      if (pending) await pending();
      return;
    }

    // Password re-authentication via Firebase Auth
    if (!reauthPassword) {
      setModalError('Please enter your current password.');
      return;
    }
    setModalLoading(true);
    try {
      const curr = auth.currentUser;
      if (!curr || !curr.email) throw new Error('Active sign-in session not found.');
      const cred = EmailAuthProvider.credential(curr.email, reauthPassword);
      await reauthenticateWithCredential(curr, cred);
      lastReauthAtRef.current = Date.now();
      const pending = pendingSensitiveActionRef.current;
      pendingSensitiveActionRef.current = null;
      setReauthPassword('');
      setActiveModal(null);
      if (pending) await pending();
    } catch (err: any) {
      triggerHaptic('error');
      if (err?.code === 'auth/wrong-password' || err?.code === 'auth/invalid-credential') {
        setModalError('Incorrect password. Please try again.');
      } else {
        setModalError(err?.message || 'Verification failed.');
      }
    } finally {
      setModalLoading(false);
    }
  };

  // ==========================================
  // SECTION A HANDLERS — PASSWORD
  // ==========================================
  const newPasswordAnalysis = useMemo(() => analyzePassword(newPassword), [newPassword]);
  const checkerAnalysis = useMemo(() => analyzePassword(checkerPassword), [checkerPassword]);

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setModalError('');

    if (!currentPassword) {
      setModalError('Enter your current password.');
      return;
    }
    if (newPassword.length < 6) {
      setModalError('New password must be at least 6 characters.');
      return;
    }
    if (newPassword === currentPassword) {
      setModalError('New password must differ from your current password.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setModalError('New password and confirmation do not match.');
      return;
    }

    setModalLoading(true);
    triggerHaptic('medium');

    try {
      const currentUser = auth.currentUser;
      if (!currentUser || !currentUser.email) {
        throw new Error('Authentication session invalid. Please log in again.');
      }

      const credential = EmailAuthProvider.credential(currentUser.email, currentPassword);
      await reauthenticateWithCredential(currentUser, credential);
      await updatePassword(currentUser, newPassword);
      lastReauthAtRef.current = Date.now();

      let signedOutOtherCount = 0;
      if (signOutOtherDevicesOnPwChange) {
        const others = activeDevices.filter(
          (d) => !d.isCurrent && d.deviceId !== currentDeviceId
        );
        if (others.length > 0) {
          await Promise.allSettled(
            others.map(async (dev) => {
              const ok = await signOutSingleDevice(user.uid, dev.deviceId);
              if (ok) signedOutOtherCount += 1;
            })
          );
        }
      }

      await logAuditAction(
        user.uid,
        user.fullName || 'Reseller',
        user.role || 'reseller',
        'UPDATE_PASSWORD',
        user.uid,
        JSON.stringify({
          signedOutOtherDevices: signedOutOtherCount,
          timestamp: new Date().toISOString(),
        })
      );

      triggerHaptic('success');
      showToast(
        signedOutOtherCount > 0
          ? `Password updated and ${signedOutOtherCount} other device${signedOutOtherCount > 1 ? 's' : ''} signed out.`
          : 'Password updated successfully.',
        'success'
      );
      setActiveModal(null);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      triggerHaptic('error');
      if (err?.code === 'auth/wrong-password' || err?.code === 'auth/invalid-credential') {
        setModalError('Current password is incorrect.');
      } else if (err?.code === 'auth/weak-password') {
        setModalError('Password is too weak. Try adding letters, numbers, and symbols.');
      } else if (err?.code === 'auth/requires-recent-login') {
        setModalError('Please sign out and sign in again to change your password.');
      } else {
        setModalError(err?.message || 'Failed to update password.');
      }
    } finally {
      setModalLoading(false);
    }
  };

  const handleForgotPassword = async () => {
    if (resetCooldown > 0 || sendingResetEmail) return;
    if (!user.email) {
      showToast('No registered email found on your account.', 'error');
      return;
    }

    setSendingResetEmail(true);
    triggerHaptic('light');
    try {
      await sendPasswordResetEmail(auth, user.email);
      setResetCooldown(60);
      await logAuditAction(
        user.uid,
        user.fullName || 'Reseller',
        user.role || 'reseller',
        'SEND_PASSWORD_RESET_EMAIL',
        user.uid,
        `Reset link sent to ${user.email}`
      );
      showToast(`Reset link sent to ${user.email}. Check inbox & spam.`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Could not send reset email.', 'error');
    } finally {
      setSendingResetEmail(false);
    }
  };

  // ==========================================
  // SECTION B HANDLERS — DEVICES & TRUST
  // ==========================================
  const handleConfirmSingleDeviceLogout = async () => {
    if (!selectedDevice) return;
    setSigningOutSingle(true);
    triggerHaptic('medium');
    try {
      await signOutSingleDevice(user.uid, selectedDevice.deviceId);
      await logAuditAction(
        user.uid,
        user.fullName || 'Reseller',
        user.role || 'reseller',
        'LOGOUT_SINGLE_DEVICE',
        selectedDevice.deviceId,
        JSON.stringify({
          deviceId: selectedDevice.deviceId,
          deviceName: selectedDevice.deviceName,
        })
      );
      triggerHaptic('success');
      showToast(`${selectedDevice.deviceName} signed out.`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Failed to sign out device.', 'error');
    } finally {
      setSigningOutSingle(false);
      setSelectedDevice(null);
      setActiveModal(null);
    }
  };

  const handleConfirmLogoutAll = async () => {
    setModalLoading(true);
    triggerHaptic('medium');
    try {
      await signOutAllDevices(user.uid);
      await logAuditAction(
        user.uid,
        user.fullName || 'Reseller',
        user.role || 'reseller',
        'LOGOUT_ALL_DEVICES',
        user.uid,
        JSON.stringify({ timestamp: new Date().toISOString() })
      );
      triggerHaptic('success');
      showToast('Signed out from all devices.', 'success');
      setActiveModal(null);
      window.setTimeout(() => onLogout(), 500);
    } catch (err: any) {
      showToast(err?.message || 'Failed to log out from all devices.', 'error');
      setModalLoading(false);
    }
  };

  const handleSetTrustedDevice = (device: DeviceItem, trust: boolean) => {
    runWithReauth(async () => {
      setTrustBusyId(device.deviceId);
      triggerHaptic('light');
      try {
        await setDeviceTrusted(user.uid, device.deviceId, trust);
        await logAuditAction(
          user.uid,
          user.fullName || 'Reseller',
          user.role || 'reseller',
          trust ? 'TRUST_DEVICE' : 'UNTRUST_DEVICE',
          device.deviceId,
          JSON.stringify({ deviceName: device.deviceName, deviceId: device.deviceId })
        );
        triggerHaptic('success');
        showToast(
          trust
            ? `${device.deviceName} marked as trusted.`
            : `${device.deviceName} removed from trusted devices.`,
          'success'
        );
      } catch (err: any) {
        showToast(err?.message || 'Could not update trusted device status.', 'error');
      } finally {
        setTrustBusyId(null);
      }
    });
  };

  // ==========================================
  // SECTION C HANDLERS — APP LOCK PIN
  // ==========================================
  const openPinFlow = (action: PinAction) => {
    if (isRestricted) {
      onOpenLockedModal?.('App Lock');
      return;
    }
    triggerHaptic('light');
    setPendingPinAction(action);
    setModalError('');

    if (pinEnabled && (action === 'change' || action === 'disable')) {
      setVerifyPinInput('');
      setActiveModal('verifyCurrentPin');
    } else {
      setPinStep(1);
      setInputPin('');
      setConfirmPin('');
      setActiveModal('pinSetup');
    }
  };

  const verifyCurrentPinForChangeOrDisable = (candidate: string) => {
    if (pinLockoutRemaining > 0) {
      setModalError(`Try again in ${pinLockoutRemaining}s.`);
      return;
    }
    const storedHash = getStoredPinHash();
    if (!storedHash) {
      if (pendingPinAction === 'disable') {
        void executeDisablePin();
      } else {
        setPinStep(1);
        setInputPin('');
        setConfirmPin('');
        setModalError('');
        setActiveModal('pinSetup');
      }
      return;
    }

    if (!verifyStoredPinHash(candidate, storedHash)) {
      triggerHaptic('error');
      setVerifyPinInput('');
      setModalError(recordPinFailure());
      return;
    }

    setPinFailedAttempts(0);
    lastReauthAtRef.current = Date.now();
    triggerHaptic('light');

    if (pendingPinAction === 'disable') {
      void executeDisablePin();
    } else {
      setPinStep(1);
      setInputPin('');
      setConfirmPin('');
      setModalError('');
      setActiveModal('pinSetup');
    }
  };

  const executeDisablePin = async () => {
    try {
      localStorage.removeItem(`sky_app_pin_enabled_${user.uid}`);
      localStorage.removeItem(`sky_app_pin_hash_${user.uid}`);
      localStorage.removeItem(`sky_app_pin_length_${user.uid}`);
      localStorage.removeItem(`sky_pin_lockout_until_${user.uid}`);
      await updateDoc(doc(db, 'users', user.uid), {
        appLockEnabled: false,
        appLockPinHash: null,
        appLockPinLength: null,
        updatedAt: serverTimestamp(),
      });
      dispatchProfilePatch({
        appLockEnabled: false,
        appLockPinHash: null,
        appLockPinLength: undefined,
      });
      await logAuditAction(
        user.uid,
        user.fullName || 'Reseller',
        user.role || 'reseller',
        'DISABLE_APP_LOCK_PIN',
        user.uid,
        'App Lock PIN disabled'
      );
      setPinEnabled(false);
      setActiveModal(null);
      showToast('App Lock turned off.', 'success');
      onRefreshUser?.();
    } catch {
      setPinEnabled(false);
      setActiveModal(null);
      showToast('App Lock turned off locally.', 'success');
    }
  };

  const executeSavePin = async (finalPin: string) => {
    try {
      const hashed = bcrypt.hashSync(finalPin, 10);
      const len = finalPin.length;
      localStorage.setItem(`sky_app_pin_enabled_${user.uid}`, 'true');
      localStorage.setItem(`sky_app_pin_hash_${user.uid}`, hashed);
      localStorage.setItem(`sky_app_pin_length_${user.uid}`, String(len));

      await updateDoc(doc(db, 'users', user.uid), {
        appLockEnabled: true,
        appLockPinHash: hashed,
        appLockPinLength: len,
        updatedAt: serverTimestamp(),
      });

      dispatchProfilePatch({
        appLockEnabled: true,
        appLockPinHash: hashed,
        appLockPinLength: len,
      });

      await logAuditAction(
        user.uid,
        user.fullName || 'Reseller',
        user.role || 'reseller',
        pendingPinAction === 'change' ? 'UPDATE_APP_LOCK_PIN' : 'ENABLE_APP_LOCK_PIN',
        user.uid,
        `App Lock PIN ${pendingPinAction === 'change' ? 'changed' : 'enabled'} (${len} digits)`
      );

      setPinEnabled(true);
      setActiveModal(null);
      triggerHaptic('success');
      showToast(
        pendingPinAction === 'change' ? 'Security PIN updated.' : 'App Lock PIN enabled.',
        'success'
      );
      onRefreshUser?.();
    } catch {
      setPinEnabled(true);
      setActiveModal(null);
      showToast('App Lock PIN saved on this device.', 'success');
    }
  };

  const handleSelectLockDelay = async (ms: number) => {
    triggerHaptic('light');
    setLockTimeoutMs(ms);
    try {
      localStorage.setItem(`sky_app_lock_timeout_${user.uid}`, String(ms));
    } catch {}
    await logAuditAction(
      user.uid,
      user.fullName || 'Reseller',
      user.role || 'reseller',
      'UPDATE_APP_LOCK_DELAY',
      user.uid,
      `Auto-lock delay set to ${ms}ms`
    );
    setActiveModal(null);
    showToast('Auto-lock delay updated.', 'success');
  };

  // ==========================================
  // SECTION D HANDLERS — ALERTS & TIMEOUTS
  // ==========================================
  const persistSecurityPrefs = (
    nextPrefs: SecurityPreferences,
    auditAction: string,
    auditDetails: string,
    toastText: string
  ) => {
    runWithReauth(async () => {
      setSavingPrefs(true);
      const payload: SecurityPreferences = {
        loginAlertsEnabled: nextPrefs.loginAlertsEnabled ?? true,
        newDeviceAlertsEnabled: nextPrefs.newDeviceAlertsEnabled ?? true,
        alertChannels: {
          push: nextPrefs.alertChannels?.push ?? true,
          email: nextPrefs.alertChannels?.email ?? false,
        },
        sessionTimeoutMinutes: nextPrefs.sessionTimeoutMinutes ?? 0,
        sessionTimeoutAction: nextPrefs.sessionTimeoutAction ?? 'lock',
        updatedAt: Date.now(),
      };
      setSecurityPrefs(payload);
      try {
        await updateDoc(doc(db, 'users', user.uid), {
          securityPrefs: payload,
          updatedAt: serverTimestamp(),
        });
        dispatchProfilePatch({ securityPrefs: payload });
        await logAuditAction(
          user.uid,
          user.fullName || 'Reseller',
          user.role || 'reseller',
          auditAction,
          user.uid,
          auditDetails
        );
        triggerHaptic('success');
        showToast(toastText, 'success');
        onRefreshUser?.();
      } catch (err: any) {
        showToast(err?.message || 'Could not save security preference.', 'error');
      } finally {
        setSavingPrefs(false);
      }
    });
  };

  // Derived data
  const trustedDevices = useMemo(
    () => activeDevices.filter((d) => d.trusted),
    [activeDevices]
  );

  const visibleHistory = useMemo(
    () => (showAllHistory ? loginHistory : loginHistory.slice(0, 5)),
    [loginHistory, showAllHistory]
  );

  const lockDelayLabel =
    LOCK_DELAY_OPTIONS.find((opt) => opt.ms === lockTimeoutMs)?.label || 'After 10 seconds';

  const currentPinTargetLength = getStoredPinLength();

  const transitionProp = prefersReducedMotion ? { duration: 0 } : { duration: 0.16 };

  return (
    <div className="max-w-xl mx-auto min-h-0 space-y-4">
      {/* Toast Notification */}
      <AnimatePresence>
        {toast && (
          <motion.div
            initial={prefersReducedMotion ? { opacity: 1 } : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={transitionProp}
            className={`fixed top-4 left-4 right-4 z-[9999] max-w-md mx-auto px-3.5 py-2.5 rounded-[12px] shadow-lg border text-[12px] font-semibold flex items-center gap-2 ${
              toast.type === 'success'
                ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                : 'bg-rose-50 text-rose-800 border-rose-200'
            }`}
          >
            {toast.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
            ) : (
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0" />
            )}
            <span className="flex-1 leading-snug">{toast.text}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Optional standalone Header */}
      {!hideHeader && (
        <PageHeader
          title="Security & Login"
          subtitle="Password, devices, app lock & alerts"
          onBack={onBack}
        />
      )}

      {/* ========================================================
          SECTION A — PASSWORD
         ======================================================== */}
      <section ref={passwordSectionRef} className="space-y-1.5">
        <h3 className="px-1 text-[13px] font-semibold text-slate-600">Password</h3>
        <div className="bg-white/85 backdrop-blur-md border border-slate-200/80 rounded-[12px] divide-y divide-slate-100 overflow-hidden">
          {/* 1. Change Password */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setModalError('');
              setCurrentPassword('');
              setNewPassword('');
              setConfirmPassword('');
              setShowCurrentPass(false);
              setShowNewPass(false);
              setShowConfirmPass(false);
              setActiveModal('changePassword');
            }}
            className="w-full min-h-[54px] px-3.5 py-2.5 flex items-center justify-between gap-3 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <Key className="w-[18px] h-[18px] stroke-[1.75]" />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-slate-900 truncate">Change Password</p>
                <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                  Re-authenticate & update your ReSellBD password
                </p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
          </button>

          {/* 2. Forgot Password */}
          <div
            ref={forgotPasswordRowRef}
            className="min-h-[54px] px-3.5 py-2.5 flex items-center justify-between gap-3"
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <Mail className="w-[18px] h-[18px] stroke-[1.75]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium text-slate-900 truncate">Forgot Password</p>
                <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                  {user.email ? `Send reset link to ${user.email}` : 'No email linked'}
                </p>
              </div>
            </div>
            <button
              type="button"
              disabled={resetCooldown > 0 || sendingResetEmail || !user.email}
              onClick={handleForgotPassword}
              className="h-9 px-3 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-slate-800 text-[12px] font-semibold shrink-0 transition-colors motion-reduce:transition-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
            >
              {sendingResetEmail && <Loader2 className="w-3.5 h-3.5 animate-spin motion-reduce:animate-none" />}
              <span>{resetCooldown > 0 ? `Wait ${resetCooldown}s` : 'Send link'}</span>
            </button>
          </div>

          {/* 3. Password Strength Checker */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              setCheckerPassword('');
              setShowCheckerPass(false);
              setActiveModal('strengthChecker');
            }}
            className="w-full min-h-[54px] px-3.5 py-2.5 flex items-center justify-between gap-3 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <Gauge className="w-[18px] h-[18px] stroke-[1.75]" />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-slate-900 truncate">
                  Password Strength Checker
                </p>
                <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                  Test password strength locally without saving anything
                </p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
          </button>
        </div>
      </section>

      {/* ========================================================
          SECTION B — LOGINS AND DEVICES
         ======================================================== */}
      <section className="space-y-3">
        {/* 4. Login History + Recent Login Activity */}
        <div ref={loginHistorySectionRef} className="space-y-1.5">
          <div className="px-1 flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-slate-600">
              Recent Login Activity
            </h3>
            <span className="text-[11px] font-medium text-slate-400">
              Last {LOGIN_HISTORY_RETENTION_MINUTES} min
            </span>
          </div>

          <div className="bg-white/85 backdrop-blur-md border border-slate-200/80 rounded-[12px] overflow-hidden">
            {loadingHistory ? (
              <div className="divide-y divide-slate-100" aria-busy="true">
                {Array.from({ length: 3 }).map((_, idx) => (
                  <div
                    key={idx}
                    className="min-h-[54px] px-3.5 py-2.5 flex items-center gap-3 animate-pulse motion-reduce:animate-none"
                  >
                    <div className="w-9 h-9 rounded-[10px] bg-slate-100 shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3.5 w-36 bg-slate-200 rounded" />
                      <div className="h-3 w-28 bg-slate-100 rounded" />
                    </div>
                  </div>
                ))}
              </div>
            ) : historyError ? (
              <div className="px-3.5 py-5 text-center space-y-2">
                <p className="text-[12px] text-rose-600 font-medium">{historyError}</p>
                <button
                  type="button"
                  onClick={handleRetryHistory}
                  className="h-9 px-3 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-slate-800 text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Retry</span>
                </button>
              </div>
            ) : loginHistory.length === 0 ? (
              <div className="px-3.5 py-6 text-center space-y-1">
                <Clock className="w-5 h-5 text-slate-400 mx-auto" />
                <p className="text-[13px] font-medium text-slate-700">
                  No sign-ins in the last hour
                </p>
                <p className="text-[11.5px] text-slate-500">
                  Recent sign-in events appear here automatically for {LOGIN_HISTORY_RETENTION_MINUTES} minutes.
                </p>
              </div>
            ) : (
              <div>
                <div className="divide-y divide-slate-100">
                  {visibleHistory.map((item, idx) => {
                    const IconComp = renderDeviceIcon(item.deviceType);
                    const isThisDevice = item.deviceId === currentDeviceId;
                    const metaExtra = [item.location, item.network].filter(Boolean).join(' • ');
                    return (
                      <div
                        key={item.id || `${item.deviceId}_${idx}`}
                        className="min-h-[54px] px-3.5 py-2.5 flex items-center gap-3"
                      >
                        <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                          <IconComp className="w-[18px] h-[18px] stroke-[1.75]" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="text-[14px] font-medium text-slate-900 truncate max-w-full">
                              {item.deviceName}
                            </p>
                            {isThisDevice && (
                              <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200/80 text-[10px] font-semibold shrink-0">
                                This device
                              </span>
                            )}
                            {!isThisDevice && item.isNewDevice && (
                              <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200 text-[10px] font-semibold shrink-0">
                                New device
                              </span>
                            )}
                          </div>
                          <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                            {formatDhakaTimestamp(item.timestamp)}
                            {metaExtra ? ` • ${metaExtra}` : ''}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>

                {loginHistory.length > 5 && (
                  <div className="border-t border-slate-100 px-3.5 py-2">
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('light');
                        setShowAllHistory((v) => !v);
                      }}
                      className="w-full h-9 rounded-[10px] bg-slate-50 hover:bg-slate-100 text-slate-700 text-[12px] font-semibold transition-colors motion-reduce:transition-none cursor-pointer"
                    >
                      {showAllHistory
                        ? 'Show fewer'
                        : `Show more (${loginHistory.length - 5} more)`}
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* 5. Active Devices + Device Management */}
        <div ref={activeDevicesSectionRef} className="space-y-1.5">
          <div className="px-1 flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-slate-600">Active Devices</h3>
            <span className="text-[11px] font-medium text-slate-400">
              {activeDevices.length} active
            </span>
          </div>

          <div className="bg-white/85 backdrop-blur-md border border-slate-200/80 rounded-[12px] divide-y divide-slate-100 overflow-hidden">
            {loadingDevices ? (
              <div className="divide-y divide-slate-100" aria-busy="true">
                {Array.from({ length: 2 }).map((_, idx) => (
                  <div
                    key={idx}
                    className="min-h-[56px] px-3.5 py-2.5 flex items-center gap-3 animate-pulse motion-reduce:animate-none"
                  >
                    <div className="w-9 h-9 rounded-[10px] bg-slate-100 shrink-0" />
                    <div className="flex-1 space-y-1.5">
                      <div className="h-3.5 w-32 bg-slate-200 rounded" />
                      <div className="h-3 w-24 bg-slate-100 rounded" />
                    </div>
                    <div className="w-16 h-9 rounded-[10px] bg-slate-100 shrink-0" />
                  </div>
                ))}
              </div>
            ) : devicesError ? (
              <div className="px-3.5 py-5 text-center space-y-2">
                <p className="text-[12px] text-rose-600 font-medium">{devicesError}</p>
                <button
                  type="button"
                  onClick={handleRetryDevices}
                  className="h-9 px-3 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-slate-800 text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  <span>Retry</span>
                </button>
              </div>
            ) : activeDevices.length === 0 ? (
              <div className="px-3.5 py-5 text-center text-[12px] text-slate-500">
                No active device records found.
              </div>
            ) : (
              activeDevices.map((dev) => {
                const IconComp = renderDeviceIcon(dev.deviceType);
                const isCurrent = Boolean(dev.isCurrent || dev.deviceId === currentDeviceId);
                const swipeX = swipedOffsets[dev.deviceId] || 0;
                const osBrowser = [dev.os, dev.browser].filter(Boolean).join(' • ');

                return (
                  <div
                    key={dev.deviceId}
                    className="relative overflow-hidden"
                    onTouchStart={(e) => {
                      if (isCurrent) return;
                      const touch = e.touches[0];
                      swipeStartRef.current = {
                        id: dev.deviceId,
                        x: touch.clientX,
                        y: touch.clientY,
                      };
                    }}
                    onTouchMove={(e) => {
                      if (isCurrent || !swipeStartRef.current || swipeStartRef.current.id !== dev.deviceId) {
                        return;
                      }
                      const touch = e.touches[0];
                      const dx = touch.clientX - swipeStartRef.current.x;
                      const dy = Math.abs(touch.clientY - swipeStartRef.current.y);
                      if (dy > 24 && Math.abs(dx) < dy) return;
                      if (dx < 0) {
                        const clamped = Math.max(-92, dx);
                        setSwipedOffsets((prev) => ({ ...prev, [dev.deviceId]: clamped }));
                      }
                    }}
                    onTouchEnd={() => {
                      if (isCurrent) return;
                      const currentOffset = swipedOffsets[dev.deviceId] || 0;
                      swipeStartRef.current = null;
                      setSwipedOffsets((prev) => ({ ...prev, [dev.deviceId]: 0 }));
                      if (currentOffset <= -68) {
                        triggerHaptic('medium');
                        setSelectedDevice(dev);
                        setActiveModal('signOutDeviceConfirm');
                      }
                    }}
                  >
                    {!isCurrent && swipeX < -10 && (
                      <div
                        className="absolute inset-y-0 right-0 w-24 bg-rose-600 text-white flex items-center justify-center text-[12px] font-semibold pointer-events-none"
                        aria-hidden="true"
                      >
                        Log out
                      </div>
                    )}

                    <div
                      style={
                        prefersReducedMotion || swipeX === 0
                          ? undefined
                          : { transform: `translateX(${swipeX}px)` }
                      }
                      className="relative bg-white/95 min-h-[56px] px-3.5 py-2.5 flex items-center justify-between gap-2 transition-transform motion-reduce:transition-none"
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                          <IconComp className="w-[18px] h-[18px] stroke-[1.75]" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="text-[14px] font-medium text-slate-900 truncate">
                              {dev.deviceName}
                            </p>
                            {isCurrent && (
                              <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200/80 text-[10px] font-semibold shrink-0">
                                Current
                              </span>
                            )}
                            {dev.trusted && (
                              <span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-700 border border-slate-200 text-[10px] font-semibold shrink-0">
                                Trusted
                              </span>
                            )}
                          </div>
                          <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                            {formatRelativeAgo(dev.lastActive)}
                            {osBrowser ? ` • ${osBrowser}` : ''}
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        {!dev.trusted && (
                          <button
                            type="button"
                            disabled={trustBusyId === dev.deviceId}
                            onClick={() => handleSetTrustedDevice(dev, true)}
                            className="h-9 px-2.5 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-slate-700 text-[11.5px] font-semibold transition-colors motion-reduce:transition-none cursor-pointer disabled:opacity-50"
                          >
                            {trustBusyId === dev.deviceId ? 'Saving...' : 'Trust'}
                          </button>
                        )}
                        {!isCurrent && (
                          <button
                            type="button"
                            onClick={() => {
                              triggerHaptic('light');
                              setSelectedDevice(dev);
                              setActiveModal('signOutDeviceConfirm');
                            }}
                            className="h-9 px-2.5 rounded-[10px] bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200/70 text-[11.5px] font-semibold transition-colors motion-reduce:transition-none cursor-pointer"
                          >
                            Log out
                          </button>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}

            {/* Quiet danger row: Log out from all devices */}
            <button
              type="button"
              onClick={() => {
                triggerHaptic('medium');
                setActiveModal('logoutAllConfirm');
              }}
              className="w-full min-h-[52px] px-3.5 py-2.5 flex items-center justify-between gap-3 text-left hover:bg-rose-50/60 active:bg-rose-100/60 transition-colors motion-reduce:transition-none cursor-pointer"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-[10px] bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">
                  <LogOut className="w-[18px] h-[18px] stroke-[1.75]" />
                </div>
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-rose-600 truncate">
                    Log out from all devices
                  </p>
                  <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                    Ends every active ReSellBD session everywhere
                  </p>
                </div>
              </div>
              <ChevronRight className="w-4 h-4 text-rose-400 shrink-0" />
            </button>
          </div>
        </div>

        {/* 6. Trusted Devices Management */}
        <div ref={trustedDevicesSectionRef} className="space-y-1.5">
          <div className="px-1 flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-slate-600">Trusted Devices</h3>
            <span className="text-[11px] font-medium text-slate-400">
              {trustedDevices.length} saved
            </span>
          </div>

          <div className="bg-white/85 backdrop-blur-md border border-slate-200/80 rounded-[12px] divide-y divide-slate-100 overflow-hidden">
            {loadingDevices ? (
              <div className="min-h-[54px] px-3.5 py-2.5 flex items-center gap-3 animate-pulse motion-reduce:animate-none">
                <div className="w-9 h-9 rounded-[10px] bg-slate-100 shrink-0" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3.5 w-36 bg-slate-200 rounded" />
                  <div className="h-3 w-28 bg-slate-100 rounded" />
                </div>
              </div>
            ) : trustedDevices.length === 0 ? (
              <div className="px-3.5 py-5 flex items-start gap-3">
                <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-500 flex items-center justify-center shrink-0">
                  <UserCheck className="w-[18px] h-[18px] stroke-[1.75]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-slate-800">No trusted devices yet</p>
                  <p className="text-[11.5px] sm:text-[12px] text-slate-500 mt-0.5">
                    Tap &ldquo;Trust&rdquo; on an active device above to mark it trusted and skip new-device alerts.
                  </p>
                </div>
              </div>
            ) : (
              trustedDevices.map((dev) => {
                const IconComp = renderDeviceIcon(dev.deviceType);
                const isCurrent = Boolean(dev.isCurrent || dev.deviceId === currentDeviceId);
                return (
                  <div
                    key={`trusted_${dev.deviceId}`}
                    className="min-h-[54px] px-3.5 py-2.5 flex items-center justify-between gap-3"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="w-9 h-9 rounded-[10px] bg-emerald-50 text-emerald-700 flex items-center justify-center shrink-0">
                        <IconComp className="w-[18px] h-[18px] stroke-[1.75]" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <p className="text-[14px] font-medium text-slate-900 truncate">
                            {dev.deviceName}
                          </p>
                          {isCurrent && (
                            <span className="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200/80 text-[10px] font-semibold">
                              This device
                            </span>
                          )}
                        </div>
                        <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                          Trusted {dev.trustedAt ? formatDhakaTimestamp(dev.trustedAt) : 'device'}
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      disabled={trustBusyId === dev.deviceId}
                      onClick={() => handleSetTrustedDevice(dev, false)}
                      className="h-9 px-3 rounded-[10px] bg-slate-100 hover:bg-rose-50 hover:text-rose-700 text-slate-700 text-[12px] font-semibold shrink-0 transition-colors motion-reduce:transition-none cursor-pointer disabled:opacity-50 inline-flex items-center gap-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>{trustBusyId === dev.deviceId ? 'Removing...' : 'Remove'}</span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>
      </section>

      {/* ========================================================
          SECTION C — APP LOCK
         ======================================================== */}
      <section ref={appLockSectionRef} className="space-y-1.5">
        <h3 className="px-1 text-[13px] font-semibold text-slate-600">App Lock</h3>
        <div className="bg-white/85 backdrop-blur-md border border-slate-200/80 rounded-[12px] divide-y divide-slate-100 overflow-hidden">
          {/* 7a. App Lock Switch */}
          <div className="min-h-[54px] px-3.5 py-2.5 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <Lock className="w-[18px] h-[18px] stroke-[1.75]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium text-slate-900 truncate">App Lock</p>
                <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                  {pinEnabled
                    ? `Enabled (${currentPinTargetLength}-digit PIN required)`
                    : 'Protect ReSellBD with a 4–6 digit PIN'}
                </p>
              </div>
            </div>

            <button
              type="button"
              role="switch"
              aria-checked={pinEnabled}
              aria-label="Toggle App Lock PIN"
              onClick={() => openPinFlow(pinEnabled ? 'disable' : 'enable')}
              className="h-9 px-1 flex items-center cursor-pointer shrink-0"
            >
              <span
                className={`w-11 h-6 rounded-full transition-colors motion-reduce:transition-none p-0.5 flex items-center ${
                  pinEnabled ? 'bg-[#0E9AA7] justify-end' : 'bg-slate-300 justify-start'
                }`}
              >
                <span className="w-5 h-5 rounded-full bg-white shadow-xs" />
              </span>
            </button>
          </div>

          {/* 7b. Set or Change Security PIN */}
          <button
            type="button"
            onClick={() => openPinFlow(pinEnabled ? 'change' : 'enable')}
            className="w-full min-h-[54px] px-3.5 py-2.5 flex items-center justify-between gap-3 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <Shield className="w-[18px] h-[18px] stroke-[1.75]" />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-slate-900 truncate">
                  {pinEnabled ? 'Change Security PIN' : 'Set Security PIN'}
                </p>
                <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                  {pinEnabled
                    ? 'Verify current PIN before choosing a new passcode'
                    : 'Create a 4-digit or 6-digit PIN'}
                </p>
              </div>
            </div>
            <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
          </button>

          {/* 7c. Lock Delay */}
          <button
            type="button"
            disabled={!pinEnabled}
            onClick={() => {
              triggerHaptic('light');
              setActiveModal('lockTiming');
            }}
            className="w-full min-h-[54px] px-3.5 py-2.5 flex items-center justify-between gap-3 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                <Timer className="w-[18px] h-[18px] stroke-[1.75]" />
              </div>
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-slate-900 truncate">Lock Delay</p>
                <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                  {pinEnabled ? lockDelayLabel : 'Enable App Lock PIN to configure delay'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {pinEnabled && (
                <span className="text-[12px] font-medium text-slate-600">
                  {LOCK_DELAY_OPTIONS.find((o) => o.ms === lockTimeoutMs)?.shortLabel || '10s'}
                </span>
              )}
              <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
            </div>
          </button>

          {/* 7d. Biometric Login (Disabled - Coming soon) */}
          <div
            ref={biometricRowRef}
            aria-disabled="true"
            className="min-h-[54px] px-3.5 py-2.5 flex items-center justify-between gap-3 opacity-65 select-none"
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-500 flex items-center justify-center shrink-0">
                <Fingerprint className="w-[18px] h-[18px] stroke-[1.75]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium text-slate-700 truncate">Biometric Login</p>
                <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                  Fingerprint &amp; Face Unlock is not yet enabled in this build
                </p>
              </div>
            </div>
            <span className="px-2 py-1 rounded-md bg-slate-100 text-slate-600 border border-slate-200 text-[11px] font-semibold shrink-0">
              Coming soon
            </span>
          </div>

          {/* 8. Two-Factor Authentication (Disabled - Coming soon) */}
          <div
            ref={twoFactorRowRef}
            aria-disabled="true"
            className="min-h-[54px] px-3.5 py-2.5 flex items-center justify-between gap-3 opacity-65 select-none"
          >
            <div className="flex items-center gap-3 min-w-0 flex-1">
              <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-500 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-[18px] h-[18px] stroke-[1.75]" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[14px] font-medium text-slate-700 truncate">
                  Two-Factor Authentication
                </p>
                <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                  Authenticator app &amp; SMS verification
                </p>
              </div>
            </div>
            <span className="px-2 py-1 rounded-md bg-slate-100 text-slate-600 border border-slate-200 text-[11px] font-semibold shrink-0">
              Coming soon
            </span>
          </div>
        </div>
      </section>

      {/* ========================================================
          SECTION D — ALERTS AND SESSIONS
         ======================================================== */}
      <section className="space-y-3">
        {/* 9. Login Alerts & Channels */}
        <div ref={alertsSectionRef} className="space-y-1.5">
          <h3 className="px-1 text-[13px] font-semibold text-slate-600">Login Alerts</h3>
          <div className="bg-white/85 backdrop-blur-md border border-slate-200/80 rounded-[12px] divide-y divide-slate-100 overflow-hidden">
            {/* Login Alert Toggle */}
            <div className="min-h-[54px] px-3.5 py-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                  <Bell className="w-[18px] h-[18px] stroke-[1.75]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-slate-900 truncate">Login Alert</p>
                  <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                    Notify whenever your account signs in
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                disabled={savingPrefs}
                aria-checked={Boolean(securityPrefs.loginAlertsEnabled)}
                aria-label="Toggle Login Alert"
                onClick={() =>
                  persistSecurityPrefs(
                    {
                      ...securityPrefs,
                      loginAlertsEnabled: !securityPrefs.loginAlertsEnabled,
                    },
                    'UPDATE_SECURITY_ALERT_PREFS',
                    `loginAlertsEnabled=${!securityPrefs.loginAlertsEnabled}`,
                    !securityPrefs.loginAlertsEnabled ? 'Login alerts enabled.' : 'Login alerts muted.'
                  )
                }
                className="h-9 px-1 flex items-center cursor-pointer shrink-0 disabled:opacity-50"
              >
                <span
                  className={`w-11 h-6 rounded-full transition-colors motion-reduce:transition-none p-0.5 flex items-center ${
                    securityPrefs.loginAlertsEnabled
                      ? 'bg-[#0E9AA7] justify-end'
                      : 'bg-slate-300 justify-start'
                  }`}
                >
                  <span className="w-5 h-5 rounded-full bg-white shadow-xs" />
                </span>
              </button>
            </div>

            {/* New Device Login Alert Toggle */}
            <div className="min-h-[54px] px-3.5 py-2.5 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3 min-w-0 flex-1">
                <div className="w-9 h-9 rounded-[10px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                  <ShieldAlert className="w-[18px] h-[18px] stroke-[1.75]" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-slate-900 truncate">
                    New Device Login Alert
                  </p>
                  <p className="text-[11.5px] sm:text-[12px] text-slate-500 truncate mt-0.5">
                    Warn on sign-in from unrecognized devices
                  </p>
                </div>
              </div>
              <button
                type="button"
                role="switch"
                disabled={savingPrefs}
                aria-checked={Boolean(securityPrefs.newDeviceAlertsEnabled)}
                aria-label="Toggle New Device Login Alert"
                onClick={() =>
                  persistSecurityPrefs(
                    {
                      ...securityPrefs,
                      newDeviceAlertsEnabled: !securityPrefs.newDeviceAlertsEnabled,
                    },
                    'UPDATE_SECURITY_ALERT_PREFS',
                    `newDeviceAlertsEnabled=${!securityPrefs.newDeviceAlertsEnabled}`,
                    !securityPrefs.newDeviceAlertsEnabled
                      ? 'New device alerts enabled.'
                      : 'New device alerts muted.'
                  )
                }
                className="h-9 px-1 flex items-center cursor-pointer shrink-0 disabled:opacity-50"
              >
                <span
                  className={`w-11 h-6 rounded-full transition-colors motion-reduce:transition-none p-0.5 flex items-center ${
                    securityPrefs.newDeviceAlertsEnabled
                      ? 'bg-[#0E9AA7] justify-end'
                      : 'bg-slate-300 justify-start'
                  }`}
                >
                  <span className="w-5 h-5 rounded-full bg-white shadow-xs" />
                </span>
              </button>
            </div>

            {/* Alert Channels Selector */}
            <div className="min-h-[54px] px-3.5 py-2.5 flex items-center justify-between gap-2 flex-wrap">
              <div className="min-w-0">
                <p className="text-[14px] font-medium text-slate-900">Notification Channels</p>
                <p className="text-[11.5px] sm:text-[12px] text-slate-500 mt-0.5">
                  Where to deliver login security alerts
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <button
                  type="button"
                  disabled={savingPrefs}
                  onClick={() => {
                    const nextPush = !(securityPrefs.alertChannels?.push ?? true);
                    const nextEmail = securityPrefs.alertChannels?.email ?? false;
                    if (!nextPush && !nextEmail) {
                      showToast('Keep at least one alert channel active.', 'error');
                      return;
                    }
                    persistSecurityPrefs(
                      {
                        ...securityPrefs,
                        alertChannels: { push: nextPush, email: nextEmail },
                      },
                      'UPDATE_SECURITY_ALERT_CHANNELS',
                      JSON.stringify({ push: nextPush, email: nextEmail }),
                      'Alert channels updated.'
                    );
                  }}
                  className={`h-9 px-3 rounded-[10px] text-[12px] font-semibold border transition-colors motion-reduce:transition-none cursor-pointer flex items-center gap-1.5 ${
                    securityPrefs.alertChannels?.push
                      ? 'bg-[#04203F] text-white border-[#04203F]'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {securityPrefs.alertChannels?.push && <Check className="w-3.5 h-3.5" />}
                  <span>Push</span>
                </button>
                <button
                  type="button"
                  disabled={savingPrefs}
                  onClick={() => {
                    const nextPush = securityPrefs.alertChannels?.push ?? true;
                    const nextEmail = !(securityPrefs.alertChannels?.email ?? false);
                    if (!nextPush && !nextEmail) {
                      showToast('Keep at least one alert channel active.', 'error');
                      return;
                    }
                    persistSecurityPrefs(
                      {
                        ...securityPrefs,
                        alertChannels: { push: nextPush, email: nextEmail },
                      },
                      'UPDATE_SECURITY_ALERT_CHANNELS',
                      JSON.stringify({ push: nextPush, email: nextEmail }),
                      'Alert channels updated.'
                    );
                  }}
                  className={`h-9 px-3 rounded-[10px] text-[12px] font-semibold border transition-colors motion-reduce:transition-none cursor-pointer flex items-center gap-1.5 ${
                    securityPrefs.alertChannels?.email
                      ? 'bg-[#04203F] text-white border-[#04203F]'
                      : 'bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100'
                  }`}
                >
                  {securityPrefs.alertChannels?.email && <Check className="w-3.5 h-3.5" />}
                  <span>Email</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* 10. Session Timeout Settings */}
        <div ref={sessionTimeoutSectionRef} className="space-y-1.5">
          <h3 className="px-1 text-[13px] font-semibold text-slate-600">
            Session Timeout Settings
          </h3>
          <div className="bg-white/85 backdrop-blur-md border border-slate-200/80 rounded-[12px] divide-y divide-slate-100 overflow-hidden">
            <div className="px-3.5 py-3 space-y-2.5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-[14px] font-medium text-slate-900">Inactivity Timeout</p>
                  <p className="text-[11.5px] sm:text-[12px] text-slate-500 mt-0.5">
                    Auto-lock or sign out after being idle
                  </p>
                </div>
                <span className="text-[12px] font-semibold text-slate-700 shrink-0">
                  {SESSION_TIMEOUT_OPTIONS.find(
                    (o) => o.minutes === (securityPrefs.sessionTimeoutMinutes ?? 0)
                  )?.label || 'Never'}
                </span>
              </div>

              <div className="grid grid-cols-3 sm:grid-cols-5 gap-1.5">
                {SESSION_TIMEOUT_OPTIONS.map((opt) => {
                  const selected = (securityPrefs.sessionTimeoutMinutes ?? 0) === opt.minutes;
                  return (
                    <button
                      key={opt.minutes}
                      type="button"
                      disabled={savingPrefs}
                      onClick={() =>
                        persistSecurityPrefs(
                          { ...securityPrefs, sessionTimeoutMinutes: opt.minutes },
                          'UPDATE_SESSION_TIMEOUT_PREFS',
                          `sessionTimeoutMinutes=${opt.minutes}`,
                          opt.minutes === 0
                            ? 'Inactivity timeout disabled.'
                            : `Session timeout set to ${opt.label}.`
                        )
                      }
                      className={`h-9 px-2 rounded-[10px] text-[12px] font-semibold border transition-colors motion-reduce:transition-none cursor-pointer disabled:opacity-50 ${
                        selected
                          ? 'bg-[#04203F] text-white border-[#04203F]'
                          : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {(securityPrefs.sessionTimeoutMinutes ?? 0) > 0 && (
              <div className="px-3.5 py-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-[14px] font-medium text-slate-900">When timeout expires</p>
                    <p className="text-[11.5px] sm:text-[12px] text-slate-500 mt-0.5">
                      {(securityPrefs.sessionTimeoutAction || 'lock') === 'lock' && !pinEnabled
                        ? 'Signs out until App Lock PIN is enabled'
                        : 'Action taken automatically when idle'}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    disabled={savingPrefs}
                    onClick={() =>
                      persistSecurityPrefs(
                        { ...securityPrefs, sessionTimeoutAction: 'lock' },
                        'UPDATE_SESSION_TIMEOUT_ACTION',
                        'sessionTimeoutAction=lock',
                        'Timeout action set to Lock with PIN.'
                      )
                    }
                    className={`h-9 px-3 rounded-[10px] text-[12px] font-semibold border transition-colors motion-reduce:transition-none cursor-pointer disabled:opacity-50 ${
                      (securityPrefs.sessionTimeoutAction || 'lock') === 'lock'
                        ? 'bg-[#04203F] text-white border-[#04203F]'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    Lock with PIN
                  </button>
                  <button
                    type="button"
                    disabled={savingPrefs}
                    onClick={() =>
                      persistSecurityPrefs(
                        { ...securityPrefs, sessionTimeoutAction: 'logout' },
                        'UPDATE_SESSION_TIMEOUT_ACTION',
                        'sessionTimeoutAction=logout',
                        'Timeout action set to Sign out.'
                      )
                    }
                    className={`h-9 px-3 rounded-[10px] text-[12px] font-semibold border transition-colors motion-reduce:transition-none cursor-pointer disabled:opacity-50 ${
                      securityPrefs.sessionTimeoutAction === 'logout'
                        ? 'bg-[#04203F] text-white border-[#04203F]'
                        : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                    }`}
                  >
                    Sign out
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ========================================================
          MODAL 1: CHANGE PASSWORD SHEET
         ======================================================== */}
      {activeModal === 'changePassword' && (
        <div
          className="fixed inset-0 z-[80] bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => !modalLoading && setActiveModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white rounded-t-2xl sm:rounded-[14px] border border-slate-200 p-4 sm:p-5 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] space-y-3.5 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[16px] font-semibold text-slate-900">Change Password</h3>
              <button
                type="button"
                disabled={modalLoading}
                onClick={() => setActiveModal(null)}
                aria-label="Close"
                className="w-9 h-9 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleChangePassword} className="space-y-3">
              {modalError && (
                <div className="px-3 py-2 rounded-[10px] bg-rose-50 border border-rose-200 text-rose-700 text-[12px] font-medium flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{modalError}</span>
                </div>
              )}

              <div>
                <label className="block text-[12px] font-medium text-slate-700 mb-1">
                  Current Password
                </label>
                <div className="relative">
                  <input
                    type={showCurrentPass ? 'text' : 'password'}
                    required
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                    className="w-full h-10 pl-3 pr-10 rounded-[10px] border border-slate-200 bg-slate-50 focus:bg-white focus:border-[#0E9AA7] text-[13px] outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCurrentPass((v) => !v)}
                    aria-label={showCurrentPass ? 'Hide current password' : 'Show current password'}
                    className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg text-slate-500 hover:text-slate-800 flex items-center justify-center cursor-pointer"
                  >
                    {showCurrentPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[12px] font-medium text-slate-700 mb-1">
                  New Password
                </label>
                <div className="relative">
                  <input
                    type={showNewPass ? 'text' : 'password'}
                    required
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="At least 6 characters"
                    className="w-full h-10 pl-3 pr-10 rounded-[10px] border border-slate-200 bg-slate-50 focus:bg-white focus:border-[#0E9AA7] text-[13px] outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPass((v) => !v)}
                    aria-label={showNewPass ? 'Hide new password' : 'Show new password'}
                    className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg text-slate-500 hover:text-slate-800 flex items-center justify-center cursor-pointer"
                  >
                    {showNewPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>

                {/* Live 4-step strength bar */}
                {newPassword.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <div className="grid grid-cols-4 gap-1">
                      {[1, 2, 3, 4].map((step) => (
                        <div
                          key={step}
                          className={`h-1.5 rounded-full transition-colors motion-reduce:transition-none ${
                            newPasswordAnalysis.score >= step
                              ? newPasswordAnalysis.barColor
                              : 'bg-slate-200'
                          }`}
                        />
                      ))}
                    </div>
                    <div className="flex items-center justify-between text-[11px]">
                      <span className={`font-semibold ${newPasswordAnalysis.textColor}`}>
                        Strength: {newPasswordAnalysis.label}
                      </span>
                      <span className="text-slate-400">
                        {newPassword.length} chars
                      </span>
                    </div>
                  </div>
                )}
              </div>

              <div>
                <label className="block text-[12px] font-medium text-slate-700 mb-1">
                  Confirm New Password
                </label>
                <div className="relative">
                  <input
                    type={showConfirmPass ? 'text' : 'password'}
                    required
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Re-enter new password"
                    className="w-full h-10 pl-3 pr-10 rounded-[10px] border border-slate-200 bg-slate-50 focus:bg-white focus:border-[#0E9AA7] text-[13px] outline-none"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirmPass((v) => !v)}
                    aria-label={showConfirmPass ? 'Hide confirm password' : 'Show confirm password'}
                    className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg text-slate-500 hover:text-slate-800 flex items-center justify-center cursor-pointer"
                  >
                    {showConfirmPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <label className="flex items-center gap-2.5 pt-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={signOutOtherDevicesOnPwChange}
                  onChange={(e) => setSignOutOtherDevicesOnPwChange(e.target.checked)}
                  className="w-4 h-4 rounded border-slate-300 text-[#0E9AA7] focus:ring-[#0E9AA7]"
                />
                <span className="text-[12px] font-medium text-slate-700">
                  Sign out other devices after updating password
                </span>
              </label>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  disabled={modalLoading}
                  onClick={() => setActiveModal(null)}
                  className="flex-1 h-10 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-slate-700 text-[13px] font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={modalLoading}
                  className="flex-1 h-10 rounded-[10px] bg-[#04203F] hover:bg-[#0E9AA7] text-white text-[13px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
                >
                  {modalLoading && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" />}
                  <span>Save Password</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ========================================================
          MODAL 2: PASSWORD STRENGTH CHECKER (LOCAL ONLY)
         ======================================================== */}
      {activeModal === 'strengthChecker' && (
        <div
          className="fixed inset-0 z-[80] bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setActiveModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white rounded-t-2xl sm:rounded-[14px] border border-slate-200 p-4 sm:p-5 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] space-y-3.5 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-[16px] font-semibold text-slate-900">
                  Password Strength Checker
                </h3>
                <p className="text-[11.5px] text-slate-500 mt-0.5">
                  Evaluated locally on your device — never saved or sent anywhere
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setCheckerPassword('');
                  setActiveModal(null);
                }}
                aria-label="Close"
                className="w-9 h-9 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 flex items-center justify-center cursor-pointer shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="relative">
              <input
                type={showCheckerPass ? 'text' : 'password'}
                value={checkerPassword}
                onChange={(e) => setCheckerPassword(e.target.value)}
                placeholder="Type any password to test..."
                autoComplete="off"
                className="w-full h-10 pl-3 pr-18 rounded-[10px] border border-slate-200 bg-slate-50 focus:bg-white focus:border-[#0E9AA7] text-[13px] outline-none"
              />
              {checkerPassword && (
                <button
                  type="button"
                  onClick={() => setCheckerPassword('')}
                  className="absolute right-9 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg text-slate-400 hover:text-slate-700 flex items-center justify-center cursor-pointer"
                  aria-label="Clear test password"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowCheckerPass((v) => !v)}
                aria-label={showCheckerPass ? 'Hide password' : 'Show password'}
                className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg text-slate-500 hover:text-slate-800 flex items-center justify-center cursor-pointer"
              >
                {showCheckerPass ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            <div className="space-y-1.5">
              <div className="grid grid-cols-4 gap-1.5">
                {[1, 2, 3, 4].map((step) => (
                  <div
                    key={step}
                    className={`h-1.5 rounded-full transition-colors motion-reduce:transition-none ${
                      checkerAnalysis.score >= step ? checkerAnalysis.barColor : 'bg-slate-200'
                    }`}
                  />
                ))}
              </div>
              <div className="flex items-center justify-between text-[12px]">
                <span className={`font-semibold ${checkerAnalysis.textColor}`}>
                  {checkerAnalysis.label}
                </span>
                <span className="text-slate-500">{checkerPassword.length} characters</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-1.5 text-[11.5px]">
              {[
                { ok: checkerAnalysis.checks.recommendedLength, label: '10+ characters' },
                { ok: checkerAnalysis.checks.upperLower, label: 'Upper & lowercase' },
                { ok: checkerAnalysis.checks.hasNumber, label: 'Contains number' },
                { ok: checkerAnalysis.checks.hasSymbol, label: 'Contains symbol' },
              ].map((rule) => (
                <div key={rule.label} className="flex items-center gap-1.5 text-slate-700">
                  <CheckCircle2
                    className={`w-3.5 h-3.5 shrink-0 ${
                      rule.ok ? 'text-emerald-600' : 'text-slate-300'
                    }`}
                  />
                  <span className={rule.ok ? 'text-slate-800 font-medium' : 'text-slate-500'}>
                    {rule.label}
                  </span>
                </div>
              ))}
            </div>

            <div className="pt-1 border-t border-slate-100 space-y-1">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Tips
              </p>
              {checkerAnalysis.tips.map((tip) => (
                <p key={tip} className="text-[12px] text-slate-600 leading-snug">
                  • {tip}
                </p>
              ))}
            </div>

            <button
              type="button"
              onClick={() => {
                setCheckerPassword('');
                setActiveModal(null);
              }}
              className="w-full h-10 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-slate-800 text-[13px] font-semibold cursor-pointer"
            >
              Done
            </button>
          </div>
        </div>
      )}

      {/* ========================================================
          MODAL 3: VERIFY CURRENT PIN (5-ATTEMPT / 30s LOCKOUT)
         ======================================================== */}
      {activeModal === 'verifyCurrentPin' && (
        <div
          className="fixed inset-0 z-[80] bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setActiveModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-[#EEF2F7] rounded-t-2xl sm:rounded-2xl border border-white/80 p-5 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] space-y-3 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[16px] font-semibold text-slate-900">Enter Current PIN</h3>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                aria-label="Close"
                className="w-9 h-9 rounded-lg bg-white/80 text-slate-600 flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-[12px] text-slate-600">
              {pendingPinAction === 'disable'
                ? 'Verify your current Security PIN to disable App Lock.'
                : 'Verify your current Security PIN before setting a new one.'}
            </p>

            {/* PIN Dots */}
            <div className="flex items-center justify-center gap-3 py-1">
              {Array.from({ length: currentPinTargetLength }).map((_, idx) => (
                <div
                  key={idx}
                  className={`w-3.5 h-3.5 rounded-full transition-colors motion-reduce:transition-none ${
                    idx < verifyPinInput.length
                      ? 'bg-[#0E9AA7]'
                      : 'bg-slate-300'
                  }`}
                />
              ))}
            </div>

            {modalError && (
              <p className="text-center text-[12px] font-medium text-rose-600">{modalError}</p>
            )}
            {pinLockoutRemaining > 0 && (
              <p className="text-center text-[12px] font-semibold text-rose-700">
                Locked out for {pinLockoutRemaining}s
              </p>
            )}

            <NeumorphicPinKeypad
              pin={verifyPinInput}
              maxPinLength={currentPinTargetLength}
              disabled={pinLockoutRemaining > 0}
              onDigitPress={(digit) => {
                if (verifyPinInput.length < currentPinTargetLength) {
                  const next = verifyPinInput + digit;
                  setVerifyPinInput(next);
                  setModalError('');
                  if (next.length === currentPinTargetLength) {
                    window.setTimeout(() => verifyCurrentPinForChangeOrDisable(next), 80);
                  }
                }
              }}
              onBackspace={() => {
                setVerifyPinInput((p) => p.slice(0, -1));
                setModalError('');
              }}
            />
          </div>
        </div>
      )}

      {/* ========================================================
          MODAL 4: SET / CONFIRM SECURITY PIN
         ======================================================== */}
      {activeModal === 'pinSetup' && (
        <div
          className="fixed inset-0 z-[80] bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setActiveModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-[#EEF2F7] rounded-t-2xl sm:rounded-2xl border border-white/80 p-5 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] space-y-3 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[16px] font-semibold text-slate-900">
                {pinStep === 1 ? 'Create Security PIN' : 'Confirm Security PIN'}
              </h3>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                aria-label="Close"
                className="w-9 h-9 rounded-lg bg-white/80 text-slate-600 flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {pinStep === 1 && (
              <div className="flex items-center justify-center gap-2">
                {([4, 6] as const).map((len) => (
                  <button
                    key={len}
                    type="button"
                    onClick={() => {
                      setPinLengthChoice(len);
                      setInputPin('');
                      setConfirmPin('');
                      setModalError('');
                    }}
                    className={`h-9 px-3 rounded-[10px] text-[12px] font-semibold border cursor-pointer ${
                      pinLengthChoice === len
                        ? 'bg-[#04203F] text-white border-[#04203F]'
                        : 'bg-white text-slate-700 border-slate-200'
                    }`}
                  >
                    {len}-digit PIN
                  </button>
                ))}
              </div>
            )}

            <p className="text-center text-[12px] text-slate-600">
              {pinStep === 1
                ? `Enter a ${pinLengthChoice}-digit Security PIN`
                : 'Re-enter your PIN to confirm'}
            </p>

            {/* PIN Dots */}
            <div className="flex items-center justify-center gap-3 py-1">
              {Array.from({ length: pinLengthChoice }).map((_, idx) => {
                const activeVal = pinStep === 1 ? inputPin : confirmPin;
                return (
                  <div
                    key={idx}
                    className={`w-3.5 h-3.5 rounded-full transition-colors motion-reduce:transition-none ${
                      idx < activeVal.length ? 'bg-[#0E9AA7]' : 'bg-slate-300'
                    }`}
                  />
                );
              })}
            </div>

            {modalError && (
              <p className="text-center text-[12px] font-medium text-rose-600">{modalError}</p>
            )}

            <NeumorphicPinKeypad
              pin={pinStep === 1 ? inputPin : confirmPin}
              maxPinLength={pinLengthChoice}
              onDigitPress={(digit) => {
                if (pinStep === 1) {
                  if (inputPin.length < pinLengthChoice) {
                    const next = inputPin + digit;
                    setInputPin(next);
                    setModalError('');
                    if (next.length === pinLengthChoice) {
                      window.setTimeout(() => {
                        setPinStep(2);
                        setConfirmPin('');
                      }, 120);
                    }
                  }
                } else {
                  if (confirmPin.length < pinLengthChoice) {
                    const next = confirmPin + digit;
                    setConfirmPin(next);
                    setModalError('');
                    if (next.length === pinLengthChoice) {
                      if (next === inputPin) {
                        window.setTimeout(() => void executeSavePin(next), 100);
                      } else {
                        triggerHaptic('error');
                        setModalError('PINs do not match. Try again.');
                        window.setTimeout(() => setConfirmPin(''), 250);
                      }
                    }
                  }
                }
              }}
              onBackspace={() => {
                if (pinStep === 1) setInputPin((p) => p.slice(0, -1));
                else setConfirmPin((p) => p.slice(0, -1));
                setModalError('');
              }}
            />
          </div>
        </div>
      )}

      {/* ========================================================
          MODAL 5: LOCK DELAY SELECTOR
         ======================================================== */}
      {activeModal === 'lockTiming' && (
        <div
          className="fixed inset-0 z-[80] bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setActiveModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-white rounded-t-2xl sm:rounded-[14px] border border-slate-200 p-4 sm:p-5 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] space-y-3 shadow-2xl"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-[16px] font-semibold text-slate-900">Auto-Lock Delay</h3>
              <button
                type="button"
                onClick={() => setActiveModal(null)}
                aria-label="Close"
                className="w-9 h-9 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="divide-y divide-slate-100 border border-slate-200 rounded-[12px] overflow-hidden">
              {LOCK_DELAY_OPTIONS.map((opt) => {
                const selected = lockTimeoutMs === opt.ms;
                return (
                  <button
                    key={opt.ms}
                    type="button"
                    onClick={() => handleSelectLockDelay(opt.ms)}
                    className="w-full min-h-[50px] px-3.5 py-2.5 flex items-center justify-between text-left hover:bg-slate-50 cursor-pointer"
                  >
                    <span className="text-[14px] font-medium text-slate-900">{opt.label}</span>
                    {selected && <Check className="w-4 h-4 text-[#0E9AA7]" />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* ========================================================
          MODAL 6: SIGN OUT SINGLE DEVICE CONFIRM
         ======================================================== */}
      {activeModal === 'signOutDeviceConfirm' && selectedDevice && (
        <div
          className="fixed inset-0 z-[80] bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => !signingOutSingle && setActiveModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-white rounded-t-2xl sm:rounded-[14px] border border-slate-200 p-5 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] space-y-4 shadow-2xl"
          >
            <div className="space-y-1">
              <h3 className="text-[16px] font-semibold text-slate-900">
                Log out {selectedDevice.deviceName}?
              </h3>
              <p className="text-[12px] text-slate-500 leading-relaxed">
                This device will immediately lose access to your ReSellBD session and must sign in again.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={signingOutSingle}
                onClick={() => {
                  setSelectedDevice(null);
                  setActiveModal(null);
                }}
                className="flex-1 h-10 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-slate-700 text-[13px] font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={signingOutSingle}
                onClick={handleConfirmSingleDeviceLogout}
                className="flex-1 h-10 rounded-[10px] bg-rose-600 hover:bg-rose-700 text-white text-[13px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
              >
                {signingOutSingle && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" />}
                <span>Log out</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================
          MODAL 7: LOG OUT FROM ALL DEVICES CONFIRM
         ======================================================== */}
      {activeModal === 'logoutAllConfirm' && (
        <div
          className="fixed inset-0 z-[80] bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => !modalLoading && setActiveModal(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-white rounded-t-2xl sm:rounded-[14px] border border-slate-200 p-5 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] space-y-4 shadow-2xl"
          >
            <div className="space-y-1">
              <h3 className="text-[16px] font-semibold text-slate-900">
                Log out from all devices?
              </h3>
              <p className="text-[12px] text-slate-500 leading-relaxed">
                Every signed-in phone and browser—including this device—will be signed out immediately.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={modalLoading}
                onClick={() => setActiveModal(null)}
                className="flex-1 h-10 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-slate-700 text-[13px] font-semibold cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={modalLoading}
                onClick={handleConfirmLogoutAll}
                className="flex-1 h-10 rounded-[10px] bg-rose-600 hover:bg-rose-700 text-white text-[13px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
              >
                {modalLoading && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" />}
                <span>Log out all</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================
          MODAL 8: RE-AUTHENTICATION GATE FOR SENSITIVE CHANGES
         ======================================================== */}
      {activeModal === 'reauthGate' && (
        <div
          className="fixed inset-0 z-[85] bg-slate-900/50 backdrop-blur-xs flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => {
            if (!modalLoading) {
              pendingSensitiveActionRef.current = null;
              setActiveModal(null);
            }
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-sm bg-white rounded-t-2xl sm:rounded-[14px] border border-slate-200 p-5 pb-[calc(env(safe-area-inset-bottom,0px)+1rem)] space-y-3.5 shadow-2xl"
          >
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="text-[16px] font-semibold text-slate-900">Confirm Identity</h3>
                <p className="text-[11.5px] text-slate-500 mt-0.5">
                  Re-authenticate before updating security settings
                </p>
              </div>
              <button
                type="button"
                disabled={modalLoading}
                onClick={() => {
                  pendingSensitiveActionRef.current = null;
                  setActiveModal(null);
                }}
                aria-label="Close"
                className="w-9 h-9 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {pinEnabled && Boolean(getStoredPinHash()) && (
              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-[10px] bg-slate-100">
                <button
                  type="button"
                  onClick={() => {
                    setReauthMode('pin');
                    setModalError('');
                  }}
                  className={`h-8 rounded-[8px] text-[12px] font-semibold cursor-pointer ${
                    reauthMode === 'pin' ? 'bg-white text-slate-900 shadow-2xs' : 'text-slate-600'
                  }`}
                >
                  App PIN
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setReauthMode('password');
                    setModalError('');
                  }}
                  className={`h-8 rounded-[8px] text-[12px] font-semibold cursor-pointer ${
                    reauthMode === 'password'
                      ? 'bg-white text-slate-900 shadow-2xs'
                      : 'text-slate-600'
                  }`}
                >
                  Password
                </button>
              </div>
            )}

            <form onSubmit={handleConfirmReauth} className="space-y-3">
              {modalError && (
                <p className="px-3 py-2 rounded-[10px] bg-rose-50 border border-rose-200 text-rose-700 text-[12px] font-medium">
                  {modalError}
                </p>
              )}

              {reauthMode === 'pin' ? (
                <div>
                  <label className="block text-[12px] font-medium text-slate-700 mb-1">
                    Current Security PIN ({currentPinTargetLength} digits)
                  </label>
                  <input
                    type="password"
                    inputMode="numeric"
                    maxLength={6}
                    value={reauthPin}
                    disabled={pinLockoutRemaining > 0}
                    onChange={(e) => setReauthPin(e.target.value.replace(/\D/g, ''))}
                    placeholder="Enter PIN"
                    className="w-full h-10 px-3 rounded-[10px] border border-slate-200 bg-slate-50 focus:bg-white focus:border-[#0E9AA7] text-[14px] tracking-widest outline-none"
                  />
                  {pinLockoutRemaining > 0 && (
                    <p className="text-[11.5px] text-rose-600 font-semibold mt-1">
                      Locked for {pinLockoutRemaining}s
                    </p>
                  )}
                </div>
              ) : (
                <div>
                  <label className="block text-[12px] font-medium text-slate-700 mb-1">
                    Current Password
                  </label>
                  <div className="relative">
                    <input
                      type={showReauthPassword ? 'text' : 'password'}
                      value={reauthPassword}
                      onChange={(e) => setReauthPassword(e.target.value)}
                      placeholder="Enter account password"
                      className="w-full h-10 pl-3 pr-10 rounded-[10px] border border-slate-200 bg-slate-50 focus:bg-white focus:border-[#0E9AA7] text-[13px] outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => setShowReauthPassword((v) => !v)}
                      aria-label={showReauthPassword ? 'Hide password' : 'Show password'}
                      className="absolute right-1 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg text-slate-500 flex items-center justify-center cursor-pointer"
                    >
                      {showReauthPassword ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  disabled={modalLoading}
                  onClick={() => {
                    pendingSensitiveActionRef.current = null;
                    setActiveModal(null);
                  }}
                  className="flex-1 h-10 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-slate-700 text-[13px] font-semibold cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={modalLoading || (reauthMode === 'pin' && pinLockoutRemaining > 0)}
                  className="flex-1 h-10 rounded-[10px] bg-[#04203F] hover:bg-[#0E9AA7] text-white text-[13px] font-semibold flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-60"
                >
                  {modalLoading && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" />}
                  <span>Verify &amp; Save</span>
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
