"use client";

import type { EvidenceEvent } from "@/lib/evidence";
import { SMOKING_THRESHOLD } from "@/lib/modelConfig";

const CIGARETTE_COLOR = "#ef4444";
const VAPE_COLOR = "#a855f7";
const LITTER_COLOR = "#f97316";

function colorFor(label: string): string {
  if (label === "Litter") return LITTER_COLOR;
  if (label === "Vape") return VAPE_COLOR;
  return CIGARETTE_COLOR;
}

interface Props {
  events: EvidenceEvent[];
  live?: boolean;
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export default function EventsPanel({ events, live = false }: Props) {
  return (
    <div className="bg-[#1a1a1a] border border-[#272727] rounded-[10px] flex flex-col overflow-hidden flex-1 min-h-0">
      <div className="px-4 pt-[14px] pb-3 border-b border-[#272727] flex items-center justify-between shrink-0">
        <span className="text-[11px] font-semibold text-[#8a8a8a] uppercase tracking-[0.08em]">
          Events
        </span>
        {events.length > 0 ? (
          <span className="text-[11px] font-bold text-[#ef4444] bg-[rgba(239,68,68,0.12)] px-2 py-0.5 rounded">
            {events.length}
          </span>
        ) : (
          live && (
            <span className="text-[11px] text-[#8a8a8a] flex items-center gap-1.5">
              <span className="w-[7px] h-[7px] rounded-full bg-[#22c55e] shadow-[0_0_6px_#22c55e]" />
              Live
            </span>
          )
        )}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {events.length === 0 ? (
          <div className="px-6 py-12 text-center text-[#8a8a8a] text-[13px] flex flex-col items-center gap-2">
            <span className="text-[22px] opacity-40">&#128276;</span>
            No events
            <span className="text-[11px] text-[#555]">
              Smoking &amp; littering events appear here (Cigarette / Vape / Litter)
            </span>
            <span className="text-[10px] text-[#444] max-w-[220px]">
              Littering = hold object, drop on floor, then walk away (~8s)
            </span>
          </div>
        ) : (
          events.map((ev) => {
            const pct = Math.round(ev.confidence * 100);
            const color = ev.info ? "#8a8a8a" : colorFor(ev.label);
            return (
              <div
                key={ev.id}
                className="flex gap-3 px-4 py-3 border-b border-[#272727] animate-[evIn_0.25s_ease]"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={ev.thumb}
                  alt="evidence"
                  className="w-[72px] h-12 object-cover rounded shrink-0 bg-black border border-[#272727]"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between mb-1">
                    <span
                      className="font-bold text-[12px] uppercase tracking-[0.04em] flex items-center gap-1.5"
                      style={{ color }}
                    >
                      {ev.info ? (
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
                        </svg>
                      ) : null}
                      {ev.label}
                    </span>
                    {ev.info ? null : (
                      <span className="text-[13px] font-bold" style={{ color }}>
                        {pct}%
                      </span>
                    )}
                  </div>
                  {ev.note ? (
                    <div
                      className="text-[11.5px] text-[#c4c4c4] italic leading-snug mb-1"
                      title={ev.note}
                    >
                      &ldquo;{ev.note}&rdquo;
                    </div>
                  ) : null}
                  <div className="text-[12px] text-[#8a8a8a]">
                    {formatTime(ev.time)}
                  </div>
                  <div
                    className="text-[11px] mt-0.5 text-[#8a8a8a] flex items-center gap-[5px] overflow-hidden text-ellipsis whitespace-nowrap"
                    title={ev.source}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M23 7l-7 5 7 5zM1 5h15v14H1z" />
                    </svg>
                    {ev.source}
                  </div>
                  {ev.info ? null : (
                    <div
                      className="text-[11px] mt-[3px] overflow-hidden text-ellipsis whitespace-nowrap"
                      style={{ color: ev.savedPath ? "#22c55e" : "#eab308" }}
                      title={ev.savedPath ?? ev.saveError}
                    >
                      {ev.savedPath
                        ? `✓ saved • ${ev.savedPath.split(/[\\/]/).pop()}`
                        : `⚠ not saved${ev.saveError ? ` • ${ev.saveError}` : ""}`}
                    </div>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="px-4 py-2.5 border-t border-[#272727] shrink-0">
        <div className="flex gap-3.5 flex-wrap">
          <span className="text-[11px] text-[#8a8a8a] flex items-center gap-[5px]">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: CIGARETTE_COLOR }} />
            Cigarette &ge; {Math.round(SMOKING_THRESHOLD * 100)}%
          </span>
          <span className="text-[11px] text-[#8a8a8a] flex items-center gap-[5px]">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: VAPE_COLOR }} />
            Vape &ge; {Math.round(SMOKING_THRESHOLD * 100)}%
          </span>
          <span className="text-[11px] text-[#8a8a8a] flex items-center gap-[5px]">
            <span className="inline-block w-2 h-2 rounded-full" style={{ background: LITTER_COLOR }} />
            Littering (carry → drop → leave)
          </span>
        </div>
      </div>
    </div>
  );
}
