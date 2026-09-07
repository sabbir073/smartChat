import { describe, expect, it, vi } from 'vitest';
import { PropertyService } from './property.service.js';

const PUBLIC_ID = 'prp_01ABCDEFGHJK';
const NOW = new Date('2026-09-07T12:00:00Z');

const context = {
  accountId: 'acc_1',
  userId: 'usr_1',
  permissions: new Set(['property:view']),
} as never;

function serviceWith(
  property: { lastWidgetRequestAt: Date | null; installedAt: Date | null; websiteUrl?: string },
  fetchSite?: ReturnType<typeof vi.fn>,
) {
  const record = vi.fn().mockResolvedValue(undefined);
  const service = new PropertyService({
    db: {
      property: { updateMany: record },
    } as never,
    widgetUrl: 'https://cdn.test',
    ...(fetchSite ? { fetchSite: fetchSite as never } : {}),
    clock: { now: () => NOW, timestamp: () => NOW.getTime() },
  });

  // `get` is the tenancy-checked read; the check under test is everything after it.
  vi.spyOn(service, 'get').mockResolvedValue({
    id: 'prp_1',
    publicId: PUBLIC_ID,
    websiteUrl: property.websiteUrl ?? 'https://example.com',
    installedAt: property.installedAt,
    lastWidgetRequestAt: property.lastWidgetRequestAt,
  } as never);

  return { service, record };
}

const html = (body: string) => ({ status: 200, text: async () => body });

/**
 * The gap this closes: "installed" could only ever become true as a side effect of a real visitor
 * loading the widget. Paste the snippet, return to the dashboard, and it still said Awaiting
 * installation — giving the same answer to "your snippet is wrong" and "nobody has visited the
 * page yet", which are not the same problem and do not have the same fix.
 */
describe('PropertyService.verifyInstallation', () => {
  it('accepts a recent request from the widget as proof, without touching the site', async () => {
    const fetchSite = vi.fn();
    const { service } = serviceWith(
      { lastWidgetRequestAt: new Date(NOW.getTime() - 60_000), installedAt: null },
      fetchSite,
    );

    const result = await service.verifyInstallation(context, 'prp_1');

    expect(result).toMatchObject({ verified: true, evidence: 'widget_request' });
    expect(fetchSite).not.toHaveBeenCalled();
  });

  it('finds the snippet in the page before anybody has visited', async () => {
    const fetchSite = vi
      .fn()
      .mockResolvedValue(html(`<html><script src="https://cdn.test/v1/loader.js?p=${PUBLIC_ID}">`));
    const { service, record } = serviceWith(
      { lastWidgetRequestAt: null, installedAt: null },
      fetchSite,
    );

    const result = await service.verifyInstallation(context, 'prp_1');

    expect(result).toMatchObject({ verified: true, evidence: 'snippet_found' });
    expect(result.checkedUrl).toBe('https://example.com/');
    // Recorded, so the badge does not revert to Awaiting on the next page load.
    expect(record).toHaveBeenCalled();
  });

  it('does not mistake another property’s snippet for this one', async () => {
    const fetchSite = vi
      .fn()
      .mockResolvedValue(html('<script src="/loader.js?p=prp_01ZZZZZZZZZZ">'));
    const { service, record } = serviceWith(
      { lastWidgetRequestAt: null, installedAt: null },
      fetchSite,
    );

    const result = await service.verifyInstallation(context, 'prp_1');

    expect(result.verified).toBe(false);
    expect(record).not.toHaveBeenCalled();
  });

  /**
   * A site behind a login, a firewall or a bot check is not a misinstalled site. Reporting one as
   * the other sends somebody to re-paste a snippet that was already correct.
   */
  it('reports a site it could not reach as exactly that', async () => {
    const fetchSite = vi.fn().mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1'));
    const { service } = serviceWith({ lastWidgetRequestAt: null, installedAt: null }, fetchSite);

    const result = await service.verifyInstallation(context, 'prp_1');

    expect(result.verified).toBe(false);
    expect(result.detail).toMatch(/could not reach/i);
    // Never the underlying error: it names addresses and helps nobody decide what to do.
    expect(result.detail).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
  });

  it('says what a 403 was, rather than calling it a missing snippet', async () => {
    const fetchSite = vi.fn().mockResolvedValue({ status: 403, text: async () => '' });
    const { service } = serviceWith({ lastWidgetRequestAt: null, installedAt: null }, fetchSite);

    const result = await service.verifyInstallation(context, 'prp_1');
    expect(result.verified).toBe(false);
    expect(result.detail).toContain('403');
  });

  /** A tag manager injects the snippet at runtime, so it is never in the HTML. Say so. */
  it('mentions tag managers when the page loads but has no snippet', async () => {
    const fetchSite = vi.fn().mockResolvedValue(html('<html><body>nothing here</body></html>'));
    const { service } = serviceWith({ lastWidgetRequestAt: null, installedAt: null }, fetchSite);

    const result = await service.verifyInstallation(context, 'prp_1');
    expect(result.detail).toMatch(/tag manager/i);
  });

  it('keeps a previously verified property verified when a later check cannot confirm', async () => {
    const fetchSite = vi.fn().mockRejectedValue(new Error('offline'));
    const { service } = serviceWith(
      { lastWidgetRequestAt: null, installedAt: new Date('2026-01-01T00:00:00Z') },
      fetchSite,
    );

    expect((await service.verifyInstallation(context, 'prp_1')).verified).toBe(true);
  });

  it('does not treat a request from months ago as current proof', async () => {
    const fetchSite = vi.fn().mockResolvedValue(html('nothing'));
    const { service } = serviceWith(
      { lastWidgetRequestAt: new Date('2026-01-01T00:00:00Z'), installedAt: null },
      fetchSite,
    );

    const result = await service.verifyInstallation(context, 'prp_1');
    expect(result.evidence).not.toBe('widget_request');
    expect(fetchSite).toHaveBeenCalled();
  });

  it('falls back cleanly when the deployment has no outbound client', async () => {
    const { service } = serviceWith({ lastWidgetRequestAt: null, installedAt: null });
    const result = await service.verifyInstallation(context, 'prp_1');
    expect(result.verified).toBe(false);
    expect(result.detail).toMatch(/No request from your site yet/i);
  });
});
