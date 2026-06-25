"use client";

import { useEffect, useMemo, useState } from "react";
import CameraCard from "./CameraCard";
import type { CameraView } from "../lib/cameraTypes";

const MAX_ACTIVE_STREAM_LOADS = 10;

export type StreamLoadState = "not_started" | "loading" | "online" | "stream_unavailable";

export default function CameraGrid({ cameras }: { cameras: CameraView[] }) {
  const loadableCameraIds = useMemo(
    () => cameras.filter((camera) => camera.enabled !== false).map((camera) => camera.id),
    [cameras],
  );
  const [streamStates, setStreamStates] = useState<Record<string, StreamLoadState>>({});

  useEffect(() => {
    setStreamStates((current) => {
      const next: Record<string, StreamLoadState> = {};
      for (const cameraId of loadableCameraIds) {
        next[cameraId] = current[cameraId] ?? "not_started";
      }
      return next;
    });
  }, [loadableCameraIds]);

  useEffect(() => {
    if (loadableCameraIds.length === 0) return;

    setStreamStates((current) => {
      const next = { ...current };
      let changed = false;
      let activeCount = loadableCameraIds.filter((cameraId) => next[cameraId] === "loading").length;

      for (const cameraId of loadableCameraIds) {
        if (activeCount >= MAX_ACTIVE_STREAM_LOADS) break;
        if ((next[cameraId] ?? "not_started") !== "not_started") continue;

        next[cameraId] = "loading";
        activeCount += 1;
        changed = true;
      }

      return changed ? next : current;
    });
  }, [loadableCameraIds, streamStates]);

  if (cameras.length === 0) {
    return (
      <div
        className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
          gap: 16,
        }}
      >
        <div
          className="flex aspect-video items-center justify-center rounded-lg border border-[var(--border)] bg-[#111] text-xs text-[var(--muted)]"
          style={{
            aspectRatio: "16 / 9",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "#111",
            color: "var(--muted)",
            fontSize: 12,
          }}
        >
          No cameras configured
        </div>
      </div>
    );
  }

  return (
    <div
      className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
        gap: 16,
      }}
    >
      {cameras.map((camera) => (
        <CameraCard
          key={camera.id}
          camera={camera}
          streamState={streamStates[camera.id] ?? "not_started"}
          onStreamSettled={(state) => {
            setStreamStates((current) => {
              if (current[camera.id] === state) return current;
              return { ...current, [camera.id]: state };
            });
          }}
        />
      ))}
    </div>
  );
}
