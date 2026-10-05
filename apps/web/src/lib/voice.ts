import type {
  CallDto,
  CallJoinGrant,
  VoiceLanguage,
  VoicePhraseKey,
  VoicePhrases,
  VoiceSettingsDto,
} from '@smartchat/types';
import { VOICE_PHRASE_KEYS } from '@smartchat/types';
import { api } from './api-client';

/**
 * Voice calls, as the dashboard talks to the API about them.
 *
 * Two halves. The calls themselves - answer, decline, transfer, hang up - are one request per
 * transition, and every answer is the whole call so a screen never has to merge. The settings
 * page is the other half: what the owner may configure for one website, and the pure function
 * that turns an edited form back into the smallest PATCH that says what changed.
 */

// --- calls ---------------------------------------------------------------------

export interface AnswerResult {
  call: CallDto;
  join: CallJoinGrant;
}

export type TransferTarget = { to: 'member'; memberId: string } | { to: 'ai' };

/** `GET /calls/:id/targets`: who a call could go to right now, as the server sees it. */
export interface TransferTargets {
  /** Online colleagues, without me. */
  members: Array<{ id: string; name: string | null }>;
  /** Whether the AI may take a transfer here: switched on, set up, in the plan, under its cap. */
  ai: boolean;
}

export const callsApi = {
  list: (
    query: { status?: CallDto['status']; propertyId?: string; limit?: number },
    signal?: AbortSignal,
  ) =>
    api
      .get<CallDto[]>('/calls', { query: { ...query }, ...(signal ? { signal } : {}) })
      .then((result) => result.data),
  get: (callId: string) => api.get<CallDto>(`/calls/${callId}`).then((result) => result.data),
  answer: (callId: string) =>
    api.post<AnswerResult>(`/calls/${callId}/answer`).then((result) => result.data),
  decline: (callId: string) =>
    api.post<CallDto>(`/calls/${callId}/decline`).then((result) => result.data),
  /** Told once the media room is connected, so the call can go live without waiting for the webhook. */
  joined: (callId: string) =>
    api.post<CallDto>(`/calls/${callId}/joined`).then((result) => result.data),
  transfer: (callId: string, target: TransferTarget) =>
    api.post<CallDto>(`/calls/${callId}/transfer`, target).then((result) => result.data),
  /** Asked when the picker opens, so it shows who is there at that moment rather than a cached list. */
  targets: (callId: string, signal?: AbortSignal) =>
    api
      .get<TransferTargets>(`/calls/${callId}/targets`, signal ? { signal } : {})
      .then((result) => result.data),
  end: (callId: string) => api.post<CallDto>(`/calls/${callId}/end`).then((result) => result.data),
};

// --- settings ------------------------------------------------------------------

/** `GET /properties/:id/voice`: the settings, every phrase resolved and its default, and the month's minutes. */
export interface VoiceSettingsView extends VoiceSettingsDto {
  resolvedPhrases: Record<VoicePhraseKey, Record<VoiceLanguage, string>>;
  /** What the assistant says where there is no override: the placeholder under every box. */
  defaultPhrases: Record<VoicePhraseKey, Record<VoiceLanguage, string>>;
  usage: { minutesUsed: number; minutesLimit: number | null };
  /** False when calling is switched off for the whole installation; the page then only explains. */
  available: boolean;
}

export const voiceApi = {
  get: (propertyId: string, signal?: AbortSignal) =>
    api
      .get<VoiceSettingsView>(`/properties/${propertyId}/voice`, signal ? { signal } : {})
      .then((result) => result.data),
  update: (propertyId: string, patch: VoiceSettingsPatch) =>
    api
      .patch<VoiceSettingsView>(`/properties/${propertyId}/voice`, patch)
      .then((result) => result.data),
};

/** The body of `PATCH /properties/:id/voice`: every field optional, phrases as overrides only. */
export interface VoiceSettingsPatch {
  enabled?: boolean;
  ringSeconds?: number;
  aiAnswers?: boolean;
  aiMaxSeconds?: number;
  defaultLanguage?: VoiceLanguage;
  voiceEn?: string;
  voiceBn?: string;
  voiceBnSpeaker?: number;
  phrases?: VoicePhrases;
}

/** The text in every phrase box: the override, or '' for "use the default". */
export type PhraseDraft = Record<VoicePhraseKey, Record<VoiceLanguage, string>>;

/** What the settings form edits. Scalars as the API has them; phrases as the boxes show them. */
export interface VoiceDraft {
  enabled: boolean;
  ringSeconds: number;
  aiAnswers: boolean;
  aiMaxSeconds: number;
  defaultLanguage: VoiceLanguage;
  voiceEn: string;
  voiceBn: string;
  voiceBnSpeaker: number;
  phrases: PhraseDraft;
}

export const VOICE_LANGUAGE_LABEL: Record<VoiceLanguage, string> = { en: 'English', bn: 'Bengali' };

export const RING_SECONDS = { min: 5, max: 120 } as const;
export const AI_MAX_SECONDS = { min: 60, max: 3_600 } as const;
/** The Bangladeshi Piper model ships sixteen speakers; the API accepts up to 63 for future models. */
export const BN_SPEAKERS = { min: 0, max: 15 } as const;

/** The voices the speech service ships, by language. The first of each list is the default. */
export const ENGLISH_VOICES: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'en_female', label: 'Kokoro · female (default)' },
  { id: 'en_male', label: 'Kokoro · male' },
  { id: 'en_piper', label: 'Piper' },
];
export const BENGALI_VOICES: ReadonlyArray<{ id: string; label: string; speakers: boolean }> = [
  { id: 'bn_bd', label: 'Bangladeshi · Piper (default)', speakers: true },
  { id: 'bn_female', label: 'Studio · female', speakers: false },
];

/** What each phrase is for, in the words of the settings page. */
export const PHRASE_LABELS: Record<VoicePhraseKey, { label: string; hint: string }> = {
  greeting: { label: 'Greeting', hint: 'The first thing the assistant says when it picks up.' },
  holdOn: { label: 'Hold on', hint: 'While it looks something up.' },
  stillChecking: {
    label: 'Still checking',
    hint: 'When the caller asks something new before the last answer is ready.',
  },
  afterWait: { label: 'After a wait', hint: 'Before an answer that took a while.' },
  ticketOffer: { label: 'Ticket offer', hint: 'When it cannot help and offers to open a ticket.' },
  ticketAskEmail: {
    label: 'Ask for an email',
    hint: 'The caller types their address in the chat box.',
  },
  ticketCreated: { label: 'Ticket created', hint: 'Uses {number} and {email}.' },
  ticketDeclined: { label: 'Ticket declined', hint: 'When the caller says no to a ticket.' },
  handoff: { label: 'Handing to a person', hint: 'Before the team is rung.' },
  handoffFailed: { label: 'Nobody picked up', hint: 'When the team was rung and nobody answered.' },
  noAgent: { label: 'Nobody online', hint: 'When a person is asked for and nobody is available.' },
  stillThere: { label: 'Still there?', hint: 'After a long silence from the caller.' },
  goodbye: { label: 'Goodbye', hint: 'When the call is over.' },
  maxLength: {
    label: 'Time limit reached',
    hint: 'When the call hits the maximum AI call length.',
  },
};

/** The placeholders the assistant fills in, so the page can say so once. */
export const PHRASE_PLACEHOLDERS = ['{assistant}', '{business}', '{number}', '{email}'] as const;

/** The form's starting values, from what the API returned. */
export function draftFromSettings(view: VoiceSettingsDto): VoiceDraft {
  const phrases = {} as PhraseDraft;
  for (const key of VOICE_PHRASE_KEYS) {
    phrases[key] = { en: view.phrases[key]?.en ?? '', bn: view.phrases[key]?.bn ?? '' };
  }
  return {
    enabled: view.enabled,
    ringSeconds: view.ringSeconds,
    aiAnswers: view.aiAnswers,
    aiMaxSeconds: view.aiMaxSeconds,
    defaultLanguage: view.defaultLanguage,
    voiceEn: view.voiceEn,
    voiceBn: view.voiceBn,
    voiceBnSpeaker: view.voiceBnSpeaker,
    phrases,
  };
}

/**
 * The overrides a draft amounts to: trimmed, with empty boxes left out.
 *
 * Leaving an empty box out is what "use the default" means on the wire - the API replaces the
 * override bag whole, so an entry that is absent is an entry that is reset.
 */
export function overridesFromDraft(phrases: PhraseDraft): VoicePhrases {
  const out: VoicePhrases = {};
  for (const key of VOICE_PHRASE_KEYS) {
    const en = phrases[key].en.trim();
    const bn = phrases[key].bn.trim();
    if (en === '' && bn === '') continue;
    out[key] = { ...(en !== '' ? { en } : {}), ...(bn !== '' ? { bn } : {}) };
  }
  return out;
}

/** The saved overrides in the same normalised shape, so two bags can be compared as JSON. */
function normalisedOverrides(phrases: VoicePhrases): VoicePhrases {
  const out: VoicePhrases = {};
  for (const key of VOICE_PHRASE_KEYS) {
    const en = phrases[key]?.en?.trim() ?? '';
    const bn = phrases[key]?.bn?.trim() ?? '';
    if (en === '' && bn === '') continue;
    out[key] = { ...(en !== '' ? { en } : {}), ...(bn !== '' ? { bn } : {}) };
  }
  return out;
}

/**
 * The PATCH for a save: only the fields that differ from what was loaded.
 *
 * Sending every field would be simpler and wrong: a stale page would silently put back a value a
 * colleague changed a minute ago. Phrases are the one bag that travels whole, because the API
 * replaces the overrides rather than merging them - but it travels only when something in it
 * changed.
 */
export function buildVoicePatch(current: VoiceSettingsDto, draft: VoiceDraft): VoiceSettingsPatch {
  const patch: VoiceSettingsPatch = {};
  if (draft.enabled !== current.enabled) patch.enabled = draft.enabled;
  if (draft.ringSeconds !== current.ringSeconds) patch.ringSeconds = draft.ringSeconds;
  if (draft.aiAnswers !== current.aiAnswers) patch.aiAnswers = draft.aiAnswers;
  if (draft.aiMaxSeconds !== current.aiMaxSeconds) patch.aiMaxSeconds = draft.aiMaxSeconds;
  if (draft.defaultLanguage !== current.defaultLanguage)
    patch.defaultLanguage = draft.defaultLanguage;
  if (draft.voiceEn !== current.voiceEn) patch.voiceEn = draft.voiceEn;
  if (draft.voiceBn !== current.voiceBn) patch.voiceBn = draft.voiceBn;
  if (draft.voiceBnSpeaker !== current.voiceBnSpeaker) patch.voiceBnSpeaker = draft.voiceBnSpeaker;

  const overrides = overridesFromDraft(draft.phrases);
  if (JSON.stringify(overrides) !== JSON.stringify(normalisedOverrides(current.phrases))) {
    patch.phrases = overrides;
  }
  return patch;
}

/** Whether the form has anything to save. */
export function isDirty(current: VoiceSettingsDto, draft: VoiceDraft): boolean {
  return Object.keys(buildVoicePatch(current, draft)).length > 0;
}

/** "12 of 300 minutes this month", or the unlimited spelling. */
export function usageSentence(usage: { minutesUsed: number; minutesLimit: number | null }): string {
  if (usage.minutesLimit === null) return `${usage.minutesUsed} minutes this month, no limit`;
  return `${usage.minutesUsed} of ${usage.minutesLimit} minutes this month`;
}
