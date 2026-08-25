/**
 * Runtime configuration.
 *
 * `__SMARTCHAT_API_URL__` and `__SMARTCHAT_REALTIME_URL__` are literal placeholders in the built
 * bundle, replaced by the widget image's entrypoint at container start. One build therefore serves
 * development, staging and production - the alternative, inlining at build time, would mean a
 * separate image per environment and no way to promote an artefact between them.
 */
declare const __SMARTCHAT_API_URL__: string;
declare const __SMARTCHAT_REALTIME_URL__: string;

function resolve(value: string, fallback: string): string {
  // An unreplaced placeholder means the entrypoint did not run (a raw `vite dev`, or a
  // misconfigured image). Falling back to localhost keeps development working and makes the
  // mistake obvious rather than silent.
  const looksReplaced = typeof value === 'string' && !value.startsWith('__SMARTCHAT');
  return (looksReplaced ? value : fallback).replace(/\/$/, '');
}

export const API_URL = resolve(
  typeof __SMARTCHAT_API_URL__ === 'string' ? __SMARTCHAT_API_URL__ : '',
  'http://localhost:3001',
);

export const REALTIME_URL = resolve(
  typeof __SMARTCHAT_REALTIME_URL__ === 'string' ? __SMARTCHAT_REALTIME_URL__ : '',
  'http://localhost:3002',
);
