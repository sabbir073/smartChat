/**
 * Characters that carry no combining mark, so NFKD normalisation leaves them intact and the
 * subsequent strip would turn them into a hyphen. The German sharp s must slugify to "ss", not
 * disappear into "stra-e" - a slug is customer-visible, so silent mangling is not acceptable.
 */
const TRANSLITERATIONS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ı: 'i',
  ħ: 'h',
  ŋ: 'ng',
};

/** Combining diacritical marks, left behind by NFKD decomposition. */
const COMBINING_MARKS = /\p{M}/gu;
const NON_ASCII = /\P{ASCII}/gu;

/**
 * Turn a display name into a URL-safe slug.
 *
 * Diacritics are folded rather than dropped, so an accented "Cafe Noir" becomes "cafe-noir"
 * instead of "caf-noir", because the slug is what the customer sees in URLs.
 */
export function slugify(value: string, maxLength = 48): string {
  const transliterated = value
    .toLowerCase()
    .replace(NON_ASCII, (character) => TRANSLITERATIONS[character] ?? character);

  const normalised = transliterated
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');

  return normalised.length >= 2 ? normalised : `workspace-${normalised}`.slice(0, maxLength);
}

/**
 * Find a free slug by appending a counter.
 *
 * The caller supplies the existence check, so this stays a pure function and can be tested without
 * a database.
 */
export async function uniqueSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>,
  maxAttempts = 50,
): Promise<string> {
  const root = slugify(base);
  if (!(await exists(root))) return root;

  for (let i = 2; i <= maxAttempts; i += 1) {
    const candidate = `${root}-${i}`;
    if (!(await exists(candidate))) return candidate;
  }

  // Deterministic attempts exhausted (a very popular company name); fall back to entropy.
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${root}-${suffix}`;
}
