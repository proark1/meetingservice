const { Resend } = require('resend');
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const APP_URL = process.env.APP_URL || 'https://meetingservice-production.up.railway.app';
const FROM    = 'onepizza.io <noreply@onepizza.io>';

if (!process.env.RESEND_API_KEY) console.warn('[email] RESEND_API_KEY not set — transactional emails disabled');

/** HTML-escape a string to prevent XSS in email templates */
function esc(s) { return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) return; // silently skip in dev
  try {
    return await resend.emails.send({ from: FROM, to, subject, html });
  } catch (err) {
    console.error('Email send error:', err.message);
  }
}

function passwordResetEmail(resetToken) {
  const url = `${APP_URL}/reset?token=${encodeURIComponent(resetToken)}`;
  return `<div style="font-family:Inter,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;background:#f8fafc">
  <div style="background:#fff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 4px 16px rgba(15,23,42,.08)">
    <div style="display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;margin-bottom:28px;color:#0f172a">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4361ee" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
      onepizza.io
    </div>
    <h1 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 8px">Reset your password</h1>
    <p style="font-size:14px;color:#64748b;margin:0 0 24px;line-height:1.6">We received a request to reset your onepizza.io password. Click the button below — this link expires in <strong>1 hour</strong>.</p>
    <a href="${esc(url)}" style="display:block;text-align:center;background:#4361ee;color:#fff;padding:13px 24px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none">Reset Password →</a>
    <p style="font-size:12px;color:#94a3b8;margin:20px 0 0;line-height:1.6">If you didn't request this, you can safely ignore this email. The link expires in 1 hour and your password won't change.</p>
  </div>
</div>`;
}

function lowBalanceEmail(balance, _email) {
  const url = `${APP_URL}/dashboard`;
  return `<div style="font-family:Inter,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;background:#f8fafc">
  <div style="background:#fff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 4px 16px rgba(15,23,42,.08)">
    <div style="display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;margin-bottom:28px;color:#0f172a">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4361ee" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
      onepizza.io
    </div>
    <h1 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 8px">Low balance alert</h1>
    <p style="font-size:14px;color:#64748b;margin:0 0 16px;line-height:1.6">Your onepizza.io balance has dropped below $2.00. You currently have <strong style="color:#0f172a">$${parseFloat(balance).toFixed(2)}</strong> remaining.</p>
    <p style="font-size:14px;color:#64748b;margin:0 0 24px;line-height:1.6">Top up now to make sure your meetings keep running without interruption.</p>
    <a href="${url}" style="display:block;text-align:center;background:#4361ee;color:#fff;padding:13px 24px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none">Top Up Credits →</a>
  </div>
</div>`;
}

function welcomeEmail(_email, apiKey) {
  const safeKey = esc(apiKey);
  return `<div style="font-family:Inter,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;background:#f8fafc">
  <div style="background:#fff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 4px 16px rgba(15,23,42,.08)">
    <div style="display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;margin-bottom:28px;color:#0f172a">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4361ee" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
      onepizza.io
    </div>
    <h1 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 8px">Welcome to onepizza.io!</h1>
    <p style="font-size:14px;color:#64748b;margin:0 0 16px;line-height:1.6">Your account is ready — here's your API key. Save it somewhere safe, it won't be shown again.</p>
    <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;font-family:monospace;font-size:13px;word-break:break-all;margin:0 0 20px;color:#0f172a">${safeKey}</div>
    <p style="font-size:13px;font-weight:600;color:#0f172a;margin:0 0 8px">Quick start:</p>
    <pre style="background:#0f172a;color:#e2e8f0;border-radius:8px;padding:14px;font-size:12px;overflow-x:auto;margin:0 0 20px">curl -X POST ${APP_URL}/api/meetings \\
  -H "x-api-key: ${safeKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"My First Meeting"}'</pre>
    <a href="${APP_URL}/dashboard" style="display:block;text-align:center;background:#4361ee;color:#fff;padding:13px 24px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none">Go to Dashboard →</a>
  </div>
</div>`;
}

function passwordChangedEmail(email) {
  return `<div style="font-family:Inter,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;background:#f8fafc">
  <div style="background:#fff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 4px 16px rgba(15,23,42,.08)">
    <div style="display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;margin-bottom:28px;color:#0f172a">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4361ee" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
      onepizza.io
    </div>
    <h1 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 8px">Password changed</h1>
    <p style="font-size:14px;color:#64748b;margin:0 0 24px;line-height:1.6">Your onepizza.io password was just changed. If you made this change, you're all set.</p>
    <p style="font-size:14px;color:#64748b;margin:0 0 24px;line-height:1.6">If you <strong>didn't</strong> change your password, your account may be compromised. Reset it immediately:</p>
    <a href="${APP_URL}/reset" style="display:block;text-align:center;background:#ef4444;color:#fff;padding:13px 24px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none">Secure my account →</a>
    <p style="font-size:12px;color:#94a3b8;margin:20px 0 0;line-height:1.6">This email was sent to ${esc(email)}.</p>
  </div>
</div>`;
}

function companyInviteEmail({ to, companyName, inviteCode }) {
  const safeName = esc(companyName);
  const safeCode = esc(inviteCode);
  return `<div style="font-family:Inter,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;background:#f8fafc">
  <div style="background:#fff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 4px 16px rgba(15,23,42,.08)">
    <div style="display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;margin-bottom:28px;color:#0f172a">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4361ee" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
      onepizza.io
    </div>
    <h1 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 8px">You've been invited to ${safeName}</h1>
    <p style="font-size:14px;color:#64748b;margin:0 0 24px;line-height:1.6">Use the invite code below to join the <strong>${safeName}</strong> workspace on onepizza.io. You'll share their credit balance and API keys.</p>
    <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:16px;text-align:center;font-family:monospace;font-size:22px;font-weight:700;color:#4361ee;letter-spacing:0.1em;margin:0 0 24px">${safeCode}</div>
    <a href="${APP_URL}/dashboard" style="display:block;text-align:center;background:#4361ee;color:#fff;padding:13px 24px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none">Join ${safeName} →</a>
    <p style="font-size:12px;color:#94a3b8;margin:20px 0 0;line-height:1.6">Sign in to your dashboard, go to Company, and enter this code.</p>
  </div>
</div>`;
}

function meetingReceiptEmail({ to, meetingId, title, durationMinutes, cost }) {
  const safeTitle = esc(title || meetingId);
  return `<div style="font-family:Inter,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;background:#f8fafc">
  <div style="background:#fff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 4px 16px rgba(15,23,42,.08)">
    <div style="display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;margin-bottom:28px;color:#0f172a">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4361ee" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
      onepizza.io
    </div>
    <h1 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 8px">Meeting receipt</h1>
    <p style="font-size:14px;color:#64748b;margin:0 0 20px;line-height:1.6">Your meeting has ended. Here's the usage summary:</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 24px">
      <tr><td style="padding:10px 0;font-size:13px;color:#64748b;border-bottom:1px solid #e2e8f0;">Meeting</td><td style="padding:10px 0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;border-bottom:1px solid #e2e8f0;">${safeTitle}</td></tr>
      <tr><td style="padding:10px 0;font-size:13px;color:#64748b;border-bottom:1px solid #e2e8f0;">Duration</td><td style="padding:10px 0;font-size:13px;font-weight:600;color:#0f172a;text-align:right;border-bottom:1px solid #e2e8f0;">${parseFloat(durationMinutes).toFixed(1)} minutes</td></tr>
      <tr><td style="padding:10px 0;font-size:14px;font-weight:700;color:#0f172a;">Credits charged</td><td style="padding:10px 0;font-size:14px;font-weight:800;color:#ef4444;text-align:right;">$${parseFloat(cost).toFixed(4)}</td></tr>
    </table>
    <a href="${APP_URL}/dashboard" style="display:block;text-align:center;background:#4361ee;color:#fff;padding:13px 24px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none">View billing history →</a>
  </div>
</div>`;
}

module.exports = { sendEmail, passwordResetEmail, lowBalanceEmail, welcomeEmail, passwordChangedEmail, companyInviteEmail, meetingReceiptEmail };
