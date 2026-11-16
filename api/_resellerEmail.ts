import crypto from 'crypto';
import nodemailer from 'nodemailer';
import type { Request, Response } from 'express';
import {
  getGmailCredentials,
  verifyFirebaseCallerIdToken,
  SOLE_SUPER_ADMIN_EMAIL_CONST,
} from './_otp.js';

const DEFAULT_PROJECT_ID = 'sky-automation-reseller';
const DEFAULT_DB_ID = 'ai-studio-5b67ed85-eca9-4578-81ec-a8f1bfd7298e';

const BRAND = {
  navy: '#04203F',
  teal: '#0E9AA7',
  green: '#3DD055',
  defaultAppUrl: 'https://re-sellbd.vercel.app',
  defaultSupportPhone: '01722063777',
  defaultSupportEmail: 'skyautomationtech@gmail.com',
};

const REJECTED_SECTION_LABELS: Record<string, string> = {
  basic: 'Basic Details (ব্যক্তিগত ও শপের তথ্য)',
  contact: 'Contact Info (যোগাযোগের তথ্য)',
  address: 'Shop Address (ঠিকানা)',
  payout: 'Payout / Banking (পেমেন্ট তথ্য)',
  business: 'Business Links (ব্যবসায়িক লিংক)',
  photos: 'Logo & Documents (লোগো ও এনআইডি/ডকুমেন্ট)',
};

const VALID_RESELLER_STATUSES = new Set(['pending', 'approved', 'rejected', 'suspended']);

// Fast in-memory dedupe guard alongside Firestore `lastStatusEmailFor`
const memoryStatusEmailCache = new Map<
  string,
  { status: string; sentAtMs: number; recentSentAtMs: number[] }
>();

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#x2F;');
}

function hashEmailForLog(email: string): string {
  if (!email) return 'anonymous';
  return crypto
    .createHash('sha256')
    .update(String(email).trim().toLowerCase())
    .digest('hex')
    .substring(0, 10);
}

function normalizeEmail(raw: unknown): string {
  return String(raw || '').trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function formatDateReadable(rawDate: unknown): string {
  if (!rawDate) return '';
  try {
    const d = new Date(String(rawDate));
    if (Number.isNaN(d.getTime())) return String(rawDate);
    return d.toLocaleDateString('en-GB', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return String(rawDate);
  }
}

function extractBearerToken(req: Request): string {
  const authHeader = req.headers.authorization || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function decodeFirestoreValue(val: any): any {
  if (!val || typeof val !== 'object') return undefined;
  if ('nullValue' in val) return null;
  if ('stringValue' in val) return val.stringValue;
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('timestampValue' in val) return val.timestampValue;
  if ('arrayValue' in val) {
    const items = Array.isArray(val.arrayValue?.values) ? val.arrayValue.values : [];
    return items.map(decodeFirestoreValue);
  }
  if ('mapValue' in val) {
    const out: Record<string, any> = {};
    const fields = val.mapValue?.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeFirestoreValue(v);
    }
    return out;
  }
  return undefined;
}

function decodeFirestoreDocument(docJson: any): Record<string, any> {
  const out: Record<string, any> = {};
  const fields = docJson?.fields || {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = decodeFirestoreValue(v);
  }
  return out;
}

function getFirestoreBaseUrl(): string {
  const projectId = (
    process.env.FIREBASE_PROJECT_ID ||
    process.env.VITE_FIREBASE_PROJECT_ID ||
    DEFAULT_PROJECT_ID
  ).trim();
  const dbId = (process.env.FIRESTORE_DATABASE_ID || DEFAULT_DB_ID).trim();
  return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/${encodeURIComponent(dbId)}/documents`;
}

async function fetchFirestoreDocRest(
  docPath: string,
  idToken?: string
): Promise<{ exists: boolean; data: Record<string, any> | null; status: number }> {
  const url = `${getFirestoreBaseUrl()}/${docPath}`;
  const resp = await fetch(url, {
    method: 'GET',
    headers: idToken ? { Authorization: `Bearer ${idToken}` } : {},
  });

  if (resp.status === 404) {
    return { exists: false, data: null, status: 404 };
  }
  if (!resp.ok) {
    return { exists: false, data: null, status: resp.status };
  }
  const json = await resp.json();
  return {
    exists: true,
    data: decodeFirestoreDocument(json),
    status: resp.status,
  };
}

async function stampLastStatusEmailRest(
  uid: string,
  idToken: string,
  record: { status: string; sentAtMs: number; recentSentAtMs: number[] }
): Promise<boolean> {
  try {
    const url = `${getFirestoreBaseUrl()}/users/${encodeURIComponent(uid)}?updateMask.fieldPaths=lastStatusEmailFor`;
    const body = {
      fields: {
        lastStatusEmailFor: {
          mapValue: {
            fields: {
              status: { stringValue: record.status },
              sentAtMs: { integerValue: String(record.sentAtMs) },
              sentAt: { timestampValue: new Date(record.sentAtMs).toISOString() },
              recentSentAtMs: {
                arrayValue: {
                  values: record.recentSentAtMs.map((ms) => ({
                    integerValue: String(Math.trunc(ms)),
                  })),
                },
              },
            },
          },
        },
      },
    };

    const resp = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${idToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.warn(
        `[resellerStatusEmail] Could not persist lastStatusEmailFor uid=${uid} (HTTP ${resp.status}):`,
        errText.slice(0, 180)
      );
      return false;
    }
    return true;
  } catch (err: any) {
    console.warn(`[resellerStatusEmail] Stamp error uid=${uid}:`, err?.message || err);
    return false;
  }
}

async function getSupportContactRest(idToken?: string): Promise<{
  supportPhone: string;
  supportEmail: string;
}> {
  let supportPhone = BRAND.defaultSupportPhone;
  let supportEmail = BRAND.defaultSupportEmail;

  try {
    const res = await fetchFirestoreDocRest('settings/general', idToken);
    if (res.exists && res.data) {
      const s = res.data;
      if (typeof s.phoneNumbers === 'string' && s.phoneNumbers.trim()) {
        supportPhone = s.phoneNumbers.trim();
      } else if (typeof s.supportPhone === 'string' && s.supportPhone.trim()) {
        supportPhone = s.supportPhone.trim();
      }
      if (typeof s.email === 'string' && s.email.trim()) {
        supportEmail = s.email.trim();
      } else if (typeof s.supportEmail === 'string' && s.supportEmail.trim()) {
        supportEmail = s.supportEmail.trim();
      }
    }
  } catch {
    // Use ReSellBD defaults
  }

  return { supportPhone, supportEmail };
}

function buildStatusEmailPayload(params: {
  beforeStatus: string | null;
  afterStatus: string;
  afterData: Record<string, any>;
  uid: string;
  supportContact: { supportPhone: string; supportEmail: string };
  appUrl: string;
}): { subject: string; html: string } | null {
  const { beforeStatus, afterStatus, afterData, uid, supportContact, appUrl } = params;

  const safeName = escapeHtml(String(afterData.fullName || 'Reseller').trim());
  const safeShop = escapeHtml(String(afterData.shopName || '').trim());
  const rawResellerId = afterData.resellerId || afterData.resellerCode || uid;
  const safeResellerId = escapeHtml(rawResellerId);
  const safeLoginEmail = escapeHtml(normalizeEmail(afterData.email));
  const cleanAppUrl = appUrl.replace(/\/+$/, '');
  const safeAppUrl = escapeHtml(cleanAppUrl);
  const safeLogoUrl = escapeHtml(`${cleanAppUrl}/resellbd-logo.png`);

  const safeSupportPhone = escapeHtml(supportContact.supportPhone || BRAND.defaultSupportPhone);
  const safeSupportEmail = escapeHtml(supportContact.supportEmail || BRAND.defaultSupportEmail);
  const waDigits = String(supportContact.supportPhone || BRAND.defaultSupportPhone).replace(/\D/g, '');
  const waHref = waDigits.startsWith('88') ? `https://wa.me/${waDigits}` : `https://wa.me/88${waDigits}`;

  const isFirstPending = !beforeStatus && afterStatus === 'pending';
  const isResubmittedPending = Boolean(beforeStatus && beforeStatus !== 'pending' && afterStatus === 'pending');
  const isReactivated = beforeStatus === 'suspended' && afterStatus === 'approved';

  let subject = '';
  let badgeText = '';
  let badgeBg = BRAND.teal;
  let headingEn = '';
  let headingBn = '';
  let bodyHtml = '';

  if (isFirstPending) {
    subject = 'Your ReSellBD account is under review | আপনার ReSellBD অ্যাকাউন্ট রিভিউ চলছে';
    badgeText = 'UNDER REVIEW • রিভিউ চলছে';
    badgeBg = BRAND.teal;
    headingEn = 'Your ReSellBD account is under review';
    headingBn = 'আপনার ReSellBD অ্যাকাউন্ট এখন যাচাই-বাছাই করা হচ্ছে';
    bodyHtml = `
      <p style="margin:0 0 12px 0; color:#e2e8f0; font-size:14px; line-height:1.6;">
        প্রিয় <strong>${safeName}</strong>${safeShop ? ` (${safeShop})` : ''}, ReSellBD-তে রেজিস্ট্রেশন করার জন্য ধন্যবাদ! আপনার আবেদনটি সফলভাবে জমা হয়েছে।
      </p>
      <p style="margin:0 0 16px 0; color:#cbd5e1; font-size:13px; line-height:1.6;">
        Thank you for registering with <strong>ReSellBD</strong>. Your application is now in our verification queue and is usually reviewed <strong>within 1 hour</strong> (সাধারণত ১ ঘণ্টার মধ্যেই রিভিউ সম্পন্ন হয়)।
      </p>
      <div style="background:rgba(14,154,167,0.14); border:1px solid #0E9AA7; border-radius:12px; padding:14px 16px; margin-bottom:16px;">
        <div style="font-size:12px; color:#94a3b8; margin-bottom:4px;">Your Reseller ID / আপনার রিসেলার আইডি:</div>
        <div style="font-size:18px; font-weight:800; color:#3DD055; font-family:monospace; letter-spacing:0.5px;">${safeResellerId}</div>
      </div>
      <div style="background:rgba(255,255,255,0.05); border:1px solid rgba(255,255,255,0.12); border-radius:12px; padding:14px 16px; margin-bottom:16px;">
        <p style="margin:0 0 6px 0; color:#ffffff; font-size:13px; font-weight:700;">অপেক্ষাকালীন অ্যাক্সেস / Access While Pending:</p>
        <p style="margin:0; color:#cbd5e1; font-size:13px; line-height:1.55;">
          প্রথম ১ ঘণ্টার পরও আবেদনটি পেন্ডিং থাকলে আপনি সীমিত অ্যাক্সেসে অ্যাপ ব্যবহার করতে পারবেন (শুধুমাত্র Home স্ক্রিন দেখা যাবে এবং পাইকারি মূল্য গোপন থাকবে)।<br/>
          After the first hour, if your account is still pending, you can use the app with limited access (Home screen only, with wholesale prices hidden until approved).
        </p>
      </div>
    `;
  } else if (isResubmittedPending) {
    subject = 'Your ReSellBD account is under review again | আপনার অ্যাকাউন্ট পুনরায় রিভিউ চলছে';
    badgeText = 'RE-REVIEW IN PROGRESS • পুনরায় রিভিউ';
    badgeBg = BRAND.teal;
    headingEn = 'Your account is under review again';
    headingBn = 'আপনার অ্যাকাউন্ট পুনরায় যাচাই করা হচ্ছে';
    bodyHtml = `
      <p style="margin:0 0 12px 0; color:#e2e8f0; font-size:14px; line-height:1.6;">
        প্রিয় <strong>${safeName}</strong>, আপনার আপডেট করা তথ্য ও ডকুমেন্টস আমরা পেয়েছি এবং অ্যাকাউন্টটি পুনরায় রিভিউ করা হচ্ছে।
      </p>
      <p style="margin:0 0 16px 0; color:#cbd5e1; font-size:13px; line-height:1.6;">
        We have received your updated registration details. Your account (<strong>${safeResellerId}</strong>) is under review again and is usually reviewed <strong>within 1 hour</strong>. After the first hour, if still pending, you can use the app with limited access (Home screen only, wholesale prices hidden).
      </p>
    `;
  } else if (isReactivated) {
    subject = 'Your ReSellBD account is active again | আপনার অ্যাকাউন্ট পুনরায় সক্রিয় হয়েছে';
    badgeText = 'ACCOUNT ACTIVE • অ্যাকাউন্ট সক্রিয়';
    badgeBg = BRAND.green;
    headingEn = 'Your account is active again';
    headingBn = 'আপনার ReSellBD অ্যাকাউন্ট পুনরায় সক্রিয় করা হয়েছে';
    bodyHtml = `
      <p style="margin:0 0 12px 0; color:#e2e8f0; font-size:14px; line-height:1.6;">
        প্রিয় <strong>${safeName}</strong>, সুখবর! আপনার ReSellBD অ্যাকাউন্টের স্থগিতাদেশ তুলে নেওয়া হয়েছে এবং অ্যাকাউন্টটি এখন সম্পূর্ণ সক্রিয়।
      </p>
      <p style="margin:0 0 16px 0; color:#cbd5e1; font-size:13px; line-height:1.6;">
        Great news! Your ReSellBD reseller account is active again. You now have full access to wholesale prices, orders, and wallet features.
      </p>
      <div style="background:rgba(61,208,85,0.12); border:1px solid #3DD055; border-radius:12px; padding:14px 16px; margin-bottom:18px;">
        <div style="font-size:12px; color:#cbd5e1; margin-bottom:6px;"><strong>How to Sign In / লগইন করার নিয়ম:</strong></div>
        <div style="font-size:13px; color:#ffffff; line-height:1.6;">
          • Reseller ID: <strong style="color:#3DD055; font-family:monospace;">${safeResellerId}</strong><br/>
          • অথবা Email: <strong>${safeLoginEmail}</strong>
        </div>
      </div>
      <div style="text-align:center; margin:20px 0 8px 0;">
        <a href="${safeAppUrl}" style="display:inline-block; background:linear-gradient(135deg, ${BRAND.teal}, ${BRAND.green}); color:#ffffff; text-decoration:none; font-weight:800; font-size:14px; padding:13px 28px; border-radius:12px;">
          Open ReSellBD App • অ্যাপ খুলুন
        </a>
      </div>
    `;
  } else if (afterStatus === 'approved') {
    subject = 'Welcome to ReSellBD! Your account is approved | ReSellBD-তে স্বাগতম!';
    badgeText = 'APPROVED • অনুমোদিত';
    badgeBg = BRAND.green;
    headingEn = 'Welcome to ReSellBD! Your account is approved';
    headingBn = 'অভিনন্দন! আপনার ReSellBD রিসেলার অ্যাকাউন্ট অনুমোদিত হয়েছে';
    bodyHtml = `
      <p style="margin:0 0 12px 0; color:#e2e8f0; font-size:14px; line-height:1.6;">
        প্রিয় <strong>${safeName}</strong>${safeShop ? ` (${safeShop})` : ''}, ReSellBD পরিবারে আপনাকে স্বাগতম! আপনার রিসেলার অ্যাকাউন্ট যাচাই শেষে অনুমোদিত হয়েছে।
      </p>
      <p style="margin:0 0 16px 0; color:#cbd5e1; font-size:13px; line-height:1.6;">
        Welcome to <strong>ReSellBD</strong>! Your reseller account is now verified and active. You can browse wholesale prices, place customer orders, and earn commissions right away.
      </p>
      <div style="background:rgba(61,208,85,0.12); border:1px solid #3DD055; border-radius:12px; padding:14px 16px; margin-bottom:18px;">
        <div style="font-size:12px; color:#cbd5e1; margin-bottom:6px;"><strong>How to Log In / যেভাবে লগইন করবেন:</strong></div>
        <div style="font-size:13px; color:#ffffff; line-height:1.6;">
          • আপনার Reseller ID: <strong style="color:#3DD055; font-family:monospace;">${safeResellerId}</strong><br/>
          • অথবা Email: <strong>${safeLoginEmail}</strong><br/>
          <span style="font-size:12px; color:#94a3b8;">(রেজিস্ট্রেশনের সময় দেওয়া আপনার পাসওয়ার্ড ব্যবহার করে লগইন করুন)</span>
        </div>
      </div>
      <div style="text-align:center; margin:20px 0 8px 0;">
        <a href="${safeAppUrl}" style="display:inline-block; background:linear-gradient(135deg, ${BRAND.teal}, ${BRAND.green}); color:#ffffff; text-decoration:none; font-weight:800; font-size:14px; padding:13px 28px; border-radius:12px;">
          Open ReSellBD App • অ্যাপ ওপেন করুন
        </a>
      </div>
    `;
  } else if (afterStatus === 'rejected') {
    subject = 'Action Needed: ReSellBD Registration Update | আপনার ReSellBD আবেদনে সংশোধন প্রয়োজন';
    badgeText = 'NEEDS CORRECTION • সংশোধন প্রয়োজন';
    badgeBg = '#D97706';
    headingEn = 'More information required for your application';
    headingBn = 'আপনার আবেদনে কিছু তথ্য সংশোধন প্রয়োজন';

    const rawReason = String(afterData.rejectReason || '').trim();
    const safeReason = escapeHtml(
      rawReason || 'প্রদত্ত তথ্য বা ডকুমেন্ট যাচাইয়ের সাথে মেলেনি। অনুগ্রহ করে সঠিক তথ্য দিয়ে পুনরায় জমা দিন।'
    );

    const sections = Array.isArray(afterData.rejectedSections)
      ? afterData.rejectedSections.map((s: any) => String(s || '').trim()).filter(Boolean)
      : [];

    const sectionsHtml =
      sections.length > 0
        ? `
          <div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.12);">
            <div style="font-size:12px; color:#fcd34d; font-weight:700; margin-bottom:6px;">Sections to fix / যে অংশগুলো ঠিক করতে হবে:</div>
            <ul style="margin:0; padding-left:18px; color:#f1f5f9; font-size:13px; line-height:1.6;">
              ${sections
                .map((sec: string) => `<li>${escapeHtml(REJECTED_SECTION_LABELS[sec] || sec)}</li>`)
                .join('')}
            </ul>
          </div>
        `
        : '';

    bodyHtml = `
      <p style="margin:0 0 12px 0; color:#e2e8f0; font-size:14px; line-height:1.6;">
        প্রিয় <strong>${safeName}</strong>, আপনার ReSellBD রিসেলার আবেদনটি (<strong>${safeResellerId}</strong>) যাচাই করার পর অনুমোদনের আগে কিছু তথ্য সংশোধনের অনুরোধ জানানো হয়েছে।
      </p>
      <p style="margin:0 0 16px 0; color:#cbd5e1; font-size:13px; line-height:1.6;">
        Thank you for applying to ReSellBD. Our review team could not approve your application yet due to the reason below. Please update the flagged details and resubmit directly from the app.
      </p>
      <div style="background:rgba(217,119,6,0.14); border:1px solid rgba(245,158,11,0.5); border-radius:12px; padding:14px 16px; margin-bottom:16px;">
        <div style="font-size:12px; color:#fcd34d; font-weight:700; margin-bottom:4px;">Reason / কারণ:</div>
        <div style="font-size:13px; color:#ffffff; line-height:1.55;">${safeReason}</div>
        ${sectionsHtml}
      </div>
      <p style="margin:0 0 16px 0; color:#cbd5e1; font-size:13px; line-height:1.6;">
        লগইন করে <strong>Edit &amp; Resubmit Application</strong> বাটনে ক্লিক করে তথ্য ঠিক করুন, অথবা কোনো সাহায্যের জন্য আমাদের সাপোর্টে যোগাযোগ করুন।<br/>
        Sign in to edit and resubmit your details, or contact our support team anytime for assistance.
      </p>
      <div style="text-align:center; margin:16px 0 8px 0;">
        <a href="${safeAppUrl}" style="display:inline-block; background:${BRAND.teal}; color:#ffffff; text-decoration:none; font-weight:700; font-size:14px; padding:12px 26px; border-radius:12px;">
          Open ReSellBD to Update • তথ্য সংশোধন করুন
        </a>
      </div>
    `;
  } else if (afterStatus === 'suspended') {
    const isPermanent = afterData.suspensionType === 'permanent';
    const rawTypeLabel = isPermanent
      ? 'Permanent Suspension / স্থায়ীভাবে স্থগিত'
      : 'Temporary Suspension / সাময়িক স্থগিত';
    const safeTypeLabel = escapeHtml(rawTypeLabel);
    const rawSuspReason = String(afterData.suspensionReason || '').trim();
    const safeSuspReason = escapeHtml(
      rawSuspReason || 'প্রশাসনিক নীতিমালা যাচাইয়ের কারণে আপনার অ্যাকাউন্টটি স্থগিত করা হয়েছে।'
    );
    const rawEndDate = afterData.suspendedUntil || afterData.suspensionEndDate;
    const formattedEndDate = !isPermanent && rawEndDate ? formatDateReadable(rawEndDate) : '';
    const safeEndDate = escapeHtml(formattedEndDate);

    subject = isPermanent
      ? 'Important: Your ReSellBD account has been suspended | আপনার ReSellBD অ্যাকাউন্ট স্থগিত করা হয়েছে'
      : 'Notice: Your ReSellBD account is temporarily suspended | আপনার অ্যাকাউন্ট সাময়িকভাবে স্থগিত';
    badgeText = isPermanent ? 'SUSPENDED • স্থায়ী স্থগিত' : 'TEMPORARY PAUSE • সাময়িক স্থগিত';
    badgeBg = '#E11D48';
    headingEn = isPermanent ? 'Your ReSellBD account has been suspended' : 'Your ReSellBD account is temporarily suspended';
    headingBn = isPermanent ? 'আপনার ReSellBD অ্যাকাউন্ট স্থগিত করা হয়েছে' : 'আপনার ReSellBD অ্যাকাউন্ট সাময়িকভাবে স্থগিত করা হয়েছে';

    bodyHtml = `
      <p style="margin:0 0 12px 0; color:#e2e8f0; font-size:14px; line-height:1.6;">
        প্রিয় <strong>${safeName}</strong>, আপনার ReSellBD রিসেলার অ্যাকাউন্ট (<strong>${safeResellerId}</strong>)-এর অ্যাক্সেস বর্তমানে স্থগিত রাখা হয়েছে।
      </p>
      <p style="margin:0 0 16px 0; color:#cbd5e1; font-size:13px; line-height:1.6;">
        Your ReSellBD reseller account access has been suspended. Please review the details below and contact support if you need clarification or wish to appeal.
      </p>
      <div style="background:rgba(225,29,72,0.14); border:1px solid rgba(244,63,94,0.45); border-radius:12px; padding:14px 16px; margin-bottom:16px;">
        <div style="font-size:13px; color:#fecdd3; margin-bottom:6px;">
          <strong>Type / ধরন:</strong> ${safeTypeLabel}
        </div>
        <div style="font-size:13px; color:#ffffff; line-height:1.55; margin-bottom:${safeEndDate ? '6px' : '0'};">
          <strong>Reason / কারণ:</strong> ${safeSuspReason}
        </div>
        ${
          safeEndDate
            ? `<div style="font-size:13px; color:#fde68a;"><strong>Suspended Until / শেষ তারিখ:</strong> ${safeEndDate}</div>`
            : ''
        }
      </div>
      <p style="margin:0; color:#cbd5e1; font-size:13px; line-height:1.6;">
        সাহায্যের জন্য নিচের সাপোর্ট ফোন/হোয়াটসঅ্যাপ বা ইমেইলে যোগাযোগ করুন।<br/>
        Please contact our support team below for assistance.
      </p>
    `;
  } else {
    return null;
  }

  const html = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>${escapeHtml(subject)}</title>
    </head>
    <body style="margin:0; padding:16px 10px; background-color:#03152A; font-family:-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">
      <div style="max-width:600px; margin:0 auto; background-color:${BRAND.navy}; border-radius:18px; border:1px solid rgba(14,154,167,0.35); overflow:hidden;">
        <div style="background:linear-gradient(135deg, ${BRAND.navy} 0%, #07335C 60%, #094D63 100%); padding:22px 24px; text-align:center; border-bottom:2px solid ${BRAND.teal};">
          <img src="${safeLogoUrl}" alt="ReSellBD" width="56" height="56" style="display:inline-block; width:56px; height:56px; border-radius:14px; object-fit:contain; background:#ffffff; padding:4px; margin-bottom:10px;" />
          <div style="font-size:22px; font-weight:900; color:#ffffff; letter-spacing:-0.4px; margin:0;">
            ReSell<span style="color:${BRAND.green};">BD</span>
          </div>
          <div style="display:inline-block; margin-top:8px; padding:4px 12px; border-radius:999px; background-color:${badgeBg}; color:#ffffff; font-size:11px; font-weight:800; letter-spacing:0.6px;">
            ${escapeHtml(badgeText)}
          </div>
        </div>
        <div style="padding:24px 22px;">
          <h2 style="margin:0 0 4px 0; color:#ffffff; font-size:18px; font-weight:800; line-height:1.35;">${escapeHtml(headingEn)}</h2>
          <p style="margin:0 0 18px 0; color:${BRAND.green}; font-size:13px; font-weight:700;">${escapeHtml(headingBn)}</p>
          ${bodyHtml}
        </div>
        <div style="background-color:#02162C; padding:18px 22px; border-top:1px solid rgba(255,255,255,0.1); text-align:center;">
          <p style="margin:0 0 8px 0; color:#cbd5e1; font-size:12px; line-height:1.5;">
            <strong style="color:#ffffff;">ReSellBD Support / সহায়তা কেন্দ্র:</strong><br/>
            Phone / WhatsApp: <a href="${escapeHtml(waHref)}" style="color:${BRAND.green}; text-decoration:none; font-weight:700;">${safeSupportPhone}</a> &nbsp;|&nbsp;
            Email: <a href="mailto:${safeSupportEmail}" style="color:${BRAND.teal}; text-decoration:none; font-weight:700;">${safeSupportEmail}</a>
          </p>
          <p style="margin:0; color:#64748b; font-size:11px; line-height:1.4;">
            Sky Automation Tech • ReSellBD B2B Wholesale Platform<br/>
            This is an automated status update sent to your registered account email.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;

  return { subject, html };
}

export async function handleResellerStatusEmailRequest(req: Request, res: Response): Promise<void> {
  const targetUid = String(req.body?.uid || req.body?.targetUid || '').trim();
  const isBackfill = Boolean(req.body?.isBackfill);
  const rawBeforeStatus = req.body?.beforeStatus;
  const beforeStatus = rawBeforeStatus ? String(rawBeforeStatus).trim().toLowerCase() : null;

  if (!targetUid) {
    res.status(400).json({ error: 'Target user UID is required.', code: 'invalid-argument' });
    return;
  }

  let caller: { uid: string; email: string };
  try {
    caller = await verifyFirebaseCallerIdToken(req);
  } catch (authErr: any) {
    res.status(authErr?.status || 401).json({
      error: authErr?.message || 'Unauthorized',
      code: authErr?.code || 'unauthenticated',
    });
    return;
  }

  const idToken = extractBearerToken(req);
  if (!idToken) {
    res.status(401).json({ error: 'Bearer token required.', code: 'unauthenticated' });
    return;
  }

  try {
    // 1. Fetch authoritative user document from Firestore
    const targetDoc = await fetchFirestoreDocRest(`users/${encodeURIComponent(targetUid)}`, idToken);
    if (!targetDoc.exists || !targetDoc.data) {
      res.status(404).json({ error: 'Reseller user profile not found.', code: 'not-found' });
      return;
    }

    const afterData = targetDoc.data;
    const role = String(afterData.role || '').trim().toLowerCase();
    const afterStatus = String(afterData.status || '').trim().toLowerCase();

    if (role !== 'reseller') {
      res.json({ success: true, sent: false, skipped: true, reason: 'not_reseller' });
      return;
    }

    if (!VALID_RESELLER_STATUSES.has(afterStatus)) {
      res.json({ success: true, sent: false, skipped: true, reason: 'invalid_status' });
      return;
    }

    // 2. Verify caller authorization (Admin / Super Admin, OR self for pending registration/resubmit)
    const isSoleSuperAdmin = caller.email === SOLE_SUPER_ADMIN_EMAIL_CONST;
    let isAuthorized = isSoleSuperAdmin;

    if (!isAuthorized) {
      if (caller.uid === targetUid && afterStatus === 'pending' && !isBackfill) {
        isAuthorized = true;
      } else {
        const callerDoc = await fetchFirestoreDocRest(`users/${encodeURIComponent(caller.uid)}`, idToken);
        const callerRole = String(callerDoc.data?.role || '').trim().toLowerCase();
        if (callerRole === 'admin' || callerRole === 'super_admin') {
          isAuthorized = true;
        }
      }
    }

    if (!isAuthorized) {
      res.status(403).json({
        error: 'Only Admin or Super Admin can dispatch reseller status emails.',
        code: 'permission-denied',
      });
      return;
    }

    // 3. Validate recipient email
    const targetEmail = normalizeEmail(afterData.email);
    const emailHash = hashEmailForLog(targetEmail);
    if (!targetEmail || !isValidEmail(targetEmail) || targetEmail === SOLE_SUPER_ADMIN_EMAIL_CONST) {
      res.json({ success: true, sent: false, skipped: true, reason: 'invalid_or_protected_email' });
      return;
    }

    // 4. Idempotency (5-minute dedupe / backfill already-emailed check) + Hourly rate limit (max 3/hour)
    const nowMs = Date.now();
    const FIVE_MINUTES_MS = 5 * 60 * 1000;
    const ONE_HOUR_MS = 60 * 60 * 1000;
    const MAX_EMAILS_PER_HOUR = 3;

    const fsRecord = afterData.lastStatusEmailFor && typeof afterData.lastStatusEmailFor === 'object'
      ? afterData.lastStatusEmailFor
      : {};
    const memRecord = memoryStatusEmailCache.get(targetUid);

    const prevStatus = String(
      (memRecord && memRecord.sentAtMs >= Number(fsRecord.sentAtMs || 0)
        ? memRecord.status
        : fsRecord.status) || ''
    )
      .trim()
      .toLowerCase();

    const fsSentAtMs =
      Number(fsRecord.sentAtMs || 0) ||
      (typeof fsRecord.sentAt === 'string' ? Date.parse(fsRecord.sentAt) || 0 : 0);
    const prevSentAtMs = Math.max(fsSentAtMs, memRecord?.sentAtMs || 0);

    if (isBackfill && prevStatus === afterStatus && prevSentAtMs > 0) {
      res.json({ success: true, sent: false, skipped: true, reason: 'already_emailed_for_status' });
      return;
    }

    if (!isBackfill && prevStatus === afterStatus && prevSentAtMs > 0 && nowMs - prevSentAtMs < FIVE_MINUTES_MS) {
      res.json({ success: true, sent: false, skipped: true, reason: 'duplicate_within_5m' });
      return;
    }

    const fsRecent = Array.isArray(fsRecord.recentSentAtMs) ? fsRecord.recentSentAtMs : [];
    const memRecent = memRecord?.recentSentAtMs || [];
    const mergedRecent = [...new Set([...fsRecent, ...memRecent])]
      .map((n) => Number(n))
      .filter((ts) => Number.isFinite(ts) && nowMs - ts < ONE_HOUR_MS);

    if (mergedRecent.length >= MAX_EMAILS_PER_HOUR) {
      res.json({ success: true, sent: false, skipped: true, reason: 'hourly_limit_reached' });
      return;
    }

    // 5. Build & send email via Gmail SMTP
    const supportContact = await getSupportContactRest(idToken);
    const originHeader = String(req.headers.origin || '').trim();
    const effectiveAppUrl =
      process.env.APP_URL ||
      (originHeader &&
      /^https?:\/\//i.test(originHeader) &&
      !originHeader.includes('localhost') &&
      !originHeader.includes('127.0.0.1')
        ? originHeader
        : BRAND.defaultAppUrl);

    const emailPayload = buildStatusEmailPayload({
      beforeStatus: isBackfill ? null : beforeStatus,
      afterStatus,
      afterData,
      uid: targetUid,
      supportContact,
      appUrl: effectiveAppUrl,
    });

    if (!emailPayload) {
      res.json({ success: true, sent: false, skipped: true, reason: 'unsupported_status' });
      return;
    }

    const { user, pass } = getGmailCredentials();
    if (!user || !pass) {
      console.error(`[resellerStatusEmail] Missing Gmail credentials for uid=${targetUid} emailHash=${emailHash}`);
      res.status(500).json({
        success: false,
        sent: false,
        error: 'Email delivery configuration is missing.',
        code: 'failed-precondition',
      });
      return;
    }

    const transporter = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
      auth: { user, pass },
    });

    await transporter.sendMail({
      from: `"ReSellBD" <${user}>`,
      to: targetEmail,
      subject: emailPayload.subject,
      html: emailPayload.html,
    });

    const nextRecord = {
      status: afterStatus,
      sentAtMs: nowMs,
      recentSentAtMs: [...mergedRecent, nowMs],
    };
    memoryStatusEmailCache.set(targetUid, nextRecord);

    // Stamp `lastStatusEmailFor` on `users/{targetUid}` in Firestore so Cloud Functions / backfill stay synchronized
    await stampLastStatusEmailRest(targetUid, idToken, nextRecord);

    console.log(
      `[resellerStatusEmail] Sent status=${afterStatus} prev=${beforeStatus || 'none'} backfill=${isBackfill} uid=${targetUid} emailHash=${emailHash}`
    );

    res.json({
      success: true,
      sent: true,
      status: afterStatus,
      lastStatusEmailFor: nextRecord,
    });
  } catch (err: any) {
    console.error(
      `[resellerStatusEmail] Failed uid=${targetUid}:`,
      err?.message || 'Unknown email delivery error'
    );
    res.status(500).json({
      success: false,
      sent: false,
      error: 'Could not deliver status email via Gmail SMTP.',
      code: 'internal',
    });
  }
}
