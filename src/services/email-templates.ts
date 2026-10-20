import type { Mail } from './mailer.js';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * One branded, accessible email layout for every transactional message.
 * Plain-text alternative included. Inline styles only (email clients ignore <style>).
 */
export function emailTemplate(m: { to: string; subject: string; heading: string; body: string[]; action?: { label: string; url: string }; footnote?: string }): Mail {
  const text = [m.heading, '', ...m.body, ...(m.action ? ['', `${m.action.label}: ${m.action.url}`] : []), ...(m.footnote ? ['', m.footnote] : []), '', '— REWIND'].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#0e0f11;padding:32px 16px;font-family:Inter,Segoe UI,Helvetica,Arial,sans-serif;color:#ececee">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#15161a;border:1px solid #2a2b31;border-radius:14px" cellpadding="0" cellspacing="0">
<tr><td style="padding:28px 28px 0"><div style="font-weight:700;letter-spacing:.22em;font-size:13px;color:#ececee">REWIND</div>
<div style="height:3px;width:56px;margin-top:10px;border-radius:3px;background:linear-gradient(90deg,#818cf8,#22d3ee)"></div></td></tr>
<tr><td style="padding:24px 28px 8px"><h1 style="margin:0 0 12px;font-size:20px;line-height:1.3;color:#ffffff">${esc(m.heading)}</h1>
${m.body.map((p) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;color:#a9a9b1">${esc(p)}</p>`).join('')}
${m.action ? `<p style="margin:20px 0 8px"><a href="${esc(m.action.url)}" style="display:inline-block;background:#ececee;color:#0e0f11;text-decoration:none;font-weight:600;font-size:14px;padding:11px 18px;border-radius:10px">${esc(m.action.label)}</a></p><p style="margin:12px 0 0;font-size:12px;color:#74747c;word-break:break-all">Or paste this link into your browser:<br>${esc(m.action.url)}</p>` : ''}
</td></tr>
<tr><td style="padding:16px 28px 28px;font-size:12px;color:#74747c;border-top:1px solid #2a2b31">${esc(m.footnote ?? "You're receiving this because of activity on your REWIND account.")}</td></tr>
</table></td></tr></table></body></html>`;
  return { to: m.to, subject: m.subject, text, html };
}
