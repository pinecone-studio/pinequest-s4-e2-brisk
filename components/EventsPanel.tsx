"use client";

import type { EvidenceEvent } from "@/lib/evidence";
import { SMOKING_THRESHOLD, LITTER_THRESHOLD } from "@/lib/modelConfig";

const SMOKING_COLOR = "#ef4444";
const LITTER_COLOR = "#f97316";

function colorFor(label: string): string {
  return label === "Litter" ? LITTER_COLOR : SMOKING_COLOR;
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
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        flex: 1,
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: "14px 16px 12px",
          borderBottom: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--muted)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
        >
          Events
        </span>
        {events.length > 0 ? (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: SMOKING_COLOR,
              background: "rgba(239,68,68,0.12)",
              padding: "2px 8px",
              borderRadius: 4,
            }}
          >
            {events.length}
          </span>
        ) : (
          live && (
            <span
              style={{
                fontSize: 11,
                color: "var(--muted)",
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--green)",
                  boxShadow: "0 0 6px var(--green)",
                }}
              />
              Live
            </span>
          )
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {events.length === 0 ? (
          <div
            style={{
              padding: "48px 24px",
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 13,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 8,
            }}
          >
            <span style={{ fontSize: 22, opacity: 0.4 }}>&#128276;</span>
            No events
            <span style={{ fontSize: 11, color: "#555" }}>
              Smoking &amp; litter detections appear here
            </span>
          </div>
        ) : (
          events.map((ev) => {
            const pct = Math.round(ev.confidence * 100);
            const color = colorFor(ev.label);
            return (
              <div
                key={ev.id}
                style={{
                  display: "flex",
                  gap: 12,
                  padding: "12px 16px",
                  borderBottom: "1px solid var(--border)",
                  animation: "evIn 0.25s ease",
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={ev.thumb}
                  alt="evidence"
                  style={{
                    width: 72,
                    height: 48,
                    objectFit: "cover",
                    borderRadius: 4,
                    flexShrink: 0,
                    background: "#000",
                    border: "1px solid var(--border)",
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      marginBottom: 4,
                    }}
                  >
                    <span
                      style={{
                        fontWeight: 700,
                        fontSize: 12,
                        color,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                      }}
                    >
                      {ev.label}
                    </span>
                    <span style={{ fontSize: 13, color, fontWeight: 700 }}>
                      {pct}%
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: "var(--muted)" }}>
                    {formatTime(ev.time)}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      marginTop: 3,
                      color: ev.savedPath ? "var(--green)" : "var(--yellow)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={ev.savedPath ?? ev.saveError}
                  >
                    {ev.savedPath
                      ? `✓ saved • ${ev.savedPath.split(/[\\/]/).pop()}`
                      : `⚠ not saved${ev.saveError ? ` • ${ev.saveError}` : ""}`}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      <div
        style={{
          padding: "10px 16px",
          borderTop: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <span
            style={{
              fontSize: 11,
              color: "var(--muted)",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: SMOKING_COLOR,
              }}
            />
            Smoking &ge; {Math.round(SMOKING_THRESHOLD * 100)}%
          </span>
          <span
            style={{
              fontSize: 11,
              color: "var(--muted)",
              display: "flex",
              alignItems: "center",
              gap: 5,
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: LITTER_COLOR,
              }}
            />
            Litter &ge; {Math.round(LITTER_THRESHOLD * 100)}%
          </span>
        </div>
      </div>

      <style>{`@keyframes evIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }`}</style>
    </div>
  );
}
