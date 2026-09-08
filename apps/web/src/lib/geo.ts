/**
 * Showing a country without shipping a country.
 *
 * A flag is two Unicode regional-indicator letters, so `BD` becomes 🇧🇩 with no image, no sprite
 * and no request. The name comes from `Intl.DisplayNames`, which every browser this product
 * supports has, in the reader's own language. `EU` and `AP` are regional codes the registries
 * use for blocks spread across a region; `Intl` knows the first, and the second is spelled out.
 */
export function countryFlag(code: string | null | undefined): string | null {
  if (!code || !/^[A-Z]{2}$/i.test(code)) return null;
  const upper = code.toUpperCase();
  // 'AP' (Asia-Pacific region) has no flag. Anything else two-letter renders as one, including EU.
  if (upper === 'AP') return null;
  return String.fromCodePoint(
    ...[...upper].map((letter) => 0x1f1e6 + letter.charCodeAt(0) - 'A'.charCodeAt(0)),
  );
}

const REGIONAL: Record<string, string> = { AP: 'Asia-Pacific region', EU: 'European Union' };

export function countryName(code: string | null | undefined, locale?: string): string | null {
  if (!code || !/^[A-Z]{2}$/i.test(code)) return null;
  const upper = code.toUpperCase();
  if (REGIONAL[upper]) return REGIONAL[upper];
  try {
    const name = new Intl.DisplayNames([locale ?? 'en'], { type: 'region' }).of(upper);
    // `of` returns the input unchanged for a code it does not know.
    return name && name !== upper ? name : upper;
  } catch {
    return upper;
  }
}

/**
 * A page, as an agent wants to read it in a list: the title if the site set one, otherwise the
 * path. Never the full URL with scheme and host - the agent knows which site it is.
 */
export function pageLabel(
  page: { url: string; title?: string | null } | null | undefined,
): string | null {
  if (!page?.url) return null;
  const title = page.title?.trim();
  if (title) return title;
  try {
    const url = new URL(page.url);
    const path = `${url.pathname}${url.search}`;
    return path === '/' ? url.host : path;
  } catch {
    return page.url;
  }
}

/** The path and query only, for showing under a title. */
export function pagePath(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    return url;
  }
}
