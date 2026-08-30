/**
 * Storage keys and file names.
 *
 * The rule this file exists to enforce: a client never contributes a single character to an object
 * key. Keys are built from ids the server already trusts - so there is no traversal to prevent, no
 * collision to resolve, and no way for one tenant's upload to land on another tenant's path even
 * if every field in the request is hostile.
 *
 * The original file name survives only as a display label and a download header, and it is
 * sanitised before either.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the key an attachment's bytes live at.
 *
 * Three uuids this service generated, and nothing else. In particular there is no extension: the
 * key has to be fixed before the bytes exist, and at that moment the only thing we know about the
 * file type is what the client claimed. Putting a claim in the key would mean the stored path
 * asserts something nobody has checked.
 *
 * Nothing is lost by leaving it out. The object is never served by its path - a download URL pins
 * the content type and the file name into its own signature, both taken from the verified row.
 */
export function attachmentKey(input: {
  accountId: string;
  propertyId: string;
  attachmentId: string;
}): string {
  for (const [field, value] of Object.entries(input)) {
    if (!UUID.test(value)) throw new Error(`refusing to build a storage key from ${field}`);
  }
  return `a/${input.accountId}/${input.propertyId}/${input.attachmentId}`;
}

/**
 * Code points that must not survive into a displayed file name.
 *
 * Control characters, and the bidi controls - which are how a name is made to *read* as something
 * other than what it is. A right-to-left override placed before "gnp.exe" renders as "exe.png" in
 * a file list, and somebody clicks it.
 *
 * Expressed as numeric ranges rather than as a character class, because a source file containing
 * an invisible override is exactly the sort of thing nobody notices in review.
 */
const FORBIDDEN_RANGES: readonly [number, number][] = [
  [0x0000, 0x001f], // C0 controls
  [0x007f, 0x009f], // DEL and C1 controls
  [0x200b, 0x200f], // zero-width and LTR/RTL marks
  [0x2028, 0x202e], // line/paragraph separators and the bidi embedding overrides
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // byte-order mark
];

function stripInvisible(value: string): string {
  let out = '';
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (FORBIDDEN_RANGES.some(([low, high]) => code >= low && code <= high)) continue;
    out += character;
  }
  return out;
}

/**
 * Make an uploaded file name safe to show and to put in a header.
 *
 * Path separators are removed rather than replaced with something that could be reassembled, and a
 * leading dot is dropped so a file cannot present itself as hidden. Everything outside a
 * conservative set becomes an underscore.
 *
 * This is about what a person is shown, not about the safety of the storage layer - that is
 * handled by never letting a name near a key in the first place.
 */
export function safeFileName(raw: string, fallbackExtension: string): string {
  const withoutPath = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = stripInvisible(withoutPath.normalize('NFKC'))
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);

  if (cleaned.length === 0) return `file.${fallbackExtension}`;
  return cleaned;
}

/**
 * The name a download is offered under.
 *
 * The extension is forced to match what the bytes actually are, so a file can never be handed back
 * under a name that misrepresents it.
 */
export function downloadName(fileName: string, extension: string): string {
  return fileName.toLowerCase().endsWith(`.${extension}`) ? fileName : `${fileName}.${extension}`;
}
