import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { arrayRemove, collection, doc, getDocs, updateDoc } from 'firebase/firestore';
import { db } from '../../lib/firebase';
import { AppVersionConfig, DEFAULT_DEMO_PRODUCT, UserProfile } from '../../types';
import {
  Bell,
  Briefcase,
  Calendar,
  Camera,
  CheckCheck,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  CreditCard,
  Edit3,
  FileText,
  Fingerprint,
  Gauge,
  HelpCircle,
  Key,
  Layers,
  LifeBuoy,
  Lock,
  LogOut,
  Mail,
  MapPin,
  MessageSquare,
  MessagesSquare,
  Package,
  Percent,
  Phone,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Sparkles,
  Star,
  User,
  UserCheck,
  Wallet,
  X,
} from 'lucide-react';
import { ResellerEditProfilePage } from './ResellerEditProfilePage';
import { AccountProfilePage } from './AccountProfilePage';
import { SupportSystem } from '../support/SupportSystem';
import { ResellerNoticeList } from '../notifications/ResellerNoticeList';
import { LiveChatWindow } from '../chat/LiveChatWindow';
import { CommissionSummary } from '../commission/CommissionSummary';
import { ProductReviewForm } from '../reviews/ProductReviewForm';
import { FeedbackForm } from '../feedback/FeedbackForm';
import { ResellerSettings } from '../settings/ResellerSettings';
import { SecurityFocusTarget } from '../settings/SecuritySection';
import { INSTALLED_BUILD_NUMBER, INSTALLED_VERSION } from '../settings/AppVersionSection';
import { AIMarketingModal } from '../marketing/AIMarketingModal';
import { SocialShareModal } from '../inventory/SocialShareModal';
import { triggerHaptic } from '../../lib/nativeFeedback';
import { PageHeader } from '../common/PageHeader';
import { formatResellerId } from '../../lib/resellerIdHelper';
import { getCurrentAppVersion } from '../../lib/versionService';
import { fetchPendingChangeRequests } from '../../lib/lockedFieldsService';

interface ResellerAccountHubProps {
  user: UserProfile;
  activeSubTab?: string;
  onNavigateTab: (tab: string) => void;
  onBackFromChat?: () => void;
  onLogout: () => void;
  unreadChatCount?: number;
  unreadNotificationsCount?: number;
  canAccessFullApp?: boolean;
  onOpenLockedModal?: (featureName?: string) => void;
}

type CategoryId =
  | 'account_profile'
  | 'business_tools'
  | 'notifications_notices'
  | 'security_login'
  | 'payout_settings'
  | 'app_preferences'
  | 'help_support'
  | 'privacy_data'
  | 'policies_info'
  | 'app_version'
  | 'account_actions';

type SettingsSectionId =
  | 'menu'
  | 'account'
  | 'payout'
  | 'changeRequests'
  | 'security'
  | 'notifications'
  | 'preferences'
  | 'version'
  | 'info'
  | 'support'
  | 'privacy';

type SubScreenId = 'commission' | 'notifications' | 'support' | 'reviews' | 'feedback';

type HubView =
  | { type: 'hub' }
  | { type: 'edit_profile'; parentCategoryId?: CategoryId | null }
  | { type: 'chat' }
  | { type: 'category'; categoryId: CategoryId }
  | {
      type: 'settings';
      section: SettingsSectionId;
      title: string;
      subtitle: string;
      parentCategoryId: CategoryId | null;
    }
  | {
      type: 'subscreen';
      screen: SubScreenId;
      title: string;
      subtitle: string;
      parentCategoryId: CategoryId | null;
    };

interface CategoryItemDef {
  id: string;
  categoryId: CategoryId;
  title: string;
  description: string;
  icon: React.ElementType;
  keywords: string[];
  badgeCount?: number;
  isLocked?: boolean;
  isDestructive?: boolean;
  onSelect: () => void;
}

interface HubCategoryDef {
  id: CategoryId;
  title: string;
  description: string;
  subtitleBn?: string;
  icon: React.ElementType;
  keywords: string[];
  badgeCount?: number;
  rightText?: string;
  isLocked?: boolean;
  mode: 'category_shell' | 'settings_direct';
  settingsSection?: SettingsSectionId;
  items: CategoryItemDef[];
}

const SETTINGS_SECTION_TITLES: Record<SettingsSectionId, { title: string; subtitle: string }> = {
  menu: { title: 'Settings & Preferences', subtitle: 'All account & app preferences' },
  account: { title: 'Verified Information', subtitle: 'Personal info, shop profile & locked fields' },
  payout: { title: 'Payout Settings', subtitle: 'Manage registered payout accounts' },
  changeRequests: { title: 'Change Requests', subtitle: 'Request changes to verified info & track status' },
  security: { title: 'Security & Login', subtitle: 'Password, PIN lock, devices & login history' },
  notifications: { title: 'Notification Settings', subtitle: 'Order alerts, sound & push preferences' },
  preferences: { title: 'App Preferences', subtitle: 'Theme, language and appearance' },
  version: { title: 'App & Version', subtitle: 'Updates, system build & changelog' },
  info: { title: 'Policies & Information', subtitle: 'Rules, terms & company information' },
  support: { title: 'Help & Support', subtitle: 'Call, WhatsApp, FAQs & quick help' },
  privacy: { title: 'Privacy & Data', subtitle: 'Privacy and personal data controls' },
};

function readCurrentScrollY(): number {
  if (typeof window === 'undefined') return 0;
  const rootEl = document.getElementById('root');
  if (rootEl && rootEl.scrollTop > 0) return rootEl.scrollTop;
  return window.scrollY || document.documentElement.scrollTop || 0;
}

function writeScrollY(y: number): void {
  if (typeof window === 'undefined') return;
  const rootEl = document.getElementById('root');
  if (rootEl) rootEl.scrollTop = y;
  try {
    window.scrollTo({ top: y, left: 0, behavior: 'instant' as ScrollBehavior });
  } catch {
    window.scrollTo(0, y);
  }
}

export const ResellerAccountHub: React.FC<ResellerAccountHubProps> = ({
  user,
  activeSubTab = 'more',
  onNavigateTab,
  onBackFromChat,
  onLogout,
  unreadChatCount = 0,
  unreadNotificationsCount = 0,
  canAccessFullApp = true,
  onOpenLockedModal,
}) => {
  const [view, setView] = useState<HubView>(() => {
    if (activeSubTab === 'chat' || activeSubTab === 'live_chat') return { type: 'chat' };
    if (activeSubTab === 'edit_profile') return { type: 'edit_profile' };
    if (activeSubTab === 'commission') {
      return {
        type: 'subscreen',
        screen: 'commission',
        title: 'Commission & Performance',
        subtitle: 'Earnings summary, stats & payout history',
        parentCategoryId: null,
      };
    }
    if (activeSubTab === 'notifications') {
      return {
        type: 'subscreen',
        screen: 'notifications',
        title: 'Notices & Broadcasts',
        subtitle: 'Platform updates & official announcements',
        parentCategoryId: null,
      };
    }
    if (activeSubTab === 'support') {
      return {
        type: 'subscreen',
        screen: 'support',
        title: 'Helpdesk & Support Tickets',
        subtitle: 'Raise issues or order inquiries',
        parentCategoryId: null,
      };
    }
    if (activeSubTab === 'reviews') {
      return {
        type: 'subscreen',
        screen: 'reviews',
        title: 'Product Reviews',
        subtitle: 'Rate accessories & share experience',
        parentCategoryId: null,
      };
    }
    if (activeSubTab === 'feedback') {
      return {
        type: 'subscreen',
        screen: 'feedback',
        title: 'Send App Feedback',
        subtitle: 'Suggest features or report app bugs',
        parentCategoryId: null,
      };
    }
    if (activeSubTab === 'profile') {
      return {
        type: 'settings',
        section: 'account',
        title: SETTINGS_SECTION_TITLES.account.title,
        subtitle: SETTINGS_SECTION_TITLES.account.subtitle,
        parentCategoryId: null,
      };
    }
    if (activeSubTab === 'security') {
      return {
        type: 'settings',
        section: 'security',
        title: SETTINGS_SECTION_TITLES.security.title,
        subtitle: SETTINGS_SECTION_TITLES.security.subtitle,
        parentCategoryId: null,
      };
    }
    if (activeSubTab === 'settings') {
      return {
        type: 'settings',
        section: 'menu',
        title: SETTINGS_SECTION_TITLES.menu.title,
        subtitle: SETTINGS_SECTION_TITLES.menu.subtitle,
        parentCategoryId: null,
      };
    }
    return { type: 'hub' };
  });

  const [settingsInnerSection, setSettingsInnerSection] = useState<string>('menu');
  const [searchQuery, setSearchQuery] = useState('');
  const [copiedId, setCopiedId] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [accountProfileFocusTarget, setAccountProfileFocusTarget] = useState<
    | 'overview'
    | 'view_profile'
    | 'photo'
    | 'full_name'
    | 'email_verify'
    | 'phone'
    | 'address'
    | 'account_info'
    | null
  >(null);
  const [securityFocusTarget, setSecurityFocusTarget] = useState<SecurityFocusTarget | null>(null);

  // Live metadata (real version & pending change request count)
  const [appVersionInfo, setAppVersionInfo] = useState<AppVersionConfig | null>(null);
  const [loadingVersion, setLoadingVersion] = useState(true);
  const [pendingChangeCount, setPendingChangeCount] = useState(0);

  // Marketing modals
  const [showAiModal, setShowAiModal] = useState(false);
  const [showPosterModal, setShowPosterModal] = useState(false);
  const [selectedPosterProduct, setSelectedPosterProduct] = useState<any>(null);
  const [allProductsList, setAllProductsList] = useState<any[]>([]);

  // Hub scroll restoration
  const hubScrollRef = useRef<number>(0);
  const prevViewTypeRef = useRef<HubView['type']>(view.type);

  const saveHubScrollIfNeeded = useCallback(() => {
    if (prevViewTypeRef.current === 'hub') {
      hubScrollRef.current = readCurrentScrollY();
    }
  }, []);

  const navigateToView = useCallback(
    (nextView: HubView) => {
      saveHubScrollIfNeeded();
      if (nextView.type === 'settings') {
        setSettingsInnerSection(nextView.section);
      }
      setView(nextView);
    },
    [saveHubScrollIfNeeded]
  );

  // Restore scroll position when returning to hub; scroll to top when entering a page
  useLayoutEffect(() => {
    const prevType = prevViewTypeRef.current;
    prevViewTypeRef.current = view.type;

    if (view.type === 'hub' && prevType !== 'hub') {
      const targetY = hubScrollRef.current || 0;
      writeScrollY(targetY);
      const rafId = requestAnimationFrame(() => writeScrollY(targetY));
      return () => cancelAnimationFrame(rafId);
    }

    if (view.type !== 'hub' && view.type !== 'chat' && view.type !== 'edit_profile') {
      writeScrollY(0);
    }
  }, [view]);

  // Sync external activeSubTab changes
  useEffect(() => {
    if (!activeSubTab || activeSubTab === 'more') {
      setView({ type: 'hub' });
      return;
    }
    if (activeSubTab === 'chat' || activeSubTab === 'live_chat') {
      setView({ type: 'chat' });
    } else if (activeSubTab === 'edit_profile') {
      setView({ type: 'edit_profile' });
    } else if (activeSubTab === 'commission') {
      setView({
        type: 'subscreen',
        screen: 'commission',
        title: 'Commission & Performance',
        subtitle: 'Earnings summary, stats & payout history',
        parentCategoryId: null,
      });
    } else if (activeSubTab === 'notifications') {
      setView({
        type: 'subscreen',
        screen: 'notifications',
        title: 'Notices & Broadcasts',
        subtitle: 'Platform updates & official announcements',
        parentCategoryId: null,
      });
    } else if (activeSubTab === 'support') {
      setView({
        type: 'subscreen',
        screen: 'support',
        title: 'Helpdesk & Support Tickets',
        subtitle: 'Raise issues or order inquiries',
        parentCategoryId: null,
      });
    } else if (activeSubTab === 'reviews') {
      setView({
        type: 'subscreen',
        screen: 'reviews',
        title: 'Product Reviews',
        subtitle: 'Rate accessories & share experience',
        parentCategoryId: null,
      });
    } else if (activeSubTab === 'feedback') {
      setView({
        type: 'subscreen',
        screen: 'feedback',
        title: 'Send App Feedback',
        subtitle: 'Suggest features or report app bugs',
        parentCategoryId: null,
      });
    } else if (activeSubTab === 'profile') {
      setSettingsInnerSection('account');
      setView({
        type: 'settings',
        section: 'account',
        title: SETTINGS_SECTION_TITLES.account.title,
        subtitle: SETTINGS_SECTION_TITLES.account.subtitle,
        parentCategoryId: null,
      });
    } else if (activeSubTab === 'security') {
      setSettingsInnerSection('security');
      setView({
        type: 'settings',
        section: 'security',
        title: SETTINGS_SECTION_TITLES.security.title,
        subtitle: SETTINGS_SECTION_TITLES.security.subtitle,
        parentCategoryId: null,
      });
    } else if (activeSubTab === 'settings') {
      setSettingsInnerSection('menu');
      setView({
        type: 'settings',
        section: 'menu',
        title: SETTINGS_SECTION_TITLES.menu.title,
        subtitle: SETTINGS_SECTION_TITLES.menu.subtitle,
        parentCategoryId: null,
      });
    }
  }, [activeSubTab]);

  // Load products for Marketing modals, real App Version, and pending change requests
  useEffect(() => {
    let active = true;

    getDocs(collection(db, 'products'))
      .then((snap) => {
        if (!active) return;
        const prods = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setAllProductsList(prods);
        if (prods.length > 0) {
          setSelectedPosterProduct(prods[0]);
        }
      })
      .catch((err) => {
        console.error('Error fetching products for AI modal:', err);
      });

    getCurrentAppVersion()
      .then((vConfig) => {
        if (active) setAppVersionInfo(vConfig);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoadingVersion(false);
      });

    if (user?.uid) {
      fetchPendingChangeRequests(user.uid)
        .then((items) => {
          if (active) setPendingChangeCount(items.length);
        })
        .catch(() => {});
    }

    return () => {
      active = false;
    };
  }, [user?.uid]);

  // Fullscreen overlay signal & Android hardware Back integration for Hub category/subscreen/modal layers
  // (LiveChatWindow & ResellerEditProfilePage manage their own sky_fullscreen_overlay lifecycle.)
  const isHubManagedFullscreen =
    view.type === 'category' ||
    view.type === 'settings' ||
    view.type === 'subscreen' ||
    showLogoutConfirm;

  useEffect(() => {
    if (view.type === 'chat' || view.type === 'edit_profile') return;
    window.dispatchEvent(
      new CustomEvent('sky_fullscreen_overlay', { detail: { open: isHubManagedFullscreen } })
    );
    return () => {
      window.dispatchEvent(new CustomEvent('sky_fullscreen_overlay', { detail: { open: false } }));
    };
  }, [isHubManagedFullscreen, view.type]);

  const handleBackNavigation = useCallback(() => {
    if (showLogoutConfirm) {
      setShowLogoutConfirm(false);
      return;
    }
    if (showPosterModal) {
      setShowPosterModal(false);
      return;
    }
    if (showAiModal) {
      setShowAiModal(false);
      return;
    }
    if (view.type === 'settings' || view.type === 'subscreen') {
      if (view.parentCategoryId) {
        setView({ type: 'category', categoryId: view.parentCategoryId });
      } else {
        setView({ type: 'hub' });
        if (activeSubTab !== 'more') {
          onNavigateTab('more');
        }
      }
      return;
    }
    if (view.type === 'category') {
      setView({ type: 'hub' });
      return;
    }
    if (view.type === 'edit_profile') {
      if (view.parentCategoryId) {
        setView({ type: 'category', categoryId: view.parentCategoryId });
      } else {
        setView({ type: 'hub' });
      }
    }
  }, [activeSubTab, onNavigateTab, showAiModal, showLogoutConfirm, showPosterModal, view]);

  useEffect(() => {
    if (view.type === 'chat' || view.type === 'edit_profile') return;
    const onHwBack = () => {
      handleBackNavigation();
    };
    window.addEventListener('sky_fullscreen_overlay_back', onHwBack);
    return () => window.removeEventListener('sky_fullscreen_overlay_back', onHwBack);
  }, [handleBackNavigation, view.type]);

  const isPendingUser = !canAccessFullApp || user.status === 'pending';
  const shortResellerId = formatResellerId(user);

  const handleCopyId = async () => {
    if (!shortResellerId) return;
    triggerHaptic('light');
    try {
      await navigator.clipboard?.writeText(shortResellerId);
      setCopiedId(true);
      window.setTimeout(() => setCopiedId(false), 1800);
    } catch {
      // Ignore clipboard failures
    }
  };

  const openLockedOrRun = useCallback(
    (locked: boolean, featureName: string, action: () => void) => {
      triggerHaptic('light');
      if (locked) {
        onOpenLockedModal?.(featureName);
        return;
      }
      action();
    },
    [onOpenLockedModal]
  );

  const openPosterStudio = useCallback(() => {
    let prodToUse = selectedPosterProduct;
    if (!prodToUse && allProductsList.length > 0) {
      prodToUse = allProductsList[0];
      setSelectedPosterProduct(prodToUse);
    }
    if (!prodToUse) {
      prodToUse = DEFAULT_DEMO_PRODUCT;
      setSelectedPosterProduct(prodToUse);
    }
    setShowPosterModal(true);
  }, [allProductsList, selectedPosterProduct]);

  const handleConfirmLogout = async () => {
    if (isLoggingOut) return;
    setIsLoggingOut(true);
    triggerHaptic('medium');
    try {
      const storedFcm = localStorage.getItem('fcm_token');
      if (storedFcm && user.uid) {
        await updateDoc(doc(db, 'users', user.uid), {
          fcmTokens: arrayRemove(storedFcm),
        });
      }
    } catch {
      // Ignore cleanup errors
    }
    try {
      const draftKeys = [
        'reseller_recent_searches',
        'product_filter_state',
        'cart_temp_draft',
        'custom_order_draft',
        'payout_form_draft',
        'category_cache',
      ];
      draftKeys.forEach((k) => localStorage.removeItem(k));
      sessionStorage.clear();
    } catch {
      // Ignore storage errors
    }
    setShowLogoutConfirm(false);
    setIsLoggingOut(false);
    onLogout();
  };

  const hasUpdateAvailable =
    Boolean(appVersionInfo?.version) && appVersionInfo?.version !== INSTALLED_VERSION;

  const categories: HubCategoryDef[] = useMemo(() => {
    return [
      {
        id: 'account_profile',
        title: 'Account & Profile',
        description: 'Personal details, contact, addresses & account info',
        subtitleBn: 'ব্যক্তিগত তথ্য, যোগাযোগ, ঠিকানা ও অ্যাকাউন্ট তথ্য',
        icon: User,
        keywords: [
          'account',
          'profile',
          'personal info',
          'personal information',
          'view profile',
          'edit profile',
          'full name',
          'name',
          'photo',
          'avatar',
          'picture',
          'logo',
          'banner',
          'contact',
          'email',
          'verify email',
          'email verified',
          'otp',
          'phone',
          'mobile',
          'whatsapp',
          'address',
          'shop address',
          'division',
          'district',
          'upazila',
          'thana',
          'union',
          'postal',
          'map',
          'coordinates',
          'reseller id',
          'status',
          'pending',
          'approved',
          'suspended',
          'rejected',
          'registration date',
          'completion',
          'verified info',
          'change request',
          'nid',
          'birth certificate',
          'dob',
          'shop name',
          'payout',
          'locked',
          'প্রোফাইল',
          'ব্যক্তিগত তথ্য',
          'নাম',
          'পূর্ণ নাম',
          'ছবি',
          'লোগো',
          'ব্যানার',
          'যোগাযোগ',
          'ইমেইল',
          'ভেরিফাই',
          'ওটিপি',
          'ফোন',
          'মোবাইল',
          'নম্বর',
          'ঠিকানা',
          'বিভাগ',
          'জেলা',
          'উপজেলা',
          'থানা',
          'ইউনিয়ন',
          'ম্যাপ',
          'রিসেলার আইডি',
          'আইডি',
          'স্ট্যাটাস',
          'নিবন্ধন',
          'সম্পূর্ণতা',
          'ভেরিফাইড',
          'পরিবর্তন',
          'আবেদন',
          'এনআইডি',
          'জন্ম নিবন্ধন',
          'জন্ম তারিখ',
          'দোকানের নাম',
          'পেআউট',
        ],
        badgeCount: pendingChangeCount > 0 ? pendingChangeCount : undefined,
        mode: 'category_shell',
        items: [
          {
            id: 'personal_information',
            categoryId: 'account_profile',
            title: 'Personal Information',
            description: 'Read-only profile summary, masked IDs & documents',
            icon: User,
            keywords: ['personal info', 'view profile', 'summary', 'masked', 'nid', 'documents', 'ব্যক্তিগত তথ্য', 'প্রোফাইল দেখুন'],
            onSelect: () => {
              triggerHaptic('light');
              setAccountProfileFocusTarget('view_profile');
              navigateToView({ type: 'category', categoryId: 'account_profile' });
            },
          },
          {
            id: 'edit_profile',
            categoryId: 'account_profile',
            title: 'Edit Profile',
            description: 'Update name, photo, banner, address & social links',
            icon: Edit3,
            keywords: ['edit profile', 'photo', 'avatar', 'cover', 'banner', 'address', 'bio', 'facebook', 'প্রোফাইল এডিট'],
            onSelect: () => {
              triggerHaptic('light');
              navigateToView({ type: 'edit_profile', parentCategoryId: 'account_profile' });
            },
          },
          {
            id: 'change_profile_photo',
            categoryId: 'account_profile',
            title: 'Change Profile Photo',
            description: 'Take or upload a compressed profile photo',
            icon: Camera,
            keywords: ['photo', 'avatar', 'picture', 'camera', 'gallery', 'upload', 'ছবি', 'প্রোফাইল ছবি'],
            onSelect: () => {
              triggerHaptic('light');
              setAccountProfileFocusTarget('photo');
              navigateToView({ type: 'category', categoryId: 'account_profile' });
            },
          },
          {
            id: 'change_full_name',
            categoryId: 'account_profile',
            title: 'Change Full Name',
            description: 'Update your account display name',
            icon: FileText,
            keywords: ['full name', 'name', 'rename', 'নাম', 'পূর্ণ নাম'],
            onSelect: () => {
              triggerHaptic('light');
              setAccountProfileFocusTarget('full_name');
              navigateToView({ type: 'category', categoryId: 'account_profile' });
            },
          },
          {
            id: 'email_verification',
            categoryId: 'account_profile',
            title: 'Email Address & Verification',
            description: 'View registered email, OTP verification & change requests',
            icon: Mail,
            keywords: ['email', 'verify', 'otp', 'verified', 'change email', 'ইমেইল', 'ভেরিফাই'],
            onSelect: () => {
              triggerHaptic('light');
              setAccountProfileFocusTarget('email_verify');
              navigateToView({ type: 'category', categoryId: 'account_profile' });
            },
          },
          {
            id: 'change_phone_number',
            categoryId: 'account_profile',
            title: 'Phone Number',
            description: 'Verify and update your BD mobile number (01XXXXXXXXX)',
            icon: Phone,
            keywords: ['phone', 'mobile', 'number', 'bd phone', 'whatsapp', 'ফোন', 'মোবাইল', 'নম্বর'],
            onSelect: () => {
              triggerHaptic('light');
              setAccountProfileFocusTarget('phone');
              navigateToView({ type: 'category', categoryId: 'account_profile' });
            },
          },
          {
            id: 'address_management',
            categoryId: 'account_profile',
            title: 'Address Management',
            description: 'Saved shop & pickup addresses with geo selectors & maps',
            icon: MapPin,
            keywords: ['address', 'division', 'district', 'upazila', 'union', 'postal', 'map', 'default address', 'ঠিকানা', 'বিভাগ', 'জেলা', 'উপজেলা', 'ম্যাপ'],
            onSelect: () => {
              triggerHaptic('light');
              setAccountProfileFocusTarget('address');
              navigateToView({ type: 'category', categoryId: 'account_profile' });
            },
          },
          {
            id: 'account_info_status',
            categoryId: 'account_profile',
            title: 'Reseller ID, Status & Completion',
            description: 'Copy short ID, status guide, registration date & checklist',
            icon: Calendar,
            keywords: ['reseller id', 'id', 'status', 'registration', 'joined', 'completion', 'missing', 'রিসেলার আইডি', 'স্ট্যাটাস', 'নিবন্ধন', 'সম্পূর্ণতা'],
            onSelect: () => {
              triggerHaptic('light');
              setAccountProfileFocusTarget('account_info');
              navigateToView({ type: 'category', categoryId: 'account_profile' });
            },
          },
          {
            id: 'verified_info',
            categoryId: 'account_profile',
            title: 'Verified Information',
            description: 'View shop name, email, NID & registered details',
            icon: CheckCircle2,
            keywords: ['verified', 'nid', 'birth certificate', 'dob', 'shop name', 'locked', 'ভেরিফাইড'],
            onSelect: () => {
              triggerHaptic('light');
              navigateToView({
                type: 'settings',
                section: 'account',
                title: 'Verified Information',
                subtitle: 'Registered profile & protected account details',
                parentCategoryId: 'account_profile',
              });
            },
          },
          {
            id: 'change_requests',
            categoryId: 'account_profile',
            title: 'Change Requests',
            description: 'Request updates to locked info & track status',
            icon: ShieldAlert,
            badgeCount: pendingChangeCount > 0 ? pendingChangeCount : undefined,
            keywords: ['change request', 'request', 'locked', 'update', 'super admin', 'পরিবর্তন', 'আবেদন'],
            onSelect: () => {
              triggerHaptic('light');
              navigateToView({
                type: 'settings',
                section: 'changeRequests',
                title: 'Change Requests',
                subtitle: 'Request updates to verified info & track status',
                parentCategoryId: 'account_profile',
              });
            },
          },
        ],
      },
      {
        id: 'business_tools',
        title: 'Business & Tools',
        description: 'Wallet, orders, commission and marketing tools',
        subtitleBn: 'ওয়ালেট, অর্ডার ও মার্কেটিং টুলস',
        icon: Briefcase,
        keywords: ['business', 'wallet', 'orders', 'parcel', 'commission', 'sales', 'poster', 'marketing', 'ওয়ালেট', 'অর্ডার', 'কমিশন'],
        mode: 'category_shell',
        items: [
          {
            id: 'my_wallet',
            categoryId: 'business_tools',
            title: 'My Wallet',
            description: canAccessFullApp ? 'Balance, earnings & payout withdrawals' : 'Unlocks after account approval',
            icon: Wallet,
            isLocked: !canAccessFullApp,
            keywords: ['wallet', 'balance', 'withdraw', 'earnings', 'money', 'ওয়ালেট', 'টাকা'],
            onSelect: () => openLockedOrRun(!canAccessFullApp, 'My Wallet', () => onNavigateTab('wallet')),
          },
          {
            id: 'orders_tracking',
            categoryId: 'business_tools',
            title: 'Orders & Track Parcels',
            description: canAccessFullApp ? 'View active deliveries & parcel history' : 'Unlocks after account approval',
            icon: Package,
            isLocked: !canAccessFullApp,
            keywords: ['orders', 'parcel', 'track', 'courier', 'delivery', 'অর্ডার', 'পার্সেল'],
            onSelect: () => openLockedOrRun(!canAccessFullApp, 'Orders Tracking', () => onNavigateTab('orders')),
          },
          {
            id: 'commission_summary',
            categoryId: 'business_tools',
            title: 'Commission & Performance',
            description: canAccessFullApp ? 'Tier rates, earnings breakdown & stats' : 'Unlocks after account approval',
            icon: Percent,
            isLocked: !canAccessFullApp,
            keywords: ['commission', 'performance', 'tier', 'earnings', 'কমিশন'],
            onSelect: () =>
              openLockedOrRun(!canAccessFullApp, 'Commission & Performance', () =>
                navigateToView({
                  type: 'subscreen',
                  screen: 'commission',
                  title: 'Commission & Performance',
                  subtitle: 'Tier rates, earnings breakdown & stats',
                  parentCategoryId: 'business_tools',
                })
              ),
          },
          {
            id: 'sales_copywriter',
            categoryId: 'business_tools',
            title: 'Sales Copywriter',
            description: 'Bengali & English captions for Facebook & TikTok',
            icon: Sparkles,
            keywords: ['sales copywriter', 'caption', 'post', 'facebook', 'tiktok', 'ক্যাপশন'],
            onSelect: () => {
              triggerHaptic('light');
              setShowAiModal(true);
            },
          },
          {
            id: 'poster_studio',
            categoryId: 'business_tools',
            title: 'Poster Studio',
            description: 'Create branded watermarked product posters',
            icon: Layers,
            keywords: ['poster', 'studio', 'image', 'watermark', 'share', 'পোস্টার'],
            onSelect: () => {
              triggerHaptic('light');
              openPosterStudio();
            },
          },
        ],
      },
      {
        id: 'notifications_notices',
        title: 'Notifications & Notices',
        description: 'Alerts, notices and broadcasts',
        subtitleBn: 'নোটিশ ও নোটিফিকেশন সেটিংস',
        icon: Bell,
        keywords: ['notifications', 'notices', 'broadcast', 'alerts', 'push', 'sound', 'নোটিশ'],
        badgeCount: unreadNotificationsCount > 0 ? unreadNotificationsCount : undefined,
        mode: 'category_shell',
        items: [
          {
            id: 'notices_broadcasts',
            categoryId: 'notifications_notices',
            title: 'Notices & Broadcasts',
            description: 'Official announcements from management',
            icon: Bell,
            badgeCount: unreadNotificationsCount > 0 ? unreadNotificationsCount : undefined,
            keywords: ['notices', 'broadcasts', 'announcements', 'news', 'নোটিশ'],
            onSelect: () => {
              triggerHaptic('light');
              navigateToView({
                type: 'subscreen',
                screen: 'notifications',
                title: 'Notices & Broadcasts',
                subtitle: 'Official announcements & platform updates',
                parentCategoryId: 'notifications_notices',
              });
            },
          },
          {
            id: 'notification_settings',
            categoryId: 'notifications_notices',
            title: 'Notification Settings',
            description: 'Order alerts, sound, vibration & push preferences',
            icon: SlidersHorizontal,
            isLocked: isPendingUser,
            keywords: ['notification settings', 'push', 'sound', 'vibration', 'quiet hours'],
            onSelect: () =>
              openLockedOrRun(isPendingUser, 'Notification Settings', () =>
                navigateToView({
                  type: 'settings',
                  section: 'notifications',
                  title: SETTINGS_SECTION_TITLES.notifications.title,
                  subtitle: SETTINGS_SECTION_TITLES.notifications.subtitle,
                  parentCategoryId: 'notifications_notices',
                })
              ),
          },
        ],
      },
      {
        id: 'security_login',
        title: 'Security & Login',
        description: 'Password, devices, app lock & login alerts',
        subtitleBn: 'পাসওয়ার্ড, পিন লক, ডিভাইস ও লগইন সতর্কতা',
        icon: Shield,
        keywords: [
          'security',
          'password',
          'change password',
          'forgot password',
          'strength checker',
          'pin',
          'app lock',
          'lock delay',
          'biometric',
          'fingerprint',
          'two factor',
          '2fa',
          'devices',
          'active devices',
          'trusted devices',
          'login history',
          'login alert',
          'new device alert',
          'session timeout',
          'passcode',
          'পাসওয়ার্ড',
          'সিকিউরিটি',
          'পিন',
          'ডিভাইস',
          'লগইন হিস্টোরি',
          'সেশন টাইমআউট',
        ],
        mode: 'settings_direct',
        settingsSection: 'security',
        items: [
          {
            id: 'security_change_password',
            categoryId: 'security_login',
            title: 'Change & Reset Password',
            description: 'Update password, forgot password link & strength checker',
            icon: Key,
            keywords: ['password', 'change password', 'forgot password', 'reset', 'পাসওয়ার্ড'],
            onSelect: () => {
              triggerHaptic('light');
              setSecurityFocusTarget('password');
              navigateToView({
                type: 'settings',
                section: 'security',
                title: SETTINGS_SECTION_TITLES.security.title,
                subtitle: SETTINGS_SECTION_TITLES.security.subtitle,
                parentCategoryId: null,
              });
            },
          },
          {
            id: 'security_strength_checker',
            categoryId: 'security_login',
            title: 'Password Strength Checker',
            description: 'Test password strength locally without saving',
            icon: Gauge,
            keywords: ['strength', 'password strength', 'checker', 'test password'],
            onSelect: () => {
              triggerHaptic('light');
              setSecurityFocusTarget('strength_checker');
              navigateToView({
                type: 'settings',
                section: 'security',
                title: SETTINGS_SECTION_TITLES.security.title,
                subtitle: SETTINGS_SECTION_TITLES.security.subtitle,
                parentCategoryId: null,
              });
            },
          },
          {
            id: 'security_login_history',
            categoryId: 'security_login',
            title: 'Login History & Activity',
            description: 'Recent sign-ins in the last hour',
            icon: Clock,
            keywords: ['login history', 'recent login', 'activity', 'sign in', 'লগইন হিস্টোরি'],
            onSelect: () => {
              triggerHaptic('light');
              setSecurityFocusTarget('login_history');
              navigateToView({
                type: 'settings',
                section: 'security',
                title: SETTINGS_SECTION_TITLES.security.title,
                subtitle: SETTINGS_SECTION_TITLES.security.subtitle,
                parentCategoryId: null,
              });
            },
          },
          {
            id: 'security_active_devices',
            categoryId: 'security_login',
            title: 'Active & Trusted Devices',
            description: 'Manage signed-in devices, trust status & remote logout',
            icon: Smartphone,
            keywords: ['active devices', 'trusted devices', 'device management', 'log out device', 'sign out all', 'ডিভাইস'],
            onSelect: () => {
              triggerHaptic('light');
              setSecurityFocusTarget('active_devices');
              navigateToView({
                type: 'settings',
                section: 'security',
                title: SETTINGS_SECTION_TITLES.security.title,
                subtitle: SETTINGS_SECTION_TITLES.security.subtitle,
                parentCategoryId: null,
              });
            },
          },
          {
            id: 'security_app_lock',
            categoryId: 'security_login',
            title: 'App Lock, Biometrics & 2FA',
            description: 'Security PIN, lock delay, biometric & 2FA status',
            icon: Fingerprint,
            keywords: ['app lock', 'pin', 'passcode', 'lock delay', 'biometric', '2fa', 'two factor', 'পিন লক'],
            onSelect: () => {
              triggerHaptic('light');
              setSecurityFocusTarget('app_lock');
              navigateToView({
                type: 'settings',
                section: 'security',
                title: SETTINGS_SECTION_TITLES.security.title,
                subtitle: SETTINGS_SECTION_TITLES.security.subtitle,
                parentCategoryId: null,
              });
            },
          },
          {
            id: 'security_alerts_timeout',
            categoryId: 'security_login',
            title: 'Login Alerts & Session Timeout',
            description: 'New-device alerts, channels & inactivity auto-lock',
            icon: UserCheck,
            keywords: ['login alert', 'new device alert', 'session timeout', 'inactivity', 'auto lock', 'সেশন টাইমআউট'],
            onSelect: () => {
              triggerHaptic('light');
              setSecurityFocusTarget('login_alerts');
              navigateToView({
                type: 'settings',
                section: 'security',
                title: SETTINGS_SECTION_TITLES.security.title,
                subtitle: SETTINGS_SECTION_TITLES.security.subtitle,
                parentCategoryId: null,
              });
            },
          },
        ],
      },
      {
        id: 'payout_settings',
        title: 'Payout Settings',
        description: 'Manage registered payout accounts',
        subtitleBn: 'বিকাশ, নগদ ও ব্যাংক অ্যাকাউন্ট',
        icon: CreditCard,
        keywords: ['payout', 'bkash', 'nagad', 'rocket', 'upay', 'bank', 'withdraw', 'বিকাশ', 'নগদ', 'ব্যাংক'],
        isLocked: isPendingUser,
        mode: 'settings_direct',
        settingsSection: 'payout',
        items: [
          {
            id: 'payout_accounts',
            categoryId: 'payout_settings',
            title: 'Registered Payout Accounts',
            description: 'View bKash, Nagad, Rocket & Bank accounts',
            icon: CreditCard,
            isLocked: isPendingUser,
            keywords: ['payout', 'bkash', 'nagad', 'bank'],
            onSelect: () =>
              openLockedOrRun(isPendingUser, 'Payout Settings', () =>
                navigateToView({
                  type: 'settings',
                  section: 'payout',
                  title: SETTINGS_SECTION_TITLES.payout.title,
                  subtitle: SETTINGS_SECTION_TITLES.payout.subtitle,
                  parentCategoryId: null,
                })
              ),
          },
        ],
      },
      {
        id: 'app_preferences',
        title: 'App Preferences',
        description: 'Theme, language and appearance',
        subtitleBn: 'ভাষা, ডিসপ্লে ও অ্যাপিয়ারেন্স',
        icon: SlidersHorizontal,
        keywords: ['preferences', 'theme', 'language', 'density', 'motion', 'cache', 'থিম', 'ভাষা'],
        isLocked: isPendingUser,
        mode: 'settings_direct',
        settingsSection: 'preferences',
        items: [
          {
            id: 'app_prefs_item',
            categoryId: 'app_preferences',
            title: 'Display, Language & Cache',
            description: 'Density, start screen, reduce motion & reset defaults',
            icon: SlidersHorizontal,
            isLocked: isPendingUser,
            keywords: ['density', 'compact', 'language', 'bangla', 'english', 'cache'],
            onSelect: () =>
              openLockedOrRun(isPendingUser, 'App Preferences', () =>
                navigateToView({
                  type: 'settings',
                  section: 'preferences',
                  title: SETTINGS_SECTION_TITLES.preferences.title,
                  subtitle: SETTINGS_SECTION_TITLES.preferences.subtitle,
                  parentCategoryId: null,
                })
              ),
          },
        ],
      },
      {
        id: 'help_support',
        title: 'Help & Support',
        description: 'Live chat, tickets, reviews and feedback',
        subtitleBn: 'লাইভ চ্যাট, সাপোর্ট টিকেট ও রিভিউ',
        icon: LifeBuoy,
        keywords: ['help', 'support', 'chat', 'live chat', 'ticket', 'review', 'feedback', 'faq', 'চ্যাট', 'সাপোর্ট'],
        badgeCount: unreadChatCount > 0 ? unreadChatCount : undefined,
        mode: 'category_shell',
        items: [
          {
            id: 'live_chat_admin',
            categoryId: 'help_support',
            title: 'Live Chat with Admin',
            description: canAccessFullApp ? 'Instant support & query resolution' : 'Unlocks after account approval',
            icon: MessagesSquare,
            badgeCount: unreadChatCount > 0 ? unreadChatCount : undefined,
            isLocked: !canAccessFullApp,
            keywords: ['live chat', 'admin', 'support chat', 'message', 'লাইভ চ্যাট'],
            onSelect: () => openLockedOrRun(!canAccessFullApp, 'Live Chat Support', () => onNavigateTab('chat')),
          },
          {
            id: 'helpdesk_tickets',
            categoryId: 'help_support',
            title: 'Helpdesk & Support Tickets',
            description: canAccessFullApp ? 'Raise issues or order inquiries' : 'Unlocks after account approval',
            icon: LifeBuoy,
            isLocked: !canAccessFullApp,
            keywords: ['ticket', 'helpdesk', 'complaint', 'issue', 'টিকেট'],
            onSelect: () =>
              openLockedOrRun(!canAccessFullApp, 'Support Tickets', () =>
                navigateToView({
                  type: 'subscreen',
                  screen: 'support',
                  title: 'Helpdesk & Support Tickets',
                  subtitle: 'Raise issues or track open tickets',
                  parentCategoryId: 'help_support',
                })
              ),
          },
          {
            id: 'product_reviews',
            categoryId: 'help_support',
            title: 'Product Reviews',
            description: canAccessFullApp ? 'Rate products & share reseller feedback' : 'Unlocks after account approval',
            icon: Star,
            isLocked: !canAccessFullApp,
            keywords: ['reviews', 'rating', 'star', 'product', 'রিভিউ'],
            onSelect: () =>
              openLockedOrRun(!canAccessFullApp, 'Product Reviews', () =>
                navigateToView({
                  type: 'subscreen',
                  screen: 'reviews',
                  title: 'Product Reviews',
                  subtitle: 'Rate accessories & share experience',
                  parentCategoryId: 'help_support',
                })
              ),
          },
          {
            id: 'app_feedback',
            categoryId: 'help_support',
            title: 'Send App Feedback',
            description: 'Suggest features or report app bugs',
            icon: MessageSquare,
            keywords: ['feedback', 'bug', 'suggest', 'feature', 'মতামত'],
            onSelect: () => {
              triggerHaptic('light');
              navigateToView({
                type: 'subscreen',
                screen: 'feedback',
                title: 'Send App Feedback',
                subtitle: 'Suggest improvements or report an issue',
                parentCategoryId: 'help_support',
              });
            },
          },
          {
            id: 'quick_help_contacts',
            categoryId: 'help_support',
            title: 'FAQs & Direct Contacts',
            description: 'Call support, WhatsApp & common questions',
            icon: HelpCircle,
            keywords: ['faq', 'call', 'whatsapp', 'phone', 'contact', 'হোয়াটসঅ্যাপ'],
            onSelect: () => {
              triggerHaptic('light');
              navigateToView({
                type: 'settings',
                section: 'support',
                title: SETTINGS_SECTION_TITLES.support.title,
                subtitle: SETTINGS_SECTION_TITLES.support.subtitle,
                parentCategoryId: 'help_support',
              });
            },
          },
        ],
      },
      {
        id: 'privacy_data',
        title: 'Privacy & Data',
        description: 'Privacy and personal data controls',
        subtitleBn: 'ডেটা ও প্রাইভেসি নিয়ন্ত্রণ',
        icon: ShieldCheck,
        keywords: ['privacy', 'data', 'deactivate', 'delete account', 'export', 'প্রাইভেসি'],
        isLocked: isPendingUser,
        mode: 'settings_direct',
        settingsSection: 'privacy',
        items: [
          {
            id: 'privacy_controls',
            categoryId: 'privacy_data',
            title: 'Data Controls & Account Requests',
            description: 'Data usage, deactivation & account deletion requests',
            icon: ShieldCheck,
            isLocked: isPendingUser,
            keywords: ['privacy', 'deactivate', 'delete', 'data'],
            onSelect: () =>
              openLockedOrRun(isPendingUser, 'Privacy & Data', () =>
                navigateToView({
                  type: 'settings',
                  section: 'privacy',
                  title: SETTINGS_SECTION_TITLES.privacy.title,
                  subtitle: SETTINGS_SECTION_TITLES.privacy.subtitle,
                  parentCategoryId: null,
                })
              ),
          },
        ],
      },
      {
        id: 'policies_info',
        title: 'Policies & Information',
        description: 'Rules and company information',
        subtitleBn: 'নীতিমালা, শর্তাবলি ও রিসেলার নিয়ম',
        icon: FileText,
        keywords: ['policies', 'terms', 'privacy policy', 'reseller rules', 'payout policy', 'commission policy', 'faq', 'নিয়মাবলি'],
        isLocked: isPendingUser,
        mode: 'settings_direct',
        settingsSection: 'info',
        items: [
          {
            id: 'policies_list',
            categoryId: 'policies_info',
            title: 'Terms, Rules & Policies',
            description: 'Terms of service, reseller rules, payout & commission policies',
            icon: FileText,
            isLocked: isPendingUser,
            keywords: ['terms', 'rules', 'policy', 'company'],
            onSelect: () =>
              openLockedOrRun(isPendingUser, 'Account Policies & FAQ', () =>
                navigateToView({
                  type: 'settings',
                  section: 'info',
                  title: SETTINGS_SECTION_TITLES.info.title,
                  subtitle: SETTINGS_SECTION_TITLES.info.subtitle,
                  parentCategoryId: null,
                })
              ),
          },
        ],
      },
      {
        id: 'app_version',
        title: 'App & Version',
        description: hasUpdateAvailable
          ? `v${INSTALLED_VERSION} (Build ${INSTALLED_BUILD_NUMBER}) • Update v${appVersionInfo?.version} available`
          : `v${INSTALLED_VERSION} (Build ${INSTALLED_BUILD_NUMBER}) • Updates & changelog`,
        subtitleBn: 'অ্যাপ ভার্সন ও আপডেট তথ্য',
        icon: Smartphone,
        rightText: loadingVersion ? undefined : `v${INSTALLED_VERSION}`,
        keywords: ['app', 'version', 'update', 'changelog', 'whats new', 'build', 'tour', 'ভার্সন', 'আপডেট'],
        mode: 'settings_direct',
        settingsSection: 'version',
        items: [
          {
            id: 'app_version_details',
            categoryId: 'app_version',
            title: 'Updates, Build & Changelog',
            description: `Installed v${INSTALLED_VERSION} (Build #${INSTALLED_BUILD_NUMBER})`,
            icon: Smartphone,
            keywords: ['version', 'update', 'changelog', 'build', 'onboarding'],
            onSelect: () => {
              triggerHaptic('light');
              navigateToView({
                type: 'settings',
                section: 'version',
                title: SETTINGS_SECTION_TITLES.version.title,
                subtitle: SETTINGS_SECTION_TITLES.version.subtitle,
                parentCategoryId: null,
              });
            },
          },
        ],
      },
      {
        id: 'account_actions',
        title: 'Account Actions',
        description: 'Logout and account management',
        subtitleBn: 'লগ আউট ও সেশন ম্যানেজমেন্ট',
        icon: LogOut,
        keywords: ['logout', 'log out', 'sign out', 'exit', 'account actions', 'লগআউট', 'সাইন আউট'],
        mode: 'category_shell',
        items: [
          {
            id: 'logout_action',
            categoryId: 'account_actions',
            title: 'Log Out',
            description: 'Sign out of your reseller account on this device',
            icon: LogOut,
            isDestructive: true,
            keywords: ['logout', 'sign out', 'exit', 'লগআউট'],
            onSelect: () => {
              triggerHaptic('light');
              setShowLogoutConfirm(true);
            },
          },
        ],
      },
    ];
  }, [
    appVersionInfo?.version,
    canAccessFullApp,
    hasUpdateAvailable,
    isPendingUser,
    loadingVersion,
    navigateToView,
    onNavigateTab,
    openLockedOrRun,
    openPosterStudio,
    pendingChangeCount,
    unreadChatCount,
    unreadNotificationsCount,
  ]);

  const handleOpenCategory = useCallback(
    (category: HubCategoryDef) => {
      if (category.mode === 'settings_direct' && category.settingsSection) {
        const featureLabel =
          category.id === 'policies_info'
            ? 'Account Policies & FAQ'
            : category.title;
        openLockedOrRun(Boolean(category.isLocked), featureLabel, () => {
          navigateToView({
            type: 'settings',
            section: category.settingsSection!,
            title: category.title,
            subtitle: category.description,
            parentCategoryId: null,
          });
        });
        return;
      }

      triggerHaptic('light');
      navigateToView({ type: 'category', categoryId: category.id });
    },
    [navigateToView, openLockedOrRun]
  );

  // Filter categories and items for Hub search
  const normalizedQuery = searchQuery.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!normalizedQuery) return null;

    const matchedCategories = categories.filter((cat) => {
      const hay = `${cat.title} ${cat.description} ${cat.subtitleBn || ''} ${cat.keywords.join(' ')}`.toLowerCase();
      return hay.includes(normalizedQuery);
    });

    const allItems = categories.flatMap((c) =>
      c.items.map((item) => ({
        ...item,
        categoryTitle: c.title,
      }))
    );

    const matchedItems = allItems.filter((item) => {
      const hay = `${item.title} ${item.description} ${item.categoryTitle} ${item.keywords.join(' ')}`.toLowerCase();
      return hay.includes(normalizedQuery);
    });

    return { matchedCategories, matchedItems };
  }, [categories, normalizedQuery]);

  // 1. True Full-Screen Live Chat Mode
  if (view.type === 'chat') {
    return (
      <LiveChatWindow
        chatId={`chat_${user.uid}`}
        currentUser={user}
        fullScreen={true}
        partnerInfo={{
          name: 'ReSellBD Support',
          shopName: 'Official Support Team',
          role: 'admin',
        }}
        onBack={() => {
          if (onBackFromChat) {
            onBackFromChat();
          } else {
            setView({ type: 'hub' });
            onNavigateTab('more');
          }
        }}
        onOpenOrder={() => onNavigateTab('orders')}
        onOpenProduct={() => onNavigateTab('products')}
      />
    );
  }

  // 2. Dedicated Full-Screen Edit Profile Page
  if (view.type === 'edit_profile') {
    const parentCat = view.parentCategoryId || null;
    return (
      <ResellerEditProfilePage
        user={user}
        onBack={() => {
          if (parentCat) {
            setView({ type: 'category', categoryId: parentCat });
          } else {
            setView({ type: 'hub' });
            if (activeSubTab !== 'more') {
              onNavigateTab('more');
            }
          }
        }}
      />
    );
  }

  // 3. Initial Skeleton Loading if user profile is not yet hydrated
  if (!user?.uid) {
    return (
      <div className="max-w-xl mx-auto min-h-0 space-y-3" aria-busy="true" aria-label="Loading account hub">
        <div className="bg-white rounded-[14px] border border-slate-200/85 p-3.5 space-y-3 animate-pulse motion-reduce:animate-none">
          <div className="flex items-center gap-3">
            <div className="w-13 h-13 rounded-2xl bg-slate-200 shrink-0" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-36 bg-slate-200 rounded" />
              <div className="h-3 w-28 bg-slate-100 rounded" />
            </div>
          </div>
          <div className="pt-2.5 border-t border-slate-100 flex items-center justify-between">
            <div className="h-6 w-32 bg-slate-100 rounded-lg" />
            <div className="h-8 w-24 bg-slate-200 rounded-xl" />
          </div>
        </div>
        <div className="h-11 bg-white rounded-[14px] border border-slate-200/85 animate-pulse motion-reduce:animate-none" />
        <div className="bg-white rounded-[14px] border border-slate-200/85 divide-y divide-slate-100 overflow-hidden">
          {Array.from({ length: 7 }).map((_, idx) => (
            <div key={idx} className="px-3.5 py-3 flex items-center gap-3 animate-pulse motion-reduce:animate-none">
              <div className="w-10 h-10 rounded-[11px] bg-slate-100 shrink-0" />
              <div className="flex-1 space-y-1.5">
                <div className="h-3.5 w-36 bg-slate-200 rounded" />
                <div className="h-3 w-52 bg-slate-100 rounded" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const avatarUrl = user.profilePhotoUrl || user.shopPhotoUrl || user.shopLogoUrl;
  const activeSettingsMeta =
    view.type === 'settings'
      ? SETTINGS_SECTION_TITLES[(settingsInnerSection as SettingsSectionId) || view.section] || {
          title: view.title,
          subtitle: view.subtitle,
        }
      : null;

  const activeCategory =
    view.type === 'category'
      ? categories.find((c) => c.id === view.categoryId) || null
      : null;

  return (
    <div className="max-w-xl mx-auto min-h-0 space-y-3">
      {/* ==========================================
          SLIM TOP PROFILE HEADER
         ========================================== */}
      <section className="bg-white rounded-[14px] border border-slate-200/85 p-3.5 shadow-[0_1px_3px_rgba(15,23,42,0.03)]">
        <div className="flex items-center gap-3">
          {/* Avatar with Camera Badge */}
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              navigateToView({ type: 'edit_profile' });
            }}
            className="relative w-14 h-14 rounded-2xl bg-slate-100 border border-slate-200/90 shrink-0 cursor-pointer group focus:outline-none focus:ring-2 focus:ring-slate-300"
            aria-label="Update profile photo"
          >
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={user.fullName || 'Reseller'}
                className="w-full h-full object-cover rounded-2xl"
              />
            ) : (
              <div className="w-full h-full rounded-2xl bg-slate-100 text-slate-700 flex items-center justify-center font-semibold text-lg uppercase">
                {(user.fullName || user.shopName || 'R').charAt(0)}
              </div>
            )}
            <span className="absolute -bottom-1 -right-1 w-6 h-6 rounded-full bg-white border border-slate-200 shadow-xs flex items-center justify-center text-slate-700 group-active:scale-95 transition-transform motion-reduce:transition-none">
              <Camera className="w-3 h-3 stroke-[2]" />
            </span>
          </button>

          {/* Name with verified tick & Shop name */}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 min-w-0">
              <h2 className="text-[15px] font-semibold text-slate-900 truncate leading-tight">
                {user.fullName || 'Reseller'}
              </h2>
              {user.status === 'approved' && (
                <CheckCircle2
                  className="w-4 h-4 text-emerald-600 shrink-0"
                  aria-label="Verified Reseller"
                />
              )}
            </div>
            <p className="text-[12px] text-slate-500 truncate mt-0.5 leading-tight">
              {user.shopName || 'ReSellBD Verified Shop'}
            </p>
          </div>
        </div>

        {/* Short Reseller ID (without SGR-), Copy Button, Status Chip & Edit Profile Button */}
        <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
            {shortResellerId && (
              <button
                type="button"
                onClick={handleCopyId}
                className="inline-flex items-center gap-1.5 min-h-[32px] px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200/75 active:bg-slate-200 text-slate-800 text-[11px] font-mono font-semibold transition-colors motion-reduce:transition-none cursor-pointer tabular-nums"
                title="Copy Reseller ID"
              >
                <span>ID: {shortResellerId}</span>
                {copiedId ? (
                  <>
                    <CheckCheck className="w-3 h-3 text-emerald-600 shrink-0" />
                    <span className="font-sans text-[10px] font-semibold text-emerald-700">Copied</span>
                  </>
                ) : (
                  <Copy className="w-3 h-3 text-slate-500 shrink-0" />
                )}
              </button>
            )}

            {user.status === 'approved' ? (
              <span className="inline-flex items-center gap-1 min-h-[28px] px-2.5 py-0.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200/70 text-[11px] font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                Active Reseller
              </span>
            ) : user.status === 'pending' ? (
              <span className="inline-flex items-center gap-1 min-h-[28px] px-2.5 py-0.5 rounded-lg bg-slate-100 text-slate-700 border border-slate-200 text-[11px] font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-slate-500" />
                Pending Approval
              </span>
            ) : user.status === 'suspended' ? (
              <span className="inline-flex items-center gap-1 min-h-[28px] px-2.5 py-0.5 rounded-lg bg-rose-50 text-rose-700 border border-rose-200/70 text-[11px] font-semibold">
                <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                Suspended
              </span>
            ) : (
              <span className="inline-flex items-center min-h-[28px] px-2.5 py-0.5 rounded-lg bg-slate-100 text-slate-700 border border-slate-200 text-[11px] font-semibold">
                {user.status || 'Reseller'}
              </span>
            )}
          </div>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              navigateToView({ type: 'edit_profile' });
            }}
            className="min-h-[36px] px-3 py-1.5 rounded-[10px] bg-slate-100 hover:bg-slate-200/80 active:bg-slate-200 text-slate-900 border border-slate-200/80 text-[12px] font-semibold inline-flex items-center gap-1 transition-colors motion-reduce:transition-none cursor-pointer shrink-0"
          >
            <span>Edit profile</span>
            <ChevronRight className="w-3.5 h-3.5 text-slate-500" />
          </button>
        </div>
      </section>

      {/* ==========================================
          SEARCH BOX
         ========================================== */}
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 stroke-[1.75] absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search settings and tools"
          aria-label="Search settings and tools"
          className="w-full h-[44px] pl-10 pr-10 bg-white rounded-[14px] border border-slate-200/85 text-[13px] font-medium text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-slate-400 shadow-[0_1px_2px_rgba(15,23,42,0.02)] transition-colors motion-reduce:transition-none"
        />
        {searchQuery && (
          <button
            type="button"
            onClick={() => setSearchQuery('')}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-100 flex items-center justify-center cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* ==========================================
          DIRECT SUPPORT STRIP FOR PENDING ACCOUNTS
         ========================================== */}
      {!canAccessFullApp && !normalizedQuery && (
        <div className="bg-white rounded-[14px] border border-slate-200/85 p-3.5 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-slate-900 truncate">
                Direct Support & Inquiries • সরাসরি সহায়তা
              </p>
              <p className="text-[12px] text-slate-500 truncate mt-0.5">
                Need verification help? Contact our team directly
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <a
              href="https://wa.me/8801700000000?text=Hello%20ReSellBD%2C%20I%20have%20a%20question%20about%20my%20reseller%20account."
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => triggerHaptic('light')}
              className="min-h-[42px] px-3 rounded-[11px] bg-slate-100 hover:bg-slate-200/75 active:bg-slate-200 text-slate-800 border border-slate-200/70 text-[12px] font-semibold flex items-center justify-center gap-1.5 transition-colors motion-reduce:transition-none"
            >
              <MessagesSquare className="w-4 h-4 text-emerald-700 stroke-[1.75]" />
              <span>WhatsApp</span>
            </a>
            <a
              href="tel:+8801700000000"
              onClick={() => triggerHaptic('light')}
              className="min-h-[42px] px-3 rounded-[11px] bg-slate-100 hover:bg-slate-200/75 active:bg-slate-200 text-slate-800 border border-slate-200/70 text-[12px] font-semibold flex items-center justify-center gap-1.5 transition-colors motion-reduce:transition-none"
            >
              <Phone className="w-4 h-4 text-slate-700 stroke-[1.75]" />
              <span>Call Us</span>
            </a>
          </div>
        </div>
      )}

      {/* ==========================================
          SEARCH RESULTS OR 11-CATEGORY HUB LIST
         ========================================== */}
      {searchResults ? (
        <div className="space-y-3">
          {searchResults.matchedCategories.length === 0 && searchResults.matchedItems.length === 0 ? (
            <div className="bg-white rounded-[14px] border border-slate-200/85 p-6 text-center space-y-2">
              <p className="text-[14px] font-semibold text-slate-800">
                No matching settings or tools
              </p>
              <p className="text-[12px] text-slate-500">
                কোনো মিল পাওয়া যায়নি — অন্য কীওয়ার্ড দিয়ে খুঁজুন
              </p>
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                className="mt-1 inline-flex items-center justify-center min-h-[38px] px-4 rounded-[10px] bg-slate-100 hover:bg-slate-200 text-slate-800 text-[12px] font-semibold cursor-pointer"
              >
                Clear search
              </button>
            </div>
          ) : (
            <>
              {searchResults.matchedCategories.length > 0 && (
                <div className="space-y-1.5">
                  <p className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Categories
                  </p>
                  <div className="bg-white rounded-[14px] border border-slate-200/85 divide-y divide-slate-100 overflow-hidden">
                    {searchResults.matchedCategories.map((cat) => {
                      const IconComp = cat.icon;
                      return (
                        <button
                          key={cat.id}
                          type="button"
                          onClick={() => handleOpenCategory(cat)}
                          className="w-full min-h-[62px] px-3.5 py-2.5 flex items-center gap-3 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer select-none"
                        >
                          <div className="w-10 h-10 rounded-[11px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                            <IconComp className="w-[19px] h-[19px] stroke-[1.75]" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span className="text-[15px] font-semibold text-slate-900 truncate">
                                {cat.title}
                              </span>
                              {cat.isLocked && <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                            </div>
                            <p className="text-[12px] text-slate-500 truncate mt-0.5">
                              {cat.description}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {cat.badgeCount && cat.badgeCount > 0 && (
                              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-rose-600 text-white text-[10px] font-bold tabular-nums">
                                {cat.badgeCount}
                              </span>
                            )}
                            <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {searchResults.matchedItems.length > 0 && (
                <div className="space-y-1.5">
                  <p className="px-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                    Items & Tools
                  </p>
                  <div className="bg-white rounded-[14px] border border-slate-200/85 divide-y divide-slate-100 overflow-hidden">
                    {searchResults.matchedItems.map((item) => {
                      const IconComp = item.icon;
                      return (
                        <button
                          key={`${item.categoryId}_${item.id}`}
                          type="button"
                          onClick={item.onSelect}
                          className="w-full min-h-[62px] px-3.5 py-2.5 flex items-center gap-3 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer select-none"
                        >
                          <div className="w-10 h-10 rounded-[11px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                            <IconComp
                              className={`w-[19px] h-[19px] stroke-[1.75] ${
                                item.isDestructive ? 'text-rose-600' : 'text-slate-700'
                              }`}
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <span
                                className={`text-[15px] font-semibold truncate ${
                                  item.isDestructive ? 'text-rose-600' : 'text-slate-900'
                                }`}
                              >
                                {item.title}
                              </span>
                              {item.isLocked && <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                            </div>
                            <p className="text-[12px] text-slate-500 truncate mt-0.5">
                              {item.categoryTitle} • {item.description}
                            </p>
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {item.badgeCount && item.badgeCount > 0 && (
                              <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-rose-600 text-white text-[10px] font-bold tabular-nums">
                                {item.badgeCount}
                              </span>
                            )}
                            <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-[14px] border border-slate-200/85 divide-y divide-slate-100 overflow-hidden shadow-[0_1px_3px_rgba(15,23,42,0.03)]">
          {categories.map((cat) => {
            const IconComp = cat.icon;
            return (
              <button
                key={cat.id}
                type="button"
                onClick={() => handleOpenCategory(cat)}
                className="w-full min-h-[62px] px-3.5 py-2.5 flex items-center gap-3 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer select-none"
              >
                <div className="w-10 h-10 rounded-[11px] bg-slate-100 text-slate-700 flex items-center justify-center shrink-0">
                  <IconComp className="w-[19px] h-[19px] stroke-[1.75]" />
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-[15px] font-semibold text-slate-900 truncate leading-snug">
                      {cat.title}
                    </span>
                    {cat.isLocked && <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />}
                  </div>
                  <p className="text-[12px] text-slate-500 truncate mt-0.5 leading-tight">
                    {cat.description}
                  </p>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  {cat.id === 'app_version' && loadingVersion ? (
                    <span className="w-11 h-4 rounded bg-slate-100 animate-pulse motion-reduce:animate-none" />
                  ) : cat.rightText ? (
                    <span className="text-[12px] font-medium text-slate-500 tabular-nums">
                      {cat.rightText}
                    </span>
                  ) : null}

                  {cat.badgeCount && cat.badgeCount > 0 && (
                    <span
                      className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold tabular-nums ${
                        cat.id === 'account_profile'
                          ? 'bg-teal-50 text-[#0E9AA7] border border-teal-200'
                          : 'bg-rose-600 text-white'
                      }`}
                    >
                      {cat.badgeCount}
                    </span>
                  )}
                  <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
                </div>
              </button>
            );
          })}
        </div>
      )}

      {/* Subtle App Version & Company Footer */}
      <footer className="text-center pt-1">
        <p className="text-[11px] font-medium text-slate-400 tabular-nums">
          ReSellBD v{INSTALLED_VERSION} (Build {INSTALLED_BUILD_NUMBER})
        </p>
        <p className="text-[10px] text-slate-400 mt-0.5">
          Sky Automation Tech
        </p>
      </footer>

      {/* ==========================================
          FULL-SCREEN CATEGORY PAGE SHELL / SUBSCREEN
         ========================================== */}
      {(view.type === 'category' || view.type === 'settings' || view.type === 'subscreen') && (
        <div
          className="fixed inset-0 z-50 bg-slate-50 flex justify-center animate-in fade-in slide-in-from-right-2 duration-150 motion-reduce:animate-none"
          role="dialog"
          aria-modal="false"
        >
          <div className="w-full max-w-2xl h-[100dvh] bg-slate-50 flex flex-col overflow-hidden md:border-x md:border-slate-200/80">
            <PageHeader
              title={
                view.type === 'category'
                  ? activeCategory?.title || 'Category'
                  : view.type === 'settings'
                  ? activeSettingsMeta?.title || view.title
                  : view.title
              }
              subtitle={
                view.type === 'category'
                  ? activeCategory?.subtitleBn || activeCategory?.description
                  : view.type === 'settings'
                  ? activeSettingsMeta?.subtitle || view.subtitle
                  : view.subtitle
              }
              onBack={handleBackNavigation}
              sticky={false}
              className="shrink-0 pt-[calc(env(safe-area-inset-top,0px)+0.35rem)]"
            />

            <div className="flex-1 overflow-y-auto overscroll-contain px-3.5 sm:px-4 pt-4 pb-[calc(env(safe-area-inset-bottom,0px)+16px)]">
              {/* Category Page Shell */}
              {view.type === 'category' && activeCategory && activeCategory.id === 'account_profile' && (
                <AccountProfilePage
                  user={user}
                  canAccessFullApp={canAccessFullApp}
                  onOpenLockedModal={onOpenLockedModal}
                  onOpenEditProfile={() =>
                    navigateToView({ type: 'edit_profile', parentCategoryId: 'account_profile' })
                  }
                  onOpenVerifiedInfo={() =>
                    navigateToView({
                      type: 'settings',
                      section: 'account',
                      title: SETTINGS_SECTION_TITLES.account.title,
                      subtitle: SETTINGS_SECTION_TITLES.account.subtitle,
                      parentCategoryId: 'account_profile',
                    })
                  }
                  onOpenChangeRequests={() =>
                    navigateToView({
                      type: 'settings',
                      section: 'changeRequests',
                      title: SETTINGS_SECTION_TITLES.changeRequests.title,
                      subtitle: SETTINGS_SECTION_TITLES.changeRequests.subtitle,
                      parentCategoryId: 'account_profile',
                    })
                  }
                  pendingChangeCount={pendingChangeCount}
                  initialFocusTarget={accountProfileFocusTarget}
                  onConsumeFocusTarget={() => setAccountProfileFocusTarget(null)}
                />
              )}

              {view.type === 'category' && activeCategory && activeCategory.id !== 'account_profile' && (
                <div className="max-w-xl mx-auto min-h-0 space-y-3">
                  {activeCategory.items.length > 0 ? (
                    <div className="bg-white rounded-[14px] border border-slate-200/85 divide-y divide-slate-100 overflow-hidden shadow-[0_1px_3px_rgba(15,23,42,0.03)]">
                      {activeCategory.items.map((item) => {
                        const ItemIcon = item.icon;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={item.onSelect}
                            className="w-full min-h-[62px] px-3.5 py-2.5 flex items-center gap-3 text-left hover:bg-slate-50 active:bg-slate-100 transition-colors motion-reduce:transition-none cursor-pointer select-none"
                          >
                            <div
                              className={`w-10 h-10 rounded-[11px] flex items-center justify-center shrink-0 ${
                                item.isDestructive
                                  ? 'bg-rose-50 text-rose-600'
                                  : 'bg-slate-100 text-slate-700'
                              }`}
                            >
                              <ItemIcon className="w-[19px] h-[19px] stroke-[1.75]" />
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span
                                  className={`text-[15px] font-semibold truncate leading-snug ${
                                    item.isDestructive ? 'text-rose-600' : 'text-slate-900'
                                  }`}
                                >
                                  {item.title}
                                </span>
                                {item.isLocked && (
                                  <Lock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                                )}
                              </div>
                              <p className="text-[12px] text-slate-500 truncate mt-0.5 leading-tight">
                                {item.description}
                              </p>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {item.badgeCount && item.badgeCount > 0 && (
                                <span
                                  className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold tabular-nums ${
                                    item.id === 'change_requests'
                                      ? 'bg-teal-50 text-[#0E9AA7] border border-teal-200'
                                      : 'bg-rose-600 text-white'
                                  }`}
                                >
                                  {item.badgeCount}
                                </span>
                              )}
                              <ChevronRight
                                className={`w-4 h-4 shrink-0 ${
                                  item.isDestructive ? 'text-rose-300' : 'text-slate-400'
                                }`}
                              />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="bg-white rounded-[14px] border border-slate-200/85 p-6 text-center">
                      <p className="text-[13px] font-medium text-slate-500">
                        More options coming soon
                      </p>
                    </div>
                  )}

                  {activeCategory.id === 'account_actions' && (
                    <p className="text-center text-[12px] font-medium text-slate-400 pt-2">
                      More options coming soon • আরও অপশন শীঘ্রই আসছে
                    </p>
                  )}
                </div>
              )}

              {/* Existing ResellerSettings Section (No Duplicate Screens) */}
              {view.type === 'settings' && (
                <ResellerSettings
                  key={view.section}
                  user={user}
                  onLogout={onLogout}
                  initialSection={view.section}
                  hideHeader={true}
                  onSectionChange={(sec) => setSettingsInnerSection(sec)}
                  canAccessFullApp={canAccessFullApp}
                  onOpenLockedModal={onOpenLockedModal}
                  onNavigateTab={onNavigateTab}
                  initialSecurityFocusTarget={securityFocusTarget}
                  onConsumeSecurityFocusTarget={() => setSecurityFocusTarget(null)}
                />
              )}

              {/* Existing Sub-Screen Views */}
              {view.type === 'subscreen' && view.screen === 'commission' && (
                <CommissionSummary user={user} />
              )}
              {view.type === 'subscreen' && view.screen === 'notifications' && (
                <ResellerNoticeList user={user} />
              )}
              {view.type === 'subscreen' && view.screen === 'support' && (
                <SupportSystem user={user} />
              )}
              {view.type === 'subscreen' && view.screen === 'reviews' && (
                <ProductReviewForm user={user} />
              )}
              {view.type === 'subscreen' && view.screen === 'feedback' && (
                <FeedbackForm user={user} />
              )}
            </div>
          </div>
        </div>
      )}

      {/* ==========================================
          LOG OUT CONFIRMATION SHEET / MODAL
         ========================================== */}
      {showLogoutConfirm && (
        <div
          className="fixed inset-0 z-[70] flex items-end sm:items-center justify-center p-0 sm:p-4 bg-slate-900/50 backdrop-blur-xs"
          onClick={() => !isLoggingOut && setShowLogoutConfirm(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md bg-white rounded-t-2xl sm:rounded-2xl border border-slate-200 shadow-2xl p-5 pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] space-y-4 animate-in fade-in slide-in-from-bottom-4 duration-150 motion-reduce:animate-none"
          >
            <div className="w-10 h-1 bg-slate-200 rounded-full mx-auto sm:hidden" />
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-[11px] bg-rose-50 text-rose-600 flex items-center justify-center shrink-0">
                <LogOut className="w-5 h-5 stroke-[1.75]" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className="text-[16px] font-semibold text-slate-900 leading-snug">
                  Log out of ReSellBD?
                </h3>
                <p className="text-[12px] text-slate-500 mt-1 leading-relaxed">
                  You will need to sign in again with your email and password. • পুনরায় লগইন করতে আপনার ইমেইল ও পাসওয়ার্ড প্রয়োজন হবে।
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5 pt-1">
              <button
                type="button"
                disabled={isLoggingOut}
                onClick={() => setShowLogoutConfirm(false)}
                className="flex-1 min-h-[44px] px-4 rounded-[12px] bg-slate-100 hover:bg-slate-200 text-slate-800 text-[13px] font-semibold transition-colors motion-reduce:transition-none cursor-pointer disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={isLoggingOut}
                onClick={handleConfirmLogout}
                className="flex-1 min-h-[44px] px-4 rounded-[12px] bg-rose-600 hover:bg-rose-700 text-white text-[13px] font-semibold transition-colors motion-reduce:transition-none cursor-pointer disabled:opacity-60"
              >
                {isLoggingOut ? 'Logging out...' : 'Yes, Log Out'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* AI Marketing & Smart Assist Modal */}
      <AIMarketingModal
        isOpen={showAiModal}
        onClose={() => setShowAiModal(false)}
        user={user}
        allProducts={allProductsList}
        onOpenSocialShare={(prod) => {
          setSelectedPosterProduct(prod || DEFAULT_DEMO_PRODUCT);
          setShowPosterModal(true);
        }}
      />

      {/* Social Share / Poster Studio Modal */}
      {showPosterModal && (
        <SocialShareModal
          isOpen={showPosterModal}
          onClose={() => setShowPosterModal(false)}
          product={
            selectedPosterProduct ||
            (allProductsList.length > 0 ? allProductsList[0] : DEFAULT_DEMO_PRODUCT)
          }
          user={user}
        />
      )}
    </div>
  );
};
