import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import fp from 'fastify-plugin';
import type { ApiConfig } from '../config.js';

/**
 * Transport-level hardening.
 *
 * CORS is split deliberately: the dashboard surface is locked to a known origin list, while the
 * widget surface has to accept requests from any customer website and is instead protected by
 * per-property origin validation inside the handler.
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
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
      hsts:
        config.NODE_ENV === 'production' ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    });

    const dashboardOrigins = new Set(
      config.CORS_DASHBOARD_ORIGINS.length > 0 ? config.CORS_DASHBOARD_ORIGINS : [config.APP_URL],
    );

    await app.register(cors, {
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
      origin(origin, callback) {
        // Same-origin and non-browser callers send no Origin header at all.
        if (!origin) return callback(null, true);
        if (dashboardOrigins.has(origin)) return callback(null, true);
        // The widget surface validates origin per property; a blanket allow here would defeat
        // that, so anything unknown is simply not granted CORS.
        return callback(null, false);
      },
    });
  },
  { name: 'security' },
);
