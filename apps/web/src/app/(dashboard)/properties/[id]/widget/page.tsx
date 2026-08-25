'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import {
  DEFAULT_WIDGET_CONFIG,
  type UpdateWidgetConfigInput,
  type WidgetConfig,
} from '@smartchat/validation';
import { ApiError, api } from '@/lib/api-client';
import { useResource } from '@/lib/use-resource';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, Badge, Button, Card, Field, Select, TextInput, useToast } from '@/components/ui';
import {
  ColorControl,
  ControlGroup,
  PositionControl,
  Row,
  SliderControl,
  ToggleControl,
} from '@/components/widget/controls';
import { WidgetPreview } from '@/components/widget/preview';
import type { PropertyDto } from '@/lib/types';

interface WidgetResponse {
  id: string;
  propertyId: string;
  version: number;
  publishedAt: string | null;
  hasUnpublishedChanges: boolean;
  config: WidgetConfig;
  draft: WidgetConfig;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

export default function WidgetBuilderPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();

  const property = useResource<PropertyDto>(
    (signal) => api.get<PropertyDto>(`/properties/${id}`, { signal }).then((r) => r.data),
    [id],
  );
  const widget = useResource<WidgetResponse>(
    (signal) => api.get<WidgetResponse>(`/properties/${id}/widget`, { signal }).then((r) => r.data),
    [id],
  );

  const [draft, setDraft] = useState<WidgetConfig>(DEFAULT_WIDGET_CONFIG);
  // Version and publish time are held in state rather than read from the initial fetch, so the
  // header reflects a publish immediately instead of showing the version it replaced.
  const [version, setVersion] = useState(1);
  const [publishedAt, setPublishedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [publishing, setPublishing] = useState(false);
  const pendingSave = useRef<number | null>(null);

  useEffect(() => {
    if (!widget.data) return;
    setDraft(widget.data.draft);
    setVersion(widget.data.version);
    setPublishedAt(widget.data.publishedAt);
    setDirty(widget.data.hasUnpublishedChanges);
  }, [widget.data]);

  /**
   * Autosave, debounced.
   *
   * Every edit is a draft: nothing here reaches a visitor until Publish. That is what makes
   * autosaving safe - a customer dragging a colour slider is not changing their live site.
   */
  const save = useCallback(
    (update: UpdateWidgetConfigInput) => {
      if (pendingSave.current) window.clearTimeout(pendingSave.current);
      setSaveState('saving');
      pendingSave.current = window.setTimeout(() => {
        void (async () => {
          try {
            const { data } = await api.patch<WidgetResponse>(`/properties/${id}/widget`, update);
            setDraft(data.draft);
            setDirty(data.hasUnpublishedChanges);
            setSaveState('saved');
          } catch (error) {
            setSaveState('error');
            toast.error(error instanceof ApiError ? error.message : 'Could not save your changes.');
          }
        })();
      }, 600);
    },
    [id, toast],
  );

  useEffect(
    () => () => {
      if (pendingSave.current) window.clearTimeout(pendingSave.current);
    },
    [],
  );

  function update<S extends keyof WidgetConfig>(section: S, patch: Partial<WidgetConfig[S]>) {
    setDraft((current) => {
      const next = { ...current, [section]: { ...current[section], ...patch } };
      save({ [section]: patch } as UpdateWidgetConfigInput);
      return next;
    });
    setDirty(true);
  }

  async function publish() {
    setPublishing(true);
    try {
      const { data } = await api.post<WidgetResponse>(`/properties/${id}/widget/publish`);
      setDraft(data.draft);
      setVersion(data.version);
      setPublishedAt(data.publishedAt);
      setDirty(false);
      // "within a minute" is the config endpoint's cache lifetime, not a guess.
      toast.success(`Published version ${data.version}. Visitors see it within a minute.`);
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not publish.');
    } finally {
      setPublishing(false);
    }
  }

  async function discard() {
    try {
      const { data } = await api.post<WidgetResponse>(`/properties/${id}/widget/discard`);
      setDraft(data.draft);
      setDirty(false);
      toast.success('Unpublished changes discarded.');
    } catch (error) {
      toast.error(error instanceof ApiError ? error.message : 'Could not discard.');
    }
  }

  if (widget.loading || property.loading) {
    return (
      <div className="space-y-4">
        <div className="skeleton h-7 w-64" />
        <div className="skeleton h-96 w-full" />
      </div>
    );
  }

  if (widget.error || !widget.data || !property.data) {
    return (
      <Alert tone="danger" title="Could not open the widget builder">
        {widget.error?.message ?? 'This website does not exist, or you do not have access to it.'}
        <div className="mt-3">
          <Link href="/properties">
            <Button size="sm" variant="secondary">
              Back to websites
            </Button>
          </Link>
        </div>
      </Alert>
    );
  }

  return (
    <>
      <PageHeader
        title="Widget"
        description={`${property.data.name} · version ${version}`}
        action={
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-ink-subtle" aria-live="polite">
              {saveState === 'saving' && 'Saving…'}
              {saveState === 'saved' && 'Draft saved'}
              {saveState === 'error' && 'Not saved'}
            </span>
            {dirty && (
              <Button variant="secondary" size="sm" onClick={() => void discard()}>
                Discard
              </Button>
            )}
            <Button size="sm" loading={publishing} onClick={() => void publish()} disabled={!dirty}>
              {dirty ? 'Publish changes' : 'Published'}
            </Button>
          </div>
        }
      />

      {dirty && (
        <div className="mb-5">
          <Alert tone="info" title="You have unpublished changes">
            Your visitors still see version {version}. Publish when you are happy with the preview.
          </Alert>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
        <Card className="overflow-hidden">
          <ControlGroup title="Appearance">
            <ColorControl
              label="Launcher colour"
              value={draft.appearance.launcherColor}
              onChange={(launcherColor) => update('appearance', { launcherColor })}
            />
            <ColorControl
              label="Launcher icon"
              value={draft.appearance.launcherIconColor}
              onChange={(launcherIconColor) => update('appearance', { launcherIconColor })}
            />
            <ColorControl
              label="Header"
              value={draft.appearance.headerColor}
              onChange={(headerColor) => update('appearance', { headerColor })}
            />
            <ColorControl
              label="Header text"
              value={draft.appearance.headerTextColor}
              onChange={(headerTextColor) => update('appearance', { headerTextColor })}
            />
            <ColorControl
              label="Your messages"
              value={draft.appearance.primaryColor}
              onChange={(primaryColor) => update('appearance', { primaryColor })}
            />
            <SliderControl
              label="Corner radius"
              min={0}
              max={32}
              value={draft.appearance.borderRadius}
              onChange={(borderRadius) => update('appearance', { borderRadius })}
            />
            <SliderControl
              label="Launcher size"
              min={44}
              max={80}
              value={draft.appearance.launcherSize}
              onChange={(launcherSize) => update('appearance', { launcherSize })}
            />
            <Row label="Theme">
              <Select
                value={draft.appearance.theme}
                onChange={(event) =>
                  update('appearance', {
                    theme: event.target.value as WidgetConfig['appearance']['theme'],
                  })
                }
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
                <option value="auto">Match the visitor&apos;s system</option>
              </Select>
            </Row>
          </ControlGroup>

          <ControlGroup title="Placement">
            <PositionControl
              value={draft.placement.position}
              onChange={(position) => update('placement', { position })}
            />
            <SliderControl
              label="Horizontal offset"
              min={0}
              max={120}
              value={draft.placement.offsetX}
              onChange={(offsetX) => update('placement', { offsetX })}
            />
            <SliderControl
              label="Vertical offset"
              min={0}
              max={120}
              value={draft.placement.offsetY}
              onChange={(offsetY) => update('placement', { offsetY })}
            />
            <ToggleControl
              label="Show on desktop"
              checked={draft.placement.showOnDesktop}
              onChange={(showOnDesktop) => update('placement', { showOnDesktop })}
            />
            <ToggleControl
              label="Show on mobile"
              checked={draft.placement.showOnMobile}
              onChange={(showOnMobile) => update('placement', { showOnMobile })}
            />
          </ControlGroup>

          <ControlGroup title="Behaviour">
            <ToggleControl
              label="Open automatically"
              description="The panel is open when the page loads."
              checked={draft.behaviour.startOpen}
              onChange={(startOpen) => update('behaviour', { startOpen })}
            />
            <SliderControl
              label="Delay before showing"
              min={0}
              max={60}
              suffix="s"
              value={draft.behaviour.showDelaySeconds}
              onChange={(showDelaySeconds) => update('behaviour', { showDelaySeconds })}
            />
            <ToggleControl
              label="Ask for details first"
              description="Collect a name and email before the first message."
              checked={draft.behaviour.preChatEnabled}
              onChange={(preChatEnabled) => update('behaviour', { preChatEnabled })}
            />
            <ToggleControl
              label="Unread badge"
              checked={draft.behaviour.showUnreadBadge}
              onChange={(showUnreadBadge) => update('behaviour', { showUnreadBadge })}
            />
            <ToggleControl
              label="Notification sound"
              checked={draft.behaviour.soundEnabled}
              onChange={(soundEnabled) => update('behaviour', { soundEnabled })}
            />
          </ControlGroup>

          <ControlGroup title="Content">
            <Field label="Business name">
              {({ id: fieldId }) => (
                <TextInput
                  id={fieldId}
                  value={draft.content.businessName}
                  maxLength={60}
                  onChange={(event) => update('content', { businessName: event.target.value })}
                />
              )}
            </Field>
            <Field label="Welcome message">
              {({ id: fieldId }) => (
                <textarea
                  id={fieldId}
                  value={draft.content.welcomeMessage}
                  maxLength={500}
                  rows={3}
                  onChange={(event) => update('content', { welcomeMessage: event.target.value })}
                  className="w-full rounded-[var(--radius-control)] border border-border-strong bg-surface px-3 py-2 text-sm text-ink"
                />
              )}
            </Field>
            <Field label="Subtitle when online">
              {({ id: fieldId }) => (
                <TextInput
                  id={fieldId}
                  value={draft.content.subtitleOnline}
                  maxLength={80}
                  onChange={(event) => update('content', { subtitleOnline: event.target.value })}
                />
              )}
            </Field>
            <Field label="Subtitle when offline">
              {({ id: fieldId }) => (
                <TextInput
                  id={fieldId}
                  value={draft.content.subtitleOffline}
                  maxLength={80}
                  onChange={(event) => update('content', { subtitleOffline: event.target.value })}
                />
              )}
            </Field>
            <Field label="Message box placeholder">
              {({ id: fieldId }) => (
                <TextInput
                  id={fieldId}
                  value={draft.content.inputPlaceholder}
                  maxLength={60}
                  onChange={(event) => update('content', { inputPlaceholder: event.target.value })}
                />
              )}
            </Field>
          </ControlGroup>
        </Card>

        <div>
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[13px] text-ink-muted">Live preview</span>
            {publishedAt && (
              <Badge tone="neutral">Published {new Date(publishedAt).toLocaleDateString()}</Badge>
            )}
          </div>
          <WidgetPreview publicId={property.data.publicId} config={draft} />
        </div>
      </div>
    </>
  );
}
