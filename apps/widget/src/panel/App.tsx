import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_WIDGET_CONFIG, parseWidgetConfig, type WidgetConfig } from '@smartchat/validation';
import { PanelBridge, type HostPage } from './lib/bridge.js';
import { WidgetApiError, widgetApi, type BootstrapResponse } from './lib/api.js';
import { clearToken, readToken, writeToken } from './lib/storage.js';
import { ChatClient, type ConnectionState } from './lib/socket.js';
import { ulid } from './lib/ulid.js';
import type { MessageDto, PanelMessage } from './lib/types.js';
import { PanelHeader } from './components/PanelHeader.js';
import { PreChatForm } from './components/PreChatForm.js';
import { MessageList } from './components/MessageList.js';
import { Composer } from './components/Composer.js';

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

  const [messages, setMessages] = useState<PanelMessage[]>([]);
  const [connection, setConnection] = useState<ConnectionState>('idle');
  const [agentTyping, setAgentTyping] = useState(false);
  const [online, setOnline] = useState(false);
  const [closed, setClosed] = useState(false);

  const bridge = useMemo(() => (params ? new PanelBridge(params.nonce) : null), [params]);
  const hostPage = useRef<HostPage | null>(null);
  const started = useRef(false);
  const client = useRef<ChatClient | null>(null);
  const typingTimer = useRef<number | null>(null);
  const isOpen = useRef(false);

  /**
   * Merge a message into the list.
   *
   * Keyed on `clientMessageId` first so a server echo replaces the optimistic bubble rather than
   * appearing beside it, then on `id` so a replay after reconnect cannot duplicate anything.
   */
  const upsertMessage = useCallback((incoming: MessageDto, delivery: PanelMessage['delivery']) => {
    setMessages((current) => {
      const index = current.findIndex(
        (message) =>
          (incoming.clientMessageId && message.clientMessageId === incoming.clientMessageId) ||
          message.id === incoming.id,
      );
      const next: PanelMessage = { ...incoming, delivery };
      if (index === -1) {
        return [...current, next].sort((a, b) => (a.seq || 0) - (b.seq || 0));
      }
      const copy = [...current];
      copy[index] = next;
      return copy;
    });
  }, []);

  const connectSocket = useCallback(
    (token: string) => {
      if (client.current) return;
      const chat = new ChatClient(token, {
        onState: (state) => {
          setConnection(state);
          setOnline(state === 'connected');
        },
        onMessage: (message) => {
          upsertMessage(message, 'sent');
          if (message.senderType !== 'visitor') {
            setAgentTyping(false);
            // The badge only counts what the visitor has not seen.
            if (!isOpen.current) {
              setMessages((current) => {
                const unread = current.filter((entry) => entry.senderType !== 'visitor').length;
                bridge?.setUnread(unread);
                return current;
              });
            } else {
              chat.markRead();
            }
          }
        },
        onTyping: (payload) => {
          setAgentTyping(payload.typing);
          if (typingTimer.current) window.clearTimeout(typingTimer.current);
          if (payload.typing) {
            // A safety net: the server's typing key expires, but if its "stopped" event is lost
            // the indicator must not stay on forever.
            typingTimer.current = window.setTimeout(() => setAgentTyping(false), 7000);
          }
        },
        onConversation: (payload) => {
          if (payload.status === 'closed') setClosed(true);
          if (payload.status === 'open') setClosed(false);
        },
      });

      client.current = chat;
      void chat.connect();
    },
    [bridge, upsertMessage],
  );

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
        setOnline(result.agentsAvailable);

        const knowsVisitor = Boolean(result.visitor.name || result.visitor.email);
        const needsPreChat = result.widget.config.behaviour.preChatEnabled && !knowsVisitor;
        setView(needsPreChat ? 'prechat' : 'chat');

        connectSocket(result.token);
      } catch (error) {
        if (error instanceof WidgetApiError && error.code === 'INVALID_TOKEN') {
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
    [params, connectSocket],
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
        isOpen.current = true;
        bridge.setUnread(0);
        client.current?.markRead();
      },
      onClose() {
        isOpen.current = false;
      },
      onPage(page) {
        hostPage.current = hostPage.current
          ? { ...hostPage.current, url: page.url, title: page.title }
          : { url: page.url, title: page.title, referrer: '' };
        client.current?.reportPage(page.url, page.title);
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
        /* the socket manages its own liveness */
      },
    });

    bridge.ready();

    const fallback = window.setTimeout(() => {
      if (!started.current && !params.preview) {
        started.current = true;
        void bootstrap(null);
      }
    }, 1200);

    return () => {
      window.clearTimeout(fallback);
      stop();
      client.current?.close();
      client.current = null;
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

  const resolved = params;
  const subtitle = online ? config.content.subtitleOnline : config.content.subtitleOffline;

  async function handlePreChat(values: Record<string, string>) {
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
    } catch {
      // Identification is context, not a gate. Failing to record it must never stop somebody
      // asking for help.
    } finally {
      setSubmitting(false);
      setView('chat');
    }
  }

  /**
   * Send optimistically, then reconcile.
   *
   * The bubble appears immediately as `pending` and is promoted to `sent` only when the server
   * acknowledges - which it does only after the message is committed. If the send fails the bubble
   * stays visible and marked, rather than vanishing with the visitor's words in it.
   */
  function handleSend(body: string) {
    const chat = client.current;
    if (!chat) return;

    const clientMessageId = ulid();
    const optimistic: PanelMessage = {
      id: clientMessageId,
      conversationId: chat.conversationId ?? '',
      seq: Number.MAX_SAFE_INTEGER,
      clientMessageId,
      senderType: 'visitor',
      senderId: null,
      senderName: null,
      type: 'text',
      body,
      createdAt: new Date().toISOString(),
      readAt: null,
      delivery: 'pending',
    };
    setMessages((current) => [...current, optimistic]);

    const promise = chat.conversationId
      ? chat.send(clientMessageId, body)
      : chat.start(clientMessageId, body);

    promise
      .then((message) => upsertMessage(message, 'sent'))
      .catch(() => {
        setMessages((current) =>
          current.map((message) =>
            message.clientMessageId === clientMessageId
              ? { ...message, delivery: 'failed' }
              : message,
          ),
        );
      });
  }

  const composerDisabled =
    resolved.preview || connection !== 'connected' || closed || view !== 'chat';

  return (
    <div className="panel">
      <PanelHeader
        title={config.content.businessName}
        subtitle={subtitle}
        online={online}
        avatarUrl={config.appearance.avatarUrl}
        onClose={() => bridge?.requestClose()}
      />

      {view === 'chat' && connection === 'reconnecting' && (
        <div className="banner" role="status">
          Reconnecting…
        </div>
      )}
      {view === 'chat' && connection === 'failed' && (
        <div className="banner" data-tone="error" role="alert">
          We cannot reach the chat service right now.
        </div>
      )}
      {closed && (
        <div className="banner" role="status">
          This conversation was closed. Send a message to reopen it.
        </div>
      )}

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
        <>
          <MessageList
            messages={messages}
            welcome={config.content.welcomeMessage}
            agentTyping={agentTyping && config.behaviour.showAgentTyping}
          />
          <Composer
            placeholder={config.content.inputPlaceholder}
            disabled={composerDisabled}
            onSend={handleSend}
            onTyping={(typing) => client.current?.typing(typing)}
          />
        </>
      )}

      {view !== 'chat' && <p className="footer">Powered by SmartChat</p>}
    </div>
  );
}
