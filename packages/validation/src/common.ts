import { z } from 'zod';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '@smartchat/types';

export const uuidSchema = z.string().uuid();

export const publicIdSchema = z
  .string()
  .regex(/^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{12,32}$/, 'Invalid public identifier');

export const cursorSchema = z.string().min(1).max(512);

export const paginationSchema = z.object({
  cursor: cursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(254)
  .email('Enter a valid email address');

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(120, 'Name is too long');

/**
 * IANA timezone. Validated against the runtime's own database rather than a hardcoded list, so it
 * stays correct as zones change.
 */
export const timezoneSchema = z.string().refine((value) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}, 'Unknown timezone');

export const localeSchema = z
  .string()
  .regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'Locale must look like "en" or "en-US"');

/** A website URL a customer pastes in. http/https only — no javascript:, data: or file:. */
export const websiteUrlSchema = z
  .string()
  .trim()
  .min(1, 'Enter your website address')
  .max(2048)
  .transform((value) => (/^https?:\/\//i.test(value) ? value : `https://${value}`))
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname.includes('.');
    } catch {
      return false;
    }
  }, 'Enter a valid website address, for example https://example.com');

/**
 * Allowed-domain pattern: an exact host, or a single leading wildcard label.
 * `localhost` and loopback addresses are accepted so development installs work.
 */
export const domainPatternSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(253)
  .refine((value) => {
    if (value === 'localhost' || value === '127.0.0.1' || value === '[::1]') return true;
    const host = value.startsWith('*.') ? value.slice(2) : value;
    if (host.length === 0 || host.length > 253) return false;
    if (host.includes('*')) return false;
    return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host);
  }, 'Enter a domain like example.com or *.example.com');

export const hexColorSchema = z
  .string()
  .regex(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/, 'Enter a colour like #2F6FED');

/** Trimmed, length-bounded free text. Content is stored raw and escaped at render. */
export function textSchema(max: number, min = 0) {
  return z.string().trim().min(min).max(max);
}
