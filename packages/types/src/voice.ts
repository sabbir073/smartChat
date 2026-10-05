/**
 * Voice calls: the shapes the widget, the dashboard, the API and the voice agent all agree on.
 *
 * A call is a chat head. It belongs to the conversation the visitor was in, the team is rung in
 * the dashboard, whoever answers talks, and the AI answers when nobody does. Everything below is
 * the state every screen renders from; the state machine itself lives in core's CallService.
 */

export const CallStatus = {
  /** Somebody is being rung: the whole team at the start, one target during a transfer. */
  RINGING: 'ringing',
  /** Answered; the parties are joining the media room. */
  CONNECTING: 'connecting',
  ACTIVE: 'active',
  ENDED: 'ended',
} as const;
export type CallStatus = (typeof CallStatus)[keyof typeof CallStatus];

export type CallLegKind = 'visitor' | 'member' | 'ai';

export type CallEndReason =
  | 'completed'
  | 'no_answer'
  | 'cancelled'
  | 'declined'
  | 'visitor_left'
  | 'agent_left'
  | 'ai_ended'
  | 'allowance'
  | 'failed';

export type VoiceLanguage = 'en' | 'bn';
export const VOICE_LANGUAGES: readonly VoiceLanguage[] = ['en', 'bn'];

/** Where a call is right now, as every screen sees it. Sent whole on every change. */
export interface CallDto {
  id: string;
  propertyId: string;
  conversationId: string;
  visitorId: string;
  status: CallStatus;
  /** Who has it: a member (by id, with a name for the screens) or the AI. Null while ringing. */
  answeredByMemberId: string | null;
  answeredByName: string | null;
  handledByAi: boolean;
  /** During a transfer: who is being rung. */
  pending: { kind: 'member'; memberId: string; name: string | null } | { kind: 'ai' } | null;
  /** The visitor as the chat head shows them. Claims from the pre-chat form, never authorisation. */
  visitor: { name: string | null; email: string | null };
  language: VoiceLanguage | null;
  startedAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: CallEndReason | null;
  durationSeconds: number;
}

/**
 * What one party needs to join the media room: the signalling URL and a short-lived token that
 * opens exactly this room for exactly this identity. Minted per leg, never shared.
 */
export interface CallJoinGrant {
  url: string;
  token: string;
  roomName: string;
  identity: string;
}

/** The fixed things the AI says on a call, each in both languages. */
export const VOICE_PHRASE_KEYS = [
  'greeting',
  'holdOn',
  'stillChecking',
  'afterWait',
  'ticketOffer',
  'ticketAskEmail',
  'ticketCreated',
  'ticketDeclined',
  'handoff',
  'handoffFailed',
  'noAgent',
  'stillThere',
  'goodbye',
  'maxLength',
] as const;
export type VoicePhraseKey = (typeof VOICE_PHRASE_KEYS)[number];
export type VoicePhrases = Partial<Record<VoicePhraseKey, Partial<Record<VoiceLanguage, string>>>>;

export interface VoiceSettingsDto {
  enabled: boolean;
  ringSeconds: number;
  aiAnswers: boolean;
  aiMaxSeconds: number;
  defaultLanguage: VoiceLanguage;
  voiceEn: string;
  voiceBn: string;
  voiceBnSpeaker: number;
  /** Overrides only. The defaults are shown next to them by the settings page. */
  phrases: VoicePhrases;
  /** Whether the plan includes calling at all; the switch above is meaningless without it. */
  planIncludesVoice: boolean;
}

/** What the widget is told about calling, as part of its public configuration. */
export interface WidgetVoiceConfig {
  enabled: boolean;
}
