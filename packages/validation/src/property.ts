import { z } from 'zod';
import {
  domainPatternSchema,
  localeSchema,
  paginationSchema,
  timezoneSchema,
  websiteUrlSchema,
} from './common.js';

export const createPropertySchema = z.object({
  name: z.string().trim().min(1, 'Give this website a name').max(120),
  websiteUrl: websiteUrlSchema,
  timezone: timezoneSchema.default('UTC'),
  locale: localeSchema.default('en'),
});

export const updatePropertySchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  websiteUrl: websiteUrlSchema.optional(),
  timezone: timezoneSchema.optional(),
  locale: localeSchema.optional(),
  status: z.enum(['active', 'paused']).optional(),
  enforceDomains: z.boolean().optional(),
});

export const listPropertiesSchema = paginationSchema.extend({
  search: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'paused']).optional(),
});

export const addDomainSchema = z.object({
  pattern: domainPatternSchema,
});

export type CreatePropertyInput = z.infer<typeof createPropertySchema>;
export type UpdatePropertyInput = z.infer<typeof updatePropertySchema>;
export type ListPropertiesInput = z.infer<typeof listPropertiesSchema>;
export type AddDomainInput = z.infer<typeof addDomainSchema>;
