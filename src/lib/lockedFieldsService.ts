import { httpsCallable } from 'firebase/functions';
import {
  addDoc,
  collection,
  getDocs,
  query,
  serverTimestamp,
  where,
} from 'firebase/firestore';
import { db, functions } from './firebase';
import { ChangeRequest, ChangeRequestFieldKey, PayoutMethod, UserProfile } from '../types';
import { formatResellerId } from './resellerIdHelper';

export const LOCKED_FIELD_NOTICE_EN =
  'Protected verified info — only Super Admin can change this after registration.';

export const LOCKED_FIELD_NOTICE_BN =
  'নিরাপত্তার জন্য এই যাচাইকৃত তথ্য লক করা আছে — শুধুমাত্র সুপার অ্যাডমিন এটি পরিবর্তন করতে পারবেন।';

export const CHANGE_REQUEST_FIELD_LABELS: Record<
  ChangeRequestFieldKey,
  { en: string; bn: string }
> = {
  shopName: { en: 'Shop Name', bn: 'দোকানের নাম' },
  email: { en: 'Email Address', bn: 'ইমেইল ঠিকানা' },
  dob: { en: 'Date of Birth', bn: 'জন্ম তারিখ' },
  nid: { en: 'National ID (NID)', bn: 'জাতীয় পরিচয়পত্র (NID)' },
  birth_certificate: { en: 'Birth Certificate', bn: 'জন্ম নিবন্ধন সনদ' },
  payout: { en: 'Payout Account Details', bn: 'পেমেন্ট / পেআউট তথ্য' },
};

export interface SubmitChangeRequestInput {
  user: UserProfile;
  fieldKey: ChangeRequestFieldKey;
  currentValueSummary: string;
  requestedValueSummary: string;
  currentData?: Record<string, any>;
  requestedData: Record<string, any>;
  requestedPayoutEntry?: Partial<PayoutMethod> & {
    type?: 'bKash' | 'Nagad' | 'Rocket' | 'Upay' | 'Bank';
    accountNumber?: string;
  };
  reason: string;
  proofUrl?: string;
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

export async function submitLockedChangeRequest(
  input: SubmitChangeRequestInput
): Promise<{ id: string }> {
  const { user, fieldKey } = input;
  const pending = await fetchPendingChangeRequests(user.uid);
  const duplicate = pending.find((req) => req.fieldKey === fieldKey);
  if (duplicate) {
    const label = CHANGE_REQUEST_FIELD_LABELS[fieldKey]?.en || fieldKey;
    throw new Error(
      `You already have a pending ${label} change request under Super Admin review.`
    );
  }

  const label = CHANGE_REQUEST_FIELD_LABELS[fieldKey]?.en || 'Protected Information';
  const payload = {
    uid: user.uid,
    resellerId: user.uid,
    resellerName: user.fullName || '',
    resellerCode: formatResellerId(user),
    shopName: user.shopName || '',
    mobile: user.mobile || '',
    fieldKey,
    fieldLabel: label,
    currentValueSummary: input.currentValueSummary,
    requestedValueSummary: input.requestedValueSummary,
    currentData: input.currentData || {},
    requestedData: input.requestedData,
    ...(input.requestedPayoutEntry ? { requestedPayoutEntry: input.requestedPayoutEntry } : {}),
    reason: input.reason.trim(),
    proofUrl: input.proofUrl || '',
    status: 'pending',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };

  const docRef = await addDoc(collection(db, 'changeRequests'), payload);
  return { id: docRef.id };
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
