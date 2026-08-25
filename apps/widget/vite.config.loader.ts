import { defineConfig } from 'vite';

/**
 * The loader is built on its own, in library mode, as a single self-executing file.
 *
 * It runs on other people's websites on every page view, so the only thing that matters here is
 * size and isolation: no module preamble, no chunk splitting, no runtime, no dependencies.
 */
export default defineConfig({
  /**
   * The runtime URLs are emitted as literal placeholders and substituted by the widget image's
   * entrypoint at container start. That is what lets one build serve every environment.
   */
  define: {
    __SMARTCHAT_API_URL__: JSON.stringify('__SMARTCHAT_API_URL__'),
    __SMARTCHAT_REALTIME_URL__: JSON.stringify('__SMARTCHAT_REALTIME_URL__'),
  },
  build: {
    outDir: 'dist/v1',
    emptyOutDir: true,
    target: 'es2017',
    minify: 'esbuild',
    lib: {
      entry: 'src/loader/index.ts',
      formats: ['iife'],
      name: 'SmartChatLoader',
      fileName: () => 'loader.js',
    },
    rollupOptions: {
      output: {
        // No `export` statement and no global assignment: the IIFE's own return value is
        // discarded, and the only thing it touches is window.SmartChat.
        extend: false,
        inlineDynamicImports: true,
      },
    },
    reportCompressedSize: true,
  },
});
