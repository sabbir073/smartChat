import {
  HOST_TO_PANEL,
  PANEL_TO_HOST,
  isTrustedHostMessage,
  type HostMessage,
} from '../../shared/protocol.js';

/**
 * The panel's half of the postMessage bridge.
 *
 * The nonce arrives in the iframe URL, which only the loader constructed, so a page that guesses
 * the panel URL still cannot talk to it - and the panel never accepts a message from an origin
 * other than the page that framed it.
 */
export interface HostPage {
  url: string;
  title: string;
  referrer: string;
}

export interface BridgeHandlers {
  onInit(page: HostPage, locale: string): void;
  onOpen(): void;
  onClose(): void;
  onPage(page: { url: string; title: string }): void;
  onIdentify(traits: Record<string, unknown>): void;
  onVisibility(visible: boolean): void;
  onPreviewConfig(config: unknown): void;
}

export class PanelBridge {
  private readonly parentOrigin: string;
  private listener: ((event: MessageEvent) => void) | null = null;

  constructor(private readonly nonce: string) {
    // document.referrer is the page that framed us. It is the only origin we will ever talk to,
    // and it is fixed for the lifetime of the frame.
    this.parentOrigin = originOf(document.referrer);
  }

  get hostOrigin(): string {
    return this.parentOrigin;
  }

  listen(handlers: BridgeHandlers): () => void {
    this.listener = (event: MessageEvent) => {
      if (!this.parentOrigin) return;
      if (!isTrustedHostMessage(event, this.parentOrigin, this.nonce)) return;
      this.dispatch(event.data as HostMessage, handlers);
    };
    window.addEventListener('message', this.listener);
    return () => this.stop();
  }

  private dispatch(message: HostMessage, handlers: BridgeHandlers): void {
    switch (message.type) {
      case HOST_TO_PANEL.INIT:
        handlers.onInit(message.page, message.locale);
        return;
      case HOST_TO_PANEL.OPEN:
        handlers.onOpen();
        return;
      case HOST_TO_PANEL.CLOSE:
        handlers.onClose();
        return;
      case HOST_TO_PANEL.PAGE:
        handlers.onPage(message.page);
        return;
      case HOST_TO_PANEL.IDENTIFY:
        handlers.onIdentify(message.traits);
        return;
      case HOST_TO_PANEL.VISIBILITY:
        handlers.onVisibility(message.visible !== false);
        return;
      case HOST_TO_PANEL.PREVIEW_CONFIG:
        handlers.onPreviewConfig(message.config);
        return;
      default:
        return;
    }
  }

  stop(): void {
    if (this.listener) window.removeEventListener('message', this.listener);
    this.listener = null;
  }

  private send(message: Record<string, unknown>): void {
    if (!this.parentOrigin) return;
    try {
      // Pinned target origin. '*' would post the visitor's state to whatever happens to frame us.
      window.parent.postMessage({ ...message, nonce: this.nonce }, this.parentOrigin);
    } catch {
      /* the parent went away */
    }
  }

  ready(): void {
    this.send({ type: PANEL_TO_HOST.READY });
  }

  requestClose(): void {
    this.send({ type: PANEL_TO_HOST.CLOSE });
  }

  setUnread(count: number): void {
    this.send({ type: PANEL_TO_HOST.UNREAD, count });
  }
}

function originOf(url: string): string {
  try {
    return url ? new URL(url).origin : '';
  } catch {
    return '';
  }
}
