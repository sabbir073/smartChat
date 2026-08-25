import type { MailMessage } from './provider.js';

export interface BrandContext {
  productName: string;
  appUrl: string;
  supportEmail?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A single shell for every transactional email.
 *
 * Table-based layout with inline styles, because email clients remain the least capable rendering
 * targets we ship to — flexbox and external stylesheets are not reliable there.
 */
function layout(brand: BrandContext, heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e4e6eb;overflow:hidden;">
<tr><td style="padding:28px 32px 8px;">
<div style="font-size:18px;font-weight:700;color:#1a1d23;letter-spacing:-0.01em;">${escapeHtml(brand.productName)}</div>
</td></tr>
<tr><td style="padding:8px 32px 32px;">
<h1 style="margin:12px 0 16px;font-size:22px;line-height:1.3;color:#1a1d23;font-weight:650;">${escapeHtml(heading)}</h1>
${bodyHtml}
</td></tr>
</table>
<div style="max-width:560px;margin:16px auto 0;font-size:12px;line-height:1.6;color:#6b7280;text-align:center;">
You received this because someone used this address at ${escapeHtml(brand.appUrl)}.<br>
If it wasn't you, you can safely ignore this email.
</div>
</td></tr></table></body></html>`;
}

function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr>
<td style="background:#2f6fed;border-radius:8px;">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
</td></tr></table>
<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">If the button doesn't work, paste this into your browser:</p>
<p style="margin:0;font-size:13px;color:#2f6fed;word-break:break-all;">${escapeHtml(url)}</p>`;
}

const paragraph = (text: string) =>
  `<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:#3c4149;">${escapeHtml(text)}</p>`;

export function verifyEmailTemplate(
  brand: BrandContext,
  input: { name: string; email: string; url: string; expiresInHours: number },
): MailMessage {
  const heading = 'Confirm your email address';
  const body = [
    paragraph(`Hi ${input.name}, welcome to ${brand.productName}.`),
    paragraph('Confirm this address to finish setting up your account.'),
    button(input.url, 'Confirm email address'),
    paragraph(`This link expires in ${input.expiresInHours} hours and can only be used once.`),
  ].join('');

  return {
    to: { email: input.email, name: input.name },
    subject: `Confirm your email address · ${brand.productName}`,
    html: layout(brand, heading, body),
    text: `Hi ${input.name},\n\nConfirm your email address to finish setting up your ${brand.productName} account:\n\n${input.url}\n\nThis link expires in ${input.expiresInHours} hours and can only be used once.\n\nIf you didn't create an account, you can ignore this email.`,
  };
}

export function passwordResetTemplate(
  brand: BrandContext,
  input: { name: string; email: string; url: string; expiresInMinutes: number },
): MailMessage {
  const heading = 'Reset your password';
  const body = [
    paragraph(`Hi ${input.name}, we received a request to reset your password.`),
    button(input.url, 'Choose a new password'),
    paragraph(
      `This link expires in ${input.expiresInMinutes} minutes and can only be used once. If you didn't request it, nothing has changed and you can ignore this email.`,
    ),
  ].join('');

  return {
    to: { email: input.email, name: input.name },
    subject: `Reset your password · ${brand.productName}`,
    html: layout(brand, heading, body),
    text: `Hi ${input.name},\n\nUse this link to choose a new password:\n\n${input.url}\n\nIt expires in ${input.expiresInMinutes} minutes and can only be used once.\n\nIf you didn't request this, nothing has changed.`,
  };
}

export function passwordChangedTemplate(
  brand: BrandContext,
  input: { name: string; email: string; when: string },
): MailMessage {
  const heading = 'Your password was changed';
  const body = [
    paragraph(`Hi ${input.name},`),
    paragraph(`Your ${brand.productName} password was changed on ${input.when}.`),
    paragraph(
      'Every other signed-in session was signed out. If this was not you, reset your password immediately.',
    ),
    button(`${brand.appUrl}/forgot-password`, 'Reset your password'),
  ].join('');

  return {
    to: { email: input.email, name: input.name },
    subject: `Your password was changed · ${brand.productName}`,
    html: layout(brand, heading, body),
    text: `Hi ${input.name},\n\nYour ${brand.productName} password was changed on ${input.when}. All other sessions were signed out.\n\nIf this was not you, reset your password now: ${brand.appUrl}/forgot-password`,
  };
}

export function invitationTemplate(
  brand: BrandContext,
  input: {
    email: string;
    inviterName: string;
    accountName: string;
    url: string;
    expiresInDays: number;
  },
): MailMessage {
  const heading = `Join ${input.accountName} on ${brand.productName}`;
  const body = [
    paragraph(`${input.inviterName} invited you to join ${input.accountName}.`),
    button(input.url, 'Accept invitation'),
    paragraph(`This invitation expires in ${input.expiresInDays} days.`),
  ].join('');

  return {
    to: { email: input.email },
    subject: `${input.inviterName} invited you to ${input.accountName}`,
    html: layout(brand, heading, body),
    text: `${input.inviterName} invited you to join ${input.accountName} on ${brand.productName}.\n\nAccept the invitation:\n${input.url}\n\nThis invitation expires in ${input.expiresInDays} days.`,
  };
}
