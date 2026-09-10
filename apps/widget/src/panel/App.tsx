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
import { ChatEnded, EndChatConfirm } from './components/ChatEnded.js';
import { AgentArrivedBanner, OfflineSent } from './components/OfflineSent.js';
import { viewAfterInboundMessage, type View } from './lib/view.js';

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
  /**
   * The loader's proof of which page this panel is embedded in.
   *
   * Opaque here and never inspected: it is a signature the server made and only the server reads.
   * Absent when the panel is opened directly rather than by a loader.
   */
  embedTicket: string | null;
}

function readParams(): Params | null {
  const query = new URLSearchParams(window.location.search);
  const publicId = query.get('p') ?? '';
  const nonce = query.get('n') ?? '';
  if (!/^[a-z]{2,5}_[0-9A-HJKMNP-TV-Z]{12,32}$/.test(publicId)) return null;
  if (!/^[a-f0-9]{8,64}$/.test(nonce)) return null;
  const embedTicket = query.get('e');
  return {
    publicId,
    nonce,
    preview: query.get('preview') === '1',
    embedTicket:
      embedTicket && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(embedTicket) ? embedTicket : null,
  };
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
  /** Who is typing, when the server said - the AI assistant names itself. */
  const [typingName, setTypingName] = useState<string | null>(null);
  /**
   * The AI assistant's ticket offer.
   *
   * `offerDismissedFor` is the id of the offer message the visitor waved away, so the buttons go
   * and stay gone for that message. `ticketFor` is the conversation a ticket form is open for.
   */
  const [offerDismissedFor, setOfferDismissedFor] = useState<string | null>(null);
  const [ticketFor, setTicketFor] = useState<string | null>(null);
  const [ticketError, setTicketError] = useState<string | null>(null);
  /**
   * Whether anybody is there to answer.
   *
   * Deliberately not the same thing as "the socket is up". A connected socket with nobody on the
   * other end is exactly the situation the offline form exists for, and telling a visitor they
   * are talking to an online team when they are not is the kind of small lie that turns into a
   * complaint about response times.
   */
  const [online, setOnline] = useState(false);
  /** The person at the top of the window - the assignee, or the owner - as the server tells it. */
  const [presenter, setPresenter] = useState<{ name: string; avatarUrl: string | null } | null>(null);
  /** Pre-chat answers, held until the first message so they arrive with it in one write. */
  const [preChat, setPreChat] = useState<Record<string, string> | null>(null);
  const [offlineError, setOfflineError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  /** Who ended it, so the wording is right. Null until something actually ends. */
  const [endedBy, setEndedBy] = useState<'visitor' | 'agent' | null>(null);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const [ending, setEnding] = useState(false);
  const [endError, setEndError] = useState<string | null>(null);

  /**
   * A message the visitor wrote before giving their details: held while the pre-chat form is
   * shown in the conversation, sent the moment it is filled in.
   */
  const [detailsFor, setDetailsFor] = useState<string | null>(null);
  /** The loader opened the window for the greeting; ask for it once the socket is up. */
  const wantsGreeting = useRef(false);
  const connected = useRef(false);
  /** The latest `greet` and business name, for handlers that were bound once. */
  const greetRef = useRef<(chat: ChatClient) => Promise<void>>(async () => undefined);
  const businessName = useRef('');

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
          connected.current = state === 'connected';
          /**
           * Say which page this is the moment the socket is up - and again on every reconnect.
           *
           * Presence is written from the socket's idea of the current page, which starts empty:
           * without this the visitor showed online with no page until they navigated, and a
           * visitor who stays on one page (most of them) never showed one at all.
           */
          if (state === 'connected' && hostPage.current) {
            chat.reportPage(hostPage.current.url, hostPage.current.title);
          }
          if (state === 'connected' && wantsGreeting.current) {
            wantsGreeting.current = false;
            void greetRef.current(chat);
          }
        },
        onAvailability: (available) => setOnline(available),
        onPresenter: (next) => setPresenter(next),
        onMessage: (message, live) => {
          upsertMessage(message, 'sent');
          if (message.senderType !== 'visitor') {
            setAgentTyping(false);
            // A trigger can greet somebody who is still on a form. Show them what was sent.
            setView((current) => viewAfterInboundMessage(current, message.senderType));
            // A reply that just happened: the host page chimes, and tells them if they are away.
            if (live && message.type !== 'system' && message.type !== 'note') {
              bridge?.alert(message.senderName ?? businessName.current, message.type === 'text' ? message.body : 'Sent you a file');
            }
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
          setTypingName(payload.typing ? (payload.actorName ?? null) : null);
          if (typingTimer.current) window.clearTimeout(typingTimer.current);
          if (payload.typing) {
            // A safety net: the server's typing key expires, but if its "stopped" event is lost
            // the indicator must not stay on forever.
            typingTimer.current = window.setTimeout(() => setAgentTyping(false), 7000);
          }
        },
        onConversation: (payload) => {
          if (payload.status === 'closed') {
            setClosed(true);
            // A close the panel did not initiate came from the other side.
            setEndedBy((current) => current ?? 'agent');
          }
          if (payload.status === 'open') {
            setClosed(false);
            setEndedBy(null);
          }
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
          e: params.embedTicket,
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
        if (result.presenter !== undefined) setPresenter(result.presenter);

        const behaviour = result.widget.config.behaviour;
        const knowsVisitor = Boolean(result.visitor.name || result.visitor.email);

        /**
         * Nobody available and the customer collects offline messages: ask for one.
         *
         * This is decided from real presence, not from a schedule. A team that says it is open
         * but has nobody signed in is offline as far as the person waiting is concerned.
         */
        if (!result.agentsAvailable && behaviour.offlineFormEnabled) {
          setView('offline');
        } else {
          setView(behaviour.preChatEnabled && !knowsVisitor ? 'prechat' : 'chat');
        }

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
      onOpen(proactive) {
        isOpen.current = true;
        bridge.setUnread(0);
        client.current?.markRead();
        if (proactive) {
          const chat = client.current;
          if (chat && chat.hasConversation) return;
          if (chat && connected.current) void greetRef.current(chat);
          else wantsGreeting.current = true;
        }
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
  // With a person on the chat, their name is the subtitle: the visitor is talking to somebody.
  const subtitle = presenter && !closed && messages.some((m) => m.senderType === 'agent')
    ? `${presenter.name} · ${online ? 'online' : 'away'}`
    : online
      ? config.content.subtitleOnline
      : config.content.subtitleOffline;

  /**
   * Keep the answers, do not send them yet.
   *
   * They travel with the first message, so the conversation is created with its pre-chat data
   * already attached - one write, and no window in which an agent can open a conversation whose
   * "who is this" panel is still empty. The server re-applies the configured field list, so what
   * is held here is a claim, not a decision.
   */
  /** The window opened on its own: ask the server to say hello. It may decline; that is fine. */
  async function greet(chat: ChatClient) {
    if (resolved.preview || chat.hasConversation || closed) return;
    try {
      const message = await chat.greet();
      if (!message) return;
      upsertMessage(message, 'sent');
      setView((current) => viewAfterInboundMessage(current, message.senderType));
      if (isOpen.current) chat.markRead();
    } catch {
      // Not greeted, then. The visitor can still open the chat themselves.
    }
  }

  greetRef.current = greet;
  businessName.current = config.content.businessName;

  function handlePreChat(values: Record<string, string>) {
    setPreChat(values);
    setView('chat');
  }

  /** The details form shown inside the conversation, before the visitor's first message goes. */
  function handleDetailsThenSend(values: Record<string, string>) {
    const body = detailsFor;
    setDetailsFor(null);
    setPreChat(values);
    if (body) sendMessage(body, values);
  }

  /**
   * Leave a message when nobody is available.
   *
   * The server validates the form again and decides what is required; anything it refuses is
   * shown here rather than swallowed, because this is the visitor's only channel right now.
   */
  async function handleOfflineSubmit(values: Record<string, string>) {
    if (resolved.preview) {
      setPreChat(values);
      setView('offline_sent');
      return;
    }
    if (!session) return;
    setSubmitting(true);
    setOfflineError(null);
    try {
      await widgetApi.offlineMessage(session.token, values);
      setPreChat(values);
      setView('offline_sent');
    } catch (error) {
      setOfflineError(
        error instanceof WidgetApiError && error.status !== 0
          ? error.message
          : 'We could not send that. Please try again in a moment.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * The ticket the AI assistant offered.
   *
   * The same form as the offline one, pre-filled with what the visitor asked, and sent with the
   * conversation id so the ticket attaches to this chat. The assistant confirms the number in the
   * transcript itself, which is why nothing is rendered here on success beyond closing the form.
   */
  async function handleTicketSubmit(values: Record<string, string>) {
    if (!session || !ticketFor) return;
    setSubmitting(true);
    setTicketError(null);
    try {
      await widgetApi.offlineMessage(session.token, values, ticketFor);
      setTicketFor(null);
    } catch (error) {
      setTicketError(
        error instanceof WidgetApiError && error.status !== 0
          ? error.message
          : 'We could not send that. Please try again in a moment.',
      );
    } finally {
      setSubmitting(false);
    }
  }

  const lastVisitorQuestion = [...messages].reverse().find((m) => m.senderType === 'visitor' && m.type === 'text')?.body ?? '';

  /**
   * Fetch a download URL for one file.
   *
   * Per request and short-lived. The panel never holds one for longer than it takes to show a
   * picture or open a file, because a URL that outlives the conversation is a file that outlives
   * the conversation.
   */
  /** Thumbs up or down: optimistic, and quietly put back if the server disagrees. */
  async function rateMessage(messageId: string, rating: 'up' | 'down' | null): Promise<void> {
    const token = session?.token ?? readToken(resolved.publicId);
    if (!token) return;
    const apply = (value: 'up' | 'down' | null | undefined) =>
      setMessages((current) =>
        current.map((m) =>
          m.id === messageId && m.ai
            ? { ...m, ai: { ...m.ai, ...(value ? { rating: value } : {}), ...(value ? {} : { rating: undefined }) } }
            : m,
        ),
      );
    const previous = messages.find((m) => m.id === messageId)?.ai?.rating;
    apply(rating);
    try {
      await widgetApi.feedback(token, messageId, rating);
    } catch {
      apply(previous);
    }
  }

  async function resolveAttachmentUrl(attachmentId: string): Promise<string> {
    const token = session?.token ?? readToken(resolved.publicId);
    if (!token) throw new Error('no token');
    const result = await widgetApi.attachmentUrl(token, attachmentId);
    return result.url;
  }

  /**
   * Send a file.
   *
   * Three steps, and the bubble appears at the first one: ask for a target, PUT the bytes straight
   * to storage, then tell the server it is there. A failure at any step leaves the bubble marked
   * rather than removing it - the visitor chose that file, and making it disappear tells them
   * nothing about what happened to it.
   */
  async function handleAttach(file: File): Promise<void> {
    const chat = client.current;
    const token = session?.token;
    if (!chat?.conversationId || !token) return;

    const clientMessageId = ulid();
    const optimistic: PanelMessage = {
      id: clientMessageId,
      conversationId: chat.conversationId,
      seq: Number.MAX_SAFE_INTEGER,
      clientMessageId,
      senderType: 'visitor',
      senderId: null,
      senderName: null,
      type: 'file',
      body: file.name,
      createdAt: new Date().toISOString(),
      readAt: null,
      delivery: 'pending',
      uploading: { fileName: file.name, byteSize: file.size },
    };
    setMessages((current) => [...current, optimistic]);

    try {
      const signed = await widgetApi.signUpload(token, {
        conversationId: chat.conversationId,
        fileName: file.name,
        byteSize: file.size,
      });

      const put = await fetch(signed.uploadUrl, { method: 'PUT', body: file });
      if (!put.ok) throw new Error(`upload failed: ${put.status}`);

      const confirmed = await widgetApi.confirmUpload(token, signed.attachmentId, clientMessageId);
      // The server's message replaces the optimistic one, keyed on the client id it carries back.
      upsertMessage(confirmed.message, 'sent');
    } catch {
      setMessages((current) =>
        current.map((message) =>
          message.clientMessageId === clientMessageId
            ? { ...message, delivery: 'failed', uploading: undefined }
            : message,
        ),
      );
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
    /**
     * The greeting opened this conversation, so the pre-chat form was never shown. When the
     * customer asks for details first, ask now, before the visitor's first words go out.
     */
    const knowsVisitor = Boolean(session?.visitor.name || session?.visitor.email);
    const firstWords = !messages.some((m) => m.senderType === 'visitor');
    if (config.behaviour.preChatEnabled && !preChat && !knowsVisitor && firstWords && !resolved.preview) {
      setDetailsFor(body);
      return;
    }
    sendMessage(body, preChat ?? undefined);
  }

  function sendMessage(body: string, details: Record<string, string> | undefined) {
    const chat = client.current;
    if (!chat) return;
    const firstWords = !messages.some((m) => m.senderType === 'visitor');
    if (firstWords) {
      bridge?.engaged();
      bridge?.requestPermission();
    }

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

    // Details travel on `start`, which the server also uses to continue the greeting's
    // conversation - the visitor's first words arrive with their name attached.
    const promise = chat.conversationId && !details
      ? chat.send(clientMessageId, body)
      : chat.start(clientMessageId, body, details);

    promise
      .then((message) => {
        // Sent once. A later message must not re-submit answers the conversation already holds.
        setPreChat(null);
        upsertMessage(message, 'sent');
      })
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

  /**
   * End the chat.
   *
   * The panel does not mark itself closed optimistically: it waits for the server, because the
   * agent's screen and this one must agree about whether the conversation is still live. A
   * failure leaves the chat exactly as it was and says so.
   */
  async function handleEndChat() {
    if (resolved.preview) {
      setConfirmingEnd(false);
      setClosed(true);
      setEndedBy('visitor');
      return;
    }

    setEnding(true);
    setEndError(null);
    try {
      await client.current?.endChat();
      setEndedBy('visitor');
      setClosed(true);
      setConfirmingEnd(false);
    } catch {
      setEndError('That did not go through. Please try again.');
    } finally {
      setEnding(false);
    }
  }

  /**
   * Start again after a chat has ended.
   *
   * The transcript is cleared and the client forgets the old conversation, so the next message
   * creates a fresh one rather than resuming a closed one. Pre-chat is not asked again: this
   * visitor already told us who they are, and asking twice in one session is a tax on someone who
   * has just been through a support conversation.
   */
  function handleStartNew() {
    client.current?.forgetConversation();
    setMessages([]);
    setClosed(false);
    setEndedBy(null);
    setEndError(null);
    setConfirmingEnd(false);
    setAgentTyping(false);
    setView('chat');
  }

  const composerDisabled =
    resolved.preview || connection !== 'connected' || closed || view !== 'chat';
  /** Switching from the offline form to a live chat, once somebody is actually there. */
  const startLiveChat = () => {
    setOfflineError(null);
    setView(config.behaviour.preChatEnabled && !preChat ? 'prechat' : 'chat');
  };
  /** Only offer to end something that exists and is still live. */
  const canEndChat = view === 'chat' && !closed && !resolved.preview && messages.length > 0;

  return (
    <div className="panel">
      <PanelHeader
        title={config.content.businessName}
        subtitle={subtitle}
        online={online}
        // The person's own picture when the business set one; the widget's picture otherwise.
        avatarUrl={presenter?.avatarUrl ?? config.appearance.avatarUrl}
        avatarName={presenter?.name ?? config.content.businessName}
        canEnd={canEndChat}
        onEnd={() => {
          setEndError(null);
          setConfirmingEnd(true);
        }}
        onMinimise={() => bridge?.requestClose()}
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
            onSubmit={handlePreChat}
          />
        </div>
      )}

      {view === 'offline' && (
        <div className="body">
          {online && <AgentArrivedBanner onStartChat={startLiveChat} />}
          <div className="bubble bubble-agent">{config.content.offlineMessage}</div>
          {offlineError && (
            <p className="field-error" role="alert">
              {offlineError}
            </p>
          )}
          <PreChatForm
            intro={config.forms.offlineIntro}
            fields={config.forms.offlineFields}
            submitLabel="Send message"
            busy={submitting}
            onSubmit={(values) => void handleOfflineSubmit(values)}
          />
        </div>
      )}

      {view === 'offline_sent' && (
        <OfflineSent
          email={preChat?.['email'] ?? session?.visitor.email ?? null}
          canChat={online && !resolved.preview}
          onStartChat={startLiveChat}
        />
      )}

      {view === 'chat' && (
        <>
          <MessageList
            messages={messages}
            welcome={config.content.welcomeMessage}
            agentTyping={agentTyping && config.behaviour.showAgentTyping}
            typingName={typingName}
            resolveAttachmentUrl={resolveAttachmentUrl}
            onRate={!resolved.preview && client.current?.conversationId ? rateMessage : undefined}
            offer={
              !resolved.preview && !closed && client.current?.conversationId && !ticketFor
                ? {
                    dismissed: offerDismissedFor === messages[messages.length - 1]?.id,
                    onCreateTicket: () => {
                      setTicketError(null);
                      setTicketFor(client.current?.conversationId ?? null);
                    },
                    onDismiss: () => setOfferDismissedFor(messages[messages.length - 1]?.id ?? null),
                  }
                : undefined
            }
          />

          {ticketFor ? (
            <div className="ticket-form">
              {ticketError && (
                <p className="field-error" role="alert">
                  {ticketError}
                </p>
              )}
              <PreChatForm
                intro="Leave your details and the team will follow up by email."
                fields={config.forms.offlineFields}
                submitLabel="Create ticket"
                busy={submitting}
                initialValues={{
                  ...(session?.visitor.name ? { name: session.visitor.name } : {}),
                  ...(session?.visitor.email ? { email: session.visitor.email } : {}),
                  ...(preChat ?? {}),
                  message: lastVisitorQuestion,
                }}
                onSubmit={(values) => void handleTicketSubmit(values)}
                onCancel={() => setTicketFor(null)}
              />
            </div>
          ) : detailsFor !== null ? (
            <div className="ticket-form">
              <PreChatForm
                intro={config.forms.preChatIntro}
                fields={config.forms.preChatFields}
                submitLabel="Send"
                busy={submitting}
                onSubmit={handleDetailsThenSend}
                onCancel={() => setDetailsFor(null)}
              />
            </div>
          ) : closed ? (
            <ChatEnded
              endedByVisitor={endedBy === 'visitor'}
              busy={connection !== 'connected'}
              onStartNew={handleStartNew}
            />
          ) : confirmingEnd ? (
            <EndChatConfirm
              busy={ending}
              error={endError}
              onCancel={() => {
                setConfirmingEnd(false);
                setEndError(null);
              }}
              onConfirm={() => void handleEndChat()}
            />
          ) : (
            <Composer
              placeholder={config.content.inputPlaceholder}
              disabled={composerDisabled}
              onSend={handleSend}
              onTyping={(typing) => client.current?.typing(typing)}
              maxBytes={session?.maxUploadBytes ?? 10 * 1024 * 1024}
              // A file needs somewhere to go. Until the visitor has said something there is no
              // conversation, so there is nothing to attach it to - and an attach button that
              // silently does nothing is worse than one that is not there.
              onAttach={
                client.current?.conversationId && !closed && !resolved.preview
                  ? (file) => void handleAttach(file)
                  : undefined
              }
            />
          )}
        </>
      )}

      {/*
        Branded until the plan says otherwise, and until the server has said so. `session` is null
        before bootstrap answers, and defaulting to branded there means a plan that has not paid
        for removal never gets a frame without it.
      */}
      {view !== 'chat' && (session?.showBranding ?? true) && (
        <p className="footer">Powered by SmartChat</p>
      )}
    </div>
  );
}
