import { z } from 'zod';
import { uuidSchema } from './common.js';

/**
 * The knowledge base contract.
 *
 * Article bodies are markdown, stored exactly as written. Nothing is stripped or rewritten on the
 * way in - the same rule a message body follows, and for the same reason: the record of what
 * somebody wrote stays intact, and the decision about what a browser is shown belongs at render
 * time, where the escaping is.
 */

export const kbSlugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2)
  .max(80)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase letters, numbers and hyphens');

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: kbSlugSchema.optional(),
  description: z.string().trim().max(300).nullable().default(null),
  position: z.number().int().min(0).max(999).default(0),
});

export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    slug: kbSlugSchema.optional(),
    description: z.string().trim().max(300).nullable().optional(),
    position: z.number().int().min(0).max(999).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const createArticleSchema = z.object({
  title: z.string().trim().min(1).max(160),
  slug: kbSlugSchema.optional(),
  excerpt: z.string().trim().max(300).nullable().default(null),
  body: z.string().min(1).max(100_000),
  categoryId: uuidSchema.nullable().default(null),
  status: z.enum(['draft', 'published']).default('draft'),
});

export const updateArticleSchema = z
  .object({
    title: z.string().trim().min(1).max(160).optional(),
    slug: kbSlugSchema.optional(),
    excerpt: z.string().trim().max(300).nullable().optional(),
    body: z.string().min(1).max(100_000).optional(),
    categoryId: uuidSchema.nullable().optional(),
    status: z.enum(['draft', 'published']).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, 'Nothing to update');

export const listArticlesSchema = z.object({
  status: z.enum(['draft', 'published']).optional(),
  categoryId: uuidSchema.optional(),
  search: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const publicKbSearchSchema = z.object({
  q: z.string().trim().min(2).max(120).optional(),
  category: kbSlugSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
export type CreateArticleInput = z.infer<typeof createArticleSchema>;
export type UpdateArticleInput = z.infer<typeof updateArticleSchema>;
export type ListArticlesInput = z.infer<typeof listArticlesSchema>;
export type PublicKbSearchInput = z.infer<typeof publicKbSearchSchema>;

/**
 * Turn a title into a URL segment.
 *
 * Only used to *suggest* one when the author has not written their own. A slug is part of a public
 * address, so once an article is published its slug is the author's to change and nobody else's -
 * regenerating it from a retitled article would break every link anybody had shared.
 */
export function slugifyTitle(title: string): string {
  const slug = title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : 'article';
}
