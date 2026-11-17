import { PayoutMethod, UserProfile } from '../../../types';
import { formatResellerId } from '../../../lib/resellerIdHelper';

export interface NormalizedPayoutEntry {
  id: string;
  type: string;
  accountNumber: string;
  accountHolderName?: string | null;
  bankName?: string | null;
  branchName?: string | null;
  routingNumber?: string | null;
  isDefault: boolean;
  verified?: boolean;
}

export interface DuplicateConflict {
  field: 'Phone / WhatsApp' | 'NID Number' | 'Shop Name' | 'Payout Number';
  value: string;
  otherUid: string;
  otherName: string;
  otherShopName: string;
  otherResellerId: string;
  otherStatus: string;
}

export interface ParsedDeviceInfo {
  device: string;
  browser: string;
  raw: string;
}

export function parseTsMs(raw: any): number | null {
  if (!raw) return null;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw?.toMillis === 'function') return raw.toMillis();
  if (typeof raw?.toDate === 'function') return raw.toDate().getTime();
  if (typeof raw?.seconds === 'number') {
    return raw.seconds * 1000 + Math.floor((raw.nanoseconds || 0) / 1e6);
  }
  if (typeof raw?._seconds === 'number') {
    return raw._seconds * 1000 + Math.floor((raw._nanoseconds || 0) / 1e6);
  }
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

export function getSubmissionTimestamp(user: UserProfile): any {
  const anyUser = user as any;
  return anyUser.pendingSince ?? anyUser.submittedAt ?? user.createdAt;
}

export function getSubmissionMs(user: UserProfile): number {
  return parseTsMs(getSubmissionTimestamp(user)) ?? 0;
}

export function formatDateTime(raw: any): string {
  const ms = parseTsMs(raw);
  if (!ms) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(new Date(ms));
  } catch {
    return '—';
  }
}

export function getWaitingTimer(user: UserProfile, nowMs: number = Date.now()): {
  label: string;
  totalMinutes: number;
  isOverdue: boolean;
} {
  const submittedMs = getSubmissionMs(user);
  if (!submittedMs) {
    return { label: 'waiting 0m', totalMinutes: 0, isOverdue: false };
  }
  const diffMs = Math.max(0, nowMs - submittedMs);
  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const mins = totalMinutes % 60;

  let label = `waiting ${mins}m`;
  if (days > 0) {
    label = hours > 0 ? `waiting ${days}d ${hours}h` : `waiting ${days}d`;
  } else if (hours > 0) {
    label = `waiting ${hours}h ${mins}m`;
  }

  return {
    label,
    totalMinutes,
    isOverdue: user.status === 'pending' && totalMinutes >= 60,
  };
}

export function normalizeExternalUrl(rawUrl?: string | null): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
    return null;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed.replace(/^\/+/, '')}`;
}

export function buildWhatsAppHref(phone?: string | null): string {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('880')) return `https://wa.me/${digits}`;
  if (digits.startsWith('0')) return `https://wa.me/88${digits}`;
  return `https://wa.me/880${digits}`;
}

export function normalizePhoneKey(phone?: string | null): string {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length >= 10) {
    return digits.slice(-10);
  }
  return digits;
}

export function collectPayoutMethods(user: UserProfile): NormalizedPayoutEntry[] {
  const results: NormalizedPayoutEntry[] = [];
  const seen = new Set<string>();

  const pushEntry = (entry: NormalizedPayoutEntry) => {
    const cleanNum = (entry.accountNumber || '').trim();
    if (!cleanNum && !entry.bankName) return;
    const key = `${entry.type.toLowerCase()}::${cleanNum.replace(/\s+/g, '')}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push({ ...entry, accountNumber: cleanNum });
  };

  if (Array.isArray(user.payoutMethods)) {
    user.payoutMethods.forEach((pm: PayoutMethod, idx: number) => {
      pushEntry({
        id: pm.id || `pm_${idx}`,
        type: pm.type || 'Payout',
        accountNumber: pm.accountNumber || '',
        accountHolderName: pm.accountHolderName,
        bankName: pm.bankName,
        branchName: pm.branchName,
        routingNumber: pm.routingNumber,
        isDefault: Boolean(pm.isDefault),
        verified: Boolean(pm.verified),
      });
    });
  }

  const legacyMap: Array<{ key: keyof UserProfile; label: string }> = [
    { key: 'bkashNumber', label: 'bKash' },
    { key: 'nagadNumber', label: 'Nagad' },
    { key: 'rocketNumber', label: 'Rocket' },
    { key: 'upayNumber', label: 'Upay' },
  ];

  legacyMap.forEach(({ key, label }) => {
    const num = user[key];
    if (typeof num === 'string' && num.trim()) {
      pushEntry({
        id: `legacy_${key}`,
        type: label,
        accountNumber: num.trim(),
        accountHolderName: user.accountHolderName || user.fullName,
        isDefault:
          results.length === 0 ||
          (user.payoutMethod || '').toLowerCase() === label.toLowerCase(),
      });
    }
  });

  if (user.payoutMethod === 'bank' || user.bankName) {
    const bankAcc = user.accountNumber || '';
    if (bankAcc.trim() || user.bankName) {
      pushEntry({
        id: 'legacy_bank',
        type: 'Bank',
        accountNumber: bankAcc,
        accountHolderName: user.accountHolderName || user.fullName,
        bankName: user.bankName,
        branchName: user.branchName,
        routingNumber: user.routingNumber,
        isDefault: results.length === 0 || user.payoutMethod === 'bank',
      });
    }
  } else if (user.accountNumber && user.payoutMethod) {
    const labelMap: Record<string, string> = {
      bkash: 'bKash',
      nagad: 'Nagad',
      rocket: 'Rocket',
      upay: 'Upay',
      bank: 'Bank',
    };
    const label = labelMap[user.payoutMethod] || user.payoutMethod;
    pushEntry({
      id: 'legacy_primary',
      type: label,
      accountNumber: user.accountNumber,
      accountHolderName: user.accountHolderName || user.fullName,
      isDefault: results.length === 0,
    });
  }

  if (results.length > 0 && !results.some((r) => r.isDefault)) {
    results[0] = { ...results[0], isDefault: true };
  }

  return results;
}

export function extractCoordinates(user: UserProfile): { lat: number; lng: number } | null {
  const anyUser = user as any;
  const candidates = [
    anyUser.coordinates,
    anyUser.location,
    anyUser.geo,
    { lat: anyUser.lat ?? anyUser.latitude, lng: anyUser.lng ?? anyUser.lon ?? anyUser.longitude },
  ];

  for (const c of candidates) {
    if (!c) continue;
    const lat = Number(c.lat ?? c.latitude);
    const lng = Number(c.lng ?? c.lon ?? c.longitude);
    if (
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat !== 0 &&
      lng !== 0 &&
      Math.abs(lat) <= 90 &&
      Math.abs(lng) <= 180
    ) {
      return { lat, lng };
    }
  }
  return null;
}

export function findDuplicateMatches(
  target: UserProfile,
  allUsers: UserProfile[]
): DuplicateConflict[] {
  const conflicts: DuplicateConflict[] = [];
  const seenKeys = new Set<string>();

  const targetPhones = new Set(
    [target.mobile, target.whatsappNumber, target.whatsapp]
      .map((p) => normalizePhoneKey(p))
      .filter((k) => k.length >= 8)
  );
  const targetNid = (target.nidNumber || '').trim().replace(/\s+/g, '');
  const targetShop = (target.shopNameKey || target.shopName || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  const targetPayouts = new Set(
    collectPayoutMethods(target)
      .map((pm) => normalizePhoneKey(pm.accountNumber) || pm.accountNumber.trim().toLowerCase())
      .filter((k) => k.length >= 6)
  );

  for (const other of allUsers) {
    if (!other.uid || other.uid === target.uid) continue;

    const otherName = other.fullName || 'Unnamed User';
    const otherShop = other.shopName || '—';
    const otherId =
      other.resellerId || other.resellerCode
        ? formatResellerId(other)
        : other.adminId || other.uid.slice(0, 8);
    const otherStatus = other.status || 'unknown';

    const addConflict = (field: DuplicateConflict['field'], value: string) => {
      const dedupeKey = `${other.uid}::${field}::${value}`;
      if (seenKeys.has(dedupeKey)) return;
      seenKeys.add(dedupeKey);
      conflicts.push({
        field,
        value,
        otherUid: other.uid,
        otherName,
        otherShopName: otherShop,
        otherResellerId: otherId,
        otherStatus,
      });
    };

    if (targetPhones.size > 0) {
      const otherPhones = [other.mobile, other.whatsappNumber, other.whatsapp];
      for (const op of otherPhones) {
        const key = normalizePhoneKey(op);
        if (key && targetPhones.has(key)) {
          addConflict('Phone / WhatsApp', op || key);
          break;
        }
      }
    }

    if (targetNid.length >= 8) {
      const otherNid = (other.nidNumber || '').trim().replace(/\s+/g, '');
      if (otherNid && otherNid === targetNid) {
        addConflict('NID Number', targetNid);
      }
    }

    if (targetShop.length >= 2) {
      const otherShopKey = (other.shopNameKey || other.shopName || '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '');
      if (otherShopKey && otherShopKey === targetShop) {
        addConflict('Shop Name', other.shopName || target.shopName);
      }
    }

    if (targetPayouts.size > 0) {
      const otherPayouts = collectPayoutMethods(other);
      for (const pm of otherPayouts) {
        const k = normalizePhoneKey(pm.accountNumber) || pm.accountNumber.trim().toLowerCase();
        if (k && targetPayouts.has(k)) {
          addConflict('Payout Number', pm.accountNumber);
          break;
        }
      }
    }
  }

  return conflicts;
}

export function parseDeviceAndBrowser(rawUa?: string | null): ParsedDeviceInfo {
  const ua = (rawUa || '').trim();
  if (!ua) {
    return { device: 'Not recorded', browser: '—', raw: '' };
  }

  let device = 'Desktop / Web';
  if (/android/i.test(ua)) device = 'Android Device';
  else if (/iphone/i.test(ua)) device = 'iPhone (iOS)';
  else if (/ipad/i.test(ua)) device = 'iPad (iPadOS)';
  else if (/windows/i.test(ua)) device = 'Windows PC';
  else if (/mac os x|macintosh/i.test(ua)) device = 'Mac';
  else if (/linux/i.test(ua)) device = 'Linux';

  let browser = 'Web Browser';
  if (/edg\//i.test(ua)) browser = 'Microsoft Edge';
  else if (/opr\//i.test(ua) || /opera/i.test(ua)) browser = 'Opera';
  else if (/samsungbrowser/i.test(ua)) browser = 'Samsung Internet';
  else if (/ucbrowser/i.test(ua)) browser = 'UC Browser';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/crios|chrome/i.test(ua)) browser = 'Chrome';
  else if (/safari/i.test(ua)) browser = 'Safari';

  if (/wv\)/i.test(ua) || /capacitor/i.test(ua)) {
    browser = `${browser} (In-App)`;
  }

  return { device, browser, raw: ua };
}
