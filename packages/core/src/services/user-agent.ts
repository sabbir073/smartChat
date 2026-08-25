import { DeviceType } from '@smartchat/types';

export interface ParsedUserAgent {
  browser: string | null;
  os: string | null;
  deviceType: DeviceType;
}

/**
 * A small, dependency-free user-agent parser.
 *
 * It exists to label a visitor row in the agent's sidebar - "Chrome on Windows, desktop" - and
 * nothing more. It is never used for authorisation or feature detection, so being approximately
 * right is sufficient, and a full UA database would be a large dependency for a cosmetic field.
 *
 * Order matters throughout: Edge advertises Chrome, Chrome advertises Safari, and most things
 * advertise Mozilla.
 */
const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bSamsungBrowser\//, 'Samsung Internet'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
];

const OPERATING_SYSTEMS: [RegExp, string][] = [
  [/\bWindows NT 10\.0/, 'Windows 10/11'],
  [/\bWindows\b/, 'Windows'],
  [/\bAndroid\b/, 'Android'],
  [/\b(iPhone|iPad|iPod)\b/, 'iOS'],
  [/\bMac OS X\b|\bMacintosh\b/, 'macOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b/, 'Linux'],
];

const BOT =
  /bot\b|crawler|spider|crawling|headlesschrome|phantomjs|slurp|facebookexternalhit|lighthouse|pingdom|uptimerobot/i;
const TABLET = /\biPad\b|\bTablet\b|\bPlayBook\b|\bSilk\b|Android(?!.*\bMobile\b)/i;
const MOBILE =
  /\bMobi\b|\bMobile\b|\biPhone\b|\biPod\b|\bAndroid\b|\bWindows Phone\b|\bIEMobile\b/i;

export function parseUserAgent(userAgent: string | undefined | null): ParsedUserAgent {
  if (!userAgent || userAgent.length > 1024) {
    return { browser: null, os: null, deviceType: DeviceType.UNKNOWN };
  }

  // Bots are checked first: a crawler that claims to be Chrome on Android should be labelled a
  // bot, not counted as a mobile visitor.
  if (BOT.test(userAgent)) {
    return { browser: null, os: null, deviceType: DeviceType.BOT };
  }

  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;
  const os = OPERATING_SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1] ?? null;

  let deviceType: DeviceType = DeviceType.DESKTOP;
  if (TABLET.test(userAgent)) deviceType = DeviceType.TABLET;
  else if (MOBILE.test(userAgent)) deviceType = DeviceType.MOBILE;

  return { browser, os, deviceType };
}

/** Truncate a URL for storage without losing the part an agent needs to see. */
export function truncateUrl(url: string | undefined | null, max = 2048): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/**
 * Reduce a URL to something safe to display and store.
 *
 * Credentials in the authority and any `#fragment` are dropped: a fragment routinely carries
 * tokens in single-page apps, and neither belongs in an agent's sidebar or our database.
 */
export function sanitiseUrl(raw: string | undefined | null): string | null {
  const value = truncateUrl(raw);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}
