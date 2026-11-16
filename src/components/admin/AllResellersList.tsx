import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DocumentData, QueryDocumentSnapshot } from 'firebase/firestore';
import {
  AlertTriangle,
  ArrowUpDown,
  Ban,
  Bell,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  Download,
  Edit,
  Eye,
  Filter,
  KeyRound,
  Loader2,
  Mail,
  MapPin,
  MessageCircle,
  MoreVertical,
  Percent,
  Phone,
  Printer,
  RefreshCw,
  RotateCw,
  Search,
  Shield,
  Store,
  Users,
  X,
} from 'lucide-react';
import { usePageRefresh, useRefresh } from '../../context/RefreshContext';
import { logAuditAction } from '../../lib/auditLogger';
import { sendResellerPasswordResetCall } from '../../lib/lockedFieldsService';
import { formatResellerId } from '../../lib/resellerIdHelper';
import {
  needsStatusEmailBackfill,
  sendMissedResellerStatusEmails,
} from '../../lib/resellerStatusEmailService';
import {
  applySuspendOrActivate,
  countActiveAdvancedFilters,
  DEFAULT_DIRECTORY_FILTERS,
  DirectoryAdvancedFilters,
  DirectorySortKey,
  DirectoryStatusFilter,
  DirectoryTab,
  EnrichedDirectoryUser,
  exportDirectoryCsv,
  fetchDirectoryPage,
  fetchDirectorySummaryMetrics,
  fetchGlobalCommissionLabel,
  formatRelativeTime,
  getDirectoryPermissions,
  isProtectedSuperAdmin,
  ResellerSummaryMetrics,
  ResellerWarningTag,
  sendTargetedNotifications,
  TeamRoleFilter,
  updateCustomCommissionRate,
} from '../../lib/resellerDirectoryService';
import { UserProfile } from '../../types';
import { EditUserModal } from './EditUserModal';
import { DocumentLightboxModal } from './approvals/DocumentLightboxModal';
import { getStatusChipClasses } from './approvals/ResellerDetailPanel';
import {
  buildWhatsAppHref,
  formatDateTime,
  parseTsMs,
} from './approvals/resellerApprovalUtils';
import { DirectoryFiltersSheet } from './directory/DirectoryFiltersSheet';
import {
  CustomCommissionModal,
  ResetPasswordConfirmModal,
  SendNotificationModal,
  SuspendActivateModal,
} from './directory/DirectoryModals';
import { DirectorySummaryStrip } from './directory/DirectorySummaryStrip';
import { ResellerDetailDrawer } from './directory/ResellerDetailDrawer';

interface AllResellersListProps {
  user?: UserProfile;
}

const WARNING_BADGE_MAP: Record<
  ResellerWarningTag,
  { label: string; cls: string }
> = {
  duplicate_phone: {
    label: 'Dup phone',
    cls: 'bg-rose-50 text-rose-700 border-rose-200',
  },
  duplicate_nid: {
    label: 'Dup NID',
    cls: 'bg-rose-50 text-rose-700 border-rose-200',
  },
  failed_logins: {
    label: 'Failed logins',
    cls: 'bg-amber-50 text-amber-700 border-amber-200',
  },
  payout_changed_recently: {
    label: 'Payout changed',
    cls: 'bg-amber-50 text-amber-700 border-amber-200',
  },
};

export const AllResellersList: React.FC<AllResellersListProps> = ({
  user: currentUser,
}) => {
  const perms = useMemo(() => getDirectoryPermissions(currentUser), [currentUser]);
  const { isRefreshing, showToast, refreshCurrentPage } = useRefresh();

  // Directory State
  const [activeTab, setActiveTab] = useState<DirectoryTab>('resellers');
  const [teamRoleFilter, setTeamRoleFilter] = useState<TeamRoleFilter>('all');
  const [statusFilter, setStatusFilter] = useState<DirectoryStatusFilter>('all');
  const [sortKey, setSortKey] = useState<DirectorySortKey>('newest');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filters, setFilters] = useState<DirectoryAdvancedFilters>(
    DEFAULT_DIRECTORY_FILTERS
  );

  // Data & Pagination State
  const [rows, setRows] = useState<EnrichedDirectoryUser[]>([]);
  const [summary, setSummary] = useState<ResellerSummaryMetrics | null>(null);
  const [globalRateLabel, setGlobalRateLabel] = useState<string>('Global');
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastCursor, setLastCursor] =
    useState<QueryDocumentSnapshot<DocumentData> | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [isSearchMode, setIsSearchMode] = useState(false);

  // Selection & Menus
  const [selectedUids, setSelectedUids] = useState<Set<string>>(new Set());
  const [openMenuUid, setOpenMenuUid] = useState<string | null>(null);
  const menuContainerRef = useRef<HTMLDivElement | null>(null);

  // Drawers & Modals
  const [isFiltersOpen, setIsFiltersOpen] = useState(false);
  const [drawerRow, setDrawerRow] = useState<EnrichedDirectoryUser | null>(null);
  const [editingUser, setEditingUser] = useState<UserProfile | null>(null);
  const [lightboxState, setLightboxState] = useState<{
    url: string;
    title: string;
  } | null>(null);

  const [suspendModalState, setSuspendModalState] = useState<{
    targets: UserProfile[];
    mode: 'suspend_temporary' | 'block_permanent' | 'activate';
  } | null>(null);
  const [commissionModalUser, setCommissionModalUser] =
    useState<UserProfile | null>(null);
  const [notifyTargets, setNotifyTargets] = useState<UserProfile[] | null>(null);
  const [resetPassUser, setResetPassUser] = useState<UserProfile | null>(null);

  // Missed-email backfill state
  const [backfillBusy, setBackfillBusy] = useState(false);
  const [backfillProgress, setBackfillProgress] = useState<{
    processed: number;
    total: number;
  } | null>(null);

  // Debounce search input for server-side queries
  useEffect(() => {
    const t = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 320);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Close quick action menu on outside click or Escape
  useEffect(() => {
    if (!openMenuUid) return;
    const handleOutside = (e: MouseEvent) => {
      if (
        menuContainerRef.current &&
        !menuContainerRef.current.contains(e.target as Node)
      ) {
        setOpenMenuUid(null);
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpenMenuUid(null);
    };
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleEsc);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleEsc);
    };
  }, [openMenuUid]);

  const loadSummary = useCallback(async () => {
    setSummaryLoading(true);
    try {
      const [metrics, rateLabel] = await Promise.all([
        fetchDirectorySummaryMetrics(perms.isSuperAdmin),
        fetchGlobalCommissionLabel(),
      ]);
      setSummary(metrics);
      setGlobalRateLabel(rateLabel);
    } catch (err) {
      console.warn('Summary load warning:', err);
    } finally {
      setSummaryLoading(false);
    }
  }, [perms.isSuperAdmin]);

  const loadFirstPage = useCallback(
    async (isManualRefresh = false) => {
      setLoading(true);
      setLoadError(null);
      setSelectedUids(new Set());
      setOpenMenuUid(null);

      try {
        const res = await fetchDirectoryPage({
          tab: activeTab,
          teamRoleFilter,
          statusFilter,
          sortKey,
          searchQuery: debouncedSearch,
          filters,
          cursor: null,
          perms,
        });
        setRows(res.items);
        setLastCursor(res.lastCursor);
        setHasMore(res.hasMore);
        setIsSearchMode(res.isSearchMode);
        if (isManualRefresh) {
          showToast('Directory refreshed', 'success');
        }
      } catch (err: any) {
        console.error('Error loading directory page:', err);
        setLoadError(
          err?.message || 'Unable to load directory accounts. Please retry.'
        );
        if (isManualRefresh) {
          showToast('Failed to refresh directory', 'error');
        }
      } finally {
        setLoading(false);
      }
    },
    [
      activeTab,
      teamRoleFilter,
      statusFilter,
      sortKey,
      debouncedSearch,
      filters,
      perms,
      showToast,
    ]
  );

  const handleLoadMore = async () => {
    if (loadingMore || !hasMore || !lastCursor) return;
    setLoadingMore(true);
    try {
      const res = await fetchDirectoryPage({
        tab: activeTab,
        teamRoleFilter,
        statusFilter,
        sortKey,
        searchQuery: debouncedSearch,
        filters,
        cursor: lastCursor,
        perms,
      });
      setRows((prev) => {
        const existing = new Set(prev.map((r) => r.user.uid));
        const nextNew = res.items.filter((r) => !existing.has(r.user.uid));
        return [...prev, ...nextNew];
      });
      setLastCursor(res.lastCursor);
      setHasMore(res.hasMore);
    } catch (err: any) {
      showToast(err?.message || 'Could not load more rows', 'error');
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    loadFirstPage(false);
  }, [loadFirstPage]);

  const handleRefreshAll = async () => {
    await Promise.all([loadSummary(), loadFirstPage(true)]);
  };

  usePageRefresh('resellers', handleRefreshAll);

  // Missed Status Email Backfill (among currently loaded resellers)
  const loadedUsersList = useMemo(() => rows.map((r) => r.user), [rows]);
  const missedEmailResellers = useMemo(
    () => loadedUsersList.filter(needsStatusEmailBackfill),
    [loadedUsersList]
  );

  const handleSendMissedEmails = async () => {
    if (backfillBusy || missedEmailResellers.length === 0) return;
    setBackfillBusy(true);
    setBackfillProgress({ processed: 0, total: missedEmailResellers.length });
    try {
      const result = await sendMissedResellerStatusEmails(loadedUsersList, (prog) => {
        setBackfillProgress({ processed: prog.processed, total: prog.total });
        if (prog.lastStatusEmailFor) {
          setRows((prev) =>
            prev.map((row) =>
              row.user.uid === prog.uid
                ? {
                    ...row,
                    user: {
                      ...row.user,
                      lastStatusEmailFor: prog.lastStatusEmailFor,
                    },
                  }
                : row
            )
          );
        }
      });
      showToast(
        `Status emails: ${result.sent} sent, ${result.skipped} skipped${
          result.failed > 0 ? `, ${result.failed} failed` : ''
        }.`,
        result.failed > 0 && result.sent === 0 ? 'error' : 'success'
      );
    } finally {
      setBackfillBusy(false);
      setBackfillProgress(null);
    }
  };

  // Selection helpers
  const selectableRows = useMemo(
    () => rows.filter((r) => !isProtectedSuperAdmin(r.user)),
    [rows]
  );

  const allVisibleSelected =
    selectableRows.length > 0 &&
    selectableRows.every((r) => selectedUids.has(r.user.uid));

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedUids(new Set());
    } else {
      setSelectedUids(new Set(selectableRows.map((r) => r.user.uid)));
    }
  };

  const toggleSelectRow = (uid: string) => {
    setSelectedUids((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  };

  const selectedRows = useMemo(
    () => rows.filter((r) => selectedUids.has(r.user.uid)),
    [rows, selectedUids]
  );
  const selectedUsers = useMemo(
    () => selectedRows.map((r) => r.user),
    [selectedRows]
  );

  // Actions handlers
  const handleCopyId = async (idText: string) => {
    try {
      await navigator.clipboard.writeText(idText);
      showToast(`Copied ${idText}`, 'success');
    } catch {
      showToast(`ID: ${idText}`, 'info');
    }
  };

  const handleConfirmSuspendOrActivate = async (params: {
    mode: 'suspend_temporary' | 'block_permanent' | 'activate';
    reason: string;
    suspendedUntil?: string;
  }) => {
    if (!currentUser || !suspendModalState) return;
    const res = await applySuspendOrActivate({
      targets: suspendModalState.targets,
      mode: params.mode,
      reason: params.reason,
      suspendedUntil: params.suspendedUntil,
      currentUser,
    });

    const updatedMap = new Map(res.updated.map((item) => [item.uid, item]));
    setRows((prev) =>
      prev.map((row) => {
        const upd = updatedMap.get(row.user.uid);
        if (!upd) return row;
        return {
          ...row,
          user: {
            ...row.user,
            status: upd.status,
            suspensionType: upd.suspensionType ?? undefined,
            suspensionReason: upd.suspensionReason ?? null,
            suspendedUntil: upd.suspendedUntil ?? null,
            ...(upd.lastStatusEmailFor
              ? { lastStatusEmailFor: upd.lastStatusEmailFor }
              : {}),
          },
        };
      })
    );

    if (drawerRow && updatedMap.has(drawerRow.user.uid)) {
      const upd = updatedMap.get(drawerRow.user.uid)!;
      setDrawerRow((prev) =>
        prev
          ? {
              ...prev,
              user: {
                ...prev.user,
                status: upd.status,
                suspensionType: upd.suspensionType ?? undefined,
                suspensionReason: upd.suspensionReason ?? null,
                suspendedUntil: upd.suspendedUntil ?? null,
              },
            }
          : null
      );
    }

    setSelectedUids(new Set());
    loadSummary();
    showToast(
      `Updated ${res.updated.length} account${res.updated.length === 1 ? '' : 's'}`,
      'success'
    );
  };

  const handleSaveCustomCommission = async (rate: number | null) => {
    if (!currentUser || !commissionModalUser) return;
    await updateCustomCommissionRate(commissionModalUser, rate, currentUser);
    setRows((prev) =>
      prev.map((row) =>
        row.user.uid === commissionModalUser.uid
          ? {
              ...row,
              user: {
                ...row.user,
                customCommissionRate: rate === null ? undefined : rate,
              },
            }
          : row
      )
    );
    showToast(
      rate === null
        ? 'Reverted to Global Commission Rate'
        : `Custom commission set to ${rate}%`,
      'success'
    );
  };

  const handleSendNotifications = async (payload: {
    title: string;
    message: string;
    type: 'general' | 'offer' | 'payment_notice' | 'maintenance';
    priority: 'normal' | 'high';
  }) => {
    if (!currentUser || !notifyTargets) return;
    const count = await sendTargetedNotifications(notifyTargets, payload, currentUser);
    setSelectedUids(new Set());
    showToast(`Notification sent to ${count} account${count === 1 ? '' : 's'}`, 'success');
  };

  const handleConfirmResetPassword = async () => {
    if (!currentUser || !resetPassUser) return;
    const res = await sendResellerPasswordResetCall(resetPassUser.uid);
    await logAuditAction(
      currentUser.uid,
      currentUser.fullName || currentUser.email || 'Super Admin',
      currentUser.role,
      'SEND_PASSWORD_RESET',
      resetPassUser.uid,
      `Sent password reset email to ${resetPassUser.email}`
    );
    showToast(res.message || 'Password reset email sent', 'success');
  };

  const handleExportCsv = async (targetRows: EnrichedDirectoryUser[]) => {
    if (!perms.isSuperAdmin || targetRows.length === 0) return;
    exportDirectoryCsv(targetRows, globalRateLabel);
    if (currentUser) {
      await logAuditAction(
        currentUser.uid,
        currentUser.fullName || currentUser.email || 'Super Admin',
        currentUser.role,
        'EXPORT_DIRECTORY_CSV',
        null,
        `Exported ${targetRows.length} directory records to CSV`
      ).catch(() => {});
    }
    showToast(`Exported ${targetRows.length} rows to CSV`, 'success');
  };

  const handlePrintList = () => {
    if (!perms.isSuperAdmin) return;
    window.print();
  };

  const activeAdvCount = countActiveAdvancedFilters(filters);

  const statusChips: Array<{
    key: DirectoryStatusFilter;
    label: string;
    count: number | null;
  }> = [
    {
      key: 'all',
      label: 'All',
      count: activeTab === 'resellers' ? summary?.totalResellers ?? null : summary?.teamCount ?? null,
    },
    {
      key: 'approved',
      label: 'Approved',
      count: activeTab === 'resellers' ? summary?.activeCount ?? null : null,
    },
    {
      key: 'pending',
      label: 'Pending',
      count: activeTab === 'resellers' ? summary?.pendingCount ?? null : null,
    },
    {
      key: 'suspended',
      label: 'Suspended',
      count: activeTab === 'resellers' ? summary?.suspendedCount ?? null : null,
    },
    {
      key: 'rejected',
      label: 'Rejected',
      count: activeTab === 'resellers' ? summary?.rejectedCount ?? null : null,
    },
  ];

  const renderQuickActionsMenu = (row: EnrichedDirectoryUser) => {
    const u = row.user;
    const isReseller = u.role === 'reseller';
    const protectedAdmin = isProtectedSuperAdmin(u);
    const idLabel = isReseller ? formatResellerId(u) : u.adminId || u.uid.slice(0, 8);
    const waHref = buildWhatsAppHref(u.whatsappNumber || u.whatsapp || u.mobile);

    return (
      <div
        ref={menuContainerRef}
        onClick={(e) => e.stopPropagation()}
        className="absolute right-0 top-9 z-40 w-52 rounded-xl bg-white/95 backdrop-blur-xl border border-slate-200 shadow-xl py-1.5 text-[12px] text-slate-700"
      >
        <button
          type="button"
          onClick={() => {
            setOpenMenuUid(null);
            setDrawerRow(row);
          }}
          className="w-full px-3 py-1.5 text-left hover:bg-slate-50 flex items-center gap-2 font-medium cursor-pointer"
        >
          <Eye className="w-3.5 h-3.5 text-slate-500" />
          <span>View profile</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setOpenMenuUid(null);
            setEditingUser(u);
          }}
          className="w-full px-3 py-1.5 text-left hover:bg-slate-50 flex items-center gap-2 font-medium cursor-pointer"
        >
          <Edit className="w-3.5 h-3.5 text-slate-500" />
          <span>Edit Details</span>
        </button>

        <button
          type="button"
          onClick={() => {
            setOpenMenuUid(null);
            handleCopyId(idLabel);
          }}
          className="w-full px-3 py-1.5 text-left hover:bg-slate-50 flex items-center gap-2 font-medium cursor-pointer"
        >
          <Copy className="w-3.5 h-3.5 text-slate-500" />
          <span>Copy {isReseller ? 'Reseller ID' : 'Admin ID'}</span>
        </button>

        {u.mobile && (
          <a
            href={`tel:${u.mobile}`}
            onClick={() => setOpenMenuUid(null)}
            className="w-full px-3 py-1.5 text-left hover:bg-slate-50 flex items-center gap-2 font-medium"
          >
            <Phone className="w-3.5 h-3.5 text-slate-500" />
            <span>Call ({u.mobile})</span>
          </a>
        )}

        {waHref && (
          <a
            href={waHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpenMenuUid(null)}
            className="w-full px-3 py-1.5 text-left hover:bg-slate-50 flex items-center gap-2 font-medium text-emerald-700"
          >
            <MessageCircle className="w-3.5 h-3.5" />
            <span>WhatsApp chat</span>
          </a>
        )}

        {perms.canSendNotifications && (
          <button
            type="button"
            onClick={() => {
              setOpenMenuUid(null);
              setNotifyTargets([u]);
            }}
            className="w-full px-3 py-1.5 text-left hover:bg-slate-50 flex items-center gap-2 font-medium cursor-pointer"
          >
            <Bell className="w-3.5 h-3.5 text-[#0E9AA7]" />
            <span>Send notification</span>
          </button>
        )}

        {isReseller && perms.canManageCommission && (
          <button
            type="button"
            onClick={() => {
              setOpenMenuUid(null);
              setCommissionModalUser(u);
            }}
            className="w-full px-3 py-1.5 text-left hover:bg-slate-50 flex items-center gap-2 font-medium cursor-pointer"
          >
            <Percent className="w-3.5 h-3.5 text-[#0E9AA7]" />
            <span>Set custom commission</span>
          </button>
        )}

        {!protectedAdmin && perms.canModerate && (
          <>
            <div className="my-1 border-t border-slate-100" />
            {u.status === 'suspended' || u.status === 'pending' ? (
              <button
                type="button"
                onClick={() => {
                  setOpenMenuUid(null);
                  setSuspendModalState({ targets: [u], mode: 'activate' });
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-emerald-50 text-emerald-700 flex items-center gap-2 font-semibold cursor-pointer"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>{u.status === 'pending' ? 'Approve account' : 'Activate account'}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => {
                  setOpenMenuUid(null);
                  setSuspendModalState({
                    targets: [u],
                    mode: 'suspend_temporary',
                  });
                }}
                className="w-full px-3 py-1.5 text-left hover:bg-rose-50 text-rose-700 flex items-center gap-2 font-semibold cursor-pointer"
              >
                <Ban className="w-3.5 h-3.5" />
                <span>Suspend / Block</span>
              </button>
            )}
          </>
        )}

        {perms.isSuperAdmin && !protectedAdmin && (
          <button
            type="button"
            onClick={() => {
              setOpenMenuUid(null);
              setResetPassUser(u);
            }}
            className="w-full px-3 py-1.5 text-left hover:bg-amber-50 text-amber-700 flex items-center gap-2 font-medium cursor-pointer"
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>Reset password email</span>
          </button>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-3.5 pb-20">
      {/* Compact Header */}
      <div className="print:hidden flex flex-wrap items-center justify-between gap-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-[16px] font-extrabold text-[#04203F] tracking-tight">
              {activeTab === 'resellers' ? 'Reseller Directory' : 'Admin & Team Directory'}
            </h2>
            {perms.isSuperAdmin && (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-md bg-slate-900 text-white">
                <Shield className="w-2.5 h-2.5 text-[#3DD055]" />
                Super Admin
              </span>
            )}
          </div>
          <p className="text-[12px] text-slate-500">
            Search, filter, audit, and manage partner accounts with live telemetry.
          </p>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {perms.isSuperAdmin && (
            <>
              <button
                type="button"
                onClick={() => handleExportCsv(rows)}
                disabled={rows.length === 0}
                className="h-[34px] px-3 rounded-xl border border-slate-200 bg-white/90 hover:bg-slate-50 text-slate-700 text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                title="Export filtered list to CSV"
              >
                <Download className="w-3.5 h-3.5 text-[#0E9AA7]" />
                <span className="hidden sm:inline">Export CSV</span>
              </button>
              <button
                type="button"
                onClick={handlePrintList}
                disabled={rows.length === 0}
                className="h-[34px] px-3 rounded-xl border border-slate-200 bg-white/90 hover:bg-slate-50 text-slate-700 text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                title="Print directory view"
              >
                <Printer className="w-3.5 h-3.5 text-slate-500" />
                <span className="hidden sm:inline">Print</span>
              </button>
            </>
          )}

          <button
            type="button"
            onClick={() => refreshCurrentPage()}
            disabled={isRefreshing || loading}
            className="h-[34px] px-3 rounded-xl border border-slate-200 bg-white/90 hover:bg-slate-50 text-slate-700 text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            title="Refresh Directory"
          >
            <RotateCw
              className={`w-3.5 h-3.5 text-[#0E9AA7] ${
                isRefreshing || loading ? 'animate-spin' : ''
              }`}
            />
            <span className="hidden sm:inline">Refresh</span>
          </button>
        </div>
      </div>

      {/* Top Summary Strip */}
      <div className="print:hidden">
        <DirectorySummaryStrip
          metrics={summary}
          loading={summaryLoading}
          isSuperAdmin={perms.isSuperAdmin}
          activeStatus={activeTab === 'resellers' ? statusFilter : 'all'}
          onSelectStatus={(s) => {
            setActiveTab('resellers');
            setStatusFilter(s);
          }}
        />
      </div>

      {/* Missed Status Emails Backfill Banner (Preserved) */}
      {perms.canModerate && activeTab === 'resellers' && missedEmailResellers.length > 0 && (
        <div className="print:hidden bg-cyan-50/90 border border-[#0E9AA7]/35 rounded-xl px-3.5 py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-2.5">
          <div className="flex items-start sm:items-center gap-2 text-[12px] text-[#04203F]">
            <Mail className="w-4 h-4 text-[#0E9AA7] shrink-0 mt-0.5 sm:mt-0" />
            <span>
              <strong>
                {missedEmailResellers.length} reseller
                {missedEmailResellers.length === 1 ? '' : 's'}
              </strong>{' '}
              did not receive their current status email yet (আগে যাদের জিমেইলে স্ট্যাটাস মেইল যায়নি).
            </span>
          </div>
          <button
            type="button"
            onClick={handleSendMissedEmails}
            disabled={backfillBusy}
            className="h-[34px] px-3.5 rounded-xl bg-[#04203F] hover:bg-[#073363] text-white text-[12px] font-bold inline-flex items-center justify-center gap-1.5 shrink-0 cursor-pointer disabled:opacity-60"
          >
            <Mail className="w-3.5 h-3.5" />
            <span>
              {backfillBusy && backfillProgress
                ? `Sending ${backfillProgress.processed}/${backfillProgress.total}...`
                : `Send Missing Emails (${missedEmailResellers.length})`}
            </span>
          </button>
        </div>
      )}

      {/* Slim Unified Toolbar */}
      <div className="print:hidden rounded-xl bg-white/85 backdrop-blur-md border border-slate-200/85 p-2.5 space-y-2">
        <div className="flex flex-col md:flex-row md:items-center gap-2">
          {/* Search Input */}
          <div className="relative flex-1 min-w-0">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Search ID, name, shop, phone, email, city..."
              className="w-full h-[36px] pl-8 pr-8 rounded-xl border border-slate-200 bg-slate-50/70 text-[12px] text-slate-800 placeholder:text-slate-400 outline-none focus:bg-white focus:border-[#0E9AA7]"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700 cursor-pointer"
                aria-label="Clear search"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
          </div>

          {/* Role Segmented Control: Resellers vs Team */}
          <div className="inline-flex items-center p-0.5 rounded-xl bg-slate-100 border border-slate-200/70 shrink-0">
            <button
              type="button"
              onClick={() => setActiveTab('resellers')}
              className={`h-[32px] px-3 rounded-[10px] text-[12px] font-bold transition-colors cursor-pointer inline-flex items-center gap-1.5 ${
                activeTab === 'resellers'
                  ? 'bg-white text-[#04203F] shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Store className="w-3.5 h-3.5 text-[#0E9AA7]" />
              <span>Resellers</span>
              {summary && (
                <span className="text-[11px] font-semibold text-slate-400 tabular-nums">
                  {summary.totalResellers}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('team')}
              className={`h-[32px] px-3 rounded-[10px] text-[12px] font-bold transition-colors cursor-pointer inline-flex items-center gap-1.5 ${
                activeTab === 'team'
                  ? 'bg-white text-[#04203F] shadow-2xs'
                  : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Shield className="w-3.5 h-3.5 text-[#04203F]" />
              <span>Team</span>
              {summary && (
                <span className="text-[11px] font-semibold text-slate-400 tabular-nums">
                  {summary.teamCount}
                </span>
              )}
            </button>
          </div>

          {/* Sort + Filters */}
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="relative flex-1 sm:flex-none">
              <ArrowUpDown className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <select
                value={sortKey}
                onChange={(e) => setSortKey(e.target.value as DirectorySortKey)}
                className="w-full sm:w-auto h-[36px] pl-8 pr-7 rounded-xl border border-slate-200 bg-white text-[12px] font-semibold text-slate-700 outline-none focus:border-[#0E9AA7] cursor-pointer"
                aria-label="Sort users"
              >
                <option value="newest">Sort: Newest</option>
                <option value="name">Sort: Name (A–Z)</option>
                {perms.canViewWallet && activeTab === 'resellers' && (
                  <option value="balance">Sort: Wallet Balance</option>
                )}
                {activeTab === 'resellers' && (
                  <option value="orders">Sort: Total Orders</option>
                )}
                <option value="last_active">Sort: Last Active</option>
              </select>
            </div>

            {activeTab === 'resellers' && (
              <button
                type="button"
                onClick={() => setIsFiltersOpen(true)}
                className={`h-[36px] px-3 rounded-xl border text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer shrink-0 ${
                  activeAdvCount > 0
                    ? 'border-[#0E9AA7] bg-cyan-50/70 text-[#04203F]'
                    : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                <Filter className="w-3.5 h-3.5 text-[#0E9AA7]" />
                <span>Filters</span>
                {activeAdvCount > 0 && (
                  <span className="px-1.5 py-0.2 rounded-md bg-[#04203F] text-white text-[10px] font-bold tabular-nums">
                    {activeAdvCount}
                  </span>
                )}
              </button>
            )}
          </div>
        </div>

        {/* Status Chips Row (or Team Sub-Role Pills) */}
        <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-slate-100">
          <div className="flex flex-wrap items-center gap-1.5">
            {statusChips.map((chip) => {
              const active = statusFilter === chip.key;
              return (
                <button
                  key={chip.key}
                  type="button"
                  onClick={() => setStatusFilter(chip.key)}
                  className={`h-[30px] px-2.5 rounded-lg text-[12px] font-semibold inline-flex items-center gap-1.5 transition-colors cursor-pointer ${
                    active
                      ? 'bg-[#04203F] text-white'
                      : 'bg-slate-50 text-slate-600 border border-slate-200/80 hover:bg-slate-100'
                  }`}
                >
                  <span>{chip.label}</span>
                  {chip.count !== null && (
                    <span
                      className={`text-[11px] tabular-nums ${
                        active ? 'text-cyan-200' : 'text-slate-400'
                      }`}
                    >
                      {chip.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {activeTab === 'team' && (
            <div className="flex items-center gap-1">
              {(
                [
                  { key: 'all', label: 'All Team' },
                  { key: 'admin', label: 'Admins' },
                  { key: 'super_admin', label: 'Super Admin' },
                ] as const
              ).map((sub) => (
                <button
                  key={sub.key}
                  type="button"
                  onClick={() => setTeamRoleFilter(sub.key)}
                  className={`h-[28px] px-2.5 rounded-lg text-[11px] font-bold cursor-pointer ${
                    teamRoleFilter === sub.key
                      ? 'bg-[#0E9AA7] text-white'
                      : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                  }`}
                >
                  {sub.label}
                </button>
              ))}
            </div>
          )}

          {activeAdvCount > 0 && activeTab === 'resellers' && (
            <button
              type="button"
              onClick={() => setFilters(DEFAULT_DIRECTORY_FILTERS)}
              className="text-[11px] font-semibold text-[#0E9AA7] hover:underline cursor-pointer"
            >
              Clear {activeAdvCount} filter{activeAdvCount === 1 ? '' : 's'}
            </button>
          )}
        </div>
      </div>

      {/* Main Content: Error / Skeleton / Empty / List */}
      {loadError ? (
        <div className="print:hidden rounded-xl bg-white/90 border border-rose-200 p-8 text-center space-y-3">
          <AlertTriangle className="w-8 h-8 text-rose-500 mx-auto" />
          <div>
            <h3 className="text-[15px] font-bold text-slate-900">
              Could not load directory
            </h3>
            <p className="text-[12px] text-slate-500 mt-0.5">{loadError}</p>
          </div>
          <button
            type="button"
            onClick={() => loadFirstPage(false)}
            className="h-[36px] px-4 rounded-xl bg-[#04203F] text-white text-[12px] font-bold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Retry</span>
          </button>
        </div>
      ) : loading ? (
        <div className="print:hidden rounded-xl bg-white/85 border border-slate-200/85 overflow-hidden divide-y divide-slate-100">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className="min-h-[60px] px-4 py-3 flex items-center justify-between gap-3 animate-pulse"
            >
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-xl bg-slate-200 shrink-0" />
                <div className="space-y-1.5">
                  <div className="h-3.5 w-40 bg-slate-200 rounded" />
                  <div className="h-2.5 w-28 bg-slate-100 rounded" />
                </div>
              </div>
              <div className="hidden sm:flex items-center gap-6">
                <div className="h-3 w-20 bg-slate-100 rounded" />
                <div className="h-3 w-16 bg-slate-200 rounded" />
                <div className="h-6 w-16 bg-slate-100 rounded-full" />
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="print:hidden rounded-xl bg-white/85 border border-slate-200/85 p-10 text-center space-y-2.5">
          <Users className="w-9 h-9 text-slate-300 mx-auto" />
          <div>
            <h3 className="text-[15px] font-bold text-slate-900">No matching accounts</h3>
            <p className="text-[12px] text-slate-500 mt-0.5">
              Try adjusting your search query, status filter, or advanced filter criteria.
            </p>
          </div>
          {(searchInput || statusFilter !== 'all' || activeAdvCount > 0) && (
            <button
              type="button"
              onClick={() => {
                setSearchInput('');
                setStatusFilter('all');
                setFilters(DEFAULT_DIRECTORY_FILTERS);
              }}
              className="h-[34px] px-3.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-[12px] font-semibold cursor-pointer"
            >
              Reset All Filters
            </button>
          )}
        </div>
      ) : (
        <>
          {/* DESKTOP: Clean Compact Sortable List (Sticky Header, 56-64px rows) */}
          <div className="print:hidden hidden lg:block rounded-xl bg-white/90 backdrop-blur-md border border-slate-200/85 shadow-xs overflow-visible">
            {/* Sticky Header Row */}
            <div className="sticky top-0 z-20 bg-slate-50/95 backdrop-blur-md border-b border-slate-200/80 rounded-t-xl px-3.5 py-2.5 grid grid-cols-12 gap-3 items-center text-[11px] font-bold uppercase tracking-wider text-slate-500">
              <div className="col-span-4 flex items-center gap-2.5">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  onChange={toggleSelectAll}
                  disabled={selectableRows.length === 0}
                  className="w-4 h-4 accent-[#04203F] rounded cursor-pointer"
                  aria-label="Select all visible rows"
                />
                <button
                  type="button"
                  onClick={() => setSortKey(sortKey === 'name' ? 'newest' : 'name')}
                  className="inline-flex items-center gap-1 hover:text-slate-900 cursor-pointer"
                >
                  <span>Account & Shop</span>
                  <ArrowUpDown className="w-3 h-3" />
                </button>
              </div>
              <div className="col-span-2">Contact & Area</div>
              <div className="col-span-2 text-right">
                {activeTab === 'resellers' ? (
                  <button
                    type="button"
                    onClick={() =>
                      perms.canViewWallet &&
                      setSortKey(sortKey === 'balance' ? 'orders' : 'balance')
                    }
                    className="inline-flex items-center justify-end gap-1 hover:text-slate-900 cursor-pointer ml-auto"
                  >
                    <span>{perms.canViewWallet ? 'Wallet & Orders' : 'Orders & Rate'}</span>
                    <ArrowUpDown className="w-3 h-3" />
                  </button>
                ) : (
                  <span>Permissions</span>
                )}
              </div>
              <div className="col-span-2">
                <button
                  type="button"
                  onClick={() =>
                    setSortKey(sortKey === 'last_active' ? 'newest' : 'last_active')
                  }
                  className="inline-flex items-center gap-1 hover:text-slate-900 cursor-pointer"
                >
                  <span>Activity & Joined</span>
                  <ArrowUpDown className="w-3 h-3" />
                </button>
              </div>
              <div className="col-span-2 text-right">Status & Actions</div>
            </div>

            {/* Slim Rows */}
            <div className="divide-y divide-slate-100">
              {rows.map((row) => {
                const u = row.user;
                const isReseller = u.role === 'reseller';
                const protectedAdmin = isProtectedSuperAdmin(u);
                const idLabel = isReseller
                  ? formatResellerId(u)
                  : u.adminId || u.uid.slice(0, 8);
                const isSelected = selectedUids.has(u.uid);

                return (
                  <div
                    key={u.uid}
                    onClick={() => setDrawerRow(row)}
                    className={`min-h-[62px] px-3.5 py-2 grid grid-cols-12 gap-3 items-center transition-colors duration-150 cursor-pointer ${
                      isSelected ? 'bg-cyan-50/50' : 'hover:bg-slate-50/80'
                    }`}
                  >
                    {/* Col 1-4: Avatar, Name, ID, Shop, Email Verified, Warnings */}
                    <div className="col-span-4 flex items-center gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={protectedAdmin}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelectRow(u.uid)}
                        className="w-4 h-4 accent-[#04203F] rounded cursor-pointer disabled:opacity-30 shrink-0"
                        aria-label={`Select ${u.fullName}`}
                      />
                      {u.profilePhotoUrl ? (
                        <img
                          src={u.profilePhotoUrl}
                          alt={u.fullName}
                          onClick={(e) => {
                            e.stopPropagation();
                            setLightboxState({
                              url: u.profilePhotoUrl,
                              title: `${u.fullName} — Avatar`,
                            });
                          }}
                          className="w-9 h-9 rounded-xl object-cover border border-slate-200 shrink-0"
                        />
                      ) : (
                        <div className="w-9 h-9 rounded-xl bg-slate-100 border border-slate-200/80 flex items-center justify-center text-[#04203F] font-bold text-[13px] shrink-0">
                          {(u.fullName || 'U').charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[13px] font-bold text-slate-900 truncate">
                            {u.fullName || 'Unnamed'}
                          </span>
                          {u.emailVerified && (
                            <span title="Email verified">
                              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                            </span>
                          )}
                          {u.role !== 'reseller' && (
                            <span className="px-1.5 py-0.5 rounded-md bg-slate-900 text-white text-[9px] font-bold uppercase shrink-0">
                              {u.role === 'super_admin' ? 'Super' : 'Admin'}
                            </span>
                          )}
                        </div>
                        <div className="flex items-center gap-1.5 text-[11px] text-slate-500 truncate">
                          <span className="font-mono font-bold text-[#04203F]">{idLabel}</span>
                          {u.shopName && (
                            <>
                              <span>·</span>
                              <span className="font-semibold text-slate-700 truncate">
                                {u.shopName}
                              </span>
                            </>
                          )}
                        </div>
                        {row.warnings.length > 0 && (
                          <div className="flex flex-wrap items-center gap-1 mt-0.5">
                            {row.warnings.map((w) => (
                              <span
                                key={w}
                                className={`inline-flex items-center px-1.5 py-0.2 rounded border text-[9px] font-bold ${WARNING_BADGE_MAP[w].cls}`}
                              >
                                {WARNING_BADGE_MAP[w].label}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Col 5-6: Contact, City, Completeness */}
                    <div className="col-span-2 min-w-0 space-y-0.5 text-[12px]">
                      <div className="font-mono font-semibold text-slate-800 truncate tabular-nums">
                        {u.mobile || '—'}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {[u.upazila, u.district].filter(Boolean).join(', ') || 'Area not set'}
                      </div>
                      {isReseller && (
                        <div className="flex items-center gap-1.5 pt-0.5">
                          <div className="w-14 h-1 rounded-full bg-slate-200 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${
                                row.completeness.percent === 100
                                  ? 'bg-emerald-500'
                                  : row.completeness.percent >= 66
                                  ? 'bg-[#0E9AA7]'
                                  : 'bg-amber-500'
                              }`}
                              style={{ width: `${row.completeness.percent}%` }}
                            />
                          </div>
                          <span className="text-[10px] font-semibold text-slate-400 tabular-nums">
                            {row.completeness.percent}%
                          </span>
                        </div>
                      )}
                    </div>

                    {/* Col 7-8: Wallet / Commission / Orders OR Team Permissions */}
                    <div className="col-span-2 text-right space-y-0.5 text-[12px]">
                      {isReseller ? (
                        <>
                          {perms.canViewWallet ? (
                            <div className="font-mono font-bold text-[#04203F] tabular-nums">
                              ৳{Math.round(row.walletBalance ?? 0).toLocaleString()}
                              {row.totalCommissionEarned !== null && row.totalCommissionEarned > 0 && (
                                <span className="text-[10px] font-normal text-slate-400 ml-1">
                                  (৳{Math.round(row.totalCommissionEarned).toLocaleString()} comm)
                                </span>
                              )}
                            </div>
                          ) : (
                            <div className="text-[11px] text-slate-400">Wallet restricted</div>
                          )}
                          <div className="text-[11px] text-slate-600 tabular-nums">
                            {row.totalOrders} orders · {row.deliveredOrders} deliv
                          </div>
                          <div className="text-[10px] font-semibold text-[#0E9AA7]">
                            {u.customCommissionRate !== undefined &&
                            u.customCommissionRate !== null
                              ? `${u.customCommissionRate}% Custom`
                              : globalRateLabel}
                          </div>
                        </>
                      ) : (
                        <div className="text-[11px] text-slate-600">
                          {protectedAdmin
                            ? 'Full Owner Access'
                            : `${Array.isArray(u.permissions) ? u.permissions.length : 0} permissions`}
                        </div>
                      )}
                    </div>

                    {/* Col 9-10: Last Active, Device, Joined */}
                    <div className="col-span-2 min-w-0 space-y-0.5 text-[11px]">
                      <div className="font-semibold text-slate-800 tabular-nums">
                        {row.lastActiveMs ? formatRelativeTime(row.lastActiveMs) : 'No activity'}
                      </div>
                      <div className="text-slate-500 truncate">
                        {row.lastDeviceLabel || 'Device unknown'}
                      </div>
                      <div className="text-slate-400 tabular-nums">
                        Reg{' '}
                        {parseTsMs(u.createdAt)
                          ? new Date(parseTsMs(u.createdAt)!).toLocaleDateString('en-GB', {
                              day: '2-digit',
                              month: 'short',
                              year: '2-digit',
                            })
                          : '—'}
                      </div>
                    </div>

                    {/* Col 11-12: Status + 3-Dot Quick Actions */}
                    <div className="col-span-2 flex items-center justify-end gap-1.5 relative">
                      <div className="flex flex-col items-end gap-0.5">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${getStatusChipClasses(
                            u.status
                          )}`}
                        >
                          {u.status}
                        </span>
                        {row.pendingMinutes !== null && row.pendingMinutes >= 60 && (
                          <span className="text-[10px] font-bold text-rose-600 tabular-nums">
                            waiting {Math.floor(row.pendingMinutes / 60)}h+
                          </span>
                        )}
                      </div>

                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuUid((prev) => (prev === u.uid ? null : u.uid));
                        }}
                        className="w-8 h-8 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 flex items-center justify-center text-slate-600 cursor-pointer shrink-0"
                        aria-label="Quick actions"
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>

                      {openMenuUid === u.uid && renderQuickActionsMenu(row)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* MOBILE: Compact Cards (320px+ safe, zero horizontal scrolling) */}
          <div className="print:hidden lg:hidden space-y-2.5">
            {rows.map((row) => {
              const u = row.user;
              const isReseller = u.role === 'reseller';
              const protectedAdmin = isProtectedSuperAdmin(u);
              const idLabel = isReseller
                ? formatResellerId(u)
                : u.adminId || u.uid.slice(0, 8);
              const isSelected = selectedUids.has(u.uid);

              return (
                <div
                  key={u.uid}
                  onClick={() => setDrawerRow(row)}
                  className={`rounded-xl bg-white/90 backdrop-blur-md border p-3 space-y-2 transition-colors ${
                    isSelected
                      ? 'border-[#0E9AA7] bg-cyan-50/30'
                      : 'border-slate-200/85'
                  }`}
                >
                  {/* Top Row: Checkbox + Avatar + Name/Shop + Status + 3-dot Menu */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2.5 min-w-0 flex-1">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        disabled={protectedAdmin}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelectRow(u.uid)}
                        className="w-4 h-4 mt-1 accent-[#04203F] rounded cursor-pointer disabled:opacity-30 shrink-0"
                        aria-label={`Select ${u.fullName}`}
                      />
                      {u.profilePhotoUrl ? (
                        <img
                          src={u.profilePhotoUrl}
                          alt={u.fullName}
                          className="w-10 h-10 rounded-xl object-cover border border-slate-200 shrink-0"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-[#04203F] font-bold text-sm shrink-0">
                          {(u.fullName || 'U').charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1 min-w-0">
                          <span className="text-[13px] font-bold text-slate-900 truncate">
                            {u.fullName || 'Unnamed'}
                          </span>
                          {u.emailVerified && (
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                          )}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">
                          <span className="font-mono font-bold text-[#04203F]">
                            {idLabel}
                          </span>
                          {u.shopName ? ` · ${u.shopName}` : ''}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0 relative">
                      <span
                        className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-bold uppercase border ${getStatusChipClasses(
                          u.status
                        )}`}
                      >
                        {u.status}
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setOpenMenuUid((prev) => (prev === u.uid ? null : u.uid));
                        }}
                        className="w-8 h-8 rounded-xl border border-slate-200 bg-white flex items-center justify-center text-slate-600 cursor-pointer"
                        aria-label="Quick actions"
                      >
                        <MoreVertical className="w-4 h-4" />
                      </button>
                      {openMenuUid === u.uid && renderQuickActionsMenu(row)}
                    </div>
                  </div>

                  {/* Contact + City + Direct Call Button */}
                  <div className="flex items-center justify-between gap-2 text-[12px] pt-1 border-t border-slate-100">
                    <div className="min-w-0 flex items-center gap-2 text-slate-600 truncate">
                      <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="truncate">
                        {[u.upazila, u.district].filter(Boolean).join(', ') || 'No city'}
                      </span>
                    </div>
                    {u.mobile && (
                      <a
                        href={`tel:${u.mobile}`}
                        onClick={(e) => e.stopPropagation()}
                        className="h-[30px] px-2.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-[#04203F] font-mono text-[11px] font-bold inline-flex items-center gap-1 shrink-0 tabular-nums"
                      >
                        <Phone className="w-3 h-3 text-[#0E9AA7]" />
                        <span>Call</span>
                      </a>
                    )}
                  </div>

                  {/* Key Numbers Grid */}
                  {isReseller && (
                    <div className="grid grid-cols-3 gap-2 rounded-xl bg-slate-50/90 border border-slate-200/60 px-2.5 py-2 text-[11px]">
                      <div>
                        <span className="text-[10px] text-slate-400 block">Wallet</span>
                        <span className="font-mono font-bold text-[#04203F] tabular-nums">
                          {perms.canViewWallet
                            ? `৳${Math.round(row.walletBalance ?? 0).toLocaleString()}`
                            : 'Restricted'}
                        </span>
                      </div>
                      <div>
                        <span className="text-[10px] text-slate-400 block">Orders</span>
                        <span className="font-bold text-slate-800 tabular-nums">
                          {row.totalOrders} ({row.deliveredOrders} del)
                        </span>
                      </div>
                      <div className="text-right">
                        <span className="text-[10px] text-slate-400 block">Active</span>
                        <span className="font-semibold text-slate-700 tabular-nums">
                          {row.lastActiveMs ? formatRelativeTime(row.lastActiveMs) : '—'}
                        </span>
                      </div>
                    </div>
                  )}

                  {/* Warnings & Completeness Footer */}
                  {isReseller && (row.warnings.length > 0 || row.completeness.percent < 100) && (
                    <div className="flex flex-wrap items-center justify-between gap-1.5 text-[10px]">
                      <div className="flex items-center gap-1.5">
                        <div className="w-12 h-1 rounded-full bg-slate-200 overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              row.completeness.percent === 100
                                ? 'bg-emerald-500'
                                : 'bg-[#0E9AA7]'
                            }`}
                            style={{ width: `${row.completeness.percent}%` }}
                          />
                        </div>
                        <span className="text-slate-500 font-semibold tabular-nums">
                          {row.completeness.percent}% profile
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {row.warnings.map((w) => (
                          <span
                            key={w}
                            className={`px-1.5 py-0.2 rounded border font-bold ${WARNING_BADGE_MAP[w].cls}`}
                          >
                            {WARNING_BADGE_MAP[w].label}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Load More Pagination */}
          {hasMore && !isSearchMode && (
            <div className="print:hidden flex justify-center pt-1">
              <button
                type="button"
                onClick={handleLoadMore}
                disabled={loadingMore}
                className="h-[38px] px-5 rounded-xl border border-slate-200 bg-white/90 hover:bg-slate-50 text-[#04203F] text-[12px] font-bold inline-flex items-center gap-2 cursor-pointer disabled:opacity-50 shadow-2xs"
              >
                {loadingMore ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin text-[#0E9AA7]" />
                    <span>Loading more...</span>
                  </>
                ) : (
                  <span>Load More Accounts</span>
                )}
              </button>
            </div>
          )}
        </>
      )}

      {/* Floating Bulk Actions Bar */}
      {selectedUids.size > 0 && (
        <div className="print:hidden fixed bottom-4 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-24px)] max-w-2xl rounded-xl bg-[#04203F] text-white shadow-2xl border border-white/15 px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="inline-flex items-center justify-center w-6 h-6 rounded-lg bg-[#0E9AA7] text-white font-bold tabular-nums">
              {selectedUids.size}
            </span>
            <span className="font-semibold">selected</span>
            <button
              type="button"
              onClick={() => setSelectedUids(new Set())}
              className="text-slate-300 hover:text-white underline text-[11px] cursor-pointer"
            >
              Clear
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {perms.canSendNotifications && (
              <button
                type="button"
                onClick={() => setNotifyTargets(selectedUsers)}
                className="h-[34px] px-3 rounded-xl bg-white/10 hover:bg-white/20 text-white text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Bell className="w-3.5 h-3.5" />
                <span>Notify</span>
              </button>
            )}

            {perms.isSuperAdmin && (
              <button
                type="button"
                onClick={() => handleExportCsv(selectedRows)}
                className="h-[34px] px-3 rounded-xl bg-white/10 hover:bg-white/20 text-white text-[12px] font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                <span>Export</span>
              </button>
            )}

            {perms.canModerate && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    setSuspendModalState({
                      targets: selectedUsers,
                      mode: 'activate',
                    })
                  }
                  className="h-[34px] px-3 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-white text-[12px] font-bold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  <span>Activate</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setSuspendModalState({
                      targets: selectedUsers,
                      mode: 'suspend_temporary',
                    })
                  }
                  className="h-[34px] px-3 rounded-xl bg-rose-500 hover:bg-rose-600 text-white text-[12px] font-bold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Ban className="w-3.5 h-3.5" />
                  <span>Suspend</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* Clean Print-Only Table (Super Admin, zero passwords/doc URLs) */}
      {perms.isSuperAdmin && (
        <div className="hidden print:block p-4 bg-white text-slate-900">
          <h1 className="text-lg font-bold">
            ReSellBD Directory Export ({new Date().toLocaleDateString('en-GB')})
          </h1>
          <p className="text-xs text-slate-500 mb-3">
            Tab: {activeTab} · Status: {statusFilter} · Rows: {rows.length}
          </p>
          <table className="w-full text-left border-collapse text-[11px]">
            <thead>
              <tr className="border-b border-slate-300">
                <th className="py-1.5 pr-2">ID</th>
                <th className="py-1.5 pr-2">Name</th>
                <th className="py-1.5 pr-2">Shop</th>
                <th className="py-1.5 pr-2">Mobile</th>
                <th className="py-1.5 pr-2">City</th>
                <th className="py-1.5 pr-2 text-right">Wallet</th>
                <th className="py-1.5 pr-2 text-right">Orders</th>
                <th className="py-1.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.user.uid} className="border-b border-slate-200">
                  <td className="py-1 pr-2 font-mono">
                    {r.user.role === 'reseller'
                      ? formatResellerId(r.user)
                      : r.user.adminId || r.user.uid.slice(0, 8)}
                  </td>
                  <td className="py-1 pr-2">{r.user.fullName}</td>
                  <td className="py-1 pr-2">{r.user.shopName || '—'}</td>
                  <td className="py-1 pr-2 font-mono">{r.user.mobile}</td>
                  <td className="py-1 pr-2">
                    {[r.user.upazila, r.user.district].filter(Boolean).join(', ')}
                  </td>
                  <td className="py-1 pr-2 text-right font-mono">
                    ৳{Math.round(r.walletBalance ?? 0).toLocaleString()}
                  </td>
                  <td className="py-1 pr-2 text-right">{r.totalOrders}</td>
                  <td className="py-1 uppercase">{r.user.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Advanced Filters Side Sheet */}
      <DirectoryFiltersSheet
        isOpen={isFiltersOpen}
        onClose={() => setIsFiltersOpen(false)}
        filters={filters}
        onApply={(next) => setFilters(next)}
      />

      {/* Detail Drawer */}
      <ResellerDetailDrawer
        isOpen={Boolean(drawerRow)}
        row={drawerRow}
        currentUser={currentUser}
        perms={perms}
        globalRateLabel={globalRateLabel}
        onClose={() => setDrawerRow(null)}
        onOpenLightbox={(url, title) => setLightboxState({ url, title })}
        onOpenEdit={(u) => setEditingUser(u)}
        onOpenSuspendOrActivate={(u, mode) =>
          setSuspendModalState({ targets: [u], mode })
        }
        onOpenCommission={(u) => setCommissionModalUser(u)}
        onOpenNotify={(u) => setNotifyTargets([u])}
        onOpenResetPassword={(u) => setResetPassUser(u)}
        onCopyId={handleCopyId}
      />

      {/* Existing Edit User Modal */}
      <EditUserModal
        isOpen={Boolean(editingUser)}
        onClose={() => setEditingUser(null)}
        targetUser={editingUser}
        currentUser={currentUser}
        onUserUpdated={() => {
          loadSummary();
          loadFirstPage(false);
        }}
      />

      {/* Action Modals */}
      <SuspendActivateModal
        isOpen={Boolean(suspendModalState)}
        onClose={() => setSuspendModalState(null)}
        targets={suspendModalState?.targets || []}
        initialMode={suspendModalState?.mode || 'suspend_temporary'}
        onConfirm={handleConfirmSuspendOrActivate}
      />

      <CustomCommissionModal
        isOpen={Boolean(commissionModalUser)}
        onClose={() => setCommissionModalUser(null)}
        targetUser={commissionModalUser}
        globalRateLabel={globalRateLabel}
        onSave={handleSaveCustomCommission}
      />

      <SendNotificationModal
        isOpen={Boolean(notifyTargets)}
        onClose={() => setNotifyTargets(null)}
        targets={notifyTargets || []}
        onSend={handleSendNotifications}
      />

      <ResetPasswordConfirmModal
        isOpen={Boolean(resetPassUser)}
        onClose={() => setResetPassUser(null)}
        targetUser={resetPassUser}
        onConfirm={handleConfirmResetPassword}
      />

      {/* Tap-to-zoom Image Lightbox */}
      <DocumentLightboxModal
        url={lightboxState?.url || null}
        title={lightboxState?.title || 'Document Preview'}
        onClose={() => setLightboxState(null)}
      />
    </div>
  );
};
