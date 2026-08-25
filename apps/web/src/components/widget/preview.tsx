'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WidgetConfig } from '@smartchat/validation';
import { runtimeConfig } from '@/lib/runtime-config';

/**
 * A live preview that is the real widget.
 *
 * Rather than reimplementing the panel's markup in the dashboard - which would drift from the real
 * thing within a release or two - this embeds the actual panel in preview mode and pushes the
 * unpublished configuration to it over the same postMessage bridge the loader uses. What the
 * customer sees here is, by construction, what their visitors will see.
 */
export function WidgetPreview({ publicId, config }: { publicId: string; config: WidgetConfig }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);

  const widgetOrigin = useMemo(() => {
    try {
      return new URL(runtimeConfig().widgetUrl).origin;
    } catch {
      return '';
    }
  }, []);

  // A fresh nonce per mount, matching what the loader does. The panel ignores any message that
  // does not carry it.
  const nonce = useMemo(
    () =>
      Array.from(crypto.getRandomValues(new Uint8Array(16)))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join(''),
    [],
  );

  const src = `${widgetOrigin}/panel/?p=${encodeURIComponent(publicId)}&n=${nonce}&preview=1`;

  const push = useCallback(() => {
    if (!widgetOrigin) return;
    frame.current?.contentWindow?.postMessage(
      { type: 'sc:host:preview-config', nonce, config },
      widgetOrigin,
    );
  }, [config, nonce, widgetOrigin]);

  useEffect(() => {
    if (!widgetOrigin) return undefined;

    function onMessage(event: MessageEvent) {
      if (event.origin !== widgetOrigin) return;
      const data = event.data as { type?: string; nonce?: string } | null;
      if (!data || data.nonce !== nonce) return;
      if (data.type !== 'sc:panel:ready') return;

      setReady(true);
      // The panel expects an init before it will act on anything else.
      frame.current?.contentWindow?.postMessage(
        {
          type: 'sc:host:init',
          nonce,
          publicId,
          page: { url: 'https://example.com/', title: 'Preview', referrer: '' },
          locale: 'en',
        },
        widgetOrigin,
      );
      push();
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [nonce, publicId, push, widgetOrigin]);

  // Push on every configuration change, once the panel is listening.
  useEffect(() => {
    if (ready) push();
  }, [ready, push]);

  const { appearance, placement } = config;
  const alignRight = placement.position.endsWith('right');
  const alignTop = placement.position.startsWith('top');

  return (
    <div className="lg:sticky lg:top-20">
      <div
        className="relative overflow-hidden rounded-[var(--radius-card)] border border-border bg-[oklch(96%_0.004_250)]"
        style={{ height: 620 }}
        aria-label="Widget preview"
      >
        {/* A suggestion of a customer's page, so the widget is judged in context rather than
            floating on a blank canvas. */}
        <div className="pointer-events-none absolute inset-0 p-6" aria-hidden="true">
          <div className="mb-6 h-8 w-40 rounded bg-[oklch(90%_0.006_250)]" />
          <div className="mb-3 h-5 w-3/4 rounded bg-[oklch(92%_0.005_250)]" />
          <div className="mb-3 h-5 w-2/3 rounded bg-[oklch(92%_0.005_250)]" />
          <div className="mb-8 h-5 w-1/2 rounded bg-[oklch(92%_0.005_250)]" />
          <div className="h-32 w-full rounded-lg bg-[oklch(93%_0.005_250)]" />
        </div>

        <div
          className="absolute flex gap-3"
          style={{
            [alignRight ? 'right' : 'left']: placement.offsetX,
            [alignTop ? 'top' : 'bottom']: placement.offsetY,
            alignItems: alignRight ? 'flex-end' : 'flex-start',
            flexDirection: alignTop ? 'column' : 'column-reverse',
          }}
        >
          <button
            type="button"
            className="flex shrink-0 items-center justify-center shadow-lg"
            style={{
              width: appearance.launcherSize,
              height: appearance.launcherSize,
              borderRadius: `${Math.min(50, Math.max(8, appearance.borderRadius * 2))}%`,
              background: appearance.launcherColor,
              color: appearance.launcherIconColor,
            }}
            aria-label="Launcher preview"
            tabIndex={-1}
          >
            <svg viewBox="0 0 24 24" width={appearance.launcherSize * 0.45} aria-hidden="true">
              <path
                d="M12 3c5 0 9 3.4 9 7.6 0 4.2-4 7.6-9 7.6-.9 0-1.8-.1-2.6-.3L4 21l1.2-3.6C3.2 16 2 13.4 2 10.6 2 6.4 6 3 12 3Z"
                fill="currentColor"
              />
            </svg>
          </button>

          {widgetOrigin ? (
            <iframe
              ref={frame}
              src={src}
              title="Chat panel preview"
              className="border-0 bg-surface shadow-2xl"
              style={{ width: 372, height: 470, borderRadius: appearance.borderRadius }}
            />
          ) : (
            <div className="rounded-lg border border-border bg-surface p-4 text-[13px] text-ink-muted">
              The widget host is not configured, so the preview cannot load.
            </div>
          )}
        </div>
      </div>

      <p className="mt-2 text-center text-[12px] text-ink-subtle">
        This is the real widget, rendering your unpublished changes.
      </p>
    </div>
  );
}
