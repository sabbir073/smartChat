import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emits a minimal server bundle with only the files actually needed, which is what keeps the
  // production image small without hand-pruning node_modules.
  /**
   * Standalone output only inside the Docker build.
   *
   * Producing it recreates pnpm's symlinked node_modules layout, and creating symlinks on Windows
   * requires elevation or Developer Mode - so a plain `pnpm build` on a developer machine would
   * fail with EPERM. The production image is built on Linux, which is the only place this output
   * is actually used.
   */
  ...(process.env['NEXT_OUTPUT_STANDALONE'] === '1'
    ? {
        output: 'standalone',
        // Tracing must start at the workspace root, or the bundle misses @smartchat/*.
        outputFileTracingRoot: path.join(here, '../../'),
      }
    : {}),
  poweredByHeader: false,
  transpilePackages: ['@smartchat/types', '@smartchat/validation'],
  // One linter for the whole repository. `pnpm lint` runs the root flat config (including the
  // react-hooks rules) across every package; running Next's separate ESLint pass here would mean
  // two configurations that drift apart.
  eslint: { ignoreDuringBuilds: true },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default nextConfig;
