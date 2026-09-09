import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { extractFileText, readableFileType, UnreadableFileError } from './extract-file.js';

describe('extractFileText', () => {
  it('reads the text of every page of a PDF', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/sample.pdf', import.meta.url)));
    const text = await extractFileText(bytes, 'application/pdf');
    expect(text).toContain('Admission fee for HSC batch is 2,500 BDT per month.');
    expect(text).toContain('Page two: contact 01301806881.');
  });

  it('turns a Word document into headed text', async () => {
    const bytes = new Uint8Array(readFileSync(new URL('./fixtures/sample.docx', import.meta.url)));
    const text = await extractFileText(bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(text).toContain('# Course fees');
    expect(text).toContain('- Physics: 1,500 BDT');
  });

  it('reads plain text and drops a byte-order mark', async () => {
    const text = await extractFileText(new TextEncoder().encode('﻿Hello there, this is a plain file.\r\n\r\n\r\nSecond.'), 'text/plain');
    expect(text).toBe('Hello there, this is a plain file.\n\nSecond.');
  });

  it('refuses a file with nothing to read', async () => {
    await expect(extractFileText(new TextEncoder().encode('   '), 'text/plain')).rejects.toBeInstanceOf(UnreadableFileError);
    await expect(extractFileText(new TextEncoder().encode('not a pdf'), 'application/pdf')).rejects.toBeInstanceOf(UnreadableFileError);
  });

  it('knows which types it can read', () => {
    expect(readableFileType('application/pdf')).toBe('application/pdf');
    expect(readableFileType('image/png')).toBeNull();
    expect(readableFileType('application/zip')).toBeNull();
  });
});

describe('extractFileText with a Node Buffer', () => {
  it('reads a PDF handed over as a Buffer, which is what the store returns', async () => {
    const bytes = readFileSync(new URL('./fixtures/sample.pdf', import.meta.url));
    const text = await extractFileText(bytes, 'application/pdf');
    expect(text).toContain('Admission fee');
  });
});
