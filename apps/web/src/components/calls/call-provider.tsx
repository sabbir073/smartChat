'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { CallDto } from '@smartchat/types';
import { ApiError, api } from '@/lib/api-client';
import { useAuth } from '@/lib/auth-context';
import { useBilling } from '@/lib/billing';
import { connectCallRoom, type CallRoom } from '@/lib/call-room';
import {
  applyCall,
  callerLabel,
  incomingFor,
  isMine,
  removeCall,
  shouldRing,
  type CallMap,
} from '@/lib/call-store';
import { armChimeOnGesture, startRing, stopRing } from '@/lib/chime';
import type { PropertyDto } from '@/lib/types';
import { callsApi, type TransferTarget } from '@/lib/voice';
import { useToast } from '@/components/ui';

/**
 * Everything the dashboard knows about calls, in one place for the whole shell.
 *
 * The socket lives in the inbox, so the inbox feeds this provider; but calls ring for people who
 * are on the settings page too, so the provider also reads the live calls itself - once on
 * mount, again whenever the socket comes back (to catch what was missed), and every few seconds
 * while no socket is feeding it. The map it keeps is rendered strictly from the latest DTO per
 * call, and the rules for who sees what live in lib/call-store.ts.
 *
 * It also holds the one media room this tab may be in. The ringing card, the bar in the thread
 * and the floating pill all act on the same room, which is what makes "one call at a time per
 * tab" true rather than hoped for.
 *
 * Who "me" is comes from the session (`/auth/me` names the membership), because every call DTO
 * speaks in member ids: who holds it, who a transfer is aimed at.
 */

/** How long an ended call stays on screen so the bar can say so before it goes. */
const ENDED_LINGER_MS = 4_000;
/** How long "Taken by …" stays where the card was. */
const NOTICE_MS = 3_500;
/** How often the live calls are re-read while no socket is feeding the provider. */
const POLL_MS = 10_000;

const SOUND_KEY = 'inbox.sound';

export interface ActiveCall {
  callId: string;
  conversationId: string;
  /** `joining` from Answer until the room is connected. */
  phase: 'joining' | 'connected';
  muted: boolean;
  /** The browser wants a gesture before it plays the caller; `unblockAudio` from a click clears it. */
  audioBlocked: boolean;
  micError: string | null;
}

export interface CallsContextValue {
  calls: CallMap;
  /** My membership id in the active account, from the session. Null outside any account. */
  me: string | null;
  /** The calls ringing for me, as cards. */
  incoming: CallDto[];
  /** Short notices shown where a card was: "Taken by Sabbir". */
  notices: ReadonlyMap<string, string>;
  active: ActiveCall | null;
  /** The conversation the inbox is showing, so the floating pill knows when it is redundant. */
  openConversationId: string | null;
  /** A conversation somebody asked to see; the inbox opens it and clears this. */
  openRequest: string | null;
  soundOn: boolean;
  setSoundOn(on: boolean): void;
  propertyName(propertyId: string): string;

  ingest(call: CallDto): void;
  setFeedLive(live: boolean): void;
  setOpenConversation(conversationId: string | null): void;
  requestOpen(conversationId: string | null): void;

  answer(callId: string): Promise<void>;
  decline(callId: string): Promise<void>;
  hangUp(): Promise<void>;
  transfer(target: TransferTarget): Promise<void>;
  setMuted(muted: boolean): Promise<void>;
  unblockAudio(): Promise<void>;
}

const CallsContext = createContext<CallsContextValue | null>(null);

function readSoundPreference(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function CallProvider({ children }: { children: ReactNode }) {
  const { activeAccount, memberId: me } = useAuth();
  const { entitlements } = useBilling();
  const toast = useToast();
  const accountId = activeAccount?.id ?? null;
  // Nothing can ring on a plan without calling, so the provider stays quiet rather than polling.
  const planHasVoice = entitlements?.plan.voice === true;

  const [calls, setCalls] = useState<Map<string, CallDto>>(() => new Map());
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [notices, setNotices] = useState<Map<string, string>>(() => new Map());
  const [properties, setProperties] = useState<Map<string, string>>(() => new Map());
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [openConversationId, setOpenConversationId] = useState<string | null>(null);
  const [openRequest, setOpenRequest] = useState<string | null>(null);
  const [feedLive, setFeedLive] = useState(false);
  /** The API refused the call list for this role: there is no point asking again every ten seconds. */
  const [refused, setRefused] = useState(false);
  const [soundOn, setSoundOnState] = useState(readSoundPreference);

  // Read by async flows and timers, which must see the latest without being re-created.
  const callsRef = useRef<CallMap>(calls);
  callsRef.current = calls;
  const activeRef = useRef<ActiveCall | null>(active);
  activeRef.current = active;
  const roomRef = useRef<CallRoom | null>(null);
  const toastRef = useRef(toast);
  toastRef.current = toast;
  /** When each call was last updated by the socket, so a slower fetch cannot roll it back. */
  const touchedAt = useRef<Map<string, number>>(new Map());
  const lingerTimers = useRef<Map<string, number>>(new Map());

  // --- the map -----------------------------------------------------------------

  const forget = useCallback((callId: string) => {
    setCalls((current) => removeCall(current, callId));
    setDismissed((current) => {
      if (!current.has(callId)) return current;
      const next = new Set(current);
      next.delete(callId);
      return next;
    });
    touchedAt.current.delete(callId);
    lingerTimers.current.delete(callId);
  }, []);

  const scheduleForget = useCallback(
    (callId: string) => {
      const existing = lingerTimers.current.get(callId);
      if (existing) window.clearTimeout(existing);
      lingerTimers.current.set(
        callId,
        window.setTimeout(() => forget(callId), ENDED_LINGER_MS),
      );
    },
    [forget],
  );

  const ingest = useCallback(
    (call: CallDto) => {
      touchedAt.current.set(call.id, Date.now());
      setCalls((current) => applyCall(current, call));
      if (call.status === 'ended') scheduleForget(call.id);
    },
    [scheduleForget],
  );

  /**
   * Re-read every live call from the API and make the map agree with it.
   *
   * A call that is live here but absent there ended while this tab was not listening, so it is
   * dropped; one the socket touched after this request began is left alone, because the socket
   * is fresher than the response.
   */
  const refresh = useCallback(async () => {
    if (!planHasVoice || refused) return;
    const began = Date.now();
    let fetched: CallDto[];
    try {
      fetched = (
        await Promise.all([
          callsApi.list({ status: 'ringing' }),
          callsApi.list({ status: 'connecting' }),
          callsApi.list({ status: 'active' }),
        ])
      ).flat();
    } catch (error) {
      // Left as it was. The socket, or the next poll, will put it right - unless the role may
      // not see calls at all, in which case asking again would only be noise in the API's logs.
      if (error instanceof ApiError && error.status === 403) setRefused(true);
      return;
    }
    setCalls((current) => {
      let next: Map<string, CallDto> = new Map(current);
      const seen = new Set<string>();
      for (const call of fetched) {
        seen.add(call.id);
        if ((touchedAt.current.get(call.id) ?? 0) > began) continue;
        next = applyCall(next, call);
      }
      for (const [id, call] of current) {
        if (call.status === 'ended' || seen.has(id)) continue;
        if ((touchedAt.current.get(id) ?? 0) > began) continue;
        next.delete(id);
      }
      return next;
    });
  }, [planHasVoice, refused]);

  // Everything is per account: a switch starts from nothing.
  useEffect(() => {
    setCalls(new Map());
    setDismissed(new Set());
    setNotices(new Map());
    setRefused(false);
    touchedAt.current = new Map();
    for (const timer of lingerTimers.current.values()) window.clearTimeout(timer);
    lingerTimers.current = new Map();
  }, [accountId]);

  useEffect(() => {
    void refresh();
  }, [refresh, accountId]);

  // While the socket is down, or no screen owns one, the live calls are polled instead.
  useEffect(() => {
    if (feedLive || !planHasVoice) return;
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [feedLive, planHasVoice, refresh]);

  // The socket just came (back) up: whatever happened while it was down is in the API.
  useEffect(() => {
    if (feedLive) void refresh();
  }, [feedLive, refresh]);

  // --- what the websites are called -------------------------------------------------

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    void api
      .get<PropertyDto[]>('/properties', { signal: controller.signal })
      .then((result) =>
        setProperties(new Map(result.data.map((property) => [property.id, property.name]))),
      )
      .catch(() => undefined);
    return () => controller.abort();
  }, [accountId]);

  const propertyName = useCallback(
    (propertyId: string) => properties.get(propertyId) ?? propertyId,
    [properties],
  );

  // --- what rings for me -----------------------------------------------------------

  const incoming = useMemo(() => incomingFor(calls, me, dismissed), [calls, me, dismissed]);
  const incomingCount = incoming.length;
  const onCall = active !== null;

  useEffect(() => {
    armChimeOnGesture();
  }, []);

  // Keyed by the count rather than the array: a DTO refresh for a call already ringing must not
  // restart the tone, and `startRing` is idempotent for the rest.
  useEffect(() => {
    if (shouldRing({ incoming: incomingCount, soundOn, onCall })) startRing();
    else stopRing();
  }, [incomingCount, soundOn, onCall]);

  useEffect(() => stopRing, []);

  /**
   * A desktop notification per call while this tab is hidden, closed again when the call stops
   * ringing - whoever answered it, the visitor who gave up, or me from another tab.
   */
  const shown = useRef<Map<string, Notification>>(new Map());
  useEffect(() => {
    const live = new Set(incoming.map((call) => call.id));
    for (const [id, notification] of shown.current) {
      if (!live.has(id)) {
        notification.close();
        shown.current.delete(id);
      }
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    if (typeof document === 'undefined' || document.visibilityState === 'visible') return;
    for (const call of incoming) {
      if (shown.current.has(call.id)) continue;
      try {
        const notification = new Notification('Incoming call', {
          body: `${callerLabel(call)} · ${propertyName(call.propertyId)}`,
          tag: `call-${call.id}`,
        });
        notification.onclick = () => {
          window.focus();
          notification.close();
        };
        shown.current.set(call.id, notification);
      } catch {
        // Notifications are a nicety; the ring and the card are the message.
      }
    }
  }, [incoming, propertyName]);

  const setSoundOn = useCallback((on: boolean) => {
    setSoundOnState(on);
    try {
      localStorage.setItem(SOUND_KEY, on ? 'on' : 'off');
    } catch {
      /* remembered for this session only */
    }
  }, []);

  const notice = useCallback((callId: string, text: string) => {
    setNotices((current) => new Map(current).set(callId, text));
    window.setTimeout(() => {
      setNotices((current) => {
        if (!current.has(callId)) return current;
        const next = new Map(current);
        next.delete(callId);
        return next;
      });
    }, NOTICE_MS);
  }, []);

  const dismiss = useCallback((callId: string) => {
    setDismissed((current) => new Set(current).add(callId));
  }, []);

  // --- the room ----------------------------------------------------------------------

  const leaveRoom = useCallback(async () => {
    const room = roomRef.current;
    roomRef.current = null;
    setActive(null);
    if (room) await room.disconnect().catch(() => undefined);
  }, []);

  const answer = useCallback(
    async (callId: string) => {
      if (activeRef.current) {
        toastRef.current.error('You are already on a call. Hang up before answering another.');
        return;
      }
      const known = callsRef.current.get(callId);
      const placeholder: ActiveCall = {
        callId,
        conversationId: known?.conversationId ?? '',
        phase: 'joining',
        muted: false,
        audioBlocked: false,
        micError: null,
      };
      setActive(placeholder);
      activeRef.current = placeholder;
      stopRing();

      // Once the server has handed us the call, a failure to join the room is ours to clean up.
      let answered = false;
      try {
        const result = await callsApi.answer(callId);
        answered = true;
        ingest(result.call);
        setActive((current) =>
          current && current.callId === callId
            ? { ...current, conversationId: result.call.conversationId }
            : current,
        );

        const room = await connectCallRoom(result.join, {
          onDisconnected: () => {
            if (roomRef.current === room) {
              roomRef.current = null;
              setActive(null);
            }
          },
          onAudioBlocked: (blocked) =>
            setActive((current) =>
              current && current.callId === callId
                ? { ...current, audioBlocked: blocked }
                : current,
            ),
          onMicrophoneError: (message) =>
            setActive((current) =>
              current && current.callId === callId ? { ...current, micError: message } : current,
            ),
        });
        // The call may have ended while the room was being joined; then the room is not wanted.
        if (!activeRef.current || activeRef.current.callId !== callId) {
          await room.disconnect().catch(() => undefined);
          return;
        }
        roomRef.current = room;
        setActive((current) =>
          current && current.callId === callId ? { ...current, phase: 'connected' } : current,
        );
        // Belt to the webhook's braces: either one is enough to make the call live.
        await callsApi
          .joined(callId)
          .then(ingest)
          .catch(() => undefined);
      } catch (error) {
        await leaveRoom();
        if (answered) {
          // The call is ours on the server and nobody is on it. There is no way to hand it back
          // to the ring, so it is ended rather than left for the visitor to wait on in silence.
          await callsApi
            .end(callId)
            .then(ingest)
            .catch(() => undefined);
          toastRef.current.error(
            `The call's audio could not be connected, so the call was ended. ${describeJoinFailure(error)}`,
          );
          return;
        }
        if (error instanceof ApiError && error.status === 409) {
          // Somebody was quicker, or the visitor gave up. The latest DTO says which, by name.
          const fresh = await callsApi
            .get(callId)
            .catch(() => callsRef.current.get(callId) ?? null);
          if (fresh) ingest(fresh);
          dismiss(callId);
          notice(
            callId,
            fresh?.status === 'ended'
              ? 'The call ended before you could answer'
              : `Taken by ${fresh?.answeredByName ?? 'a colleague'}`,
          );
          return;
        }
        toastRef.current.error(
          error instanceof ApiError ? error.message : 'The call could not be answered.',
        );
      }
    },
    [dismiss, ingest, leaveRoom, notice],
  );

  const decline = useCallback(
    async (callId: string) => {
      dismiss(callId);
      try {
        ingest(await callsApi.decline(callId));
      } catch (error) {
        // The card is gone either way; a decline that did not reach the server times out on its own.
        if (!(error instanceof ApiError && (error.status === 409 || error.status === 404))) {
          toastRef.current.error(
            error instanceof ApiError ? error.message : 'Could not decline the call.',
          );
        }
      }
    },
    [dismiss, ingest],
  );

  const hangUp = useCallback(async () => {
    const current = activeRef.current;
    if (!current) return;
    await leaveRoom();
    try {
      ingest(await callsApi.end(current.callId));
    } catch (error) {
      // Leaving the room already ended the call on the server's side; only an unexpected refusal
      // is worth a word.
      if (!(
        error instanceof ApiError &&
        (error.status === 403 || error.status === 404 || error.status === 409)
      )) {
        toastRef.current.error(
          error instanceof ApiError ? error.message : 'Could not end the call.',
        );
      }
    }
  }, [ingest, leaveRoom]);

  const transfer = useCallback(
    async (target: TransferTarget) => {
      const current = activeRef.current;
      if (!current) return;
      try {
        ingest(await callsApi.transfer(current.callId, target));
        toastRef.current.info(
          target.to === 'ai'
            ? 'Handing the call to the AI assistant…'
            : 'Ringing your colleague. You keep the call until they answer.',
        );
      } catch (error) {
        toastRef.current.error(
          error instanceof ApiError ? error.message : 'The call could not be transferred.',
        );
      }
    },
    [ingest],
  );

  const setMuted = useCallback(async (muted: boolean) => {
    const room = roomRef.current;
    if (!room) return;
    try {
      await room.setMuted(muted);
      setActive((current) => (current ? { ...current, muted: room.isMuted() } : current));
    } catch {
      toastRef.current.error(
        muted ? 'Could not mute the microphone.' : 'Could not unmute the microphone.',
      );
    }
  }, []);

  const unblockAudio = useCallback(async () => {
    await roomRef.current?.startAudio().catch(() => undefined);
  }, []);

  /**
   * The DTO decides whether this tab still belongs in the room. The call ended, a colleague
   * accepted a transfer, the AI arrived: in each case the server has removed us or is about to,
   * and the bar must not go on offering a Hang up for a call that is no longer ours.
   */
  useEffect(() => {
    if (!active) return;
    const call = calls.get(active.callId);
    if (!call) return;
    const handedOver =
      (call.status === 'connecting' || call.status === 'active') &&
      call.pending === null &&
      !isMine(call, me);
    if (call.status === 'ended' || handedOver) void leaveRoom();
  }, [calls, active, me, leaveRoom]);

  // A closed tab leaves the room cleanly, so the caller hears nobody drop out mid-sentence.
  useEffect(() => {
    const onUnload = () => void roomRef.current?.disconnect();
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, []);

  useEffect(() => {
    void leaveRoom();
  }, [accountId, leaveRoom]);

  const setFeed = useCallback((live: boolean) => setFeedLive(live), []);
  const setOpenConversation = useCallback((id: string | null) => setOpenConversationId(id), []);
  const requestOpen = useCallback((id: string | null) => setOpenRequest(id), []);

  const value = useMemo<CallsContextValue>(
    () => ({
      calls,
      me,
      incoming,
      notices,
      active,
      openConversationId,
      openRequest,
      soundOn,
      setSoundOn,
      propertyName,
      ingest,
      setFeedLive: setFeed,
      setOpenConversation,
      requestOpen,
      answer,
      decline,
      hangUp,
      transfer,
      setMuted,
      unblockAudio,
    }),
    [
      calls,
      me,
      incoming,
      notices,
      active,
      openConversationId,
      openRequest,
      soundOn,
      setSoundOn,
      propertyName,
      ingest,
      setFeed,
      setOpenConversation,
      requestOpen,
      answer,
      decline,
      hangUp,
      transfer,
      setMuted,
      unblockAudio,
    ],
  );

  return <CallsContext.Provider value={value}>{children}</CallsContext.Provider>;
}

export function useCalls(): CallsContextValue {
  const value = useContext(CallsContext);
  if (!value) throw new Error('useCalls must be used inside CallProvider');
  return value;
}

/** One sentence on why the room could not be joined, for the person rather than the console. */
function describeJoinFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/not allowed|permission|NotAllowed/i.test(message))
    return 'Allow the microphone in the browser and try again.';
  if (/csp|content security|refused to connect/i.test(message))
    return 'The media server is not allowed by this page. Check LIVEKIT_PUBLIC_URL on the web service.';
  return 'Check your connection and try again.';
}
