import { httpsCallable } from 'firebase/functions';
import { collection, doc, getDocs, limit, query, serverTimestamp, updateDoc, where } from 'firebase/firestore';
import { auth, db, functions } from './firebase';
import { normalizeShopName } from '../utils/shopName';

export interface CheckShopNameResult {
  available: boolean;
  shopNameKey: string;
  message?: string;
  isOwn?: boolean;
}

async function checkShopNameInFirestore(shopNameKey: string, excludeUid?: string): Promise<CheckShopNameResult | null> {
  if (!auth.currentUser) return null;
  try {
    const q = query(collection(db, 'users'), where('shopNameKey', '==', shopNameKey), limit(5));
    const snap = await getDocs(q);
    if (snap.empty) {
      return { available: true, shopNameKey, message: 'Shop name is available' };
    }
    const others = snap.docs.filter((d) => !excludeUid || d.id !== excludeUid);
    if (others.length === 0) {
      return { available: true, shopNameKey, isOwn: true, message: 'Shop name is available' };
    }
    return {
      available: false,
      shopNameKey,
      message: 'This shop name is already taken. Please choose a different name.',
    };
  } catch {
    return null;
  }
}

/**
 * Live check for shop name uniqueness across all resellers.
 * 1. If user is already signed in, queries Firestore users collection directly.
 * 2. Calls Express/Vercel API '/api/check-shop-name' (avoids Cloud Functions 404 on Spark Free Plan).
 * 3. If API is unavailable, falls back to Cloud Function 'checkShopName' if deployed.
 */
export async function checkShopNameAvailability(
  name: string,
  excludeUid?: string
): Promise<CheckShopNameResult> {
  const cleanName = (name || '').trim();
  const shopNameKey = normalizeShopName(cleanName);

  if (!shopNameKey || shopNameKey.length < 2) {
    return {
      available: false,
      shopNameKey,
      message: 'Shop name must be at least 2 characters long.',
    };
  }

  // 1. Authenticated direct Firestore check (most accurate when user is logged in)
  const fsResult = await checkShopNameInFirestore(shopNameKey, excludeUid);
  if (fsResult) {
    return fsResult;
  }

  // 2. Try server Express / Vercel API (safe for Spark Free Plan & pre-auth registration)
  try {
    const res = await fetch('/api/check-shop-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopName: cleanName, excludeUid }),
    });

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json') && res.ok) {
      const data = await res.json();
      return {
        available: !!data.available,
        shopNameKey,
        message: data.message,
        isOwn: data.isOwn,
      };
    }
  } catch (proxyErr) {
    console.warn('API /api/check-shop-name check failed:', proxyErr);
  }

  // 3. Try Cloud Function fallback (if deployed on Blaze)
  try {
    const checkCallable = httpsCallable<
      { name: string; excludeUid?: string },
      CheckShopNameResult
    >(functions, 'checkShopName');

    const res = await checkCallable({ name: cleanName, excludeUid });
    if (res.data) {
      return res.data;
    }
  } catch (fnErr: any) {
    if (fnErr.code === 'already-exists') {
      return {
        available: false,
        shopNameKey,
        message: 'This shop name is already taken. Please choose a different name.',
      };
    }
  }

  // 4. Fail-safe trigger: return deferred result instead of throwing if network/offline
  throw new Error('Could not verify the name, will be checked again on submit');
}

/**
 * Updates a reseller's shop name cleanly on both Blaze Cloud Functions & Spark Free Plan.
 */
export async function updateShopNameAtomic(
  newShopName: string,
  targetUid?: string
): Promise<{ success: boolean; shopNameKey: string }> {
  const cleanName = newShopName.trim();
  const newKey = normalizeShopName(cleanName);

  if (!newKey || newKey.length < 2) {
    throw new Error('Shop name must be at least 2 characters long.');
  }

  const effectiveUid = targetUid || auth.currentUser?.uid;

  // Check uniqueness in Firestore directly first when signed in (works seamlessly on Spark Free Plan)
  const fsCheck = await checkShopNameInFirestore(newKey, effectiveUid);
  if (fsCheck && !fsCheck.available) {
    throw new Error('This shop name is already taken. Please choose a different name.');
  }

  // Try Cloud Function 'updateShopName' (for Blaze deployments with shopNames index)
  try {
    const updateCallable = httpsCallable<
      { newShopName: string; targetUid?: string },
      { success: boolean; shopNameKey: string }
    >(functions, 'updateShopName');

    const res = await updateCallable({ newShopName: cleanName, targetUid });
    if (res.data?.success) {
      return res.data;
    }
  } catch (fnErr: any) {
    if (fnErr.message?.includes('already taken') || fnErr.code === 'already-exists') {
      throw new Error('This shop name is already taken. Please choose a different name.');
    }
    // On Spark Free Plan, Cloud Function is unavailable -> update user doc directly if permitted
    if (effectiveUid && auth.currentUser) {
      await updateDoc(doc(db, 'users', effectiveUid), {
        shopName: cleanName,
        shopNameKey: newKey,
        updatedAt: serverTimestamp(),
      });
      return { success: true, shopNameKey: newKey };
    }
    throw new Error(fnErr?.message || 'Failed to update shop name.');
  }

  return { success: true, shopNameKey: newKey };
}

/**
 * Triggers the admin migration to reserve shop names and generate shopNameKey for all existing resellers.
 */
export async function runShopNameMigration(): Promise<{
  success: boolean;
  totalResellers: number;
  migratedCount: number;
  duplicateCount: number;
  duplicates: Array<{
    shopNameKey: string;
    shopName: string;
    resellers: Array<{ uid: string; resellerId: string; email: string; shopName: string }>;
  }>;
}> {
  const migrateCallable = httpsCallable<
    void,
    {
      success: boolean;
      totalResellers: number;
      migratedCount: number;
      duplicateCount: number;
      duplicates: any[];
    }
  >(functions, 'migrateShopNames');

  const res = await migrateCallable();
  if (res.data?.success) {
    return res.data;
  }
  throw new Error('Failed to run shop name migration.');
}
