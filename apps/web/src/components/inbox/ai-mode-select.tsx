'use client';

import { useEffect, useState } from 'react';
import { ApiError, api } from '@/lib/api-client';
import { AI_MODES, type AiMode, type AiSettingsView } from '@/lib/ai';
import { cn, useToast } from '@/components/ui';

/**
 * The answering-mode switch, in the inbox.
 *
 * The same setting as on the website's AI page, reachable from the conversation list because
 * "switch the AI on, I'm stepping out" is a thing people decide from here. One fetch per website;
 * the result is shared across every conversation of that website through the small cache below,
 * so opening ten conversations does not ask ten times.
 */

const cache = new Map<string, { at: number; view: AiSettingsView }>();
const CACHE_MS = 30_000;

export function AiModeSelect({ propertyId, className }: { propertyId: string; className?: string }) {
  const toast = useToast();
  const [view, setView] = useState<AiSettingsView | null>(() => {
    const hit = cache.get(propertyId);
    return hit && Date.now() - hit.at < CACHE_MS ? hit.view : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const hit = cache.get(propertyId);
    if (hit && Date.now() - hit.at < CACHE_MS) {
      setView(hit.view);
      return;
    }
    const controller = new AbortController();
    api
      .get<AiSettingsView>(`/properties/${propertyId}/ai`, { signal: controller.signal })
      .then((result) => {
        cache.set(propertyId, { at: Date.now(), view: result.data });
        setView(result.data);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : 'Could not load the AI mode');
      });
    return () => controller.abort();
  }, [propertyId]);

  async function change(mode: AiMode) {
    if (!view || view.mode === mode) return;
    setBusy(true);
    try {
      const result = await api.patch<AiSettingsView>(`/properties/${propertyId}/ai`, { mode });
      cache.set(propertyId, { at: Date.now(), view: result.data });
      setView(result.data);
      toast.success(
        mode === 'team'
          ? 'Your team answers new messages.'
          : mode === 'ai'
            ? 'The AI assistant answers new messages first.'
            : 'The AI assistant covers while nobody is online.',
      );
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : 'Could not change the mode.');
    } finally {
      setBusy(false);
    }
  }

  if (error) return null;
  const locked = view !== null && !view.plan.includesAi;

  return (
    <>
      <label className="sr-only" htmlFor="conversation-ai-mode">
        Who answers new messages on this website
      </label>
      <select
        id="conversation-ai-mode"
        value={view?.mode ?? 'team'}
        disabled={busy || view === null}
        title={locked ? `The AI agent is not included in the ${view.plan.planName} plan` : 'Who answers new messages on this website'}
        onChange={(event) => void change(event.target.value as AiMode)}
        className={cn(
          'h-8 shrink-0 rounded-[var(--radius-control)] border border-border-strong bg-surface px-2 text-[12px] font-medium disabled:opacity-50',
          view?.mode === 'team' ? 'text-ink-muted' : 'text-success',
          className,
        )}
      >
        {AI_MODES.map((option) => (
          <option key={option.value} value={option.value} disabled={locked && option.value !== 'team'}>
            {option.value === 'team' ? 'Team answers' : option.short}
          </option>
        ))}
      </select>
    </>
  );
}
