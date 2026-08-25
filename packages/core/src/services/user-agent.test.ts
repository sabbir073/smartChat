import { describe, expect, it } from 'vitest';
import { DeviceType } from '@smartchat/types';
import { parseUserAgent, sanitiseUrl } from './user-agent.js';

const UA = {
  chromeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0',
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  safariIphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  chromeAndroidTablet:
    'Mozilla/5.0 (Linux; Android 14; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  chromeAndroidPhone:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0',
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
};

describe('parseUserAgent', () => {
  it('does not mistake Edge for Chrome, even though Edge advertises both', () => {
    expect(parseUserAgent(UA.edgeWindows).browser).toBe('Edge');
    expect(parseUserAgent(UA.chromeWindows).browser).toBe('Chrome');
  });

  it('does not mistake Chrome for Safari', () => {
    expect(parseUserAgent(UA.chromeWindows).browser).toBe('Chrome');
    expect(parseUserAgent(UA.safariMac).browser).toBe('Safari');
  });

  it('identifies operating systems', () => {
    expect(parseUserAgent(UA.chromeWindows).os).toBe('Windows 10/11');
    expect(parseUserAgent(UA.safariMac).os).toBe('macOS');
    expect(parseUserAgent(UA.safariIphone).os).toBe('iOS');
    expect(parseUserAgent(UA.firefox).os).toBe('Linux');
  });

  it('distinguishes phone, tablet and desktop', () => {
    expect(parseUserAgent(UA.safariIphone).deviceType).toBe(DeviceType.MOBILE);
    expect(parseUserAgent(UA.chromeAndroidPhone).deviceType).toBe(DeviceType.MOBILE);
    expect(parseUserAgent(UA.chromeAndroidTablet).deviceType).toBe(DeviceType.TABLET);
    expect(parseUserAgent(UA.chromeWindows).deviceType).toBe(DeviceType.DESKTOP);
  });

  it('labels a crawler as a bot rather than counting it as a visitor', () => {
    expect(parseUserAgent(UA.googlebot).deviceType).toBe(DeviceType.BOT);
    expect(parseUserAgent('HeadlessChrome/131.0.0.0').deviceType).toBe(DeviceType.BOT);
  });

  it('degrades to unknown rather than throwing on absent or absurd input', () => {
    expect(parseUserAgent(undefined).deviceType).toBe(DeviceType.UNKNOWN);
    expect(parseUserAgent('').deviceType).toBe(DeviceType.UNKNOWN);
    expect(parseUserAgent('x'.repeat(2000)).deviceType).toBe(DeviceType.UNKNOWN);
  });
});

describe('sanitiseUrl', () => {
  it('strips credentials and the fragment, which routinely carries tokens', () => {
    expect(sanitiseUrl('https://user:pass@example.com/pricing#access_token=abc')).toBe(
      'https://example.com/pricing',
    );
  });

  it('keeps the query string, which is genuinely useful context for an agent', () => {
    expect(sanitiseUrl('https://example.com/pricing?plan=pro')).toBe(
      'https://example.com/pricing?plan=pro',
    );
  });

  it('rejects non-http schemes', () => {
    expect(sanitiseUrl('javascript:alert(1)')).toBeNull();
    expect(sanitiseUrl('data:text/html,<script>')).toBeNull();
    expect(sanitiseUrl('file:///etc/passwd')).toBeNull();
  });

  it('returns null for absent or unparseable values', () => {
    expect(sanitiseUrl(null)).toBeNull();
    expect(sanitiseUrl('   ')).toBeNull();
    expect(sanitiseUrl('not a url')).toBeNull();
  });
});
