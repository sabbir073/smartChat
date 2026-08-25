import type { FastifyInstance } from 'fastify';
import type { Container } from '../container.js';
import { accountRoutes } from './account.routes.js';
import { authRoutes } from './auth.routes.js';
import { conversationRoutes } from './conversation.routes.js';
import { propertyRoutes } from './property.routes.js';
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
    },
    { prefix: '/api/v1' },
  );
}
