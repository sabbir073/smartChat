import { z } from 'zod';
import { paginationSchema, uuidSchema } from './common.js';

/**
 * Message and conversation contracts, shared by the API, the realtime gateway, the widget and the
 * dashboard - so a message that one accepts is a message the others understand.
 */

/** The longest a single message may be. Generous for a person, bounded against abuse. */
export const MESSAGE_MAX_LENGTH = 8000;

/**
 * Client-generated message id.
 *
 * A ULID from the sender. It is what makes a retry after a lost acknowledgement idempotent rather
 * than a duplicate, which is what makes reconnect-and-resend safe.
 */
export const clientMessageIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/, 'Invalid message id');

export const messageBodySchema = z
  .string()
  .min(1, 'Type a message first')
  .max(MESSAGE_MAX_LENGTH, 'That message is too long')
  // Trailing whitespace is trimmed but interior newlines are preserved: people format messages.
  .transform((value) => value.replace(/[ \t]+$/gm, '').trim())
  .refine((value) => value.length > 0, 'Type a message first');

export const sendMessageSchema = z.object({
  clientMessageId: clientMessageIdSchema,
  body: messageBodySchema,
  type: z.enum(['text', 'note']).default('text'),
});

export const startConversationSchema = z.object({
  clientMessageId: clientMessageIdSchema,
  body: messageBodySchema,
  /** Whatever the configured pre-chat form collected. Keys are validated against the config. */
  preChat: z.record(z.string().max(60), z.string().max(2000)).optional(),
});

export const listMessagesSchema = z.object({
  /** Keyset cursor: the lowest `seq` already held by the client. */
  beforeSeq: z.coerce.number().int().min(0).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const syncSinceSchema = z.object({
  conversationId: uuidSchema,
  lastSeq: z.coerce.number().int().min(0).default(0),
});

export const listConversationsSchema = paginationSchema.extend({
  status: z.enum(['open', 'pending', 'closed']).optional(),
  propertyId: uuidSchema.optional(),
  assignedMemberId: uuidSchema.optional(),
  /** `me` is resolved server-side from the caller's membership; never trusted from the client. */
  assigned: z.enum(['me', 'unassigned', 'any']).optional(),
  search: z.string().trim().max(120).optional(),
  /** Repeatable `tag` parameter. A conversation must carry every tag asked for, not any of them. */
  tags: z
    .union([z.string(), z.array(z.string())])
    .transform((value) => (Array.isArray(value) ? value : [value]))
    .pipe(z.array(z.string().trim().min(1).max(40)).max(10))
    .optional(),
});

export const updateConversationSchema = z.object({
  status: z.enum(['open', 'pending', 'closed']).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(30).optional(),
  subject: z.string().trim().max(200).nullable().optional(),
});

export const assignConversationSchema = z.object({
  /** null unassigns. */
  memberId: uuidSchema.nullable(),
});

export const markReadSchema = z.object({
  seq: z.coerce.number().int().min(0),
});

export const typingSchema = z.object({
  conversationId: uuidSchema,
});

export type SendMessageInput = z.infer<typeof sendMessageSchema>;
export type StartConversationInput = z.infer<typeof startConversationSchema>;
export type ListMessagesInput = z.infer<typeof listMessagesSchema>;
export type ListConversationsInput = z.infer<typeof listConversationsSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
export type AssignConversationInput = z.infer<typeof assignConversationSchema>;
