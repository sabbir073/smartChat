import { z } from 'zod';
import { uuidSchema } from './common.js';

/**
 * Voice calls: what an owner may configure for a website, and what the two sides of a call may
 * ask for. The shapes are small on purpose - a call is a state machine, and every request is a
 * single transition on it.
 */

export const voiceLanguageSchema = z.enum(['en', 'bn']);

/** A thing the AI says on a call. Short: it is spoken, and a visitor is waiting. */
const phraseSchema = z.string().trim().min(2).max(400);

const voicePhraseKeys = [
  'greeting',
  'holdOn',
  'stillChecking',
  'afterWait',
  'ticketOffer',
  'ticketAskEmail',
  'ticketCreated',
  'ticketDeclined',
  'handoff',
  'handoffFailed',
  'noAgent',
  'stillThere',
  'goodbye',
  'maxLength',
] as const;

export const voicePhrasesSchema = z
  .object(
    Object.fromEntries(
      voicePhraseKeys.map((key) => [
        key,
        z.object({ en: phraseSchema.optional(), bn: phraseSchema.optional() }).strict().optional(),
      ]),
    ) as Record<
      (typeof voicePhraseKeys)[number],
      z.ZodOptional<z.ZodObject<{ en: z.ZodOptional<z.ZodString>; bn: z.ZodOptional<z.ZodString> }>>
    >,
  )
  .strict();

/** The speech service's voice ids: letters, digits and underscores, nothing it would not list. */
const voiceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9_]+$/i, 'Not a voice id');

export const updateVoiceSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    ringSeconds: z.number().int().min(5).max(120).optional(),
    aiAnswers: z.boolean().optional(),
    aiMaxSeconds: z.number().int().min(60).max(3_600).optional(),
    defaultLanguage: voiceLanguageSchema.optional(),
    voiceEn: voiceIdSchema.optional(),
    voiceBn: voiceIdSchema.optional(),
    voiceBnSpeaker: z.number().int().min(0).max(63).optional(),
    phrases: voicePhrasesSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Nothing to change');
export type UpdateVoiceSettingsInput = z.infer<typeof updateVoiceSettingsSchema>;

/**
 * The visitor presses Call. The pre-chat answers travel with it when the form was shown first;
 * they are sanitised against the website's configuration server-side, exactly as for a chat.
 */
export const startCallSchema = z.object({
  preChat: z.record(z.string().max(60), z.string().max(2000)).optional(),
  /** The language the widget is showing, so the AI greets in it before hearing a word. */
  language: voiceLanguageSchema.optional(),
});
export type StartCallInput = z.infer<typeof startCallSchema>;

export const callParamSchema = z.object({ id: uuidSchema });

/** A transfer goes to exactly one colleague, or to the AI. */
export const transferCallSchema = z.discriminatedUnion('to', [
  z.object({ to: z.literal('member'), memberId: uuidSchema }),
  z.object({ to: z.literal('ai') }),
]);
export type TransferCallInput = z.infer<typeof transferCallSchema>;

export const listCallsSchema = z.object({
  propertyId: uuidSchema.optional(),
  status: z.enum(['ringing', 'connecting', 'active', 'ended']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ListCallsInput = z.infer<typeof listCallsSchema>;
