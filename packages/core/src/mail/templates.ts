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
/**
 * The line the inbox shows next to the subject, before anybody opens anything.
 *
 * Without one, Gmail and Apple Mail take whatever text comes first in the body — which in a
 * table-based layout is the product name again, so the preview reads "GetChat GetChat Confirm
 * your...". Hidden with the usual belt-and-braces: zero size, transparent, and pushed off-screen,
 * because no single one of those works everywhere. The trailing filler stops the client from
 * reaching past it into the real body.
 */
function preheader(text: string): string {
  return `<div style="display:none;font-size:1px;color:#f4f5f7;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(
    text,
  )}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`;
}

export function layout(
  brand: BrandContext,
  heading: string,
  bodyHtml: string,
  previewText?: string,
): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
${preheader(previewText ?? heading)}
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
If it wasn't you, you can safely ignore this email.${
    brand.supportEmail
      ? `<br>Questions? Write to <a href="mailto:${escapeHtml(brand.supportEmail)}" style="color:#6b7280;">${escapeHtml(brand.supportEmail)}</a>.`
      : ''
  }
</div>
</td></tr></table></body></html>`;
}

export function button(url: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:20px 0;"><tr>
<td style="background:#2f6fed;border-radius:8px;">
<a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
</td></tr></table>
<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">If the button doesn't work, paste this into your browser:</p>
<p style="margin:0;font-size:13px;color:#2f6fed;word-break:break-all;">${escapeHtml(url)}</p>`;
}

export const paragraph = (text: string) =>
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
    html: layout(
      brand,
      heading,
      body,
      `One click and your ${brand.productName} account is ready. The link expires in ${input.expiresInHours} hours.`,
    ),
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
    html: layout(
      brand,
      heading,
      body,
      `Choose a new password. This link expires in ${input.expiresInMinutes} minutes, and nothing has changed until you use it.`,
    ),
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
    html: layout(
      brand,
      heading,
      body,
      `Changed on ${input.when}. If it was not you, reset it now.`,
    ),
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
    html: layout(
      brand,
      heading,
      body,
      `${input.inviterName} added you to ${input.accountName}. The invitation expires in ${input.expiresInDays} days.`,
    ),
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
  previewText?: string,
): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
${preheader(previewText ?? heading)}
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
    html: ticketLayout(
      context.accountName,
      heading,
      html,
      replyFooter(context),
      `${context.accountName} has your message and will reply to this address.`,
    ),
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
    html: ticketLayout(
      context.accountName,
      heading,
      html,
      replyFooter(context),
      `${input.agentName} at ${context.accountName} replied to you.`,
    ),
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
    html: ticketLayout(
      context.accountName,
      heading,
      html,
      replyFooter(context),
      `Say so if this is not resolved and ${context.accountName} will pick it up again.`,
    ),
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
    html: layout(
      brand,
      heading,
      body,
      `"${input.subject}" from ${input.requesterName} is waiting for you.`,
    ),
    text: `Hi ${input.memberName},\n\n"${input.subject}" from ${input.requesterName} has been assigned to you.\n\nOpen it: ${input.url}`,
  };
}

// -----------------------------------------------------------------------------
// Billing email
//
// Money mail has one job: leave the reader certain what happened and what, if anything, they
// have to do. Every one of these says the amount, the plan, and the next step in the first two
// lines, and links to Stripe's own invoice page rather than reproducing it - Stripe's copy is
// the legal one, and a link cannot disagree with it.
// -----------------------------------------------------------------------------

function money(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en', {
      style: 'currency',
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function longDate(date: Date | null): string {
  if (!date) return 'the end of the current period';
  return date.toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' });
}

const intervalWord = (interval: 'month' | 'year') => (interval === 'year' ? 'yearly' : 'monthly');

export function subscriptionActivatedTemplate(
  brand: BrandContext,
  input: {
    email: string;
    name: string;
    planName: string;
    interval: 'month' | 'year';
    renewsAt: Date | null;
    reactivated?: boolean;
  },
): MailMessage {
  const heading = input.reactivated
    ? `You're back on ${input.planName}`
    : `You're on ${input.planName}`;
  const body = [
    paragraph(`Hi ${input.name},`),
    paragraph(
      input.reactivated
        ? `Your payment went through and your ${brand.productName} account is fully open again. Thank you for sorting that out.`
        : `Your ${brand.productName} subscription is active. You're on the ${input.planName} plan, billed ${intervalWord(input.interval)}, and everything it includes is switched on now.`,
    ),
    paragraph(`It renews on ${longDate(input.renewsAt)}. You can change plan, update your card or cancel from Billing at any time.`),
    button(`${brand.appUrl}/app/billing`, 'Open billing'),
  ].join('');

  return {
    to: { email: input.email, name: input.name },
    subject: `${heading} · ${brand.productName}`,
    html: layout(
      brand,
      heading,
      body,
      `${input.planName}, billed ${intervalWord(input.interval)}. Renews ${longDate(input.renewsAt)}.`,
    ),
    text: `Hi ${input.name},\n\n${
      input.reactivated
        ? `Your payment went through and your ${brand.productName} account is fully open again.`
        : `Your ${brand.productName} subscription is active: the ${input.planName} plan, billed ${intervalWord(input.interval)}.`
    }\n\nIt renews on ${longDate(input.renewsAt)}. Manage it here: ${brand.appUrl}/app/billing`,
  };
}

export function invoicePaidTemplate(
  brand: BrandContext,
  input: {
    email: string;
    name: string;
    number: string | null;
    amountCents: number;
    currency: string;
    planName: string | null;
    periodStart: Date | null;
    periodEnd: Date | null;
    hostedInvoiceUrl: string | null;
    invoicePdfUrl: string | null;
  },
): MailMessage {
  const amount = money(input.amountCents, input.currency);
  const heading = `Receipt: ${amount}`;
  const period =
    input.periodStart && input.periodEnd
      ? ` for ${longDate(input.periodStart)} to ${longDate(input.periodEnd)}`
      : '';
  const body = [
    paragraph(`Hi ${input.name},`),
    paragraph(
      `We've received ${amount} for ${input.planName ?? `your ${brand.productName} plan`}${period}.${
        input.number ? ` Invoice ${input.number}.` : ''
      }`,
    ),
    input.hostedInvoiceUrl ? button(input.hostedInvoiceUrl, 'View invoice') : '',
    input.invoicePdfUrl
      ? paragraph(`Need it as a file? Download the PDF: ${input.invoicePdfUrl}`)
      : '',
    paragraph('Nothing to do - this is just your record.'),
  ].join('');

  return {
    to: { email: input.email, name: input.name },
    subject: `Receipt for ${amount}${input.number ? ` · ${input.number}` : ''} · ${brand.productName}`,
    html: layout(brand, heading, body, `${amount} received${period}. Nothing to do.`),
    text: `Hi ${input.name},\n\nWe've received ${amount} for ${input.planName ?? `your ${brand.productName} plan`}${period}.${
      input.number ? ` Invoice ${input.number}.` : ''
    }\n\n${input.hostedInvoiceUrl ? `View the invoice: ${input.hostedInvoiceUrl}\n` : ''}${
      input.invoicePdfUrl ? `PDF: ${input.invoicePdfUrl}\n` : ''
    }\nNothing to do - this is just your record.`,
  };
}

export function paymentFailedTemplate(
  brand: BrandContext,
  input: {
    email: string;
    name: string;
    amountCents: number;
    currency: string;
    hostedInvoiceUrl: string | null;
    /** When the dashboard locks if the card is not updated. */
    graceEndsAt: Date | null;
  },
): MailMessage {
  const amount = money(input.amountCents, input.currency);
  const heading = 'Your payment did not go through';
  const deadline = input.graceEndsAt
    ? `If it isn't sorted by ${longDate(input.graceEndsAt)}, your dashboard will be locked until it is - your chat widget keeps working for your visitors either way.`
    : 'Until it is, your dashboard may be locked - your chat widget keeps working for your visitors either way.';
  const body = [
    paragraph(`Hi ${input.name},`),
    paragraph(
      `We tried to charge ${amount} for your ${brand.productName} subscription and your card was declined. This usually means the card expired, the bank blocked it, or there weren't enough funds.`,
    ),
    paragraph(`We'll try again automatically over the next few days. ${deadline}`),
    button(
      input.hostedInvoiceUrl ?? `${brand.appUrl}/app/billing`,
      input.hostedInvoiceUrl ? 'Pay now' : 'Update your card',
    ),
    paragraph(`You can also update your card from Billing: ${brand.appUrl}/app/billing`),
  ].join('');

  return {
    to: { email: input.email, name: input.name },
    subject: `Action needed: your ${brand.productName} payment failed`,
    html: layout(
      brand,
      heading,
      body,
      `${amount} was declined. Update your card${input.graceEndsAt ? ` before ${longDate(input.graceEndsAt)}` : ''}.`,
    ),
    text: `Hi ${input.name},\n\nWe tried to charge ${amount} for your ${brand.productName} subscription and your card was declined.\n\nWe'll try again over the next few days. ${deadline}\n\n${
      input.hostedInvoiceUrl ? `Pay now: ${input.hostedInvoiceUrl}\n` : ''
    }Update your card: ${brand.appUrl}/app/billing`,
  };
}

export function accountLockedTemplate(
  brand: BrandContext,
  input: { email: string; name: string; reason: 'unpaid' | 'canceled' | 'grace_expired' | 'incomplete' },
): MailMessage {
  const heading = 'Your dashboard is locked';
  const why =
    input.reason === 'canceled'
      ? 'your subscription was cancelled and the period you paid for has ended'
      : 'your subscription has not been paid';
  const body = [
    paragraph(`Hi ${input.name},`),
    paragraph(
      `Your ${brand.productName} dashboard is locked because ${why}. You can still sign in and read everything, but nothing can be changed and your team cannot reply to visitors until it's resolved.`,
    ),
    paragraph(
      'Your chat widget is still live on your website, and no conversations or settings have been removed.',
    ),
    button(`${brand.appUrl}/app/billing`, 'Fix this now'),
  ].join('');

  return {
    to: { email: input.email, name: input.name },
    subject: `Your ${brand.productName} dashboard is locked`,
    html: layout(brand, heading, body, `Locked because ${why}. Nothing has been deleted.`),
    text: `Hi ${input.name},\n\nYour ${brand.productName} dashboard is locked because ${why}. You can still sign in and read everything, but nothing can be changed until it's resolved.\n\nYour chat widget is still live, and nothing has been removed.\n\nFix it here: ${brand.appUrl}/app/billing`,
  };
}

export function subscriptionCanceledTemplate(
  brand: BrandContext,
  input: {
    email: string;
    name: string;
    planName: string;
    /** The plan the account falls back to, and whether the account still fits inside it. */
    fallbackPlanName: string;
    overLimit: boolean;
  },
): MailMessage {
  const heading = `Your ${input.planName} subscription has ended`;
  const fits = paragraph(
    `Your account is now on the ${input.fallbackPlanName} plan. Your conversations, settings and websites are all still there, and your widget keeps working for your visitors.`,
  );
  const doesNotFit = paragraph(
    `Your account is now on the ${input.fallbackPlanName} plan, and it currently has more websites or team members than that plan includes. Nothing has been deleted, and your widget keeps working for your visitors - but the dashboard stays locked until you remove the extras or choose a plan that fits.`,
  );
  const body = [
    paragraph(`Hi ${input.name},`),
    paragraph(`Your ${input.planName} subscription to ${brand.productName} has ended.`),
    input.overLimit ? doesNotFit : fits,
    button(`${brand.appUrl}/app/billing`, input.overLimit ? 'Sort out my plan' : 'See plans'),
  ].join('');

  const textTail = input.overLimit
    ? `Your account is now on the ${input.fallbackPlanName} plan and has more websites or team members than it includes. Nothing has been deleted; the dashboard stays locked until you remove the extras or choose a plan that fits.`
    : `Your account is now on the ${input.fallbackPlanName} plan. Nothing has been deleted, and your widget keeps working.`;

  return {
    to: { email: input.email, name: input.name },
    subject: `${heading} · ${brand.productName}`,
    html: layout(brand, heading, body, `Now on the ${input.fallbackPlanName} plan. Nothing has been deleted.`),
    text: `Hi ${input.name},\n\nYour ${input.planName} subscription to ${brand.productName} has ended. ${textTail}\n\nPlans: ${brand.appUrl}/app/billing`,
  };
}

/** To the operator, not the customer: somebody wants a plan that is not on the menu. */
export function billingEnquiryTemplate(
  brand: BrandContext,
  input: {
    to: string;
    accountName: string;
    accountId: string;
    fromName: string;
    fromEmail: string;
    message: string;
    wants: Record<string, unknown>;
  },
): MailMessage {
  const heading = `Custom plan enquiry from ${input.accountName}`;
  const wants = Object.entries(input.wants)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(', ');
  const body = [
    paragraph(`${input.fromName} (${input.fromEmail}) from ${input.accountName} asked about a custom plan.`),
    wants ? paragraph(`They want: ${wants}.`) : '',
    paragraph('Their message:'),
    `<div style="margin:0 0 18px;padding:12px 16px;border-left:3px solid #d5d9e0;background:#f7f8fa;font-size:15px;line-height:1.6;color:#3c4149;">${escapeHtml(input.message).replace(/\n/g, '<br>')}</div>`,
    paragraph(`Account id ${input.accountId}. Reply to this email to reach them.`),
  ].join('');

  return {
    to: { email: input.to },
    replyTo: { email: input.fromEmail, name: input.fromName },
    subject: `Custom plan enquiry · ${input.accountName}`,
    html: layout(brand, heading, body, `${input.fromName} wants a custom plan.${wants ? ` ${wants}.` : ''}`),
    text: `${input.fromName} (${input.fromEmail}) from ${input.accountName} asked about a custom plan.\n${
      wants ? `\nThey want: ${wants}.\n` : ''
    }\n${input.message}\n\nAccount id ${input.accountId}. Reply to this email to reach them.`,
  };
}
