import { describe, expect, it } from 'vitest';
import { issueEmbedTicket } from '../crypto/embed-ticket.js';
import { AppError, ErrorCode } from '@smartchat/types';
import { VisitorService } from './visitor.service.js';

const SECRET = 'a'.repeat(48);
const PUBLIC_ID = 'prp_01ABCDEFGHJK';

/**
 * The bug this pins, in one sentence: with domain enforcement switched on, every widget on every
 * authorised site stopped working.
 *
 * The widget has two halves on two origins. The loader runs in the customer's page, so its
 * requests carry `Origin: https://their-site.com`. The panel runs in an iframe on this product's
 * own CDN, so its requests carry `Origin: https://cdn.ours.com` — on every site, including the
 * authorised ones. Bootstrap checked that header against the customer's allowed-domain list, which
 * it can never be in, so enforcement rejected everybody and the only way to have a working widget
 * was to leave enforcement off.
 *
 * These call the private guard directly. It is the whole of the decision, and reaching it through
 * `bootstrap` would need a database for the parts that are not being tested.
 */
type Guard = (
  property: { enforceDomains: boolean; domains: { pattern: string; isWildcard: boolean }[] },
  input: { publicId: string; origin: string | undefined; embedTicket?: string | undefined },
) => void;

function guard(options: { allowLocalhostOrigins?: boolean } = {}): Guard {
  const service = new VisitorService({
    db: {} as never,
    visitorTokenSecret: SECRET,
    allowLocalhostOrigins: options.allowLocalhostOrigins ?? false,
  });
  return (property, input) =>
    (service as unknown as { assertEmbedAllowed: Guard }).assertEmbedAllowed(property, input);
}

const enforcing = {
  enforceDomains: true,
  domains: [{ pattern: 'example.com', isWildcard: false }],
};

const ticketFor = (host: string, publicId = PUBLIC_ID) =>
  issueEmbedTicket({ publicId, host, now: new Date() }, SECRET);

function refusal(run: () => void): AppError {
  try {
    run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error('expected the embed to be refused');
}

describe('embed enforcement', () => {
  it("lets the panel through for a site on the list, whatever the panel's own origin is", () => {
    expect(() =>
      guard()(enforcing, {
        publicId: PUBLIC_ID,
        // This is the CDN, and it is never in anybody's allowed-domain list. That is the point.
        origin: 'https://cdn.getchat.site',
        embedTicket: ticketFor('example.com'),
      }),
    ).not.toThrow();
  });

  it('refuses a site that is not on the list', () => {
    const error = refusal(() =>
      guard()(enforcing, {
        publicId: PUBLIC_ID,
        origin: 'https://cdn.getchat.site',
        embedTicket: ticketFor('somewhere-else.test'),
      }),
    );
    expect(error.code).toBe(ErrorCode.ORIGIN_NOT_ALLOWED);
  });

  it('honours a wildcard entry', () => {
    expect(() =>
      guard()(
        { enforceDomains: true, domains: [{ pattern: '*.example.com', isWildcard: true }] },
        {
          publicId: PUBLIC_ID,
          origin: 'https://cdn.getchat.site',
          embedTicket: ticketFor('shop.example.com'),
        },
      ),
    ).not.toThrow();
  });

  it('refuses a ticket minted for a different property', () => {
    const error = refusal(() =>
      guard()(enforcing, {
        publicId: PUBLIC_ID,
        origin: 'https://cdn.getchat.site',
        embedTicket: ticketFor('example.com', 'prp_01ZZZZZZZZZZ'),
      }),
    );
    expect(error.code).toBe(ErrorCode.ORIGIN_NOT_ALLOWED);
  });

  it('refuses a forged ticket', () => {
    const forged = issueEmbedTicket(
      { publicId: PUBLIC_ID, host: 'example.com', now: new Date() },
      'z'.repeat(48),
    );
    expect(
      refusal(() =>
        guard()(enforcing, {
          publicId: PUBLIC_ID,
          origin: 'https://cdn.getchat.site',
          embedTicket: forged,
        }),
      ).code,
    ).toBe(ErrorCode.ORIGIN_NOT_ALLOWED);
  });

  /**
   * A domain removed from the list must stop working within the ticket's short life, not at the
   * end of it: the ticket carries *which host*, and the answer to "is that host allowed" is looked
   * up fresh every time.
   */
  it('re-checks the list rather than trusting that a ticket exists', () => {
    const stillValid = ticketFor('example.com');
    expect(
      refusal(() =>
        guard()(
          { enforceDomains: true, domains: [] },
          { publicId: PUBLIC_ID, origin: 'https://cdn.getchat.site', embedTicket: stillValid },
        ),
      ).code,
    ).toBe(ErrorCode.ORIGIN_NOT_ALLOWED);
  });

  it('refuses a panel opened directly, with no ticket at all', () => {
    expect(
      refusal(() => guard()(enforcing, { publicId: PUBLIC_ID, origin: 'https://cdn.getchat.site' }))
        .code,
    ).toBe(ErrorCode.ORIGIN_NOT_ALLOWED);
  });

  it('lets everything through when enforcement is off', () => {
    expect(() =>
      guard()(
        { enforceDomains: false, domains: [] },
        { publicId: PUBLIC_ID, origin: 'https://anywhere.test' },
      ),
    ).not.toThrow();
  });

  it('still lets a developer work on localhost when the deployment allows it', () => {
    expect(() =>
      guard({ allowLocalhostOrigins: true })(
        { enforceDomains: true, domains: [] },
        { publicId: PUBLIC_ID, origin: 'http://localhost:3000' },
      ),
    ).not.toThrow();
  });
});
