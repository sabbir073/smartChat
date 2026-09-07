import { describe, expect, it } from 'vitest';
import type { MailMessage } from './provider.js';
import {
  invitationTemplate,
  passwordChangedTemplate,
  passwordResetTemplate,
  ticketAssignedTemplate,
  ticketReceivedTemplate,
  ticketReplyTemplate,
  ticketResolvedTemplate,
  verifyEmailTemplate,
  type BrandContext,
  type TicketMailContext,
} from './templates.js';

const brand: BrandContext = {
  productName: 'GetChat',
  appUrl: 'https://getchat.site',
  supportEmail: 'no-reply@getchat.site',
};

const ticket: TicketMailContext = {
  accountName: 'Northwind',
  ticketNumber: 41,
  subject: 'Where is my order',
  requesterEmail: 'ada@example.com',
  requesterName: 'Ada',
  supportEmail: 'help@northwind.test',
};

/**
 * Every message this product sends, built once so the shared rules below can be asserted against
 * all of them rather than remembered for each. A template added without a line here is a template
 * nothing checks.
 */
const everyMessage: Array<[string, MailMessage]> = [
  [
    'verifyEmail',
    verifyEmailTemplate(brand, {
      name: 'Ada',
      email: 'ada@example.com',
      url: 'https://getchat.site/verify?token=abc',
      expiresInHours: 24,
    }),
  ],
  [
    'passwordReset',
    passwordResetTemplate(brand, {
      name: 'Ada',
      email: 'ada@example.com',
      url: 'https://getchat.site/reset?token=abc',
      expiresInMinutes: 60,
    }),
  ],
  [
    'passwordChanged',
    passwordChangedTemplate(brand, {
      name: 'Ada',
      email: 'ada@example.com',
      when: '7 September 2026 at 11:04 UTC',
    }),
  ],
  [
    'invitation',
    invitationTemplate(brand, {
      email: 'ada@example.com',
      inviterName: 'Grace',
      accountName: 'Northwind',
      url: 'https://getchat.site/invite?token=abc',
      expiresInDays: 7,
    }),
  ],
  ['ticketReceived', ticketReceivedTemplate(ticket, 'It never arrived.')],
  ['ticketReply', ticketReplyTemplate(ticket, { reply: 'On its way.', agentName: 'Grace' })],
  ['ticketResolved', ticketResolvedTemplate(ticket)],
  [
    'ticketAssigned',
    ticketAssignedTemplate(brand, {
      memberEmail: 'grace@northwind.test',
      memberName: 'Grace',
      ticketNumber: 41,
      subject: 'Where is my order',
      requesterName: 'Ada',
      url: 'https://getchat.site/app/tickets/41',
    }),
  ],
];

describe.each(everyMessage)('%s', (name, message) => {
  it('has a subject, an HTML body and a plain-text body', () => {
    expect(message.subject.trim()).not.toBe('');
    expect(message.html).toContain('<!doctype html>');
    expect(message.text.trim()).not.toBe('');
  });

  it('addresses a real recipient', () => {
    expect(message.to.email).toMatch(/^[^@\s]+@[^@\s]+$/);
  });

  /**
   * A subject that wraps across a phone's notification is a subject nobody reads. RFC 5322
   * suggests 78; clients truncate well before 100.
   */
  it('keeps the subject short enough to survive a notification', () => {
    expect(message.subject.length).toBeLessThanOrEqual(90);
  });

  it('leaves no unreplaced interpolation behind', () => {
    expect(message.html).not.toMatch(/\$\{|\bundefined\b|\[object Object\]/);
    expect(message.text).not.toMatch(/\$\{|\bundefined\b|\[object Object\]/);
  });

  it('never hardcodes a brand other than the one it was given', () => {
    if (name.startsWith('ticket') && name !== 'ticketAssigned') return;
    expect(message.html).not.toContain('SmartChat');
    expect(message.text).not.toContain('SmartChat');
  });
});

describe('escaping', () => {
  /**
   * A display name is user-controlled and lands inside the HTML body. If it is not escaped, an
   * agent who names themselves with a tag writes markup into a mailbox this product does not own.
   */
  it('escapes a name that contains markup', () => {
    const message = verifyEmailTemplate(brand, {
      name: '<script>alert(1)</script>',
      email: 'ada@example.com',
      url: 'https://getchat.site/verify?token=abc',
      expiresInHours: 24,
    });

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });

  it('escapes a quoted ticket body and keeps its line breaks', () => {
    const message = ticketReceivedTemplate(ticket, 'line one\n<b>line two</b>');
    expect(message.html).not.toContain('<b>line two</b>');
    expect(message.html).toContain('&lt;b&gt;line two&lt;/b&gt;');
    expect(message.html).toContain('line one<br>');
  });

  it('escapes a URL rather than letting it close the attribute', () => {
    const message = passwordResetTemplate(brand, {
      name: 'Ada',
      email: 'ada@example.com',
      url: 'https://getchat.site/reset?token=a"onmouseover="alert(1)',
      expiresInMinutes: 60,
    });

    expect(message.html).not.toContain('onmouseover="alert(1)"');
    expect(message.html).toContain('&quot;onmouseover=&quot;');
  });
});

describe('ticket mail', () => {
  /**
   * This product does not receive mail. A Reply-To pointing at us would make every reply a
   * customer writes disappear, so it is only ever set when the account has a real mailbox.
   */
  it('sets Reply-To only when the account has a mailbox behind it', () => {
    expect(ticketReceivedTemplate(ticket, 'hi').replyTo).toEqual({
      email: 'help@northwind.test',
      name: 'Northwind',
    });

    const withoutMailbox = ticketReceivedTemplate({ ...ticket, supportEmail: null }, 'hi');
    expect(withoutMailbox.replyTo).toBeUndefined();
    expect(withoutMailbox.text).toContain('not monitored');
  });

  it('carries the account name, not ours, to a customer of a customer', () => {
    const message = ticketReplyTemplate(ticket, { reply: 'On its way.', agentName: 'Grace' });
    expect(message.html).toContain('Northwind');
    expect(message.html).not.toContain('GetChat');
  });

  it('threads on the ticket number in the subject and a header', () => {
    for (const message of [
      ticketReceivedTemplate(ticket, 'hi'),
      ticketReplyTemplate(ticket, { reply: 'hi', agentName: 'Grace' }),
      ticketResolvedTemplate(ticket),
    ]) {
      expect(message.subject).toContain('[#41]');
      expect(message.headers).toMatchObject({ 'X-SmartChat-Ticket': '41' });
    }
  });

  it('greets an anonymous requester without printing a blank name', () => {
    const message = ticketReceivedTemplate({ ...ticket, requesterName: null }, 'hi');
    expect(message.text.startsWith('Hi,')).toBe(true);
    expect(message.to.name).toBeUndefined();
  });

  /**
   * Deliberate: an assignment notification lands in a mailbox this product does not control, so it
   * carries the subject and who asked, and not what they wrote.
   */
  it("keeps the customer's words out of the agent assignment email", () => {
    const message = ticketAssignedTemplate(brand, {
      memberEmail: 'grace@northwind.test',
      memberName: 'Grace',
      ticketNumber: 41,
      subject: 'Where is my order',
      requesterName: 'Ada',
      url: 'https://getchat.site/app/tickets/41',
    });

    expect(message.html).toContain('Where is my order');
    expect(message.html).toContain('https://getchat.site/app/tickets/41');
  });
});

describe('links', () => {
  it('shows the link as text as well as a button, for clients that strip buttons', () => {
    const url = 'https://getchat.site/verify?token=abc';
    const message = verifyEmailTemplate(brand, {
      name: 'Ada',
      email: 'ada@example.com',
      url,
      expiresInHours: 24,
    });

    expect(message.html.split(url).length - 1).toBeGreaterThanOrEqual(2);
    expect(message.text).toContain(url);
  });
});
