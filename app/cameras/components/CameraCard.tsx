"use client";

import { useEffect, useState } from "react";
import { buildCameraStreamUrl } from "../lib/cameraApi";
import type { CameraView } from "../lib/cameraTypes";
import type { StreamLoadState } from "./CameraGrid";

const STREAM_LOAD_TIMEOUT_MS = 25000;

function cameraTitle(camera: CameraView) {
  return camera.name || camera.id;
}

export default function CameraCard({
  camera,
  label,
  streamState,
  selected,
  onSelect,
  onStreamSettled,
  onCredentialsRequest,
}: {
  camera: CameraView;
  label: string;
  streamState: StreamLoadState;
  selected?: boolean;
  onSelect?: () => void;
  onStreamSettled: (state: "online" | "stream_unavailable") => void;
  onCredentialsRequest?: () => void;
}) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const streamUrl = buildCameraStreamUrl(camera);
  const streamActive =
    camera.enabled !== false && (streamState === "loading" || streamState === "online");
  const showStream = streamActive;

  const isDisabled = camera.enabled === false;
  const isUnavailable = streamState === "stream_unavailable";
  const isOnline = streamState === "online";

  const dotColor = isDisabled
    ? "var(--faint)"
    : isUnavailable
      ? "var(--red)"
      : isOnline
        ? "var(--brand)"
        : "var(--yellow)";

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

  const handleUnavailableClick = () => {
    if (isUnavailable && onCredentialsRequest) {
      onCredentialsRequest();
      return;
    }
    onSelect?.();
  };

  return (
    <article
      className="cam-tile"
      onClick={handleUnavailableClick}
      style={{
        position: "relative",
        aspectRatio: "16 / 9",
        width: "100%",
        overflow: "hidden",
        borderRadius: 10,
        background: "#000",
        cursor: onSelect || onCredentialsRequest ? "pointer" : "default",
        border: selected ? "2px solid var(--brand)" : "1px solid var(--border)",
        boxShadow: selected ? "0 0 0 3px var(--brand-soft)" : "none",
      }}
    >
      {showStream ? (
        <>
          <img
            src={camera.stream_url ?? streamUrl}
            alt={cameraTitle(camera)}
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
            <div className="cam-overlay-center">LOADING</div>
          ) : null}
        </>
      ) : (
        <div className="cam-overlay-center" style={{ flexDirection: "column", gap: 6 }}>
          <span>{isDisabled ? "DISABLED" : isUnavailable ? "STREAM UNAVAILABLE" : "LOADING"}</span>
          {isUnavailable && onCredentialsRequest ? (
            <span style={{ fontSize: 10, letterSpacing: "0.04em", color: "var(--faint)" }}>
              Click to enter credentials
            </span>
          ) : null}
        </div>
      )}

      <div
        style={{
          position: "absolute",
          inset: 0,
          pointerEvents: "none",
          background:
            "linear-gradient(to top, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0) 34%)",
        }}
      />
      <div
        style={{
          position: "absolute",
          left: 12,
          bottom: 10,
          display: "flex",
          alignItems: "center",
          gap: 7,
        }}
      >
        <span
          style={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            background: dotColor,
            boxShadow: isOnline ? `0 0 6px ${dotColor}` : "none",
            flexShrink: 0,
          }}
        />
        <span
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: "#fff",
            letterSpacing: "0.02em",
            textShadow: "0 1px 2px rgba(0,0,0,0.6)",
          }}
        >
          {label}
        </span>
      </div>

      <button
        type="button"
        title="Enter camera credentials"
        onClick={(event) => {
          event.stopPropagation();
          onCredentialsRequest?.();
        }}
        style={{
          position: "absolute",
          right: 10,
          bottom: 8,
          width: 24,
          height: 24,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
          background: "transparent",
          color: "rgba(255,255,255,0.75)",
          cursor: "pointer",
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </button>
    </article>
  );
}
