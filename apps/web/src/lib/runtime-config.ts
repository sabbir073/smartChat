/**
 * Runtime configuration.
 *
 * `NEXT_PUBLIC_*` values are inlined at build time, which would mean a separate image per
 * environment. Instead the server renders a small config object into the document and the client
 * reads it, so one image runs unchanged in development, staging and production.
 */
export interface RuntimeConfig {
  apiUrl: string;
  realtimeUrl: string;
  widgetUrl: string;
}

export const RUNTIME_CONFIG_GLOBAL = '__SMARTCHAT_CONFIG__';

declare global {
  interface Window {
    __SMARTCHAT_CONFIG__?: RuntimeConfig;
  }
}

/** Server-side: read from the process environment. */
export function readRuntimeConfig(): RuntimeConfig {
  return {
    apiUrl: process.env['API_URL'] ?? 'http://localhost:3001',
    realtimeUrl: process.env['REALTIME_URL'] ?? 'http://localhost:3002',
    widgetUrl: process.env['WIDGET_URL'] ?? 'http://localhost:3003',
  };
}

/**
 * Serialise for inline injection.
 *
 * `<` is escaped so a value containing `</script>` cannot terminate the tag early. The values are
 * our own configuration rather than user input, but an injection sink is worth closing regardless
 * of who currently controls the source.
 */
export function serialiseRuntimeConfig(config: RuntimeConfig): string {
  return JSON.stringify(config).replace(/</g, '\\u003c');
}

/** Client-side: read what the server injected. */
export function runtimeConfig(): RuntimeConfig {
  if (typeof window !== 'undefined' && window[RUNTIME_CONFIG_GLOBAL]) {
    return window[RUNTIME_CONFIG_GLOBAL];
  }
  return {
    apiUrl: 'http://localhost:3001',
    realtimeUrl: 'http://localhost:3002',
    widgetUrl: 'http://localhost:3003',
  };
}
