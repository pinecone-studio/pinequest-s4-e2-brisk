"use client";

import { useEffect, useState } from "react";
import CameraStatusBadge from "./CameraStatusBadge";
import { buildCameraStreamUrl } from "../lib/cameraApi";
import type { CameraView } from "../lib/cameraTypes";
import type { StreamLoadState } from "./CameraGrid";

const STREAM_LOAD_TIMEOUT_MS = 25000;

function cameraTitle(camera: CameraView) {
  return camera.name || camera.id;
}

function cameraMeta(camera: CameraView) {
  const parts = [];
  if (camera.host) parts.push(camera.host);
  if (camera.location) parts.push(camera.location);
  if (camera.description && camera.description.toLowerCase() !== "unknown") {
    parts.push(camera.description);
  }
  if (parts.length === 0 && camera.floor) parts.push(`Floor ${camera.floor}`);
  if (parts.length === 0 && camera.zone && camera.zone !== "unknown") parts.push(camera.zone);
  return parts.join(" • ");
}

export default function CameraCard({
  camera,
  streamState,
  onStreamSettled,
}: {
  camera: CameraView;
  streamState: StreamLoadState;
  onStreamSettled: (state: "online" | "stream_unavailable") => void;
}) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const streamUrl = buildCameraStreamUrl(camera);
  const streamActive = camera.enabled !== false && (streamState === "loading" || streamState === "online");
  const showStream = streamActive;
  const displayStatus = camera.enabled === false
    ? "disabled"
    : streamState === "stream_unavailable"
      ? "stream_unavailable"
      : streamState === "online"
        ? "online"
        : "loading";

  useEffect(() => {
    setImageLoaded(false);
  }, [camera.id, camera.stream_url, camera.enabled]);

  useEffect(() => {
    if (camera.enabled === false || streamState !== "loading") return;

    const timeout = window.setTimeout(() => {
      setImageLoaded((loaded) => {
        if (!loaded) {
          onStreamSettled("stream_unavailable");
        }
        return loaded;
      });
    }, STREAM_LOAD_TIMEOUT_MS);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [camera.id, camera.stream_url, camera.enabled, streamState, onStreamSettled]);

  return (
    <article
      className="rounded-xl border border-neutral-800 bg-neutral-900/70 overflow-hidden"
      style={{
        minWidth: 0,
        overflow: "hidden",
        borderRadius: 12,
        border: "1px solid #262626",
        background: "rgba(23, 23, 23, 0.7)",
      }}
    >
      <div
        className="relative aspect-video w-full overflow-hidden bg-black"
        style={{
          position: "relative",
          aspectRatio: "16 / 9",
          width: "100%",
          overflow: "hidden",
          background: "#000",
        }}
      >
        {showStream ? (
          <>
            <img
              src={camera.stream_url ?? streamUrl}
              alt={cameraTitle(camera)}
              className="h-full w-full object-cover"
              style={{
                display: "block",
                height: "100%",
                width: "100%",
                objectFit: "cover",
              }}
              onLoad={() => {
                setImageLoaded(true);
                onStreamSettled("online");
              }}
              onError={() => {
                setImageLoaded(false);
                onStreamSettled("stream_unavailable");
              }}
            />
            {streamState === "loading" && !imageLoaded ? (
              <div
                className="absolute inset-0 flex items-center justify-center text-xs text-[var(--muted)]"
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--muted)",
                  fontSize: 12,
                  background: "#000",
                }}
              >
                LOADING
              </div>
            ) : null}
          </>
        ) : (
          <div
            className="flex h-full w-full items-center justify-center text-xs text-[var(--muted)]"
            style={{
              display: "flex",
              height: "100%",
              width: "100%",
              alignItems: "center",
              justifyContent: "center",
              color: "var(--muted)",
              fontSize: 12,
            }}
          >
            {camera.enabled === false
              ? "Disabled"
              : streamState === "stream_unavailable"
                ? "STREAM UNAVAILABLE"
                : "LOADING"}
          </div>
        )}
      </div>

      <div
        className="flex min-w-0 items-start justify-between gap-3 px-1 pb-1 pt-2"
        style={{
          display: "flex",
          minWidth: 0,
          alignItems: "flex-start",
          justifyContent: "space-between",
          gap: 12,
          padding: "10px 12px 12px",
        }}
      >
        <div className="min-w-0 space-y-1" style={{ minWidth: 0 }}>
          <div
            className="truncate text-sm font-semibold text-[var(--text)]"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--text)",
              fontSize: 14,
              fontWeight: 600,
            }}
          >
            {cameraTitle(camera)}
          </div>
          <div
            className="truncate text-xs text-[var(--muted)]"
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--muted)",
              fontSize: 12,
            }}
          >
            {cameraMeta(camera) || camera.id}
          </div>
        </div>
        <CameraStatusBadge camera={camera} displayStatus={displayStatus} />
      </div>
    </article>
  );
}
