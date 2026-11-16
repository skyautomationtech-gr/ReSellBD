import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Ban,
  Bell,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  Edit,
  ExternalLink,
  FileText,
  History,
  KeyRound,
  Landmark,
  Loader2,
  Lock,
  Mail,
  MapPin,
  MessageCircle,
  MonitorSmartphone,
  Percent,
  Phone,
  Plus,
  RefreshCw,
  Send,
  Shield,
  ShoppingBag,
  Smartphone,
  StickyNote,
  Store,
  Trash2,
  User,
  Wallet,
  X,
  ZoomIn,
} from 'lucide-react';
import {
  addInternalAdminNote,
  deleteInternalAdminNote,
  DirectoryPermissions,
  DirectoryUserDetailData,
  EnrichedDirectoryUser,
  fetchDirectoryUserDetail,
  formatRelativeTime,
  isProtectedSuperAdmin,
  ResellerWarningTag,
} from '../../../lib/resellerDirectoryService';
import { formatResellerId } from '../../../lib/resellerIdHelper';
import {
  buildWhatsAppHref,
  collectPayoutMethods,
  extractCoordinates,
  formatDateTime,
  normalizeExternalUrl,
  parseDeviceAndBrowser,
  parseTsMs,
} from '../approvals/resellerApprovalUtils';
import { getStatusChipClasses } from '../approvals/ResellerDetailPanel';
import { UserProfile } from '../../../types';

type DrawerTab = 'profile' | 'payout_kyc' | 'wallet_orders' | 'devices' | 'notes_timeline';

interface ResellerDetailDrawerProps {
  isOpen: boolean;
  row: EnrichedDirectoryUser | null;
  currentUser?: UserProfile;
  perms: DirectoryPermissions;
  globalRateLabel: string;
  onClose: () => void;
  onOpenLightbox: (url: string, title: string) => void;
  onOpenEdit: (user: UserProfile) => void;
  onOpenSuspendOrActivate: (
    user: UserProfile,
    mode: 'suspend_temporary' | 'block_permanent' | 'activate'
  ) => void;
  onOpenCommission: (user: UserProfile) => void;
  onOpenNotify: (user: UserProfile) => void;
  onOpenResetPassword: (user: UserProfile) => void;
  onCopyId: (idText: string) => void;
}

const WARNING_LABELS: Record<ResellerWarningTag, string> = {
  duplicate_phone: 'Duplicate phone',
  duplicate_nid: 'Duplicate NID',
  failed_logins: 'Many failed logins',
  payout_changed_recently: 'Payout changed recently',
};

const LockedTag: React.FC = () => (
  <span
    className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200/80 px-1.5 py-0.5 rounded-md ml-1.5"
    title="Locked identity/payout field — only Super Admin can edit"
  >
    <Lock className="w-2.5 h-2.5" />
    <span>Locked</span>
  </span>
);

export const ResellerDetailDrawer: React.FC<ResellerDetailDrawerProps> = ({
  isOpen,
  row,
  currentUser,
  perms,
  globalRateLabel,
  onClose,
  onOpenLightbox,
  onOpenEdit,
  onOpenSuspendOrActivate,
  onOpenCommission,
  onOpenNotify,
  onOpenResetPassword,
  onCopyId,
}) => {
  const [activeTab, setActiveTab] = useState<DrawerTab>('profile');
  const [detail, setDetail] = useState<DirectoryUserDetailData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [copiedId, setCopiedId] = useState(false);

  // Notes composer state
  const [noteInput, setNoteInput] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteError, setNoteError] = useState('');

  const targetUid = row?.user.uid || null;

  const loadDetail = async (uid: string) => {
    setLoading(true);
    setError('');
    try {
      const res = await fetchDirectoryUserDetail(uid, perms);
      setDetail(res);
    } catch (err: any) {
      setError(err?.message || 'Failed to load account details.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && targetUid) {
      setActiveTab('profile');
      setNoteInput('');
      setNoteError('');
      loadDetail(targetUid);
    } else if (!isOpen) {
      setDetail(null);
    }
  }, [isOpen, targetUid]);

  if (!isOpen || !row) return null;

  const u = detail?.user || row.user;
  const isReseller = u.role === 'reseller';
  const protectedAdmin = isProtectedSuperAdmin(u);
  const displayId = isReseller ? formatResellerId(u) : u.adminId || u.uid.slice(0, 8);
  const payouts = collectPayoutMethods(u);
  const coords = extractCoordinates(u);
  const waHref = buildWhatsAppHref(u.whatsappNumber || u.whatsapp || u.mobile);
  const completeness = row.completeness;

  const handleCopy = () => {
    onCopyId(displayId);
    setCopiedId(true);
    setTimeout(() => setCopiedId(false), 1800);
  };

  const handleAddNote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser || !noteInput.trim()) return;
    setSavingNote(true);
    setNoteError('');
    try {
      const created = await addInternalAdminNote(u.uid, noteInput, currentUser);
      setDetail((prev) =>
        prev ? { ...prev, notes: [created, ...prev.notes] } : prev
      );
      setNoteInput('');
    } catch (err: any) {
      setNoteError(err?.message || 'Could not save internal note.');
    } finally {
      setSavingNote(false);
    }
  };

  const handleDeleteNote = async (noteId: string) => {
    if (!currentUser) return;
    try {
      await deleteInternalAdminNote(u.uid, noteId, currentUser);
      setDetail((prev) =>
        prev ? { ...prev, notes: prev.notes.filter((n) => n.id !== noteId) } : prev
      );
    } catch (err: any) {
      setNoteError(err?.message || 'Could not delete note.');
    }
  };

  const docImages: Array<{ label: string; url: string }> = [];
  if (perms.canViewKycAndPayout) {
    if (u.nidFrontUrl) docImages.push({ label: 'NID Front', url: u.nidFrontUrl });
    if (u.nidBackUrl) docImages.push({ label: 'NID Back', url: u.nidBackUrl });
    if (u.nidUrl && !u.nidFrontUrl) docImages.push({ label: 'NID Document', url: u.nidUrl });
    if (u.birthCertificateUrl) {
      docImages.push({ label: 'Birth Certificate', url: u.birthCertificateUrl });
    }
  }
  if (u.shopLogoUrl) docImages.push({ label: 'Shop Logo', url: u.shopLogoUrl });
  if (u.shopPhotoUrl) docImages.push({ label: 'Shop Photo', url: u.shopPhotoUrl });

  const businessLinks = [
    { label: 'Facebook Page', url: normalizeExternalUrl(u.facebookPage) },
    { label: 'TikTok', url: normalizeExternalUrl(u.tiktokUrl) },
    { label: 'Instagram', url: normalizeExternalUrl(u.instagramUrl) },
    { label: 'YouTube', url: normalizeExternalUrl(u.youtubeUrl) },
    { label: 'Website', url: normalizeExternalUrl((u as any).website) },
  ].filter((item): item is { label: string; url: string } => Boolean(item.url));

  const tabs: Array<{ id: DrawerTab; label: string }> = [
    { id: 'profile', label: 'Profile' },
    { id: 'payout_kyc', label: 'Payout & KYC' },
    { id: 'wallet_orders', label: 'Wallet & Orders' },
    { id: 'devices', label: 'Devices & Logins' },
    { id: 'notes_timeline', label: `Notes (${detail?.notes.length ?? 0})` },
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/45 backdrop-blur-[2px]">
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />
      <aside className="relative w-full md:max-w-2xl bg-white/95 backdrop-blur-xl h-full border-l border-slate-200 shadow-2xl flex flex-col">
        {/* Sticky Drawer Header */}
        <div className="px-4 py-3.5 border-b border-slate-200/80 bg-white/90 space-y-2.5 shrink-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              {u.profilePhotoUrl ? (
                <img
                  src={u.profilePhotoUrl}
                  alt={u.fullName}
                  onClick={() => onOpenLightbox(u.profilePhotoUrl, `${u.fullName} — Profile`)}
                  className="w-11 h-11 rounded-xl object-cover border border-slate-200 shrink-0 cursor-pointer hover:opacity-90"
                />
              ) : (
                <div className="w-11 h-11 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-[#04203F] font-bold text-base shrink-0">
                  {(u.fullName || 'U').charAt(0).toUpperCase()}
                </div>
              )}
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <h3 className="text-[16px] font-bold text-slate-900 truncate">
                    {u.fullName || 'Unnamed Account'}
                  </h3>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${getStatusChipClasses(
                      u.status
                    )}`}
                  >
                    {u.status}
                  </span>
                  {u.role !== 'reseller' && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold bg-[#04203F] text-white uppercase">
                      <Shield className="w-2.5 h-2.5" />
                      {u.role === 'super_admin' ? 'Super Admin' : 'Admin'}
                    </span>
                  )}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-slate-500">
                  <button
                    type="button"
                    onClick={handleCopy}
                    className="inline-flex items-center gap-1 font-mono font-bold text-[#04203F] hover:text-[#0E9AA7] cursor-pointer"
                    title="Copy ID"
                  >
                    <span>{displayId}</span>
                    {copiedId ? (
                      <Check className="w-3 h-3 text-emerald-600" />
                    ) : (
                      <Copy className="w-3 h-3 text-slate-400" />
                    )}
                  </button>
                  {u.shopName && (
                    <>
                      <span>·</span>
                      <span className="font-semibold text-slate-700 truncate">{u.shopName}</span>
                    </>
                  )}
                  <span>·</span>
                  <span className="tabular-nums">Joined {formatDateTime(u.createdAt)}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => loadDetail(u.uid)}
                disabled={loading}
                className="w-8 h-8 rounded-xl border border-slate-200 flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-50 cursor-pointer disabled:opacity-50"
                title="Reload details"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              </button>
              <button
                type="button"
                onClick={onClose}
                className="w-8 h-8 rounded-xl border border-slate-200 flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-50 cursor-pointer"
                aria-label="Close drawer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Warnings + Completeness strip */}
          {isReseller && (
            <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
              <div className="flex items-center gap-2">
                <div className="w-24 h-1.5 rounded-full bg-slate-200 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      completeness.percent === 100
                        ? 'bg-emerald-500'
                        : completeness.percent >= 66
                        ? 'bg-[#0E9AA7]'
                        : 'bg-amber-500'
                    }`}
                    style={{ width: `${completeness.percent}%` }}
                  />
                </div>
                <span className="text-[11px] font-semibold text-slate-600 tabular-nums">
                  {completeness.percent}% complete
                  {completeness.missingLabels.length > 0
                    ? ` (Missing: ${completeness.missingLabels.join(', ')})`
                    : ''}
                </span>
              </div>

              {row.warnings.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  {row.warnings.map((w) => (
                    <span
                      key={w}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 border border-rose-200 text-[10px] font-bold"
                    >
                      <AlertTriangle className="w-2.5 h-2.5" />
                      {WARNING_LABELS[w]}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Drawer Tabs */}
          <div className="flex items-center gap-1 overflow-x-auto pt-1 pb-0.5">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveTab(t.id)}
                className={`px-3 h-[32px] rounded-xl text-[12px] font-semibold whitespace-nowrap transition-colors cursor-pointer ${
                  activeTab === t.id
                    ? 'bg-[#04203F] text-white'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/* Drawer Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-[13px]">
          {error && (
            <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 flex items-center justify-between gap-2 text-[12px] text-rose-700">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => loadDetail(u.uid)}
                className="px-2.5 py-1 rounded-lg bg-white border border-rose-200 font-bold cursor-pointer"
              >
                Retry
              </button>
            </div>
          )}

          {/* TAB 1: PROFILE */}
          {activeTab === 'profile' && (
            <div className="space-y-4">
              {/* Contact & Quick Channels */}
              <section className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2.5">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                  <User className="w-3.5 h-3.5 text-[#0E9AA7]" />
                  <span>Identity & Contact</span>
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-[12px]">
                  <div>
                    <span className="block text-[11px] text-slate-400">Full Name</span>
                    <span className="font-semibold text-slate-900">{u.fullName || '—'}</span>
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-400">
                      Shop Name {isReseller && <LockedTag />}
                    </span>
                    <span className="font-semibold text-slate-900">{u.shopName || '—'}</span>
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-400">
                      Email {isReseller && <LockedTag />}
                    </span>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-medium text-slate-800 break-all">{u.email || '—'}</span>
                      {u.emailVerified ? (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-md">
                          <CheckCircle2 className="w-2.5 h-2.5" />
                          Verified
                        </span>
                      ) : (
                        <span className="inline-flex items-center text-[10px] font-semibold text-slate-500 bg-slate-100 px-1.5 py-0.5 rounded-md">
                          Unverified
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-400">Mobile & WhatsApp</span>
                    <div className="flex flex-wrap items-center gap-2 mt-0.5">
                      <a
                        href={`tel:${u.mobile}`}
                        className="inline-flex items-center gap-1 font-mono font-semibold text-[#04203F] hover:text-[#0E9AA7]"
                      >
                        <Phone className="w-3 h-3" />
                        <span>{u.mobile || '—'}</span>
                      </a>
                      {waHref && (
                        <a
                          href={waHref}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-bold hover:bg-emerald-100"
                        >
                          <MessageCircle className="w-3 h-3" />
                          <span>WhatsApp</span>
                        </a>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-400">
                      Date of Birth {isReseller && <LockedTag />}
                    </span>
                    <span className="font-medium text-slate-800 tabular-nums">
                      {u.dob || '—'}
                    </span>
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-400">Gender & Commission</span>
                    <span className="font-medium text-slate-800 capitalize">
                      {u.gender || '—'}
                    </span>
                    {isReseller && (
                      <span className="ml-2 text-[11px] font-semibold text-[#0E9AA7]">
                        ·{' '}
                        {u.customCommissionRate !== undefined &&
                        u.customCommissionRate !== null
                          ? `${u.customCommissionRate}% Custom`
                          : globalRateLabel}
                      </span>
                    )}
                  </div>
                </div>
              </section>

              {/* Address */}
              <section className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-[#0E9AA7]" />
                    <span>Address & Area</span>
                  </h4>
                  {coords && (
                    <a
                      href={`https://maps.google.com/?q=${coords.lat},${coords.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[11px] font-bold text-[#0E9AA7] hover:underline"
                    >
                      <span>Open Maps</span>
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-[12px]">
                  <div>
                    <span className="block text-[11px] text-slate-400">Division</span>
                    <span className="font-medium text-slate-800">{u.division || '—'}</span>
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-400">District</span>
                    <span className="font-medium text-slate-800">{u.district || '—'}</span>
                  </div>
                  <div>
                    <span className="block text-[11px] text-slate-400">Upazila / Thana</span>
                    <span className="font-medium text-slate-800">{u.upazila || '—'}</span>
                  </div>
                  {(u.union || u.ward || u.postalCode) && (
                    <div className="col-span-2 sm:col-span-3 text-[12px] text-slate-600">
                      {[
                        u.union ? `Union/Ward: ${u.union}` : null,
                        u.ward ? `Ward: ${u.ward}` : null,
                        u.postalCode ? `Postal: ${u.postalCode}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  )}
                  <div className="col-span-2 sm:col-span-3">
                    <span className="block text-[11px] text-slate-400">Street Address</span>
                    <span className="font-medium text-slate-800">{u.address || '—'}</span>
                  </div>
                </div>
              </section>

              {/* Business Links */}
              {businessLinks.length > 0 && (
                <section className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                    <Store className="w-3.5 h-3.5 text-[#0E9AA7]" />
                    <span>Business Links</span>
                  </h4>
                  <div className="flex flex-wrap gap-2">
                    {businessLinks.map((lnk) => (
                      <a
                        key={lnk.label}
                        href={lnk.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-[12px] font-semibold text-[#04203F]"
                      >
                        <span>{lnk.label}</span>
                        <ExternalLink className="w-3 h-3 text-slate-400" />
                      </a>
                    ))}
                  </div>
                </section>
              )}

              {/* Suspension / Rejection Reason if applicable */}
              {(u.suspensionReason || u.rejectReason) && (
                <section className="rounded-xl border border-rose-200 bg-rose-50/70 p-3.5 space-y-1 text-[12px]">
                  <span className="font-bold text-rose-800 block">
                    {u.status === 'suspended' ? 'Suspension Details' : 'Rejection Note'}
                  </span>
                  <p className="text-rose-700">{u.suspensionReason || u.rejectReason}</p>
                  {u.suspendedUntil && (
                    <p className="text-[11px] text-rose-600">
                      Suspended until: {u.suspendedUntil}
                    </p>
                  )}
                </section>
              )}
            </div>
          )}

          {/* TAB 2: PAYOUT & KYC */}
          {activeTab === 'payout_kyc' && (
            <div className="space-y-4">
              {!perms.canViewKycAndPayout ? (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-6 text-center space-y-1.5">
                  <Lock className="w-6 h-6 text-slate-400 mx-auto" />
                  <p className="text-[13px] font-bold text-slate-800">
                    Permission Required
                  </p>
                  <p className="text-[12px] text-slate-500">
                    Payout numbers and identity documents require{' '}
                    <strong>approve_resellers</strong> or Super Admin access.
                  </p>
                </div>
              ) : (
                <>
                  {/* Payout Accounts */}
                  <section className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                        <CreditCard className="w-3.5 h-3.5 text-[#0E9AA7]" />
                        <span>Payout Methods</span>
                        {isReseller && <LockedTag />}
                      </h4>
                    </div>
                    {payouts.length === 0 ? (
                      <p className="text-[12px] text-slate-500">No payout method configured.</p>
                    ) : (
                      <div className="divide-y divide-slate-100">
                        {payouts.map((pm) => (
                          <div
                            key={pm.id}
                            className="py-2 flex items-center justify-between gap-2 text-[12px]"
                          >
                            <div>
                              <div className="font-bold text-slate-900 flex items-center gap-1.5">
                                <Landmark className="w-3.5 h-3.5 text-slate-400" />
                                <span>{pm.type}</span>
                                {pm.isDefault && (
                                  <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 px-1.5 py-0.5 rounded-md">
                                    Default
                                  </span>
                                )}
                              </div>
                              <div className="text-[11px] text-slate-500 mt-0.5">
                                {pm.bankName ? `${pm.bankName} · ` : ''}
                                {pm.accountHolderName || u.fullName}
                                {pm.branchName ? ` · ${pm.branchName}` : ''}
                              </div>
                            </div>
                            <span className="font-mono font-bold text-slate-900 tabular-nums">
                              {pm.accountNumber || '—'}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  {/* KYC Identity Numbers & Documents */}
                  <section className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-3">
                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-[#0E9AA7]" />
                      <span>Identity & Verification Photos</span>
                      {isReseller && <LockedTag />}
                    </h4>

                    <div className="grid grid-cols-2 gap-3 text-[12px]">
                      <div>
                        <span className="block text-[11px] text-slate-400">Document Type</span>
                        <span className="font-semibold text-slate-900 uppercase">
                          {u.documentType || 'NID'}
                        </span>
                      </div>
                      <div>
                        <span className="block text-[11px] text-slate-400">
                          {u.documentType === 'birth_certificate'
                            ? 'Birth Certificate No.'
                            : 'NID Number'}
                        </span>
                        <span className="font-mono font-semibold text-slate-900 tabular-nums">
                          {u.documentType === 'birth_certificate'
                            ? u.birthCertificateNumber || '—'
                            : u.nidNumber || '—'}
                        </span>
                      </div>
                    </div>

                    {docImages.length === 0 ? (
                      <p className="text-[12px] text-slate-500">No document photos uploaded.</p>
                    ) : (
                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                        {docImages.map((img) => (
                          <button
                            key={img.label}
                            type="button"
                            onClick={() => onOpenLightbox(img.url, img.label)}
                            className="group relative rounded-xl border border-slate-200 overflow-hidden bg-slate-50 text-left cursor-pointer"
                          >
                            <img
                              src={img.url}
                              alt={img.label}
                              className="w-full h-24 object-cover group-hover:scale-105 transition-transform duration-150"
                            />
                            <div className="px-2 py-1 bg-white/95 border-t border-slate-100 flex items-center justify-between text-[11px] font-semibold text-slate-700">
                              <span className="truncate">{img.label}</span>
                              <ZoomIn className="w-3 h-3 text-slate-400 shrink-0" />
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          )}

          {/* TAB 3: WALLET & ORDERS */}
          {activeTab === 'wallet_orders' && (
            <div className="space-y-4">
              {loading && !detail ? (
                <div className="py-10 flex items-center justify-center text-slate-400 gap-2 text-[12px]">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Loading wallet and order history...</span>
                </div>
              ) : (
                <>
                  {/* Wallet Section */}
                  {!perms.canViewWallet ? (
                    <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 flex items-center gap-3 text-[12px] text-slate-600">
                      <Lock className="w-4 h-4 text-slate-400 shrink-0" />
                      <span>
                        Wallet balance and transaction ledger require{' '}
                        <strong>manage_wallet</strong> or Super Admin permission.
                      </span>
                    </div>
                  ) : (
                    <section className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-3">
                      <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                        <Wallet className="w-3.5 h-3.5 text-[#0E9AA7]" />
                        <span>Wallet & Recent Transactions</span>
                      </h4>
                      <div className="grid grid-cols-3 gap-2">
                        <div className="rounded-xl bg-slate-50 border border-slate-200/70 p-2.5">
                          <span className="text-[10px] font-semibold text-slate-500 block">
                            Available Balance
                          </span>
                          <span className="text-[15px] font-extrabold text-[#04203F] tabular-nums">
                            ৳{Math.round(detail?.wallet?.balance ?? row.walletBalance ?? 0).toLocaleString()}
                          </span>
                        </div>
                        <div className="rounded-xl bg-slate-50 border border-slate-200/70 p-2.5">
                          <span className="text-[10px] font-semibold text-slate-500 block">
                            Total Earned
                          </span>
                          <span className="text-[15px] font-extrabold text-emerald-700 tabular-nums">
                            ৳{Math.round(detail?.wallet?.totalEarned ?? row.totalCommissionEarned ?? 0).toLocaleString()}
                          </span>
                        </div>
                        <div className="rounded-xl bg-slate-50 border border-slate-200/70 p-2.5">
                          <span className="text-[10px] font-semibold text-slate-500 block">
                            Withdrawn
                          </span>
                          <span className="text-[15px] font-extrabold text-slate-700 tabular-nums">
                            ৳{Math.round(detail?.wallet?.totalWithdrawn ?? 0).toLocaleString()}
                          </span>
                        </div>
                      </div>

                      {detail && detail.transactions.length > 0 ? (
                        <div className="divide-y divide-slate-100 max-h-52 overflow-y-auto">
                          {detail.transactions.map((tx) => (
                            <div
                              key={tx.id}
                              className="py-2 flex items-center justify-between gap-2 text-[12px]"
                            >
                              <div className="min-w-0">
                                <span className="font-semibold text-slate-800 capitalize block truncate">
                                  {tx.type}
                                  {tx.orderNumber ? ` · #${tx.orderNumber}` : ''}
                                </span>
                                <span className="text-[11px] text-slate-400 tabular-nums">
                                  {formatDateTime(tx.createdAt)} · {tx.status}
                                </span>
                              </div>
                              <span
                                className={`font-mono font-bold tabular-nums shrink-0 ${
                                  tx.type === 'withdrawal' ? 'text-rose-600' : 'text-emerald-700'
                                }`}
                              >
                                {tx.type === 'withdrawal' ? '-' : '+'}৳
                                {Math.round(tx.amount || 0).toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-[12px] text-slate-400">No recent transactions.</p>
                      )}
                    </section>
                  )}

                  {/* Orders Section */}
                  <section className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2.5">
                    <div className="flex items-center justify-between">
                      <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                        <ShoppingBag className="w-3.5 h-3.5 text-[#0E9AA7]" />
                        <span>Recent Orders ({row.totalOrders} total · {row.deliveredOrders} delivered)</span>
                      </h4>
                    </div>
                    {!detail || detail.orders.length === 0 ? (
                      <p className="text-[12px] text-slate-400">No orders placed yet.</p>
                    ) : (
                      <div className="divide-y divide-slate-100 max-h-64 overflow-y-auto">
                        {detail.orders.map((ord) => (
                          <div
                            key={ord.id}
                            className="py-2 flex items-center justify-between gap-2 text-[12px]"
                          >
                            <div className="min-w-0">
                              <div className="font-semibold text-slate-900 truncate">
                                #{ord.orderNumber || ord.id.slice(0, 8)} · {ord.productName}
                              </div>
                              <div className="text-[11px] text-slate-500 truncate">
                                {ord.customerName} · Qty {ord.quantity} ·{' '}
                                {formatDateTime(ord.createdAt)}
                              </div>
                            </div>
                            <div className="text-right shrink-0">
                              <div className="font-mono font-bold text-slate-900 tabular-nums">
                                ৳{Math.round(ord.totalAmount || 0).toLocaleString()}
                              </div>
                              <span className="text-[10px] font-bold uppercase text-slate-500">
                                {ord.status}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          )}

          {/* TAB 4: DEVICES & LOGINS */}
          {activeTab === 'devices' && (
            <div className="space-y-4">
              {loading && !detail ? (
                <div className="py-10 flex items-center justify-center text-slate-400 gap-2 text-[12px]">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Loading device & login telemetry...</span>
                </div>
              ) : (
                <>
                  <section className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2.5">
                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                      <MonitorSmartphone className="w-3.5 h-3.5 text-[#0E9AA7]" />
                      <span>Active Devices ({detail?.devices.length ?? 0})</span>
                    </h4>
                    {!detail || detail.devices.length === 0 ? (
                      <p className="text-[12px] text-slate-400">
                        No active device records stored.
                        {row.lastDeviceLabel ? ` Last known: ${row.lastDeviceLabel}` : ''}
                      </p>
                    ) : (
                      <div className="divide-y divide-slate-100">
                        {detail.devices.map((dev) => (
                          <div
                            key={dev.id || dev.deviceId}
                            className="py-2 flex items-center justify-between gap-2 text-[12px]"
                          >
                            <div className="flex items-center gap-2.5 min-w-0">
                              <Smartphone className="w-4 h-4 text-slate-400 shrink-0" />
                              <div className="min-w-0">
                                <div className="font-semibold text-slate-900 truncate">
                                  {dev.deviceName || dev.model || 'Device'}
                                </div>
                                <div className="text-[11px] text-slate-500 truncate">
                                  {dev.os} {dev.osVersion} · {dev.browser || dev.platform}
                                </div>
                              </div>
                            </div>
                            <span className="text-[11px] text-slate-500 tabular-nums shrink-0">
                              {formatRelativeTime(parseTsMs(dev.lastActive))}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>

                  <section className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2.5">
                    <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                      <History className="w-3.5 h-3.5 text-[#0E9AA7]" />
                      <span>Recent Login History</span>
                    </h4>
                    {!detail || detail.loginHistory.length === 0 ? (
                      <p className="text-[12px] text-slate-400">
                        No recent login history events found.
                      </p>
                    ) : (
                      <div className="divide-y divide-slate-100 max-h-60 overflow-y-auto">
                        {detail.loginHistory.map((lh, idx) => {
                          const parsed = parseDeviceAndBrowser(lh.userAgent);
                          return (
                            <div
                              key={lh.id || idx}
                              className="py-2 flex items-center justify-between gap-2 text-[12px]"
                            >
                              <div className="min-w-0">
                                <div className="font-semibold text-slate-800 truncate">
                                  {lh.deviceName || parsed.device} · {lh.browser || parsed.browser}
                                </div>
                                <div className="text-[11px] text-slate-400">
                                  {lh.os} {lh.osVersion} {lh.isNewDevice ? '· New Device' : ''}
                                </div>
                              </div>
                              <span className="text-[11px] text-slate-500 tabular-nums shrink-0">
                                {formatDateTime(lh.timestamp)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </section>
                </>
              )}
            </div>
          )}

          {/* TAB 5: INTERNAL NOTES & AUDIT TIMELINE */}
          {activeTab === 'notes_timeline' && (
            <div className="space-y-4">
              {/* Internal Admin Notes */}
              <section className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                    <StickyNote className="w-3.5 h-3.5 text-[#0E9AA7]" />
                    <span>Internal Admin Notes (Admins Only)</span>
                  </h4>
                </div>

                <form onSubmit={handleAddNote} className="space-y-2">
                  <textarea
                    rows={2}
                    value={noteInput}
                    onChange={(e) => setNoteInput(e.target.value)}
                    placeholder="Add an internal note visible only to Admins & Super Admin..."
                    className="w-full p-2.5 rounded-xl border border-slate-200 bg-slate-50 text-[12px] text-slate-800 outline-none focus:border-[#0E9AA7] resize-none"
                  />
                  {noteError && (
                    <p className="text-[11px] text-rose-600">{noteError}</p>
                  )}
                  <div className="flex justify-end">
                    <button
                      type="submit"
                      disabled={savingNote || !noteInput.trim()}
                      className="h-[34px] px-3.5 rounded-xl bg-[#04203F] hover:bg-[#073363] text-white text-[12px] font-bold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                    >
                      {savingNote ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Plus className="w-3.5 h-3.5" />
                      )}
                      <span>Add Note</span>
                    </button>
                  </div>
                </form>

                {(u.adminNotes || u.internalNote) && (
                  <div className="rounded-xl bg-amber-50/70 border border-amber-200/80 p-2.5 text-[12px]">
                    <span className="text-[10px] font-bold uppercase text-amber-800 block">
                      Profile Note
                    </span>
                    <p className="text-slate-800 mt-0.5">{u.adminNotes || u.internalNote}</p>
                  </div>
                )}

                {detail && detail.notes.length > 0 ? (
                  <div className="divide-y divide-slate-100">
                    {detail.notes.map((note) => {
                      const canDelete =
                        perms.isSuperAdmin || note.authorUid === currentUser?.uid;
                      return (
                        <div key={note.id} className="py-2.5 flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <p className="text-[12px] text-slate-800 whitespace-pre-wrap break-words">
                              {note.text}
                            </p>
                            <p className="text-[11px] text-slate-400 mt-1 tabular-nums">
                              {note.authorName} ({note.authorRole === 'super_admin' ? 'Super Admin' : 'Admin'}) ·{' '}
                              {formatDateTime(note.createdAt)}
                            </p>
                          </div>
                          {canDelete && (
                            <button
                              type="button"
                              onClick={() => handleDeleteNote(note.id)}
                              className="p-1 text-slate-400 hover:text-rose-600 cursor-pointer shrink-0"
                              title="Delete note"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <p className="text-[12px] text-slate-400">No internal notes recorded yet.</p>
                )}
              </section>

              {/* Activity Timeline from auditLogs */}
              <section className="rounded-xl border border-slate-200 bg-white p-3.5 space-y-2.5">
                <h4 className="text-[11px] font-bold uppercase tracking-wider text-slate-500 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-[#0E9AA7]" />
                  <span>Activity Timeline (Audit Logs)</span>
                </h4>
                {!detail || detail.auditLogs.length === 0 ? (
                  <p className="text-[12px] text-slate-400">
                    No audit log activity recorded for this account yet.
                  </p>
                ) : (
                  <div className="space-y-2.5 max-h-72 overflow-y-auto pr-1">
                    {detail.auditLogs.map((log) => (
                      <div
                        key={log.id}
                        className="border-l-2 border-slate-200 pl-3 py-0.5 text-[12px]"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-slate-900 text-[11px] uppercase tracking-wide">
                            {log.action.replace(/_/g, ' ')}
                          </span>
                          <span className="text-[11px] text-slate-400 tabular-nums shrink-0">
                            {formatDateTime(log.timestamp)}
                          </span>
                        </div>
                        {log.details && (
                          <p className="text-[12px] text-slate-600 mt-0.5">{log.details}</p>
                        )}
                        <p className="text-[11px] text-slate-400 mt-0.5">
                          By: {log.performedByName}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </div>

        {/* Sticky Bottom Action Bar */}
        <div className="px-4 py-3 border-t border-slate-200/80 bg-white/95 backdrop-blur-md flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => onOpenEdit(u)}
            className="h-[36px] px-3.5 rounded-xl bg-[#04203F] hover:bg-[#073363] text-white text-[12px] font-bold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Edit className="w-3.5 h-3.5" />
            <span>{perms.isSuperAdmin ? 'Edit Details' : 'View / Edit'}</span>
          </button>

          {!protectedAdmin && perms.canModerate && (
            <button
              type="button"
              onClick={() =>
                onOpenSuspendOrActivate(
                  u,
                  u.status === 'suspended' || u.status === 'pending'
                    ? 'activate'
                    : 'suspend_temporary'
                )
              }
              className={`h-[36px] px-3.5 rounded-xl text-[12px] font-bold inline-flex items-center gap-1.5 border cursor-pointer ${
                u.status === 'suspended' || u.status === 'pending'
                  ? 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100'
                  : 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100'
              }`}
            >
              {u.status === 'suspended' || u.status === 'pending' ? (
                <>
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>{u.status === 'pending' ? 'Approve' : 'Activate'}</span>
                </>
              ) : (
                <>
                  <Ban className="w-3.5 h-3.5" />
                  <span>Suspend</span>
                </>
              )}
            </button>
          )}

          {isReseller && perms.canManageCommission && (
            <button
              type="button"
              onClick={() => onOpenCommission(u)}
              className="h-[36px] px-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Percent className="w-3.5 h-3.5 text-[#0E9AA7]" />
              <span>Commission</span>
            </button>
          )}

          {perms.canSendNotifications && (
            <button
              type="button"
              onClick={() => onOpenNotify(u)}
              className="h-[36px] px-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Bell className="w-3.5 h-3.5 text-[#0E9AA7]" />
              <span>Notify</span>
            </button>
          )}

          {perms.isSuperAdmin && !protectedAdmin && (
            <button
              type="button"
              onClick={() => onOpenResetPassword(u)}
              className="h-[36px] px-3 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer ml-auto"
            >
              <KeyRound className="w-3.5 h-3.5 text-amber-600" />
              <span>Reset Password</span>
            </button>
          )}
        </div>
      </aside>
    </div>
  );
};
