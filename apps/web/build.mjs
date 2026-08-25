#!/usr/bin/env node
/**
 * Run `next build` with NODE_ENV pinned to production.
 *
 * This machine (and many CI images) export NODE_ENV=development globally so that pnpm installs
 * devDependencies. `next build` inherits it, and a production build under a development NODE_ENV
 * fails while prerendering /404 and /500 with a misleading
 * "<Html> should not be imported outside of pages/_document".
 *
 * Setting it here rather than in the shell means the build behaves identically however it is
 * invoked - locally, from turbo, or inside Docker.
 */
import { spawnSync } from 'node:child_process';

const result = spawnSync('next', ['build', ...process.argv.slice(2)], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, NODE_ENV: 'production' },
});

if (result.error) {
  console.error('[web] failed to start next build:', result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
