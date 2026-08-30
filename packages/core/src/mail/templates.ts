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

// -----------------------------------------------------------------------------
// Ticket email
//
// These are the only messages this product sends to somebody who is not its user. They go to a
// customer's customer, so they carry the *account's* name rather than ours, and the footer says
// plainly whether replying will reach anybody.
// -----------------------------------------------------------------------------

function ticketLayout(
  senderName: string,
  heading: string,
  bodyHtml: string,
  footerText: string,
): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e4e6eb;overflow:hidden;">
<tr><td style="padding:28px 32px 8px;">
<div style="font-size:18px;font-weight:700;color:#1a1d23;letter-spacing:-0.01em;">${escapeHtml(senderName)}</div>
</td></tr>
<tr><td style="padding:8px 32px 32px;">
<h1 style="margin:12px 0 16px;font-size:22px;line-height:1.3;color:#1a1d23;font-weight:650;">${escapeHtml(heading)}</h1>
${bodyHtml}
</td></tr>
</table>
<div style="max-width:560px;margin:16px auto 0;font-size:12px;line-height:1.6;color:#6b7280;text-align:center;">
${escapeHtml(footerText)}
</div>
</td></tr></table></body></html>`;
}

/**
 * Somebody's own words, quoted back to them.
 *
 * Escaped and then given line breaks - the order that matters everywhere else in this codebase.
 * A quoted block, so it is visibly *their* text rather than ours.
 */
function quote(text: string): string {
  const html = escapeHtml(text).replace(/\n/g, '<br>');
  return `<div style="margin:0 0 18px;padding:12px 16px;border-left:3px solid #d5d9e0;background:#f7f8fa;font-size:15px;line-height:1.6;color:#3c4149;white-space:normal;">${html}</div>`;
}

/** The reply itself, presented as the message rather than as a quotation. */
function passage(text: string): string {
  const html = escapeHtml(text).replace(/\n/g, '<br>');
  return `<div style="margin:0 0 18px;font-size:15px;line-height:1.6;color:#3c4149;">${html}</div>`;
}

export interface TicketMailContext {
  /** The account's name. What the recipient will recognise; ours is not on the envelope. */
  accountName: string;
  ticketNumber: number;
  subject: string;
  requesterEmail: string;
  requesterName?: string | null;
  /** The customer's own mailbox, when they have configured one. */
  supportEmail?: string | null;
}

/**
 * The footer, and the whole reason `supportEmail` exists.
 *
 * SmartChat does not receive mail. If we set a `Reply-To` pointing at ourselves, every reply a
 * customer writes would vanish, which is worse than telling them not to write one. So the footer
 * says which it is, and the header below only sets `Reply-To` when there is a real mailbox behind
 * it.
 */
function replyFooter(context: TicketMailContext): string {
  return context.supportEmail
    ? `Reply to this email to reach ${context.accountName} at ${context.supportEmail}. Ticket #${context.ticketNumber}.`
    : `This mailbox is not monitored - please use the contact form on ${context.accountName}'s website. Ticket #${context.ticketNumber}.`;
}

function replyHeaders(context: TicketMailContext): Pick<MailMessage, 'replyTo' | 'headers'> {
  return {
    ...(context.supportEmail
      ? { replyTo: { email: context.supportEmail, name: context.accountName } }
      : {}),
    headers: { 'X-SmartChat-Ticket': String(context.ticketNumber) },
  };
}

const greeting = (name?: string | null) => (name ? `Hi ${name},` : 'Hi,');

export function ticketReceivedTemplate(context: TicketMailContext, body: string): MailMessage {
  const heading = `We have your message (#${context.ticketNumber})`;
  const html = [
    paragraph(greeting(context.requesterName)),
    paragraph(
      `Thanks for getting in touch with ${context.accountName}. Somebody will read this and reply to you at this address.`,
    ),
    paragraph('This is what we received:'),
    quote(body),
  ].join('');

  return {
    to: {
      email: context.requesterEmail,
      ...(context.requesterName ? { name: context.requesterName } : {}),
    },
    subject: `[#${context.ticketNumber}] ${context.subject}`,
    html: ticketLayout(context.accountName, heading, html, replyFooter(context)),
    text: `${greeting(context.requesterName)}\n\nThanks for getting in touch with ${context.accountName}. Somebody will read this and reply to you at this address.\n\nThis is what we received:\n\n${body}\n\n${replyFooter(context)}`,
    ...replyHeaders(context),
  };
}

export function ticketReplyTemplate(
  context: TicketMailContext,
  input: { reply: string; agentName: string },
): MailMessage {
  const heading = `Re: ${context.subject}`;
  const html = [
    paragraph(greeting(context.requesterName)),
    passage(input.reply),
    paragraph(`— ${input.agentName}, ${context.accountName}`),
  ].join('');

  return {
    to: {
      email: context.requesterEmail,
      ...(context.requesterName ? { name: context.requesterName } : {}),
    },
    subject: `[#${context.ticketNumber}] ${context.subject}`,
    html: ticketLayout(context.accountName, heading, html, replyFooter(context)),
    text: `${greeting(context.requesterName)}\n\n${input.reply}\n\n- ${input.agentName}, ${context.accountName}\n\n${replyFooter(context)}`,
    ...replyHeaders(context),
  };
}

export function ticketResolvedTemplate(context: TicketMailContext): MailMessage {
  const heading = `We think this one is done (#${context.ticketNumber})`;
  const html = [
    paragraph(greeting(context.requesterName)),
    paragraph(
      `We have marked "${context.subject}" as resolved. If that is not right, say so and we will pick it up again - a resolved ticket is not a closed door.`,
    ),
  ].join('');

  return {
    to: {
      email: context.requesterEmail,
      ...(context.requesterName ? { name: context.requesterName } : {}),
    },
    subject: `[#${context.ticketNumber}] ${context.subject}`,
    html: ticketLayout(context.accountName, heading, html, replyFooter(context)),
    text: `${greeting(context.requesterName)}\n\nWe have marked "${context.subject}" as resolved. If that is not right, say so and we will pick it up again.\n\n${replyFooter(context)}`,
    ...replyHeaders(context),
  };
}

/**
 * To an agent, about work that is now theirs.
 *
 * This one uses the product's own shell, because the recipient is a user of this product and the
 * link goes into this product. It deliberately carries the subject and the requester but not the
 * message body: a notification that reproduces customer data in a mailbox we do not control is a
 * copy of that data in a place nobody is auditing.
 */
export function ticketAssignedTemplate(
  brand: BrandContext,
  input: {
    memberEmail: string;
    memberName: string;
    ticketNumber: number;
    subject: string;
    requesterName: string;
    url: string;
  },
): MailMessage {
  const heading = `Ticket #${input.ticketNumber} is yours`;
  const body = [
    paragraph(`Hi ${input.memberName},`),
    paragraph(`"${input.subject}" — from ${input.requesterName} — has been assigned to you.`),
    button(input.url, 'Open the ticket'),
  ].join('');

  return {
    to: { email: input.memberEmail, name: input.memberName },
    subject: `Ticket #${input.ticketNumber} assigned to you · ${brand.productName}`,
    html: layout(brand, heading, body),
    text: `Hi ${input.memberName},\n\n"${input.subject}" from ${input.requesterName} has been assigned to you.\n\nOpen it: ${input.url}`,
  };
}
