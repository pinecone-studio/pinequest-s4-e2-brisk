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
    ? "#5c5c5c"
    : isUnavailable
      ? "#ef4444"
      : isOnline
        ? "#f0652c"
        : "#eab308";

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
      className={`relative aspect-video w-full overflow-hidden rounded-[10px] bg-black ${
        onSelect || onCredentialsRequest ? "cursor-pointer" : "cursor-default"
      } ${
        selected
          ? "border-2 border-[#f0652c] shadow-[0_0_0_3px_rgba(240,101,44,0.14)]"
          : "border border-[#272727]"
      }`}
      onClick={handleUnavailableClick}
    >
      {showStream ? (
        <>
          <img
            src={camera.stream_url ?? streamUrl}
            alt={cameraTitle(camera)}
            className="block h-full w-full object-cover"
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
            <div className="absolute inset-0 flex items-center justify-center text-[#8a8a8a] text-[12px] tracking-[0.08em] bg-[#0d0d0d]">LOADING</div>
          ) : null}
        </>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-[#8a8a8a] text-[12px] tracking-[0.08em] bg-[#0d0d0d]">
          <span>{isDisabled ? "DISABLED" : isUnavailable ? "STREAM UNAVAILABLE" : "LOADING"}</span>
          {isUnavailable && onCredentialsRequest ? (
            <span className="text-[10px] tracking-[0.04em] text-[#5c5c5c]">
              Click to enter credentials
            </span>
          ) : null}
        </div>
      )}

      <div className="absolute inset-0 pointer-events-none bg-[linear-gradient(to_top,rgba(0,0,0,0.55)_0%,rgba(0,0,0,0)_34%)]" />
      <div className="absolute left-3 bottom-2.5 flex items-center gap-[7px]">
        <span
          className="w-[7px] h-[7px] rounded-full shrink-0"
          style={{
            background: dotColor,
            boxShadow: isOnline ? `0 0 6px ${dotColor}` : "none",
          }}
        />
        <span className="text-[12px] font-semibold text-white tracking-[0.02em] [text-shadow:0_1px_2px_rgba(0,0,0,0.6)]">
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
        className="absolute right-2.5 bottom-2 w-6 h-6 flex items-center justify-center border-none bg-transparent text-[rgba(255,255,255,0.75)] cursor-pointer"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </button>
    </article>
  );
}
