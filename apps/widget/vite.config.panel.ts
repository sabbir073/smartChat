import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * The panel is a normal single-page app, served from our own origin inside an iframe.
 *
 * Because it is lazily created on first open, its size does not affect the customer's page load -
 * which is exactly why the heavy, stateful part of the widget lives here rather than in the loader.
 */
export default defineConfig({
  plugins: [react()],
  /**
   * The panel directory is the Vite root.
   *
   * Passing `rollupOptions.input: 'src/panel/index.html'` instead emits the document at
   * `dist/panel/src/panel/index.html` - Vite preserves the input path relative to the project
   * root - and nginx then 404s on /panel/. Setting the root is what puts index.html where the
   * URL says it is.
   */
  root: 'src/panel',
  base: '/panel/',
  /**
   * The runtime URLs are emitted as literal placeholders and substituted by the widget image's
   * entrypoint at container start. That is what lets one build serve every environment.
   */
  define: {
    __SMARTCHAT_API_URL__: JSON.stringify('__SMARTCHAT_API_URL__'),
    __SMARTCHAT_REALTIME_URL__: JSON.stringify('__SMARTCHAT_REALTIME_URL__'),
  },

  build: {
    outDir: '../../dist/panel',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: true,
  },
  server: {
    port: 3003,
  },
});
