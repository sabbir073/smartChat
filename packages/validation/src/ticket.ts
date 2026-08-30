import { z } from 'zod';
import { emailSchema, paginationSchema, uuidSchema } from './common.js';

/**
 * The ticket contract.
 *
 * The shape that matters most here is `replyToTicketSchema`: `visibility` is a required, explicit
 * choice with no default. A default of `public` would eventually send somebody's internal note to
 * a customer because a caller forgot a field, and a default of `internal` would quietly swallow
 * replies. Neither failure is acceptable, so the caller has to say which it is.
 */

export const ticketStatusSchema = z.enum(['open', 'pending', 'resolved', 'closed']);
export const ticketPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export const ticketVisibilitySchema = z.enum(['public', 'internal']);

export const ticketSubjectSchema = z.string().trim().min(1).max(200);
export const ticketBodySchema = z.string().trim().min(1).max(20_000);

export const createTicketSchema = z.object({
  propertyId: uuidSchema,
  subject: ticketSubjectSchema,
  body: ticketBodySchema,
  requesterEmail: emailSchema,
  requesterName: z.string().trim().min(1).max(120).nullable().default(null),
  priority: ticketPrioritySchema.default('normal'),
  assignedMemberId: uuidSchema.nullable().default(null),
  departmentId: uuidSchema.nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
  /**
   * Whether the requester is told their ticket exists.
   *
   * An agent logging a phone call has already spoken to the person; emailing them a receipt for a
   * conversation they just had is noise. So it is a choice, and it defaults to sending, because
   * silence is the more surprising outcome.
   */
  notifyRequester: z.boolean().default(true),
});

export const updateTicketSchema = z
  .object({
    subject: ticketSubjectSchema.optional(),
    status: ticketStatusSchema.optional(),
    priority: ticketPrioritySchema.optional(),
    assignedMemberId: uuidSchema.nullable().optional(),
    departmentId: uuidSchema.nullable().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const replyToTicketSchema = z.object({
  body: ticketBodySchema,
  /** No default. See the note at the top of this file. */
  visibility: ticketVisibilitySchema,
});

export const listTicketsSchema = paginationSchema.extend({
  status: ticketStatusSchema.optional(),
  priority: ticketPrioritySchema.optional(),
  propertyId: uuidSchema.optional(),
  assignedMemberId: uuidSchema.optional(),
  /** `me` is resolved server-side from the caller's membership, never sent by the client. */
  assigned: z.enum(['me', 'unassigned']).optional(),
  contactId: uuidSchema.optional(),
  search: z.string().trim().min(1).max(120).optional(),
});

export type CreateTicketInput = z.infer<typeof createTicketSchema>;
export type UpdateTicketInput = z.infer<typeof updateTicketSchema>;
export type ReplyToTicketInput = z.infer<typeof replyToTicketSchema>;
export type ListTicketsInput = z.infer<typeof listTicketsSchema>;

/**
 * A subject for a ticket nobody wrote a subject for.
 *
 * Offline messages arrive as a body and nothing else. "Re: your message" tells an agent nothing in
 * a queue of two hundred, so the first line of what the person actually wrote is used instead -
 * trimmed at a word boundary, because a subject cut mid-word reads as a bug.
 */
export function subjectFromBody(body: string, limit = 80): string {
  const firstLine = body
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return 'New message';
  if (firstLine.length <= limit) return firstLine;
  const clipped = firstLine.slice(0, limit);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > limit / 2 ? clipped.slice(0, lastSpace) : clipped).trimEnd()}…`;
}
