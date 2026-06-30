"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { cameraStreamWsUrl, jsmpegScriptUrl } from "../lib/universalCameraApi";
import type { TileConnectionState, UniversalCamera } from "../lib/universalCameraTypes";

let jsmpegLoader: Promise<void> | null = null;

function loadJsmpeg(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("JSMpeg requires a browser"));
  }
  if (window.JSMpeg) {
    return Promise.resolve();
  }
  if (jsmpegLoader) {
    return jsmpegLoader;
  }
  jsmpegLoader = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = jsmpegScriptUrl();
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Failed to load JSMpeg"));
    document.head.appendChild(script);
  });
  return jsmpegLoader;
}

const RECONNECT_DELAY_MS = 3000;
const CONNECT_TIMEOUT_MS = 15000;

export default function CameraTile({ camera }: { camera: UniversalCamera }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<{ destroy: () => void } | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveRef = useRef(false);
  const mountedRef = useRef(true);
  const [state, setState] = useState<TileConnectionState>("idle");

  const teardown = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    if (playerRef.current) {
      playerRef.current.destroy();
      playerRef.current = null;
    }
    liveRef.current = false;
  }, []);

  const connect = useCallback(async () => {
    if (!mountedRef.current || !canvasRef.current) return;

    teardown();
    setState("loading");

    try {
      await loadJsmpeg();
      if (!mountedRef.current || !canvasRef.current || !window.JSMpeg) return;

      connectTimeoutRef.current = setTimeout(() => {
        if (!mountedRef.current || liveRef.current) return;
        setState("error");
        reconnectTimerRef.current = setTimeout(() => {
          void connect();
        }, RECONNECT_DELAY_MS);
      }, CONNECT_TIMEOUT_MS);

      const player = new window.JSMpeg.Player(cameraStreamWsUrl(camera.id), {
        canvas: canvasRef.current,
        autoplay: true,
        audio: false,
        pauseWhenHidden: false,
        disableGl: true,
        onSourceEstablished: () => {
          if (!mountedRef.current) return;
          liveRef.current = true;
          if (connectTimeoutRef.current) {
            clearTimeout(connectTimeoutRef.current);
            connectTimeoutRef.current = null;
          }
          setState("live");
        },
        onSourceCompleted: () => {
          if (!mountedRef.current) return;
          liveRef.current = false;
          setState("reconnecting");
          reconnectTimerRef.current = setTimeout(() => {
            void connect();
          }, RECONNECT_DELAY_MS);
        },
      });

      playerRef.current = player;
    } catch {
      if (!mountedRef.current) return;
      setState("error");
      reconnectTimerRef.current = setTimeout(() => {
        void connect();
      }, RECONNECT_DELAY_MS);
    }
  }, [camera.id, teardown]);

  useEffect(() => {
    mountedRef.current = true;
    void connect();
    return () => {
      mountedRef.current = false;
      teardown();
    };
  }, [camera.id, connect, teardown]);

  const statusLabel =
    state === "loading"
      ? "Connecting"
      : state === "live"
        ? "Live"
        : state === "reconnecting"
          ? "Reconnecting"
          : state === "error"
            ? "Unavailable"
            : "Idle";

  const statusClass =
    state === "live"
      ? "bg-emerald-500/20 text-emerald-300"
      : state === "error"
        ? "bg-red-500/20 text-red-300"
        : "bg-amber-500/20 text-amber-200";

  return (
    <article className="flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-lg">
      <div className="relative aspect-video bg-black">
        <canvas ref={canvasRef} className="h-full w-full object-contain" />
        {state !== "live" ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/55">
            <span className="text-sm text-zinc-200">{statusLabel}</span>
          </div>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-zinc-800 px-3 py-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-100">{camera.name}</p>
          <p className="truncate text-xs text-zinc-500">
            {camera.host}:{camera.port} · {camera.source}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${statusClass}`}>
          {statusLabel}
        </span>
      </div>
    </article>
  );
}
