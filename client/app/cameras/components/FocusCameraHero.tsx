"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buildCameraStreamUrl } from "../lib/cameraApi";
import type { CameraView } from "../lib/cameraTypes";
import type { Detection } from "@/lib/detection";
import type { EvidenceEvent } from "@/lib/evidence";
import {
  EVIDENCE_COOLDOWN_MS,
  FRAME_HISTORY_MS,
  GEMINI_BURST_FRAMES,
  GEMINI_BURST_INTERVAL_MS,
  GEMINI_FETCH_TIMEOUT_MS,
  GEMINI_VIOLATION_THRESHOLD,
} from "@/lib/aiConfig";
import {
  captureBurstForGemini,
  captureEvidenceFromSource,
  CIGARETTE_KIND,
  imageToGeminiDataUrl,
  LITTER_KIND,
  VAPE_KIND,
} from "@/lib/cameraAiUtils";
import {
  isLiveStreamUrl,
  SELECTED_AI_INTERVAL_MS,
  SELECTED_GEMINI_BACKOFF_MS,
  SELECTED_GEMINI_COOLDOWN_MS,
} from "@/lib/demoConfig";

const STREAM_LOAD_TIMEOUT_MS = 25_000;
const ALERT_FLASH_MS = 5_000;

type ViolationLabel = "Cigarette" | "Vape" | "Litter";

const VIOLATION_COLORS: Record<ViolationLabel, string> = {
  Cigarette: "#ef4444",
  Vape: "#a855f7",
  Litter: "#f97316",
};

function detectEndpoint(cameraId: string): string {
  return `/api/gemini/${encodeURIComponent(cameraId)}`;
}

function formatClock(date: Date): string {
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

export default function FocusCameraHero({
  camera,
  label,
  aiReady,
  onEvent,
}: {
  camera: CameraView;
  label: string;
  aiReady: boolean;
  onEvent?: (event: EvidenceEvent) => void;
}) {
  const [streamState, setStreamState] = useState<"loading" | "online" | "offline">("loading");
  const [imageLoaded, setImageLoaded] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [statusLine, setStatusLine] = useState("Connecting to live feed…");
  const [activeAlert, setActiveAlert] = useState<{
    label: ViolationLabel;
    confidence: number;
    summary: string;
  } | null>(null);
  const [clock, setClock] = useState("");

  const imgRef = useRef<HTMLImageElement>(null);
  const onEventRef = useRef(onEvent);
  const frameHistoryRef = useRef<{ dataUrl: string; at: number }[]>([]);
  const lastGeminiAtRef = useRef(0);
  const geminiBackoffUntilRef = useRef(0);
  const verifyInFlightRef = useRef(false);
  const lastCaptureRef = useRef({ cigarette: 0, vape: 0, litter: 0 });
  const alertTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const streamUrl = buildCameraStreamUrl(camera);
  const canStream = camera.enabled !== false && isLiveStreamUrl(streamUrl);
  const aiActive = aiReady && streamState === "online" && imageLoaded;

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    setStreamState("loading");
    setImageLoaded(false);
    setStatusLine("Connecting to live feed…");
    setActiveAlert(null);
    frameHistoryRef.current = [];
    lastGeminiAtRef.current = 0;
  }, [camera.id, camera.stream_url]);

  useEffect(() => {
    const id = window.setInterval(() => setClock(formatClock(new Date())), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
      if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
    };
  }, []);

  const flashAlert = useCallback((label: ViolationLabel, confidence: number, summary: string) => {
    setActiveAlert({ label, confidence, summary });
    if (alertTimerRef.current) clearTimeout(alertTimerRef.current);
    alertTimerRef.current = setTimeout(() => setActiveAlert(null), ALERT_FLASH_MS);
  }, []);

  const runGeminiVerify = useCallback(async () => {
    if (verifyInFlightRef.current || !aiActive) return;

    const img = imgRef.current;
    if (!img || img.naturalWidth === 0) return;

    verifyInFlightRef.current = true;
    lastGeminiAtRef.current = Date.now();
    setAnalyzing(true);
    setStatusLine("Analyzing live frames…");

    try {
      const now = Date.now();
      const history = frameHistoryRef.current.filter((f) => now - f.at < FRAME_HISTORY_MS);
      let images =
        history.length >= 2
          ? [history[history.length - 2].dataUrl, history[history.length - 1].dataUrl]
          : history.length === 1
            ? [history[0].dataUrl]
            : [];

      if (images.length < GEMINI_BURST_FRAMES) {
        const burst = await captureBurstForGemini(
          img,
          GEMINI_BURST_FRAMES,
          GEMINI_BURST_INTERVAL_MS,
          () => imgRef.current,
        );
        if (burst.length > 0) images = burst;
      }

      if (images.length === 0) {
        setStatusLine("Waiting for frames…");
        return;
      }

      const controller = new AbortController();
      const fetchTimeout = window.setTimeout(
        () => controller.abort(),
        GEMINI_FETCH_TIMEOUT_MS,
      );

      let data: { detections?: Detection[]; summary?: string };
      try {
        const res = await fetch(detectEndpoint(camera.id), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ images }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
        data = (await res.json()) as { detections?: Detection[]; summary?: string };
      } finally {
        window.clearTimeout(fetchTimeout);
      }

      const raw = Array.isArray(data.detections) ? data.detections : [];
      const dets = raw.filter(
        (d) => d.label === "Person" || d.confidence >= GEMINI_VIOLATION_THRESHOLD,
      );
      const summary = (data.summary ?? "").trim();
      const liveImg = imgRef.current;
      if (!liveImg) return;

      const ts = Date.now();
      const best = (detLabel: string) =>
        dets
          .filter((d) => d.label === detLabel)
          .sort((a, b) => b.confidence - a.confidence)[0];

      const violations: {
        det: Detection | undefined;
        kind: typeof CIGARETTE_KIND;
        key: "cigarette" | "vape" | "litter";
        label: ViolationLabel;
      }[] = [
        { det: best("Cigarette"), kind: CIGARETTE_KIND, key: "cigarette", label: "Cigarette" },
        { det: best("Vape"), kind: VAPE_KIND, key: "vape", label: "Vape" },
        { det: best("Litter"), kind: LITTER_KIND, key: "litter", label: "Litter" },
      ];

      let triggered = false;
      for (const { det, kind, key, label: violationLabel } of violations) {
        if (!det) continue;
        triggered = true;
        flashAlert(violationLabel, det.confidence, summary || `${violationLabel} detected`);
        if (ts - lastCaptureRef.current[key] >= EVIDENCE_COOLDOWN_MS) {
          lastCaptureRef.current[key] = ts;
          void captureEvidenceFromSource(
            liveImg,
            camera.id,
            label,
            kind,
            det.confidence,
            onEventRef.current,
            summary || undefined,
          );
        }
      }

      if (!triggered) {
        setStatusLine(summary || "Monitoring — no violations detected");
      }
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      if (!isAbort) {
        console.warn(`[focus-ai:${camera.id}]`, err);
        setStatusLine("Analysis paused — retrying…");
      }
    } finally {
      verifyInFlightRef.current = false;
      setAnalyzing(false);
    }
  }, [aiActive, camera.id, flashAlert, label]);

  const sampleFrame = useCallback(() => {
    const img = imgRef.current;
    if (!img || img.naturalWidth === 0) return;

    const dataUrl = imageToGeminiDataUrl(img);
    if (!dataUrl) return;

    const now = Date.now();
    frameHistoryRef.current = [
      ...frameHistoryRef.current.filter((f) => now - f.at < FRAME_HISTORY_MS),
      { dataUrl, at: now },
    ].slice(-3);

    if (!aiActive || verifyInFlightRef.current) return;
    if (now < geminiBackoffUntilRef.current) return;
    if (now - lastGeminiAtRef.current < SELECTED_GEMINI_COOLDOWN_MS) return;

    void runGeminiVerify();
  }, [aiActive, runGeminiVerify]);

  useEffect(() => {
    if (!canStream || !aiActive) return undefined;
    const id = window.setInterval(sampleFrame, SELECTED_AI_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [canStream, aiActive, camera.id, sampleFrame]);

  useEffect(() => {
    if (streamState !== "loading") return undefined;
    const timeout = window.setTimeout(() => {
      if (!imageLoaded) setStreamState("offline");
    }, STREAM_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timeout);
  }, [streamState, imageLoaded, camera.id]);

  useEffect(() => {
    if (aiActive && !analyzing && !activeAlert) {
      setStatusLine("Live AI surveillance active");
    }
  }, [aiActive, analyzing, activeAlert]);

  const alertColor = activeAlert ? VIOLATION_COLORS[activeAlert.label] : "#f0652c";

  return (
    <section
      className={`relative overflow-hidden rounded-[12px] border bg-black transition-shadow duration-300 ${
        activeAlert
          ? "border-[#ef4444] shadow-[0_0_24px_rgba(239,68,68,0.35)] animate-[alert-pulse_1.2s_ease-in-out_infinite]"
          : "border-[#272727] shadow-[0_8px_32px_rgba(0,0,0,0.45)]"
      }`}
    >
      <div className="relative aspect-[21/9] max-h-[min(42vh,420px)] w-full min-h-[220px] bg-[#0a0a0a]">
        {canStream ? (
          <img
            key={`${camera.id}-hero`}
            ref={imgRef}
            src={streamUrl}
            alt={label}
            className="block h-full w-full object-cover"
            onLoad={() => {
              setImageLoaded(true);
              setStreamState("online");
            }}
            onError={() => {
              setImageLoaded(false);
              setStreamState("offline");
              setStatusLine("Live stream unavailable");
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[#8a8a8a] text-[13px] tracking-[0.06em]">
            STREAM NOT CONFIGURED
          </div>
        )}

        {streamState === "loading" && !imageLoaded ? (
          <div className="absolute inset-0 flex items-center justify-center bg-[#0d0d0d]">
            <div className="absolute inset-0 bg-[linear-gradient(110deg,#0d0d0d_0%,#181818_42%,#0d0d0d_78%)] opacity-80 animate-pulse" />
            <span className="relative text-[#8a8a8a] text-[12px] tracking-[0.1em]">CONNECTING LIVE FEED</span>
          </div>
        ) : null}

        {aiActive && analyzing ? (
          <div
            className="pointer-events-none absolute inset-x-0 top-0 h-[2px] bg-gradient-to-r from-transparent via-[#f0652c] to-transparent animate-[scan-line_2s_linear_infinite]"
            aria-hidden
          />
        ) : null}

        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_top,rgba(0,0,0,0.72)_0%,rgba(0,0,0,0.15)_38%,transparent_62%)]" />

        <div className="absolute left-4 top-4 flex items-center gap-2">
          {streamState === "online" ? (
            <span className="flex items-center gap-1.5 rounded-md bg-[rgba(0,0,0,0.55)] px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em] text-white backdrop-blur-sm">
              <span className="h-2 w-2 rounded-full bg-[#ef4444] animate-[live-blink_1.4s_ease-in-out_infinite]" />
              Live
            </span>
          ) : null}
          {clock ? (
            <span className="rounded-md bg-[rgba(0,0,0,0.45)] px-2.5 py-1 font-mono text-[11px] text-[#d4d4d4] backdrop-blur-sm">
              {clock}
            </span>
          ) : null}
        </div>

        <div className="absolute right-4 top-4 flex items-center gap-2">
          {aiActive ? (
            <span
              className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-bold uppercase tracking-[0.08em] backdrop-blur-sm ${
                analyzing
                  ? "bg-[rgba(240,101,44,0.25)] text-[#ffb089]"
                  : "bg-[rgba(240,101,44,0.15)] text-[#f0652c]"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full bg-[#f0652c] ${analyzing ? "animate-[pulse-dot_0.8s_ease-in-out_infinite]" : ""}`}
              />
              {analyzing ? "Analyzing" : "AI Active"}
            </span>
          ) : aiReady ? (
            <span className="rounded-md bg-[rgba(0,0,0,0.45)] px-2.5 py-1 text-[11px] text-[#8a8a8a] backdrop-blur-sm">
              AI standby
            </span>
          ) : null}
        </div>

        {activeAlert ? (
          <div
            className="absolute inset-x-4 top-1/2 -translate-y-1/2 rounded-[10px] border px-4 py-3 backdrop-blur-md"
            style={{
              borderColor: `${alertColor}88`,
              background: `${alertColor}22`,
            }}
          >
            <div
              className="text-[13px] font-bold uppercase tracking-[0.1em]"
              style={{ color: alertColor }}
            >
              {activeAlert.label} detected — {Math.round(activeAlert.confidence * 100)}%
            </div>
            {activeAlert.summary ? (
              <div className="mt-1 text-[12px] leading-snug text-[#e8e8e8]">
                {activeAlert.summary}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-3 px-4 pb-3 pt-8">
          <div className="min-w-0">
            <div className="text-[15px] font-semibold text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.8)]">
              {label}
            </div>
            <div className="mt-0.5 truncate text-[12px] text-[#c4c4c4] [text-shadow:0_1px_2px_rgba(0,0,0,0.8)]">
              {statusLine}
            </div>
          </div>
          <div className="hidden shrink-0 text-[10px] uppercase tracking-[0.08em] text-[#8a8a8a] sm:block">
            Carry → drop → leave
          </div>
        </div>
      </div>
    </section>
  );
}
