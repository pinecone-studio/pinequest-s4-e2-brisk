"use client";

import { Detection } from "@/lib/yoloDecode";
import { ALERT_THRESHOLD, LITTER_THRESHOLD, SMOKING_THRESHOLD } from "@/lib/modelConfig";

const SMOKING_COLOR = "#ef4444";
const LITTER_COLOR = "#f97316";

interface Props {
  detections: Detection[];
}

function getColor(label: string): string {
  return label === "Smoking" ? SMOKING_COLOR : LITTER_COLOR;
}

export default function DetectionPanel({ detections }: Props) {
  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "14px 16px 10px",
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
          Live Detections
        </span>
        {detections.length > 0 && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: "var(--accent)",
              background: "rgba(59,130,246,0.12)",
              padding: "2px 8px",
              borderRadius: 4,
            }}
          >
            {detections.length}
          </span>
        )}
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        {detections.length === 0 ? (
          <div
            style={{
              padding: "48px 24px",
              textAlign: "center",
              color: "var(--muted)",
              fontSize: 13,
            }}
          >
            No detections
          </div>
        ) : (
          detections
            .slice()
            .sort((a, b) => b.confidence - a.confidence)
            .map((det, i) => {
              const color = getColor(det.label);
              const pct = Math.round(det.confidence * 100);
              const isAlert = det.confidence >= ALERT_THRESHOLD;

              return (
                <div
                  key={i}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 16px",
                    borderBottom: "1px solid var(--border)",
                  }}
                >
                  <div
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      background: color,
                      flexShrink: 0,
                      boxShadow: isAlert ? `0 0 6px ${color}` : undefined,
                    }}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        marginBottom: 5,
                      }}
                    >
                      <span
                        style={{
                          fontWeight: 600,
                          fontSize: 13,
                          color: isAlert ? color : "var(--text)",
                        }}
                      >
                        {det.label}
                      </span>
                      <span style={{ fontSize: 13, color: color, fontWeight: 700 }}>
                        {pct}%
                      </span>
                    </div>
                    <div
                      style={{
                        height: 3,
                        background: "var(--border)",
                        borderRadius: 2,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          height: "100%",
                          width: `${pct}%`,
                          background: color,
                          borderRadius: 2,
                          transition: "width 0.1s ease",
                        }}
                      />
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
        <div style={{ display: "flex", gap: 16 }}>
          <span style={{ fontSize: 11, color: "var(--muted)", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: SMOKING_COLOR }} />
            Smoking ≥ {Math.round(SMOKING_THRESHOLD * 100)}%
          </span>
          <span style={{ fontSize: 11, color: "var(--muted)", display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: LITTER_COLOR }} />
            Litter ≥ {Math.round(LITTER_THRESHOLD * 100)}%
          </span>
        </div>
      </div>
    </div>
  );
}
