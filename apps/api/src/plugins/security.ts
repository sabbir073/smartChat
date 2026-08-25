import cookie from '@fastify/cookie';
import cors, { type FastifyCorsOptions } from '@fastify/cors';
import helmet from '@fastify/helmet';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiConfig } from '../config.js';

const WIDGET_PREFIX = '/api/v1/widget';

/**
 * Transport-level hardening.
 *
 * CORS is split deliberately, because the two surfaces have opposite requirements:
 *
 * - The **dashboard** sends cookies, so it must have a strict origin allowlist. `credentials:true`
 *   with a permissive origin is the classic way to hand an attacker's page an authenticated
 *   session, and the browser refuses the combination anyway.
 * - The **widget** runs on customer websites whose domains we cannot enumerate, so it must accept
 *   any origin - and therefore must not use cookies at all. It authenticates with a bearer token
 *   instead, and each request is separately checked against the property's allowed-domain list.
 */
export const securityPlugin = fp<{ config: ApiConfig }>(
  async (app, options) => {
    const { config } = options;

    await app.register(cookie, {
      parseOptions: { sameSite: 'lax', path: '/' },
    });

    await app.register(helmet, {
      // The API serves JSON, never HTML, so a restrictive CSP costs nothing here.
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts:
        config.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    });

    const dashboardOrigins = new Set(
      config.CORS_DASHBOARD_ORIGINS.length > 0 ? config.CORS_DASHBOARD_ORIGINS : [config.APP_URL],
    );

    type CorsCallback = (error: Error | null, options: FastifyCorsOptions) => void;

    await app.register(cors, (instance: FastifyInstance) => {
      void instance;
      return (request: FastifyRequest, callback: CorsCallback) => {
        const origin = request.headers.origin;
        const isWidget = request.url.startsWith(WIDGET_PREFIX);

        if (isWidget) {
          return callback(null, {
            origin: true,
            // Never. The widget must not be able to send the dashboard's cookies.
            credentials: false,
            maxAge: 600,
            allowedHeaders: ['content-type', 'authorization', 'x-request-id'],
            exposedHeaders: ['x-request-id', 'retry-after'],
            methods: ['GET', 'POST', 'OPTIONS'],
          });
        }

        // Same-origin and non-browser callers send no Origin header at all.
        const allowed = !origin || dashboardOrigins.has(origin);
        return callback(null, {
          origin: allowed ? true : false,
          credentials: true,
          maxAge: 600,
          allowedHeaders: [
            'content-type',
            'x-csrf-token',
            'x-account-id',
            'x-request-id',
            'authorization',
          ],
          exposedHeaders: ['x-request-id', 'retry-after'],
          methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
        });
      };
    });
  },
  { name: 'security' },
);
