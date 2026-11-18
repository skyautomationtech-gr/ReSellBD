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
import { db, functions } from './firebase';
import { ChangeRequest, ChangeRequestFieldKey, PayoutMethod, UserProfile } from '../types';
import { formatResellerId } from './resellerIdHelper';
import { createAppNotification } from './notificationHelper';

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
  if (!uid) return [];
  const q = query(
    collection(db, 'changeRequests'),
    where('uid', '==', uid),
    where('status', '==', 'pending')
  );
  const snap = await getDocs(q);
  const items: ChangeRequest[] = [];
  snap.forEach((docSnap) => {
    items.push({ id: docSnap.id, ...docSnap.data() } as ChangeRequest);
  });
  return items;
}

export async function fetchUserChangeRequests(uid: string): Promise<ChangeRequest[]> {
  if (!uid) return [];
  const colRef = collection(db, 'changeRequests');
  let docs: ChangeRequest[] = [];

  try {
    const q = query(colRef, where('uid', '==', uid), orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    docs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as ChangeRequest));
  } catch {
    const fallbackQ = query(colRef, where('uid', '==', uid));
    const snap = await getDocs(fallbackQ);
    docs = snap.docs.map((d) => ({ id: d.id, ...d.data() } as ChangeRequest));
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

export async function submitLockedChangeRequest(
  input: SubmitChangeRequestInput
): Promise<{ id: string; requestId: string }> {
  const { user, fieldKey } = input;
  const pending = await fetchPendingChangeRequests(user.uid);
  const duplicate = pending.find((req) => req.fieldKey === fieldKey);
  if (duplicate) {
    const label = CHANGE_REQUEST_FIELD_LABELS[fieldKey]?.en || fieldKey;
    throw new Error(
      `You already have a pending ${label} change request under Super Admin review.`
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
