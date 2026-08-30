import path from 'node:path';
import { defineConfig } from 'vitest/config';

/**
 * Tests for the dashboard.
 *
 * Most of this app's behaviour belongs to the API and is tested there; what lives here is the
 * part a server-side test cannot see - text rendering and focus behaviour in a real DOM.
 */
export default defineConfig({
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    /**
     * The container images build with `NODE_ENV=production`, and the shell that runs the gate
     * inherits it. React ships a different `react-dom/test-utils` under that value - one whose
     * `act` is a stub - so a test run in a production environment fails on the first render with
     * "React.act is not a function". Pinning it here means the suite behaves the same wherever it
     * is started from.
     */
    env: { NODE_ENV: 'test' },
  },
});
