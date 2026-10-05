'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { VOICE_PHRASE_KEYS, type VoiceLanguage, type VoicePhraseKey } from '@smartchat/types';
import { ApiError } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, Badge, Button, Card, CardBody, CardFooter, CardHeader, Field, Select, TextInput, cn, useToast } from '@/components/ui';
import type { PropertyDto } from '@/lib/types';
import { api } from '@/lib/api-client';
import {
  AI_MAX_SECONDS,
  BENGALI_VOICES,
  BN_SPEAKERS,
  ENGLISH_VOICES,
  PHRASE_LABELS,
  PHRASE_PLACEHOLDERS,
  RING_SECONDS,
  VOICE_LANGUAGE_LABEL,
  buildVoicePatch,
  draftFromSettings,
  isDirty,
  usageSentence,
  voiceApi,
  type VoiceDraft,
  type VoiceSettingsView,
} from '@/lib/voice';

/**
 * Voice calls, per website.
 *
 * The switch first, with the honest reason when it cannot be turned on; then how the team is
 * rung and whether the AI picks up; then the voices and the fixed things the AI says, each with
 * its default shown as the placeholder so an owner can see what they are replacing. One Save
 * sends only what changed - the same pattern as the AI page.
 */

type Draft = VoiceDraft;

const LANGUAGES: readonly VoiceLanguage[] = ['en', 'bn'];

const TEXTAREA =
  'w-full resize-y rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-subtle disabled:bg-surface-raised';

export default function VoiceSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();

  const property = useResource<PropertyDto>(
    (signal) => api.get<PropertyDto>(`/properties/${id}`, { signal }).then((r) => r.data),
    [id],
  );
  const settings = useResource<VoiceSettingsView>((signal) => voiceApi.get(id, signal), [id]);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (settings.data) setDraft(draftFromSettings(settings.data));
  }, [settings.data]);

  async function save() {
    if (!draft || !settings.data) return;
    const patch = buildVoicePatch(settings.data, draft);
    if (Object.keys(patch).length === 0) {
      toast.success('Nothing to save.');
      return;
    }
    setSaving(true);
    setErrors({});
    try {
      await voiceApi.update(id, patch);
      toast.success(patch.enabled === true ? 'Saved. Visitors on this website can call you now.' : 'Saved.');
      settings.reload();
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(error.fieldErrors());
        toast.error(error.message);
      } else {
        toast.error('Could not save.');
      }
    } finally {
      setSaving(false);
    }
  }

  if (property.error || settings.error) {
    return (
      <Alert tone="danger" title="Could not load the call settings">
        {(property.error ?? settings.error)?.message}
      </Alert>
    );
  }
  if (!property.data || !settings.data || !draft) {
    return <p className="text-sm text-ink-muted">Loading…</p>;
  }

  const view = settings.data;
  const dirty = isDirty(view, draft);
  const canEnable = view.available && view.planIncludesVoice;
  const bengali = BENGALI_VOICES.find((voice) => voice.id === draft.voiceBn);

  const update = (patch: Partial<Draft>) => setDraft((current) => (current ? { ...current, ...patch } : current));
  const setPhrase = (key: VoicePhraseKey, language: VoiceLanguage, value: string) =>
    setDraft((current) =>
      current
        ? { ...current, phrases: { ...current.phrases, [key]: { ...current.phrases[key], [language]: value } } }
        : current,
    );

  return (
    <>
      <PageHeader
        title="Voice calls"
        description={`${property.data.name} · a Call button in the chat window. Your team rings in the dashboard; the AI can answer when nobody does.`}
        action={
          view.enabled && canEnable ? (
            <Badge tone="success" dot>
              Calls on
            </Badge>
          ) : (
            <Badge tone="neutral">Calls off</Badge>
          )
        }
      />

      <div className="space-y-6">
        {!view.available ? (
          <Alert tone="info" title="Calling is not enabled on this installation">
            The media server and the speech service are not configured. Everything below can be prepared;
            the switch works once calling is set up.
          </Alert>
        ) : !view.planIncludesVoice ? (
          <Alert tone="info" title="Voice calls are not included in your plan">
            Set everything up now; switching calls on needs a plan that includes them.{' '}
            <Link href="/app/billing" className="font-medium underline">
              See plans
            </Link>
          </Alert>
        ) : null}

        <Card>
          <CardHeader title="Calls" description="Whether visitors see a Call button, and how long your team rings before the AI or the missed-call message." />
          <CardBody className="space-y-5">
            <Switch
              label="Visitors can call"
              hint={
                canEnable
                  ? 'Everyone on the team who is online rings at once; the first to answer takes the call.'
                  : view.available
                    ? 'Needs a plan that includes voice calls.'
                    : 'Needs calling to be enabled on this installation.'
              }
              checked={draft.enabled && canEnable}
              disabled={!canEnable}
              onChange={(enabled) => update({ enabled })}
            />
            <div className="grid gap-5 md:grid-cols-2">
              <NumberField
                label="Ring the team for"
                hint={`Seconds, ${RING_SECONDS.min} to ${RING_SECONDS.max}. Then the AI answers if it may, or the call is missed.`}
                error={errors['ringSeconds']}
                min={RING_SECONDS.min}
                max={RING_SECONDS.max}
                value={draft.ringSeconds}
                onChange={(ringSeconds) => update({ ringSeconds })}
              />
              <Field label="Language to greet in" hint="When the chat window has not said which language the visitor is using." error={errors['defaultLanguage']}>
                {({ id: fieldId }) => (
                  <Select id={fieldId} value={draft.defaultLanguage} onChange={(event) => update({ defaultLanguage: event.target.value === 'bn' ? 'bn' : 'en' })} className="max-w-[14rem]">
                    {LANGUAGES.map((language) => (
                      <option key={language} value={language}>
                        {VOICE_LANGUAGE_LABEL[language]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
            <p className="text-[13px] text-ink-muted">
              <span className="font-medium text-ink">{usageSentence(view.usage)}</span>
              {view.usage.minutesLimit !== null && ' across every website on the account. Minutes count from the moment a call is answered.'}
            </p>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="The AI on the phone"
            description="When nobody answers, the assistant can take the call: it listens, answers from what it knows, and offers a ticket or a person when it cannot help."
          />
          <CardBody className="space-y-5">
            <Switch
              label="The AI answers when nobody does"
              hint={
                <>
                  Needs the AI agent set up for this website - a name and something to answer from - and a plan that includes it.{' '}
                  <Link href={`/app/properties/${id}/ai`} className="font-medium underline">
                    AI agent settings
                  </Link>
                </>
              }
              checked={draft.aiAnswers}
              onChange={(aiAnswers) => update({ aiAnswers })}
            />
            <NumberField
              label="Longest AI call"
              hint={`Seconds, ${AI_MAX_SECONDS.min} to ${AI_MAX_SECONDS.max}. The assistant says goodbye when a call reaches this; a person's call has no limit.`}
              error={errors['aiMaxSeconds']}
              min={AI_MAX_SECONDS.min}
              max={AI_MAX_SECONDS.max}
              step={30}
              value={draft.aiMaxSeconds}
              onChange={(aiMaxSeconds) => update({ aiMaxSeconds })}
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Voices" description="How the assistant sounds in each language. It answers in the language it hears." />
          <CardBody>
            <div className="grid gap-5 md:grid-cols-2">
              <Field label="English voice" error={errors['voiceEn']}>
                {({ id: fieldId }) => (
                  <Select id={fieldId} value={draft.voiceEn} onChange={(event) => update({ voiceEn: event.target.value })}>
                    {ENGLISH_VOICES.map((voice) => (
                      <option key={voice.id} value={voice.id}>
                        {voice.label}
                      </option>
                    ))}
                    {!ENGLISH_VOICES.some((voice) => voice.id === draft.voiceEn) && <option value={draft.voiceEn}>{draft.voiceEn}</option>}
                  </Select>
                )}
              </Field>
              <div className="space-y-3">
                <Field label="Bengali voice" error={errors['voiceBn']}>
                  {({ id: fieldId }) => (
                    <Select id={fieldId} value={draft.voiceBn} onChange={(event) => update({ voiceBn: event.target.value })}>
                      {BENGALI_VOICES.map((voice) => (
                        <option key={voice.id} value={voice.id}>
                          {voice.label}
                        </option>
                      ))}
                      {!bengali && <option value={draft.voiceBn}>{draft.voiceBn}</option>}
                    </Select>
                  )}
                </Field>
                {bengali?.speakers && (
                  <NumberField
                    label="Speaker"
                    hint={`The Bangladeshi model has ${BN_SPEAKERS.max + 1} speakers, numbered ${BN_SPEAKERS.min} to ${BN_SPEAKERS.max}.`}
                    error={errors['voiceBnSpeaker']}
                    min={BN_SPEAKERS.min}
                    max={BN_SPEAKERS.max}
                    value={draft.voiceBnSpeaker}
                    onChange={(voiceBnSpeaker) => update({ voiceBnSpeaker })}
                    narrow
                  />
                )}
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="What the assistant says"
            description={
              <>
                The fixed sentences, in both languages. Leave a box empty to use the default shown in it. The assistant fills in{' '}
                {PHRASE_PLACEHOLDERS.map((placeholder, index) => (
                  <span key={placeholder}>
                    {index > 0 && ', '}
                    <code className="rounded bg-surface-raised px-1 font-mono text-[12px]">{placeholder}</code>
                  </span>
                ))}
                .
              </>
            }
          />
          <CardBody className="space-y-6">
            {VOICE_PHRASE_KEYS.map((key) => (
              <div key={key} className="grid gap-3 md:grid-cols-[minmax(0,180px)_1fr_1fr]">
                <div>
                  <p className="text-sm font-medium text-ink">{PHRASE_LABELS[key].label}</p>
                  <p className="text-[12.5px] text-ink-subtle">{PHRASE_LABELS[key].hint}</p>
                </div>
                {LANGUAGES.map((language) => {
                  const value = draft.phrases[key][language];
                  // The default sits in the empty box, so the owner sees what they are replacing.
                  const fallback = view.defaultPhrases[key][language];
                  const fieldKey = `phrases.${key}.${language}`;
                  return (
                    <div key={language} className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label htmlFor={fieldKey} className="text-[12px] font-medium uppercase tracking-wide text-ink-subtle">
                          {VOICE_LANGUAGE_LABEL[language]}
                        </label>
                        {value !== '' && (
                          <button
                            type="button"
                            onClick={() => setPhrase(key, language, '')}
                            title={`Back to the default: ${fallback}`}
                            className="text-[12px] font-medium text-brand hover:underline"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                      <textarea
                        id={fieldKey}
                        rows={2}
                        value={value}
                        maxLength={400}
                        lang={language}
                        placeholder={fallback}
                        onChange={(event) => setPhrase(key, language, event.target.value)}
                        aria-invalid={errors[fieldKey] ? true : undefined}
                        className={cn(TEXTAREA, errors[fieldKey] && 'border-danger')}
                      />
                      {errors[fieldKey] && (
                        <p className="text-[12.5px] text-danger" role="alert">
                          {errors[fieldKey]}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
          </CardBody>
          <CardFooter>
            {dirty && <span className="mr-auto text-[13px] text-ink-subtle">Unsaved changes</span>}
            <Button loading={saving} disabled={!dirty} onClick={() => void save()}>
              Save
            </Button>
          </CardFooter>
        </Card>
      </div>
    </>
  );
}

/** A labelled switch with the reason it is off, when it is off. */
function Switch({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={cn('flex items-start gap-3 text-sm text-ink', disabled && 'cursor-not-allowed opacity-70')}>
      <input
        type="checkbox"
        role="switch"
        aria-checked={checked}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-0.5 size-4 rounded border-border-strong accent-[var(--color-brand)]"
      />
      <span>
        <span className="font-medium">{label}</span>
        {hint && <span className="block text-[13px] text-ink-subtle">{hint}</span>}
      </span>
    </label>
  );
}

/**
 * A whole number within a range.
 *
 * The box holds what is typed and the draft gets the value only once it is in range, with the
 * rest clamped on blur. Clamping on every keystroke would turn "30" into "50" on a field whose
 * minimum is 5, because the "3" alone is below it.
 */
function NumberField({
  label,
  hint,
  error,
  min,
  max,
  step,
  value,
  onChange,
  narrow,
}: {
  label: string;
  hint?: string;
  error?: string | undefined;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (value: number) => void;
  narrow?: boolean;
}) {
  const [text, setText] = useState(String(value));
  // A reload puts the saved value back in the box; typing is never interrupted by it.
  useEffect(() => setText(String(value)), [value]);

  const commit = (raw: string) => {
    const parsed = Math.floor(Number(raw));
    if (!Number.isFinite(parsed) || raw.trim() === '') {
      setText(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <Field label={label} hint={hint} error={error}>
      {({ id: fieldId, invalid }) => (
        <TextInput
          id={fieldId}
          type="number"
          min={min}
          max={max}
          step={step}
          invalid={invalid}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            const parsed = Math.floor(Number(event.target.value));
            if (Number.isFinite(parsed) && parsed >= min && parsed <= max && parsed !== value) onChange(parsed);
          }}
          onBlur={(event) => commit(event.target.value)}
          className={narrow ? 'max-w-[8rem]' : 'max-w-[10rem]'}
        />
      )}
    </Field>
  );
}
