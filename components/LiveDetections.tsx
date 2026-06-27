"use client";

import { forwardRef, useImperativeHandle, useRef } from "react";
import type { Detection } from "@/lib/yoloDecode";
import { ALERT_THRESHOLD } from "@/lib/modelConfig";

const SMOKING_COLOR = "#ef4444";
const LITTER_COLOR = "#f97316";
const PERSON_COLOR = "#3b82f6";

export interface LiveDetectionsHandle {
  update: (dets: Detection[]) => void;
}

function colorFor(label: string): string {
  if (label === "Smoking") return SMOKING_COLOR;
  if (label === "Person") return PERSON_COLOR;
  return LITTER_COLOR;
}

/** Build one row's static DOM once; dynamic bits are filled in on each update. */
function makeRow(): HTMLDivElement {
  const row = document.createElement("div");
  Object.assign(row.style, {
    display: "flex",
    alignItems: "center",
    gap: "12px",
    padding: "12px 16px",
    borderBottom: "1px solid var(--border)",
  });

  const dot = document.createElement("div");
  Object.assign(dot.style, {
    width: "10px",
    height: "10px",
    borderRadius: "50%",
    flexShrink: "0",
  });

  const body = document.createElement("div");
  Object.assign(body.style, { flex: "1", minWidth: "0" });

  const head = document.createElement("div");
  Object.assign(head.style, {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "5px",
  });

  const label = document.createElement("span");
  Object.assign(label.style, { fontWeight: "600", fontSize: "13px" });

  const pct = document.createElement("span");
  Object.assign(pct.style, { fontSize: "13px", fontWeight: "700" });

  const bar = document.createElement("div");
  Object.assign(bar.style, {
    height: "3px",
    background: "var(--border)",
    borderRadius: "2px",
    overflow: "hidden",
  });

  const fill = document.createElement("div");
  Object.assign(fill.style, {
    height: "100%",
    borderRadius: "2px",
    transition: "width 0.1s ease",
  });

  bar.appendChild(fill);
  head.appendChild(label);
  head.appendChild(pct);
  body.appendChild(head);
  body.appendChild(bar);
  row.appendChild(dot);
  row.appendChild(body);
  return row;
}

function fillRow(row: HTMLElement, det: Detection): void {
  const color = colorFor(det.label);
  const isAlert = det.label !== "Person" && det.confidence >= ALERT_THRESHOLD;
  const pct = Math.round(det.confidence * 100);

  const dot = row.children[0] as HTMLElement;
  const body = row.children[1] as HTMLElement;
  const head = body.children[0] as HTMLElement;
  const label = head.children[0] as HTMLElement;
  const pctEl = head.children[1] as HTMLElement;
  const fill = (body.children[1] as HTMLElement).children[0] as HTMLElement;

  dot.style.background = color;
  dot.style.boxShadow = isAlert ? `0 0 6px ${color}` : "none";
  label.textContent = det.label;
  label.style.color = isAlert ? color : "var(--text)";
  pctEl.textContent = `${pct}%`;
  pctEl.style.color = color;
  fill.style.width = `${pct}%`;
  fill.style.background = color;
}

const LiveDetections = forwardRef<LiveDetectionsHandle>(function LiveDetections(_props, ref) {
  const listRef = useRef<HTMLDivElement>(null);
  const emptyRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      update(dets: Detection[]) {
        const list = listRef.current;
        if (!list) return;
        const sorted = [...dets].sort((a, b) => b.confidence - a.confidence);

        if (emptyRef.current) {
          emptyRef.current.style.display = sorted.length ? "none" : "block";
        }
        if (countRef.current) {
          countRef.current.textContent = sorted.length ? String(sorted.length) : "";
          countRef.current.style.display = sorted.length ? "inline-block" : "none";
        }

        // Reconcile the row pool: add/remove rows, then fill each in place.
        while (list.children.length < sorted.length) list.appendChild(makeRow());
        while (list.children.length > sorted.length) list.removeChild(list.lastChild!);
        sorted.forEach((det, i) => fillRow(list.children[i] as HTMLElement, det));
      },
    }),
    [],
  );

  return (
    <div
      style={{
        background: "var(--card)",
        border: "1px solid var(--border)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        flexShrink: 0,
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
        <span
          ref={countRef}
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "var(--accent)",
            background: "rgba(59,130,246,0.12)",
            padding: "2px 8px",
            borderRadius: 4,
            display: "none",
          }}
        />
      </div>

      <div style={{ flex: 1, overflowY: "auto", minHeight: 0 }}>
        <div ref={listRef} />
        <div
          ref={emptyRef}
          style={{
            padding: "28px 24px",
            textAlign: "center",
            color: "var(--muted)",
            fontSize: 13,
          }}
        >
          No detections
        </div>
      </div>
    </div>
  );
});

export default LiveDetections;
