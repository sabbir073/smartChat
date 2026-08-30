import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createArticleSchema,
  createCategorySchema,
  listArticlesSchema,
  publicKbSearchSchema,
  updateArticleSchema,
  updateCategorySchema,
} from '@smartchat/validation';
import type { Container } from '../container.js';
import { requireTenant } from '../plugins/auth.js';
import { created, noContent, ok } from '../lib/reply.js';
import { parseBody, parseParams, parseQuery } from '../lib/validate.js';
import { toArticleDto, toCategoryDto } from './dto.js';

const idParam = z.object({ id: z.string().uuid() });
const propertyParam = z.object({ propertyId: z.string().uuid() });

/**
 * The knowledge base, for the people who write it.
 *
 * Tenant-scoped by the preHandler, and property-scoped inside the service: a restricted agent
 * cannot read or write articles for a website they do not work on. The public surface is a
 * separate function below, deliberately outside this scope.
 */
export async function kbRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.addHook('preHandler', app.authenticateTenant);

  app.get('/kb/:propertyId/categories', async (request, reply) => {
    const tenant = requireTenant(request);
    const { propertyId } = parseParams(propertyParam, request.params);
    const categories = await container.kb.listCategories(tenant, propertyId);
    return ok(reply, categories.map(toCategoryDto));
  });

  app.post('/kb/:propertyId/categories', async (request, reply) => {
    const tenant = requireTenant(request);
    const { propertyId } = parseParams(propertyParam, request.params);
    const input = parseBody(createCategorySchema, request.body);
    const category = await container.kb.createCategory(tenant, propertyId, input);
    return created(reply, toCategoryDto(category));
  });

  app.patch('/kb/categories/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updateCategorySchema, request.body);
    return ok(reply, toCategoryDto(await container.kb.updateCategory(tenant, id, input)));
  });

  app.delete('/kb/categories/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.kb.deleteCategory(tenant, id);
    return noContent(reply);
  });

  app.get('/kb/:propertyId/articles', async (request, reply) => {
    const tenant = requireTenant(request);
    const { propertyId } = parseParams(propertyParam, request.params);
    const query = parseQuery(listArticlesSchema, request.query);
    const articles = await container.kb.listArticles(tenant, propertyId, query);
    return ok(reply, articles.map(toArticleDto));
  });

  app.post('/kb/:propertyId/articles', async (request, reply) => {
    const tenant = requireTenant(request);
    const { propertyId } = parseParams(propertyParam, request.params);
    const input = parseBody(createArticleSchema, request.body);
    const article = await container.kb.createArticle(tenant, propertyId, input);
    return created(reply, toArticleDto(article));
  });

  app.get('/kb/articles/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    return ok(reply, toArticleDto(await container.kb.getArticle(tenant, id)));
  });

  app.patch('/kb/articles/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updateArticleSchema, request.body);
    return ok(reply, toArticleDto(await container.kb.updateArticle(tenant, id, input)));
  });

  app.delete('/kb/articles/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.kb.deleteArticle(tenant, id);
    return noContent(reply);
  });
}

/**
 * The public help centre.
 *
 * Registered in its own scope with no authentication hook at all - not "authentication that
 * usually passes", none. It is keyed by a property's public id, which authorises nothing, and it
 * can only ever read published rows. The shapes it returns carry no ids, no author and no
 * counters, so there is nothing internal to leak even by accident.
 */
export async function publicKbRoutes(app: FastifyInstance, container: Container): Promise<void> {
  const publicIdParam = z.object({
    publicId: z.string().regex(/^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{12,32}$/),
  });

  app.get('/public/kb/:publicId', async (request, reply) => {
    await app.rateLimit(request, 'widgetSession');
    const { publicId } = parseParams(publicIdParam, request.params);
    const index = await container.kb.publicIndex(publicId);
    // Cacheable: identical for every reader, and a help centre that is a minute stale is fine.
    reply.header('cache-control', 'public, max-age=60, stale-while-revalidate=300');
    return ok(reply, index);
  });

  app.get('/public/kb/:publicId/search', async (request, reply) => {
    await app.rateLimit(request, 'widgetSession');
    const { publicId } = parseParams(publicIdParam, request.params);
    const query = parseQuery(publicKbSearchSchema, request.query);
    const results = await container.kb.publicSearch(publicId, query);
    reply.header('cache-control', 'public, max-age=30');
    return ok(reply, results);
  });

  app.get('/public/kb/:publicId/articles/:slug', async (request, reply) => {
    await app.rateLimit(request, 'widgetSession');
    const params = parseParams(
      publicIdParam.extend({ slug: z.string().min(1).max(80) }),
      request.params,
    );
    const article = await container.kb.publicArticle(params.publicId, params.slug);
    reply.header('cache-control', 'public, max-age=60, stale-while-revalidate=300');
    return ok(reply, article);
  });
}
