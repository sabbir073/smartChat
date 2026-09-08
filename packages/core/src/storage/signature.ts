/**
 * What a file actually is, read from its first bytes.
 *
 * The browser's `Content-Type` is a claim, and `.png` on the end of a name is a claim. Both are
 * trivially wrong and trivially forged, and neither is stored. This is the only thing that decides
 * what an attachment is - so a PHP script named `photo.png` and declared as `image/png` is
 * recognised for what it is and refused.
 *
 * Deliberately an allow-list rather than a general sniffer: images, documents, spreadsheets,
 * presentations, archives, video and audio - the things a support conversation actually needs -
 * and anything unrecognised is rejected rather than guessed at. Nothing here is a type a browser
 * or an operating system executes, and nothing but an image is ever served inline.
 */

export interface FileKind {
  /** The type the bytes are, which is what gets stored. */
  contentType: string;
  /** The extension we will give the object, regardless of what the file was called. */
  extension: string;
  /** Whether it should render inline in a chat bubble. */
  isImage: boolean;
}

interface Signature extends FileKind {
  /** Bytes that must appear at `offset`. A gap (null) matches any byte. */
  magic: (number | null)[];
  offset: number;
  /** Extra check for containers whose magic bytes are shared (ZIP, RIFF, ISO-BMFF). */
  refine?: (bytes: Uint8Array, declaredName: string) => FileKind | null;
}

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));

function at(bytes: Uint8Array, offset: number, expected: string): boolean {
  const wanted = ascii(expected);
  if (bytes.length < offset + wanted.length) return false;
  return wanted.every((code, index) => bytes[offset + index] === code);
}

/**
 * ZIP is a container. An .docx, .xlsx and .pptx are all ZIPs, and so is a .jar - so the magic
 * bytes alone are not an answer. The member names near the start tell them apart.
 */
function refineZip(bytes: Uint8Array): FileKind | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (head.includes('word/')) {
    return {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      extension: 'docx',
      isImage: false,
    };
  }
  if (head.includes('xl/')) {
    return {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      extension: 'xlsx',
      isImage: false,
    };
  }
  if (head.includes('ppt/')) {
    return {
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      extension: 'pptx',
      isImage: false,
    };
  }
  // A plain archive. Allowed, but never presented as anything cleverer than a zip.
  return { contentType: 'application/zip', extension: 'zip', isImage: false };
}

/** RIFF is also a container; only the WEBP form is accepted. */
function refineRiff(bytes: Uint8Array): FileKind | null {
  if (!at(bytes, 8, 'WEBP')) return null;
  return { contentType: 'image/webp', extension: 'webp', isImage: true };
}

/**
 * ISO base media files - MP4, MOV, M4V - carry a brand at byte 8 after the `ftyp` box. The
 * brand says which container it is; the same family also covers HEIC photos, which browsers do
 * not display, so those are named for what they are rather than shown as a broken image.
 */
function refineIsoMedia(bytes: Uint8Array): FileKind | null {
  const brand = new TextDecoder('latin1').decode(bytes.subarray(8, 12));
  if (brand === 'qt  ') return { contentType: 'video/quicktime', extension: 'mov', isImage: false };
  if (brand === 'M4V ' || brand === 'M4VH' || brand === 'M4VP') {
    return { contentType: 'video/x-m4v', extension: 'm4v', isImage: false };
  }
  if (brand === 'M4A ') return { contentType: 'audio/mp4', extension: 'm4a', isImage: false };
  if (brand.startsWith('hei') || brand.startsWith('mif') || brand.startsWith('avif')) {
    return {
      contentType: brand.startsWith('avif') ? 'image/avif' : 'image/heic',
      extension: brand.startsWith('avif') ? 'avif' : 'heic',
      isImage: false,
    };
  }
  // isom, iso2, mp41, mp42, avc1, dash, ... - MP4 in one of its many spellings.
  return { contentType: 'video/mp4', extension: 'mp4', isImage: false };
}

/** EBML is the container for both WebM and Matroska; the DocType a little way in tells them apart. */
function refineEbml(bytes: Uint8Array): FileKind | null {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 64)));
  if (head.includes('webm'))
    return { contentType: 'video/webm', extension: 'webm', isImage: false };
  if (head.includes('matroska')) {
    return { contentType: 'video/x-matroska', extension: 'mkv', isImage: false };
  }
  return null;
}

/**
 * Legacy Office (.doc, .xls, .ppt) shares one container signature. The bytes cannot tell the
 * three apart cheaply, and the name is allowed to, because every branch is an office document
 * served as an attachment - never anything a browser would execute.
 */
function refineOleByName(declaredName: string): FileKind {
  const lower = declaredName.toLowerCase();
  if (lower.endsWith('.xls')) {
    return { contentType: 'application/vnd.ms-excel', extension: 'xls', isImage: false };
  }
  if (lower.endsWith('.ppt')) {
    return { contentType: 'application/vnd.ms-powerpoint', extension: 'ppt', isImage: false };
  }
  return { contentType: 'application/msword', extension: 'doc', isImage: false };
}

const SIGNATURES: Signature[] = [
  {
    magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    offset: 0,
    contentType: 'image/png',
    extension: 'png',
    isImage: true,
  },
  {
    magic: [0xff, 0xd8, 0xff],
    offset: 0,
    contentType: 'image/jpeg',
    extension: 'jpg',
    isImage: true,
  },
  { magic: ascii('GIF87a'), offset: 0, contentType: 'image/gif', extension: 'gif', isImage: true },
  { magic: ascii('GIF89a'), offset: 0, contentType: 'image/gif', extension: 'gif', isImage: true },
  { magic: [0x42, 0x4d], offset: 0, contentType: 'image/bmp', extension: 'bmp', isImage: true },
  {
    magic: ascii('RIFF'),
    offset: 0,
    contentType: 'image/webp',
    extension: 'webp',
    isImage: true,
    refine: refineRiff,
  },
  {
    magic: ascii('%PDF-'),
    offset: 0,
    contentType: 'application/pdf',
    extension: 'pdf',
    isImage: false,
  },
  {
    magic: [0x50, 0x4b, 0x03, 0x04],
    offset: 0,
    contentType: 'application/zip',
    extension: 'zip',
    isImage: false,
    refine: refineZip,
  },
  {
    magic: [0x50, 0x4b, 0x05, 0x06],
    offset: 0,
    contentType: 'application/zip',
    extension: 'zip',
    isImage: false,
    refine: refineZip,
  },
  {
    magic: [0x1f, 0x8b],
    offset: 0,
    contentType: 'application/gzip',
    extension: 'gz',
    isImage: false,
  },
  // Legacy Office. One signature covers .doc, .xls and .ppt; the name picks between them.
  {
    magic: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
    offset: 0,
    contentType: 'application/msword',
    extension: 'doc',
    isImage: false,
    refine: (_bytes, declaredName) => refineOleByName(declaredName),
  },
  // Video. MP4 and its relatives declare themselves with an `ftyp` box after a 4-byte size.
  {
    magic: ascii('ftyp'),
    offset: 4,
    contentType: 'video/mp4',
    extension: 'mp4',
    isImage: false,
    refine: refineIsoMedia,
  },
  {
    magic: [0x1a, 0x45, 0xdf, 0xa3],
    offset: 0,
    contentType: 'video/webm',
    extension: 'webm',
    isImage: false,
    refine: refineEbml,
  },
  // Audio, for the voice note somebody attaches instead of typing it out.
  { magic: ascii('ID3'), offset: 0, contentType: 'audio/mpeg', extension: 'mp3', isImage: false },
  { magic: ascii('OggS'), offset: 0, contentType: 'audio/ogg', extension: 'ogg', isImage: false },
];

function matches(bytes: Uint8Array, signature: Signature): boolean {
  const { magic, offset } = signature;
  if (bytes.length < offset + magic.length) return false;
  return magic.every((byte, index) => byte === null || bytes[offset + index] === byte);
}

/**
 * Plain text has no signature, so it is identified by exclusion: nothing else matched, and every
 * byte is something a text file may contain. A NUL byte is the giveaway that it is not text.
 */
function looksLikeText(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.length, 2048));
  for (const byte of sample) {
    if (byte === 0) return false;
    // Control characters other than tab, newline and carriage return.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) return false;
  }
  return true;
}

/**
 * Identify a file from its leading bytes.
 *
 * Returns null when the bytes are not something this product accepts, which is the answer for
 * every executable, script and unknown format - refusing by default rather than allowing by
 * default is the whole point of doing this at all.
 */
export function identifyFile(bytes: Uint8Array, declaredName: string): FileKind | null {
  for (const signature of SIGNATURES) {
    if (!matches(bytes, signature)) continue;
    if (signature.refine) {
      const refined = signature.refine(bytes, declaredName);
      if (refined) return refined;
      continue;
    }
    return {
      contentType: signature.contentType,
      extension: signature.extension,
      isImage: signature.isImage,
    };
  }

  if (looksLikeText(bytes)) {
    // The name is allowed to pick between text flavours, because it cannot pick anything unsafe:
    // every branch here is served as text/plain and never executed by anything.
    const lower = declaredName.toLowerCase();
    if (lower.endsWith('.csv'))
      return { contentType: 'text/csv', extension: 'csv', isImage: false };
    if (lower.endsWith('.json'))
      return { contentType: 'application/json', extension: 'json', isImage: false };
    return { contentType: 'text/plain', extension: 'txt', isImage: false };
  }

  return null;
}
