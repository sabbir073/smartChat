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
  /**
   * The media server browsers connect to for a call, or null when calling is not configured. The
   * join grant carries the URL as well; this copy is for the page to know calling exists at all.
   */
  livekitUrl: string | null;
}

export const RUNTIME_CONFIG_GLOBAL = '__SMARTCHAT_CONFIG__';

declare global {
  interface Window {
    __SMARTCHAT_CONFIG__?: RuntimeConfig;
  }
}

/**
 * Where the dashboard connects for a call. `LIVEKIT_PUBLIC_URL` is the name the rest of the
 * platform uses (docs/VOICE.md); the `NEXT_PUBLIC_` spelling is accepted for a deployment that
 * configured the web image on its own. Read at request time, like everything else here.
 */
export function livekitPublicUrl(): string | undefined {
  return process.env['LIVEKIT_PUBLIC_URL'] || process.env['NEXT_PUBLIC_LIVEKIT_URL'] || undefined;
}

/** Server-side: read from the process environment. */
export function readRuntimeConfig(): RuntimeConfig {
  return {
    apiUrl: process.env['API_URL'] ?? 'http://localhost:3001',
    realtimeUrl: process.env['REALTIME_URL'] ?? 'http://localhost:3002',
    widgetUrl: process.env['WIDGET_URL'] ?? 'http://localhost:3003',
    livekitUrl: livekitPublicUrl() ?? null,
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
    livekitUrl: null,
  };
}
