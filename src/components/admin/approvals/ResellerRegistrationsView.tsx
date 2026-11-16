import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { addDoc, collection, doc, getDocs, serverTimestamp, updateDoc } from 'firebase/firestore';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  RefreshCw,
  Search,
  UserCheck,
  X,
} from 'lucide-react';
import { auth, db } from '../../../lib/firebase';
import { logAuditAction } from '../../../lib/auditLogger';
import { formatResellerId } from '../../../lib/resellerIdHelper';
import { UserProfile, UserStatus } from '../../../types';
import { DocumentLightboxModal } from './DocumentLightboxModal';
import {
  ApproveConfirmSheet,
  RejectOrChangesModal,
} from './ResellerDecisionModals';
import {
  ChecklistKey,
  ChecklistState,
  getStatusChipClasses,
  ResellerDetailPanel,
} from './ResellerDetailPanel';
import {
  findDuplicateMatches,
  getSubmissionMs,
  getWaitingTimer,
} from './resellerApprovalUtils';

type StatusFilter = 'pending' | 'approved' | 'rejected' | 'suspended' | 'all';

const PAGE_SIZE = 20;

const DEFAULT_CHECKLIST: ChecklistState = {
  nameMatchesNid: false,
  photoClear: false,
  addressValid: false,
  payoutValid: false,
};

interface ResellerRegistrationsViewProps {
  currentUser?: UserProfile;
  onPendingCountChange?: (count: number) => void;
}

function logFirestorePermissionIfNeeded(
  error: any,
  operationType: 'get' | 'list' | 'create' | 'update',
  path: string
) {
  const errMsg = error instanceof Error ? error.message : String(error);
  const info = {
    error: errMsg,
    operationType,
    path,
    authInfo: {
      userId: auth.currentUser?.uid ?? null,
      email: auth.currentUser?.email ?? null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
    },
  };
  console.error('Firestore Error:', JSON.stringify(info));
}

export const ResellerRegistrationsView: React.FC<ResellerRegistrationsViewProps> = ({
  currentUser,
  onPendingCountChange,
}) => {
  const [allAccounts, setAllAccounts] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('pending');
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleLimit, setVisibleLimit] = useState(PAGE_SIZE);

  const [selectedUid, setSelectedUid] = useState<string | null>(null);
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false);

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [checklistsByUid, setChecklistsByUid] = useState<Record<string, ChecklistState>>({});
  const [lightboxState, setLightboxState] = useState<{ url: string; title: string } | null>(null);

  const [approvingUser, setApprovingUser] = useState<UserProfile | null>(null);
  const [decisionModal, setDecisionModal] = useState<{
    mode: 'reject' | 'request_changes';
    user: UserProfile;
  } | null>(null);
  const [actionLoadingUid, setActionLoadingUid] = useState<string | null>(null);

  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const showFeedback = (type: 'success' | 'error', message: string) => {
    setFeedback({ type, message });
    setTimeout(() => {
      setFeedback((prev) => (prev?.message === message ? null : prev));
    }, 5000);
  };

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);

  const fetchAllAccounts = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    else setLoading(true);

    try {
      const snap = await getDocs(collection(db, 'users'));
      const list: UserProfile[] = [];
      snap.forEach((docSnap) => {
        const data = docSnap.data() as UserProfile;
        list.push({ ...data, uid: data.uid || docSnap.id });
      });
      setAllAccounts(list);
    } catch (err: any) {
      logFirestorePermissionIfNeeded(err, 'list', 'users');
      showFeedback(
        'error',
        err?.message || 'Unable to load reseller registrations. Check permissions or network.'
      );
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchAllAccounts(false);
  }, [fetchAllAccounts]);

  const resellersSorted = useMemo(() => {
    return allAccounts
      .filter((u) => u.role === 'reseller')
      .sort((a, b) => getSubmissionMs(b) - getSubmissionMs(a));
  }, [allAccounts]);

  const statusCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = {
      pending: 0,
      approved: 0,
      rejected: 0,
      suspended: 0,
      all: resellersSorted.length,
    };
    resellersSorted.forEach((u) => {
      if (u.status === 'pending') counts.pending++;
      else if (u.status === 'approved') counts.approved++;
      else if (u.status === 'rejected') counts.rejected++;
      else if (u.status === 'suspended') counts.suspended++;
    });
    return counts;
  }, [resellersSorted]);

  useEffect(() => {
    onPendingCountChange?.(statusCounts.pending);
  }, [statusCounts.pending, onPendingCountChange]);

  const filteredResellers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return resellersSorted.filter((u) => {
      if (statusFilter !== 'all' && u.status !== statusFilter) return false;
      if (!q) return true;
      const rId = formatResellerId(u).toLowerCase();
      return (
        (u.fullName || '').toLowerCase().includes(q) ||
        (u.shopName || '').toLowerCase().includes(q) ||
        rId.includes(q) ||
        (u.mobile || '').toLowerCase().includes(q) ||
        (u.whatsappNumber || '').toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.nidNumber || '').toLowerCase().includes(q) ||
        (u.district || '').toLowerCase().includes(q) ||
        (u.upazila || '').toLowerCase().includes(q)
      );
    });
  }, [resellersSorted, statusFilter, searchQuery]);

  useEffect(() => {
    setVisibleLimit(PAGE_SIZE);
  }, [statusFilter, searchQuery]);

  const paginatedResellers = useMemo(
    () => filteredResellers.slice(0, visibleLimit),
    [filteredResellers, visibleLimit]
  );

  useEffect(() => {
    if (filteredResellers.length === 0) {
      setSelectedUid(null);
      setMobileSheetOpen(false);
      return;
    }
    const existsInAll = selectedUid && resellersSorted.some((u) => u.uid === selectedUid);
    if (!existsInAll) {
      setSelectedUid(filteredResellers[0].uid);
    }
  }, [filteredResellers, resellersSorted, selectedUid]);

  const selectedReseller = useMemo(
    () => resellersSorted.find((u) => u.uid === selectedUid) || null,
    [resellersSorted, selectedUid]
  );

  const duplicatesByUid = useMemo(() => {
    const map = new Map<string, ReturnType<typeof findDuplicateMatches>>();
    resellersSorted.forEach((u) => {
      map.set(u.uid, findDuplicateMatches(u, allAccounts));
    });
    return map;
  }, [resellersSorted, allAccounts]);

  const selectedDuplicates = selectedReseller
    ? duplicatesByUid.get(selectedReseller.uid) || []
    : [];

  const activeChecklist = selectedReseller
    ? checklistsByUid[selectedReseller.uid] || DEFAULT_CHECKLIST
    : DEFAULT_CHECKLIST;

  const toggleChecklistItem = (key: ChecklistKey) => {
    if (!selectedReseller) return;
    const uid = selectedReseller.uid;
    setChecklistsByUid((prev) => {
      const curr = prev[uid] || DEFAULT_CHECKLIST;
      return {
        ...prev,
        [uid]: { ...curr, [key]: !curr[key] },
      };
    });
  };

  const applyLocalStatusUpdate = (
    uid: string,
    patch: Partial<UserProfile> & { status: UserStatus }
  ) => {
    setAllAccounts((prev) => prev.map((u) => (u.uid === uid ? { ...u, ...patch } : u)));
  };

  const handleConfirmApprove = async () => {
    if (!approvingUser) return;
    const target = approvingUser;
    setActionLoadingUid(target.uid);

    try {
      await updateDoc(doc(db, 'users', target.uid), {
        status: 'approved',
        rejectReason: null,
        rejectedSections: [],
      });

      await logAuditAction(
        currentUser?.uid || 'admin',
        currentUser?.fullName || currentUser?.email || 'Admin',
        currentUser?.role || 'admin',
        'reseller_approved',
        target.uid,
        `Approved reseller ${target.fullName} (${target.shopName} · ${formatResellerId(target)})`
      );

      applyLocalStatusUpdate(target.uid, {
        status: 'approved',
        rejectReason: null,
        rejectedSections: [],
      });
      setApprovingUser(null);
      setMobileSheetOpen(false);
      showFeedback('success', `${target.fullName} (${formatResellerId(target)}) has been approved.`);
    } catch (err: any) {
      logFirestorePermissionIfNeeded(err, 'update', `users/${target.uid}`);
      showFeedback(
        'error',
        err?.message?.toLowerCase().includes('permission')
          ? 'Missing or insufficient permissions. Please verify your Super Admin OTP session or admin role.'
          : 'Failed to approve reseller account.'
      );
    } finally {
      setActionLoadingUid(null);
    }
  };

  const handleConfirmRejectOrChanges = async (
    reason: string,
    sections: string[],
    mode: 'reject' | 'request_changes'
  ) => {
    if (!decisionModal) return;
    const target = decisionModal.user;
    setActionLoadingUid(target.uid);

    try {
      await updateDoc(doc(db, 'users', target.uid), {
        status: 'rejected',
        rejectReason: reason,
        rejectedSections: sections,
      });

      try {
        await addDoc(collection(db, 'notifications'), {
          userId: target.uid,
          title:
            mode === 'request_changes'
              ? 'Action Required: Changes Requested'
              : 'Action Required: Application Update Needed',
          message: `Your registration requires corrections: ${reason}`,
          type: 'account_rejected',
          targetRole: 'reseller',
          read: false,
          createdAt: serverTimestamp(),
        });
      } catch (notifErr) {
        console.warn('Failed to send reseller rejection notification:', notifErr);
      }

      const actionCode =
        mode === 'request_changes' ? 'reseller_changes_requested' : 'reseller_rejected';
      const sectionNote = sections.length > 0 ? ` | Sections: ${sections.join(', ')}` : '';
      await logAuditAction(
        currentUser?.uid || 'admin',
        currentUser?.fullName || currentUser?.email || 'Admin',
        currentUser?.role || 'admin',
        actionCode,
        target.uid,
        `${mode === 'request_changes' ? 'Requested changes from' : 'Rejected'} ${target.fullName} (${target.shopName} · ${formatResellerId(target)}): ${reason}${sectionNote}`
      );

      applyLocalStatusUpdate(target.uid, {
        status: 'rejected',
        rejectReason: reason,
        rejectedSections: sections,
      });
      setDecisionModal(null);
      setMobileSheetOpen(false);
      showFeedback(
        'success',
        mode === 'request_changes'
          ? `Change request sent to ${target.fullName}.`
          : `Application for ${target.fullName} marked as rejected.`
      );
    } catch (err: any) {
      logFirestorePermissionIfNeeded(err, 'update', `users/${target.uid}`);
      showFeedback(
        'error',
        err?.message?.toLowerCase().includes('permission')
          ? 'Missing or insufficient permissions. Please verify your Super Admin OTP session or admin role.'
          : 'Failed to update reseller application status.'
      );
    } finally {
      setActionLoadingUid(null);
    }
  };

  const handleInspectDuplicate = (otherUid: string) => {
    const match = resellersSorted.find((u) => u.uid === otherUid);
    if (!match) {
      showFeedback('error', 'Matched account is an admin or non-reseller record.');
      return;
    }
    setStatusFilter('all');
    setSearchQuery('');
    setSelectedUid(match.uid);
    setMobileSheetOpen(true);
  };

  const FILTER_TABS: Array<{ id: StatusFilter; label: string }> = [
    { id: 'pending', label: 'Pending' },
    { id: 'approved', label: 'Approved' },
    { id: 'rejected', label: 'Rejected' },
    { id: 'suspended', label: 'Suspended' },
    { id: 'all', label: 'All' },
  ];

  const remainingCount = Math.max(0, filteredResellers.length - paginatedResellers.length);

  if (loading) {
    return (
      <div className="bg-white/80 backdrop-blur-xl rounded-2xl border border-slate-200/80 p-10 flex items-center justify-center gap-2.5 text-slate-500 text-[13px]">
        <Clock className="w-4 h-4 animate-spin text-[#0E9AA7]" />
        <span>Loading reseller registrations...</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {feedback && (
        <div
          className={`px-3.5 py-2.5 rounded-xl border text-[12px] font-semibold flex items-center justify-between gap-2 ${
            feedback.type === 'success'
              ? 'bg-emerald-50 border-emerald-200 text-emerald-800'
              : 'bg-rose-50 border-rose-200 text-rose-800'
          }`}
        >
          <span className="min-w-0">{feedback.message}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-current opacity-70 hover:opacity-100 cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      <div className="bg-white/85 backdrop-blur-xl rounded-2xl border border-slate-200/85 shadow-[0_2px_12px_rgba(4,32,63,0.04)] overflow-hidden grid grid-cols-1 lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)] lg:h-[calc(100vh-210px)] lg:min-h-[600px]">
        <div className="flex flex-col min-h-0 border-b lg:border-b-0 lg:border-r border-slate-200 bg-white">
          <div className="p-3 border-b border-slate-100 space-y-2.5 shrink-0">
            <div className="flex items-center gap-2">
              <div className="relative flex-1 min-w-0">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search name, shop, ID, phone, NID, city..."
                  className="w-full h-[38px] pl-8 pr-8 rounded-xl bg-slate-50 border border-slate-200 text-[12.5px] text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-[#0E9AA7] focus:bg-white transition-colors"
                />
                {searchQuery && (
                  <button
                    type="button"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              <button
                type="button"
                onClick={() => fetchAllAccounts(true)}
                disabled={refreshing}
                title="Refresh list"
                className="w-[38px] h-[38px] rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 text-slate-600 flex items-center justify-center shrink-0 cursor-pointer disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              </button>
            </div>

            <div className="flex items-center gap-1 overflow-x-auto pb-0.5 no-scrollbar">
              {FILTER_TABS.map((tab) => {
                const active = statusFilter === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => setStatusFilter(tab.id)}
                    className={`min-h-[32px] px-2.5 py-1 rounded-lg text-[11.5px] font-semibold transition-colors flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer ${
                      active
                        ? 'bg-[#04203F] text-white shadow-2xs'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200/70 hover:text-slate-900'
                    }`}
                  >
                    <span>{tab.label}</span>
                    <span
                      className={`font-mono tabular-nums text-[10.5px] ${
                        active ? 'text-[#7CE7F0]' : 'text-slate-500'
                      }`}
                    >
                      {statusCounts[tab.id]}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {paginatedResellers.length === 0 ? (
              <div className="py-12 px-4 text-center space-y-2">
                <div className="w-10 h-10 rounded-xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto">
                  <UserCheck className="w-5 h-5" />
                </div>
                <p className="text-[13px] font-bold text-slate-800">
                  No matching reseller registrations
                </p>
                <p className="text-[11.5px] text-slate-500">
                  {searchQuery
                    ? 'Try clearing or adjusting your search query.'
                    : `No registrations in "${statusFilter}" status right now.`}
                </p>
              </div>
            ) : (
              paginatedResellers.map((item) => {
                const isSelected = item.uid === selectedUid;
                const rId = formatResellerId(item);
                const chip = getStatusChipClasses(item.status);
                const waiting = getWaitingTimer(item, nowMs);
                const dupCount = (duplicatesByUid.get(item.uid) || []).length;
                const avatar = item.profilePhotoUrl || item.shopLogoUrl || '';
                const city = item.district || item.division || '—';

                return (
                  <button
                    key={item.uid}
                    type="button"
                    onClick={() => {
                      setSelectedUid(item.uid);
                      setMobileSheetOpen(true);
                    }}
                    className={`w-full text-left px-3 py-2.5 flex items-center gap-2.5 transition-colors cursor-pointer min-h-[58px] ${
                      isSelected
                        ? 'bg-[#0E9AA7]/[0.08] lg:ring-1 lg:ring-inset lg:ring-[#0E9AA7]/30'
                        : 'hover:bg-slate-50/90'
                    }`}
                  >
                    {avatar ? (
                      <img
                        src={avatar}
                        alt={item.fullName}
                        referrerPolicy="no-referrer"
                        className="w-9 h-9 rounded-lg object-cover border border-slate-200 bg-slate-100 shrink-0"
                      />
                    ) : (
                      <div className="w-9 h-9 rounded-lg bg-[#04203F]/90 text-white font-bold text-[12px] flex items-center justify-center shrink-0">
                        {(item.fullName || 'R').charAt(0).toUpperCase()}
                      </div>
                    )}

                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[13px] font-bold text-[#04203F] truncate">
                            {item.fullName || 'Unnamed'}
                          </span>
                          {dupCount > 0 && (
                            <AlertTriangle
                              className="w-3.5 h-3.5 text-rose-500 shrink-0"
                              aria-label="Possible duplicate"
                            />
                          )}
                        </div>
                        <span
                          className={`px-1.5 py-0.5 rounded border text-[10px] font-bold shrink-0 ${chip.cls}`}
                        >
                          {chip.label}
                        </span>
                      </div>

                      <div className="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                        <span className="truncate min-w-0">
                          <span className="font-medium text-slate-700">{item.shopName || '—'}</span>
                          <span aria-hidden="true"> · </span>
                          <span className="font-mono tabular-nums text-[#0E9AA7] font-semibold">
                            {rId}
                          </span>
                        </span>
                        <span className="truncate shrink-0 text-slate-500">{city}</span>
                      </div>

                      <div className="flex items-center justify-between gap-2 text-[10.5px]">
                        <span
                          className={`font-mono tabular-nums ${
                            waiting.isOverdue
                              ? 'text-rose-600 font-semibold'
                              : 'text-slate-400'
                          }`}
                        >
                          {waiting.label}
                        </span>
                        {item.emailVerified && (
                          <span className="text-emerald-600 font-medium shrink-0">
                            Email verified
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                );
              })
            )}

            {remainingCount > 0 && (
              <div className="p-3 bg-slate-50/70">
                <button
                  type="button"
                  onClick={() => setVisibleLimit((prev) => prev + PAGE_SIZE)}
                  className="w-full min-h-[38px] px-4 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-[12px] font-bold text-[#04203F] transition-colors cursor-pointer"
                >
                  Load more ({remainingCount} remaining)
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="hidden lg:flex flex-col min-h-0">
          {selectedReseller ? (
            <ResellerDetailPanel
              user={selectedReseller}
              duplicates={selectedDuplicates}
              checklist={activeChecklist}
              onToggleChecklist={toggleChecklistItem}
              onSelectDuplicateAccount={handleInspectDuplicate}
              onOpenImage={(url, title) => setLightboxState({ url, title })}
              onApprove={() => setApprovingUser(selectedReseller)}
              onReject={() =>
                setDecisionModal({ mode: 'reject', user: selectedReseller })
              }
              onRequestChanges={() =>
                setDecisionModal({ mode: 'request_changes', user: selectedReseller })
              }
              actionLoading={actionLoadingUid === selectedReseller.uid}
              nowMs={nowMs}
            />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center text-slate-500 space-y-2 bg-slate-50/60">
              <CheckCircle2 className="w-8 h-8 text-slate-300" />
              <p className="text-[13px] font-semibold text-slate-700">
                Select a reseller application to inspect
              </p>
              <p className="text-[12px] text-slate-400 max-w-xs">
                Review personal info, contact verification, address, shop links, payout accounts, and KYC documents.
              </p>
            </div>
          )}
        </div>
      </div>

      {mobileSheetOpen && selectedReseller && (
        <div className="lg:hidden fixed inset-0 z-[70] bg-slate-50 flex flex-col">
          <ResellerDetailPanel
            user={selectedReseller}
            duplicates={selectedDuplicates}
            checklist={activeChecklist}
            onToggleChecklist={toggleChecklistItem}
            onSelectDuplicateAccount={handleInspectDuplicate}
            onOpenImage={(url, title) => setLightboxState({ url, title })}
            onApprove={() => setApprovingUser(selectedReseller)}
            onReject={() =>
              setDecisionModal({ mode: 'reject', user: selectedReseller })
            }
            onRequestChanges={() =>
              setDecisionModal({ mode: 'request_changes', user: selectedReseller })
            }
            onCloseMobile={() => setMobileSheetOpen(false)}
            actionLoading={actionLoadingUid === selectedReseller.uid}
            nowMs={nowMs}
          />
        </div>
      )}

      <ApproveConfirmSheet
        user={approvingUser}
        checklistCount={
          approvingUser
            ? Object.values(checklistsByUid[approvingUser.uid] || DEFAULT_CHECKLIST).filter(Boolean)
                .length
            : 0
        }
        checklistTotal={4}
        hasDuplicates={
          approvingUser ? (duplicatesByUid.get(approvingUser.uid) || []).length > 0 : false
        }
        submitting={Boolean(approvingUser && actionLoadingUid === approvingUser.uid)}
        onCancel={() => setApprovingUser(null)}
        onConfirm={handleConfirmApprove}
      />

      <RejectOrChangesModal
        mode={decisionModal?.mode || null}
        user={decisionModal?.user || null}
        submitting={Boolean(decisionModal && actionLoadingUid === decisionModal.user.uid)}
        onClose={() => setDecisionModal(null)}
        onConfirm={handleConfirmRejectOrChanges}
      />

      <DocumentLightboxModal
        imageUrl={lightboxState?.url || null}
        title={lightboxState?.title}
        subtitle={
          selectedReseller
            ? `${selectedReseller.fullName} · ${formatResellerId(selectedReseller)}`
            : undefined
        }
        onClose={() => setLightboxState(null)}
      />
    </div>
  );
};
