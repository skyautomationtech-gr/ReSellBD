import React, { useEffect, useState } from 'react';
import { collection, getDocs, limit, orderBy, query } from 'firebase/firestore';
import {
  AlertTriangle,
  ArrowLeft,
  Ban,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock,
  Copy,
  CreditCard,
  ExternalLink,
  FileCheck2,
  FileText,
  Globe,
  MapPin,
  MessageCircle,
  Phone,
  ShieldCheck,
  Store,
  User,
  XCircle,
  ZoomIn,
} from 'lucide-react';
import { db } from '../../../lib/firebase';
import { formatResellerId } from '../../../lib/resellerIdHelper';
import { UserProfile } from '../../../types';
import {
  buildWhatsAppHref,
  collectPayoutMethods,
  DuplicateConflict,
  extractCoordinates,
  formatDateTime,
  getSubmissionTimestamp,
  getWaitingTimer,
  normalizeExternalUrl,
  parseDeviceAndBrowser,
  ParsedDeviceInfo,
} from './resellerApprovalUtils';

export type ChecklistKey = 'nameMatchesNid' | 'photoClear' | 'addressValid' | 'payoutValid';

export interface ChecklistState {
  nameMatchesNid: boolean;
  photoClear: boolean;
  addressValid: boolean;
  payoutValid: boolean;
}

const CHECKLIST_ITEMS: Array<{ key: ChecklistKey; label: string }> = [
  { key: 'nameMatchesNid', label: 'Name matches NID' },
  { key: 'photoClear', label: 'Photo clear' },
  { key: 'addressValid', label: 'Address valid' },
  { key: 'payoutValid', label: 'Payout valid' },
];

interface ResellerDetailPanelProps {
  user: UserProfile;
  duplicates: DuplicateConflict[];
  checklist: ChecklistState;
  onToggleChecklist: (key: ChecklistKey) => void;
  onSelectDuplicateAccount?: (uid: string) => void;
  onOpenImage: (url: string, title: string) => void;
  onApprove: () => void;
  onReject: () => void;
  onRequestChanges: () => void;
  onCloseMobile?: () => void;
  actionLoading?: boolean;
  nowMs?: number;
}

interface SectionShellProps {
  id: string;
  title: string;
  icon: React.ElementType;
  summary?: string;
  isOpen: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}

const SectionShell: React.FC<SectionShellProps> = ({
  id,
  title,
  icon: Icon,
  summary,
  isOpen,
  onToggle,
  children,
}) => (
  <section className="bg-white/90 backdrop-blur-sm border border-slate-200/85 rounded-xl overflow-hidden shadow-[0_1px_6px_rgba(4,32,63,0.03)]">
    <button
      type="button"
      onClick={() => onToggle(id)}
      aria-expanded={isOpen}
      className="w-full px-3.5 py-2.5 flex items-center justify-between gap-2 text-left hover:bg-slate-50/80 transition-colors cursor-pointer min-h-[42px]"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon className="w-4 h-4 text-[#0E9AA7] shrink-0" />
        <span className="text-[13px] font-bold text-[#04203F] truncate">{title}</span>
        {summary && (
          <span className="text-[11px] font-medium text-slate-400 truncate hidden sm:inline">
            · {summary}
          </span>
        )}
      </div>
      <ChevronDown
        className={`w-4 h-4 text-slate-400 shrink-0 transition-transform duration-150 ${
          isOpen ? 'rotate-180' : ''
        }`}
      />
    </button>
    {isOpen && <div className="border-t border-slate-100">{children}</div>}
  </section>
);

const InfoRow: React.FC<{
  label: string;
  value?: React.ReactNode;
  mono?: boolean;
}> = ({ label, value, mono = false }) => (
  <div className="px-3.5 py-2 flex items-start justify-between gap-3 text-[12px]">
    <span className="text-slate-500 font-medium shrink-0">{label}</span>
    <div
      className={`text-right text-slate-900 font-medium break-words min-w-0 ${
        mono ? 'font-mono tabular-nums' : ''
      }`}
    >
      {value || <span className="text-slate-400">—</span>}
    </div>
  </div>
);

export const getStatusChipClasses = (status: string) => {
  switch (status) {
    case 'approved':
      return {
        cls: 'bg-emerald-50 text-emerald-700 border-emerald-200',
        label: 'Approved',
        Icon: CheckCircle2,
      };
    case 'rejected':
      return {
        cls: 'bg-rose-50 text-rose-700 border-rose-200',
        label: 'Rejected',
        Icon: XCircle,
      };
    case 'suspended':
      return {
        cls: 'bg-slate-100 text-slate-700 border-slate-300',
        label: 'Suspended',
        Icon: Ban,
      };
    default:
      return {
        cls: 'bg-amber-50 text-amber-700 border-amber-200',
        label: 'Pending',
        Icon: Clock,
      };
  }
};

export const ResellerDetailPanel: React.FC<ResellerDetailPanelProps> = ({
  user,
  duplicates,
  checklist,
  onToggleChecklist,
  onSelectDuplicateAccount,
  onOpenImage,
  onApprove,
  onReject,
  onRequestChanges,
  onCloseMobile,
  actionLoading = false,
  nowMs = Date.now(),
}) => {
  const anyUser = user as any;
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    personal: true,
    contact: true,
    address: true,
    shop: true,
    links: true,
    payout: true,
    documents: true,
    registration: true,
  });
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [deviceMeta, setDeviceMeta] = useState<ParsedDeviceInfo>(() =>
    parseDeviceAndBrowser(anyUser.deviceInfo || anyUser.userAgent)
  );
  const [showRawUa, setShowRawUa] = useState(false);

  useEffect(() => {
    let active = true;
    const inlineUa = anyUser.deviceInfo || anyUser.userAgent;
    if (inlineUa) {
      setDeviceMeta(parseDeviceAndBrowser(inlineUa));
      return;
    }

    setDeviceMeta({ device: 'Checking...', browser: '', raw: '' });

    const loadDeviceInfo = async () => {
      try {
        const histSnap = await getDocs(
          query(collection(db, 'users', user.uid, 'loginHistory'), orderBy('timestamp', 'desc'), limit(1))
        );
        if (active && !histSnap.empty) {
          const d = histSnap.docs[0].data();
          const parsed = parseDeviceAndBrowser(d.userAgent || d.deviceModel);
          if (d.deviceName || d.browser) {
            setDeviceMeta({
              device: d.deviceName || parsed.device,
              browser: d.browser || parsed.browser,
              raw: d.userAgent || '',
            });
            return;
          }
          setDeviceMeta(parsed);
          return;
        }

        const devSnap = await getDocs(query(collection(db, 'users', user.uid, 'devices'), limit(5)));
        if (active && !devSnap.empty) {
          const realDevice = devSnap.docs.find((docItem) => docItem.id !== '_serverTimeProbe');
          if (realDevice) {
            const d = realDevice.data();
            const parsed = parseDeviceAndBrowser(d.userAgent || d.deviceModel);
            setDeviceMeta({
              device: d.deviceName || parsed.device,
              browser: d.browser || parsed.browser,
              raw: d.userAgent || '',
            });
            return;
          }
        }
      } catch {
        // Silent fallback
      }
      if (active) {
        setDeviceMeta({ device: 'Not recorded', browser: '—', raw: '' });
      }
    };

    loadDeviceInfo();
    return () => {
      active = false;
    };
  }, [user.uid, anyUser.deviceInfo, anyUser.userAgent]);

  const toggleSection = (id: string) => {
    setOpenSections((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const expandOrCollapseAll = (expand: boolean) => {
    setOpenSections({
      personal: expand,
      contact: expand,
      address: expand,
      shop: expand,
      links: expand,
      payout: expand,
      documents: expand,
      registration: expand,
    });
  };

  const handleCopy = (label: string, val: string) => {
    if (!val) return;
    navigator.clipboard?.writeText(val).catch(() => {});
    setCopiedField(label);
    setTimeout(() => setCopiedField(null), 1500);
  };

  const resellerId = formatResellerId(user);
  const statusInfo = getStatusChipClasses(user.status);
  const StatusIcon = statusInfo.Icon;
  const waiting = getWaitingTimer(user, nowMs);
  const payoutList = collectPayoutMethods(user);
  const coords = extractCoordinates(user);
  const avatarSrc = user.profilePhotoUrl || user.shopLogoUrl || '';

  const checkedCount = CHECKLIST_ITEMS.filter((c) => checklist[c.key]).length;

  const businessLinks: Array<{ label: string; url: string | null; raw?: string }> = [
    { label: 'Facebook Page', url: normalizeExternalUrl(user.facebookPage), raw: user.facebookPage },
    {
      label: 'Website',
      url: normalizeExternalUrl(anyUser.website || anyUser.websiteUrl),
      raw: anyUser.website || anyUser.websiteUrl,
    },
    { label: 'TikTok', url: normalizeExternalUrl(user.tiktokUrl), raw: user.tiktokUrl },
    { label: 'Instagram', url: normalizeExternalUrl(user.instagramUrl), raw: user.instagramUrl },
    { label: 'YouTube', url: normalizeExternalUrl(user.youtubeUrl), raw: user.youtubeUrl },
  ];
  if (Array.isArray(anyUser.otherLinks)) {
    anyUser.otherLinks.forEach((lnk: string, idx: number) => {
      if (lnk) {
        businessLinks.push({
          label: `Other Link ${idx + 1}`,
          url: normalizeExternalUrl(lnk),
          raw: lnk,
        });
      }
    });
  } else if (typeof anyUser.otherLink === 'string' && anyUser.otherLink.trim()) {
    businessLinks.push({
      label: 'Other Link',
      url: normalizeExternalUrl(anyUser.otherLink),
      raw: anyUser.otherLink,
    });
  }
  const activeBusinessLinks = businessLinks.filter((l) => Boolean(l.url));

  const extraShopPhotos: string[] = Array.isArray(anyUser.shopPhotos)
    ? anyUser.shopPhotos.filter((u: any) => typeof u === 'string' && u.trim())
    : [];
  const primaryShopPhoto = user.shopPhotoUrl || '';
  const allShopPhotos = Array.from(
    new Set([primaryShopPhoto, ...extraShopPhotos].filter(Boolean))
  );

  const documentSlots = [
    { key: 'profile', label: 'Profile Photo', url: user.profilePhotoUrl || user.shopLogoUrl || '' },
    { key: 'shop', label: 'Shop Photo', url: user.shopPhotoUrl || '' },
    {
      key: 'nidFront',
      label: 'NID Front',
      url: user.nidFrontUrl || (user.documentType !== 'birth_certificate' ? user.nidUrl || '' : ''),
    },
    { key: 'nidBack', label: 'NID Back', url: user.nidBackUrl || '' },
    {
      key: 'birthCert',
      label: 'Birth Certificate',
      url:
        user.birthCertificateUrl ||
        (user.documentType === 'birth_certificate' ? user.nidUrl || '' : ''),
    },
  ];

  const allExpanded = Object.values(openSections).every(Boolean);

  return (
    <div className="flex flex-col h-full min-h-0 bg-slate-50/90">
      {/* Top Identity Header */}
      <div className="sticky top-0 z-20 bg-white/95 backdrop-blur-md border-b border-slate-200 px-3 sm:px-4 py-3 flex items-center justify-between gap-2.5 shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          {onCloseMobile && (
            <button
              type="button"
              onClick={onCloseMobile}
              aria-label="Back to list"
              className="min-h-[40px] min-w-[40px] rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-700 flex items-center justify-center shrink-0 cursor-pointer"
            >
              <ArrowLeft className="w-4 h-4" />
            </button>
          )}

          {avatarSrc ? (
            <button
              type="button"
              onClick={() => onOpenImage(avatarSrc, `${user.fullName} — Avatar`)}
              className="w-10 h-10 rounded-xl overflow-hidden border border-slate-200 bg-slate-100 shrink-0 cursor-pointer"
            >
              <img
                src={avatarSrc}
                alt={user.fullName}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
              />
            </button>
          ) : (
            <div className="w-10 h-10 rounded-xl bg-[#04203F] text-white font-bold text-sm flex items-center justify-center shrink-0">
              {(user.fullName || 'R').charAt(0).toUpperCase()}
            </div>
          )}

          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h2 className="text-[16px] font-bold text-[#04203F] truncate leading-tight">
                {user.fullName || 'Unnamed Reseller'}
              </h2>
              <span
                className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10.5px] font-bold shrink-0 ${statusInfo.cls}`}
              >
                <StatusIcon className="w-3 h-3" />
                {statusInfo.label}
              </span>
            </div>
            <div className="flex items-center gap-1.5 text-[11.5px] text-slate-500 mt-0.5 truncate">
              <span className="font-semibold text-slate-700 truncate">{user.shopName || '—'}</span>
              <span aria-hidden="true">·</span>
              <span className="font-mono font-semibold tabular-nums text-[#0E9AA7] shrink-0">
                {resellerId}
              </span>
              {user.status === 'pending' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span
                    className={`font-mono tabular-nums shrink-0 ${
                      waiting.isOverdue ? 'text-rose-600 font-semibold' : 'text-slate-500'
                    }`}
                  >
                    {waiting.label}
                  </span>
                </>
              )}
            </div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => expandOrCollapseAll(!allExpanded)}
          className="hidden sm:inline-flex items-center px-2.5 h-[32px] rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-[11px] font-semibold text-slate-600 shrink-0 cursor-pointer whitespace-nowrap"
        >
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </button>
      </div>

      {/* Scrollable Review Body */}
      <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-3.5 space-y-3">
        {/* Duplicate Check Notice */}
        {duplicates.length > 0 && (
          <div className="rounded-xl bg-rose-50/90 border border-rose-200 px-3.5 py-2.5 space-y-1.5">
            <div className="flex items-center gap-2 text-[12.5px] font-bold text-rose-800">
              <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
              <span>Duplicate check: {duplicates.length} match{duplicates.length > 1 ? 'es' : ''} found on other accounts</span>
            </div>
            <div className="space-y-1">
              {duplicates.map((dup, i) => (
                <div
                  key={`${dup.otherUid}-${dup.field}-${i}`}
                  className="flex items-center justify-between gap-2 text-[11.5px] text-rose-900 bg-white/75 rounded-lg px-2.5 py-1.5 border border-rose-200/70"
                >
                  <div className="min-w-0 truncate">
                    <span className="font-bold">{dup.field}:</span>{' '}
                    <span className="font-mono tabular-nums">{dup.value}</span>{' '}
                    <span className="text-rose-700">
                      → {dup.otherName} ({dup.otherResellerId} · {dup.otherStatus})
                    </span>
                  </div>
                  {onSelectDuplicateAccount && (
                    <button
                      type="button"
                      onClick={() => onSelectDuplicateAccount(dup.otherUid)}
                      className="text-[11px] font-bold text-rose-700 hover:text-rose-900 underline shrink-0 cursor-pointer"
                    >
                      Inspect
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Admin Visual Verification Checklist */}
        <div className="bg-white/90 backdrop-blur-sm border border-slate-200/85 rounded-xl px-3.5 py-2.5 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-[#0E9AA7]" />
              Admin Verification Checklist
            </span>
            <span className="text-[11px] font-mono font-bold tabular-nums text-slate-600">
              {checkedCount}/{CHECKLIST_ITEMS.length} verified
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {CHECKLIST_ITEMS.map((item) => {
              const checked = checklist[item.key];
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => onToggleChecklist(item.key)}
                  className={`min-h-[36px] px-2.5 py-1.5 rounded-lg border text-[11.5px] font-medium flex items-center gap-1.5 transition-colors cursor-pointer text-left ${
                    checked
                      ? 'bg-emerald-50 border-emerald-300 text-emerald-800 font-semibold'
                      : 'bg-slate-50 border-slate-200 text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded flex items-center justify-center shrink-0 border ${
                      checked
                        ? 'bg-emerald-600 border-emerald-600 text-white'
                        : 'bg-white border-slate-300'
                    }`}
                  >
                    {checked && <Check className="w-3 h-3 stroke-[3]" />}
                  </span>
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 1. Personal */}
        <SectionShell
          id="personal"
          title="1. Personal"
          icon={User}
          summary={user.fullName}
          isOpen={openSections.personal}
          onToggle={toggleSection}
        >
          <div className="divide-y divide-slate-100">
            <InfoRow label="Full name" value={user.fullName} />
            <InfoRow label="Date of birth" value={user.dob || '—'} mono />
            <InfoRow
              label="Gender"
              value={
                user.gender ? (
                  <span className="capitalize">{user.gender}</span>
                ) : (
                  '—'
                )
              }
            />
            <InfoRow
              label="NID number"
              value={
                user.nidNumber ? (
                  <span className="inline-flex items-center gap-1.5">
                    <span className="font-mono tabular-nums">{user.nidNumber}</span>
                    <button
                      type="button"
                      onClick={() => handleCopy('nid', user.nidNumber || '')}
                      className="text-slate-400 hover:text-slate-700 cursor-pointer"
                      title="Copy NID"
                    >
                      {copiedField === 'nid' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </span>
                ) : (
                  <span className="text-rose-600 font-semibold">Not provided</span>
                )
              }
            />
            <InfoRow
              label="Identity document type"
              value={
                user.documentType === 'birth_certificate'
                  ? 'Birth Certificate'
                  : 'National ID (NID)'
              }
            />
          </div>
        </SectionShell>

        {/* 2. Contact */}
        <SectionShell
          id="contact"
          title="2. Contact"
          icon={Phone}
          summary={user.mobile}
          isOpen={openSections.contact}
          onToggle={toggleSection}
        >
          <div className="divide-y divide-slate-100">
            <InfoRow
              label="Mobile number"
              value={
                user.mobile ? (
                  <div className="inline-flex items-center gap-2">
                    <a
                      href={`tel:${user.mobile}`}
                      className="font-mono tabular-nums text-[#04203F] hover:text-[#0E9AA7] underline decoration-slate-300"
                    >
                      {user.mobile}
                    </a>
                    <button
                      type="button"
                      onClick={() => handleCopy('mobile', user.mobile)}
                      className="text-slate-400 hover:text-slate-700 cursor-pointer"
                      title="Copy mobile"
                    >
                      {copiedField === 'mobile' ? (
                        <Check className="w-3.5 h-3.5 text-emerald-600" />
                      ) : (
                        <Copy className="w-3.5 h-3.5" />
                      )}
                    </button>
                  </div>
                ) : null
              }
            />
            <InfoRow
              label="WhatsApp"
              value={
                user.whatsappNumber || user.whatsapp ? (
                  <a
                    href={buildWhatsAppHref(user.whatsappNumber || user.whatsapp)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-emerald-700 hover:text-emerald-800 font-mono tabular-nums underline decoration-emerald-300"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    <span>{user.whatsappNumber || user.whatsapp}</span>
                    <ExternalLink className="w-3 h-3" />
                  </a>
                ) : (
                  'Same / Not set'
                )
              }
            />
            <InfoRow
              label="Email"
              value={
                <div className="flex flex-col items-end gap-1">
                  <div className="inline-flex items-center gap-1.5 flex-wrap justify-end">
                    <span className="break-all">{user.email}</span>
                    {user.emailVerified ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10.5px] font-bold whitespace-nowrap">
                        <CheckCircle2 className="w-3 h-3" />
                        Email verified
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-rose-50 border border-rose-200 text-rose-700 text-[10.5px] font-bold whitespace-nowrap">
                        <XCircle className="w-3 h-3" />
                        Unverified
                      </span>
                    )}
                  </div>
                  {user.emailVerified && (
                    <span className="text-[11px] text-slate-400 tabular-nums">
                      Verified time:{' '}
                      {anyUser.emailVerifiedAt
                        ? formatDateTime(anyUser.emailVerifiedAt)
                        : formatDateTime(getSubmissionTimestamp(user))}
                    </span>
                  )}
                </div>
              }
            />
          </div>
        </SectionShell>

        {/* 3. Full address */}
        <SectionShell
          id="address"
          title="3. Full address"
          icon={MapPin}
          summary={[user.upazila, user.district].filter(Boolean).join(', ')}
          isOpen={openSections.address}
          onToggle={toggleSection}
        >
          <div className="divide-y divide-slate-100">
            <InfoRow label="Division" value={user.division} />
            <InfoRow label="District" value={user.district} />
            <InfoRow
              label="Upazila / Thana"
              value={user.upazila || anyUser.upazilaThana}
            />
            <InfoRow label="Union / City ward" value={user.union || '—'} />
            <InfoRow label="Ward no." value={user.ward || '—'} mono />
            <InfoRow
              label="Postal code"
              value={
                [anyUser.postOffice, user.postalCode].filter(Boolean).join(' · ') || '—'
              }
              mono
            />
            <InfoRow label="Address line" value={user.address} />
            <InfoRow label="Landmark" value={anyUser.landmark || '—'} />
            {coords && (
              <div className="px-3.5 py-2.5 flex items-center justify-between gap-2 text-[12px]">
                <span className="text-slate-500 font-medium">Map location</span>
                <a
                  href={`https://www.google.com/maps?q=${coords.lat},${coords.lng}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-3 min-h-[36px] rounded-lg bg-[#0E9AA7]/10 hover:bg-[#0E9AA7]/20 border border-[#0E9AA7]/30 text-[#04203F] font-semibold text-[12px] transition-colors"
                >
                  <MapPin className="w-3.5 h-3.5 text-[#0E9AA7]" />
                  <span>Open in Google Maps</span>
                  <ExternalLink className="w-3 h-3" />
                </a>
              </div>
            )}
          </div>
        </SectionShell>

        {/* 4. Shop */}
        <SectionShell
          id="shop"
          title="4. Shop"
          icon={Store}
          summary={user.shopName}
          isOpen={openSections.shop}
          onToggle={toggleSection}
        >
          <div className="divide-y divide-slate-100">
            <InfoRow label="Shop name" value={user.shopName} />
            <InfoRow
              label="Shop type / category"
              value={anyUser.shopType || anyUser.shopCategory || '—'}
            />
            <InfoRow label="Reseller ID" value={resellerId} mono />
            <div className="px-3.5 py-2.5 space-y-2 text-[12px]">
              <span className="text-slate-500 font-medium block">Shop logo & shop photos</span>
              <div className="flex flex-wrap gap-2.5">
                {user.shopLogoUrl ? (
                  <button
                    type="button"
                    onClick={() => onOpenImage(user.shopLogoUrl!, `${user.shopName} — Shop Logo`)}
                    className="group relative w-20 h-20 rounded-xl overflow-hidden border border-slate-200 bg-slate-100 cursor-pointer shrink-0"
                  >
                    <img
                      src={user.shopLogoUrl}
                      alt="Shop Logo"
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute inset-x-0 bottom-0 bg-slate-900/75 text-white text-[10px] font-semibold py-0.5 text-center">
                      Logo
                    </span>
                  </button>
                ) : (
                  <span className="inline-flex items-center px-2 py-1 rounded bg-rose-50 border border-rose-200 text-rose-700 text-[11px] font-semibold">
                    Logo: Not provided
                  </span>
                )}

                {allShopPhotos.map((photoUrl, idx) => (
                  <button
                    key={`${photoUrl.slice(0, 32)}-${idx}`}
                    type="button"
                    onClick={() =>
                      onOpenImage(photoUrl, `${user.shopName} — Shop Photo ${idx + 1}`)
                    }
                    className="group relative w-20 h-20 rounded-xl overflow-hidden border border-slate-200 bg-slate-100 cursor-pointer shrink-0"
                  >
                    <img
                      src={photoUrl}
                      alt={`Shop Photo ${idx + 1}`}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover"
                    />
                    <span className="absolute inset-x-0 bottom-0 bg-slate-900/75 text-white text-[10px] font-semibold py-0.5 text-center">
                      Shop {allShopPhotos.length > 1 ? idx + 1 : 'Photo'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </SectionShell>

        {/* 5. Business links */}
        <SectionShell
          id="links"
          title="5. Business links"
          icon={Globe}
          summary={
            activeBusinessLinks.length > 0
              ? `${activeBusinessLinks.length} link${activeBusinessLinks.length > 1 ? 's' : ''}`
              : 'None provided'
          }
          isOpen={openSections.links}
          onToggle={toggleSection}
        >
          {activeBusinessLinks.length === 0 ? (
            <div className="px-3.5 py-3 text-[12px] text-slate-500">
              No business or social links provided during registration.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {activeBusinessLinks.map((lnk) => (
                <div
                  key={lnk.label}
                  className="px-3.5 py-2 flex items-center justify-between gap-3 text-[12px]"
                >
                  <span className="text-slate-500 font-medium shrink-0">{lnk.label}</span>
                  <a
                    href={lnk.url!}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-[#0E9AA7] hover:text-[#04203F] font-semibold truncate min-w-0 underline decoration-[#0E9AA7]/40"
                  >
                    <span className="truncate">{lnk.raw || lnk.url}</span>
                    <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                  </a>
                </div>
              ))}
            </div>
          )}
        </SectionShell>

        {/* 6. Payout methods */}
        <SectionShell
          id="payout"
          title="6. Payout methods"
          icon={CreditCard}
          summary={
            payoutList.length > 0
              ? `${payoutList.length} method${payoutList.length > 1 ? 's' : ''}`
              : 'Not set'
          }
          isOpen={openSections.payout}
          onToggle={toggleSection}
        >
          {payoutList.length === 0 ? (
            <div className="px-3.5 py-3 text-[12px] text-rose-600 font-semibold">
              No payout methods provided.
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {payoutList.map((pm) => (
                <div key={pm.id} className="px-3.5 py-2.5 space-y-1 text-[12px]">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-bold text-[#04203F]">{pm.type}</span>
                      {pm.isDefault && (
                        <span className="px-1.5 py-0.5 rounded bg-[#0E9AA7]/12 border border-[#0E9AA7]/30 text-[#04203F] text-[10px] font-bold">
                          Default
                        </span>
                      )}
                    </div>
                    <div className="inline-flex items-center gap-1.5">
                      <span className="font-mono font-bold tabular-nums text-slate-900">
                        {pm.accountNumber || '—'}
                      </span>
                      {pm.accountNumber && (
                        <button
                          type="button"
                          onClick={() => handleCopy(`pm-${pm.id}`, pm.accountNumber)}
                          className="text-slate-400 hover:text-slate-700 cursor-pointer"
                          title="Copy payout number"
                        >
                          {copiedField === `pm-${pm.id}` ? (
                            <Check className="w-3.5 h-3.5 text-emerald-600" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="text-[11.5px] text-slate-600 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span>
                      Holder: <strong className="text-slate-800">{pm.accountHolderName || '—'}</strong>
                    </span>
                    {pm.bankName && (
                      <span>
                        Bank: <strong className="text-slate-800">{pm.bankName}</strong>
                      </span>
                    )}
                    {pm.branchName && (
                      <span>
                        Branch: <strong className="text-slate-800">{pm.branchName}</strong>
                      </span>
                    )}
                    {pm.routingNumber && (
                      <span className="font-mono tabular-nums">
                        Routing: <strong className="text-slate-800">{pm.routingNumber}</strong>
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </SectionShell>

        {/* 7. Documents and photos */}
        <SectionShell
          id="documents"
          title="7. Documents and photos"
          icon={Camera}
          summary={`${documentSlots.filter((d) => Boolean(d.url)).length}/${documentSlots.length} provided`}
          isOpen={openSections.documents}
          onToggle={toggleSection}
        >
          <div className="p-3.5 grid grid-cols-1 min-[380px]:grid-cols-2 sm:grid-cols-3 gap-2.5">
            {documentSlots.map((slot) => (
              <div
                key={slot.key}
                className="rounded-xl border border-slate-200 bg-slate-50/70 overflow-hidden flex flex-col"
              >
                <div className="px-2.5 py-1.5 border-b border-slate-200/70 flex items-center justify-between gap-1 bg-white">
                  <span className="text-[11.5px] font-bold text-[#04203F] truncate">
                    {slot.label}
                  </span>
                  {!slot.url && (
                    <span className="px-1.5 py-0.5 rounded bg-rose-50 border border-rose-200 text-rose-700 text-[10px] font-bold whitespace-nowrap shrink-0">
                      Not provided
                    </span>
                  )}
                </div>

                {slot.url ? (
                  <button
                    type="button"
                    onClick={() => onOpenImage(slot.url, `${user.fullName} — ${slot.label}`)}
                    className="relative aspect-[4/3] w-full bg-slate-100 group cursor-pointer overflow-hidden"
                  >
                    <img
                      src={slot.url}
                      alt={slot.label}
                      referrerPolicy="no-referrer"
                      className="w-full h-full object-cover group-hover:scale-[1.03] transition-transform duration-200"
                    />
                    <span className="absolute bottom-1.5 right-1.5 px-2 py-1 rounded-md bg-slate-900/75 text-white text-[10.5px] font-semibold inline-flex items-center gap-1 opacity-90 group-hover:opacity-100">
                      <ZoomIn className="w-3 h-3" />
                      <span>View</span>
                    </span>
                  </button>
                ) : (
                  <div className="aspect-[4/3] w-full flex flex-col items-center justify-center p-3 text-center bg-rose-50/30">
                    <FileText className="w-5 h-5 text-rose-300 mb-1" />
                    <span className="text-[11px] font-semibold text-rose-600">Not provided</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </SectionShell>

        {/* 8. Registration info */}
        <SectionShell
          id="registration"
          title="8. Registration info"
          icon={FileCheck2}
          summary={formatDateTime(getSubmissionTimestamp(user))}
          isOpen={openSections.registration}
          onToggle={toggleSection}
        >
          <div className="divide-y divide-slate-100">
            <InfoRow
              label="Submitted time"
              value={formatDateTime(getSubmissionTimestamp(user))}
              mono
            />
            <InfoRow
              label="Terms accepted"
              value={
                anyUser.termsAcceptedAt
                  ? `${formatDateTime(anyUser.termsAcceptedAt)}${
                      anyUser.termsVersion ? ` (v${anyUser.termsVersion})` : ''
                    }`
                  : anyUser.termsVersion
                    ? `Accepted (v${anyUser.termsVersion})`
                    : '—'
              }
              mono
            />
            <InfoRow
              label="Email verification status"
              value={
                user.emailVerified ? (
                  <span className="text-emerald-700 font-semibold">Verified</span>
                ) : (
                  <span className="text-rose-600 font-semibold">Not verified</span>
                )
              }
            />
            <InfoRow
              label="Device & browser"
              value={
                <div className="space-y-0.5">
                  <div>
                    {deviceMeta.device}
                    {deviceMeta.browser && deviceMeta.browser !== '—'
                      ? ` · ${deviceMeta.browser}`
                      : ''}
                  </div>
                  {deviceMeta.raw && (
                    <div>
                      <button
                        type="button"
                        onClick={() => setShowRawUa((v) => !v)}
                        className="text-[10.5px] text-[#0E9AA7] hover:underline cursor-pointer"
                      >
                        {showRawUa ? 'Hide raw user-agent' : 'Show raw user-agent'}
                      </button>
                      {showRawUa && (
                        <p className="text-[10.5px] font-mono text-slate-500 break-all mt-1 text-left bg-slate-50 p-2 rounded-lg border border-slate-200">
                          {deviceMeta.raw}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              }
            />
            {user.rejectReason && (
              <InfoRow
                label="Last rejection reason"
                value={
                  <span className="text-rose-700">
                    {user.rejectReason}
                    {Array.isArray(user.rejectedSections) && user.rejectedSections.length > 0
                      ? ` (${user.rejectedSections.join(', ')})`
                      : ''}
                  </span>
                }
              />
            )}
            {user.suspensionReason && (
              <InfoRow
                label="Suspension reason"
                value={
                  <span className="text-rose-700">
                    [{user.suspensionType || 'suspended'}] {user.suspensionReason}
                  </span>
                }
              />
            )}
            {Array.isArray(user.resubmissions) && user.resubmissions.length > 0 && (
              <div className="px-3.5 py-2.5 space-y-1.5 text-[11.5px]">
                <span className="text-slate-500 font-medium block">
                  Resubmission history ({user.resubmissions.length})
                </span>
                <div className="space-y-1">
                  {user.resubmissions.map((r, idx) => (
                    <div
                      key={idx}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-50 border border-slate-200/80 text-slate-700"
                    >
                      <span className="font-mono tabular-nums text-slate-500">
                        {formatDateTime(r.resubmittedAt)}
                      </span>{' '}
                      · Prev: {r.rejectReason || (r as any).previousRejectReason || '—'}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </SectionShell>

        <div className="h-2" />
      </div>

      {/* Sticky Bottom Action Bar */}
      <div className="sticky bottom-0 z-20 bg-white/95 backdrop-blur-md border-t border-slate-200 px-3 sm:px-4 py-2.5 flex items-center justify-between gap-2 shrink-0">
        <button
          type="button"
          onClick={onReject}
          disabled={actionLoading}
          className="flex-1 min-h-[40px] px-2.5 sm:px-4 rounded-xl bg-rose-600 hover:bg-rose-700 active:scale-[0.98] text-white text-[12px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          <XCircle className="w-4 h-4 shrink-0" />
          <span>Reject</span>
        </button>

        <button
          type="button"
          onClick={onRequestChanges}
          disabled={actionLoading}
          className="flex-1 min-h-[40px] px-2.5 sm:px-4 rounded-xl bg-amber-50 hover:bg-amber-100 border border-amber-300 active:scale-[0.98] text-amber-800 text-[12px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden min-[370px]:inline">Request changes</span>
          <span className="min-[370px]:hidden">Changes</span>
        </button>

        <button
          type="button"
          onClick={onApprove}
          disabled={actionLoading}
          className="flex-1 min-h-[40px] px-2.5 sm:px-4 rounded-xl bg-emerald-600 hover:bg-emerald-700 active:scale-[0.98] text-white text-[12px] font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50 whitespace-nowrap shrink-0 shadow-xs"
        >
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>Approve</span>
        </button>
      </div>
    </div>
  );
};
