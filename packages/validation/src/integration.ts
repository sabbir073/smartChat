import { z } from 'zod';
import { API_SCOPE_VALUES, WEBHOOK_EVENT_VALUES } from '@smartchat/types';
import { uuidSchema } from './common.js';

/**
 * The integration contract.
 *
 * The interesting rule is `webhookUrlSchema`. A webhook URL is an address this server will make an
 * outbound request to, on a schedule the account controls - which is a server-side request forgery
 * primitive if it is left open. So it is an allow-list of shape: https only, a public-looking host,
 * and no attempt to name the machinery this product runs on.
 */

const PRIVATE_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  // The services on this compose network. Named explicitly, because a webhook pointed at them
  // would let an account make this server talk to its own internals.
  'postgres',
  'redis',
  'minio',
  'api',
  'realtime',
  'worker',
  'web',
  'widget',
  'mailpit',
]);

/** Link-local, loopback, and the RFC1918 ranges, as literal-IP text. */
const PRIVATE_IP =
  /^(?:10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i;

export const webhookUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    // http:// would send a signed payload - and whatever it contains about a customer - across
    // the internet in clear text. The signature proves who sent it; it does not hide it.
    if (url.protocol !== 'https:') return false;
    const host = url.hostname.toLowerCase();
    if (PRIVATE_HOSTS.has(host)) return false;
    if (PRIVATE_IP.test(host)) return false;
    // A host with no dot is a name only this network can resolve.
    if (!host.includes('.')) return false;
    return true;
  }, 'Use an https:// address on a public host');

/**
 * The same rule, relaxed for development.
 *
 * A test receiver has to run somewhere, and in development that somewhere is this machine. This is
 * enabled by configuration, never by a request, and the production compose file does not set it.
 */
export const developmentWebhookUrlSchema = z
  .string()
  .trim()
  .max(2000)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' || url.protocol === 'http:';
    } catch {
      return false;
    }
  }, 'Use a valid URL');

export const createApiKeySchema = z.object({
  name: z.string().trim().min(1).max(80),
  scopes: z
    .array(z.enum(API_SCOPE_VALUES as [string, ...string[]]))
    .min(1, 'A key with no scopes can do nothing')
    .max(API_SCOPE_VALUES.length),
  propertyIds: z.array(uuidSchema).max(50).default([]),
  /** ISO date. Optional, and worth encouraging: a key that never expires never gets rotated. */
  expiresAt: z.string().datetime().nullable().default(null),
});

export const createWebhookSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: webhookUrlSchema,
  events: z
    .array(z.enum(WEBHOOK_EVENT_VALUES as [string, ...string[]]))
    .min(1, 'Choose at least one event')
    .max(WEBHOOK_EVENT_VALUES.length),
  enabled: z.boolean().default(true),
});

/**
 * The updatable fields, before the "did you actually change anything" refinement.
 *
 * Exported separately because `.refine()` produces a `ZodEffects`, which has no `.extend()` - and
 * the API needs to swap in the relaxed URL rule for development. Without this the relaxation
 * covered create and not update, so in development you could point a webhook at a local receiver
 * when you made it and then never move it.
 */
export const updateWebhookFields = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  url: webhookUrlSchema.optional(),
  events: z
    .array(z.enum(WEBHOOK_EVENT_VALUES as [string, ...string[]]))
    .min(1)
    .optional(),
  enabled: z.boolean().optional(),
});

export const notEmpty = (value: object): boolean => Object.keys(value).length > 0;

export const updateWebhookSchema = updateWebhookFields.refine(notEmpty, 'Nothing to update');

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;
export type CreateWebhookInput = z.infer<typeof createWebhookSchema>;
export type UpdateWebhookInput = z.infer<typeof updateWebhookSchema>;
