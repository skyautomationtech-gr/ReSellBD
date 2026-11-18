const crypto = require('crypto');
const nodemailer = require('nodemailer');
const admin = require('firebase-admin');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentCreated, onDocumentUpdated, onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const {
  getSupportContactInfo,
  buildStatusEmailPayload,
  claimStatusEmailSlot,
  buildLockedFieldsUpdatedEmailPayload,
  buildChangeRequestDecisionEmailPayload,
  buildPasswordResetEmailPayload,
  buildTemporaryPasswordSetEmailPayload,
} = require('./statusEmailHelper');

admin.initializeApp();

const REGION = 'asia-south1';
const FIRESTORE_DATABASE_ID =
  process.env.FIRESTORE_DATABASE_ID || 'ai-studio-5b67ed85-eca9-4578-81ec-a8f1bfd7298e';

setGlobalOptions({ region: REGION });

// Firebase Secret Manager parameters (never hardcoded, never defaulted)
const GMAIL_USER = defineSecret('GMAIL_USER');
const GMAIL_APP_PASSWORD = defineSecret('GMAIL_APP_PASSWORD');
const OTP_SECRET_SALT = defineSecret('OTP_SECRET_SALT');

function getDb() {
  if (FIRESTORE_DATABASE_ID && FIRESTORE_DATABASE_ID !== '(default)') {
    return getFirestore(FIRESTORE_DATABASE_ID);
  }
  return getFirestore();
}

function getOtpSalt() {
  const salt = String(OTP_SECRET_SALT.value() || '').trim();
  if (!salt) {
    console.error('[Config Error] Missing required Firebase secret: OTP_SECRET_SALT');
    throw new HttpsError(
      'failed-precondition',
      'Server OTP configuration is missing. Please contact the administrator.'
    );
  }
  return salt;
}

function getGmailConfig() {
  const user = String(GMAIL_USER.value() || '').trim();
  const pass = String(GMAIL_APP_PASSWORD.value() || '').replace(/\s+/g, '');
  if (!user || !pass) {
    console.error('[Config Error] Missing required Firebase secret(s): GMAIL_USER or GMAIL_APP_PASSWORD');
    throw new HttpsError(
      'failed-precondition',
      'Email delivery configuration is missing. Please contact the administrator.'
    );
  }
  return { user, pass };
}

function createGmailTransporter() {
  const { user, pass } = getGmailConfig();
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
  return { transporter, gmailUser: user };
}

function hashOtp(code, salt) {
  return crypto
    .createHash('sha256')
    .update(`${String(code).trim()}:${salt}`)
    .digest('hex');
}

function hashEmailForLog(email) {
  if (!email) return 'anonymous';
  return crypto
    .createHash('sha256')
    .update(String(email).trim().toLowerCase())
    .digest('hex')
    .substring(0, 10);
}

function normalizeEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function parseTimestampMs(val) {
  if (!val) return 0;
  if (typeof val.toDate === 'function') return val.toDate().getTime();
  if (typeof val.toMillis === 'function') return val.toMillis();
  if (typeof val === 'number') return val;
  if (val instanceof Date) return val.getTime();
  return new Date(val).getTime() || 0;
}

function generateSixDigitOtp() {
  return String(crypto.randomInt(100000, 1000000));
}

async function sendPushToTokens(tokens, payload) {
  const uniqueTokens = [...new Set((tokens || []).filter(Boolean))];
  if (uniqueTokens.length === 0) return { successCount: 0, failureCount: 0 };

  const stringData = {};
  if (payload.data) {
    for (const [k, v] of Object.entries(payload.data)) {
      stringData[k] = String(v ?? '');
    }
  }

  const message = {
    tokens: uniqueTokens,
    ...(payload.notification ? { notification: payload.notification } : {}),
    ...(Object.keys(stringData).length > 0 ? { data: stringData } : {}),
    android: {
      priority: 'high',
      ...(payload.sound ? { notification: { sound: payload.sound } } : {}),
    },
    apns: {
      payload: {
        aps: {
          contentAvailable: true,
          ...(payload.sound ? { sound: payload.sound } : {}),
        },
      },
    },
  };

  return admin.messaging().sendEachForMulticast(message);
}

/**
 * Checks whether the current time falls within user's configured quiet hours.
 */
function isWithinQuietHours(notifPref) {
  if (!notifPref || !notifPref.quietHoursEnabled) return false;
  try {
    const start = notifPref.quietHoursStart || '22:00';
    const end = notifPref.quietHoursEnd || '07:00';
    const now = new Date();
    const bdHours = (now.getUTCHours() + 6) % 24;
    const currentMinutes = bdHours * 60 + now.getUTCMinutes();

    const [sH, sM] = start.split(':').map(Number);
    const startMinutes = (sH || 0) * 60 + (sM || 0);

    const [eH, eM] = end.split(':').map(Number);
    const endMinutes = (eH || 0) * 60 + (eM || 0);

    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
    }
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  } catch (_e) {
    return false;
  }
}

// =========================================================================
// 1. FIRESTORE PUSH NOTIFICATION TRIGGERS (2nd-Gen, asia-south1)
// =========================================================================

exports.sendNewOrderNotification = onDocumentCreated(
  {
    document: 'orders/{orderId}',
    database: FIRESTORE_DATABASE_ID,
    region: REGION,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return null;
    const order = snap.data();
    if (!order) return null;

    const orderNumber = order.orderNumber || event.params.orderId;
    const amount = order.totalAmount || order.payableAmount || 0;
    const resellerName = order.resellerName || order.customerName || 'Reseller';

    const db = getDb();
    const usersSnap = await db
      .collection('users')
      .where('role', 'in', ['admin', 'super_admin'])
      .get();

    const tokens = [];
    usersSnap.forEach((docSnap) => {
      const userData = docSnap.data();
      const notifPref = userData.notificationPreferences || {};
      const orderAllowed = notifPref.orderUpdates !== false && notifPref.newOrder !== false;
      if (
        orderAllowed &&
        !isWithinQuietHours(notifPref) &&
        Array.isArray(userData.fcmTokens) &&
        userData.fcmTokens.length > 0
      ) {
        tokens.push(...userData.fcmTokens);
      }
    });

    if (tokens.length === 0) return null;

    try {
      const response = await sendPushToTokens(tokens, {
        notification: {
          title: 'New Order Received',
          body: `Order #${orderNumber} - ৳${amount} from ${resellerName}`,
        },
        data: {
          type: 'new_order',
          orderId: event.params.orderId,
          orderNumber: String(orderNumber),
        },
      });
      console.log(`Successfully sent ${response.successCount} new order push notifications.`);
    } catch (error) {
      console.error('Error sending new order push notification:', error);
    }
    return null;
  }
);

exports.sendOrderStatusNotification = onDocumentUpdated(
  {
    document: 'orders/{orderId}',
    database: FIRESTORE_DATABASE_ID,
    region: REGION,
  },
  async (event) => {
    const change = event.data;
    if (!change) return null;
    const before = change.before.data();
    const after = change.after.data();

    if (!before || !after || before.status === after.status) return null;

    const resellerId = after.resellerId || after.userId;
    if (!resellerId) return null;

    const db = getDb();
    const userDoc = await db.collection('users').doc(resellerId).get();
    if (!userDoc.exists) return null;

    const userData = userDoc.data();
    const notifPref = userData.notificationPreferences || {};
    const orderAllowed = notifPref.orderUpdates !== false && notifPref.orderStatus !== false;
    if (!orderAllowed || !Array.isArray(userData.fcmTokens) || userData.fcmTokens.length === 0) {
      return null;
    }

    if (isWithinQuietHours(notifPref)) return null;

    const orderNumber = after.orderNumber || event.params.orderId;
    const status = after.status || 'Updated';

    try {
      const response = await sendPushToTokens(userData.fcmTokens, {
        notification: {
          title: 'Order Status Updated',
          body: `Your order #${orderNumber} is now ${status}`,
        },
        sound: notifPref.sound !== false ? 'default' : undefined,
        data: {
          type: 'order_status',
          orderId: event.params.orderId,
          status: String(status),
        },
      });
      console.log(`Sent order status notification to reseller ${resellerId}:`, response.successCount);
    } catch (error) {
      console.error('Error sending order status notification:', error);
    }
    return null;
  }
);

exports.sendCommissionPayoutNotification = onDocumentCreated(
  {
    document: 'transactions/{txId}',
    database: FIRESTORE_DATABASE_ID,
    region: REGION,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return null;
    const tx = snap.data();
    if (!tx || !tx.userId) return null;

    const db = getDb();
    const userDoc = await db.collection('users').doc(tx.userId).get();
    if (!userDoc.exists) return null;

    const userData = userDoc.data();
    const notifPref = userData.notificationPreferences || {};
    if (!Array.isArray(userData.fcmTokens) || userData.fcmTokens.length === 0) return null;
    if (isWithinQuietHours(notifPref)) return null;

    let title = 'Wallet Update';
    let body = `৳${tx.amount || 0} wallet update recorded.`;
    let sendNotif = true;

    if (tx.type === 'commission' || tx.type === 'credit') {
      if (notifPref.commissionCredited === false || notifPref.commission === false) sendNotif = false;
      title = 'Commission Credited';
      body = `৳${tx.amount || 0} added to your wallet!`;
    } else if (tx.type === 'withdrawal' || tx.type === 'payout') {
      if (notifPref.payoutUpdates === false || notifPref.payout === false) sendNotif = false;
      title = 'Withdrawal Update';
      body = `Your withdrawal request of ৳${tx.amount || 0} is ${tx.status || 'processed'}`;
    } else {
      if (notifPref.walletActivity === false) sendNotif = false;
    }

    if (!sendNotif) return null;

    try {
      await sendPushToTokens(userData.fcmTokens, {
        notification: { title, body },
        sound: notifPref.sound !== false ? 'default' : undefined,
        data: {
          type: 'payout',
          txId: event.params.txId,
        },
      });
    } catch (err) {
      console.error('Error sending commission/payout push:', err);
    }
    return null;
  }
);

exports.sendImportantNoticeNotification = onDocumentCreated(
  {
    document: 'notices/{noticeId}',
    database: FIRESTORE_DATABASE_ID,
    region: REGION,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return null;
    const notice = snap.data();
    if (!notice) return null;

    const title = notice.title || 'Important Notice';
    const body = notice.message || notice.content || notice.preview || 'New announcement published.';

    const db = getDb();
    const usersSnap = await db.collection('users').get();
    const tokens = [];

    usersSnap.forEach((docSnap) => {
      const userData = docSnap.data();
      const notifPref = userData.notificationPreferences || {};
      const noticeAllowed = notifPref.importantNotices !== false && notifPref.importantNotice !== false;
      if (noticeAllowed && Array.isArray(userData.fcmTokens) && userData.fcmTokens.length > 0) {
        tokens.push(...userData.fcmTokens);
      }
    });

    if (tokens.length === 0) return null;

    try {
      await sendPushToTokens(tokens, {
        notification: { title, body },
        data: {
          type: 'important_notice',
          noticeId: event.params.noticeId,
        },
      });
    } catch (err) {
      console.error('Error sending notice push notification:', err);
    }
    return null;
  }
);

exports.sendAppUpdateNotification = onDocumentCreated(
  {
    document: 'appVersions/{versionId}',
    database: FIRESTORE_DATABASE_ID,
    region: REGION,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return null;
    const versionData = snap.data();
    if (!versionData) return null;

    const versionNum = versionData.version || '1.0.0';
    const releaseTitle = versionData.title || versionData.changelog || 'New Features & Bug Fixes';

    const db = getDb();
    const usersSnap = await db.collection('users').get();
    const tokens = [];

    usersSnap.forEach((docSnap) => {
      const userData = docSnap.data();
      const notifPref = userData.notificationPreferences || {};
      const appUpdateAllowed = notifPref.appUpdates !== false && notifPref.appUpdate !== false;
      if (
        appUpdateAllowed &&
        !isWithinQuietHours(notifPref) &&
        Array.isArray(userData.fcmTokens) &&
        userData.fcmTokens.length > 0
      ) {
        tokens.push(...userData.fcmTokens);
      }
    });

    if (tokens.length === 0) return null;

    try {
      await sendPushToTokens(tokens, {
        notification: {
          title: 'App Update Available',
          body: `Version ${versionNum} is now available - ${releaseTitle}`,
        },
        data: {
          type: 'app_update',
          version: String(versionNum),
        },
      });
    } catch (err) {
      console.error('Error sending app update push notification:', err);
    }
    return null;
  }
);

exports.sendTestPushNotification = onCall({ region: REGION, cors: true }, async (request) => {
  const uid = request.auth ? request.auth.uid : request.data?.userId;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'User authentication required.');
  }

  const db = getDb();
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists) {
    throw new HttpsError('not-found', 'User profile not found.');
  }

  const userData = userDoc.data();
  const tokens = Array.isArray(userData.fcmTokens) ? userData.fcmTokens : [];
  if (tokens.length === 0) {
    return { success: false, reason: 'no_tokens', message: 'No registered push devices found.' };
  }

  try {
    const res = await sendPushToTokens(tokens, {
      notification: {
        title: request.data?.title || 'ReSellBD Test Alert',
        body: request.data?.body || 'Push notifications are successfully configured!',
      },
      data: {
        type: 'test_notification',
        timestamp: String(Date.now()),
      },
    });
    return { success: true, count: res.successCount };
  } catch (err) {
    console.error('Test notification failed:', err);
    throw new HttpsError('internal', err.message || 'Failed to send test push notification.');
  }
});

// =========================================================================
// 2. RESELLER REGISTRATION EMAIL OTP (Firestore `emailOtps` only)
// =========================================================================

exports.sendEmailOtp = onCall(
  {
    region: REGION,
    cors: true,
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD, OTP_SECRET_SALT],
  },
  async (request) => {
    const email = normalizeEmail(request.data?.email);
    const emailHash = hashEmailForLog(email);

    try {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!email || !emailRegex.test(email)) {
        throw new HttpsError('invalid-argument', 'Please provide a valid email address.');
      }

      // Validate all required secrets up front (fails cleanly if missing)
      const otpSalt = getOtpSalt();
      const { transporter, gmailUser } = createGmailTransporter();

      const db = getDb();
      const existingUserSnap = await db
        .collection('users')
        .where('email', '==', email)
        .limit(1)
        .get();

      if (!existingUserSnap.empty) {
        const existingUser = existingUserSnap.docs[0].data();
        if (existingUser.status === 'approved') {
          throw new HttpsError(
            'already-exists',
            'This email address is already registered and approved. Please sign in.'
          );
        }
      }

      const otpDocRef = db.collection('emailOtps').doc(email);
      const otpDocSnap = await otpDocRef.get();
      const now = Date.now();

      if (otpDocSnap.exists) {
        const otpData = otpDocSnap.data() || {};

        const lockedUntil = parseTimestampMs(otpData.lockedUntil);
        if (lockedUntil > now) {
          const remainingMinutes = Math.ceil((lockedUntil - now) / 60000);
          throw new HttpsError(
            'resource-exhausted',
            `Too many failed attempts. Account is locked for ${remainingMinutes} more minute${remainingMinutes === 1 ? '' : 's'}.`
          );
        }

        const lastSent = parseTimestampMs(otpData.lastSentAt);
        const elapsedSeconds = Math.floor((now - lastSent) / 1000);
        if (lastSent > 0 && elapsedSeconds < 60) {
          const waitTime = 60 - elapsedSeconds;
          throw new HttpsError(
            'resource-exhausted',
            `Please wait ${waitTime} seconds before requesting a new OTP.`
          );
        }
      }

      const code = generateSixDigitOtp();
      const hashedCode = hashOtp(code, otpSalt);
      const expiresAt = Timestamp.fromDate(new Date(now + 10 * 60 * 1000)); // 10 minutes

      // Replace any previous OTP record cleanly
      await otpDocRef.set({
        email,
        type: 'reseller_registration',
        hashedCode,
        expiresAt,
        attemptsLeft: 5,
        lastSentAt: FieldValue.serverTimestamp(),
        lockedUntil: null,
      });

      try {
        await transporter.sendMail({
          from: `"ReSellBD Verification" <${gmailUser}>`,
          to: email,
          subject: `${code} is your ReSellBD Reseller Verification Code`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 560px; margin: 0 auto; padding: 24px; background: #050B1A; color: #ffffff; border-radius: 16px; border: 1px solid rgba(255,255,255,0.1);">
              <div style="text-align: center; margin-bottom: 24px;">
                <h1 style="color: #3DD055; margin: 0; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">ReSellBD</h1>
                <p style="color: #0E9AA7; font-size: 13px; margin: 4px 0 0 0; text-transform: uppercase; font-weight: 700; letter-spacing: 1px;">Reseller Portal Verification</p>
              </div>
              <div style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 20px;">
                <p style="margin: 0 0 12px 0; color: #94a3b8; font-size: 14px;">Your 6-digit email verification code is:</p>
                <div style="font-size: 36px; font-weight: 900; letter-spacing: 8px; color: #3DD055; padding: 12px; background: rgba(0,0,0,0.3); border-radius: 8px; display: inline-block; font-family: monospace;">
                  ${code}
                </div>
                <p style="margin: 12px 0 0 0; color: #cbd5e1; font-size: 12px;">This code will expire in <strong>10 minutes</strong>. If you do not see it in Inbox, check your <strong>Spam / Junk</strong> folder.</p>
              </div>
              <p style="color: #64748b; font-size: 11px; text-align: center; margin: 0;">
                Sent automatically by ReSellBD. Do not share this code with anyone.
              </p>
            </div>
          `,
        });
        console.log(`[sendEmailOtp] Dispatched OTP email for emailHash=${emailHash}`);
      } catch (mailErr) {
        console.error(`[sendEmailOtp] SMTP delivery failed for emailHash=${emailHash}:`, mailErr?.message || mailErr);
        // Delete un-delivered OTP record so user can retry immediately without hitting 60s cooldown
        await otpDocRef.delete().catch(() => {});
        throw new HttpsError(
          'internal',
          'Could not deliver the verification email. Please verify your email address and try again.'
        );
      }

      return {
        success: true,
        message: 'Verification code sent to your email address.',
        email,
        expiresInSeconds: 600,
        cooldownSeconds: 60,
      };
    } catch (err) {
      if (err instanceof HttpsError) {
        throw err;
      }
      console.error(`[sendEmailOtp] Unhandled error for emailHash=${emailHash}:`, err);
      throw new HttpsError('internal', 'Could not send verification email. Please try again later.');
    }
  }
);

exports.verifyEmailOtp = onCall(
  {
    region: REGION,
    cors: true,
    secrets: [OTP_SECRET_SALT],
  },
  async (request) => {
    const email = normalizeEmail(request.data?.email);
    const code = String(request.data?.code ?? '').trim();
    const emailHash = hashEmailForLog(email);

    try {
      if (!email || !/^\d{6}$/.test(code)) {
        throw new HttpsError('invalid-argument', 'Please enter the full 6-digit verification code.');
      }

      const otpSalt = getOtpSalt();
      const db = getDb();
      const otpDocRef = db.collection('emailOtps').doc(email);
      const otpDocSnap = await otpDocRef.get();

      if (!otpDocSnap.exists) {
        throw new HttpsError(
          'not-found',
          'No active verification code found for this email. Please request a new code.'
        );
      }

      const otpData = otpDocSnap.data() || {};
      const now = Date.now();

      const lockedUntil = parseTimestampMs(otpData.lockedUntil);
      if (lockedUntil > now) {
        const remainingMinutes = Math.ceil((lockedUntil - now) / 60000);
        throw new HttpsError(
          'resource-exhausted',
          `Account is locked due to too many failed attempts. Please wait ${remainingMinutes} more minute${remainingMinutes === 1 ? '' : 's'}.`
        );
      }

      const expiresAt = parseTimestampMs(otpData.expiresAt);
      if (!expiresAt || now > expiresAt) {
        await otpDocRef.delete();
        throw new HttpsError(
          'deadline-exceeded',
          'This verification code has expired. Please request a new one.'
        );
      }

      const attemptsLeft = typeof otpData.attemptsLeft === 'number' ? otpData.attemptsLeft : 5;
      if (attemptsLeft <= 0) {
        await otpDocRef.update({
          lockedUntil: Timestamp.fromDate(new Date(now + 15 * 60 * 1000)),
          attemptsLeft: 0,
        });
        throw new HttpsError(
          'resource-exhausted',
          'Maximum verification attempts exceeded. Account is locked for 15 minutes.'
        );
      }

      const inputHash = hashOtp(code, otpSalt);
      if (!otpData.hashedCode || inputHash !== otpData.hashedCode) {
        const remaining = attemptsLeft - 1;
        if (remaining <= 0) {
          await otpDocRef.update({
            lockedUntil: Timestamp.fromDate(new Date(now + 15 * 60 * 1000)),
            attemptsLeft: 0,
          });
          throw new HttpsError(
            'resource-exhausted',
            'Incorrect code. Maximum attempts exceeded. Account is locked for 15 minutes.'
          );
        }

        // Count attempt ONLY on wrong code
        await otpDocRef.update({ attemptsLeft: remaining });
        throw new HttpsError(
          'permission-denied',
          `Incorrect code. You have ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} remaining.`
        );
      }

      // Verified: record short-lived server verification marker for finalizeRegistration, then delete OTP record
      await db.collection('verifiedEmails').doc(email).set({
        email,
        verified: true,
        verifiedAt: FieldValue.serverTimestamp(),
        verifiedUntil: Timestamp.fromDate(new Date(now + 30 * 60 * 1000)),
      });

      await otpDocRef.delete();
      console.log(`[verifyEmailOtp] OTP verified and deleted for emailHash=${emailHash}`);

      return {
        verified: true,
      };
    } catch (err) {
      if (err instanceof HttpsError) {
        throw err;
      }
      console.error(`[verifyEmailOtp] Unhandled error for emailHash=${emailHash}:`, err);
      throw new HttpsError('internal', 'Failed to verify code due to a server error. Please try again.');
    }
  }
);

// =========================================================================
// 3. RESELLER LOGIN ID RESOLUTION & REGISTRATION FINALIZATION
// =========================================================================

const resolveIdRateLimitMap = new Map();

exports.resolveLoginId = onCall({ region: REGION, cors: true }, async (request) => {
  const rawId = String(request.data?.loginId || '').trim();
  if (!rawId) {
    throw new HttpsError('invalid-argument', 'Invalid ID or password');
  }

  const callerKey = request.rawRequest?.ip || request.auth?.uid || 'anonymous';
  const now = Date.now();
  const limitWindow = 60 * 1000;
  const maxAttempts = 15;

  const currentRate = resolveIdRateLimitMap.get(callerKey) || { count: 0, windowStart: now };
  if (now - currentRate.windowStart > limitWindow) {
    currentRate.count = 1;
    currentRate.windowStart = now;
  } else {
    currentRate.count++;
  }
  resolveIdRateLimitMap.set(callerKey, currentRate);

  if (currentRate.count > maxAttempts) {
    throw new HttpsError('resource-exhausted', 'Too many login attempts. Please wait a moment and try again.');
  }

  const cleanId = rawId.toUpperCase();
  const db = getDb();

  try {
    let userSnap = await db.collection('users').where('resellerId', '==', cleanId).limit(1).get();
    if (userSnap.empty) {
      userSnap = await db.collection('users').where('resellerCode', '==', cleanId).limit(1).get();
    }

    if (userSnap.empty) {
      throw new HttpsError('not-found', 'Invalid ID or password');
    }

    const userData = userSnap.docs[0].data();
    if (!userData.email) {
      throw new HttpsError('not-found', 'Invalid ID or password');
    }

    return {
      success: true,
      email: userData.email,
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error('Error resolving reseller login ID:', err);
    throw new HttpsError('not-found', 'Invalid ID or password');
  }
});

function normalizeShopName(name) {
  if (!name || typeof name !== 'string') return '';
  return name
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

const checkShopNameRateLimits = new Map();
function isRateLimited(key, limit = 60, windowMs = 60000) {
  const now = Date.now();
  const record = checkShopNameRateLimits.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + windowMs;
    checkShopNameRateLimits.set(key, record);
    return false;
  }
  record.count += 1;
  checkShopNameRateLimits.set(key, record);
  return record.count > limit;
}

exports.checkShopName = onCall({ region: REGION, cors: true }, async (request) => {
  const ip =
    request.rawRequest?.headers?.['x-forwarded-for'] ||
    request.rawRequest?.ip ||
    'unknown_ip';

  if (isRateLimited(String(ip), 60, 60000)) {
    throw new HttpsError('resource-exhausted', 'Too many requests. Please wait a moment before trying again.');
  }

  const rawName = String(request.data?.name || request.data?.shopName || '').trim();
  const shopNameKey = normalizeShopName(rawName);

  if (!shopNameKey || shopNameKey.length < 2) {
    return {
      available: false,
      shopNameKey,
      message: 'Shop name must be at least 2 characters long.',
    };
  }

  const excludeUid = request.data?.excludeUid || request.auth?.uid;
  const db = getDb();
  const snap = await db.collection('shopNames').doc(shopNameKey).get();

  if (!snap.exists) {
    return {
      available: true,
      shopNameKey,
      message: 'Shop name is available',
    };
  }

  const docData = snap.data();
  if (excludeUid && docData?.uid === excludeUid) {
    return {
      available: true,
      shopNameKey,
      isOwn: true,
      message: 'Shop name is available',
    };
  }

  return {
    available: false,
    shopNameKey,
    message: 'This shop name is already taken. Please choose a different name.',
  };
});

exports.finalizeRegistration = onCall({ region: REGION, cors: true }, async (request) => {
  const uid = request.data?.uid || request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'User must be authenticated.');
  }

  const formData = request.data?.formData || {};
  const email = normalizeEmail(request.data?.email || formData.email);
  const rawShopName = String(formData.shopName || '').trim();
  const shopNameKey = normalizeShopName(rawShopName);

  if (!shopNameKey || shopNameKey.length < 2) {
    throw new HttpsError('invalid-argument', 'Shop name must be at least 2 characters long.');
  }

  const db = getDb();
  const counterRef = db.collection('counters').doc('resellerId');
  const userRef = db.collection('users').doc(uid);
  const shopNameReservationRef = db.collection('shopNames').doc(shopNameKey);
  const emailOtpRef = db.collection('emailOtps').doc(email);
  const verifiedEmailRef = db.collection('verifiedEmails').doc(email);

  let assignedResellerId = '';

  try {
    await db.runTransaction(async (t) => {
      const verifiedEmailSnap = await t.get(verifiedEmailRef);
      const emailOtpSnap = await t.get(emailOtpRef);

      const vData = verifiedEmailSnap.exists ? verifiedEmailSnap.data() : null;
      if (!vData || !vData.verified) {
        throw new HttpsError(
          'failed-precondition',
          'Email verification is required before finalizing registration.'
        );
      }

      const verifiedUntil = parseTimestampMs(vData.verifiedUntil);
      if (verifiedUntil && Date.now() > verifiedUntil) {
        throw new HttpsError(
          'failed-precondition',
          'Email verification has expired. Please verify your email again.'
        );
      }

      if (verifiedEmailSnap.exists) t.delete(verifiedEmailRef);
      if (emailOtpSnap.exists) t.delete(emailOtpRef);

      const shopNameSnap = await t.get(shopNameReservationRef);
      if (shopNameSnap.exists) {
        const existingReservation = shopNameSnap.data();
        if (existingReservation && existingReservation.uid !== uid) {
          throw new HttpsError(
            'already-exists',
            'This shop name is already taken. Please choose a different name.'
          );
        }
      }

      const counterDoc = await t.get(counterRef);
      let currentCount = 0;
      if (counterDoc.exists) {
        currentCount = counterDoc.data().lastCount || 0;
      }
      const nextCount = currentCount + 1;
      assignedResellerId = `RSB-${String(nextCount).padStart(6, '0')}`;

      t.set(
        counterRef,
        {
          lastCount: nextCount,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      t.set(shopNameReservationRef, {
        uid,
        shopName: rawShopName,
        shopNameKey,
        createdAt: FieldValue.serverTimestamp(),
      });

      const userPayload = {
        uid,
        resellerId: assignedResellerId,
        resellerCode: assignedResellerId,
        role: 'reseller',
        status: 'pending',
        rejectReason: null,
        emailVerified: true,
        termsVersion: request.data?.termsVersion || '1.0',
        termsAcceptedAt: FieldValue.serverTimestamp(),
        privacyAcceptedAt: FieldValue.serverTimestamp(),
        createdAt: FieldValue.serverTimestamp(),

        fullName: String(formData.fullName || '').trim(),
        shopName: rawShopName,
        shopNameKey,
        mobile: String(formData.mobile || '').trim(),
        whatsappNumber: String(formData.whatsappNumber || formData.mobile || '').trim(),
        whatsapp: String(formData.whatsappNumber || formData.mobile || '').trim(),
        email,
        dob: formData.dob || '',
        gender: formData.gender || 'male',

        division: formData.division || formData.customDivision || '',
        divisionId: formData.divisionId || '',
        district: formData.district || formData.customDistrict || '',
        districtId: formData.districtId || '',
        upazila: formData.upazila || formData.customUpazila || '',
        upazilaId: formData.upazilaId || '',
        union: formData.union || formData.customUnion || '',
        unionId: formData.unionId || '',
        ward: formData.ward || '',
        postalCode: String(formData.postalCode || '').trim(),
        address: String(formData.address || '').trim(),

        payoutMethod: formData.payoutMethod || 'bkash',
        payoutMethods: formData.payoutMethods || [],
        accountHolderName: String(formData.accountHolderName || formData.fullName || '').trim(),
        accountNumber: String(formData.accountNumber || '').trim(),
        bkashNumber: formData.payoutMethod === 'bkash' ? formData.accountNumber : '',
        nagadNumber: formData.payoutMethod === 'nagad' ? formData.accountNumber : '',
        rocketNumber: formData.payoutMethod === 'rocket' ? formData.accountNumber : '',
        upayNumber: formData.payoutMethod === 'upay' ? formData.accountNumber : '',
        bankName: formData.bankName || formData.customBankName || '',
        branchName: formData.branchName || '',
        routingNumber: formData.routingNumber || '',

        facebookPage: String(formData.facebookPage || '').trim(),
        tiktokUrl: String(formData.tiktokUrl || '').trim(),
        instagramUrl: String(formData.instagramUrl || '').trim(),
        youtubeUrl: String(formData.youtubeUrl || '').trim(),

        shopLogoUrl: formData.shopLogoUrl || '',
        documentType: formData.documentType || 'nid',
        nidNumber: String(formData.nidNumber || '').trim(),
        birthCertificateNumber: String(formData.birthCertificateNumber || '').trim(),
        nidFrontUrl: formData.nidFrontUrl || '',
        nidBackUrl: formData.nidBackUrl || '',
        birthCertificateUrl: formData.birthCertificateUrl || '',

        profilePhotoUrl: formData.shopLogoUrl || '',
        shopPhotoUrl: formData.shopLogoUrl || '',
        nidUrl: formData.nidFrontUrl || formData.birthCertificateUrl || '',
      };

      t.set(userRef, userPayload, { merge: true });
    });

    try {
      const adminSnap = await db.collection('users').where('role', 'in', ['admin', 'super_admin']).get();
      const tokens = [];
      adminSnap.forEach((d) => {
        const u = d.data();
        if (Array.isArray(u.fcmTokens) && u.fcmTokens.length > 0) {
          tokens.push(...u.fcmTokens);
        }
      });

      if (tokens.length > 0) {
        await sendPushToTokens(tokens, {
          notification: {
            title: 'New Reseller Pending Approval',
            body: `${rawShopName || 'New Reseller'} (${assignedResellerId}) has applied and is waiting for review.`,
          },
          data: {
            type: 'reseller_approval',
            uid,
            resellerId: assignedResellerId,
            shopName: rawShopName,
          },
        });
      }
    } catch (notifErr) {
      console.warn('Could not dispatch admin registration push notification:', notifErr);
    }

    return {
      success: true,
      resellerId: assignedResellerId,
      shopNameKey,
      message: 'Registration finalized successfully! Your account is pending admin approval.',
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error('Error finalizing registration:', err);
    throw new HttpsError('internal', err.message || 'Failed to finalize registration.');
  }
});

exports.updateShopName = onCall({ region: REGION, cors: true }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'User must be authenticated.');
  }

  const rawShopName = String(request.data?.shopName || request.data?.newShopName || '').trim();
  const newKey = normalizeShopName(rawShopName);

  if (!newKey || newKey.length < 2) {
    throw new HttpsError('invalid-argument', 'Shop name must be at least 2 characters long.');
  }

  const db = getDb();
  const callerDoc = await db.collection('users').doc(callerUid).get();
  if (!callerDoc.exists) {
    throw new HttpsError('not-found', 'Caller user record not found.');
  }
  const callerData = callerDoc.data() || {};
  if (callerData.role !== 'super_admin') {
    throw new HttpsError(
      'permission-denied',
      'Only Super Admin can update shop names. Please submit a change request instead.'
    );
  }

  const targetUid = request.data?.targetUid ? String(request.data.targetUid).trim() : callerUid;
  const targetUserRef = db.collection('users').doc(targetUid);

  try {
    await db.runTransaction(async (t) => {
      const targetUserSnap = await t.get(targetUserRef);
      if (!targetUserSnap.exists) {
        throw new HttpsError('not-found', 'Target user does not exist.');
      }
      const targetUserData = targetUserSnap.data();
      const oldKey = targetUserData.shopNameKey || normalizeShopName(targetUserData.shopName || '');

      const newReservationRef = db.collection('shopNames').doc(newKey);
      const newReservationSnap = await t.get(newReservationRef);

      if (newReservationSnap.exists) {
        const reservationData = newReservationSnap.data();
        if (reservationData?.uid !== targetUid) {
          throw new HttpsError(
            'already-exists',
            'This shop name is already taken. Please choose a different name.'
          );
        }
      }

      if (oldKey && oldKey !== newKey) {
        t.delete(db.collection('shopNames').doc(oldKey));
      }

      t.set(
        newReservationRef,
        {
          uid: targetUid,
          shopName: rawShopName,
          shopNameKey: newKey,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      t.update(targetUserRef, {
        shopName: rawShopName,
        shopNameKey: newKey,
        updatedAt: FieldValue.serverTimestamp(),
      });
    });

    return {
      success: true,
      shopName: rawShopName,
      shopNameKey: newKey,
      message: 'Shop name updated successfully!',
    };
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.error('Error updating shop name:', err);
    throw new HttpsError('internal', err.message || 'Failed to update shop name.');
  }
});

exports.migrateShopNames = onCall({ region: REGION, cors: true }, async (request) => {
  const callerUid = request.auth?.uid;
  if (!callerUid) {
    throw new HttpsError('unauthenticated', 'User must be authenticated.');
  }

  const db = getDb();
  const callerDoc = await db.collection('users').doc(callerUid).get();
  if (!callerDoc.exists) {
    throw new HttpsError('not-found', 'User record not found.');
  }
  const callerData = callerDoc.data();
  if (callerData.role !== 'admin' && callerData.role !== 'super_admin') {
    throw new HttpsError('permission-denied', 'Only Admins can run the shop name migration.');
  }

  const usersSnap = await db.collection('users').get();
  const resellers = [];

  usersSnap.forEach((docSnap) => {
    const u = docSnap.data();
    if (u.role === 'reseller' || u.shopName) {
      resellers.push({
        uid: docSnap.id,
        shopName: (u.shopName || '').trim(),
        resellerId: u.resellerId || u.resellerCode || docSnap.id,
        email: u.email || '',
        shopNameKey: u.shopNameKey || '',
      });
    }
  });

  const groups = new Map();
  for (const r of resellers) {
    if (!r.shopName) continue;
    const key = normalizeShopName(r.shopName);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const duplicates = [];
  let migratedCount = 0;
  let opsCount = 0;
  const batches = [db.batch()];

  for (const [key, list] of groups.entries()) {
    if (list.length > 1) {
      duplicates.push({
        shopNameKey: key,
        shopName: list[0].shopName,
        resellers: list.map((item) => ({
          uid: item.uid,
          resellerId: item.resellerId,
          email: item.email,
          shopName: item.shopName,
        })),
      });
      continue;
    }

    const single = list[0];
    const currentBatch = batches[batches.length - 1];

    currentBatch.set(
      db.collection('shopNames').doc(key),
      {
        uid: single.uid,
        shopName: single.shopName,
        shopNameKey: key,
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    currentBatch.update(db.collection('users').doc(single.uid), {
      shopNameKey: key,
      updatedAt: FieldValue.serverTimestamp(),
    });

    migratedCount++;
    opsCount += 2;
    if (opsCount >= 400) {
      batches.push(db.batch());
      opsCount = 0;
    }
  }

  for (const b of batches) {
    await b.commit();
  }

  return {
    success: true,
    totalResellers: resellers.length,
    migratedCount,
    duplicateCount: duplicates.length,
    duplicates,
  };
});

// =========================================================================
// 4. SCHEDULED FUNCTIONS (2nd-Gen, asia-south1)
// =========================================================================

/**
 * Scheduled Hourly Cleanup:
 * Deletes expired OTP records from `emailOtps` (preserving active 15-min security locks)
 * and expired verification markers from `verifiedEmails`.
 */
exports.cleanupExpiredEmailOtps = onSchedule(
  {
    schedule: 'every 1 hours',
    region: REGION,
  },
  async () => {
    const db = getDb();
    const nowTs = Timestamp.now();
    const nowMs = nowTs.toMillis();
    let deletedOtps = 0;
    let deletedVerified = 0;

    // 1. Delete expired `emailOtps` documents in batches
    const expiredOtpsSnap = await db
      .collection('emailOtps')
      .where('expiresAt', '<', nowTs)
      .limit(450)
      .get();

    if (!expiredOtpsSnap.empty) {
      const batch = db.batch();
      expiredOtpsSnap.docs.forEach((docSnap) => {
        const data = docSnap.data() || {};
        const lockedUntilMs = parseTimestampMs(data.lockedUntil);
        // Preserve records still under an active 15-minute brute-force lockout
        if (!lockedUntilMs || lockedUntilMs < nowMs) {
          batch.delete(docSnap.ref);
          deletedOtps++;
        }
      });
      if (deletedOtps > 0) {
        await batch.commit();
      }
    }

    // 2. Delete expired `verifiedEmails` markers
    const expiredVerifiedSnap = await db
      .collection('verifiedEmails')
      .where('verifiedUntil', '<', nowTs)
      .limit(450)
      .get();

    if (!expiredVerifiedSnap.empty) {
      const batch = db.batch();
      expiredVerifiedSnap.docs.forEach((docSnap) => {
        batch.delete(docSnap.ref);
        deletedVerified++;
      });
      await batch.commit();
    }

    console.log(
      `[cleanupExpiredEmailOtps] Deleted ${deletedOtps} expired emailOtps and ${deletedVerified} expired verifiedEmails.`
    );
  }
);

/**
 * Scheduled 10-minute SLA check for pending reseller approvals.
 */
exports.checkPendingApprovals = onSchedule(
  {
    schedule: 'every 10 minutes',
    region: REGION,
  },
  async () => {
    const db = getDb();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const pendingResellers = await db
      .collection('users')
      .where('status', '==', 'pending')
      .where('createdAt', '<', Timestamp.fromDate(oneHourAgo))
      .get();

    if (pendingResellers.empty) return;

    const batch = db.batch();
    const adminTokens = [];
    const adminSnap = await db.collection('users').where('role', 'in', ['admin', 'super_admin']).get();
    adminSnap.forEach((d) => {
      const u = d.data();
      if (Array.isArray(u.fcmTokens)) adminTokens.push(...u.fcmTokens);
    });

    let updates = 0;
    for (const docSnap of pendingResellers.docs) {
      const reseller = docSnap.data();
      if (reseller.slaNotified === true) continue;

      if (adminTokens.length > 0) {
        try {
          await sendPushToTokens(adminTokens, {
            notification: {
              title: 'Registration Pending > 1h',
              body: `Registration pending for: ${reseller.shopName || 'Reseller'} (${String(reseller.resellerId || '').replace(/^SGR-/i, '')})`,
            },
          });
        } catch (e) {
          console.error(e);
        }
      }

      if (Array.isArray(reseller.fcmTokens) && reseller.fcmTokens.length > 0) {
        try {
          await sendPushToTokens(reseller.fcmTokens, {
            notification: {
              title: 'Review in Progress',
              body: 'Your approval is taking a little longer than usual. We are reviewing it — thank you for your patience.',
            },
          });
        } catch (e) {
          console.error(e);
        }
      }

      batch.update(docSnap.ref, { slaNotified: true });
      updates++;
    }

    if (updates > 0) {
      await batch.commit();
    }
  }
);

// =========================================================================
// 5. SUPER ADMIN TWO-STEP VERIFICATION (Firestore `emailOtps` only)
// =========================================================================

const SUPER_ADMIN_OTP_SESSION_HOURS = 12;
const OTP_ENFORCED_ROLES = ['super_admin'];

function superAdminOtpDocId(email) {
  return `superadmin:${normalizeEmail(email)}`;
}

exports.startSuperAdminLogin = onCall(
  {
    region: REGION,
    cors: true,
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD, OTP_SECRET_SALT],
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError('unauthenticated', 'User must be authenticated.');
    }

    const db = getDb();
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      throw new HttpsError('not-found', 'User record not found.');
    }

    const userData = userDoc.data() || {};
    const userRole = userData.role;
    const email = normalizeEmail(userData.email || request.auth.token?.email || request.data?.email);
    const emailHash = hashEmailForLog(email);

    if (!OTP_ENFORCED_ROLES.includes(userRole)) {
      throw new HttpsError('failed-precondition', 'Two-step verification is not required for this role.');
    }
    if (!email) {
      throw new HttpsError('failed-precondition', 'Super Admin email address is missing.');
    }

    // Validate secrets up front before altering claims or writing OTP records
    const otpSalt = getOtpSalt();
    const { transporter, gmailUser } = createGmailTransporter();

    // Immediately clear any previous OTP-verified session custom claims
    await admin.auth().setCustomUserClaims(uid, {
      role: userRole,
      otpSession: null,
      otpExpiresAt: null,
    });

    const otpDocRef = db.collection('emailOtps').doc(superAdminOtpDocId(email));
    const otpDocSnap = await otpDocRef.get();
    const now = Date.now();

    if (otpDocSnap.exists) {
      const existing = otpDocSnap.data() || {};

      const lockedUntil = parseTimestampMs(existing.lockedUntil);
      if (lockedUntil > now) {
        const waitMinutes = Math.ceil((lockedUntil - now) / 60000);
        throw new HttpsError(
          'resource-exhausted',
          `Account is temporarily locked for ${waitMinutes} more minute${waitMinutes === 1 ? '' : 's'} due to too many failed attempts.`
        );
      }

      const lastSentAt = parseTimestampMs(existing.lastSentAt);
      const elapsedSeconds = Math.floor((now - lastSentAt) / 1000);
      if (lastSentAt > 0 && elapsedSeconds < 60) {
        const remainingSeconds = 60 - elapsedSeconds;
        throw new HttpsError(
          'resource-exhausted',
          `Please wait ${remainingSeconds} seconds before requesting a new verification code.`
        );
      }
    }

    const code = generateSixDigitOtp();
    const hashedCode = hashOtp(code, otpSalt);
    const expiresInSeconds = 300; // 5 minutes
    const expiresAt = Timestamp.fromDate(new Date(now + expiresInSeconds * 1000));

    // Replace previous Super Admin OTP record in `emailOtps`
    await otpDocRef.set({
      uid,
      email,
      type: 'super_admin_login',
      hashedCode,
      expiresAt,
      attemptsLeft: 5,
      lastSentAt: FieldValue.serverTimestamp(),
      lockedUntil: null,
    });

    try {
      await transporter.sendMail({
        from: `"ReSellBD Security" <${gmailUser}>`,
        to: email,
        subject: `${code} is your Super Admin Two-Step Verification Code`,
        html: `
          <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 540px; margin: 0 auto; padding: 28px; background: #050B1A; color: #ffffff; border-radius: 20px; border: 1px solid rgba(255,255,255,0.15);">
            <div style="text-align: center; margin-bottom: 24px;">
              <h1 style="color: #3DD055; margin: 0; font-size: 26px; font-weight: 900; letter-spacing: -0.5px;">ReSellBD Security</h1>
              <p style="color: #0E9AA7; font-size: 13px; margin: 6px 0 0 0; text-transform: uppercase; font-weight: 700; letter-spacing: 1px;">Super Admin Two-Step Verification (দ্বি-স্তরীয় নিরাপত্তা)</p>
            </div>
            <div style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); border-radius: 16px; padding: 24px; text-align: center; margin-bottom: 20px;">
              <p style="margin: 0 0 12px 0; color: #94a3b8; font-size: 14px;">Your 6-digit Super Admin verification code is:</p>
              <div style="font-size: 40px; font-weight: 900; letter-spacing: 10px; color: #3DD055; padding: 14px 20px; background: rgba(0,0,0,0.4); border-radius: 12px; display: inline-block; font-family: monospace;">
                ${code}
              </div>
              <p style="margin: 16px 0 0 0; color: #cbd5e1; font-size: 13px;">This code will expire in <strong>5 minutes</strong>. Maximum 5 verification attempts are allowed before a 15-minute security lock.</p>
            </div>
            <div style="background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); border-radius: 12px; padding: 14px; margin-bottom: 20px; font-size: 12px; color: #fde68a;">
              ⚠️ <strong>Security Notice:</strong> If you did not initiate this login attempt, someone entered your password. Please change your password immediately.
            </div>
            <p style="color: #64748b; font-size: 11px; text-align: center; margin: 0;">
              Sent automatically by ReSellBD via Sky Automation Tech.
            </p>
          </div>
        `,
      });
      console.log(`[startSuperAdminLogin] Dispatched 2-Step OTP email for emailHash=${emailHash}`);
    } catch (mailErr) {
      console.error(
        `[startSuperAdminLogin] SMTP delivery failed for emailHash=${emailHash}:`,
        mailErr?.message || mailErr
      );
      await otpDocRef.delete().catch(() => {});
      throw new HttpsError(
        'internal',
        'Could not deliver Super Admin verification email. Please check mail configuration and try again.'
      );
    }

    try {
      await db.collection('auditLogs').add({
        action: 'super_admin_otp_requested',
        userId: uid,
        userEmail: email,
        role: userRole,
        ip:
          request.rawRequest?.headers?.['x-forwarded-for'] ||
          request.rawRequest?.ip ||
          'unknown',
        userAgent: request.rawRequest?.headers?.['user-agent'] || 'unknown',
        timestamp: FieldValue.serverTimestamp(),
      });
    } catch (logErr) {
      console.warn('Could not record audit log:', logErr);
    }

    return {
      success: true,
      message: 'Verification code sent to your registered Super Admin email.',
      email,
      expiresInSeconds,
      cooldownSeconds: 60,
    };
  }
);

exports.verifySuperAdminOtp = onCall(
  {
    region: REGION,
    cors: true,
    secrets: [OTP_SECRET_SALT],
  },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) {
      throw new HttpsError('unauthenticated', 'User must be authenticated.');
    }

    const code = String(request.data?.code ?? '').trim();
    if (!/^\d{6}$/.test(code)) {
      throw new HttpsError('invalid-argument', 'Please enter the full 6-digit code.');
    }

    const otpSalt = getOtpSalt();
    const db = getDb();

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      throw new HttpsError('not-found', 'User record not found.');
    }

    const userData = userDoc.data() || {};
    if (!OTP_ENFORCED_ROLES.includes(userData.role)) {
      throw new HttpsError('permission-denied', 'Unauthorized role for Super Admin OTP verification.');
    }

    const email = normalizeEmail(userData.email || request.auth.token?.email || request.data?.email);
    const otpDocRef = db.collection('emailOtps').doc(superAdminOtpDocId(email));
    const otpDocSnap = await otpDocRef.get();

    if (!otpDocSnap.exists) {
      throw new HttpsError('not-found', 'No active verification code found. Please request a new code.');
    }

    const otpData = otpDocSnap.data() || {};
    if (otpData.uid && otpData.uid !== uid) {
      throw new HttpsError('permission-denied', 'Verification record does not match the signed-in account.');
    }

    const now = Date.now();
    const lockedUntil = parseTimestampMs(otpData.lockedUntil);
    if (lockedUntil > now) {
      const waitMinutes = Math.ceil((lockedUntil - now) / 60000);
      throw new HttpsError(
        'resource-exhausted',
        `Account is temporarily locked for ${waitMinutes} more minute${waitMinutes === 1 ? '' : 's'} due to too many failed attempts.`
      );
    }

    const expiresAt = parseTimestampMs(otpData.expiresAt);
    if (!expiresAt || now > expiresAt) {
      await otpDocRef.delete();
      throw new HttpsError('deadline-exceeded', 'Verification code has expired. Please request a new code.');
    }

    const attemptsLeft = typeof otpData.attemptsLeft === 'number' ? otpData.attemptsLeft : 5;
    if (attemptsLeft <= 0) {
      await otpDocRef.update({
        attemptsLeft: 0,
        lockedUntil: Timestamp.fromDate(new Date(now + 15 * 60 * 1000)),
      });
      throw new HttpsError(
        'resource-exhausted',
        'Account is temporarily locked for 15 minutes due to too many failed attempts.'
      );
    }

    const inputHash = hashOtp(code, otpSalt);
    if (!otpData.hashedCode || inputHash !== otpData.hashedCode) {
      const remaining = attemptsLeft - 1;

      try {
        await db.collection('auditLogs').add({
          action: 'super_admin_otp_failed_attempt',
          userId: uid,
          userEmail: otpData.email || email,
          attemptsRemaining: remaining,
          ip:
            request.rawRequest?.headers?.['x-forwarded-for'] ||
            request.rawRequest?.ip ||
            'unknown',
          userAgent: request.rawRequest?.headers?.['user-agent'] || 'unknown',
          timestamp: FieldValue.serverTimestamp(),
        });
      } catch (_) {}

      if (remaining <= 0) {
        await otpDocRef.update({
          attemptsLeft: 0,
          lockedUntil: Timestamp.fromDate(new Date(now + 15 * 60 * 1000)),
        });

        await admin.auth().setCustomUserClaims(uid, {
          role: 'super_admin',
          otpSession: null,
          otpExpiresAt: null,
        });

        throw new HttpsError(
          'resource-exhausted',
          'Account is temporarily locked for 15 minutes due to too many failed attempts.'
        );
      }

      // Count attempts ONLY on wrong codes
      await otpDocRef.update({ attemptsLeft: remaining });
      throw new HttpsError(
        'permission-denied',
        `Incorrect code. You have ${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} remaining.`
      );
    }

    // Verification successful
    const sessionId = crypto.randomUUID();
    const sessionExpiresAt = now + SUPER_ADMIN_OTP_SESSION_HOURS * 60 * 60 * 1000;

    await admin.auth().setCustomUserClaims(uid, {
      role: 'super_admin',
      otpSession: sessionId,
      otpExpiresAt: sessionExpiresAt,
    });

    await db.collection('adminSessions').doc(uid).set({
      uid,
      email,
      verified: true,
      sessionId,
      expiresAt: sessionExpiresAt,
      verifiedAt: FieldValue.serverTimestamp(),
    });

    // Delete the OTP record immediately after verification
    await otpDocRef.delete();

    const clientIp =
      request.rawRequest?.headers?.['x-forwarded-for'] || request.rawRequest?.ip || 'unknown';
    const clientUserAgent = request.rawRequest?.headers?.['user-agent'] || 'unknown';

    try {
      await db.collection('auditLogs').add({
        action: 'super_admin_otp_login_success',
        userId: uid,
        userEmail: email,
        role: 'super_admin',
        sessionId,
        sessionExpiresAt,
        ip: clientIp,
        userAgent: clientUserAgent,
        timestamp: FieldValue.serverTimestamp(),
      });
    } catch (logErr) {
      console.warn('Could not record login success audit log:', logErr);
    }

    try {
      if (Array.isArray(userData.fcmTokens) && userData.fcmTokens.length > 0) {
        await sendPushToTokens(userData.fcmTokens, {
          notification: {
            title: 'Security Alert: Super Admin Login',
            body: 'Your Super Admin account was authenticated via two-step verification from a new session.',
          },
          data: {
            type: 'security_alert',
            action: 'super_admin_login',
            sessionId,
            timestamp: String(now),
          },
        });
      }
    } catch (pushErr) {
      console.warn('Could not dispatch security push notification:', pushErr);
    }

    console.log(`[verifySuperAdminOtp] Verified and granted 12-hour session to uid: ${uid}`);

    return {
      success: true,
      verified: true,
      expiresAt: sessionExpiresAt,
      message: 'Two-step verification completed successfully!',
    };
  }
);

exports.clearSuperAdminOtpSession = onCall({ region: REGION, cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    return { success: true };
  }

  const db = getDb();
  try {
    await admin.auth().setCustomUserClaims(uid, {
      role: 'super_admin',
      otpSession: null,
      otpExpiresAt: null,
    });
    await db.collection('adminSessions').doc(uid).delete().catch(() => {});
    console.log(`[clearSuperAdminOtpSession] Cleared OTP session for uid: ${uid}`);
  } catch (err) {
    console.warn('Could not clear custom claims on logout:', err);
  }

  return { success: true };
});

// =========================================================================
// 6. REMOTE DEVICE LOGOUT FUNCTIONS
// =========================================================================

const logoutRateLimits = new Map();

exports.logoutDevice = onCall({ region: REGION, cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'User must be authenticated.');
  }

  const deviceId = request.data?.deviceId;
  if (!deviceId) {
    throw new HttpsError('invalid-argument', 'Device ID is required.');
  }

  const now = Date.now();
  const lastAction = logoutRateLimits.get(`${uid}_single`) || 0;
  if (now - lastAction < 3000) {
    throw new HttpsError('resource-exhausted', 'Please wait a few seconds before another logout action.');
  }
  logoutRateLimits.set(`${uid}_single`, now);

  const db = getDb();
  try {
    const devRef = db.collection('users').doc(uid).collection('devices').doc(deviceId);
    const devSnap = await devRef.get();

    let removedFcmToken = null;
    let devName = 'Unknown Device';

    if (devSnap.exists) {
      const devData = devSnap.data();
      removedFcmToken = devData.fcmToken || null;
      devName = devData.deviceName || devName;

      await devRef.update({
        status: 'signed_out',
        fcmToken: null,
        signedOutAt: FieldValue.serverTimestamp(),
        signedOutBy: uid,
      });
    }

    if (removedFcmToken) {
      try {
        await sendPushToTokens([removedFcmToken], {
          data: {
            type: 'force_logout',
            deviceId: String(deviceId),
            timestamp: String(now),
          },
        });
      } catch (fcmErr) {
        console.warn(`[Security] Could not deliver force_logout FCM data message to ${deviceId}:`, fcmErr);
      }

      await db
        .collection('users')
        .doc(uid)
        .update({
          fcmTokens: FieldValue.arrayRemove(removedFcmToken),
        })
        .catch(() => {});
    }

    await db.collection('auditLogs').add({
      userId: uid,
      action: 'LOGOUT_DEVICE',
      timestamp: FieldValue.serverTimestamp(),
      details: {
        deviceId,
        deviceName: devName,
        signedOutBy: uid,
        reason: 'User requested remote device sign-out',
      },
    });

    return {
      success: true,
      message: 'Device session signed out successfully.',
      deviceId,
    };
  } catch (err) {
    console.error('Error logging out device:', err);
    throw new HttpsError('internal', err.message || 'Failed to logout device.');
  }
});

exports.logoutAllDevices = onCall({ region: REGION, cors: true }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'User must be authenticated.');
  }

  const now = Date.now();
  const lastAction = logoutRateLimits.get(`${uid}_all`) || 0;
  if (now - lastAction < 3000) {
    throw new HttpsError('resource-exhausted', 'Please wait a few seconds before another logout action.');
  }
  logoutRateLimits.set(`${uid}_all`, now);

  const db = getDb();
  try {
    await admin.auth().revokeRefreshTokens(uid);

    const devicesSnap = await db.collection('users').doc(uid).collection('devices').get();
    const batch = db.batch();
    const allTokens = new Set();

    devicesSnap.docs.forEach((devDoc) => {
      const devData = devDoc.data();
      if (devData.fcmToken) allTokens.add(devData.fcmToken);
      batch.update(devDoc.ref, {
        status: 'signed_out',
        fcmToken: null,
        signedOutAt: FieldValue.serverTimestamp(),
        signedOutBy: uid,
      });
    });

    const userDocRef = db.collection('users').doc(uid);
    const userSnap = await userDocRef.get();
    if (userSnap.exists && Array.isArray(userSnap.data()?.fcmTokens)) {
      userSnap.data().fcmTokens.forEach((t) => {
        if (t) allTokens.add(t);
      });
    }

    batch.update(userDocRef, {
      sessionsValidFrom: FieldValue.serverTimestamp(),
      fcmTokens: [],
      fcmToken: null,
    });

    await batch.commit();

    const tokenList = Array.from(allTokens);
    if (tokenList.length > 0) {
      try {
        await sendPushToTokens(tokenList, {
          notification: {
            title: 'Security Alert: Signed Out',
            body: 'You were signed out from all devices.',
          },
          data: {
            type: 'force_logout',
            reason: 'logout_all',
            timestamp: String(now),
          },
        });
      } catch (fcmErr) {
        console.warn('[Security] Error sending logout_all push notification:', fcmErr);
      }
    }

    await db.collection('auditLogs').add({
      userId: uid,
      action: 'LOGOUT_ALL_DEVICES',
      timestamp: FieldValue.serverTimestamp(),
      details: {
        signedOutBy: uid,
        reason: 'User requested remote logout of all devices',
        devicesCount: devicesSnap.size,
      },
    });

    return {
      success: true,
      message: 'All devices signed out and sessions revoked.',
    };
  } catch (err) {
    console.error('Error logging out all devices:', err);
    throw new HttpsError('internal', err.message || 'Failed to logout all devices.');
  }
});

exports.revokeSingleDeviceSession = exports.logoutDevice;
exports.revokeAllUserSessions = exports.logoutAllDevices;

// =========================================================================
// 7. SECURE ADMIN MANAGEMENT SYSTEM (Super Admin Exclusive)
// =========================================================================

const ALLOWED_ADMIN_PERMISSIONS = [
  'approve_resellers',
  'handle_support',
  'manage_products',
  'manage_orders',
  'manage_wallet',
  'manage_commission',
  'view_reports',
  'send_notifications',
  'manage_banners',
];

const MAX_ADMINS_LIMIT = 10;

function isValidPassword(pwd) {
  if (typeof pwd !== 'string' || pwd.length < 8) return false;
  return (
    /[A-Z]/.test(pwd) &&
    /[a-z]/.test(pwd) &&
    /[0-9]/.test(pwd) &&
    /[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?]/.test(pwd)
  );
}

async function sendAdminWelcomeEmailHtml(email, fullName, adminId, resetLink) {
  const { transporter, gmailUser } = createGmailTransporter();
  const appLoginUrl = process.env.APP_URL || 'https://re-sellbd.vercel.app';

  await transporter.sendMail({
    from: `"ReSellBD Security" <${gmailUser}>`,
    to: email,
    subject: 'আপনার ReSellBD Admin অ্যাকাউন্ট তৈরি হয়েছে / Your ReSellBD Admin account is ready',
    html: `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 28px; background: #050B1A; color: #ffffff; border-radius: 20px; border: 1px solid rgba(255,255,255,0.15);">
        <div style="text-align: center; margin-bottom: 24px;">
          <h1 style="color: #3DD055; margin: 0; font-size: 26px; font-weight: 900; letter-spacing: -0.5px;">ReSellBD</h1>
          <p style="color: #0E9AA7; font-size: 13px; margin: 4px 0 0 0; text-transform: uppercase; font-weight: 700; letter-spacing: 1.5px;">Administrative Management Portal</p>
        </div>

        <div style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.15); border-radius: 16px; padding: 24px; margin-bottom: 24px;">
          <h2 style="margin: 0 0 12px 0; color: #ffffff; font-size: 18px; font-weight: 700;">স্বাগতম, ${fullName}!</h2>
          <p style="margin: 0 0 16px 0; color: #cbd5e1; font-size: 14px; line-height: 1.6;">
            সুপার অ্যাডমিন আপনাকে <strong>ReSellBD</strong> প্ল্যাটফর্মের অ্যাডমিনিস্ট্রেটর হিসেবে অনুমোদন ও যুক্ত করেছেন।
            Your official administrator credentials have been created.
          </p>

          <table style="width: 100%; border-collapse: collapse; margin-bottom: 18px; font-size: 13px;">
            <tr>
              <td style="padding: 8px 0; color: #94a3b8; width: 140px;">Admin ID / আইডি:</td>
              <td style="padding: 8px 0; color: #3DD055; font-weight: 700; font-family: monospace; font-size: 14px;">${adminId}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8;">Role / পদবী:</td>
              <td style="padding: 8px 0; color: #ffffff; font-weight: 600;">System Administrator (অ্যাডমিন)</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8;">Login Email / ইমেইল:</td>
              <td style="padding: 8px 0; color: #ffffff; font-weight: 600;">${email}</td>
            </tr>
            <tr>
              <td style="padding: 8px 0; color: #94a3b8;">Login Portal / পোর্টাল:</td>
              <td style="padding: 8px 0;"><a href="${appLoginUrl}" style="color: #0E9AA7; text-decoration: none; font-weight: 600;">ReSellBD Login Portal</a></td>
            </tr>
          </table>

          <div style="background: rgba(14,154,167,0.12); border: 1px solid rgba(14,154,167,0.3); border-radius: 12px; padding: 16px; margin-bottom: 20px;">
            <p style="margin: 0 0 6px 0; color: #3DD055; font-size: 13px; font-weight: 700;">নিরাপত্তা নির্দেশিকা (Security Note):</p>
            <p style="margin: 0; color: #e2e8f0; font-size: 12px; line-height: 1.5;">
              আপনার প্রাথমিক অস্থায়ী পাসওয়ার্ডটি সুপার অ্যাডমিন আপনাকে ব্যক্তিগতভাবে প্রদান করেছেন (নিরাপত্তার স্বার্থে ইমেইলে পাঠানো হয় না)। অনুগ্রহ করে নিচের বাটনে ক্লিক করে সরাসরি আপনার নিজস্ব পাসওয়ার্ড সেট করুন অথবা লগইন করে প্রথমবারে পরিবর্তন করে নিন।
            </p>
          </div>

          <div style="text-align: center; margin: 24px 0 12px 0;">
            <a href="${resetLink}" style="display: inline-block; background: linear-gradient(135deg, #0E9AA7, #3DD055); color: #ffffff; text-decoration: none; font-weight: 700; font-size: 14px; padding: 14px 28px; border-radius: 12px; box-shadow: 0 4px 15px rgba(61,208,85,0.3);">
              Set Your Own Password (পাসওয়ার্ড সেট করুন)
            </a>
          </div>
          <p style="color: #94a3b8; font-size: 11px; text-align: center; margin: 8px 0 0 0;">
            This secure password link is valid for a limited time.
          </p>
        </div>

        <p style="color: #64748b; font-size: 11px; text-align: center; margin: 0; line-height: 1.5;">
          Sky Automation Tech • ReSellBD Administrator Network<br/>
          This is an automated operational notification. Never share your credentials with anyone.
        </p>
      </div>
    `,
  });
}

exports.createAdmin = onCall(
  {
    region: REGION,
    cors: true,
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD],
  },
  async (request) => {
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Sign-in required to create an admin.');
    }

    const callerUid = request.auth.uid;
    const callerEmail = normalizeEmail(request.auth.token?.email);
    const db = getDb();

    const callerDoc = await db.collection('users').doc(callerUid).get();
    if (!callerDoc.exists) {
      throw new HttpsError('permission-denied', 'Caller account profile not found.');
    }

    const callerData = callerDoc.data() || {};
    const isSoleSuperAdmin = callerEmail === 'skyautomationtech@gmail.com' && callerData.role === 'super_admin';
    if (!isSoleSuperAdmin) {
      throw new HttpsError('permission-denied', 'Only the Super Admin (owner) can create Admin accounts.');
    }

    const fullName = String(request.data?.fullName || '').trim();
    const email = normalizeEmail(request.data?.email);
    const mobile = String(request.data?.mobile || '').trim();
    const password = String(request.data?.password || '');
    const requestedPermissions = Array.isArray(request.data?.permissions) ? request.data.permissions : [];
    const profilePhotoUrl = String(request.data?.profilePhotoUrl || '').trim();
    const internalNote = String(request.data?.internalNote || '').trim();

    if (!fullName || fullName.length < 2 || fullName.length > 100) {
      throw new HttpsError('invalid-argument', 'Please provide a valid full name (2-100 characters).');
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!email || !emailRegex.test(email)) {
      throw new HttpsError('invalid-argument', 'Please provide a valid email address.');
    }

    const bdMobileRegex = /^01[3-9]\d{8}$/;
    if (!mobile || !bdMobileRegex.test(mobile)) {
      throw new HttpsError(
        'invalid-argument',
        'Please provide a valid Bangladeshi mobile number (01[3-9]XXXXXXXX).'
      );
    }

    if (!isValidPassword(password)) {
      throw new HttpsError(
        'invalid-argument',
        'Password must be at least 8 characters and contain uppercase, lowercase, numbers, and symbols.'
      );
    }

    const sanitizedPermissions = requestedPermissions.filter((p) => ALLOWED_ADMIN_PERMISSIONS.includes(p));
    if (sanitizedPermissions.length === 0) {
      throw new HttpsError('invalid-argument', 'At least one operational permission must be selected.');
    }

    const adminsSnap = await db.collection('users').where('role', '==', 'admin').get();
    let activeAdminCount = 0;
    adminsSnap.forEach((docSnap) => {
      if (docSnap.data()?.status !== 'deleted') activeAdminCount++;
    });

    if (activeAdminCount >= MAX_ADMINS_LIMIT) {
      throw new HttpsError(
        'resource-exhausted',
        `Administrator limit reached (maximum ${MAX_ADMINS_LIMIT} active admins allowed). Please suspend or remove an existing admin.`
      );
    }

    const existingFsUser = await db.collection('users').where('email', '==', email).limit(1).get();
    if (!existingFsUser.empty) {
      throw new HttpsError('already-exists', 'An account with this email address already exists in the system.');
    }

    try {
      const existingAuth = await admin.auth().getUserByEmail(email);
      if (existingAuth) {
        throw new HttpsError(
          'already-exists',
          'An account with this email address already exists in Firebase Authentication.'
        );
      }
    } catch (err) {
      if (err instanceof HttpsError) throw err;
    }

    let newAuthUser;
    try {
      newAuthUser = await admin.auth().createUser({
        email,
        password,
        displayName: fullName,
        emailVerified: false,
      });
    } catch (authCreateErr) {
      if (authCreateErr.code === 'auth/email-already-exists') {
        throw new HttpsError('already-exists', 'An account with this email address already exists.');
      }
      throw new HttpsError('invalid-argument', authCreateErr.message || 'Failed to create auth user.');
    }

    const newUid = newAuthUser.uid;
    let assignedAdminId = 'ADM-0001';

    try {
      await db.runTransaction(async (t) => {
        const counterRef = db.collection('counters').doc('adminId');
        const counterDoc = await t.get(counterRef);
        let nextCount = 1;
        if (counterDoc.exists) {
          nextCount = (counterDoc.data()?.lastCount || 0) + 1;
        }
        assignedAdminId = `ADM-${String(nextCount).padStart(4, '0')}`;

        t.set(
          counterRef,
          {
            lastCount: nextCount,
            updatedAt: FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        t.set(db.collection('users').doc(newUid), {
          uid: newUid,
          adminId: assignedAdminId,
          fullName,
          email,
          mobile,
          role: 'admin',
          status: 'approved',
          permissions: sanitizedPermissions,
          createdBy: callerUid,
          createdByName: callerData.fullName || 'Super Admin',
          mustChangePassword: true,
          emailVerified: false,
          profilePhotoUrl: profilePhotoUrl || '',
          internalNote: internalNote || '',
          shopName: 'ReSellBD HQ',
          division: 'Dhaka',
          district: 'Dhaka',
          upazila: 'Tejgaon',
          address: 'Headquarters, Dhaka',
          createdAt: FieldValue.serverTimestamp(),
        });
      });
    } catch (txErr) {
      console.error('[createAdmin] Transaction failed. Rolling back Auth user:', txErr);
      await admin.auth().deleteUser(newUid).catch(() => {});
      throw new HttpsError('internal', 'Database error creating admin record. Rolled back successfully.');
    }

    try {
      await db.collection('auditLogs').add({
        action: 'admin_created',
        actorUid: callerUid,
        actorEmail: callerEmail,
        targetUid: newUid,
        targetEmail: email,
        adminId: assignedAdminId,
        permissions: sanitizedPermissions,
        timestamp: FieldValue.serverTimestamp(),
      });
    } catch (auditErr) {
      console.warn('[createAdmin] Could not record audit log:', auditErr);
    }

    let resetLink = '';
    try {
      resetLink = await admin.auth().generatePasswordResetLink(email);
    } catch (_linkErr) {
      resetLink = process.env.APP_URL || 'https://re-sellbd.vercel.app';
    }

    try {
      await sendAdminWelcomeEmailHtml(email, fullName, assignedAdminId, resetLink);
    } catch (emailErr) {
      console.error('[createAdmin] Welcome email send error:', emailErr?.message || emailErr);
    }

    return {
      success: true,
      adminId: assignedAdminId,
      uid: newUid,
      email,
      fullName,
      message: `Admin account (${assignedAdminId}) successfully created for ${fullName}. Welcome email sent.`,
    };
  }
);

exports.resendAdminWelcomeEmail = onCall(
  {
    region: REGION,
    cors: true,
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD],
  },
  async (request) => {
    if (!request.auth || !request.auth.uid) {
      throw new HttpsError('unauthenticated', 'Sign-in required.');
    }

    const callerUid = request.auth.uid;
    const callerEmail = normalizeEmail(request.auth.token?.email);
    const db = getDb();

    const callerDoc = await db.collection('users').doc(callerUid).get();
    if (!callerDoc.exists || callerEmail !== 'skyautomationtech@gmail.com' || callerDoc.data()?.role !== 'super_admin') {
      throw new HttpsError('permission-denied', 'Only the Super Admin can resend welcome emails.');
    }

    const adminUid = String(request.data?.adminUid || '').trim();
    if (!adminUid) {
      throw new HttpsError('invalid-argument', 'Target admin UID is required.');
    }

    const targetDoc = await db.collection('users').doc(adminUid).get();
    if (!targetDoc.exists || targetDoc.data()?.role !== 'admin') {
      throw new HttpsError('not-found', 'Admin profile not found.');
    }

    const targetData = targetDoc.data();
    const resetLink = await admin.auth().generatePasswordResetLink(targetData.email);

    await sendAdminWelcomeEmailHtml(
      targetData.email,
      targetData.fullName,
      targetData.adminId || 'Admin',
      resetLink
    );

    await db.collection('auditLogs').add({
      action: 'admin_welcome_email_resent',
      actorUid: callerUid,
      actorEmail: callerEmail,
      targetUid: adminUid,
      targetEmail: targetData.email,
      timestamp: FieldValue.serverTimestamp(),
    });

    return {
      success: true,
      message: `Welcome email successfully resent to ${targetData.email}.`,
    };
  }
);

exports.changeAdminPassword = onCall({ region: REGION, cors: true }, async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign-in required.');
  }

  const uid = request.auth.uid;
  const db = getDb();
  const userDocRef = db.collection('users').doc(uid);
  const userDoc = await userDocRef.get();

  if (!userDoc.exists) {
    throw new HttpsError('not-found', 'User profile not found.');
  }

  const userData = userDoc.data() || {};
  if (userData.role !== 'admin' && userData.role !== 'reseller') {
    throw new HttpsError('permission-denied', 'This function is only for admin and reseller accounts.');
  }

  const newPassword = String(request.data?.newPassword || '');
  if (!isValidPassword(newPassword)) {
    throw new HttpsError(
      'invalid-argument',
      'New password must be at least 8 characters and contain uppercase, lowercase, numbers, and symbols.'
    );
  }

  try {
    await admin.auth().updateUser(uid, { password: newPassword });
  } catch (pErr) {
    console.error('[changeAdminPassword] Error updating Auth password:', pErr);
    throw new HttpsError('internal', 'Could not update password. Please try again.');
  }

  await userDocRef.update({
    mustChangePassword: false,
    passwordChangedAt: FieldValue.serverTimestamp(),
    plainPassword: FieldValue.delete(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  await db.collection('auditLogs').add({
    action: userData.role === 'admin' ? 'admin_first_login_password_changed' : 'reseller_forced_password_changed',
    actorUid: uid,
    actorEmail: userData.email,
    adminId: userData.adminId || userData.resellerId || uid,
    timestamp: FieldValue.serverTimestamp(),
  });

  try {
    await db.collection('notifications').add({
      title: 'Admin First Login & Password Updated',
      message: `Admin ${userData.fullName} (${userData.adminId || userData.email}) has completed their first login and set their personal password.`,
      type: 'admin_security_alert',
      targetRole: 'super_admin',
      userId: uid,
      read: false,
      createdAt: FieldValue.serverTimestamp(),
    });

    const superAdminSnap = await db.collection('users').where('role', '==', 'super_admin').get();
    const tokens = [];
    superAdminSnap.forEach((d) => {
      const u = d.data();
      if (Array.isArray(u.fcmTokens)) tokens.push(...u.fcmTokens);
    });
    if (tokens.length > 0) {
      await sendPushToTokens(tokens, {
        notification: {
          title: 'Admin Password Set',
          body: `Admin ${userData.fullName} has updated their password and accessed the portal.`,
        },
      });
    }
  } catch (notifErr) {
    console.warn('[changeAdminPassword] Notification error:', notifErr);
  }

  return {
    success: true,
    message: 'Your personal password has been successfully updated. You may now access the administrative portal.',
  };
});

exports.toggleAdminStatus = onCall({ region: REGION, cors: true }, async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign-in required.');
  }

  const callerUid = request.auth.uid;
  const callerEmail = normalizeEmail(request.auth.token?.email);
  const db = getDb();

  const callerDoc = await db.collection('users').doc(callerUid).get();
  if (!callerDoc.exists || callerEmail !== 'skyautomationtech@gmail.com' || callerDoc.data()?.role !== 'super_admin') {
    throw new HttpsError('permission-denied', 'Only the Super Admin can suspend or activate admin accounts.');
  }

  const adminUid = String(request.data?.adminUid || '').trim();
  const newStatus = request.data?.status === 'suspended' ? 'suspended' : 'approved';
  const reason = String(request.data?.reason || '').trim();

  const targetDoc = await db.collection('users').doc(adminUid).get();
  if (!targetDoc.exists || targetDoc.data()?.role !== 'admin') {
    throw new HttpsError('not-found', 'Admin profile not found.');
  }

  const targetData = targetDoc.data();
  if (normalizeEmail(targetData.email) === 'skyautomationtech@gmail.com' || targetData.role === 'super_admin') {
    throw new HttpsError('permission-denied', 'Super Admin account cannot be suspended or modified.');
  }

  if (newStatus === 'suspended') {
    await admin.auth().revokeRefreshTokens(adminUid).catch(() => {});
  }

  await db.collection('users').doc(adminUid).update({
    status: newStatus,
    suspensionReason: newStatus === 'suspended' ? (reason || 'Administrative suspension by Super Admin') : null,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await db.collection('auditLogs').add({
    action: newStatus === 'suspended' ? 'admin_suspended' : 'admin_activated',
    actorUid: callerUid,
    actorEmail: callerEmail,
    targetUid: adminUid,
    targetEmail: targetData.email,
    reason,
    timestamp: FieldValue.serverTimestamp(),
  });

  return {
    success: true,
    status: newStatus,
    message: `Admin account has been ${newStatus === 'suspended' ? 'suspended' : 'activated'}.`,
  };
});

exports.updateAdminPermissions = onCall({ region: REGION, cors: true }, async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign-in required.');
  }

  const callerUid = request.auth.uid;
  const callerEmail = normalizeEmail(request.auth.token?.email);
  const db = getDb();

  const callerDoc = await db.collection('users').doc(callerUid).get();
  if (!callerDoc.exists || callerEmail !== 'skyautomationtech@gmail.com' || callerDoc.data()?.role !== 'super_admin') {
    throw new HttpsError('permission-denied', 'Only the Super Admin can update admin permissions.');
  }

  const adminUid = String(request.data?.adminUid || '').trim();
  const requestedPermissions = Array.isArray(request.data?.permissions) ? request.data.permissions : [];
  const sanitizedPermissions = requestedPermissions.filter((p) => ALLOWED_ADMIN_PERMISSIONS.includes(p));

  const targetDoc = await db.collection('users').doc(adminUid).get();
  if (!targetDoc.exists || targetDoc.data()?.role !== 'admin') {
    throw new HttpsError('not-found', 'Admin profile not found.');
  }

  await db.collection('users').doc(adminUid).update({
    permissions: sanitizedPermissions,
    updatedAt: FieldValue.serverTimestamp(),
  });

  await db.collection('auditLogs').add({
    action: 'admin_permissions_updated',
    actorUid: callerUid,
    actorEmail: callerEmail,
    targetUid: adminUid,
    permissions: sanitizedPermissions,
    timestamp: FieldValue.serverTimestamp(),
  });

  return {
    success: true,
    permissions: sanitizedPermissions,
    message: 'Admin permissions updated successfully.',
  };
});

// =========================================================================
// 8. AUTOMATIC RESELLER STATUS EMAIL TRIGGER (2nd-Gen, asia-south1)
// =========================================================================

exports.sendResellerStatusEmail = onDocumentWritten(
  {
    document: 'users/{uid}',
    database: FIRESTORE_DATABASE_ID,
    region: REGION,
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD],
    retry: false,
  },
  async (event) => {
    const uid = event.params?.uid;
    if (!uid || !event.data?.after?.exists) {
      return null;
    }

    const beforeData = event.data.before?.exists ? event.data.before.data() : null;
    const afterData = event.data.after.data() || {};

    // Admins and Super Admin never receive reseller status emails
    if (String(afterData.role || '').trim().toLowerCase() !== 'reseller') {
      return null;
    }

    const email = normalizeEmail(afterData.email);
    const emailHash = hashEmailForLog(email);

    try {
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return null;
      }
      if (email === 'skyautomationtech@gmail.com') {
        return null;
      }

      const beforeStatus = beforeData ? String(beforeData.status || '').trim().toLowerCase() : null;
      const afterStatus = String(afterData.status || '').trim().toLowerCase();

      if (!['pending', 'approved', 'rejected', 'suspended'].includes(afterStatus)) {
        return null;
      }

      // Send only when the status value actually changed (or document created with pending/approved)
      if (beforeData !== null && beforeStatus === afterStatus) {
        return null;
      }

      const db = getDb();

      // Atomic idempotency (5-minute dedupe) + max 3 status emails per user per hour
      const slot = await claimStatusEmailSlot(db, uid, afterStatus);
      if (!slot.allowed) {
        console.log(
          `[sendResellerStatusEmail] Skipped uid=${uid} emailHash=${emailHash} status=${afterStatus} reason=${slot.reason}`
        );
        return null;
      }

      const supportContact = await getSupportContactInfo(db);
      const emailPayload = buildStatusEmailPayload({
        beforeStatus,
        afterStatus,
        afterData,
        uid,
        supportContact,
      });

      if (!emailPayload) {
        return null;
      }

      const { transporter, gmailUser } = createGmailTransporter();
      await transporter.sendMail({
        from: `"ReSellBD" <${gmailUser}>`,
        to: email,
        subject: emailPayload.subject,
        html: emailPayload.html,
      });

      console.log(
        `[sendResellerStatusEmail] Sent status=${afterStatus} prev=${beforeStatus || 'none'} uid=${uid} emailHash=${emailHash}`
      );
      return null;
    } catch (err) {
      // Log safe error summary without secrets or full email address, and never throw/retry forever
      console.error(
        `[sendResellerStatusEmail] Failed uid=${uid} emailHash=${emailHash}:`,
        err?.message || 'Unknown email delivery error'
      );
      return null;
    }
  }
);

// =========================================================================
// 9. SUPER ADMIN LOCKED IDENTITY/PAYOUT CONTROLS & PASSWORD TOOLS
// =========================================================================

const LOCKED_FIELD_DISPLAY_LABELS = {
  shopName: 'Shop Name (শপের নাম)',
  email: 'Registered Email (ইমেইল)',
  dob: 'Date of Birth (জন্ম তারিখ)',
  documentType: 'Identity Document Type (ডকুমেন্টের ধরন)',
  nidNumber: 'NID Number (এনআইডি নম্বর)',
  nidFrontUrl: 'NID Front Image (এনআইডি সামনের ছবি)',
  nidBackUrl: 'NID Back Image (এনআইডি পেছনের ছবি)',
  nidUrl: 'NID Document Image (এনআইডি ছবি)',
  birthCertificateUrl: 'Birth Certificate Image (জন্ম নিবন্ধন ছবি)',
  birthCertificateNumber: 'Birth Certificate Number (জন্ম নিবন্ধন নম্বর)',
  payoutMethod: 'Default Payout Method (পেমেন্ট মাধ্যম)',
  payoutMethods: 'Payout Accounts List (পেমেন্ট অ্যাকাউন্ট তালিকা)',
  bkashNumber: 'bKash Account Number',
  nagadNumber: 'Nagad Account Number',
  rocketNumber: 'Rocket Account Number',
  upayNumber: 'Upay Account Number',
  bankName: 'Bank Name',
  branchName: 'Bank Branch Name',
  routingNumber: 'Bank Routing Number',
  accountHolderName: 'Account Holder Name',
  accountNumber: 'Bank / Payout Account Number',
};

const ALLOWED_LOCKED_KEYS = new Set(Object.keys(LOCKED_FIELD_DISPLAY_LABELS));

async function assertSuperAdmin(request, db) {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError('unauthenticated', 'Sign-in required.');
  }
  const callerUid = request.auth.uid;
  const callerEmail = normalizeEmail(request.auth.token?.email);
  const callerSnap = await db.collection('users').doc(callerUid).get();
  if (!callerSnap.exists) {
    throw new HttpsError('permission-denied', 'Caller profile not found.');
  }
  const callerData = callerSnap.data() || {};
  if (callerData.role !== 'super_admin') {
    throw new HttpsError(
      'permission-denied',
      'Only the Super Admin is authorized to perform this action.'
    );
  }
  return { callerUid, callerEmail, callerData };
}

function generateStrongTempPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnpqrstuvwxyz';
  const digits = '23456789';
  const symbols = '@#$%&*!';
  const all = upper + lower + digits + symbols;
  const chars = [
    upper[crypto.randomInt(0, upper.length)],
    upper[crypto.randomInt(0, upper.length)],
    lower[crypto.randomInt(0, lower.length)],
    lower[crypto.randomInt(0, lower.length)],
    digits[crypto.randomInt(0, digits.length)],
    digits[crypto.randomInt(0, digits.length)],
    symbols[crypto.randomInt(0, symbols.length)],
  ];
  while (chars.length < 12) {
    chars.push(all[crypto.randomInt(0, all.length)]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    const tmp = chars[i];
    chars[i] = chars[j];
    chars[j] = tmp;
  }
  return chars.join('');
}

async function applyLockedUpdatesInternal({
  db,
  targetUid,
  rawUpdates,
  actorUid,
  actorEmail,
  sendUpdateEmail = true,
  auditAction = 'super_admin_updated_locked_fields',
}) {
  const userRef = db.collection('users').doc(targetUid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) {
    throw new HttpsError('not-found', 'Target user record not found.');
  }
  const beforeData = userSnap.data() || {};
  const isTargetSoleSuperAdmin =
    normalizeEmail(beforeData.email) === 'skyautomationtech@gmail.com' ||
    beforeData.role === 'super_admin';

  const sanitized = {};
  const changedKeys = [];

  for (const [k, v] of Object.entries(rawUpdates || {})) {
    if (!ALLOWED_LOCKED_KEYS.has(k)) continue;
    if (v === undefined) continue;
    if (typeof v === 'string') {
      sanitized[k] = k === 'email' ? normalizeEmail(v) : v.trim();
    } else {
      sanitized[k] = v;
    }
  }

  if (Object.keys(sanitized).length === 0) {
    throw new HttpsError('invalid-argument', 'No valid locked fields provided to update.');
  }

  if (sanitized.email !== undefined) {
    const cleanEmail = sanitized.email;
    if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      throw new HttpsError('invalid-argument', 'Please enter a valid email address.');
    }
    if (isTargetSoleSuperAdmin && cleanEmail !== 'skyautomationtech@gmail.com') {
      throw new HttpsError('permission-denied', 'Sole Super Admin email cannot be changed.');
    }
    if (cleanEmail !== normalizeEmail(beforeData.email)) {
      try {
        await admin.auth().updateUser(targetUid, { email: cleanEmail, emailVerified: false });
      } catch (authErr) {
        if (authErr?.code === 'auth/email-already-exists') {
          throw new HttpsError('already-exists', 'This email address is already registered to another account.');
        }
        throw new HttpsError('internal', authErr?.message || 'Failed to update Firebase Auth email.');
      }
      changedKeys.push('email');
    }
  }

  let newShopNameKey = null;
  if (sanitized.shopName !== undefined) {
    const cleanShop = String(sanitized.shopName || '').trim();
    if (cleanShop.length < 2) {
      throw new HttpsError('invalid-argument', 'Shop name must be at least 2 characters long.');
    }
    newShopNameKey = normalizeShopName(cleanShop);
    if (!newShopNameKey || newShopNameKey.length < 2) {
      throw new HttpsError('invalid-argument', 'Shop name must contain valid characters.');
    }
    sanitized.shopName = cleanShop;
    sanitized.shopNameKey = newShopNameKey;
  }

  await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(userRef);
    if (!freshSnap.exists) {
      throw new HttpsError('not-found', 'Target user does not exist.');
    }
    const freshData = freshSnap.data() || {};

    if (newShopNameKey) {
      const oldKey = freshData.shopNameKey || normalizeShopName(freshData.shopName || '');
      const resRef = db.collection('shopNames').doc(newShopNameKey);
      const resSnap = await tx.get(resRef);
      if (resSnap.exists && resSnap.data()?.uid !== targetUid) {
        throw new HttpsError(
          'already-exists',
          'This shop name is already taken. Please choose a different name.'
        );
      }
      if (oldKey && oldKey !== newShopNameKey) {
        tx.delete(db.collection('shopNames').doc(oldKey));
      }
      tx.set(
        resRef,
        {
          uid: targetUid,
          shopName: sanitized.shopName,
          shopNameKey: newShopNameKey,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    for (const key of Object.keys(sanitized)) {
      if (key === 'shopNameKey') continue;
      if (JSON.stringify(freshData[key] ?? null) !== JSON.stringify(sanitized[key] ?? null)) {
        if (!changedKeys.includes(key)) changedKeys.push(key);
      }
    }

    tx.update(userRef, {
      ...sanitized,
      plainPassword: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  const changedLabels = changedKeys
    .filter((k) => LOCKED_FIELD_DISPLAY_LABELS[k])
    .map((k) => LOCKED_FIELD_DISPLAY_LABELS[k]);

  await db
    .collection('auditLogs')
    .add({
      action: auditAction,
      actorUid,
      actorEmail,
      targetUid,
      changedFields: changedKeys,
      timestamp: FieldValue.serverTimestamp(),
    })
    .catch(() => {});

  if (changedLabels.length > 0) {
    await db
      .collection('notifications')
      .add({
        userId: targetUid,
        title: 'Protected Account Details Updated',
        message: `Super Admin updated: ${changedLabels.join(', ')}.`,
        type: 'security_alert',
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});

    if (sendUpdateEmail) {
      const recipients = [...new Set([normalizeEmail(beforeData.email), normalizeEmail(sanitized.email)].filter(Boolean))];
      if (recipients.length > 0) {
        try {
          const supportContact = await getSupportContactInfo(db);
          const { subject, html } = buildLockedFieldsUpdatedEmailPayload({
            userData: { ...beforeData, ...sanitized },
            changedFieldLabels: changedLabels,
            supportContact,
          });
          const { transporter, gmailUser } = createGmailTransporter();
          for (const toAddr of recipients) {
            await transporter.sendMail({
              from: `"ReSellBD" <${gmailUser}>`,
              to: toAddr,
              subject,
              html,
            });
          }
        } catch (mailErr) {
          console.warn('[applyLockedUpdatesInternal] Email send skipped:', mailErr?.message || mailErr);
        }
      }
    }
  }

  return { changedKeys, changedLabels };
}

exports.updateResellerLockedFields = onCall(
  {
    region: REGION,
    cors: true,
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD],
  },
  async (request) => {
    const db = getDb();
    const { callerUid, callerEmail } = await assertSuperAdmin(request, db);

    const targetUid = String(request.data?.targetUid || '').trim();
    const updates = request.data?.updates;
    if (!targetUid || !updates || typeof updates !== 'object') {
      throw new HttpsError('invalid-argument', 'targetUid and updates object are required.');
    }

    const result = await applyLockedUpdatesInternal({
      db,
      targetUid,
      rawUpdates: updates,
      actorUid: callerUid,
      actorEmail: callerEmail,
      sendUpdateEmail: request.data?.notifyUser !== false,
      auditAction: 'super_admin_updated_locked_fields',
    });

    return {
      success: true,
      changedFields: result.changedKeys,
      message: 'Locked fields updated securely.',
    };
  }
);

exports.reviewChangeRequest = onCall(
  {
    region: REGION,
    cors: true,
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD],
  },
  async (request) => {
    const db = getDb();
    const { callerUid, callerEmail, callerData } = await assertSuperAdmin(request, db);

    const requestId = String(request.data?.requestId || '').trim();
    const collectionName =
      request.data?.collectionName === 'payoutChangeRequests' ? 'payoutChangeRequests' : 'changeRequests';
    const decision = request.data?.decision === 'approved' ? 'approved' : request.data?.decision === 'rejected' ? 'rejected' : '';
    const adminNote = String(request.data?.adminNote || '').trim();

    if (!requestId || !decision) {
      throw new HttpsError('invalid-argument', 'requestId and valid decision (approved/rejected) are required.');
    }
    if (decision === 'rejected' && !adminNote) {
      throw new HttpsError('invalid-argument', 'Please provide a reason when rejecting a change request.');
    }

    const reqRef = db.collection(collectionName).doc(requestId);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) {
      throw new HttpsError('not-found', 'Change request record not found.');
    }

    const reqData = reqSnap.data() || {};
    if (reqData.status !== 'pending') {
      throw new HttpsError('failed-precondition', `This request has already been ${reqData.status}.`);
    }

    const targetUid = String(reqData.uid || reqData.userId || reqData.resellerId || '').trim();
    if (!targetUid) {
      throw new HttpsError('failed-precondition', 'Change request is missing target reseller UID.');
    }

    const userSnap = await db.collection('users').doc(targetUid).get();
    if (!userSnap.exists) {
      throw new HttpsError('not-found', 'Reseller profile not found.');
    }
    const targetUser = userSnap.data() || {};

    let fieldLabel = reqData.fieldLabel || 'Protected Account Field';

    if (decision === 'approved') {
      let updatesToApply = {};
      if (collectionName === 'payoutChangeRequests') {
        fieldLabel = 'Payout Account Details';
        updatesToApply = {
          payoutMethod: reqData.payoutMethod || 'bkash',
          bkashNumber: reqData.bkashNumber || '',
          nagadNumber: reqData.nagadNumber || '',
          rocketNumber: reqData.rocketNumber || '',
          upayNumber: reqData.upayNumber || '',
          bankName: reqData.bankName || '',
          accountNumber: reqData.accountNumber || '',
          accountHolderName: reqData.accountHolderName || '',
          branchName: reqData.branchName || '',
          routingNumber: reqData.routingNumber || '',
        };
      } else {
        updatesToApply = { ...(reqData.requestedData || {}) };
        // Normalize structured payout methods update (add / edit / remove)
        if (reqData.fieldKey === 'payout' && reqData.requestedPayoutEntry) {
          const existingList = Array.isArray(targetUser.payoutMethods) ? [...targetUser.payoutMethods] : [];
          const entry = reqData.requestedPayoutEntry;
          const action = entry.action || 'add';

          if (action === 'remove') {
            const targetId = entry.targetPayoutId || entry.id;
            const remaining = existingList.filter((item) => item.id !== targetId);
            if (remaining.length > 0 && !remaining.some((item) => item.isDefault)) {
              remaining[0] = { ...remaining[0], isDefault: true };
            }
            updatesToApply.payoutMethods = remaining;
            const newDef = remaining.find((item) => item.isDefault) || remaining[0];
            if (newDef) {
              const defKey = String(newDef.type || 'bKash').toLowerCase();
              updatesToApply.payoutMethod = defKey === 'bank' ? 'bank' : defKey;
              updatesToApply.accountHolderName = newDef.accountHolderName || '';
              updatesToApply.accountNumber = newDef.accountNumber || '';
            } else {
              updatesToApply.accountNumber = '';
              updatesToApply.accountHolderName = '';
            }
          } else {
            const makeDefault = Boolean(entry.isDefault) || existingList.length === 0;
            const normalizedEntry = {
              id: entry.targetPayoutId || entry.id || `pm_${Date.now().toString(36)}`,
              type: entry.type || 'bKash',
              accountNumber: String(entry.accountNumber || '').trim(),
              accountHolderName: entry.accountHolderName || targetUser.fullName || '',
              bankName: entry.bankName || null,
              branchName: entry.branchName || null,
              routingNumber: entry.routingNumber || null,
              isDefault: makeDefault,
              verified: true,
              payoutVerified: 'verified',
              addedAt: entry.addedAt || new Date().toISOString(),
            };
            const filtered = existingList
              .filter((item) => item.id !== normalizedEntry.id)
              .map((item) => (makeDefault ? { ...item, isDefault: false } : item));
            filtered.push(normalizedEntry);
            updatesToApply.payoutMethods = filtered;

            const methodKey = String(normalizedEntry.type || 'bKash').toLowerCase();
            if (makeDefault) {
              updatesToApply.payoutMethod = methodKey === 'bank' ? 'bank' : methodKey;
              updatesToApply.accountHolderName = normalizedEntry.accountHolderName || '';
              updatesToApply.accountNumber = normalizedEntry.accountNumber || '';
            }
            if (methodKey === 'bkash') updatesToApply.bkashNumber = normalizedEntry.accountNumber;
            if (methodKey === 'nagad') updatesToApply.nagadNumber = normalizedEntry.accountNumber;
            if (methodKey === 'rocket') updatesToApply.rocketNumber = normalizedEntry.accountNumber;
            if (methodKey === 'upay') updatesToApply.upayNumber = normalizedEntry.accountNumber;
            if (methodKey === 'bank') {
              updatesToApply.bankName = normalizedEntry.bankName || '';
              updatesToApply.branchName = normalizedEntry.branchName || '';
              updatesToApply.routingNumber = normalizedEntry.routingNumber || '';
            }
          }
        }
      }

      await applyLockedUpdatesInternal({
        db,
        targetUid,
        rawUpdates: updatesToApply,
        actorUid: callerUid,
        actorEmail: callerEmail,
        sendUpdateEmail: false,
        auditAction: 'super_admin_approved_change_request',
      });
    } else {
      await db
        .collection('auditLogs')
        .add({
          action: 'super_admin_rejected_change_request',
          actorUid: callerUid,
          actorEmail: callerEmail,
          targetUid,
          requestId,
          adminNote,
          timestamp: FieldValue.serverTimestamp(),
        })
        .catch(() => {});
    }

    await reqRef.update({
      status: decision,
      adminNote: adminNote || null,
      decisionNote: adminNote || null,
      ...(decision === 'rejected' ? { rejectionReason: adminNote } : { approvedAt: FieldValue.serverTimestamp(), approvedBy: callerData.fullName || 'Super Admin' }),
      reviewedBy: callerUid,
      reviewedByName: callerData.fullName || 'Super Admin',
      decidedBy: callerData.fullName || callerEmail || 'Super Admin',
      reviewedAt: FieldValue.serverTimestamp(),
      decidedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    await db
      .collection('notices')
      .add({
        resellerId: targetUid,
        title: decision === 'approved' ? `Change Approved: ${fieldLabel}` : `Change Request Declined: ${fieldLabel}`,
        message:
          decision === 'approved'
            ? `Your request to update ${fieldLabel} has been approved by Super Admin.${adminNote ? ` Note: ${adminNote}` : ''}`
            : `Your request to update ${fieldLabel} was declined. Reason: ${adminNote}`,
        type: 'system',
        targetRole: 'reseller',
        createdAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});

    await db
      .collection('notifications')
      .add({
        userId: targetUid,
        title: decision === 'approved' ? `Change Request Approved` : `Change Request Declined`,
        message:
          decision === 'approved'
            ? `Super Admin approved your ${fieldLabel} update.`
            : `Your ${fieldLabel} update request was declined: ${adminNote}`,
        type: 'change_request_decision',
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});

    const notifyEmail = normalizeEmail(reqData?.requestedData?.email || targetUser.email);
    const oldEmail = normalizeEmail(targetUser.email);
    const emailTargets = [...new Set([oldEmail, notifyEmail].filter(Boolean))];
    if (emailTargets.length > 0) {
      try {
        const supportContact = await getSupportContactInfo(db);
        const { subject, html } = buildChangeRequestDecisionEmailPayload({
          userData: targetUser,
          fieldLabel,
          status: decision,
          adminNote,
          supportContact,
        });
        const { transporter, gmailUser } = createGmailTransporter();
        for (const toAddr of emailTargets) {
          await transporter.sendMail({
            from: `"ReSellBD" <${gmailUser}>`,
            to: toAddr,
            subject,
            html,
          });
        }
      } catch (mailErr) {
        console.warn('[reviewChangeRequest] Decision email skipped:', mailErr?.message || mailErr);
      }
    }

    return {
      success: true,
      decision,
      message:
        decision === 'approved'
          ? `Approved and applied ${fieldLabel} update.`
          : `Rejected change request for ${fieldLabel}.`,
    };
  }
);

exports.notifySuperAdminOnChangeRequest = onDocumentCreated(
  {
    document: 'changeRequests/{requestId}',
    database: FIRESTORE_DATABASE_ID,
    region: REGION,
  },
  async (event) => {
    const snap = event.data;
    if (!snap) return null;
    const reqData = snap.data() || {};
    const docId = event.params.requestId;
    const displayId = reqData.requestId || docId.slice(0, 8).toUpperCase();
    const fieldLabel = reqData.fieldLabel || reqData.field || 'Verified Info';
    const resellerName = reqData.resellerName || reqData.shopName || 'Reseller';
    const rawCode = String(reqData.resellerCode || reqData.resellerId || '').trim();
    const shortCode = rawCode.replace(/^SGR-/i, '');

    const db = getDb();
    const superAdminsSnap = await db
      .collection('users')
      .where('role', '==', 'super_admin')
      .get();

    const tokens = [];
    const writeOps = [];

    superAdminsSnap.forEach((saDoc) => {
      const saData = saDoc.data() || {};
      if (Array.isArray(saData.fcmTokens) && saData.fcmTokens.length > 0) {
        tokens.push(...saData.fcmTokens);
      }
      writeOps.push(
        db
          .collection('notifications')
          .doc(`cr_super_${docId}_${saDoc.id}`)
          .set(
            {
              userId: saDoc.id,
              targetRole: 'super_admin',
              type: 'change_request',
              requestId: displayId,
              changeRequestDocId: docId,
              resellerUid: reqData.uid || reqData.resellerUid || '',
              resellerId: shortCode,
              title: `New Change Request (${displayId})`,
              message: `${resellerName}${shortCode ? ` (${shortCode})` : ''} requested to update ${fieldLabel}.`,
              read: false,
              createdAt: FieldValue.serverTimestamp(),
            },
            { merge: true }
          )
          .catch(() => {})
      );
    });

    await Promise.allSettled(writeOps);

    if (tokens.length > 0) {
      await sendPushToTokens(tokens, {
        notification: {
          title: `Change Request (${displayId})`,
          body: `${resellerName} requested ${fieldLabel} update`,
        },
        data: {
          type: 'change_request',
          requestId: String(displayId),
          changeRequestDocId: String(docId),
        },
      }).catch((err) => {
        console.warn('[notifySuperAdminOnChangeRequest] Push send skipped:', err?.message || err);
      });
    }

    return null;
  }
);

exports.sendResellerPasswordReset = onCall(
  {
    region: REGION,
    cors: true,
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD],
  },
  async (request) => {
    const db = getDb();
    const { callerUid, callerEmail } = await assertSuperAdmin(request, db);

    const targetUid = String(request.data?.targetUid || '').trim();
    if (!targetUid) {
      throw new HttpsError('invalid-argument', 'Target user UID is required.');
    }

    const userSnap = await db.collection('users').doc(targetUid).get();
    if (!userSnap.exists) {
      throw new HttpsError('not-found', 'User account not found.');
    }
    const targetData = userSnap.data() || {};
    const targetEmail = normalizeEmail(targetData.email);
    if (!targetEmail) {
      throw new HttpsError('failed-precondition', 'Target account does not have an email address.');
    }

    const resetLink = await admin.auth().generatePasswordResetLink(targetEmail);
    const supportContact = await getSupportContactInfo(db);
    const { subject, html } = buildPasswordResetEmailPayload({
      userData: targetData,
      resetLink,
      supportContact,
    });

    const { transporter, gmailUser } = createGmailTransporter();
    await transporter.sendMail({
      from: `"ReSellBD" <${gmailUser}>`,
      to: targetEmail,
      subject,
      html,
    });

    await db
      .collection('auditLogs')
      .add({
        action: 'super_admin_sent_password_reset',
        actorUid: callerUid,
        actorEmail: callerEmail,
        targetUid,
        timestamp: FieldValue.serverTimestamp(),
      })
      .catch(() => {});

    return {
      success: true,
      message: `Password reset email sent to ${targetEmail}.`,
    };
  }
);

exports.setResellerTemporaryPassword = onCall(
  {
    region: REGION,
    cors: true,
    secrets: [GMAIL_USER, GMAIL_APP_PASSWORD],
  },
  async (request) => {
    const db = getDb();
    const { callerUid, callerEmail } = await assertSuperAdmin(request, db);

    const targetUid = String(request.data?.targetUid || '').trim();
    if (!targetUid) {
      throw new HttpsError('invalid-argument', 'Target user UID is required.');
    }

    const userRef = db.collection('users').doc(targetUid);
    const userSnap = await userRef.get();
    if (!userSnap.exists) {
      throw new HttpsError('not-found', 'User account not found.');
    }
    const targetData = userSnap.data() || {};
    if (normalizeEmail(targetData.email) === 'skyautomationtech@gmail.com') {
      throw new HttpsError('permission-denied', 'Cannot set a temporary password on the sole Super Admin account.');
    }

    let tempPassword = String(request.data?.temporaryPassword || '').trim();
    if (!tempPassword) {
      tempPassword = generateStrongTempPassword();
    } else if (!isValidPassword(tempPassword)) {
      throw new HttpsError(
        'invalid-argument',
        'Temporary password must be at least 8 characters and include uppercase, lowercase, number, and symbol.'
      );
    }

    await admin.auth().updateUser(targetUid, { password: tempPassword });
    await admin.auth().revokeRefreshTokens(targetUid).catch(() => {});

    await userRef.update({
      mustChangePassword: true,
      sessionsValidFrom: FieldValue.serverTimestamp(),
      plainPassword: FieldValue.delete(),
      updatedAt: FieldValue.serverTimestamp(),
    });

    try {
      const devSnap = await userRef.collection('devices').get();
      if (!devSnap.empty) {
        const batch = db.batch();
        devSnap.docs.forEach((d) => {
          batch.update(d.ref, {
            status: 'signed_out',
            signedOutAt: FieldValue.serverTimestamp(),
          });
        });
        await batch.commit();
      }
    } catch (devErr) {
      console.warn('[setResellerTemporaryPassword] Device sign-out skipped:', devErr?.message || devErr);
    }

    await db
      .collection('auditLogs')
      .add({
        action: 'super_admin_set_temporary_password',
        actorUid: callerUid,
        actorEmail: callerEmail,
        targetUid,
        timestamp: FieldValue.serverTimestamp(),
      })
      .catch(() => {});

    await db
      .collection('notifications')
      .add({
        userId: targetUid,
        title: 'Temporary Password Issued',
        message: 'Super Admin set a temporary password on your account. You must set a new password upon next sign-in.',
        type: 'security_alert',
        read: false,
        createdAt: FieldValue.serverTimestamp(),
      })
      .catch(() => {});

    const targetEmail = normalizeEmail(targetData.email);
    if (targetEmail) {
      try {
        const supportContact = await getSupportContactInfo(db);
        const { subject, html } = buildTemporaryPasswordSetEmailPayload({
          userData: targetData,
          supportContact,
        });
        const { transporter, gmailUser } = createGmailTransporter();
        await transporter.sendMail({
          from: `"ReSellBD" <${gmailUser}>`,
          to: targetEmail,
          subject,
          html,
        });
      } catch (mailErr) {
        console.warn('[setResellerTemporaryPassword] Security alert email skipped:', mailErr?.message || mailErr);
      }
    }

    // Returned strictly over HTTPS once in memory so Super Admin can copy & share securely. Never stored anywhere.
    return {
      success: true,
      tempPassword,
      message: 'Temporary password applied and active sessions revoked. User must change password on next login.',
    };
  }
);

exports.removePlainPasswords = onCall({ region: REGION, cors: true }, async (request) => {
  const db = getDb();
  const { callerUid, callerEmail } = await assertSuperAdmin(request, db);

  const usersSnap = await db.collection('users').get();
  let cleanedCount = 0;
  let opsCount = 0;
  const batches = [db.batch()];

  usersSnap.docs.forEach((docSnap) => {
    const data = docSnap.data() || {};
    if (Object.prototype.hasOwnProperty.call(data, 'plainPassword')) {
      batches[batches.length - 1].update(docSnap.ref, {
        plainPassword: FieldValue.delete(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      cleanedCount++;
      opsCount++;
      if (opsCount >= 400) {
        batches.push(db.batch());
        opsCount = 0;
      }
    }
  });

  if (cleanedCount > 0) {
    for (const b of batches) {
      await b.commit();
    }
  }

  await db
    .collection('auditLogs')
    .add({
      action: 'super_admin_removed_plain_passwords',
      actorUid: callerUid,
      actorEmail: callerEmail,
      cleanedCount,
      timestamp: FieldValue.serverTimestamp(),
    })
    .catch(() => {});

  return {
    success: true,
    cleanedCount,
    message:
      cleanedCount > 0
        ? `Removed stored plainPassword from ${cleanedCount} user account(s).`
        : 'No stored plainPassword fields found.',
  };
});


