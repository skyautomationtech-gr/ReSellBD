import { auth } from './firebase';
import { getApiBaseUrl } from './emailOtpService';
import type { UserProfile } from '../types';

export interface StatusEmailDispatchResult {
  success: boolean;
  sent: boolean;
  skipped?: boolean;
  reason?: string;
  lastStatusEmailFor?: {
    status: string;
    sentAtMs: number;
    recentSentAtMs: number[];
  };
  error?: string;
}

const VALID_EMAIL_STATUSES = new Set(['pending', 'approved', 'rejected', 'suspended']);

/**
 * Triggers the server-side Gmail SMTP reseller status email endpoint (/api/reseller-status-email).
 * Never throws so Firestore status updates are never blocked if SMTP fails.
 */
export async function notifyResellerStatusEmail(params: {
  uid: string;
  beforeStatus?: string | null;
  afterStatus: string;
  isBackfill?: boolean;
}): Promise<StatusEmailDispatchResult> {
  const uid = String(params.uid || '').trim();
  const afterStatus = String(params.afterStatus || '').trim().toLowerCase();
  const beforeStatus = params.beforeStatus ? String(params.beforeStatus).trim().toLowerCase() : null;

  if (!uid || !VALID_EMAIL_STATUSES.has(afterStatus)) {
    return { success: false, sent: false, skipped: true, reason: 'invalid_params' };
  }

  if (!params.isBackfill && beforeStatus && beforeStatus === afterStatus) {
    return { success: true, sent: false, skipped: true, reason: 'status_unchanged' };
  }

  const postOnce = async (forceRefresh: boolean): Promise<Response> => {
    const idToken = auth.currentUser ? await auth.currentUser.getIdToken(forceRefresh) : '';
    return fetch(`${getApiBaseUrl()}/api/reseller-status-email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
      },
      credentials: 'same-origin',
      body: JSON.stringify({
        uid,
        beforeStatus,
        afterStatus,
        isBackfill: Boolean(params.isBackfill),
      }),
    });
  };

  try {
    let resp = await postOnce(false);
    if (resp.status === 401 && auth.currentUser) {
      resp = await postOnce(true);
    }

    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('application/json')) {
      return {
        success: false,
        sent: false,
        error: `Unexpected server response (${resp.status})`,
      };
    }

    const data = await resp.json();
    if (!resp.ok) {
      return {
        success: false,
        sent: false,
        error: data?.error || `HTTP ${resp.status}`,
      };
    }

    return {
      success: Boolean(data?.success),
      sent: Boolean(data?.sent),
      skipped: Boolean(data?.skipped),
      reason: data?.reason,
      lastStatusEmailFor: data?.lastStatusEmailFor,
    };
  } catch (err: any) {
    console.warn('[notifyResellerStatusEmail] Dispatch failed:', err?.message || err);
    return {
      success: false,
      sent: false,
      error: err?.message || 'Network error while sending status email',
    };
  }
}

/**
 * Returns true when an existing reseller has a valid email and never received
 * a status email for their current status (used to backfill previously missed resellers).
 */
export function needsStatusEmailBackfill(user: Partial<UserProfile> | null | undefined): boolean {
  if (!user || user.role !== 'reseller') return false;
  const email = String(user.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return false;
  if (email === 'skyautomationtech@gmail.com') return false;

  const currentStatus = String(user.status || '').trim().toLowerCase();
  if (!VALID_EMAIL_STATUSES.has(currentStatus)) return false;

  const emailedStatus = String(user.lastStatusEmailFor?.status || '').trim().toLowerCase();
  return emailedStatus !== currentStatus;
}

/**
 * Dispatches missed status emails sequentially to existing resellers who never received
 * an email for their current status. Safe & idempotent via `lastStatusEmailFor`.
 */
export async function sendMissedResellerStatusEmails(
  users: UserProfile[],
  onProgress?: (progress: {
    processed: number;
    total: number;
    sent: number;
    skipped: number;
    failed: number;
    uid: string;
    lastStatusEmailFor?: StatusEmailDispatchResult['lastStatusEmailFor'];
  }) => void
): Promise<{
  total: number;
  sent: number;
  skipped: number;
  failed: number;
  updatedRecords: Record<string, NonNullable<StatusEmailDispatchResult['lastStatusEmailFor']>>;
}> {
  const targets = users.filter(needsStatusEmailBackfill);
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const updatedRecords: Record<string, NonNullable<StatusEmailDispatchResult['lastStatusEmailFor']>> = {};

  for (let i = 0; i < targets.length; i++) {
    const u = targets[i];
    const result = await notifyResellerStatusEmail({
      uid: u.uid,
      beforeStatus: null,
      afterStatus: u.status,
      isBackfill: true,
    });

    if (result.sent) {
      sent++;
      if (result.lastStatusEmailFor) {
        updatedRecords[u.uid] = result.lastStatusEmailFor;
      }
    } else if (result.skipped) {
      skipped++;
    } else {
      failed++;
    }

    onProgress?.({
      processed: i + 1,
      total: targets.length,
      sent,
      skipped,
      failed,
      uid: u.uid,
      lastStatusEmailFor: result.lastStatusEmailFor,
    });

    // Small spacing between Gmail SMTP messages to avoid throttling
    if (i < targets.length - 1) {
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  return {
    total: targets.length,
    sent,
    skipped,
    failed,
    updatedRecords,
  };
}
