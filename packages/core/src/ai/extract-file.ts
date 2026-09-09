import mammoth from 'mammoth';
import { extractText, getDocumentProxy } from 'unpdf';
import { htmlToText } from './extract.js';

/**
 * Text out of an uploaded file, for the index.
 *
 * Three formats, chosen because they are what a business actually has lying around: PDFs (price
 * lists, brochures, prospectuses), Word documents (policies, course outlines), and plain text or
 * Markdown. Spreadsheets and slides are not read - a table of prices without its headings is
 * worse than nothing, and the honest answer is "paste it into Key facts".
 *
 * The output is Markdown-ish text the chunker already understands: DOCX headings become `#`
 * lines so a passage carries the heading it sits under; PDF pages are separated by a blank line.
 * A PDF that yields no text is a scanned one, and the caller is told so rather than indexing an
 * empty document.
 */

export const MAX_FILE_TEXT_CHARS = 200_000;

export type ReadableFileType =
  | 'application/pdf'
  | 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  | 'text/plain'
  | 'text/csv'
  | 'text/markdown';

export function readableFileType(contentType: string): ReadableFileType | null {
  switch (contentType) {
    case 'application/pdf':
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    case 'text/plain':
    case 'text/csv':
    case 'text/markdown':
      return contentType;
    default:
      return null;
  }
}

export class UnreadableFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnreadableFileError';
  }
}

export async function extractFileText(bytes: Uint8Array, contentType: ReadableFileType): Promise<string> {
  let text: string;
  switch (contentType) {
    case 'application/pdf':
      text = await fromPdf(bytes);
      break;
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      text = await fromDocx(bytes);
      break;
    default:
      text = fromText(bytes);
  }
  const cleaned = tidy(text);
  if (cleaned.length < 20) {
    throw new UnreadableFileError(
      contentType === 'application/pdf'
        ? 'No text could be read from this PDF. If it is a scan, it has no text to read - export it again from the original document.'
        : 'The file has no readable text.',
    );
  }
  return cleaned.slice(0, MAX_FILE_TEXT_CHARS);
}

async function fromPdf(bytes: Uint8Array): Promise<string> {
  let pdf;
  try {
    // pdf.js insists on a plain Uint8Array; a Node Buffer is one, but it checks the constructor.
    pdf = await getDocumentProxy(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  } catch (error) {
    throw new UnreadableFileError(`The PDF could not be opened${describe(error)}.`);
  }
  try {
    const result = await extractText(pdf, { mergePages: false });
    return result.text.map((page) => page.trim()).filter((page) => page.length > 0).join('\n\n');
  } catch (error) {
    throw new UnreadableFileError(`The PDF could not be read${describe(error)}.`);
  } finally {
    await pdf.cleanup().catch(() => undefined);
  }
}

async function fromDocx(bytes: Uint8Array): Promise<string> {
  try {
    // HTML, then the same walk the crawler uses, so headings and lists come out the same way.
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) });
    return htmlToText(result.value);
  } catch (error) {
    throw new UnreadableFileError(`The document could not be read${describe(error)}.`);
  }
}

function fromText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return text.replace(/^\uFEFF/, '');
}

/** Whitespace as the chunker likes it: no trailing spaces, at most one blank line in a row. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex -- stripping control characters is the point
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return message ? ` (${message.slice(0, 120)})` : '';
}
