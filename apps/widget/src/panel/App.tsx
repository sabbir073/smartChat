import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_WIDGET_CONFIG, parseWidgetConfig, type WidgetConfig } from '@smartchat/validation';
import { PanelBridge, type HostPage } from './lib/bridge.js';
import { WidgetApiError, widgetApi, type BootstrapResponse } from './lib/api.js';
import { clearToken, readToken, writeToken } from './lib/storage.js';
import { PanelHeader } from './components/PanelHeader.js';
import { PreChatForm } from './components/PreChatForm.js';

type View = 'loading' | 'unavailable' | 'prechat' | 'chat';

interface Params {
  publicId: string;
  nonce: string;
  /**
   * Builder preview mode.
   *
   * The panel renders from a configuration pushed over the bridge instead of bootstrapping a
   * visitor. It creates no visitor, no session and no page view - a customer dragging a colour
   * slider must not pollute their own analytics.
   */
  preview: boolean;
}

function readParams(): Params | null {
  const query = new URLSearchParams(window.location.search);
  const publicId = query.get('p') ?? '';
  const nonce = query.get('n') ?? '';
  if (!/^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{12,32}$/.test(publicId)) return null;
  if (!/^[a-f0-9]{8,64}$/.test(nonce)) return null;
  return { publicId, nonce, preview: query.get('preview') === '1' };
}

/** Apply the customer's colours as CSS variables rather than inline styles on every element. */
function applyTheme(config: WidgetConfig): void {
  const root = document.documentElement;
  const { appearance } = config;
  root.style.setProperty('--sc-primary', appearance.primaryColor);
  root.style.setProperty('--sc-header', appearance.headerColor);
  root.style.setProperty('--sc-header-text', appearance.headerTextColor);
  root.style.setProperty('--sc-radius', `${appearance.borderRadius}px`);

  const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  const dark = appearance.theme === 'dark' || (appearance.theme === 'auto' && prefersDark);
  root.dataset['theme'] = dark ? 'dark' : 'light';
}

export function App() {
  const params = useMemo(readParams, []);
  const [view, setView] = useState<View>('loading');
  const [config, setConfig] = useState<WidgetConfig>(DEFAULT_WIDGET_CONFIG);
  const [session, setSession] = useState<BootstrapResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const bridge = useMemo(() => (params ? new PanelBridge(params.nonce) : null), [params]);
  const hostPage = useRef<HostPage | null>(null);
  const started = useRef(false);

  const bootstrap = useCallback(
    async (page: HostPage | null) => {
      if (!params) return;
      try {
        const stored = readToken(params.publicId);
        const result = await widgetApi.bootstrap({
          p: params.publicId,
          token: stored,
          page: page ? { url: page.url, title: page.title, referrer: page.referrer } : undefined,
          screen: { width: window.screen?.width ?? 0, height: window.screen?.height ?? 0 },
          language: navigator.language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });

        writeToken(params.publicId, result.token);
        setSession(result);
        setConfig(result.widget.config);
        applyTheme(result.widget.config);

        // A returning visitor who already told us who they are should not be asked again.
        const knowsVisitor = Boolean(result.visitor.name || result.visitor.email);
        const needsPreChat = result.widget.config.behaviour.preChatEnabled && !knowsVisitor;
        setView(needsPreChat ? 'prechat' : 'chat');
      } catch (error) {
        if (error instanceof WidgetApiError && error.code === 'INVALID_TOKEN') {
          // The stored token is no longer usable - expired, or its visitor was erased. Drop it and
          // start over as a new visitor rather than leaving the widget permanently broken.
          clearToken(params.publicId);
          if (!started.current) {
            started.current = true;
            void bootstrap(page);
            return;
          }
        }
        setFailure(
          error instanceof WidgetApiError && error.status !== 0
            ? error.message
            : 'We could not reach the chat service. Please try again in a moment.',
        );
        setView('unavailable');
      }
    },
    [params],
  );

  // --- bridge ---------------------------------------------------------------
  useEffect(() => {
    if (!bridge || !params) return undefined;

    const stop = bridge.listen({
      onInit(page) {
        hostPage.current = page;
        if (params.preview) {
          started.current = true;
          return;
        }
        if (!started.current) {
          started.current = true;
          void bootstrap(page);
        }
      },
      onPreviewConfig(incoming) {
        if (!params.preview) return;
        const parsed = parseWidgetConfig(incoming);
        setConfig(parsed);
        applyTheme(parsed);
        setView(parsed.behaviour.preChatEnabled ? 'prechat' : 'chat');
      },
      onOpen() {
        bridge.setUnread(0);
      },
      onClose() {
        /* the loader has already hidden the frame; nothing to tear down */
      },
      onPage(page) {
        hostPage.current = hostPage.current
          ? { ...hostPage.current, url: page.url, title: page.title }
          : { url: page.url, title: page.title, referrer: '' };
        const token = readToken(params.publicId);
        if (token) void widgetApi.pageView(token, page).catch(() => undefined);
      },
      onIdentify(traits) {
        const token = readToken(params.publicId);
        if (!token) return;
        void widgetApi
          .identify(token, {
            name: typeof traits['name'] === 'string' ? traits['name'] : undefined,
            email: typeof traits['email'] === 'string' ? traits['email'] : undefined,
            phone: typeof traits['phone'] === 'string' ? traits['phone'] : undefined,
            externalId: typeof traits['id'] === 'string' ? traits['id'] : undefined,
          })
          .catch(() => undefined);
      },
      onVisibility() {
        /* used by the realtime layer to pace reconnects */
      },
    });

    bridge.ready();

    // If the loader never answers (a stale frame, a blocked bridge), start anyway after a moment
    // so the visitor is not left staring at a spinner.
    const fallback = window.setTimeout(() => {
      if (!started.current && !params.preview) {
        started.current = true;
        void bootstrap(null);
      }
    }, 1200);

    return () => {
      window.clearTimeout(fallback);
      stop();
    };
  }, [bridge, bootstrap, params]);

  // --- render ---------------------------------------------------------------
  if (!params) {
    return (
      <div className="panel">
        <div className="centered">
          <p>This chat window was opened incorrectly.</p>
        </div>
      </div>
    );
  }

  // Narrowed here so the handlers below do not each have to re-prove it; the early return above
  // has already established that params is present.
  const resolved = params;
  const online = false; // Agent presence arrives with the realtime layer in Phase 3.
  const subtitle = online ? config.content.subtitleOnline : config.content.subtitleOffline;

  async function handlePreChat(values: Record<string, string>) {
    // In preview mode there is no visitor to identify; the form is there to be looked at.
    if (resolved.preview) {
      setView('chat');
      return;
    }
    if (!session) return;
    setSubmitting(true);
    try {
      await widgetApi.identify(session.token, {
        name: values['name'],
        email: values['email'],
        phone: values['phone'],
      });
      setView('chat');
    } catch {
      // Identification is best-effort context, not a gate. Failing to record it must never stop
      // somebody from asking for help.
      setView('chat');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="panel">
      <PanelHeader
        title={config.content.businessName}
        subtitle={subtitle}
        online={online}
        avatarUrl={config.appearance.avatarUrl}
        onClose={() => bridge?.requestClose()}
      />

      {view === 'loading' && (
        <div className="centered">
          <div className="spinner" aria-hidden="true" />
          <p className="sr-only">Loading chat</p>
        </div>
      )}

      {view === 'unavailable' && (
        <div className="centered">
          <p>{failure}</p>
        </div>
      )}

      {view === 'prechat' && (
        <div className="body">
          <div className="bubble bubble-agent">{config.content.welcomeMessage}</div>
          <PreChatForm
            intro={config.forms.preChatIntro}
            fields={config.forms.preChatFields}
            submitLabel="Start chat"
            busy={submitting}
            onSubmit={(values) => void handlePreChat(values)}
          />
        </div>
      )}

      {view === 'chat' && (
        <div className="body">
          <div className="bubble bubble-agent">{config.content.welcomeMessage}</div>
          <div className="centered">
            <div className="spinner" aria-hidden="true" />
            <p>Connecting you to the team…</p>
          </div>
        </div>
      )}

      <p className="footer">Powered by SmartChat</p>
    </div>
  );
}
