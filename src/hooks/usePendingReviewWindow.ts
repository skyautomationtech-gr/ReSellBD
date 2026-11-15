import { useEffect, useState, useRef } from 'react';
import { doc, setDoc, getDocFromServer, deleteDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { UserProfile } from '../types';

export const FIRST_HOUR_WINDOW_MS = 60 * 60 * 1000;

export function parseFirestoreTimestampMs(raw: any): number | null {
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

export function getPendingSubmissionMs(user: UserProfile | null | undefined): number | null {
  if (!user) return null;
  return (
    parseFirestoreTimestampMs(user.pendingSince) ??
    parseFirestoreTimestampMs(user.submittedAt) ??
    parseFirestoreTimestampMs(user.createdAt)
  );
}

export interface PendingReviewWindowState {
  isPendingReseller: boolean;
  isResolvingOffset: boolean;
  isWithinFirstHour: boolean;
  submittedAtMs: number | null;
  elapsedMs: number;
  remainingMs: number;
  progressRatio: number; // 0 (just submitted) -> 1 (60 minutes elapsed)
}

/**
 * Tracks whether a pending reseller is within their first 60 minutes since submission.
 * - Uses Firestore serverTimestamp write/read ONCE per pending session (in memory only; no client persistence)
 *   so the device's local clock cannot skew the 60-minute window.
 * - Automatically ticks and flips `isWithinFirstHour` to false when 60 minutes finish (no page reload needed).
 */
export function usePendingReviewWindow(userProfile: UserProfile | null | undefined): PendingReviewWindowState {
  const isPendingReseller = Boolean(
    userProfile && userProfile.role === 'reseller' && userProfile.status === 'pending'
  );
  const uid = userProfile?.uid || '';
  const submittedAtMs = getPendingSubmissionMs(userProfile);

  // Store offset purely in memory (never localStorage/sessionStorage)
  const [resolvedUid, setResolvedUid] = useState<string | null>(null);
  const [serverOffsetMs, setServerOffsetMs] = useState<number>(0);
  const [nowLocalMs, setNowLocalMs] = useState<number>(() => Date.now());
  const probingUidRef = useRef<string | null>(null);

  // Probe server timestamp offset once when a pending reseller session starts
  useEffect(() => {
    if (!isPendingReseller || !uid) {
      probingUidRef.current = null;
      setResolvedUid(null);
      setServerOffsetMs(0);
      return;
    }

    if (resolvedUid === uid || probingUidRef.current === uid) {
      return;
    }

    let cancelled = false;
    probingUidRef.current = uid;

    const fetchServerOffset = async () => {
      try {
        const probeRef = doc(db, 'users', uid, 'devices', '_serverTimeProbe');
        const probePromise = (async () => {
          const tBefore = Date.now();
          await setDoc(probeRef, { checkedAt: serverTimestamp() });
          const tAfterWrite = Date.now();
          const snap = await getDocFromServer(probeRef);
          const serverMs = parseFirestoreTimestampMs(snap.data()?.checkedAt);
          deleteDoc(probeRef).catch(() => {});
          return { serverMs, clientMidpointMs: Math.round((tBefore + tAfterWrite) / 2) };
        })();

        const timeoutPromise = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), 4000)
        );

        const result = await Promise.race([probePromise, timeoutPromise]);
        if (!cancelled && result && result.serverMs !== null) {
          setServerOffsetMs(result.serverMs - result.clientMidpointMs);
        }
      } catch (err) {
        // Offline / restricted fallback: default offset 0 until online
        console.warn('[PendingWindow] Server clock offset probe skipped (offline?):', err);
      } finally {
        if (!cancelled) {
          probingUidRef.current = null;
          setNowLocalMs(Date.now());
          setResolvedUid(uid);
        }
      }
    };

    fetchServerOffset();

    // If probe happened while offline and connection returns, sync server time once
    const handleOnline = () => {
      setResolvedUid((prev) => (prev === uid ? null : prev));
    };
    window.addEventListener('online', handleOnline);

    return () => {
      cancelled = true;
      window.removeEventListener('online', handleOnline);
    };
  }, [isPendingReseller, uid, resolvedUid]);

  const isResolvingOffset = Boolean(isPendingReseller && uid && resolvedUid !== uid);

  const serverNowMs = nowLocalMs + serverOffsetMs;
  const elapsedMs =
    isPendingReseller && !isResolvingOffset && submittedAtMs !== null
      ? Math.max(0, serverNowMs - submittedAtMs)
      : 0;
  const remainingMs =
    isPendingReseller && !isResolvingOffset && submittedAtMs !== null
      ? Math.max(0, FIRST_HOUR_WINDOW_MS - elapsedMs)
      : 0;

  const isWithinFirstHour = Boolean(
    isPendingReseller &&
      !isResolvingOffset &&
      submittedAtMs !== null &&
      remainingMs > 0
  );

  // Live 1s timer while inside the first hour so ring updates smoothly and switches to Home at 60:00
  useEffect(() => {
    if (!isWithinFirstHour) return;

    const tick = () => setNowLocalMs(Date.now());
    tick();
    const intervalId = setInterval(tick, 1000);
    return () => clearInterval(intervalId);
  }, [isWithinFirstHour]);

  const progressRatio =
    submittedAtMs !== null && !isResolvingOffset
      ? Math.min(1, Math.max(0, elapsedMs / FIRST_HOUR_WINDOW_MS))
      : 0;

  return {
    isPendingReseller,
    isResolvingOffset,
    isWithinFirstHour,
    submittedAtMs,
    elapsedMs,
    remainingMs,
    progressRatio,
  };
}
