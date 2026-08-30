import { z } from 'zod';
import { uuidSchema } from './common.js';

/**
 * The reporting contract.
 *
 * Dates are plain `YYYY-MM-DD`, not timestamps. A report is asked for in days, and the days are
 * the account's own - accepting an instant would invite a client to send its browser's midnight
 * and get back a window nobody worked.
 */
export const daySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)), 'That is not a date');

export const MAX_RANGE_DAYS = 366;

const range = z
  .object({
    from: daySchema,
    to: daySchema,
  })
  .refine((value) => Date.parse(value.from) <= Date.parse(value.to), {
    message: 'The range starts after it ends',
    path: ['from'],
  })
  .refine(
    (value) => (Date.parse(value.to) - Date.parse(value.from)) / 86_400_000 + 1 <= MAX_RANGE_DAYS,
    { message: `A report covers at most ${MAX_RANGE_DAYS} days`, path: ['to'] },
  );

export const overviewReportSchema = z.intersection(
  range,
  z.object({ propertyId: uuidSchema.optional() }),
);

export const agentReportSchema = range;

export const articleReportSchema = z.object({
  propertyId: uuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const rebuildReportSchema = range;

export type OverviewReportInput = z.infer<typeof overviewReportSchema>;
export type AgentReportInput = z.infer<typeof agentReportSchema>;
export type ArticleReportInput = z.infer<typeof articleReportSchema>;
export type RebuildReportInput = z.infer<typeof rebuildReportSchema>;
