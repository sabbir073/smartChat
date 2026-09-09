import { z } from 'zod';
import { uuidSchema } from './common.js';

/**
 * The AI agent, from both sides: what an account may configure for a website, and what the
 * operator may configure for the installation.
 */

export const aiModeSchema = z.enum(['team', 'ai_when_offline', 'ai']);
export type AiMode = z.infer<typeof aiModeSchema>;

/** A single line the widget shows as the sender name. */
const assistantNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^\n\r<>]+$/, 'Letters, numbers and punctuation only');

/**
 * What the owner may change. Everything is optional so the inbox's mode selector can send
 * `{ mode }` alone. Texts are bounded because every one of them ends up inside a prompt or a
 * chat bubble, and neither has room for an essay.
 */
export const updateAiSettingsSchema = z
  .object({
    mode: aiModeSchema.optional(),
    assistantName: assistantNameSchema.optional(),
    instructions: z.string().trim().max(2_000).optional(),
    keyFacts: z.string().trim().max(20_000).optional(),
    ticketOfferText: z.string().trim().min(10).max(500).optional(),
    handoffText: z.string().trim().min(10).max(500).optional(),
    maxRepliesPerConversation: z.number().int().min(1).max(500).optional(),
    /** How many pages one website sync reads. */
    crawlMaxPages: z.number().int().min(1).max(1_000).optional(),
    /** Paths the sync skips: `/blog/*`, `/cart`, `*.pdf`. */
    crawlExclude: z
      .array(z.string().trim().min(1).max(200).regex(/^[^\s<>"']+$/, 'One path pattern per line, no spaces'))
      .max(50)
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change');
export type UpdateAiSettingsInput = z.infer<typeof updateAiSettingsSchema>;

export const aiPropertyParamSchema = z.object({ id: uuidSchema });
export const aiFileParamSchema = z.object({ id: uuidSchema, fileId: uuidSchema });

/** Step one of a knowledge-file upload: the claimed name and size. Both are checked again on confirm. */
export const signKnowledgeFileSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  byteSize: z.number().int().positive().max(10 * 1024 * 1024),
});
export type SignKnowledgeFileInput = z.infer<typeof signKnowledgeFileSchema>;

// --- operator side ----------------------------------------------------------

export const aiFallbackProviderSchema = z.enum(['none', 'openai', 'deepseek']);

/**
 * The operator's AI settings. As with billing, an omitted secret is kept and `null` clears it.
 */
export const updateAiPlatformSettingsSchema = z
  .object({
    fallbackProvider: aiFallbackProviderSchema.optional(),
    fallbackApiKey: z.string().trim().min(8).max(500).nullable().optional(),
    fallbackModel: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[A-Za-z0-9._:/-]+$/, 'A model name, like gpt-4o-mini')
      .nullable()
      .optional(),
    localTimeoutMs: z.number().int().min(5_000).max(120_000).optional(),
    routing: z.enum(['local_first', 'fallback_only']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change');
export type UpdateAiPlatformSettingsInput = z.infer<typeof updateAiPlatformSettingsSchema>;
