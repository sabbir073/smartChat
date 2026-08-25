import { z } from 'zod';
import { emailSchema, publicIdSchema } from './common.js';

/**
 * Everything a visitor's browser is allowed to tell us.
 *
 * All of it is a claim, none of it is a credential: it populates the agent's sidebar and nothing
 * else. Sizes are bounded so a hostile page cannot use the widget endpoint as a storage service.
 */

const urlSchema = z.string().trim().max(2048);

export const widgetBootstrapSchema = z.object({
  p: publicIdSchema,
  token: z.string().max(4096).optional(),
  page: z
    .object({
      url: urlSchema.optional(),
      title: z.string().trim().max(300).optional(),
      referrer: urlSchema.optional(),
    })
    .optional(),
  screen: z
    .object({
      width: z.number().int().min(0).max(20000).optional(),
      height: z.number().int().min(0).max(20000).optional(),
    })
    .optional(),
  language: z.string().trim().max(35).optional(),
  timezone: z.string().trim().max(64).optional(),
});

export const widgetPageViewSchema = z.object({
  url: urlSchema.min(1),
  title: z.string().trim().max(300).optional(),
  referrer: urlSchema.optional(),
});

export const widgetIdentifySchema = z.object({
  name: z.string().trim().max(120).optional(),
  email: emailSchema.optional(),
  phone: z.string().trim().max(40).optional(),
  externalId: z.string().trim().max(120).optional(),
});

export const widgetConfigQuerySchema = z.object({
  p: publicIdSchema,
});

export type WidgetBootstrapInput = z.infer<typeof widgetBootstrapSchema>;
export type WidgetPageViewInput = z.infer<typeof widgetPageViewSchema>;
export type WidgetIdentifyInput = z.infer<typeof widgetIdentifySchema>;
