import { httpsCallable } from 'firebase/functions';
import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { auth, db, functions } from './firebase';
import { ChangeRequest, ChangeRequestFieldKey, PayoutMethod, UserProfile } from '../types';
import { formatResellerId } from './resellerIdHelper';
import { createAppNotification } from './notificationHelper';

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

function logAndThrowFirestoreError(error: unknown, operationType: OperationType, path: string): never {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    operationType,
    path,
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  throw error instanceof Error ? error : new Error(JSON.stringify(errInfo));
}

export const CHANGE_REQUEST_FIELD_LABELS: Record<
  ChangeRequestFieldKey,
  { en: string; bn: string }
> = {
  shopName: { en: 'Shop Name', bn: 'দোকানের নাম' },
  email: { en: 'Email Address', bn: 'ইমেইল ঠিকানা' },
  dob: { en: 'Date of Birth', bn: 'জন্ম তারিখ' },
  nid: { en: 'NID Number', bn: 'এনআইডি নম্বর' },
  nid_image: { en: 'NID Image', bn: 'এনআইডির ছবি' },
  birth_certificate: { en: 'Birth Certificate', bn: 'জন্ম নিবন্ধন সনদ' },
  payout: { en: 'Payout Method', bn: 'পেআউট মাধ্যম' },
};

export interface SubmitChangeRequestInput {
  user: UserProfile;
  fieldKey: ChangeRequestFieldKey;
  oldValueMasked?: string;
  newValue?: string;
  newDocumentUrl?: string;
  currentValueSummary: string;
  requestedValueSummary: string;
  currentData?: Record<string, any>;
  requestedData: Record<string, any>;
  requestedPayoutEntry?: Partial<PayoutMethod> & {
    action?: 'add' | 'edit' | 'remove';
    targetPayoutId?: string;
    type?: 'bKash' | 'Nagad' | 'Rocket' | 'Upay' | 'Bank';
    accountNumber?: string;
  };
  reason: string;
  proofUrl?: string;
}

export function generateChangeRequestId(): string {
  const num = Math.floor(100000 + Math.random() * 900000);
  return `CR-${num}`;
}

export function maskSensitiveValue(value?: string | null, visibleTail = 4): string {
  if (!value) return 'Not set';
  const clean = String(value).trim();
  if (!clean) return 'Not set';
  if (clean.includes('@')) {
    const [local, domain] = clean.split('@');
    const prefix = local.slice(0, Math.min(2, local.length));
    return `${prefix}***@${domain}`;
  }
  if (clean.length <= visibleTail) return `••••${clean}`;
  return `•••• •••• ${clean.slice(-visibleTail)}`;
}

export function getMaskedCurrentValueForField(
  user: UserProfile,
  fieldKey: ChangeRequestFieldKey
): string {
  switch (fieldKey) {
    case 'shopName':
      return user.shopName || 'Not set';
    case 'email':
      return maskSensitiveValue(user.email);
    case 'dob': {
      const dob = user.dob || '';
      if (!dob) return 'Not set';
      const parts = dob.split('-');
      return parts.length === 3 ? `${parts[0]}-••-${parts[2]}` : maskSensitiveValue(dob, 2);
    }
    case 'nid':
      return user.nidNumber ? maskSensitiveValue(user.nidNumber) : 'Not on file';
    case 'nid_image':
      return user.nidFrontUrl || user.nidUrl ? 'Verified NID image on file' : 'No NID photo on file';
    case 'birth_certificate':
      return user.birthCertificateNumber
        ? maskSensitiveValue(user.birthCertificateNumber)
        : user.birthCertificateUrl
        ? 'Verified Birth Certificate on file'
        : 'Not on file';
    case 'payout': {
      const def = user.payoutMethods?.find((m) => m.isDefault) || user.payoutMethods?.[0];
      if (def) {
        return `${def.type} (${maskSensitiveValue(def.accountNumber)})`;
      }
      if (user.accountNumber) {
        return `${(user.payoutMethod || 'Payout').toUpperCase()} (${maskSensitiveValue(
          user.accountNumber
        )})`;
      }
      return 'No payout method';
    }
    default:
      return 'Not set';
  }
}

function getTimestampMs(val: any): number {
  if (!val) return 0;
  if (typeof val.toMillis === 'function') return val.toMillis();
  if (typeof val.toDate === 'function') return val.toDate().getTime();
  if (val.seconds) return val.seconds * 1000;
  const parsed = new Date(val).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

export async function fetchPendingChangeRequests(uid: string): Promise<ChangeRequest[]> {
  const effectiveUid = auth.currentUser?.uid || '';
  if (!uid || !effectiveUid) return [];
  const targetUid = effectiveUid === uid ? uid : effectiveUid;
  try {
    const q = query(
      collection(db, 'changeRequests'),
      where('uid', '==', targetUid),
      where('status', '==', 'pending')
    );
    const snap = await getDocs(q);
    const items: ChangeRequest[] = [];
    snap.forEach((docSnap) => {
      items.push({ id: docSnap.id, ...docSnap.data() } as ChangeRequest);
    });
    return items;
  } catch (err) {
    logAndThrowFirestoreError(err, OperationType.LIST, 'changeRequests');
  }
}

export async function fetchUserChangeRequests(uid: string): Promise<ChangeRequest[]> {
  const effectiveUid = auth.currentUser?.uid || '';
  if (!uid || !effectiveUid) return [];
  const targetUid = effectiveUid === uid ? uid : effectiveUid;
  const colRef = collection(db, 'changeRequests');
  let docs: ChangeRequest[] = [];

  try {
    const q = query(colRef, where('uid', '==', targetUid), orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    docs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as ChangeRequest));
  } catch (primaryErr: any) {
    if (primaryErr?.code === 'permission-denied') {
      logAndThrowFirestoreError(primaryErr, OperationType.LIST, 'changeRequests');
    }
    try {
      const fallbackQ = query(colRef, where('uid', '==', targetUid));
      const snap = await getDocs(fallbackQ);
      docs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as ChangeRequest));
    } catch (fallbackErr) {
      logAndThrowFirestoreError(fallbackErr, OperationType.LIST, 'changeRequests');
    }
  }

  docs.sort((a, b) => getTimestampMs(b.createdAt) - getTimestampMs(a.createdAt));
  return docs;
}

export async function cancelPendingChangeRequest(docId: string): Promise<void> {
  if (!docId) throw new Error('Invalid change request ID.');
  await updateDoc(doc(db, 'changeRequests', docId), {
    status: 'cancelled',
    cancelledAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export interface PayoutPrefillConfig {
  mode: 'add' | 'edit' | 'remove' | 'set_default';
  targetPayoutId?: string;
  methodType?: 'bKash' | 'Nagad' | 'Rocket' | 'Upay' | 'Bank';
  makeDefault?: boolean;
  reason?: string;
  lockFieldSelector?: boolean;
}

export interface PayoutHistoryEntry {
  id: string;
  source: 'changeRequests' | 'payoutChangeRequests' | 'auditLogs';
  requestId: string;
  dateMs: number;
  dateLabel: string;
  whatChanged: string;
  oldValueMasked?: string;
  reason?: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  adminResponse?: string | null;
  decidedBy?: string | null;
  decidedAtLabel?: string | null;
  actionType?: 'add' | 'edit' | 'remove' | 'set_default';
  targetPayoutId?: string;
  methodType?: string;
  accountNumber?: string;
  proofUrl?: string;
  requestDoc?: ChangeRequest;
}

export function normalizePayoutAccountNumber(value?: string | null): string {
  return String(value || '')
    .trim()
    .replace(/[\s-]+/g, '');
}

export function isPayoutMethodPending(
  method: Pick<PayoutMethod, 'id' | 'type' | 'accountNumber'>,
  pendingRequests: ChangeRequest[],
  legacyPendingList: Array<{ payoutMethod?: string; accountNumber?: string; bkashNumber?: string; nagadNumber?: string; rocketNumber?: string }> = []
): ChangeRequest | null {
  const normalizedTargetAcct = normalizePayoutAccountNumber(method.accountNumber);
  const methodTypeLower = String(method.type || '').toLowerCase();

  for (const req of pendingRequests) {
    if (req.fieldKey !== 'payout') continue;
    const entry = req.requestedPayoutEntry;
    if (entry?.targetPayoutId && entry.targetPayoutId === method.id) {
      return req;
    }
    if (req.requestedData?.targetPayoutId && req.requestedData.targetPayoutId === method.id) {
      return req;
    }
    const entryAcct = normalizePayoutAccountNumber(
      entry?.accountNumber || req.requestedData?.accountNumber
    );
    const entryTypeLower = String(
      entry?.type || req.requestedData?.payoutMethod || ''
    ).toLowerCase();
    if (
      entryAcct &&
      normalizedTargetAcct &&
      entryAcct === normalizedTargetAcct &&
      (!entryTypeLower || entryTypeLower === methodTypeLower)
    ) {
      return req;
    }
    // Untargeted legacy unified request blocks all rows until resolved
    if (!entry?.targetPayoutId && !req.requestedData?.targetPayoutId && !entryAcct) {
      return req;
    }
  }

  for (const leg of legacyPendingList) {
    const legAcct = normalizePayoutAccountNumber(
      leg.accountNumber || leg.bkashNumber || leg.nagadNumber || leg.rocketNumber
    );
    const legTypeLower = String(leg.payoutMethod || '').toLowerCase();
    if (legAcct && normalizedTargetAcct && legAcct === normalizedTargetAcct) {
      return pendingRequests[0] || ({
        id: 'legacy_pending',
        uid: '',
        resellerName: '',
        fieldKey: 'payout',
        fieldLabel: 'Payout Method',
        currentValueSummary: '',
        requestedValueSummary: `${leg.payoutMethod || 'Payout'} update`,
        requestedData: {},
        reason: '',
        status: 'pending',
        createdAt: null,
      } as ChangeRequest);
    }
    if (!legAcct && legTypeLower && legTypeLower === methodTypeLower) {
      return {
        id: 'legacy_pending',
        uid: '',
        resellerName: '',
        fieldKey: 'payout',
        fieldLabel: 'Payout Method',
        currentValueSummary: '',
        requestedValueSummary: `${leg.payoutMethod || 'Payout'} update`,
        requestedData: {},
        reason: '',
        status: 'pending',
        createdAt: null,
      } as ChangeRequest;
    }
  }

  return null;
}

export async function fetchUserPayoutHistory(
  uid: string,
  userRole?: string
): Promise<{
  entries: PayoutHistoryEntry[];
  pendingUnified: ChangeRequest[];
  pendingLegacy: any[];
}> {
  const effectiveUid = auth.currentUser?.uid || '';
  if (!uid || !effectiveUid) {
    return { entries: [], pendingUnified: [], pendingLegacy: [] };
  }
  const targetUid = effectiveUid === uid ? uid : effectiveUid;

  const [allUnified, legacySnap, auditSnap] = await Promise.all([
    fetchUserChangeRequests(targetUid),
    getDocs(
      query(collection(db, 'payoutChangeRequests'), where('resellerId', '==', targetUid))
    ).catch(() => null),
    userRole === 'admin' || userRole === 'super_admin'
      ? getDocs(
          query(collection(db, 'auditLogs'), where('targetUid', '==', targetUid))
        ).catch(() => null)
      : Promise.resolve(null),
  ]);

  const payoutUnified = allUnified.filter((r) => r.fieldKey === 'payout');
  const pendingUnified = payoutUnified.filter((r) => r.status === 'pending');

  const formatDate = (ms: number): string => {
    if (!ms) return 'Just now';
    try {
      return new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Dhaka',
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      }).format(new Date(ms));
    } catch {
      return new Date(ms).toLocaleString('en-GB');
    }
  };

  const entries: PayoutHistoryEntry[] = [];

  for (const req of payoutUnified) {
    const createdMs = getTimestampMs(req.createdAt);
    const decidedMs = getTimestampMs(req.decidedAt || req.reviewedAt || req.cancelledAt);
    const adminName = req.decidedBy || req.reviewedByName || null;
    const note = req.decisionNote || req.rejectionReason || req.adminNote || null;

    let adminResponse: string | null = null;
    if (req.status === 'approved') {
      adminResponse = adminName
        ? `Approved by ${adminName}${note ? ` — ${note}` : ''}`
        : note || 'Approved & applied by Super Admin';
    } else if (req.status === 'rejected') {
      adminResponse = adminName
        ? `Rejected by ${adminName}${note ? `: ${note}` : ''}`
        : note || 'Rejected by Super Admin';
    } else if (req.status === 'cancelled') {
      adminResponse = 'Cancelled by you before review';
    }

    const actionType: PayoutHistoryEntry['actionType'] =
      req.requestedPayoutEntry?.action === 'remove'
        ? 'remove'
        : req.requestedData?.setAsDefaultOnly
        ? 'set_default'
        : req.requestedPayoutEntry?.action === 'edit'
        ? 'edit'
        : 'add';

    entries.push({
      id: `cr_${req.id}`,
      source: 'changeRequests',
      requestId: req.requestId || `CR-${req.id.slice(0, 6).toUpperCase()}`,
      dateMs: decidedMs || createdMs,
      dateLabel: formatDate(createdMs),
      whatChanged: req.newValue || req.requestedValueSummary || 'Payout Account Update',
      oldValueMasked: req.oldValueMasked || req.currentValueSummary,
      reason: req.reason,
      status: req.status || 'pending',
      adminResponse,
      decidedBy: adminName,
      decidedAtLabel: decidedMs ? formatDate(decidedMs) : null,
      actionType,
      targetPayoutId: req.requestedPayoutEntry?.targetPayoutId,
      methodType: req.requestedPayoutEntry?.type,
      accountNumber: req.requestedPayoutEntry?.accountNumber,
      proofUrl: req.proofUrl || req.newDocumentUrl,
      requestDoc: req,
    });
  }

  const pendingLegacy: any[] = [];
  if (legacySnap) {
    legacySnap.forEach((docSnap) => {
      const data = docSnap.data() as any;
      if (data.status === 'pending') {
        pendingLegacy.push({ id: docSnap.id, ...data });
      }
      const createdMs = getTimestampMs(data.createdAt);
      const decidedMs = getTimestampMs(data.approvedAt);
      const methodLabel = String(data.payoutMethod || 'Payout').toUpperCase();
      const rawAcct =
        data.payoutMethod === 'bkash'
          ? data.bkashNumber
          : data.payoutMethod === 'nagad'
          ? data.nagadNumber
          : data.payoutMethod === 'rocket'
          ? data.rocketNumber
          : data.accountNumber;
      const summary =
        data.payoutMethod === 'bank'
          ? `Bank: ${data.bankName || 'Bank'} (${maskSensitiveValue(rawAcct)})`
          : `${methodLabel}: ${maskSensitiveValue(rawAcct)}`;

      let adminResponse: string | null = null;
      if (data.status === 'approved') {
        adminResponse = data.approvedBy
          ? `Approved by ${data.approvedBy}`
          : 'Approved by Super Admin';
      } else if (data.status === 'rejected') {
        adminResponse = data.rejectionReason || 'Rejected by Super Admin';
      }

      entries.push({
        id: `pcr_${docSnap.id}`,
        source: 'payoutChangeRequests',
        requestId: `PCR-${docSnap.id.slice(0, 6).toUpperCase()}`,
        dateMs: decidedMs || createdMs,
        dateLabel: formatDate(createdMs),
        whatChanged: summary,
        status: data.status || 'pending',
        adminResponse,
        decidedBy: data.approvedBy || null,
        decidedAtLabel: decidedMs ? formatDate(decidedMs) : null,
        methodType: data.payoutMethod,
        accountNumber: rawAcct,
      });
    });
  }

  if (auditSnap) {
    auditSnap.forEach((docSnap) => {
      const data = docSnap.data() as any;
      const actionStr = String(data.action || '').toLowerCase();
      const detailsStr = String(data.details || '');
      if (
        !actionStr.includes('payout') &&
        !actionStr.includes('change_request') &&
        !detailsStr.toLowerCase().includes('payout')
      ) {
        return;
      }
      const ms = getTimestampMs(data.timestamp);
      entries.push({
        id: `audit_${docSnap.id}`,
        source: 'auditLogs',
        requestId: data.requestId ? String(data.requestId).slice(0, 10) : 'AUDIT',
        dateMs: ms,
        dateLabel: formatDate(ms),
        whatChanged: data.action || 'Payout Audit Event',
        status: actionStr.includes('reject') ? 'rejected' : 'approved',
        adminResponse: data.adminNote || detailsStr || null,
        decidedBy: data.actorEmail || data.actorName || null,
        decidedAtLabel: ms ? formatDate(ms) : null,
      });
    });
  }

  entries.sort((a, b) => b.dateMs - a.dateMs);
  return { entries, pendingUnified, pendingLegacy };
}

export async function submitLockedChangeRequest(
  input: SubmitChangeRequestInput
): Promise<{ id: string; requestId: string }> {
  const { user, fieldKey } = input;
  const pending = await fetchPendingChangeRequests(user.uid);
  const duplicate = pending.find((req) => {
    if (req.fieldKey !== fieldKey) return false;
    if (fieldKey !== 'payout') return true;

    const existingEntry = req.requestedPayoutEntry;
    const incomingEntry = input.requestedPayoutEntry;
    if (!existingEntry || !incomingEntry) return true;

    const existingTarget = existingEntry.targetPayoutId || '';
    const incomingTarget = incomingEntry.targetPayoutId || '';
    if (existingTarget && incomingTarget) {
      return existingTarget === incomingTarget;
    }

    const existingAcct = normalizePayoutAccountNumber(existingEntry.accountNumber);
    const incomingAcct = normalizePayoutAccountNumber(incomingEntry.accountNumber);
    const existingType = String(existingEntry.type || '').toLowerCase();
    const incomingType = String(incomingEntry.type || '').toLowerCase();
    if (existingAcct && incomingAcct && existingAcct === incomingAcct && existingType === incomingType) {
      return true;
    }

    return !existingTarget && !existingAcct;
  });

  if (duplicate) {
    const label = CHANGE_REQUEST_FIELD_LABELS[fieldKey]?.en || fieldKey;
    throw new Error(
      fieldKey === 'payout'
        ? 'You already have a pending change request for this payout method under Super Admin review.'
        : `You already have a pending ${label} change request under Super Admin review.`
    );
  }

  const requestId = generateChangeRequestId();
  const label = CHANGE_REQUEST_FIELD_LABELS[fieldKey]?.en || 'Verified Information';
  const oldValueMasked =
    input.oldValueMasked || getMaskedCurrentValueForField(user, fieldKey);
  const newValue = input.newValue || input.requestedValueSummary;
  const newDocumentUrl =
    input.newDocumentUrl ||
    input.requestedData?.nidFrontUrl ||
    input.requestedData?.birthCertificateUrl ||
    input.proofUrl ||
    '';

  const payload = {
    requestId,
    uid: user.uid,
    resellerUid: user.uid,
    resellerId: user.uid,
    resellerName: user.fullName || '',
    resellerCode: formatResellerId(user),
    shopName: user.shopName || '',
    mobile: user.mobile || '',
    field: fieldKey,
    fieldKey,
    fieldLabel: label,
    oldValueMasked,
    newValue,
    newDocumentUrl,
    currentValueSummary: input.currentValueSummary,
    requestedValueSummary: input.requestedValueSummary,
    currentData: input.currentData || {},
    requestedData: input.requestedData,
    ...(input.requestedPayoutEntry ? { requestedPayoutEntry: input.requestedPayoutEntry } : {}),
    reason: input.reason.trim(),
    proofUrl: input.proofUrl || newDocumentUrl || '',
    status: 'pending',
    decidedAt: null,
    decidedBy: null,
    decisionNote: null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const docRef = await addDoc(collection(db, 'changeRequests'), payload);

  const shortId = formatResellerId(user);
  await Promise.allSettled([
    createAppNotification({
      title: `New Change Request (${requestId})`,
      message: `${user.fullName || user.shopName || 'Reseller'} (${shortId}) requested to update ${label}.`,
      type: 'change_request',
      targetAudience: 'admin',
      priority: 'high',
      metadata: {
        targetRole: 'super_admin',
        requestId,
        changeRequestDocId: docRef.id,
        resellerUid: user.uid,
        resellerCode: shortId,
        fieldKey,
      },
    }),
    addDoc(collection(db, 'notifications'), {
      targetRole: 'super_admin',
      type: 'change_request',
      requestId,
      changeRequestDocId: docRef.id,
      resellerUid: user.uid,
      resellerId: shortId,
      title: `New Change Request (${requestId})`,
      message: `${user.fullName || 'Reseller'} (${shortId}) requested ${label} change.`,
      read: false,
      createdAt: serverTimestamp(),
    }),
  ]);

  return { id: docRef.id, requestId };
}

export async function updateResellerLockedFieldsCall(
  targetUid: string,
  updates: Record<string, any>
): Promise<{ success: boolean; updatedFields: string[]; message: string }> {
  const fn = httpsCallable<
    { targetUid: string; updates: Record<string, any> },
    { success: boolean; updatedFields: string[]; message: string }
  >(functions, 'updateResellerLockedFields');
  const res = await fn({ targetUid, updates });
  return res.data;
}

export async function reviewChangeRequestCall(params: {
  requestId: string;
  collectionName?: 'changeRequests' | 'payoutChangeRequests';
  decision: 'approved' | 'rejected';
  adminNote?: string;
}): Promise<{ success: boolean; decision: string; message: string }> {
  const fn = httpsCallable<
    {
      requestId: string;
      collectionName?: 'changeRequests' | 'payoutChangeRequests';
      decision: 'approved' | 'rejected';
      adminNote?: string;
    },
    { success: boolean; decision: string; message: string }
  >(functions, 'reviewChangeRequest');
  const res = await fn(params);
  return res.data;
}

export async function sendResellerPasswordResetCall(
  targetUid: string
): Promise<{ success: boolean; message: string }> {
  const fn = httpsCallable<{ targetUid: string }, { success: boolean; message: string }>(
    functions,
    'sendResellerPasswordReset'
  );
  const res = await fn({ targetUid });
  return res.data;
}

export async function setResellerTemporaryPasswordCall(
  targetUid: string,
  temporaryPassword?: string
): Promise<{ success: boolean; tempPassword: string; message: string }> {
  const fn = httpsCallable<
    { targetUid: string; temporaryPassword?: string },
    { success: boolean; tempPassword: string; message: string }
  >(functions, 'setResellerTemporaryPassword');
  const res = await fn({ targetUid, ...(temporaryPassword ? { temporaryPassword } : {}) });
  return res.data;
}

export async function removePlainPasswordsCall(): Promise<{
  success: boolean;
  cleanedCount: number;
  message: string;
}> {
  const fn = httpsCallable<
    void,
    { success: boolean; cleanedCount: number; message: string }
  >(functions, 'removePlainPasswords');
  const res = await fn();
  return res.data;
}
