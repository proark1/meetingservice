const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
const APP_URL = process.env.APP_URL || 'https://meetingservice-production.up.railway.app';
const FROM    = 'MeetingService <noreply@meetingservice.app>';

async function sendEmail({ to, subject, html }) {
  if (!process.env.RESEND_API_KEY) return; // silently skip in dev
  try {
    return await resend.emails.send({ from: FROM, to, subject, html });
  } catch (err) {
    console.error('Email send error:', err.message);
  }
}

function passwordResetEmail(resetToken) {
  const url = `${APP_URL}/reset?token=${resetToken}`;
  return `<div style="font-family:Inter,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;background:#f8fafc">
  <div style="background:#fff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 4px 16px rgba(15,23,42,.08)">
    <div style="display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;margin-bottom:28px;color:#0f172a">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4361ee" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
      MeetingService
    </div>
    <h1 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 8px">Reset your password</h1>
    <p style="font-size:14px;color:#64748b;margin:0 0 24px;line-height:1.6">We received a request to reset your MeetingService password. Click the button below — this link expires in <strong>1 hour</strong>.</p>
    <a href="${url}" style="display:block;text-align:center;background:#4361ee;color:#fff;padding:13px 24px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none">Reset Password →</a>
    <p style="font-size:12px;color:#94a3b8;margin:20px 0 0;line-height:1.6">If you didn't request this, you can safely ignore this email. The link expires in 1 hour and your password won't change.</p>
  </div>
</div>`;
}

function lowBalanceEmail(balance, email) {
  const url = `${APP_URL}/dashboard`;
  return `<div style="font-family:Inter,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;background:#f8fafc">
  <div style="background:#fff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 4px 16px rgba(15,23,42,.08)">
    <div style="display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;margin-bottom:28px;color:#0f172a">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4361ee" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
      MeetingService
    </div>
    <h1 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 8px">Low balance alert</h1>
    <p style="font-size:14px;color:#64748b;margin:0 0 16px;line-height:1.6">Your MeetingService balance has dropped below $2.00. You currently have <strong style="color:#0f172a">$${parseFloat(balance).toFixed(2)}</strong> remaining.</p>
    <p style="font-size:14px;color:#64748b;margin:0 0 24px;line-height:1.6">Top up now to make sure your meetings keep running without interruption.</p>
    <a href="${url}" style="display:block;text-align:center;background:#4361ee;color:#fff;padding:13px 24px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none">Top Up Credits →</a>
  </div>
</div>`;
}

function welcomeEmail(email, apiKey) {
  return `<div style="font-family:Inter,-apple-system,sans-serif;max-width:480px;margin:0 auto;padding:32px 20px;background:#f8fafc">
  <div style="background:#fff;border-radius:12px;padding:36px;border:1px solid #e2e8f0;box-shadow:0 4px 16px rgba(15,23,42,.08)">
    <div style="display:flex;align-items:center;gap:8px;font-weight:800;font-size:17px;margin-bottom:28px;color:#0f172a">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#4361ee" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
      MeetingService
    </div>
    <h1 style="font-size:20px;font-weight:800;color:#0f172a;margin:0 0 8px">Welcome to MeetingService! 🎉</h1>
    <p style="font-size:14px;color:#64748b;margin:0 0 16px;line-height:1.6">Your account is ready — here's your API key. Save it somewhere safe, it won't be shown again.</p>
    <div style="background:#f1f5f9;border:1px solid #e2e8f0;border-radius:8px;padding:12px 16px;font-family:monospace;font-size:13px;word-break:break-all;margin:0 0 20px;color:#0f172a">${apiKey}</div>
    <p style="font-size:13px;font-weight:600;color:#0f172a;margin:0 0 8px">Quick start:</p>
    <pre style="background:#0f172a;color:#e2e8f0;border-radius:8px;padding:14px;font-size:12px;overflow-x:auto;margin:0 0 20px">curl -X POST ${APP_URL}/api/meetings \\
  -H "x-api-key: ${apiKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"title":"My First Meeting"}'</pre>
    <a href="${APP_URL}/dashboard" style="display:block;text-align:center;background:#4361ee;color:#fff;padding:13px 24px;border-radius:8px;font-weight:700;font-size:15px;text-decoration:none">Go to Dashboard →</a>
  </div>
</div>`;
}

module.exports = { sendEmail, passwordResetEmail, lowBalanceEmail, welcomeEmail };
