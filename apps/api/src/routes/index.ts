import type { FastifyInstance } from 'fastify';
import type { Container } from '../container.js';
import { accountRoutes } from './account.routes.js';
import { authRoutes } from './auth.routes.js';
import { automationRoutes } from './automation.routes.js';
import { billingRoutes, publicPlanRoutes } from './billing.routes.js';
import { contactRoutes } from './contact.routes.js';
import { conversationRoutes } from './conversation.routes.js';
import { integrationRoutes } from './integration.routes.js';
import { kbRoutes, publicKbRoutes } from './kb.routes.js';
import { platformRoutes } from './platform.routes.js';
import { propertyRoutes } from './property.routes.js';
import { reportRoutes } from './report.routes.js';
import { teamRoutes } from './team.routes.js';
import { ticketRoutes } from './ticket.routes.js';
import { uploadRoutes } from './upload.routes.js';
import { widgetRoutes } from './widget.routes.js';

/**
 * All versioned routes mount under `/api/v1`.
 *
 * `/api/v1` is a contract: additive changes are fine, breaking ones get a `/api/v2`.
 */
export async function registerRoutes(app: FastifyInstance, container: Container): Promise<void> {
  await app.register(
    async (v1) => {
      await authRoutes(v1, container);
      await accountRoutes(v1, container);
      // The widget surface is registered in its own scope: it must NOT inherit the dashboard's
      // authenticateTenant hook, because visitors have no session and no account membership.
      await v1.register(async (scoped) => widgetRoutes(scoped, container));
      await v1.register(async (scoped) => propertyRoutes(scoped, container));
      await v1.register(async (scoped) => conversationRoutes(scoped, container));
      await v1.register(async (scoped) => teamRoutes(scoped, container));
      await v1.register(async (scoped) => automationRoutes(scoped, container));
      await v1.register(async (scoped) => contactRoutes(scoped, container));
      await v1.register(async (scoped) => uploadRoutes(scoped, container));
      await v1.register(async (scoped) => kbRoutes(scoped, container));
      await v1.register(async (scoped) => ticketRoutes(scoped, container));
      await v1.register(async (scoped) => reportRoutes(scoped, container));
      await v1.register(async (scoped) => integrationRoutes(scoped, container));
      await v1.register(async (scoped) => billingRoutes(scoped, container));
      // The pricing page is read by strangers, so this gets its own scope with no auth hook -
      // the same reasoning as the public help centre below.
      await v1.register(async (scoped) => publicPlanRoutes(scoped, container));
      // The platform console: its own scope, its own cookie, its own principal. It must not
      // inherit the tenant authentication hook, and a tenant session must never reach it.
      await v1.register(async (scoped) => platformRoutes(scoped, container));
      // The public help centre gets its own scope with no auth hook. Registering it alongside the
      // authenticated routes and relying on the hook to be skipped would be one edit away from
      // exposing drafts.
      await v1.register(async (scoped) => publicKbRoutes(scoped, container));
    },
    { prefix: '/api/v1' },
  );
}
