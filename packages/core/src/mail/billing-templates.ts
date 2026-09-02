import type { MailMessage } from './provider.js';
import { layout, paragraph, button, type BrandContext } from './templates.js';

/**
 * Billing email.
 *
 * These go to the account's own people rather than to a customer's customer, so unlike the ticket
 * templates they carry *our* branding: the recipient is our customer and the message is about
 * their relationship with us.
 *
 * Every one of them says what will happen and when, in the subject line. "Your subscription" as a
 * subject makes somebody open an email to find out whether they need to act; "Your SmartChat
 * account becomes read-only on 14 March" does not.
 */

/** Money, as a person reads it. Cents in, "£29.00" out. */
export function formatMoney(cents: number, currency: string): string {
  const amount = (cents / 100).toFixed(2);
  const symbols: Record<string, string> = { USD: '$', EUR: '€', GBP: '£' };
  const symbol = symbols[currency.toUpperCase()];
  return symbol ? `${symbol}${amount}` : `${amount} ${currency.toUpperCase()}`;
}

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function planChangeRequestedTemplate(
  brand: BrandContext,
  input: { email: string; accountName: string; toPlanName: string; interval: string },
): MailMessage {
  const heading = `We have your request to move to ${input.toPlanName}`;
  const body = [
    paragraph(
      `Somebody on ${input.accountName} asked to move to ${input.toPlanName}, billed ${input.interval}.`,
    ),
    paragraph(
      'We will confirm it by email once it is set up. Nothing changes on your account until then, ' +
        'and you can withdraw the request from your billing settings at any point before that.',
    ),
    button(`${brand.appUrl}/app/settings/billing`, 'View billing settings'),
  ].join('');

  return {
    to: { email: input.email },
    subject: `Your request to move to ${input.toPlanName}`,
    html: layout(brand, heading, body),
    text:
      `Somebody on ${input.accountName} asked to move to ${input.toPlanName}, billed ${input.interval}.\n\n` +
      `We will confirm by email once it is set up. Nothing changes until then, and you can withdraw ` +
      `the request from your billing settings:\n${brand.appUrl}/app/settings/billing`,
  };
}

export function planChangeApprovedTemplate(
  brand: BrandContext,
  input: { email: string; accountName: string; planName: string },
): MailMessage {
  const heading = `${input.accountName} is now on ${input.planName}`;
  const body = [
    paragraph(`Your plan change is done. ${input.accountName} is on ${input.planName} from today.`),
    paragraph('Your new limits are already in effect - there is nothing else to do.'),
    button(`${brand.appUrl}/app/settings/billing`, 'View your plan'),
  ].join('');

  return {
    to: { email: input.email },
    subject: `You are now on ${input.planName}`,
    html: layout(brand, heading, body),
    text: `Your plan change is done. ${input.accountName} is on ${input.planName} from today.\n\n${brand.appUrl}/app/settings/billing`,
  };
}

export function planChangeRejectedTemplate(
  brand: BrandContext,
  input: { email: string; planName: string; note: string | null },
): MailMessage {
  const heading = `About your request to move to ${input.planName}`;
  const body = [
    paragraph(`We were not able to move you to ${input.planName}.`),
    // The reason, when there is one. An unexplained refusal is a support ticket waiting to happen.
    ...(input.note ? [paragraph(input.note)] : []),
    paragraph(`Reply to this email and we will sort it out.`),
  ].join('');

  return {
    to: { email: input.email },
    subject: `Your request to move to ${input.planName}`,
    html: layout(brand, heading, body),
    text:
      `We were not able to move you to ${input.planName}.` +
      (input.note ? `\n\n${input.note}` : '') +
      `\n\nReply to this email and we will sort it out.`,
  };
}

export function invoiceIssuedTemplate(
  brand: BrandContext,
  input: {
    email: string;
    accountName: string;
    number: number;
    planName: string;
    amountCents: number;
    currency: string;
    periodStart: Date;
    periodEnd: Date;
    dueBy: Date;
  },
): MailMessage {
  const amount = formatMoney(input.amountCents, input.currency);
  const heading = `Invoice ${input.number} — ${amount}`;
  const body = [
    paragraph(
      `${input.planName} for ${input.accountName}, covering ` +
        `${formatDate(input.periodStart)} to ${formatDate(input.periodEnd)}.`,
    ),
    paragraph(`Amount due: ${amount}. Please settle by ${formatDate(input.dueBy)}.`),
    // Said plainly, because it is the question somebody actually has when an invoice arrives.
    paragraph(
      'Your service continues as normal in the meantime. If the invoice is still unpaid after ' +
        `${formatDate(input.dueBy)}, the account becomes read-only - your data is never deleted, ` +
        'and paying restores everything immediately.',
    ),
    button(`${brand.appUrl}/app/settings/billing`, 'View invoices'),
  ].join('');

  return {
    to: { email: input.email },
    subject: `Invoice ${input.number} for ${input.accountName} — ${amount}`,
    html: layout(brand, heading, body),
    text:
      `Invoice ${input.number}: ${amount}\n` +
      `${input.planName}, ${formatDate(input.periodStart)} to ${formatDate(input.periodEnd)}.\n\n` +
      `Please settle by ${formatDate(input.dueBy)}. Your service continues in the meantime; if it ` +
      `is still unpaid after that date the account becomes read-only. Nothing is ever deleted.\n\n` +
      `${brand.appUrl}/app/settings/billing`,
  };
}

export function trialEndingTemplate(
  brand: BrandContext,
  input: { email: string; accountName: string; endsAt: Date; planName: string },
): MailMessage {
  const heading = `Your trial ends on ${formatDate(input.endsAt)}`;
  const body = [
    paragraph(
      `${input.accountName}'s trial ends on ${formatDate(input.endsAt)}, and the account moves to ` +
        `${input.planName}.`,
    ),
    paragraph('Choose a plan before then if you want something different. Nothing is lost either way.'),
    button(`${brand.appUrl}/app/settings/billing`, 'Choose a plan'),
  ].join('');

  return {
    to: { email: input.email },
    subject: `${input.accountName}'s trial ends on ${formatDate(input.endsAt)}`,
    html: layout(brand, heading, body),
    text:
      `${input.accountName}'s trial ends on ${formatDate(input.endsAt)} and moves to ${input.planName}.\n\n` +
      `Choose a plan before then if you want something different:\n${brand.appUrl}/app/settings/billing`,
  };
}

export function subscriptionPausedTemplate(
  brand: BrandContext,
  input: { email: string; accountName: string },
): MailMessage {
  const heading = `${input.accountName} is now read-only`;
  const body = [
    paragraph(
      `${input.accountName} has been set to read-only because the subscription is not active.`,
    ),
    // The most important sentence in the whole set. Somebody reading this is worried about exactly
    // one thing, and the answer is in the first line rather than three paragraphs down.
    paragraph(
      '<strong>Nothing has been deleted.</strong> Every conversation, ticket, article and file is ' +
        'still there and still readable. Your chat widget has stopped taking new conversations, ' +
        'and your team can read but not write.',
    ),
    paragraph('Settling the outstanding invoice restores everything immediately.'),
    button(`${brand.appUrl}/app/settings/billing`, 'View billing'),
  ].join('');

  return {
    to: { email: input.email },
    subject: `${input.accountName} is now read-only`,
    html: layout(brand, heading, body),
    text:
      `${input.accountName} has been set to read-only because the subscription is not active.\n\n` +
      `Nothing has been deleted. Every conversation, ticket, article and file is still there and ` +
      `readable. The widget has stopped taking new conversations and your team can read but not ` +
      `write. Settling the outstanding invoice restores everything immediately.\n\n` +
      `${brand.appUrl}/app/settings/billing`,
  };
}
