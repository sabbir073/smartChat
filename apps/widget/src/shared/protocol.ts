/**
 * The postMessage contract between the loader (on the customer's page) and the panel (in our
 * iframe).
 *
 * The set is small and closed on purpose. Both sides pin `targetOrigin` to the exact widget
 * origin - never `*` - verify `event.origin` on receipt, and check a per-instance nonce, so a
 * third script on the host page cannot forge a message either way.
 */

export const PANEL_TO_HOST = {
  READY: 'sc:panel:ready',
  RESIZE: 'sc:panel:resize',
  CLOSE: 'sc:panel:close',
  UNREAD: 'sc:panel:unread',
  SOUND: 'sc:panel:sound',
} as const;

export const HOST_TO_PANEL = {
  INIT: 'sc:host:init',
  OPEN: 'sc:host:open',
  CLOSE: 'sc:host:close',
  PAGE: 'sc:host:page',
  IDENTIFY: 'sc:host:identify',
  VISIBILITY: 'sc:host:visibility',
  /**
   * Builder preview only. The dashboard pushes an unpublished configuration straight into the
   * panel, so the preview *is* the real widget rather than a second implementation of it - which
   * is the only way preview and production cannot drift apart.
   */
  PREVIEW_CONFIG: 'sc:host:preview-config',
} as const;

export interface HostInitMessage {
  type: typeof HOST_TO_PANEL.INIT;
  nonce: string;
  publicId: string;
  page: { url: string; title: string; referrer: string };
  locale: string;
}

export interface HostPageMessage {
  type: typeof HOST_TO_PANEL.PAGE;
  nonce: string;
  page: { url: string; title: string };
}

export interface HostPreviewConfigMessage {
  type: typeof HOST_TO_PANEL.PREVIEW_CONFIG;
  nonce: string;
  config: unknown;
}

export interface HostIdentifyMessage {
  type: typeof HOST_TO_PANEL.IDENTIFY;
  nonce: string;
  traits: Record<string, unknown>;
}

export interface HostSimpleMessage {
  type: typeof HOST_TO_PANEL.OPEN | typeof HOST_TO_PANEL.CLOSE | typeof HOST_TO_PANEL.VISIBILITY;
  nonce: string;
  visible?: boolean;
}

export type HostMessage =
  | HostInitMessage
  | HostPageMessage
  | HostIdentifyMessage
  | HostPreviewConfigMessage
  | HostSimpleMessage;

export interface PanelReadyMessage {
  type: typeof PANEL_TO_HOST.READY;
  nonce: string;
}

export interface PanelResizeMessage {
  type: typeof PANEL_TO_HOST.RESIZE;
  nonce: string;
  height: number;
}

export interface PanelUnreadMessage {
  type: typeof PANEL_TO_HOST.UNREAD;
  nonce: string;
  count: number;
}

export interface PanelSimpleMessage {
  type: typeof PANEL_TO_HOST.CLOSE | typeof PANEL_TO_HOST.SOUND;
  nonce: string;
}

export type PanelMessage =
  PanelReadyMessage | PanelResizeMessage | PanelUnreadMessage | PanelSimpleMessage;

const PANEL_TYPES = new Set<string>(Object.values(PANEL_TO_HOST));
const HOST_TYPES = new Set<string>(Object.values(HOST_TO_PANEL));

/**
 * Accept a message only if it came from the expected origin, carries our nonce, and names a
 * message type we know. Anything else is dropped without a trace - a hostile page should learn
 * nothing from probing the bridge.
 */
export function isTrustedPanelMessage(
  event: MessageEvent,
  expectedOrigin: string,
  nonce: string,
): event is MessageEvent<PanelMessage> {
  if (event.origin !== expectedOrigin) return false;
  const data = event.data as { type?: unknown; nonce?: unknown } | null;
  if (!data || typeof data !== 'object') return false;
  if (typeof data.type !== 'string' || !PANEL_TYPES.has(data.type)) return false;
  return data.nonce === nonce;
}

export function isTrustedHostMessage(
  event: MessageEvent,
  expectedOrigin: string,
  nonce: string,
): event is MessageEvent<HostMessage> {
  if (event.origin !== expectedOrigin) return false;
  const data = event.data as { type?: unknown; nonce?: unknown } | null;
  if (!data || typeof data !== 'object') return false;
  if (typeof data.type !== 'string' || !HOST_TYPES.has(data.type)) return false;
  return data.nonce === nonce;
}
