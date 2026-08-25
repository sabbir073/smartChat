/**
 * SmartChat loader.
 *
 * This file runs on other people's websites. Every decision in it follows from that:
 *
 *  - The entire body is wrapped in try/catch. If anything at all goes wrong, the launcher simply
 *    does not appear and the host page is completely unaffected. We never throw into their page.
 *  - It touches exactly one global, `window.SmartChat`, and never patches a prototype, `fetch`,
 *    `XMLHttpRequest`, `history`, or an event handler.
 *  - The launcher lives in a closed Shadow DOM, so neither their CSS nor ours can reach the other.
 *  - The panel is a cross-origin iframe created on first open, so a visitor who never chats
 *    downloads a few kilobytes and nothing else - and the visitor token lives in *our* origin's
 *    storage, unreachable from their page.
 *
 * `__SMARTCHAT_API_URL__` is replaced at container start by the widget image's entrypoint, so one
 * build serves every environment.
 */

import { HOST_TO_PANEL, PANEL_TO_HOST, isTrustedPanelMessage } from '../shared/protocol.js';

declare const __SMARTCHAT_API_URL__: string;

interface LauncherConfig {
  appearance: {
    launcherColor: string;
    launcherIconColor: string;
    launcherSize: number;
    borderRadius: number;
  };
  placement: {
    position: 'bottom_right' | 'bottom_left' | 'top_right' | 'top_left';
    offsetX: number;
    offsetY: number;
    showOnDesktop: boolean;
    showOnMobile: boolean;
    hideOnUrls: string[];
  };
  behaviour: {
    startOpen: boolean;
    showDelaySeconds: number;
    showUnreadBadge: boolean;
  };
  content: { title: string };
}

type QueuedCall = [command: string, ...args: unknown[]];

interface SmartChatGlobal {
  (command: string, ...args: unknown[]): void;
  q?: QueuedCall[];
}

(function bootstrap(): void {
  try {
    const w = window as unknown as Window & { SmartChat?: SmartChatGlobal };
    const d = document;

    // Guard against the snippet being pasted twice, which happens more often than you would think
    // (a tag manager plus a template partial).
    const GUARD = '__smartchatLoaded';
    const guarded = w as unknown as Record<string, unknown>;
    if (guarded[GUARD]) return;
    guarded[GUARD] = true;

    // --- work out who we are -------------------------------------------------
    const script = (d.currentScript as HTMLScriptElement | null) ?? findOwnScript(d);
    if (!script) return;

    const scriptUrl = new URL(script.src, d.baseURI);
    const publicId = scriptUrl.searchParams.get('p');
    if (!publicId || !/^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{12,32}$/.test(publicId)) return;

    const widgetOrigin = scriptUrl.origin;
    const apiUrl = String(__SMARTCHAT_API_URL__).replace(/\/$/, '');
    const nonce = randomNonce();

    // --- state ---------------------------------------------------------------
    let config: LauncherConfig | null = null;
    let iframe: HTMLIFrameElement | null = null;
    let open = false;
    let unread = 0;
    let launcher: HTMLButtonElement | null = null;
    let badge: HTMLSpanElement | null = null;
    let root: ShadowRoot | null = null;
    let host: HTMLDivElement | null = null;

    // --- command queue -------------------------------------------------------
    // The snippet defines a stub that pushes into `q`, so `SmartChat('open')` works before this
    // file has finished loading. We drain it here and then replace the stub.
    const pending: QueuedCall[] = (w.SmartChat && w.SmartChat.q) || [];

    const api: SmartChatGlobal = function api(command: string, ...args: unknown[]): void {
      try {
        handle(command, args);
      } catch {
        /* a bad call from the host page must never surface as an error in their console */
      }
    };
    w.SmartChat = api;

    function handle(command: string, args: unknown[]): void {
      switch (command) {
        case 'open':
          setOpen(true);
          return;
        case 'close':
          setOpen(false);
          return;
        case 'toggle':
          setOpen(!open);
          return;
        case 'identify':
          post({
            type: HOST_TO_PANEL.IDENTIFY,
            nonce,
            traits: (args[0] as Record<string, unknown>) ?? {},
          });
          return;
        case 'hide':
          if (host) host.style.display = 'none';
          return;
        case 'show':
          if (host) host.style.display = '';
          return;
        default:
          return;
      }
    }

    // --- start ---------------------------------------------------------------
    void start();

    async function start(): Promise<void> {
      try {
        const response = await fetch(
          `${apiUrl}/api/v1/widget/config?p=${encodeURIComponent(publicId!)}`,
          { method: 'GET', credentials: 'omit', mode: 'cors' },
        );
        if (!response.ok) return;

        const body = (await response.json()) as {
          success?: boolean;
          data?: { widget?: { config?: LauncherConfig } };
        };
        const loaded = body?.data?.widget?.config;
        if (!body.success || !loaded) return;
        config = loaded;

        if (!shouldRender(config)) return;

        const delay = Math.max(0, Number(config.behaviour.showDelaySeconds) || 0) * 1000;
        if (delay > 0) window.setTimeout(() => void render(), delay);
        else await render();
      } catch {
        /* offline, blocked by a content blocker, CSP, DNS - all the same to the host page */
      }
    }

    function shouldRender(cfg: LauncherConfig): boolean {
      const isMobile = window.matchMedia?.('(max-width: 640px)').matches ?? window.innerWidth < 640;
      if (isMobile && !cfg.placement.showOnMobile) return false;
      if (!isMobile && !cfg.placement.showOnDesktop) return false;

      const here = location.pathname + location.search;
      return !cfg.placement.hideOnUrls.some((pattern) => pattern && here.indexOf(pattern) !== -1);
    }

    async function render(): Promise<void> {
      if (!config || root) return;

      host = d.createElement('div');
      host.setAttribute('data-smartchat', '');
      // Fixed and zero-size: the host element itself can never affect the page's layout.
      host.style.cssText = 'position:fixed;z-index:2147483000;width:0;height:0;';

      // A *closed* shadow root: the host page cannot reach into it even deliberately, so their
      // scripts cannot restyle or scrape the widget.
      root = host.attachShadow({ mode: 'closed' });
      root.appendChild(styles(config));
      launcher = buildLauncher(config);
      root.appendChild(launcher);

      (d.body || d.documentElement).appendChild(host);

      window.addEventListener('message', onPanelMessage);
      document.addEventListener('visibilitychange', onVisibility);

      for (const call of pending) {
        const [command, ...args] = call;
        if (typeof command === 'string') handle(command, args);
      }
      pending.length = 0;

      if (config.behaviour.startOpen) setOpen(true);
    }

    function styles(cfg: LauncherConfig): HTMLStyleElement {
      const style = d.createElement('style');
      const size = clamp(cfg.appearance.launcherSize, 44, 80);
      const [vertical, horizontal] = cfg.placement.position.split('_') as [
        'bottom' | 'top',
        'right' | 'left',
      ];
      const x = clamp(cfg.placement.offsetX, 0, 200);
      const y = clamp(cfg.placement.offsetY, 0, 200);

      style.textContent = `
:host{all:initial}
*{box-sizing:border-box}
.launcher{
  position:fixed;${vertical}:${y}px;${horizontal}:${x}px;
  width:${size}px;height:${size}px;border:0;padding:0;margin:0;
  border-radius:${clamp(cfg.appearance.borderRadius * 2, 8, 50)}%;
  background:${safeColor(cfg.appearance.launcherColor)};
  color:${safeColor(cfg.appearance.launcherIconColor)};
  cursor:pointer;display:flex;align-items:center;justify-content:center;
  box-shadow:0 4px 16px rgba(16,24,40,.24);
  transition:transform .18s ease, box-shadow .18s ease;
  font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
}
.launcher:hover{transform:scale(1.05);box-shadow:0 6px 20px rgba(16,24,40,.3)}
.launcher:active{transform:scale(.97)}
.launcher:focus-visible{outline:3px solid ${safeColor(cfg.appearance.launcherColor)};outline-offset:3px}
.launcher svg{width:${Math.round(size * 0.45)}px;height:${Math.round(size * 0.45)}px;pointer-events:none}
.badge{
  position:absolute;top:-2px;${horizontal}:-2px;min-width:20px;height:20px;padding:0 6px;
  border-radius:10px;background:#e5484d;color:#fff;font-size:11px;font-weight:700;
  display:none;align-items:center;justify-content:center;line-height:1;
}
.badge[data-visible="1"]{display:flex}
.frame{
  position:fixed;${vertical}:${y + size + 12}px;${horizontal}:${x}px;
  width:400px;height:min(640px, calc(100vh - ${y + size + 32}px));
  border:0;border-radius:${clamp(cfg.appearance.borderRadius, 0, 24)}px;
  box-shadow:0 12px 48px rgba(16,24,40,.24);
  opacity:0;transform:translateY(8px);pointer-events:none;
  transition:opacity .18s ease, transform .18s ease;
  background:transparent;color-scheme:normal;
}
.frame[data-open="1"]{opacity:1;transform:translateY(0);pointer-events:auto}
@media (max-width:640px){
  .frame{inset:0;width:100%;height:100%;border-radius:0;max-height:100%}
  .launcher[data-open="1"]{display:none}
}
@media (prefers-reduced-motion:reduce){
  .launcher,.frame{transition:none}
  .launcher:hover{transform:none}
}`;
      return style;
    }

    function buildLauncher(cfg: LauncherConfig): HTMLButtonElement {
      const button = d.createElement('button');
      button.className = 'launcher';
      button.type = 'button';
      button.setAttribute('aria-haspopup', 'dialog');
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', String(cfg.content.title || 'Chat with us'));

      // Built as DOM nodes rather than innerHTML: nothing from the config is ever parsed as markup.
      const svg = d.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', '0 0 24 24');
      svg.setAttribute('fill', 'none');
      svg.setAttribute('aria-hidden', 'true');
      const path = d.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute(
        'd',
        'M12 3c5 0 9 3.4 9 7.6 0 4.2-4 7.6-9 7.6-.9 0-1.8-.1-2.6-.3L4 21l1.2-3.6C3.2 16 2 13.4 2 10.6 2 6.4 6 3 12 3Z',
      );
      path.setAttribute('fill', 'currentColor');
      svg.appendChild(path);
      button.appendChild(svg);

      badge = d.createElement('span');
      badge.className = 'badge';
      badge.setAttribute('aria-live', 'polite');
      button.appendChild(badge);

      button.addEventListener('click', () => setOpen(!open));
      return button;
    }

    function ensureFrame(): HTMLIFrameElement {
      if (iframe) return iframe;

      iframe = d.createElement('iframe');
      iframe.className = 'frame';
      iframe.title = String(config?.content.title || 'Chat');
      iframe.setAttribute('aria-label', iframe.title);
      // Only what the panel actually needs. No allow-top-navigation, no allow-popups.
      iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      iframe.setAttribute('allow', 'clipboard-write');
      iframe.src = `${widgetOrigin}/panel/?p=${encodeURIComponent(publicId!)}&n=${encodeURIComponent(nonce)}`;
      root?.appendChild(iframe);
      return iframe;
    }

    function setOpen(next: boolean): void {
      if (!config || !launcher) return;
      open = next;

      const frame = ensureFrame();
      frame.dataset['open'] = next ? '1' : '0';
      launcher.dataset['open'] = next ? '1' : '0';
      launcher.setAttribute('aria-expanded', next ? 'true' : 'false');

      if (next) {
        unread = 0;
        paintBadge();
        post({
          type: HOST_TO_PANEL.OPEN,
          nonce,
        });
        // Focus follows the panel so keyboard users land inside it.
        window.setTimeout(() => frame.contentWindow?.focus(), 60);
      } else {
        post({ type: HOST_TO_PANEL.CLOSE, nonce });
        launcher.focus();
      }
    }

    function paintBadge(): void {
      if (!badge || !config) return;
      const visible = config.behaviour.showUnreadBadge && unread > 0;
      badge.dataset['visible'] = visible ? '1' : '0';
      badge.textContent = unread > 9 ? '9+' : String(unread);
    }

    function post(message: Record<string, unknown>): void {
      try {
        // targetOrigin is pinned. Never '*': that would broadcast to whatever happens to be
        // loaded in the frame.
        iframe?.contentWindow?.postMessage(message, widgetOrigin);
      } catch {
        /* frame not ready yet */
      }
    }

    function onPanelMessage(event: MessageEvent): void {
      if (!isTrustedPanelMessage(event, widgetOrigin, nonce)) return;
      const message = event.data;

      switch (message.type) {
        case PANEL_TO_HOST.READY:
          post({
            type: HOST_TO_PANEL.INIT,
            nonce,
            publicId,
            page: {
              url: location.href,
              title: d.title || '',
              referrer: d.referrer || '',
            },
            locale: navigator.language || 'en',
          });
          return;
        case PANEL_TO_HOST.CLOSE:
          setOpen(false);
          return;
        case PANEL_TO_HOST.UNREAD:
          unread = Math.max(0, Number(message.count) || 0);
          paintBadge();
          return;
        default:
          return;
      }
    }

    function onVisibility(): void {
      post({ type: HOST_TO_PANEL.VISIBILITY, nonce, visible: !d.hidden });
    }

    // --- helpers -------------------------------------------------------------
    function findOwnScript(doc: Document): HTMLScriptElement | null {
      // Fallback for browsers or injection methods where document.currentScript is null.
      const scripts = doc.getElementsByTagName('script');
      for (let i = scripts.length - 1; i >= 0; i -= 1) {
        const candidate = scripts[i];
        if (candidate && candidate.src && candidate.src.indexOf('/v1/loader.js') !== -1) {
          return candidate;
        }
      }
      return null;
    }

    function randomNonce(): string {
      const bytes = new Uint8Array(16);
      (window.crypto || (window as unknown as { msCrypto: Crypto }).msCrypto).getRandomValues(
        bytes,
      );
      let out = '';
      for (let i = 0; i < bytes.length; i += 1)
        out += (bytes[i] as number).toString(16).padStart(2, '0');
      return out;
    }

    function clamp(value: number, min: number, max: number): number {
      const n = Number(value);
      if (!Number.isFinite(n)) return min;
      return Math.min(max, Math.max(min, n));
    }

    /** Only a literal hex colour is ever written into a stylesheet. */
    function safeColor(value: string): string {
      return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value)) ? String(value) : '#2F6FED';
    }
  } catch {
    /*
     * The outermost catch. A failure here means the visitor does not get a chat widget - which is
     * a bad day for us and a completely ordinary one for the customer's website.
     */
  }
})();
