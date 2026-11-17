import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  documentId,
  getAggregateFromServer,
  getCountFromServer,
  getDoc,
  getDocs,
  limit,
  orderBy,
  QueryConstraint,
  QueryDocumentSnapshot,
  DocumentData,
  query,
  serverTimestamp,
  startAfter,
  sum,
  Timestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { db } from './firebase';
import { logAuditAction } from './auditLogger';
import { formatResellerId } from './resellerIdHelper';
import { notifyResellerStatusEmail } from './resellerStatusEmailService';
import { normalizeShopName } from '../utils/shopName';
import {
  collectPayoutMethods,
  parseTsMs,
} from '../components/admin/approvals/resellerApprovalUtils';
import {
  fetchUserDevices,
  fetchUserLoginHistory,
  DeviceItem,
  LoginHistoryItem,
} from './deviceSecurity';
import {
  AuditLog,
  CommissionSettings,
  Order,
  UserProfile,
  UserRole,
  UserStatus,
  Wallet,
  WalletTransaction,
} from '../types';

export const SOLE_SUPER_ADMIN_EMAIL = 'skyautomationtech@gmail.com';
export const DIRECTORY_PAGE_SIZE = 25;

export type DirectoryTab = 'resellers' | 'team';
export type TeamRoleFilter = 'all' | 'admin' | 'super_admin';
export type DirectoryStatusFilter = 'all' | 'approved' | 'pending' | 'suspended' | 'rejected';
export type DirectorySortKey = 'newest' | 'name' | 'balance' | 'orders' | 'last_active';

export interface DirectoryAdvancedFilters {
  district: string;
  upazila: string;
  commissionType: 'all' | 'global' | 'custom';
  hasOrders: 'all' | 'yes' | 'no';
  inactiveDays: 'all' | '7' | '30';
  payoutMethod: 'all' | 'bkash' | 'nagad' | 'rocket' | 'upay' | 'bank' | 'none';
  documentsMissing: boolean;
  joinedFrom: string;
  joinedTo: string;
}

export const DEFAULT_DIRECTORY_FILTERS: DirectoryAdvancedFilters = {
  district: '',
  upazila: '',
  commissionType: 'all',
  hasOrders: 'all',
  inactiveDays: 'all',
  payoutMethod: 'all',
  documentsMissing: false,
  joinedFrom: '',
  joinedTo: '',
};

export interface ResellerSummaryMetrics {
  totalResellers: number;
  activeCount: number;
  pendingCount: number;
  pendingOver1hCount: number;
  suspendedCount: number;
  rejectedCount: number;
  newThisWeekCount: number;
  teamCount: number;
  totalWalletBalance: number | null;
}

export type ResellerWarningTag =
  | 'duplicate_phone'
  | 'duplicate_nid'
  | 'failed_logins'
  | 'payout_changed_recently';

export interface ProfileCompleteness {
  percent: number;
  hasDocuments: boolean;
  hasPayout: boolean;
  hasAddress: boolean;
  missingLabels: string[];
}

export interface EnrichedDirectoryUser {
  user: UserProfile;
  walletBalance: number | null;
  totalCommissionEarned: number | null;
  totalOrders: number;
  deliveredOrders: number;
  lastActiveMs: number | null;
  lastDeviceLabel: string | null;
  completeness: ProfileCompleteness;
  warnings: ResellerWarningTag[];
  pendingMinutes: number | null;
}

export interface InternalAdminNote {
  id: string;
  text: string;
  authorUid: string;
  authorName: string;
  authorRole: UserRole;
  createdAt: any;
}

export interface DirectoryPermissions {
  isSuperAdmin: boolean;
  canModerate: boolean;
  canViewWallet: boolean;
  canViewKycAndPayout: boolean;
  canManageCommission: boolean;
  canSendNotifications: boolean;
}

export function getDirectoryPermissions(currentUser?: UserProfile): DirectoryPermissions {
  const isSuperAdmin = currentUser?.role === 'super_admin';
  const isAdmin = isSuperAdmin || currentUser?.role === 'admin';
  const perms = Array.isArray(currentUser?.permissions) ? currentUser!.permissions : [];

  return {
    isSuperAdmin,
    canModerate: isAdmin,
    canViewWallet: isSuperAdmin || perms.includes('manage_wallet'),
    canViewKycAndPayout: isSuperAdmin || perms.includes('approve_resellers'),
    canManageCommission: isSuperAdmin || perms.includes('manage_commission'),
    canSendNotifications: isSuperAdmin || perms.includes('send_notifications'),
  };
}

export function isProtectedSuperAdmin(u?: UserProfile | null): boolean {
  if (!u) return false;
  return (
    u.role === 'super_admin' ||
    (u.email || '').trim().toLowerCase() === SOLE_SUPER_ADMIN_EMAIL
  );
}

/**
 * Strips any sensitive password fields before storing in client state.
 */
export function sanitizeUserDoc(id: string, raw: Record<string, any>): UserProfile {
  const clone: Record<string, any> = { ...raw, uid: raw.uid || id };
  delete clone.plainPassword;
  delete clone.password;
  delete clone.appLockPinHash;
  return clone as UserProfile;
}

export function computeProfileCompleteness(u: UserProfile): ProfileCompleteness {
  const docType = u.documentType || 'nid';
  const hasNidImgs = Boolean((u.nidFrontUrl && u.nidBackUrl) || u.nidUrl);
  const hasBirthImg = Boolean(u.birthCertificateUrl);
  const hasDocNumber = Boolean(
    (u.nidNumber && u.nidNumber.trim()) ||
      (u.birthCertificateNumber && u.birthCertificateNumber.trim())
  );
  const hasDocuments =
    docType === 'birth_certificate'
      ? hasBirthImg && hasDocNumber
      : hasNidImgs && hasDocNumber;

  const payouts = collectPayoutMethods(u);
  const hasPayout = payouts.length > 0;

  const hasAddress = Boolean(
    (u.division || '').trim() &&
      (u.district || '').trim() &&
      (u.upazila || '').trim() &&
      (u.address || '').trim()
  );

  const missingLabels: string[] = [];
  if (!hasDocuments) missingLabels.push('Documents');
  if (!hasPayout) missingLabels.push('Payout');
  if (!hasAddress) missingLabels.push('Address');

  const completedCount = [hasDocuments, hasPayout, hasAddress].filter(Boolean).length;
  const percent = Math.round((completedCount / 3) * 100);

  return {
    percent,
    hasDocuments,
    hasPayout,
    hasAddress,
    missingLabels,
  };
}

export function countActiveAdvancedFilters(filters: DirectoryAdvancedFilters): number {
  let count = 0;
  if (filters.district) count++;
  if (filters.upazila) count++;
  if (filters.commissionType !== 'all') count++;
  if (filters.hasOrders !== 'all') count++;
  if (filters.inactiveDays !== 'all') count++;
  if (filters.payoutMethod !== 'all') count++;
  if (filters.documentsMissing) count++;
  if (filters.joinedFrom) count++;
  if (filters.joinedTo) count++;
  return count;
}

export async function fetchGlobalCommissionLabel(): Promise<string> {
  try {
    const snap = await getDoc(doc(db, 'commissionSettings', 'global'));
    if (!snap.exists()) return 'Global';
    const data = snap.data() as CommissionSettings;
    if (data.defaultType === 'percentage') {
      return `Global · ${data.percentageValue ?? 10}%`;
    }
    if (data.defaultType === 'fixed') {
      return `Global · ৳${data.fixedValue ?? 100}/unit`;
    }
    return 'Global · Sell Margin';
  } catch {
    return 'Global';
  }
}

export async function fetchDirectorySummaryMetrics(
  isSuperAdmin: boolean
): Promise<ResellerSummaryMetrics> {
  const usersCol = collection(db, 'users');
  const oneHourAgoTs = Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
  const sevenDaysAgoTs = Timestamp.fromMillis(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const safeCount = async (qRef: ReturnType<typeof query>): Promise<number> => {
    try {
      const snap = await getCountFromServer(qRef);
      return snap.data().count;
    } catch {
      return -1;
    }
  };

  const [
    totalResellers,
    activeCount,
    pendingCount,
    suspendedCount,
    rejectedCount,
    teamCount,
    pendingOver1hDirect,
    newThisWeekDirect,
  ] = await Promise.all([
    safeCount(query(usersCol, where('role', '==', 'reseller'))),
    safeCount(query(usersCol, where('role', '==', 'reseller'), where('status', '==', 'approved'))),
    safeCount(query(usersCol, where('role', '==', 'reseller'), where('status', '==', 'pending'))),
    safeCount(query(usersCol, where('role', '==', 'reseller'), where('status', '==', 'suspended'))),
    safeCount(query(usersCol, where('role', '==', 'reseller'), where('status', '==', 'rejected'))),
    safeCount(query(usersCol, where('role', 'in', ['admin', 'super_admin']))),
    safeCount(
      query(
        usersCol,
        where('role', '==', 'reseller'),
        where('status', '==', 'pending'),
        where('createdAt', '<=', oneHourAgoTs)
      )
    ),
    safeCount(
      query(
        usersCol,
        where('role', '==', 'reseller'),
        where('createdAt', '>=', sevenDaysAgoTs)
      )
    ),
  ]);

  let pendingOver1hCount = pendingOver1hDirect;
  if (pendingOver1hCount < 0 && pendingCount > 0) {
    // Graceful fallback if composite index (role + status + createdAt) is not yet created
    try {
      const pSnap = await getDocs(
        query(usersCol, where('role', '==', 'reseller'), where('status', '==', 'pending'), limit(200))
      );
      const cutoff = Date.now() - 3600000;
      let over = 0;
      pSnap.forEach((d) => {
        const data = d.data();
        const ms = parseTsMs(data.pendingSince ?? data.submittedAt ?? data.createdAt);
        if (ms && ms <= cutoff) over++;
      });
      pendingOver1hCount = over;
    } catch {
      pendingOver1hCount = 0;
    }
  } else if (pendingOver1hCount < 0) {
    pendingOver1hCount = 0;
  }

  let newThisWeekCount = newThisWeekDirect;
  if (newThisWeekCount < 0) {
    try {
      const rSnap = await getDocs(
        query(usersCol, where('role', '==', 'reseller'), orderBy('createdAt', 'desc'), limit(150))
      );
      const cutoff = Date.now() - 7 * 86400000;
      let cnt = 0;
      rSnap.forEach((d) => {
        const ms = parseTsMs(d.data().createdAt);
        if (ms && ms >= cutoff) cnt++;
      });
      newThisWeekCount = cnt;
    } catch {
      newThisWeekCount = 0;
    }
  }

  let totalWalletBalance: number | null = null;
  if (isSuperAdmin) {
    try {
      const aggSnap = await getAggregateFromServer(collection(db, 'wallets'), {
        totalBalance: sum('balance'),
      });
      totalWalletBalance = Number(aggSnap.data().totalBalance || 0);
    } catch {
      try {
        const wSnap = await getDocs(collection(db, 'wallets'));
        let sumVal = 0;
        wSnap.forEach((d) => {
          sumVal += Number(d.data().balance || 0);
        });
        totalWalletBalance = sumVal;
      } catch {
        totalWalletBalance = 0;
      }
    }
  }

  return {
    totalResellers: Math.max(0, totalResellers),
    activeCount: Math.max(0, activeCount),
    pendingCount: Math.max(0, pendingCount),
    pendingOver1hCount: Math.max(0, pendingOver1hCount),
    suspendedCount: Math.max(0, suspendedCount),
    rejectedCount: Math.max(0, rejectedCount),
    newThisWeekCount: Math.max(0, newThisWeekCount),
    teamCount: Math.max(0, teamCount),
    totalWalletBalance,
  };
}

function toTitleCase(input: string): string {
  return input
    .trim()
    .split(/\s+/)
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : ''))
    .join(' ');
}

function matchesSearchClientSide(u: UserProfile, rawQuery: string): boolean {
  const q = rawQuery.trim().toLowerCase();
  if (!q) return true;
  const code = formatResellerId(u).toLowerCase();
  return (
    (u.fullName || '').toLowerCase().includes(q) ||
    (u.shopName || '').toLowerCase().includes(q) ||
    (u.mobile || '').toLowerCase().includes(q) ||
    (u.whatsappNumber || '').toLowerCase().includes(q) ||
    (u.email || '').toLowerCase().includes(q) ||
    (u.resellerId || '').toLowerCase().includes(q) ||
    (u.resellerCode || '').toLowerCase().includes(q) ||
    (u.adminId || '').toLowerCase().includes(q) ||
    code.includes(q) ||
    (u.district || '').toLowerCase().includes(q) ||
    (u.upazila || '').toLowerCase().includes(q)
  );
}

/**
 * Server-side multi-field search without reading the whole `users` collection.
 */
async function searchUsersServerSide(
  searchQuery: string,
  tab: DirectoryTab,
  teamRoleFilter: TeamRoleFilter,
  statusFilter: DirectoryStatusFilter
): Promise<UserProfile[]> {
  const usersCol = collection(db, 'users');
  const trimmed = searchQuery.trim();
  const upper = trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  const title = toTitleCase(trimmed);
  const digits = trimmed.replace(/\D/g, '');
  const shopKey = normalizeShopName(trimmed);

  const queries: Array<Promise<UserProfile[]>> = [];
  const runPrefixQuery = async (field: string, prefix: string): Promise<UserProfile[]> => {
    if (!prefix) return [];
    try {
      const snap = await getDocs(
        query(usersCol, where(field, '>=', prefix), where(field, '<=', prefix + '\uf8ff'), limit(20))
      );
      return snap.docs.map((d) => sanitizeUserDoc(d.id, d.data()));
    } catch {
      return [];
    }
  };

  const runExactQuery = async (field: string, value: string): Promise<UserProfile[]> => {
    if (!value) return [];
    try {
      const snap = await getDocs(query(usersCol, where(field, '==', value), limit(20)));
      return snap.docs.map((d) => sanitizeUserDoc(d.id, d.data()));
    } catch {
      return [];
    }
  };

  const idVariants = new Set<string>([upper]);
  if (upper.startsWith('RSB-')) {
    idVariants.add(`SGR-${upper}`);
  } else if (upper.startsWith('SGR-')) {
    const withoutSgr = upper.replace(/^SGR-/, '');
    if (withoutSgr) idVariants.add(withoutSgr);
  }

  if (upper.startsWith('SGR-') || upper.startsWith('RSB-') || upper.startsWith('ADM-') || upper.length <= 12) {
    idVariants.forEach((variant) => {
      queries.push(runPrefixQuery('resellerId', variant));
      queries.push(runPrefixQuery('resellerCode', variant));
      queries.push(runPrefixQuery('adminId', variant));
    });
  }
  if (digits.length >= 3) {
    queries.push(runPrefixQuery('mobile', digits));
    if (trimmed.startsWith('0')) {
      queries.push(runPrefixQuery('mobile', trimmed));
    }
    queries.push(runPrefixQuery('whatsappNumber', trimmed));
  }
  if (trimmed.includes('@') || /^[a-z0-9._-]+$/i.test(trimmed)) {
    queries.push(runPrefixQuery('email', lower));
  }
  if (shopKey.length >= 2) {
    queries.push(runPrefixQuery('shopNameKey', shopKey));
  }
  queries.push(runPrefixQuery('fullName', trimmed));
  if (title !== trimmed) {
    queries.push(runPrefixQuery('fullName', title));
  }
  queries.push(runPrefixQuery('shopName', trimmed));
  if (title !== trimmed) {
    queries.push(runPrefixQuery('shopName', title));
  }
  queries.push(runExactQuery('district', title));
  queries.push(runExactQuery('upazila', title));

  const batches = await Promise.all(queries);
  const byUid = new Map<string, UserProfile>();
  batches.flat().forEach((u) => {
    if (!byUid.has(u.uid)) {
      byUid.set(u.uid, u);
    }
  });

  // Fallback bounded scan of recent users only if server prefix queries yielded 0 (e.g. substring inside middle of name/shop)
  if (byUid.size === 0) {
    try {
      const roleConstraint =
        tab === 'team'
          ? where('role', 'in', ['admin', 'super_admin'])
          : where('role', '==', 'reseller');
      const recentSnap = await getDocs(query(usersCol, roleConstraint, limit(120)));
      recentSnap.forEach((d) => {
        const u = sanitizeUserDoc(d.id, d.data());
        if (matchesSearchClientSide(u, trimmed)) {
          byUid.set(u.uid, u);
        }
      });
    } catch {
      // ignore fallback errors
    }
  }

  return Array.from(byUid.values()).filter((u) => {
    if (tab === 'team') {
      if (teamRoleFilter === 'admin' && u.role !== 'admin') return false;
      if (teamRoleFilter === 'super_admin' && u.role !== 'super_admin') return false;
      if (teamRoleFilter === 'all' && u.role !== 'admin' && u.role !== 'super_admin') return false;
    } else {
      if (u.role !== 'reseller') return false;
    }
    if (statusFilter !== 'all' && u.status !== statusFilter) return false;
    return true;
  });
}

export interface FetchDirectoryPageParams {
  tab: DirectoryTab;
  teamRoleFilter: TeamRoleFilter;
  statusFilter: DirectoryStatusFilter;
  sortKey: DirectorySortKey;
  searchQuery: string;
  filters: DirectoryAdvancedFilters;
  cursor: QueryDocumentSnapshot<DocumentData> | null;
  perms: DirectoryPermissions;
}

export interface FetchDirectoryPageResult {
  items: EnrichedDirectoryUser[];
  lastCursor: QueryDocumentSnapshot<DocumentData> | null;
  hasMore: boolean;
  isSearchMode: boolean;
}

export async function fetchDirectoryPage(
  params: FetchDirectoryPageParams
): Promise<FetchDirectoryPageResult> {
  const {
    tab,
    teamRoleFilter,
    statusFilter,
    sortKey,
    searchQuery,
    filters,
    cursor,
    perms,
  } = params;

  const usersCol = collection(db, 'users');
  const trimmedSearch = searchQuery.trim();

  // 1. Server-side search mode
  if (trimmedSearch.length > 0) {
    const matchedUsers = await searchUsersServerSide(
      trimmedSearch,
      tab,
      teamRoleFilter,
      statusFilter
    );
    const preFiltered = applyUserDocFilters(matchedUsers, filters);
    const enriched = await enrichDirectoryUsers(preFiltered, perms);
    const postFiltered = applyEnrichedFilters(enriched, filters);
    const sorted = sortEnrichedUsers(postFiltered, sortKey, tab);
    return {
      items: sorted,
      lastCursor: null,
      hasMore: false,
      isSearchMode: true,
    };
  }

  // 2. Balance sort mode (server-side top wallets when Super Admin / manage_wallet)
  if (
    tab === 'resellers' &&
    sortKey === 'balance' &&
    perms.canViewWallet &&
    !filters.district &&
    !filters.joinedFrom &&
    !filters.joinedTo
  ) {
    try {
      const wConstraints: QueryConstraint[] = [orderBy('balance', 'desc')];
      if (cursor) wConstraints.push(startAfter(cursor));
      wConstraints.push(limit(DIRECTORY_PAGE_SIZE));

      const wSnap = await getDocs(query(collection(db, 'wallets'), ...wConstraints));
      const walletDocs = wSnap.docs;
      if (walletDocs.length > 0) {
        const uids = walletDocs.map((d) => d.id);
        const userMap = new Map<string, UserProfile>();

        // Fetch corresponding user docs in chunks of 10
        for (let i = 0; i < uids.length; i += 10) {
          const chunk = uids.slice(i, i + 10);
          const uSnap = await getDocs(query(usersCol, where(documentId(), 'in', chunk)));
          uSnap.forEach((docSnap) => {
            userMap.set(docSnap.id, sanitizeUserDoc(docSnap.id, docSnap.data()));
          });
        }

        const orderedUsers: UserProfile[] = [];
        uids.forEach((uid) => {
          const u = userMap.get(uid);
          if (!u || u.role !== 'reseller') return;
          if (statusFilter !== 'all' && u.status !== statusFilter) return;
          orderedUsers.push(u);
        });

        const preFiltered = applyUserDocFilters(orderedUsers, filters);
        const enriched = await enrichDirectoryUsers(preFiltered, perms);
        const postFiltered = applyEnrichedFilters(enriched, filters);
        return {
          items: sortEnrichedUsers(postFiltered, 'balance', tab),
          lastCursor: walletDocs[walletDocs.length - 1] || null,
          hasMore: walletDocs.length === DIRECTORY_PAGE_SIZE,
          isSearchMode: false,
        };
      }
    } catch (err: any) {
      if (err?.code !== 'failed-precondition') {
        console.warn('Wallet balance sort fallback:', err);
      }
    }
  }

  // 3. Paginated Firestore query on users collection
  const constraints: QueryConstraint[] = [];
  if (tab === 'team') {
    if (teamRoleFilter === 'admin') {
      constraints.push(where('role', '==', 'admin'));
    } else if (teamRoleFilter === 'super_admin') {
      constraints.push(where('role', '==', 'super_admin'));
    } else {
      constraints.push(where('role', 'in', ['admin', 'super_admin']));
    }
  } else {
    constraints.push(where('role', '==', 'reseller'));
  }

  if (statusFilter !== 'all') {
    constraints.push(where('status', '==', statusFilter));
  }
  if (tab === 'resellers' && filters.district) {
    constraints.push(where('district', '==', filters.district));
    if (filters.upazila) {
      constraints.push(where('upazila', '==', filters.upazila));
    }
  }

  const hasDateRange = Boolean(filters.joinedFrom || filters.joinedTo);
  if (hasDateRange && sortKey !== 'name') {
    if (filters.joinedFrom) {
      const fromDate = new Date(`${filters.joinedFrom}T00:00:00`);
      if (!Number.isNaN(fromDate.getTime())) {
        constraints.push(where('createdAt', '>=', Timestamp.fromDate(fromDate)));
      }
    }
    if (filters.joinedTo) {
      const toDate = new Date(`${filters.joinedTo}T23:59:59.999`);
      if (!Number.isNaN(toDate.getTime())) {
        constraints.push(where('createdAt', '<=', Timestamp.fromDate(toDate)));
      }
    }
  }

  if (sortKey === 'name') {
    constraints.push(orderBy('fullName', 'asc'));
  } else {
    constraints.push(orderBy('createdAt', 'desc'));
  }

  if (cursor) {
    constraints.push(startAfter(cursor));
  }

  // Request slightly larger page if post-enrichment filters are active so results stay dense
  const hasPostFilters =
    filters.commissionType !== 'all' ||
    filters.hasOrders !== 'all' ||
    filters.inactiveDays !== 'all' ||
    filters.payoutMethod !== 'all' ||
    filters.documentsMissing;
  const pageLimit = hasPostFilters ? 40 : DIRECTORY_PAGE_SIZE;
  constraints.push(limit(pageLimit));

  let docsSnap;
  let usedFallback = false;

  try {
    docsSnap = await getDocs(query(usersCol, ...constraints));
  } catch (err: any) {
    // Graceful fallback if composite index hasn't been created in Firebase Console yet
    if (
      err?.code === 'failed-precondition' ||
      String(err?.message || '').toLowerCase().includes('index')
    ) {
      usedFallback = true;
      const fallbackConstraints: QueryConstraint[] = [];
      if (tab === 'team') {
        fallbackConstraints.push(
          teamRoleFilter === 'all'
            ? where('role', 'in', ['admin', 'super_admin'])
            : where('role', '==', teamRoleFilter)
        );
      } else {
        fallbackConstraints.push(where('role', '==', 'reseller'));
      }
      if (statusFilter !== 'all') {
        fallbackConstraints.push(where('status', '==', statusFilter));
      }
      fallbackConstraints.push(limit(100));
      docsSnap = await getDocs(query(usersCol, ...fallbackConstraints));
    } else {
      throw err;
    }
  }

  const rawDocs = docsSnap.docs;
  let fetchedUsers = rawDocs.map((d) => sanitizeUserDoc(d.id, d.data()));
  fetchedUsers = applyUserDocFilters(fetchedUsers, filters);

  const enriched = await enrichDirectoryUsers(fetchedUsers, perms);
  const filteredEnriched = applyEnrichedFilters(enriched, filters);
  const sorted = sortEnrichedUsers(filteredEnriched, sortKey, tab);

  return {
    items: sorted,
    lastCursor: !usedFallback && rawDocs.length > 0 ? rawDocs[rawDocs.length - 1] : null,
    hasMore: !usedFallback && rawDocs.length === pageLimit,
    isSearchMode: false,
  };
}

function applyUserDocFilters(
  list: UserProfile[],
  filters: DirectoryAdvancedFilters
): UserProfile[] {
  const fromMs = filters.joinedFrom
    ? new Date(`${filters.joinedFrom}T00:00:00`).getTime()
    : null;
  const toMs = filters.joinedTo
    ? new Date(`${filters.joinedTo}T23:59:59.999`).getTime()
    : null;

  return list.filter((u) => {
    if (filters.district && (u.district || '').toLowerCase() !== filters.district.toLowerCase()) {
      return false;
    }
    if (filters.upazila && (u.upazila || '').toLowerCase() !== filters.upazila.toLowerCase()) {
      return false;
    }
    if (filters.commissionType === 'custom') {
      if (u.customCommissionRate === undefined || u.customCommissionRate === null) return false;
    } else if (filters.commissionType === 'global') {
      if (u.customCommissionRate !== undefined && u.customCommissionRate !== null) return false;
    }

    if (filters.payoutMethod !== 'all') {
      const payouts = collectPayoutMethods(u);
      if (filters.payoutMethod === 'none') {
        if (payouts.length > 0) return false;
      } else {
        const target = filters.payoutMethod.toLowerCase();
        const hasMatch = payouts.some((pm) => pm.type.toLowerCase() === target);
        if (!hasMatch) return false;
      }
    }

    if (fromMs || toMs) {
      const createdMs = parseTsMs(u.createdAt);
      if (!createdMs) return false;
      if (fromMs && createdMs < fromMs) return false;
      if (toMs && createdMs > toMs) return false;
    }

    return true;
  });
}

function applyEnrichedFilters(
  list: EnrichedDirectoryUser[],
  filters: DirectoryAdvancedFilters
): EnrichedDirectoryUser[] {
  const now = Date.now();
  return list.filter((row) => {
    if (filters.hasOrders === 'yes' && row.totalOrders <= 0) return false;
    if (filters.hasOrders === 'no' && row.totalOrders > 0) return false;

    if (filters.documentsMissing && row.completeness.hasDocuments) return false;

    if (filters.inactiveDays !== 'all') {
      const days = Number(filters.inactiveDays);
      const cutoff = now - days * 86400000;
      const refMs = row.lastActiveMs ?? parseTsMs(row.user.createdAt) ?? 0;
      if (refMs > cutoff) return false;
    }

    return true;
  });
}

function sortEnrichedUsers(
  list: EnrichedDirectoryUser[],
  sortKey: DirectorySortKey,
  tab: DirectoryTab
): EnrichedDirectoryUser[] {
  const copy = [...list];
  copy.sort((a, b) => {
    if (tab === 'team') {
      // Keep Super Admin pinned at the top of the Team tab
      const aSuper = isProtectedSuperAdmin(a.user) ? 1 : 0;
      const bSuper = isProtectedSuperAdmin(b.user) ? 1 : 0;
      if (aSuper !== bSuper) return bSuper - aSuper;
    }

    switch (sortKey) {
      case 'name':
        return (a.user.fullName || '').localeCompare(b.user.fullName || '');
      case 'balance':
        return (b.walletBalance ?? -1) - (a.walletBalance ?? -1);
      case 'orders':
        return b.totalOrders - a.totalOrders;
      case 'last_active':
        return (b.lastActiveMs ?? 0) - (a.lastActiveMs ?? 0);
      case 'newest':
      default:
        return (parseTsMs(b.user.createdAt) ?? 0) - (parseTsMs(a.user.createdAt) ?? 0);
    }
  });
  return copy;
}

export async function enrichDirectoryUsers(
  users: UserProfile[],
  perms: DirectoryPermissions
): Promise<EnrichedDirectoryUser[]> {
  if (users.length === 0) return [];

  const usersCol = collection(db, 'users');
  const ordersCol = collection(db, 'orders');
  const now = Date.now();
  const fourteenDaysAgo = now - 14 * 86400000;

  const enrichOne = async (u: UserProfile): Promise<EnrichedDirectoryUser> => {
    const uid = u.uid;
    const isReseller = u.role === 'reseller';
    const anyU = u as any;

    const walletPromise =
      perms.canViewWallet && isReseller
        ? getDoc(doc(db, 'wallets', uid)).catch(() => null)
        : Promise.resolve(null);

    const totalOrdersPromise = isReseller
      ? getCountFromServer(query(ordersCol, where('resellerId', '==', uid)))
          .then((s) => s.data().count)
          .catch(() => 0)
      : Promise.resolve(0);

    const deliveredOrdersPromise = isReseller
      ? getCountFromServer(
          query(ordersCol, where('resellerId', '==', uid), where('status', '==', 'delivered'))
        )
          .then((s) => s.data().count)
          .catch(() => 0)
      : Promise.resolve(0);

    const devicePromise = getDocs(
      query(collection(db, 'users', uid, 'devices'), orderBy('lastActive', 'desc'), limit(1))
    ).catch(() =>
      getDocs(query(collection(db, 'users', uid, 'devices'), limit(3))).catch(() => null)
    );

    const loginHistPromise = getDocs(
      query(collection(db, 'users', uid, 'loginHistory'), orderBy('timestamp', 'desc'), limit(1))
    ).catch(() => null);

    // Duplicate phone & NID checks via lightweight count queries
    const dupPhonePromise =
      u.mobile && u.mobile.trim().length >= 8
        ? getCountFromServer(query(usersCol, where('mobile', '==', u.mobile.trim())))
            .then((s) => s.data().count > 1)
            .catch(() => false)
        : Promise.resolve(false);

    const dupNidPromise =
      u.nidNumber && u.nidNumber.trim().length >= 8
        ? getCountFromServer(query(usersCol, where('nidNumber', '==', u.nidNumber.trim())))
            .then((s) => s.data().count > 1)
            .catch(() => false)
        : Promise.resolve(false);

    const recentPayoutChangePromise =
      perms.isSuperAdmin && isReseller
        ? getDocs(
            query(
              collection(db, 'changeRequests'),
              where('uid', '==', uid),
              where('fieldKey', '==', 'payout'),
              limit(3)
            )
          )
            .then((snap) =>
              snap.docs.some((d) => {
                const ms = parseTsMs(d.data().createdAt);
                return ms !== null && ms >= fourteenDaysAgo;
              })
            )
            .catch(() => false)
        : Promise.resolve(false);

    const [
      walletSnap,
      totalOrders,
      deliveredOrders,
      deviceSnap,
      loginHistSnap,
      dupPhone,
      dupNid,
      recentPayoutReq,
    ] = await Promise.all([
      walletPromise,
      totalOrdersPromise,
      deliveredOrdersPromise,
      devicePromise,
      loginHistPromise,
      dupPhonePromise,
      dupNidPromise,
      recentPayoutChangePromise,
    ]);

    let walletBalance: number | null = null;
    let totalCommissionEarned: number | null = null;
    if (walletSnap && walletSnap.exists()) {
      const wData = walletSnap.data() as Wallet;
      walletBalance = Number(wData.balance || 0);
      totalCommissionEarned = Number(wData.totalEarned || 0);
    } else if (perms.canViewWallet && isReseller) {
      walletBalance = 0;
      totalCommissionEarned = 0;
    }

    let lastActiveMs: number | null =
      parseTsMs(anyU.lastActiveAt ?? anyU.lastLoginAt) ?? null;
    let lastDeviceLabel: string | null = anyU.lastDeviceLabel || null;

    if (deviceSnap && !deviceSnap.empty) {
      let bestMs = lastActiveMs || 0;
      let bestLabel = lastDeviceLabel;
      deviceSnap.forEach((d) => {
        const data = d.data();
        const ms = parseTsMs(data.lastActive ?? data.createdAt) ?? 0;
        if (ms >= bestMs) {
          bestMs = ms;
          const devName = data.deviceName || data.model || data.os || 'Device';
          const browser = data.browser ? ` · ${data.browser}` : '';
          bestLabel = `${devName}${browser}`;
        }
      });
      if (bestMs > 0) lastActiveMs = bestMs;
      if (bestLabel) lastDeviceLabel = bestLabel;
    }

    if ((!lastActiveMs || !lastDeviceLabel) && loginHistSnap && !loginHistSnap.empty) {
      const lh = loginHistSnap.docs[0].data();
      const lhMs = parseTsMs(lh.timestamp ?? lh.createdAt);
      if (lhMs && (!lastActiveMs || lhMs > lastActiveMs)) {
        lastActiveMs = lhMs;
      }
      if (!lastDeviceLabel) {
        const devName = lh.deviceName || lh.deviceModel || lh.os || 'Web';
        const browser = lh.browser ? ` · ${lh.browser}` : '';
        lastDeviceLabel = `${devName}${browser}`;
      }
    }

    const warnings: ResellerWarningTag[] = [];
    if (dupPhone) warnings.push('duplicate_phone');
    if (dupNid) warnings.push('duplicate_nid');
    const failedCount = Number(
      anyU.failedLoginCount ?? anyU.failedLoginAttempts ?? 0
    );
    if (failedCount >= 3) warnings.push('failed_logins');

    const payoutUpdatedMs = parseTsMs(anyU.payoutUpdatedAt);
    if (recentPayoutReq || (payoutUpdatedMs !== null && payoutUpdatedMs >= fourteenDaysAgo)) {
      warnings.push('payout_changed_recently');
    }

    let pendingMinutes: number | null = null;
    if (u.status === 'pending') {
      const subMs = parseTsMs(u.pendingSince ?? u.submittedAt ?? u.createdAt);
      if (subMs) {
        pendingMinutes = Math.max(0, Math.floor((now - subMs) / 60000));
      }
    }

    return {
      user: u,
      walletBalance,
      totalCommissionEarned,
      totalOrders,
      deliveredOrders,
      lastActiveMs,
      lastDeviceLabel,
      completeness: computeProfileCompleteness(u),
      warnings,
      pendingMinutes,
    };
  };

  // Process in chunks of 8 to keep Firestore reads smooth and predictable
  const results: EnrichedDirectoryUser[] = [];
  for (let i = 0; i < users.length; i += 8) {
    const chunk = users.slice(i, i + 8);
    const chunkResults = await Promise.all(chunk.map(enrichOne));
    results.push(...chunkResults);
  }
  return results;
}

export interface DirectoryUserDetailData {
  user: UserProfile;
  wallet: Wallet | null;
  transactions: WalletTransaction[];
  orders: Order[];
  devices: DeviceItem[];
  loginHistory: LoginHistoryItem[];
  notes: InternalAdminNote[];
  auditLogs: AuditLog[];
}

export async function fetchDirectoryUserDetail(
  uid: string,
  perms: DirectoryPermissions
): Promise<DirectoryUserDetailData> {
  const userSnap = await getDoc(doc(db, 'users', uid));
  if (!userSnap.exists()) {
    throw new Error('User record not found.');
  }
  const user = sanitizeUserDoc(userSnap.id, userSnap.data());

  const walletPromise = perms.canViewWallet
    ? getDoc(doc(db, 'wallets', uid))
        .then((s) => (s.exists() ? ({ ...s.data(), resellerId: uid } as Wallet) : null))
        .catch(() => null)
    : Promise.resolve(null);

  const txPromise = perms.canViewWallet
    ? getDocs(
        query(
          collection(db, 'transactions'),
          where('resellerId', '==', uid),
          orderBy('createdAt', 'desc'),
          limit(15)
        )
      )
        .catch(() =>
          getDocs(query(collection(db, 'transactions'), where('resellerId', '==', uid), limit(25)))
        )
        .then((snap) =>
          snap.docs
            .map((d) => ({ id: d.id, ...d.data() } as WalletTransaction))
            .sort((a, b) => (parseTsMs(b.createdAt) ?? 0) - (parseTsMs(a.createdAt) ?? 0))
            .slice(0, 15)
        )
        .catch(() => [])
    : Promise.resolve([]);

  const ordersPromise = getDocs(
    query(
      collection(db, 'orders'),
      where('resellerId', '==', uid),
      orderBy('createdAt', 'desc'),
      limit(15)
    )
  )
    .catch(() => getDocs(query(collection(db, 'orders'), where('resellerId', '==', uid), limit(25))))
    .then((snap) =>
      snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as Order))
        .sort((a, b) => (parseTsMs(b.createdAt) ?? 0) - (parseTsMs(a.createdAt) ?? 0))
        .slice(0, 15)
    )
    .catch(() => []);

  const devicesPromise = fetchUserDevices(uid)
    .then((r) => r.activeDevices)
    .catch(() => []);

  const loginHistPromise = fetchUserLoginHistory(uid).catch(() => []);

  const notesPromise = getDocs(
    query(collection(db, 'users', uid, 'internalNotes'), orderBy('createdAt', 'desc'), limit(30))
  )
    .catch(() => getDocs(query(collection(db, 'users', uid, 'internalNotes'), limit(30))))
    .then((snap) =>
      snap.docs
        .map((d) => ({ id: d.id, ...d.data() } as InternalAdminNote))
        .sort((a, b) => (parseTsMs(b.createdAt) ?? 0) - (parseTsMs(a.createdAt) ?? 0))
    )
    .catch(() => []);

  const auditPromise = Promise.all([
    getDocs(
      query(
        collection(db, 'auditLogs'),
        where('targetId', '==', uid),
        orderBy('timestamp', 'desc'),
        limit(25)
      )
    ).catch(() =>
      getDocs(query(collection(db, 'auditLogs'), where('targetId', '==', uid), limit(25))).catch(
        () => null
      )
    ),
    getDocs(query(collection(db, 'auditLogs'), where('targetUid', '==', uid), limit(15))).catch(
      () => null
    ),
  ]).then(([snap1, snap2]) => {
    const map = new Map<string, AuditLog>();
    [snap1, snap2].forEach((snap) => {
      if (!snap) return;
      snap.docs.forEach((d) => {
        if (!map.has(d.id)) {
          const data = d.data();
          map.set(d.id, {
            id: d.id,
            action: data.action || 'ACTIVITY',
            performedBy: data.performedBy || data.performedByUid || '',
            performedByName: data.performedByName || data.performedBy || 'Admin',
            performedByRole: data.performedByRole || 'admin',
            targetId: data.targetId || data.targetUid || uid,
            details: data.details || data.reason || '',
            timestamp: data.timestamp ?? data.createdAt,
          });
        }
      });
    });
    return Array.from(map.values()).sort(
      (a, b) => (parseTsMs(b.timestamp) ?? 0) - (parseTsMs(a.timestamp) ?? 0)
    );
  });

  const [wallet, transactions, orders, devices, loginHistory, notes, auditLogs] =
    await Promise.all([
      walletPromise,
      txPromise,
      ordersPromise,
      devicesPromise,
      loginHistPromise,
      notesPromise,
      auditPromise,
    ]);

  return {
    user,
    wallet,
    transactions,
    orders,
    devices,
    loginHistory,
    notes,
    auditLogs,
  };
}

export async function addInternalAdminNote(
  targetUid: string,
  text: string,
  currentUser: UserProfile
): Promise<InternalAdminNote> {
  const cleanText = text.trim();
  if (!cleanText) throw new Error('Note cannot be empty.');

  const payload = {
    text: cleanText,
    authorUid: currentUser.uid,
    authorName: currentUser.fullName || currentUser.email || 'Admin',
    authorRole: currentUser.role,
    createdAt: serverTimestamp(),
  };

  const docRef = await addDoc(collection(db, 'users', targetUid, 'internalNotes'), payload);
  await logAuditAction(
    currentUser.uid,
    currentUser.fullName || currentUser.email || 'Admin',
    currentUser.role,
    'ADD_INTERNAL_NOTE',
    targetUid,
    `Added internal note: "${cleanText.slice(0, 80)}${cleanText.length > 80 ? '...' : ''}"`
  );

  return {
    id: docRef.id,
    ...payload,
    createdAt: new Date(),
  };
}

export async function deleteInternalAdminNote(
  targetUid: string,
  noteId: string,
  currentUser: UserProfile
): Promise<void> {
  await deleteDoc(doc(db, 'users', targetUid, 'internalNotes', noteId));
  await logAuditAction(
    currentUser.uid,
    currentUser.fullName || currentUser.email || 'Admin',
    currentUser.role,
    'DELETE_INTERNAL_NOTE',
    targetUid,
    `Deleted internal note (${noteId})`
  );
}

export async function updateCustomCommissionRate(
  targetUser: UserProfile,
  rate: number | null,
  currentUser: UserProfile
): Promise<void> {
  if (rate !== null && (Number.isNaN(rate) || rate < 0 || rate > 100)) {
    throw new Error('Commission rate must be between 0% and 100%.');
  }

  await updateDoc(doc(db, 'users', targetUser.uid), {
    customCommissionRate: rate,
    updatedAt: serverTimestamp(),
  });

  await logAuditAction(
    currentUser.uid,
    currentUser.fullName || currentUser.email || 'Admin',
    currentUser.role,
    'SET_CUSTOM_COMMISSION',
    targetUser.uid,
    rate === null
      ? `Reset commission to Global Rate for ${targetUser.fullName} (${formatResellerId(targetUser)})`
      : `Set custom commission rate to ${rate}% for ${targetUser.fullName} (${formatResellerId(targetUser)})`
  );
}

export async function sendTargetedNotifications(
  targets: UserProfile[],
  payload: {
    title: string;
    message: string;
    type?: 'general' | 'offer' | 'payment_notice' | 'maintenance';
    priority?: 'normal' | 'high';
  },
  currentUser: UserProfile
): Promise<number> {
  const title = payload.title.trim();
  const message = payload.message.trim();
  if (!title || !message) {
    throw new Error('Title and message are required.');
  }

  let sentCount = 0;
  for (const target of targets) {
    const docRef = await addDoc(collection(db, 'notices'), {
      type: payload.type || 'general',
      title,
      message,
      content: message,
      targetAudience: 'specific',
      targetResellerId: target.uid,
      targetResellerName: target.fullName || target.shopName || 'Reseller',
      priority: payload.priority || 'normal',
      publishedBy: currentUser.uid,
      publishedByName: currentUser.fullName || currentUser.email || 'Admin',
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    sentCount++;

    await logAuditAction(
      currentUser.uid,
      currentUser.fullName || currentUser.email || 'Admin',
      currentUser.role,
      'SEND_TARGETED_NOTIFICATION',
      target.uid,
      `Sent notification "${title}" (notice ${docRef.id}) to ${target.fullName} (${formatResellerId(target)})`
    );
  }

  return sentCount;
}

export interface SuspendActivateInput {
  targets: UserProfile[];
  mode: 'suspend_temporary' | 'block_permanent' | 'activate';
  reason?: string;
  suspendedUntil?: string;
  currentUser: UserProfile;
}

export interface SuspendActivateResult {
  updated: Array<{
    uid: string;
    status: UserStatus;
    suspensionType?: 'temporary' | 'permanent' | null;
    suspensionReason?: string | null;
    suspendedUntil?: string | null;
    lastStatusEmailFor?: UserProfile['lastStatusEmailFor'];
  }>;
  skippedSuperAdmins: number;
}

export async function applySuspendOrActivate(
  input: SuspendActivateInput
): Promise<SuspendActivateResult> {
  const { targets, mode, reason, suspendedUntil, currentUser } = input;
  const cleanReason = (reason || '').trim();

  if (mode !== 'activate' && !cleanReason) {
    throw new Error('A reason is required to suspend or block accounts.');
  }

  const updated: SuspendActivateResult['updated'] = [];
  let skippedSuperAdmins = 0;

  for (const target of targets) {
    if (isProtectedSuperAdmin(target)) {
      skippedSuperAdmins++;
      continue;
    }

    const userRef = doc(db, 'users', target.uid);
    const prevStatus = target.status;

    if (mode === 'activate') {
      const updatePayload: Record<string, any> = {
        status: 'approved',
        suspensionType: null,
        suspensionReason: null,
        suspendedUntil: null,
        rejectReason: null,
        reactivatedAt: serverTimestamp(),
        reactivatedBy: currentUser.fullName || currentUser.email || 'Admin',
        ...(prevStatus === 'pending'
          ? {
              approvedAt: serverTimestamp(),
              approvedBy: currentUser.uid,
            }
          : {}),
        updatedAt: serverTimestamp(),
      };
      await updateDoc(userRef, updatePayload);

      await logAuditAction(
        currentUser.uid,
        currentUser.fullName || currentUser.email || 'Admin',
        currentUser.role,
        prevStatus === 'pending' ? 'APPROVE_RESELLER' : 'REACTIVATE_USER',
        target.uid,
        `${prevStatus === 'pending' ? 'Approved' : 'Reactivated'} ${target.fullName} (${formatResellerId(target)})${cleanReason ? ` — Note: ${cleanReason}` : ''}`
      );

      let emailStamp: UserProfile['lastStatusEmailFor'] | undefined;
      if (target.role === 'reseller') {
        const emailRes = await notifyResellerStatusEmail({
          uid: target.uid,
          beforeStatus: prevStatus,
          afterStatus: 'approved',
        });
        emailStamp = emailRes.lastStatusEmailFor;
      }

      updated.push({
        uid: target.uid,
        status: 'approved',
        suspensionType: null,
        suspensionReason: null,
        suspendedUntil: null,
        ...(emailStamp ? { lastStatusEmailFor: emailStamp } : {}),
      });
    } else {
      const sType = mode === 'suspend_temporary' ? 'temporary' : 'permanent';
      const untilVal = sType === 'temporary' && suspendedUntil ? suspendedUntil : null;

      await updateDoc(userRef, {
        status: 'suspended',
        suspensionType: sType,
        suspensionReason: cleanReason,
        suspendedUntil: untilVal,
        suspendedAt: serverTimestamp(),
        suspendedBy: currentUser.fullName || currentUser.email || 'Admin',
        updatedAt: serverTimestamp(),
      });

      await logAuditAction(
        currentUser.uid,
        currentUser.fullName || currentUser.email || 'Admin',
        currentUser.role,
        sType === 'temporary' ? 'SUSPEND_USER_TEMPORARY' : 'BLOCK_USER_PERMANENT',
        target.uid,
        `${sType === 'temporary' ? 'Temporarily suspended' : 'Permanently blocked'} ${target.fullName} (${formatResellerId(target)}) — Reason: ${cleanReason}${untilVal ? ` (until ${untilVal})` : ''}`
      );

      let emailStamp: UserProfile['lastStatusEmailFor'] | undefined;
      if (target.role === 'reseller') {
        const emailRes = await notifyResellerStatusEmail({
          uid: target.uid,
          beforeStatus: prevStatus,
          afterStatus: 'suspended',
        });
        emailStamp = emailRes.lastStatusEmailFor;
      }

      updated.push({
        uid: target.uid,
        status: 'suspended',
        suspensionType: sType,
        suspensionReason: cleanReason,
        suspendedUntil: untilVal,
        ...(emailStamp ? { lastStatusEmailFor: emailStamp } : {}),
      });
    }
  }

  return { updated, skippedSuperAdmins };
}

function escapeCsvCell(value: unknown): string {
  const str = String(value ?? '');
  // Prevent CSV formula injection
  const safe = /^[=+\-@\t\r]/.test(str) ? `'${str}` : str;
  return `"${safe.replace(/"/g, '""')}"`;
}

/**
 * Super Admin only CSV export. Strictly omits passwords and sensitive document URLs.
 */
export function exportDirectoryCsv(
  rows: EnrichedDirectoryUser[],
  globalRateLabel: string
): void {
  const headers = [
    'Reseller ID',
    'Full Name',
    'Shop Name',
    'Role',
    'Status',
    'Email',
    'Email Verified',
    'Mobile',
    'WhatsApp',
    'District',
    'Upazila',
    'Wallet Balance (BDT)',
    'Total Commission Earned (BDT)',
    'Total Orders',
    'Delivered Orders',
    'Commission Rate',
    'Profile Completeness (%)',
    'Registered At',
    'Last Active',
    'Last Device',
  ];

  const lines = [headers.map(escapeCsvCell).join(',')];

  rows.forEach((r) => {
    const u = r.user;
    const idLabel =
      u.role === 'reseller' ? formatResellerId(u) : u.adminId || u.uid.slice(0, 8);
    const createdMs = parseTsMs(u.createdAt);
    const createdStr = createdMs ? new Date(createdMs).toISOString().split('T')[0] : '';
    const activeStr = r.lastActiveMs ? new Date(r.lastActiveMs).toISOString() : '';
    const commStr =
      u.customCommissionRate !== undefined && u.customCommissionRate !== null
        ? `${u.customCommissionRate}% Custom`
        : globalRateLabel;

    lines.push(
      [
        idLabel,
        u.fullName || '',
        u.shopName || '',
        u.role,
        u.status,
        u.email || '',
        u.emailVerified ? 'Yes' : 'No',
        u.mobile || '',
        u.whatsappNumber || u.whatsapp || '',
        u.district || '',
        u.upazila || '',
        r.walletBalance !== null ? r.walletBalance : 0,
        r.totalCommissionEarned !== null ? r.totalCommissionEarned : 0,
        r.totalOrders,
        r.deliveredOrders,
        commStr,
        r.completeness.percent,
        createdStr,
        activeStr,
        r.lastDeviceLabel || '',
      ]
        .map(escapeCsvCell)
        .join(',')
    );
  });

  const csvContent = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `resellbd-directory-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export function formatRelativeTime(ms?: number | null): string {
  if (!ms) return '—';
  const diff = Math.max(0, Date.now() - ms);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  });
}
