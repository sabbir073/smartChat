'use client';

import { useEffect, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ApiError, api } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardHeader,
  Field,
  PasswordInput,
  Select,
  TextInput,
  useToast,
} from '@/components/ui';

type Provider = 'openai' | 'deepseek' | 'anthropic';

interface View {
  allowed: boolean;
  planName: string;
  configured: boolean;
  provider: Provider | null;
  model: string | null;
  routing: 'local_first' | 'own_only';
  keyHint: string | null;
  lastTestedAt: string | null;
  lastTestError: string | null;
  defaultModels: Record<Provider, string>;
}

const PROVIDERS: Array<{ value: Provider; label: string; placeholder: string }> = [
  { value: 'openai', label: 'OpenAI', placeholder: 'sk-…' },
  { value: 'deepseek', label: 'DeepSeek', placeholder: 'sk-…' },
  { value: 'anthropic', label: 'Anthropic', placeholder: 'sk-ant-…' },
];

/**
 * Bring your own key.
 *
 * With a key here the account's AI replies go to its own provider instead of the platform's
 * fallback - their key, their bill. The local model still answers first unless they say
 * otherwise. The key is checked against the provider before it is kept, and never shown again
 * beyond its last four characters.
 */
export function OwnAiKeyCard({ canManage }: { canManage: boolean }) {
  const toast = useToast();
  const view = useResource<View>((signal) => api.get<View>('/account/ai', { signal }).then((r) => r.data), []);
  const [provider, setProvider] = useState<Provider>('openai');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [routing, setRouting] = useState<'local_first' | 'own_only'>('local_first');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!view.data) return;
    setProvider(view.data.provider ?? 'openai');
    setModel(view.data.model ?? '');
    setRouting(view.data.routing);
    setApiKey('');
  }, [view.data]);

  const data = view.data;
  if (view.error || !data) return null;

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      const body: Record<string, unknown> = { provider, routing, model: model.trim() || null };
      if (apiKey.trim()) body['apiKey'] = apiKey.trim();
      await api.put('/account/ai', body);
      toast.success('Your key works and is saved.');
      view.reload();
    } catch (error) {
      if (error instanceof ApiError) {
        setErrors(error.fieldErrors());
        toast.error(error.message);
      } else {
        toast.error('Could not save the key.');
      }
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    try {
      const result = await api.post<{ ok: boolean; model?: string; error?: string }>('/account/ai/test');
      if (result.data.ok) toast.success(`The key works (${result.data.model}).`);
      else toast.error(result.data.error ?? 'The provider refused the key.');
      view.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not test the key.');
    } finally {
      setTesting(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      await api.delete('/account/ai');
      toast.success('Key removed. Replies use the platform providers again.');
      view.reload();
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not remove the key.');
    } finally {
      setRemoving(false);
    }
  }

  const placeholder = PROVIDERS.find((p) => p.value === provider);
  const editable = canManage && data.allowed;

  return (
    <Card>
      <CardHeader
        title="Your own AI provider"
        description="Use your own OpenAI, DeepSeek or Anthropic key for the AI assistant. Your key, your bill; the local model still answers first unless you choose otherwise."
      />
      <form onSubmit={save}>
        <CardBody className="space-y-4">
          {!data.allowed && (
            <Alert tone="info" title={`Not included in the ${data.planName} plan`}>
              Bringing your own key is part of the Custom plan.{' '}
              <Link href="/app/billing" className="font-medium underline">
                Talk to us
              </Link>
            </Alert>
          )}
          {data.configured && (
            <p className="text-sm text-ink-muted">
              Using{' '}
              <span className="font-medium text-ink">{PROVIDERS.find((p) => p.value === data.provider)?.label}</span> · key
              ending in <span className="font-mono">{data.keyHint ?? '????'}</span>
              {data.lastTestedAt && ` · tested ${new Date(data.lastTestedAt).toLocaleString()}`}
              {data.lastTestError && <span className="text-danger"> · last test failed: {data.lastTestError}</span>}
            </p>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Provider">
              {({ id }) => (
                <Select id={id} value={provider} disabled={!editable} onChange={(e) => setProvider(e.target.value as Provider)}>
                  {PROVIDERS.map((p) => (
                    <option key={p.value} value={p.value}>
                      {p.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Model" hint={`Leave empty for ${data.defaultModels[provider]}.`} error={errors['model']}>
              {({ id, invalid }) => (
                <TextInput
                  id={id}
                  invalid={invalid}
                  value={model}
                  disabled={!editable}
                  placeholder={data.defaultModels[provider]}
                  onChange={(e) => setModel(e.target.value)}
                  className="font-mono"
                />
              )}
            </Field>
          </div>
          <Field
            label={data.configured ? 'New API key (leave empty to keep the stored one)' : 'API key'}
            hint="Checked against the provider before it is saved. Stored encrypted; shown only by its last four characters."
            error={errors['apiKey']}
          >
            {({ id, invalid }) => (
              <PasswordInput
                id={id}
                invalid={invalid}
                value={apiKey}
                disabled={!editable}
                placeholder={placeholder?.placeholder}
                autoComplete="off"
                onChange={(e) => setApiKey(e.target.value)}
              />
            )}
          </Field>
          <Field label="When to use it">
            {({ id }) => (
              <Select
                id={id}
                value={routing}
                disabled={!editable}
                onChange={(e) => setRouting(e.target.value as 'local_first' | 'own_only')}
              >
                <option value="local_first">Local model first; my provider when it cannot answer</option>
                <option value="own_only">My provider answers everything</option>
              </Select>
            )}
          </Field>
        </CardBody>
        {editable && (
          <CardFooter>
            {data.configured && (
              <>
                <Button type="button" size="sm" variant="secondary" loading={testing} onClick={() => void test()}>
                  Test
                </Button>
                <Button type="button" size="sm" variant="ghost" loading={removing} onClick={() => void remove()}>
                  Remove key
                </Button>
              </>
            )}
            <Button type="submit" size="sm" loading={saving} className="ml-auto">
              {data.configured ? 'Save changes' : 'Save and test key'}
            </Button>
          </CardFooter>
        )}
      </form>
    </Card>
  );
}
