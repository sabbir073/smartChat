import { describe, expect, it } from 'vitest';
import type { VoiceSettingsDto } from '@smartchat/types';
import {
  buildVoicePatch,
  draftFromSettings,
  isDirty,
  overridesFromDraft,
  usageSentence,
} from './voice';

/**
 * The settings form's one piece of logic: turning what was edited into the smallest PATCH, with
 * the phrase overrides spelled the way the API replaces them.
 */

function settings(overrides: Partial<VoiceSettingsDto> = {}): VoiceSettingsDto {
  return {
    enabled: false,
    ringSeconds: 30,
    aiAnswers: true,
    aiMaxSeconds: 600,
    defaultLanguage: 'en',
    voiceEn: 'en_female',
    voiceBn: 'bn_bd',
    voiceBnSpeaker: 3,
    phrases: {},
    planIncludesVoice: true,
    ...overrides,
  };
}

describe('buildVoicePatch', () => {
  it('sends nothing when nothing changed', () => {
    const current = settings({ phrases: { greeting: { en: 'Hi there' } } });
    expect(buildVoicePatch(current, draftFromSettings(current))).toEqual({});
    expect(isDirty(current, draftFromSettings(current))).toBe(false);
  });

  it('sends only the scalars that changed', () => {
    const current = settings();
    const draft = {
      ...draftFromSettings(current),
      ringSeconds: 45,
      defaultLanguage: 'bn' as const,
    };
    expect(buildVoicePatch(current, draft)).toEqual({ ringSeconds: 45, defaultLanguage: 'bn' });
  });

  it('sends the whole override bag when one phrase changes, empty boxes left out', () => {
    const current = settings({ phrases: { goodbye: { bn: 'বিদায়' } } });
    const draft = draftFromSettings(current);
    draft.phrases.greeting = { en: '  Welcome to the shop  ', bn: '' };
    expect(buildVoicePatch(current, draft)).toEqual({
      phrases: { greeting: { en: 'Welcome to the shop' }, goodbye: { bn: 'বিদায়' } },
    });
  });

  it('treats an emptied box as "back to the default" by leaving it out of the bag', () => {
    const current = settings({ phrases: { greeting: { en: 'Custom hello', bn: 'কাস্টম' } } });
    const draft = draftFromSettings(current);
    draft.phrases.greeting = { en: '', bn: 'কাস্টম' };
    expect(buildVoicePatch(current, draft)).toEqual({ phrases: { greeting: { bn: 'কাস্টম' } } });

    draft.phrases.greeting = { en: '   ', bn: '' };
    expect(buildVoicePatch(current, draft)).toEqual({ phrases: {} });
  });

  it('does not count whitespace as a change', () => {
    const current = settings({ phrases: { holdOn: { en: 'One moment' } } });
    const draft = draftFromSettings(current);
    draft.phrases.holdOn = { en: 'One moment  ', bn: '  ' };
    expect(buildVoicePatch(current, draft)).toEqual({});
  });

  it('combines scalars and phrases in one patch', () => {
    const current = settings();
    const draft = draftFromSettings(current);
    draft.enabled = true;
    draft.voiceBnSpeaker = 7;
    draft.phrases.goodbye.en = 'Bye now';
    expect(buildVoicePatch(current, draft)).toEqual({
      enabled: true,
      voiceBnSpeaker: 7,
      phrases: { goodbye: { en: 'Bye now' } },
    });
  });
});

describe('draftFromSettings', () => {
  it('puts every phrase in the form, override or empty', () => {
    const draft = draftFromSettings(settings({ phrases: { stillThere: { en: 'Hello?' } } }));
    expect(Object.keys(draft.phrases)).toHaveLength(14);
    expect(draft.phrases.stillThere).toEqual({ en: 'Hello?', bn: '' });
    expect(draft.phrases.greeting).toEqual({ en: '', bn: '' });
    expect(overridesFromDraft(draft.phrases)).toEqual({ stillThere: { en: 'Hello?' } });
  });
});

describe('usageSentence', () => {
  it('reads naturally with and without a limit', () => {
    expect(usageSentence({ minutesUsed: 12, minutesLimit: 300 })).toBe(
      '12 of 300 minutes this month',
    );
    expect(usageSentence({ minutesUsed: 12, minutesLimit: null })).toBe(
      '12 minutes this month, no limit',
    );
  });
});
