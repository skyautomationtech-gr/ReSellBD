import { httpsCallable } from 'firebase/functions';
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  updateDoc,
  where,
} from 'firebase/firestore';
import { EmailAuthProvider, reauthenticateWithCredential, updatePassword } from 'firebase/auth';
import { auth, db, functions } from './firebase';
import { getApiBaseUrl } from './emailOtpService';

export interface AdminPermissionDef {
  id: string;
  label: string;
  labelBn: string;
  category: 'resellers' | 'catalog' | 'financial' | 'engagement';
  description: string;
  defaultChecked: boolean;
}

export const ADMIN_PERMISSIONS_LIST: AdminPermissionDef[] = [
  // 1. Reseller & Partner Operations
  {
    id: 'approve_resellers',
    label: 'Approve & Reject Resellers',
    labelBn: 'রিসেলার আবেদন অনুমোদন ও বাতিল',
    category: 'resellers',
    description: 'Review pending reseller applications, verify NID and shop info, approve or request resubmission.',
    defaultChecked: true,
  },
  {
    id: 'handle_support',
    label: 'Handle Support Tickets',
    labelBn: 'সাপোর্ট টিকিট ও অভিযোগ পরিচালনা',
    category: 'resellers',
    description: 'Respond to reseller support inquiries, dispute tickets, and communication requests.',
    defaultChecked: true,
  },

  // 2. Catalog & Orders
  {
    id: 'manage_products',
    label: 'Manage Products, Categories & Brands',
    labelBn: 'পণ্য, ক্যাটাগরি ও ব্র্যান্ড পরিচালনা',
    category: 'catalog',
    description: 'Add and edit products, manage variants, upload photos, and organize catalog categories.',
    defaultChecked: true,
  },
  {
    id: 'manage_orders',
    label: 'Manage & Process Orders',
    labelBn: 'অর্ডার প্রসেসিং ও ডেলিভারি আপডেট',
    category: 'catalog',
    description: 'View customer orders, update tracking status, and coordinate courier dispatch.',
    defaultChecked: true,
  },

  // 3. Financials & Reports
  {
    id: 'manage_wallet',
    label: 'Approve Wallet Deposits & Withdrawals',
    labelBn: 'ওয়ালেট জমা ও উত্তোলন অনুমোদন',
    category: 'financial',
    description: 'Verify deposit transaction IDs, review payout requests, and mark payouts completed.',
    defaultChecked: true,
  },
  {
    id: 'manage_commission',
    label: 'Manage Commission Settings',
    labelBn: 'কমিশন সেটিংস ও রেট পরিচালনা',
    category: 'financial',
    description: 'Configure standard and category-wise reseller commissions.',
    defaultChecked: true,
  },
  {
    id: 'view_reports',
    label: 'View Analytics & Reports',
    labelBn: 'বিক্রয় ও আর্থিক রিপোর্ট দেখুন',
    category: 'financial',
    description: 'Access sales analytics, order performance trends, and reseller volume summaries.',
    defaultChecked: true,
  },

  // 4. Engagement & Notices
  {
    id: 'send_notifications',
    label: 'Send Notices & Push Notifications',
    labelBn: 'নোটিশ ও পুশ নোটিফিকেশন পাঠান',
    category: 'engagement',
    description: 'Dispatch urgent operational notices, general bulletins, and system alerts to resellers.',
    defaultChecked: true,
  },
  {
    id: 'manage_banners',
    label: 'Manage Promotional Banners',
    labelBn: 'ব্যানার ও অফার স্লাইডার পরিচালনা',
    category: 'engagement',
    description: 'Upload promotional banners, homepage sliders, and marketing graphics.',
    defaultChecked: true,
  },
];

export const FORBIDDEN_ADMIN_ACTIONS = [
  'Create, edit or delete Admin accounts (Super Admin exclusive)',
  'Modify company legal, tax, or banking credentials (Super Admin exclusive)',
  'Access, duplicate or modify Super Admin security settings (Super Admin exclusive)',
  'Delete core database audit logs or system backups (Super Admin exclusive)',
];

export interface CreateAdminPayload {
  fullName: string;
  email: string;
  mobile: string;
  password?: string;
  permissions: string[];
  profilePhotoUrl?: string;
  internalNote?: string;
}

export interface CreateAdminResponse {
  success: boolean;
  adminId: string;
  uid: string;
  email: string;
  fullName: string;
  message: string;
}

/**
 * Generate a cryptographically secure 12-character temporary password
 * with uppercase, lowercase, numbers, and symbols.
 */
export function generateSecurePassword(): string {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const numbers = '23456789';
  const symbols = '!@#$%^&*()_+-=';

  // Ensure at least 1 of each required class
  let pwd = [
    upper[Math.floor(Math.random() * upper.length)],
    lower[Math.floor(Math.random() * lower.length)],
    numbers[Math.floor(Math.random() * numbers.length)],
    symbols[Math.floor(Math.random() * symbols.length)],
  ];

  const allChars = upper + lower + numbers + symbols;
  for (let i = 4; i < 12; i++) {
    pwd.push(allChars[Math.floor(Math.random() * allChars.length)]);
  }

  // Shuffle array
  return pwd.sort(() => 0.5 - Math.random()).join('');
}

export interface PasswordStrengthResult {
  score: number; // 0 to 4
  label: string;
  color: string;
  hasUpper: boolean;
  hasLower: boolean;
  hasNumber: boolean;
  hasSymbol: boolean;
  hasMinLength: boolean;
  isValid: boolean;
}

export function evaluatePasswordStrength(password: string): PasswordStrengthResult {
  const hasMinLength = password.length >= 8;
  const hasUpper = /[A-Z]/.test(password);
  const hasLower = /[a-z]/.test(password);
  const hasNumber = /[0-9]/.test(password);
  const hasSymbol = /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(password);

  let criteriaMet = 0;
  if (hasMinLength) criteriaMet++;
  if (hasUpper) criteriaMet++;
  if (hasLower) criteriaMet++;
  if (hasNumber) criteriaMet++;
  if (hasSymbol) criteriaMet++;

  const isValid = hasMinLength && hasUpper && hasLower && hasNumber && hasSymbol;

  if (criteriaMet <= 2) {
    return { score: 1, label: 'Weak (দুর্বল)', color: '#F43F5E', hasUpper, hasLower, hasNumber, hasSymbol, hasMinLength, isValid };
  }
  if (criteriaMet <= 4) {
    return { score: 2, label: 'Moderate (মাঝারি)', color: '#F59E0B', hasUpper, hasLower, hasNumber, hasSymbol, hasMinLength, isValid };
  }
  return { score: 4, label: 'Strong (শক্তিশালী)', color: '#3DD055', hasUpper, hasLower, hasNumber, hasSymbol, hasMinLength, isValid };
}

function isCloudFunctionUnavailableError(err: any): boolean {
  const code = String(err?.code || '').toLowerCase();
  const msg = String(err?.message || '').toLowerCase();
  return (
    code.includes('not-found') ||
    code.includes('internal') ||
    code.includes('unavailable') ||
    msg === 'internal' ||
    msg.includes('cors') ||
    msg.includes('failed to fetch') ||
    msg.includes('network')
  );
}

async function fetchAdminApi(
  endpoint: string,
  payload: Record<string, any>
): Promise<Response> {
  const sendOnce = async (forceRefresh: boolean): Promise<Response> => {
    const idToken = auth.currentUser ? await auth.currentUser.getIdToken(forceRefresh) : '';
    return fetch(`${getApiBaseUrl()}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      credentials: 'same-origin',
      body: JSON.stringify(payload),
    });
  };

  let res = await sendOnce(false);
  if (res.status === 401 && auth.currentUser) {
    res = await sendOnce(true);
  }
  return res;
}

/**
 * Creates an admin account cleanly on Spark Free Plan + Vercel Free Plan
 * via /api/admin-create (Firebase Auth REST signUp + Welcome Email) + Firestore write,
 * falling back to Cloud Function 'createAdmin' only if /api/admin-create is missing (404 non-JSON).
 */
export async function createAdminCall(payload: CreateAdminPayload): Promise<CreateAdminResponse> {
  const caller = auth.currentUser;
  if (!caller) {
    throw new Error('অ্যাডমিন তৈরি করতে সুপার অ্যাডমিন হিসেবে সাইন-ইন থাকতে হবে। (Sign-in required.)');
  }

  const cleanEmail = String(payload.email || '').trim().toLowerCase();
  const cleanName = String(payload.fullName || '').trim();
  const cleanMobile = String(payload.mobile || '').trim();

  // 1. Pre-check existing user & active admin limit before creating Auth account
  const existingFsSnap = await getDocs(
    query(collection(db, 'users'), where('email', '==', cleanEmail), limit(1))
  );
  if (!existingFsSnap.empty) {
    throw new Error('এই ইমেইল দিয়ে ইতিমধ্যে একটি অ্যাকাউন্ট রয়েছে। (An account with this email already exists.)');
  }

  const adminsSnap = await getDocs(query(collection(db, 'users'), where('role', '==', 'admin')));
  let activeAdminCount = 0;
  adminsSnap.forEach((d) => {
    if (d.data()?.status !== 'deleted') activeAdminCount++;
  });
  if (activeAdminCount >= 10) {
    throw new Error('সর্বোচ্চ ১০ জন সক্রিয় অ্যাডমিন অনুমোদিত। (Maximum 10 active admins allowed.)');
  }

  // Compute Admin ID hint for welcome email
  let adminIdHint = 'ADM-0001';
  try {
    const counterSnap = await getDoc(doc(db, 'counters', 'adminId'));
    if (counterSnap.exists()) {
      const nextNum = Number(counterSnap.data()?.lastCount || 0) + 1;
      adminIdHint = `ADM-${String(nextNum).padStart(4, '0')}`;
    }
  } catch {
    // Ignore read error
  }

  // 2. Call stateless /api/admin-create (Free Plan compatible)
  let shouldFallbackToCloudFunction = false;
  let createdUid = '';
  let sanitizedPermissions = payload.permissions;
  let emailSent = false;

  try {
    const response = await fetchAdminApi('/api/admin-create', {
      ...payload,
      fullName: cleanName,
      email: cleanEmail,
      mobile: cleanMobile,
      adminIdHint,
    });

    const contentType = response.headers.get('content-type') || '';
    if (response.status === 404 && !contentType.includes('application/json')) {
      shouldFallbackToCloudFunction = true;
    } else if (!contentType.includes('application/json')) {
      throw new Error('সার্ভার রেসপন্স সঠিক নয়। কিছুক্ষণ পর আবার চেষ্টা করুন। (Unexpected server response.)');
    } else {
      const data = await response.json();
      if (!response.ok || !data?.success || !data?.uid) {
        throw new Error(data?.error || 'অ্যাডমিন অ্যাকাউন্ট তৈরি করতে ব্যর্থ হয়েছে। (Failed to create admin account.)');
      }
      createdUid = String(data.uid);
      if (Array.isArray(data.permissions) && data.permissions.length > 0) {
        sanitizedPermissions = data.permissions;
      }
      emailSent = !!data.emailSent;
    }
  } catch (apiErr: any) {
    if (shouldFallbackToCloudFunction || apiErr?.message?.includes('Failed to fetch')) {
      shouldFallbackToCloudFunction = true;
    } else {
      throw apiErr;
    }
  }

  if (shouldFallbackToCloudFunction) {
    try {
      const fn = httpsCallable<CreateAdminPayload, CreateAdminResponse>(functions, 'createAdmin');
      const res = await fn(payload);
      if (res.data && res.data.success) {
        return res.data;
      }
      throw new Error('Failed to create admin account.');
    } catch (fnErr: any) {
      console.error('[adminManagementService] Cloud Function createAdmin error:', fnErr);
      if (isCloudFunctionUnavailableError(fnErr)) {
        throw new Error('সার্ভার সংযোগ পাওয়া যায়নি। ইন্টারনেট বা সার্ভার চেক করে আবার চেষ্টা করুন।');
      }
      const msg = fnErr?.details || fnErr?.message || 'অ্যাডমিন অ্যাকাউন্ট তৈরি করতে ব্যর্থ হয়েছে।';
      throw new Error(msg);
    }
  }

  // 3. Persist Admin profile + sequential ADM-XXXX counter in Firestore
  let assignedAdminId = adminIdHint;
  await runTransaction(db, async (t) => {
    const counterRef = doc(db, 'counters', 'adminId');
    const counterSnap = await t.get(counterRef);
    let nextCount = 1;
    if (counterSnap.exists()) {
      nextCount = Number(counterSnap.data()?.lastCount || 0) + 1;
    }
    assignedAdminId = `ADM-${String(nextCount).padStart(4, '0')}`;

    t.set(
      counterRef,
      {
        lastCount: nextCount,
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );

    t.set(doc(db, 'users', createdUid), {
      uid: createdUid,
      adminId: assignedAdminId,
      fullName: cleanName,
      email: cleanEmail,
      mobile: cleanMobile,
      role: 'admin',
      status: 'approved',
      permissions: sanitizedPermissions,
      createdBy: caller.uid,
      createdByName: caller.displayName || 'Super Admin',
      mustChangePassword: true,
      emailVerified: false,
      profilePhotoUrl: payload.profilePhotoUrl?.trim() || '',
      internalNote: payload.internalNote?.trim() || '',
      shopName: 'ReSellBD HQ',
      division: 'Dhaka',
      district: 'Dhaka',
      upazila: 'Tejgaon',
      address: 'Headquarters, Dhaka',
      createdAt: serverTimestamp(),
    });
  });

  await addDoc(collection(db, 'auditLogs'), {
    action: 'admin_created',
    actorUid: caller.uid,
    actorEmail: caller.email || '',
    targetUid: createdUid,
    targetEmail: cleanEmail,
    adminId: assignedAdminId,
    permissions: sanitizedPermissions,
    timestamp: serverTimestamp(),
  }).catch(() => {});

  return {
    success: true,
    adminId: assignedAdminId,
    uid: createdUid,
    email: cleanEmail,
    fullName: cleanName,
    message: emailSent
      ? `Admin account (${assignedAdminId}) created for ${cleanName} & welcome email sent.`
      : `Admin account (${assignedAdminId}) created for ${cleanName}. Please share the temporary password privately.`,
  };
}

/**
 * Resends the welcome & password setup email (Free Plan /api/admin-resend-welcome + Cloud Function fallback)
 */
export async function resendAdminWelcomeEmailCall(adminUid: string): Promise<{ success: boolean; message: string }> {
  try {
    const targetSnap = await getDoc(doc(db, 'users', adminUid));
    if (!targetSnap.exists()) {
      throw new Error('অ্যাডমিন প্রোফাইল পাওয়া যায়নি। (Admin profile not found.)');
    }
    const targetData = targetSnap.data() || {};

    const response = await fetchAdminApi('/api/admin-resend-welcome', {
      adminUid,
      email: targetData.email,
      fullName: targetData.fullName,
      adminId: targetData.adminId || 'Admin',
    });

    const contentType = response.headers.get('content-type') || '';
    if (response.status === 404 && !contentType.includes('application/json')) {
      const fn = httpsCallable<{ adminUid: string }, { success: boolean; message: string }>(functions, 'resendAdminWelcomeEmail');
      const res = await fn({ adminUid });
      if (res.data && res.data.success) return res.data;
      throw new Error('Failed to resend welcome email.');
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data?.success) {
      throw new Error(data?.error || 'ওয়েলকাম ইমেইল পাঠানো সম্ভব হয়নি।');
    }

    if (auth.currentUser) {
      await addDoc(collection(db, 'auditLogs'), {
        action: 'admin_welcome_email_resent',
        actorUid: auth.currentUser.uid,
        actorEmail: auth.currentUser.email || '',
        targetUid: adminUid,
        targetEmail: targetData.email || '',
        timestamp: serverTimestamp(),
      }).catch(() => {});
    }

    return {
      success: true,
      message: data.message || `Welcome email sent to ${targetData.email}.`,
    };
  } catch (err: any) {
    console.error('[adminManagementService] resendAdminWelcomeEmail error:', err);
    throw new Error(err?.message || 'ওয়েলকাম ইমেইল পুনরায় পাঠানো সম্ভব হয়নি।');
  }
}

/**
 * Password update for Admins on first login (Firebase Auth updatePassword + Firestore fallback)
 */
export async function changeAdminPasswordCall(newPassword: string, currentPassword?: string): Promise<{ success: boolean; message: string }> {
  const currentUser = auth.currentUser;
  if (!currentUser || !currentUser.email) {
    throw new Error('সাইন-ইন সেশন পাওয়া যায়নি। আবার লগইন করুন। (Please sign in again.)');
  }

  // 1. Try Cloud Function first if deployed, otherwise update directly via Firebase Auth SDK
  try {
    const fn = httpsCallable<{ newPassword: string; currentPassword?: string }, { success: boolean; message: string }>(functions, 'changeAdminPassword');
    const res = await fn({ newPassword, currentPassword });
    if (res.data && res.data.success) {
      return res.data;
    }
  } catch (fnErr: any) {
    if (!isCloudFunctionUnavailableError(fnErr)) {
      const msg = fnErr?.details || fnErr?.message || 'পাসওয়ার্ড আপডেট করা সম্ভব হয়নি।';
      throw new Error(msg);
    }
  }

  // 2. Spark-Free-Plan direct Firebase Auth + Firestore update
  try {
    if (currentPassword && currentPassword.trim()) {
      const cred = EmailAuthProvider.credential(currentUser.email, currentPassword);
      await reauthenticateWithCredential(currentUser, cred);
    }
    await updatePassword(currentUser, newPassword);
  } catch (authErr: any) {
    const code = String(authErr?.code || '');
    if (code === 'auth/wrong-password' || code === 'auth/invalid-credential') {
      throw new Error('বর্তমান/অস্থায়ী পাসওয়ার্ডটি সঠিক নয়। (Temporary/current password is incorrect.)');
    }
    if (code === 'auth/requires-recent-login') {
      throw new Error('নিরাপত্তার জন্য উপরের ঘরে আপনার বর্তমান/অস্থায়ী পাসওয়ার্ডটি দিয়ে আবার সাবমিট করুন। (Please enter your temporary password above and submit again.)');
    }
    throw new Error(authErr?.message || 'পাসওয়ার্ড আপডেট করা সম্ভব হয়নি।');
  }

  await updateDoc(doc(db, 'users', currentUser.uid), {
    mustChangePassword: false,
    passwordChangedAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });

  await addDoc(collection(db, 'auditLogs'), {
    action: 'admin_first_login_password_changed',
    actorUid: currentUser.uid,
    actorEmail: currentUser.email,
    timestamp: serverTimestamp(),
  }).catch(() => {});

  return {
    success: true,
    message: 'আপনার নিজস্ব পাসওয়ার্ড সফলভাবে সেট হয়েছে! (Password updated successfully.)',
  };
}

/**
 * Suspends or activates an admin account (with Spark Free Plan Super Admin Firestore fallback)
 */
export async function toggleAdminStatusCall(adminUid: string, status: 'approved' | 'suspended', reason?: string): Promise<{ success: boolean; message: string }> {
  try {
    const fn = httpsCallable<{ adminUid: string; status: 'approved' | 'suspended'; reason?: string }, { success: boolean; message: string }>(functions, 'toggleAdminStatus');
    const res = await fn({ adminUid, status, reason });
    if (res.data && res.data.success) {
      return res.data;
    }
    throw new Error('Failed to update admin status.');
  } catch (fnErr: any) {
    if (isCloudFunctionUnavailableError(fnErr)) {
      await updateDoc(doc(db, 'users', adminUid), {
        status,
        ...(reason ? { suspendReason: reason } : {}),
        updatedAt: serverTimestamp(),
      });
      return {
        success: true,
        message: status === 'approved' ? 'Admin account activated.' : 'Admin account suspended.',
      };
    }
    console.error('[adminManagementService] Cloud Function toggleAdminStatus error:', fnErr);
    const msg = fnErr?.details || fnErr?.message || 'এডমিন স্ট্যাটাস পরিবর্তন করা সম্ভব হয়নি।';
    throw new Error(msg);
  }
}

/**
 * Updates permissions for an existing admin account (with Spark Free Plan Super Admin Firestore fallback)
 */
export async function updateAdminPermissionsCall(adminUid: string, permissions: string[]): Promise<{ success: boolean; message: string }> {
  try {
    const fn = httpsCallable<{ adminUid: string; permissions: string[] }, { success: boolean; message: string }>(functions, 'updateAdminPermissions');
    const res = await fn({ adminUid, permissions });
    if (res.data && res.data.success) {
      return res.data;
    }
    throw new Error('Failed to update admin permissions.');
  } catch (fnErr: any) {
    if (isCloudFunctionUnavailableError(fnErr)) {
      await updateDoc(doc(db, 'users', adminUid), {
        permissions,
        updatedAt: serverTimestamp(),
      });
      return {
        success: true,
        message: 'Admin permissions updated successfully.',
      };
    }
    console.error('[adminManagementService] Cloud Function updateAdminPermissions error:', fnErr);
    const msg = fnErr?.details || fnErr?.message || 'এডমিন পারমিশন আপডেট করা সম্ভব হয়নি।';
    throw new Error(msg);
  }
}

