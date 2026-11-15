const { FieldValue } = require('firebase-admin/firestore');

const BRAND = {
  navy: '#04203F',
  teal: '#0E9AA7',
  green: '#3DD055',
  appUrl: process.env.APP_URL || 'https://re-sellbd.vercel.app',
  defaultSupportPhone: '01722063777',
  defaultSupportEmail: 'skyautomationtech@gmail.com',
};

const REJECTED_SECTION_LABELS = {
  basic: 'Basic Details (ব্যক্তিগত ও শপের তথ্য)',
  contact: 'Contact Info (যোগাযোগের তথ্য)',
  address: 'Shop Address (ঠিকানা)',
  payout: 'Payout / Banking (পেমেন্ট তথ্য)',
  business: 'Business Links (ব্যবসায়িক লিংক)',
  photos: 'Logo & Documents (লোগো ও এনআইডি/ডকুমেন্ট)',
};

/**
 * Escapes untrusted user-supplied text before interpolating into HTML emails.
 */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\//g, '&#x2F;');
}

function formatDateReadable(rawDate) {
  if (!rawDate) return '';
  try {
    const d = typeof rawDate.toDate === 'function' ? rawDate.toDate() : new Date(rawDate);
    if (Number.isNaN(d.getTime())) return String(rawDate);
    return d.toLocaleDateString('en-GB', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch (_err) {
    return String(rawDate);
  }
}

async function getSupportContactInfo(db) {
  let supportPhone = BRAND.defaultSupportPhone;
  let supportEmail = BRAND.defaultSupportEmail;

  try {
    const settingsSnap = await db.collection('settings').doc('general').get();
    if (settingsSnap.exists) {
      const s = settingsSnap.data() || {};
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
  } catch (_err) {
    // Fallback to built-in ReSellBD support constants
  }

  return { supportPhone, supportEmail };
}

function buildStatusEmailPayload({ beforeStatus, afterStatus, afterData, uid, supportContact }) {
  const safeName = escapeHtml((afterData.fullName || 'Reseller').trim());
  const safeShop = escapeHtml((afterData.shopName || '').trim());
  const rawResellerId = afterData.resellerId || afterData.resellerCode || uid;
  const safeResellerId = escapeHtml(rawResellerId);
  const safeLoginEmail = escapeHtml((afterData.email || '').trim().toLowerCase());
  const safeAppUrl = escapeHtml(BRAND.appUrl);
  const logoUrl = `${BRAND.appUrl.replace(/\/+$/, '')}/resellbd-logo.png`;
  const safeLogoUrl = escapeHtml(logoUrl);

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
          অনুমোদন না হওয়া পর্যন্ত আপনি শুধুমাত্র <strong>Home</strong> স্ক্রিন দেখতে পারবেন এবং পণ্যের পাইকারি মূল্য গোপন থাকবে।<br/>
          Until your account is approved, you can only view the <strong>Home</strong> screen and wholesale prices remain hidden.
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
        We have received your updated registration details. Your account (<strong>${safeResellerId}</strong>) is under review again and is usually reviewed <strong>within 1 hour</strong>. Until approval, only the Home screen is visible and prices remain hidden.
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
      ? afterData.rejectedSections.map((s) => String(s || '').trim()).filter(Boolean)
      : [];

    const sectionsHtml =
      sections.length > 0
        ? `
          <div style="margin-top:10px; padding-top:10px; border-top:1px solid rgba(255,255,255,0.12);">
            <div style="font-size:12px; color:#fcd34d; font-weight:700; margin-bottom:6px;">Sections to fix / যে অংশগুলো ঠিক করতে হবে:</div>
            <ul style="margin:0; padding-left:18px; color:#f1f5f9; font-size:13px; line-height:1.6;">
              ${sections
                .map((sec) => `<li>${escapeHtml(REJECTED_SECTION_LABELS[sec] || sec)}</li>`)
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
    const formattedEndDate = !isPermanent && afterData.suspendedUntil ? formatDateReadable(afterData.suspendedUntil) : '';
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
        <!-- Header -->
        <div style="background:linear-gradient(135deg, ${BRAND.navy} 0%, #07335C 60%, #094D63 100%); padding:22px 24px; text-align:center; border-bottom:2px solid ${BRAND.teal};">
          <img src="${safeLogoUrl}" alt="ReSellBD" width="56" height="56" style="display:inline-block; width:56px; height:56px; border-radius:14px; object-fit:contain; background:#ffffff; padding:4px; margin-bottom:10px;" />
          <div style="font-size:22px; font-weight:900; color:#ffffff; letter-spacing:-0.4px; margin:0;">
            ReSell<span style="color:${BRAND.green};">BD</span>
          </div>
          <div style="display:inline-block; margin-top:8px; padding:4px 12px; border-radius:999px; background-color:${badgeBg}; color:#ffffff; font-size:11px; font-weight:800; letter-spacing:0.6px;">
            ${escapeHtml(badgeText)}
          </div>
        </div>

        <!-- Body -->
        <div style="padding:24px 22px;">
          <h2 style="margin:0 0 4px 0; color:#ffffff; font-size:18px; font-weight:800; line-height:1.35;">${escapeHtml(headingEn)}</h2>
          <p style="margin:0 0 18px 0; color:${BRAND.green}; font-size:13px; font-weight:700;">${escapeHtml(headingBn)}</p>
          ${bodyHtml}
        </div>

        <!-- Support & Footer -->
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

/**
 * Atomically checks 5-minute duplicate idempotency + max 3 status emails per hour
 * and records `lastStatusEmailFor` on `users/{uid}` before dispatching SMTP mail.
 */
async function claimStatusEmailSlot(db, uid, afterStatus, nowMs = Date.now()) {
  const userRef = db.collection('users').doc(uid);
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  const ONE_HOUR_MS = 60 * 60 * 1000;
  const MAX_EMAILS_PER_HOUR = 3;

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) {
      return { allowed: false, reason: 'user_missing' };
    }

    const data = snap.data() || {};
    const prevRecord = data.lastStatusEmailFor || {};
    const prevStatus = String(prevRecord.status || '').trim().toLowerCase();
    const prevSentAtMs = Number(
      prevRecord.sentAtMs ||
        (typeof prevRecord.sentAt?.toMillis === 'function' ? prevRecord.sentAt.toMillis() : 0) ||
        0
    );

    if (prevStatus === afterStatus && prevSentAtMs > 0 && nowMs - prevSentAtMs < FIVE_MINUTES_MS) {
      return { allowed: false, reason: 'duplicate_within_5m' };
    }

    const recentList = Array.isArray(prevRecord.recentSentAtMs)
      ? prevRecord.recentSentAtMs.filter((ts) => typeof ts === 'number' && nowMs - ts < ONE_HOUR_MS)
      : [];

    if (recentList.length >= MAX_EMAILS_PER_HOUR) {
      return { allowed: false, reason: 'hourly_limit_reached' };
    }

    tx.update(userRef, {
      lastStatusEmailFor: {
        status: afterStatus,
        sentAt: FieldValue.serverTimestamp(),
        sentAtMs: nowMs,
        recentSentAtMs: [...recentList, nowMs],
      },
    });

    return { allowed: true };
  });
}

module.exports = {
  escapeHtml,
  getSupportContactInfo,
  buildStatusEmailPayload,
  claimStatusEmailSlot,
};
