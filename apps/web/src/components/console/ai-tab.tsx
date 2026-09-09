'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, api } from '@/lib/api-client';

/**
 * The AI layer, as the operator sees it: is the local model up, where do replies go, and what
 * the fallback costs in calls. The fallback key is entered here and sealed like the Stripe key.
 */

interface SettingsView {
  local: { url: string; chatModel: string; embedModel: string; embedDimensions: number; timeoutMs: number };
  fallback: { provider: 'none' | 'openai' | 'deepseek' | 'anthropic'; model: string | null; apiKeyConfigured: boolean };
  routing: 'local_first' | 'fallback_only';
  defaultModels: Record<'openai' | 'deepseek' | 'anthropic', string>;
}

interface HealthView {
  local:
    | { reachable: true; chatModel: string; chatModelPresent: boolean; embedModel: string; embedModelPresent: boolean; error: null }
    | { reachable: false; error: string };
  breaker: { open: boolean; until: string | null; consecutiveFailures: number; inFlight: number };
}

interface UsageView {
  month: { turns: number; answers: number; chats: number; tickets: number; handoffs: number; failed: number; fellBack: number; local: number; hosted: number };
  accounts: Array<{ accountId: string; accountName: string; turns: number; fellBack: number; failed: number }>;
  recentFailures: Array<{ at: string; accountName: string; error: string | null; provider: string | null }>;
}

const INPUT =
  'h-9 w-full rounded-[var(--radius-control)] border border-ink-inverted/20 bg-ink-inverted/5 px-3 text-sm text-ink-inverted placeholder:text-ink-inverted/30';
const BUTTON =
  'h-9 rounded-[var(--radius-control)] border border-ink-inverted/20 px-3 text-[13px] font-medium disabled:opacity-50';
const PRIMARY =
  'h-9 rounded-[var(--radius-control)] bg-ink-inverted px-3 text-[13px] font-medium text-ink disabled:opacity-50';
const PANEL = 'rounded-[var(--radius-card)] border border-ink-inverted/15 bg-ink-inverted/5 p-4';

function describe(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function AiTab({ onError }: { onError: (message: string | null) => void }) {
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [health, setHealth] = useState<HealthView | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    onError(null);
    try {
      const [s, h, u] = await Promise.all([
        api.get<SettingsView>('/platform/ai/settings'),
        api.get<HealthView>('/platform/ai/health'),
        api.get<UsageView>('/platform/ai/usage'),
      ]);
      setSettings(s.data);
      setHealth(h.data);
      setUsage(u.data);
    } catch (error) {
      onError(describe(error, 'The AI settings could not be loaded.'));
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!settings || !health || !usage) return <p className="text-sm text-ink-inverted/60">Loading…</p>;

  return (
    <div className="space-y-6">
      {notice && (
        <p className="rounded-[var(--radius-control)] border border-success/40 bg-success/10 px-3 py-2 text-[13px] text-success-soft">
          {notice}
        </p>
      )}

      <section className={PANEL}>
        <h2 className="text-sm font-semibold">Local model</h2>
        <p className="mt-1 text-[13px] text-ink-inverted/60">
          Runs in the <code>ai</code> container. Replies go here first; the fallback below is used when it fails, times out, is
          busy, or the breaker is open.
        </p>
        <dl className="mt-4 grid gap-3 text-[13px] sm:grid-cols-2 lg:grid-cols-4">
          <Row label="Address" value={settings.local.url || 'not set'} mono />
          <Row
            label="Reachable"
            value={health.local.reachable ? 'Yes' : `No - ${health.local.error}`}
            tone={health.local.reachable ? 'good' : 'bad'}
          />
          <Row
            label="Chat model"
            value={`${settings.local.chatModel}${health.local.reachable ? (health.local.chatModelPresent ? ' · present' : ' · MISSING') : ''}`}
            tone={health.local.reachable && !health.local.chatModelPresent ? 'bad' : undefined}
            mono
          />
          <Row
            label="Embedding model"
            value={`${settings.local.embedModel} (${settings.local.embedDimensions}d)${health.local.reachable ? (health.local.embedModelPresent ? ' · present' : ' · MISSING') : ''}`}
            tone={health.local.reachable && !health.local.embedModelPresent ? 'bad' : undefined}
            mono
          />
          <Row
            label="Breaker"
            value={
              health.breaker.open
                ? `Open until ${health.breaker.until ? new Date(health.breaker.until).toLocaleTimeString() : '?'} (${health.breaker.consecutiveFailures} failures)`
                : `Closed · ${health.breaker.consecutiveFailures} recent failures`
            }
            tone={health.breaker.open ? 'bad' : 'good'}
          />
          <Row label="In flight (this process)" value={String(health.breaker.inFlight)} />
        </dl>
        <p className="mt-3 text-[12px] text-ink-inverted/50">
          The breaker shown is this API process&apos;s. The worker, which answers visitors, keeps its own; a run of failures
          there shows up under &quot;fell back&quot; below.
        </p>
      </section>

      <FallbackSettings
        settings={settings}
        onSaved={(view, message) => {
          setSettings(view);
          setNotice(message);
          onError(null);
        }}
        onError={onError}
      />

      <section className={PANEL}>
        <h2 className="text-sm font-semibold">This month</h2>
        <dl className="mt-4 grid grid-cols-2 gap-3 text-[13px] sm:grid-cols-4 lg:grid-cols-9">
          <Stat label="Turns" value={usage.month.turns} />
          <Stat label="Answered" value={usage.month.answers} />
          <Stat label="Chatted" value={usage.month.chats} />
          <Stat label="Ticket offers" value={usage.month.tickets} />
          <Stat label="Handoffs" value={usage.month.handoffs} />
          <Stat label="Failed" value={usage.month.failed} tone={usage.month.failed > 0 ? 'bad' : undefined} />
          <Stat label="Local" value={usage.month.local} />
          <Stat label="Hosted" value={usage.month.hosted} />
          <Stat label="Fell back" value={usage.month.fellBack} tone={usage.month.fellBack > 0 ? 'warn' : undefined} />
        </dl>

        {usage.accounts.length > 0 && (
          <table className="mt-5 w-full text-[13px]">
            <thead className="text-left text-ink-inverted/50">
              <tr>
                <th className="pb-1 font-medium">Account</th>
                <th className="pb-1 text-right font-medium">Turns</th>
                <th className="pb-1 text-right font-medium">Fell back</th>
                <th className="pb-1 text-right font-medium">Failed</th>
              </tr>
            </thead>
            <tbody>
              {usage.accounts.map((row) => (
                <tr key={row.accountId} className="border-t border-ink-inverted/10">
                  <td className="py-1.5">{row.accountName}</td>
                  <td className="py-1.5 text-right tabular-nums">{row.turns}</td>
                  <td className="py-1.5 text-right tabular-nums">{row.fellBack}</td>
                  <td className="py-1.5 text-right tabular-nums">{row.failed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {usage.recentFailures.length > 0 && (
          <div className="mt-5">
            <h3 className="text-[13px] font-semibold text-ink-inverted/80">Recent failures</h3>
            <ul className="mt-2 space-y-1 text-[12.5px] text-ink-inverted/70">
              {usage.recentFailures.map((failure, i) => (
                <li key={`${failure.at}-${i}`} className="font-mono">
                  {new Date(failure.at).toLocaleString()} · {failure.accountName} · {failure.provider ?? '-'} ·{' '}
                  {failure.error ?? 'no detail'}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}

function FallbackSettings({
  settings,
  onSaved,
  onError,
}: {
  settings: SettingsView;
  onSaved: (view: SettingsView, message: string) => void;
  onError: (message: string | null) => void;
}) {
  const [provider, setProvider] = useState(settings.fallback.provider);
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(settings.fallback.model ?? '');
  const [timeout, setTimeoutMs] = useState(String(settings.local.timeoutMs));
  const [routing, setRouting] = useState(settings.routing);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        fallbackProvider: provider,
        fallbackModel: model.trim() || null,
        localTimeoutMs: Number(timeout),
        routing,
      };
      if (apiKey.trim()) body['fallbackApiKey'] = apiKey.trim();
      const result = await api.patch<SettingsView>('/platform/ai/settings', body);
      setApiKey('');
      onSaved(result.data, 'AI settings saved. The worker picks them up within thirty seconds.');
    } catch (error) {
      onError(describe(error, 'Could not save the settings.'));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.post<{ provider: string; model: string }>('/platform/ai/settings/test');
      setTestResult(`Connected: ${result.data.provider} answered with ${result.data.model}.`);
    } catch (error) {
      setTestResult(describe(error, 'The test failed.'));
    } finally {
      setTesting(false);
    }
  }

  const placeholderModel = provider === 'none' ? '' : settings.defaultModels[provider];

  return (
    <form onSubmit={save} className={PANEL}>
      <h2 className="text-sm font-semibold">Fallback provider</h2>
      <p className="mt-1 text-[13px] text-ink-inverted/60">
        A hosted model for when the local one cannot answer. The key is encrypted at rest and never shown again. Visitor
        messages and the account&apos;s public content go to this provider when it is used - say so in your privacy policy.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-[13px]">
          <span className="text-ink-inverted/70">Provider</span>
          <select className={`${INPUT} mt-1`} value={provider} onChange={(e) => setProvider(e.target.value as SettingsView['fallback']['provider'])}>
            <option value="none">None - local only</option>
            <option value="openai">OpenAI</option>
            <option value="deepseek">DeepSeek</option>
            <option value="anthropic">Anthropic</option>
          </select>
        </label>
        <label className="block text-[13px]">
          <span className="text-ink-inverted/70">Model</span>
          <input
            className={`${INPUT} mt-1 font-mono`}
            value={model}
            onChange={(e) => setModel(e.target.value)}
            placeholder={placeholderModel || 'gpt-4o-mini'}
            disabled={provider === 'none'}
          />
        </label>
        <label className="block text-[13px] sm:col-span-2">
          <span className="text-ink-inverted/70">
            API key {settings.fallback.apiKeyConfigured ? '· stored' : '· not set'}
          </span>
          <input
            className={`${INPUT} mt-1 font-mono`}
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={settings.fallback.apiKeyConfigured ? 'Leave blank to keep the stored key' : 'sk-…'}
            disabled={provider === 'none'}
          />
        </label>
        <label className="block text-[13px]">
          <span className="text-ink-inverted/70">Local timeout (ms)</span>
          <input
            className={`${INPUT} mt-1`}
            type="number"
            min={5000}
            max={120000}
            step={1000}
            value={timeout}
            onChange={(e) => setTimeoutMs(e.target.value)}
          />
          <span className="mt-1 block text-[12px] text-ink-inverted/50">
            How long one local reply may take before the fallback is asked instead. A 2B model on this CPU answers in
            about five seconds; thirty is generous.
          </span>
        </label>
        <label className="block text-[13px]">
          <span className="text-ink-inverted/70">Routing</span>
          <select className={`${INPUT} mt-1`} value={routing} onChange={(e) => setRouting(e.target.value as SettingsView['routing'])}>
            <option value="local_first">Local first, fallback when needed</option>
            <option value="fallback_only">Fallback only (local model down for maintenance)</option>
          </select>
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button type="submit" className={PRIMARY} disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className={BUTTON}
          disabled={testing || !settings.fallback.apiKeyConfigured || settings.fallback.provider === 'none'}
          onClick={() => void test()}
        >
          {testing ? 'Testing…' : 'Test fallback'}
        </button>
        {testResult && <span className="text-[13px] text-ink-inverted/70">{testResult}</span>}
      </div>
    </form>
  );
}

function Row({ label, value, tone, mono }: { label: string; value: string; tone?: 'good' | 'bad'; mono?: boolean }) {
  return (
    <div>
      <dt className="text-ink-inverted/50">{label}</dt>
      <dd
        className={`mt-0.5 ${mono ? 'font-mono text-[12.5px]' : ''} ${
          tone === 'good' ? 'text-success-soft' : tone === 'bad' ? 'text-danger-soft' : 'text-ink-inverted'
        }`}
      >
        {value}
      </dd>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'bad' | 'warn' }) {
  return (
    <div>
      <dt className="text-ink-inverted/50">{label}</dt>
      <dd className={`mt-0.5 text-lg font-semibold tabular-nums ${tone === 'bad' ? 'text-danger-soft' : tone === 'warn' ? 'text-warning' : ''}`}>
        {value}
      </dd>
    </div>
  );
}
