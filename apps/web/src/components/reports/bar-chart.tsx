'use client';

import { useId, useState } from 'react';
import { cn } from '@/components/ui';

export interface Bar {
  label: string;
  values: number[];
}

/**
 * A daily bar chart, drawn by hand.
 *
 * No charting library: this is two rectangles per day and an axis, and a dependency that ships a
 * layout engine, an animation system and its own event handling to draw them is a lot of surface
 * for a picture we can describe in fifty lines. It also means the chart is a real `<svg>` in the
 * page - readable, printable, and inspectable - rather than a canvas nobody can select text from.
 *
 * Every day in the range is a bar, including the empty ones. A chart that omits quiet days draws a
 * straight line through a weekend and makes it look like a busy one.
 */
export function BarChart({
  bars,
  seriesNames,
  colours,
  height = 180,
}: {
  bars: Bar[];
  seriesNames: string[];
  colours: string[];
  height?: number;
}) {
  const titleId = useId();
  const [hovered, setHovered] = useState<number | null>(null);

  const max = Math.max(1, ...bars.flatMap((bar) => bar.values));
  const width = Math.max(bars.length * 28, 280);
  const groupWidth = width / Math.max(bars.length, 1);
  const barWidth = Math.max(3, (groupWidth - 6) / seriesNames.length);

  const active = hovered === null ? null : bars[hovered];

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-4">
        {seriesNames.map((name, index) => (
          <span key={name} className="flex items-center gap-1.5 text-[13px] text-ink-muted">
            <span
              className="size-2.5 rounded-[3px]"
              style={{ background: colours[index] }}
              aria-hidden="true"
            />
            {name}
          </span>
        ))}
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-labelledby={titleId}
          preserveAspectRatio="none"
          className="block"
        >
          <title id={titleId}>
            {seriesNames.join(' and ')} per day, peaking at {max}
          </title>

          {/* A baseline, so bars of zero still sit on something. */}
          <line
            x1="0"
            y1={height - 18}
            x2={width}
            y2={height - 18}
            stroke="currentColor"
            strokeWidth="1"
            className="text-border"
          />

          {bars.map((bar, index) => (
            <g
              key={bar.label}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered((current) => (current === index ? null : current))}
            >
              {/* A full-height target, so hovering a zero-height bar still works. */}
              <rect
                x={index * groupWidth}
                y={0}
                width={groupWidth}
                height={height - 18}
                fill="transparent"
              />
              {bar.values.map((value, series) => {
                const barHeight = Math.round(((height - 30) * value) / max);
                return (
                  <rect
                    key={series}
                    x={index * groupWidth + 3 + series * barWidth}
                    y={height - 18 - barHeight}
                    width={barWidth - 1}
                    height={barHeight}
                    rx="1.5"
                    fill={colours[series]}
                    opacity={hovered === null || hovered === index ? 1 : 0.35}
                  />
                );
              })}
            </g>
          ))}
        </svg>
      </div>

      <p
        className={cn('mt-2 h-5 text-[13px]', active ? 'text-ink-muted' : 'text-ink-subtle')}
        aria-live="polite"
      >
        {active
          ? `${active.label}: ${active.values
              .map((value, index) => `${value} ${seriesNames[index]}`)
              .join(', ')}`
          : `${bars.length} days · highest ${max}`}
      </p>
    </div>
  );
}
