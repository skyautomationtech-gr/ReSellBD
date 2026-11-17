import { UserProfile } from '../types';

/**
 * Generates a clean 4-character uppercase alphanumeric code.
 * E.g. 'ERTY', '7K9P', 'X9Q2'
 */
export function generateRandomResellerSuffix(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // excluding I, O, 0, 1 for clarity
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Returns the short Reseller ID for UI/copy display by stripping any leading "SGR-" prefix
 * (e.g. "SGR-RSB-275986" -> "RSB-275986", "SGR-ERTY" -> "ERTY").
 * Does NOT modify any stored Firestore value.
 */
export function formatResellerId(userOrUid?: UserProfile | string | null, fallbackCode?: string): string {
  if (!userOrUid) return '0000';

  if (typeof userOrUid === 'string') {
    const trimmed = userOrUid.trim().toUpperCase();
    if (!trimmed) return '0000';

    if (/^SGR-/i.test(trimmed)) {
      return trimmed.replace(/^SGR-/i, '');
    }
    if (/^RSB-/i.test(trimmed)) {
      return trimmed;
    }
    if (fallbackCode && fallbackCode.trim()) {
      return fallbackCode.trim().toUpperCase().replace(/^SGR-/i, '');
    }
    // Deterministic 4-character suffix from UID when no reseller code exists
    const cleanUid = trimmed.replace(/[^A-Z0-9]/g, '');
    const suffix = cleanUid.length >= 4 ? cleanUid.slice(0, 4) : cleanUid.padEnd(4, 'X');
    return suffix || '0000';
  }

  // It's a UserProfile object
  const storedId = (userOrUid.resellerId || userOrUid.resellerCode || '').trim().toUpperCase();
  if (storedId) {
    return storedId.replace(/^SGR-/i, '');
  }

  // Derive from UID
  const cleanUid = (userOrUid.uid || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const suffix = cleanUid.length >= 4 ? cleanUid.slice(0, 4) : cleanUid.padEnd(4, 'X');
  return suffix || '0000';
}

/**
 * Normalizes a typed Reseller ID for login resolution.
 * Trims, uppercases, and prepends "SGR-" when the ID starts with "RSB-" without "SGR-".
 */
export function normalizeResellerIdForLogin(rawInput: string): string {
  const normalized = rawInput.trim().toUpperCase();
  if (normalized.startsWith('RSB-') && !normalized.startsWith('SGR-')) {
    return `SGR-${normalized}`;
  }
  return normalized;
}
