"use client";

import { useEffect, useMemo, useState } from "react";
import type { EvidenceEvent } from "@/lib/evidence";

const CIGARETTE_COLOR = "#ef4444";
const VAPE_COLOR = "#a855f7";
const LITTER_COLOR = "#f97316";
const INFO_COLOR = "#8a8a8a";

/** How much of the recent past the timeline shows (ms). */
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
/** Tick labels along the axis. */
const AXIS_STEPS = 5;

function colorFor(ev: EvidenceEvent): string {
  if (ev.info) return INFO_COLOR;
  if (ev.label === "Litter") return LITTER_COLOR;
  if (ev.label === "Vape") return VAPE_COLOR;
  return CIGARETTE_COLOR;
}

function formatClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export default function EventTimeline({
  events,
  onSelectEvent,
}: {
  events: EvidenceEvent[];
  onSelectEvent?: (ev: EvidenceEvent) => void;
}) {
  // Re-render every few seconds so the window scrolls with wall-clock time.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 3000);
    return () => window.clearInterval(id);
  }, []);

  const start = now - WINDOW_MS;

  const markers = useMemo(
    () =>
      events
        .filter((ev) => ev.time >= start)
        .map((ev) => ({
          ev,
          left: Math.min(100, Math.max(0, ((ev.time - start) / WINDOW_MS) * 100)),
          color: colorFor(ev),
        })),
    [events, start],
  );

  const axisLabels = useMemo(
    () =>
      Array.from({ length: AXIS_STEPS + 1 }, (_, i) => {
        const t = start + (WINDOW_MS * i) / AXIS_STEPS;
        return { left: (i / AXIS_STEPS) * 100, label: formatClock(t) };
      }),
    [start],
  );

  const violations = markers.filter((m) => !m.ev.info).length;

  return (
    <div className="rounded-[10px] border border-[#272727] bg-[#141414] px-4 pt-3 pb-2.5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a8a8a]">
          Event Timeline · last 10 min
        </span>
        <span className="text-[11px] text-[#8a8a8a]">
          {violations} {violations === 1 ? "event" : "events"}
        </span>
      </div>

      {/* Track */}
      <div className="relative h-9 rounded-md border border-[#222] bg-[linear-gradient(90deg,#161616_0%,#1c1c1c_100%)]">
        {/* Gridlines */}
        {axisLabels.map((a, i) =>
          i === 0 || i === axisLabels.length - 1 ? null : (
            <div
              key={`grid-${i}`}
              className="absolute top-0 bottom-0 w-px bg-[#232323]"
              style={{ left: `${a.left}%` }}
            />
          ),
        )}

        {/* "now" edge */}
        <div className="absolute right-0 top-0 bottom-0 w-px bg-[#f0652c]/50" />

        {/* Event markers */}
        {markers.length === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center text-[11px] text-[#555]">
            No events in the last 10 minutes
          </div>
        ) : (
          markers.map(({ ev, left, color }) => (
            <button
              key={ev.id}
              type="button"
              onClick={() => onSelectEvent?.(ev)}
              title={`${ev.label}${ev.info ? "" : ` · ${Math.round(ev.confidence * 100)}%`} · ${ev.source} · ${formatClock(ev.time)}`}
              className="group absolute top-1/2 -translate-x-1/2 -translate-y-1/2 cursor-pointer border-none bg-transparent p-0"
              style={{ left: `${left}%` }}
            >
              <span
                className="block h-4 w-[3px] rounded-full transition-transform group-hover:scale-y-150"
                style={{ background: color, boxShadow: `0 0 6px ${color}` }}
              />
            </button>
          ))
        )}
      </div>

      {/* Axis labels */}
      <div className="relative mt-1 h-3">
        {axisLabels.map((a, i) => (
          <span
            key={`lbl-${i}`}
            className="absolute font-mono text-[9px] text-[#5c5c5c]"
            style={{
              left: `${a.left}%`,
              transform:
                i === 0
                  ? "translateX(0)"
                  : i === axisLabels.length - 1
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
            }}
          >
            {a.label}
          </span>
        ))}
      </div>
    </div>
  );
}
