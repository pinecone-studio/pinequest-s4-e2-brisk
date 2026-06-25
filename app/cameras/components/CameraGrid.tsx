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
  const [focusedCameraId, setFocusedCameraId] = useState<string | null>(null);
  const focusedCamera = cameras.find((camera) => camera.id === focusedCameraId);

  const openFocusedCamera = (camera: CameraView) => {
    setFocusedCameraId(camera.id);
    if (camera.enabled === false) return;

    setStreamStates((current) => {
      if ((current[camera.id] ?? "not_started") !== "not_started") return current;
      return { ...current, [camera.id]: "loading" };
    });
  };

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
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
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
    <>
      <div
        className="grid grid-cols-1 md:grid-cols-2 gap-5"
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(340px, 1fr))",
          gap: 20,
        }}
      >
        {cameras.map((camera) => (
          <CameraCard
            key={camera.id}
            camera={camera}
            streamState={streamStates[camera.id] ?? "not_started"}
            onOpen={() => openFocusedCamera(camera)}
            onStreamSettled={(state) => {
              setStreamStates((current) => {
                if (current[camera.id] === state) return current;
                return { ...current, [camera.id]: state };
              });
            }}
          />
        ))}
      </div>

      {focusedCamera ? (
        <FocusedCameraView
          camera={focusedCamera}
          streamState={streamStates[focusedCamera.id] ?? "not_started"}
          onClose={() => setFocusedCameraId(null)}
          onStreamSettled={(state) => {
            setStreamStates((current) => {
              if (current[focusedCamera.id] === state) return current;
              return { ...current, [focusedCamera.id]: state };
            });
          }}
        />
      ) : null}
    </>
  );
}

function FocusedCameraView({
  camera,
  streamState,
  onClose,
  onStreamSettled,
}: {
  camera: CameraView;
  streamState: StreamLoadState;
  onClose: () => void;
  onStreamSettled: (state: "online" | "stream_unavailable") => void;
}) {
  const streamActive = camera.enabled !== false && (streamState === "loading" || streamState === "online");

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${camera.name ?? camera.id} focused stream`}
      className="fixed inset-0 z-50"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0, 0, 0, 0.82)",
      }}
    >
      <section
        className="w-full max-w-6xl overflow-hidden rounded-xl border border-neutral-800 bg-neutral-950"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 1180,
          overflow: "hidden",
          borderRadius: 12,
          border: "1px solid #262626",
          background: "#050505",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            padding: "12px 14px",
            borderBottom: "1px solid #262626",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "var(--text)",
                fontSize: 15,
                fontWeight: 700,
              }}
            >
              {camera.name ?? camera.id}
            </div>
            <div
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                color: "var(--muted)",
                fontSize: 12,
              }}
            >
              {camera.host ?? camera.id}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close focused camera view"
            style={{
              flexShrink: 0,
              borderRadius: 6,
              border: "1px solid #3f3f46",
              background: "#18181b",
              color: "var(--text)",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 700,
              padding: "7px 10px",
            }}
          >
            Close
          </button>
        </div>

        <div
          style={{
            position: "relative",
            aspectRatio: "16 / 9",
            width: "100%",
            background: "#000",
          }}
        >
          {streamActive ? (
            <>
              <img
                src={camera.stream_url}
                alt={camera.name ?? camera.id}
                style={{
                  display: "block",
                  height: "100%",
                  width: "100%",
                  objectFit: "contain",
                }}
                onLoad={() => onStreamSettled("online")}
                onError={() => onStreamSettled("stream_unavailable")}
              />
              {streamState === "loading" ? (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: "var(--muted)",
                    fontSize: 13,
                    background: "#000",
                  }}
                >
                  LOADING
                </div>
              ) : null}
            </>
          ) : (
            <div
              style={{
                display: "flex",
                height: "100%",
                width: "100%",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--muted)",
                fontSize: 13,
              }}
            >
              {streamState === "stream_unavailable" ? "STREAM UNAVAILABLE" : "LOADING"}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
