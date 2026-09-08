import { describe, expect, it } from 'vitest';
import { identifyFile } from './signature.js';
import { attachmentKey, downloadName, safeFileName } from './keys.js';
import { presignS3Url } from './sigv4.js';

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);

describe('identifyFile', () => {
  it('recognises the formats a support conversation actually uses', () => {
    expect(identifyFile(PNG, 'shot.png')?.contentType).toBe('image/png');
    expect(identifyFile(bytes(0xff, 0xd8, 0xff, 0xe0), 'photo.jpg')?.contentType).toBe(
      'image/jpeg',
    );
    expect(identifyFile(text('GIF89a...'), 'a.gif')?.contentType).toBe('image/gif');
    expect(identifyFile(text('%PDF-1.7\n'), 'invoice.pdf')?.contentType).toBe('application/pdf');
  });

  it('reads the bytes, not the name and not the claim', () => {
    // A PHP script called photo.png, declared image/png. This is the whole reason the check exists.
    const script = text('<?php system($_GET["c"]); ?>');
    const kind = identifyFile(script, 'photo.png');
    expect(kind?.contentType).not.toBe('image/png');
    // It is text, so it is storable - but as text/plain, which no browser will execute for us.
    expect(kind?.contentType).toBe('text/plain');
    expect(kind?.extension).toBe('txt');
  });

  it('refuses a binary it does not recognise', () => {
    // An ELF executable. Not text, not an allowed format: no answer at all.
    expect(identifyFile(bytes(0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0), 'update.png')).toBeNull();
    // A Windows executable, for the same reason.
    expect(identifyFile(bytes(0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00), 'setup.pdf')).toBeNull();
  });

  it('tells the Office formats apart inside the ZIP they share', () => {
    const zip = (member: string) => {
      const head = Uint8Array.from([0x50, 0x4b, 0x03, 0x04]);
      const body = text(`\u0000\u0000${member}document.xml`);
      const all = new Uint8Array(head.length + body.length);
      all.set(head);
      all.set(body, head.length);
      return all;
    };
    expect(identifyFile(zip('word/'), 'a.docx')?.extension).toBe('docx');
    expect(identifyFile(zip('xl/'), 'a.xlsx')?.extension).toBe('xlsx');
    expect(identifyFile(zip('ppt/'), 'a.pptx')?.extension).toBe('pptx');
    // A plain archive is still a zip and is never dressed up as a document.
    expect(identifyFile(zip('random/'), 'a.docx')?.extension).toBe('zip');
  });

  it('only accepts the WEBP form of a RIFF container', () => {
    const riff = (form: string) => text(`RIFF\u0000\u0000\u0000\u0000${form}more`);
    expect(identifyFile(riff('WEBP'), 'a.webp')?.contentType).toBe('image/webp');
    // RIFF/WAVE is not in the allow-list, so the container match must not stand in for it.
    expect(identifyFile(riff('WAVE'), 'a.webp')).toBeNull();
  });

  it('refuses an empty file', () => {
    expect(identifyFile(bytes(), 'empty.txt')).toBeNull();
  });
});

describe('attachmentKey', () => {
  const ids = {
    accountId: '018f2b4c-1a2b-7c3d-8e4f-5a6b7c8d9e0f',
    propertyId: '018f2b4c-1a2b-7c3d-8e4f-5a6b7c8d9e10',
    attachmentId: '018f2b4c-1a2b-7c3d-8e4f-5a6b7c8d9e11',
  };

  it('is built only from ids we generated', () => {
    expect(attachmentKey(ids)).toBe(`a/${ids.accountId}/${ids.propertyId}/${ids.attachmentId}`);
  });

  it('carries no extension, because at signing time the type is only a claim', () => {
    expect(attachmentKey(ids)).not.toContain('.');
  });

  it('refuses anything that is not a uuid, so traversal has nowhere to enter', () => {
    expect(() => attachmentKey({ ...ids, accountId: '../../etc' })).toThrow();
    expect(() => attachmentKey({ ...ids, attachmentId: `${ids.attachmentId}/../other` })).toThrow();
    expect(() => attachmentKey({ ...ids, propertyId: '' })).toThrow();
  });
});

describe('safeFileName', () => {
  it('keeps a readable name', () => {
    expect(safeFileName('Invoice 2026-03.pdf', 'pdf')).toBe('Invoice 2026-03.pdf');
  });

  it('drops the path, so only a name survives', () => {
    expect(safeFileName('../../etc/passwd', 'txt')).toBe('passwd');
    expect(safeFileName('C:\\Windows\\System32\\drivers\\etc\\hosts', 'txt')).toBe('hosts');
  });

  it('strips the bidi override used to disguise an extension', () => {
    // U+202E makes "report<RLO>gnp.exe" render as "report.exe.png" in a file list.
    const disguised = `report\u202Egnp.exe`;
    const cleaned = safeFileName(disguised, 'txt');
    expect(cleaned).not.toContain('\u202E');
    expect(cleaned).toBe('reportgnp.exe');
  });

  it('never returns a hidden or empty name', () => {
    expect(safeFileName('...', 'png')).toBe('file.png');
    expect(safeFileName('', 'png')).toBe('file.png');
    expect(safeFileName('.bashrc', 'txt')).toBe('bashrc');
  });
});

describe('downloadName', () => {
  it('forces the extension to match what the bytes are', () => {
    expect(downloadName('report.pdf.exe', 'txt')).toBe('report.pdf.exe.txt');
    expect(downloadName('shot.png', 'png')).toBe('shot.png');
    expect(downloadName('SHOT.PNG', 'png')).toBe('SHOT.PNG');
  });
});

describe('presignS3Url', () => {
  const base = {
    endpoint: 'http://localhost:9100',
    bucket: 'smartchat',
    key: 'a/018f2b4c-1a2b-7c3d-8e4f-5a6b7c8d9e0f/x.png',
    credentials: { accessKeyId: 'AKIA', secretAccessKey: 'secret', region: 'us-east-1' },
    expiresInSeconds: 300,
    forcePathStyle: true,
    now: new Date('2026-03-04T05:06:07Z'),
  } as const;

  it('carries everything the store needs to check it', () => {
    const url = presignS3Url({ ...base, method: 'PUT' });
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(url).toContain('X-Amz-Credential=AKIA%2F20260304%2Fus-east-1%2Fs3%2Faws4_request');
    expect(url).toContain('X-Amz-Date=20260304T050607Z');
    expect(url).toContain('X-Amz-Expires=300');
    expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}$/);
  });

  it('is deterministic for the same request, and changes with any part of it', () => {
    const put = presignS3Url({ ...base, method: 'PUT' });
    expect(presignS3Url({ ...base, method: 'PUT' })).toBe(put);
    // The method is signed, so a PUT link cannot be replayed as a GET.
    expect(presignS3Url({ ...base, method: 'GET' })).not.toBe(put);
    // So is the key, so a link for one object cannot be pointed at another.
    expect(presignS3Url({ ...base, method: 'PUT', key: 'a/other.png' })).not.toBe(put);
  });

  /**
   * `https://cdn.example.com/files` is the shape a single-box deployment uses: the proxy owns
   * `/files/` and strips it before the store sees the request. The browser must be sent the
   * prefixed URL, and the signature must be over the unprefixed path - the one the store checks.
   */
  it('keeps a proxy prefix on the URL but out of the signature', () => {
    const plain = presignS3Url({ ...base, method: 'PUT', endpoint: 'https://cdn.example.com' });
    const prefixed = presignS3Url({
      ...base,
      method: 'PUT',
      endpoint: 'https://cdn.example.com/files',
    });
    expect(prefixed).toContain('https://cdn.example.com/files/smartchat/a/');
    expect(plain).toContain('https://cdn.example.com/smartchat/a/');
    // Same host, same path once the prefix is stripped: the same signature.
    const signatureOf = (url: string) => new URL(url).searchParams.get('X-Amz-Signature');
    expect(signatureOf(prefixed)).toBe(signatureOf(plain));
  });

  it('puts the bucket in the path or in the host, as the deployment requires', () => {
    expect(presignS3Url({ ...base, method: 'GET' })).toContain('localhost:9100/smartchat/a/');
    expect(presignS3Url({ ...base, method: 'GET', forcePathStyle: false })).toContain(
      'smartchat.localhost:9100/a/',
    );
  });
});

describe('identifyFile - video, audio and legacy Office', () => {
  const box = (brand: string) =>
    new Uint8Array([
      0,
      0,
      0,
      0x18,
      ...'ftyp'.split('').map((c) => c.charCodeAt(0)),
      ...brand.split('').map((c) => c.charCodeAt(0)),
      0,
      0,
      0,
      0,
    ]);
  const ebml = (doctype: string) =>
    new Uint8Array([
      0x1a,
      0x45,
      0xdf,
      0xa3,
      0x9f,
      0x42,
      0x86,
      0x81,
      0x01,
      0x42,
      0x82,
      0x84,
      ...doctype.split('').map((c) => c.charCodeAt(0)),
    ]);

  it('recognises MP4, MOV, WebM and Matroska from their container bytes', () => {
    expect(identifyFile(box('isom'), 'clip.mp4')?.contentType).toBe('video/mp4');
    expect(identifyFile(box('mp42'), 'whatever.bin')?.extension).toBe('mp4');
    expect(identifyFile(box('qt  '), 'clip.mov')?.contentType).toBe('video/quicktime');
    expect(identifyFile(ebml('webm'), 'clip.webm')?.contentType).toBe('video/webm');
    expect(identifyFile(ebml('matroska'), 'clip.mkv')?.extension).toBe('mkv');
  });

  it('never renders a video inline', () => {
    expect(identifyFile(box('isom'), 'clip.mp4')?.isImage).toBe(false);
  });

  it('recognises MP3 and Ogg audio', () => {
    expect(identifyFile(new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0]), 'note.mp3')?.contentType).toBe(
      'audio/mpeg',
    );
    expect(
      identifyFile(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2]), 'note.ogg')?.extension,
    ).toBe('ogg');
  });

  it('names a legacy Office file by what it was called, since the bytes cannot tell', () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    expect(identifyFile(ole, 'report.doc')?.contentType).toBe('application/msword');
    expect(identifyFile(ole, 'numbers.xls')?.extension).toBe('xls');
    expect(identifyFile(ole, 'deck.ppt')?.contentType).toBe('application/vnd.ms-powerpoint');
    expect(identifyFile(ole, 'mystery')?.extension).toBe('doc');
  });

  it('still refuses executables and scripts whatever they are called', () => {
    const exe = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]);
    expect(identifyFile(exe, 'holiday.mp4')).toBeNull();
    const elf = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00]);
    expect(identifyFile(elf, 'photo.png')).toBeNull();
  });
});
