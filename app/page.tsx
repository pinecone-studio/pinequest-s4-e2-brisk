"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { loadModels } from "@/lib/inference";
import { Detection } from "@/lib/yoloDecode";
import DetectionPanel from "@/components/DetectionPanel";
import ModelStatusBadge from "@/components/ModelStatusBadge";

// WebcamCanvas uses browser APIs — disable SSR entirely
const WebcamCanvas = dynamic(() => import("@/components/WebcamCanvas"), {
  ssr: false,
});

export default function DemoPage() {
  const [modelState, setModelState] = useState<"loading" | "ready" | "error">("loading");
  const [detections, setDetections] = useState<Detection[]>([]);

  useEffect(() => {
    let cancelled = false;
    let modelLoadTimer: number | null = null;
    let modelLoadIdleCallback: number | null = null;
    const idleWindow = window as Window & {
      requestIdleCallback?: (
        callback: IdleRequestCallback,
        options?: IdleRequestOptions,
      ) => number;
      cancelIdleCallback?: (handle: number) => void;
    };

    const startModelLoad = () => {
      if (cancelled) return;
      loadModels()
        .then(() => {
          if (!cancelled) setModelState("ready");
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("Model load failed:", err);
          setModelState("error");
        });
    };

    if (idleWindow.requestIdleCallback) {
      modelLoadIdleCallback = idleWindow.requestIdleCallback(startModelLoad, { timeout: 3000 });
    } else {
      modelLoadTimer = window.setTimeout(startModelLoad, 1000);
    }

    return () => {
      cancelled = true;
      if (modelLoadIdleCallback !== null && idleWindow.cancelIdleCallback) {
        idleWindow.cancelIdleCallback(modelLoadIdleCallback);
      }
      if (modelLoadTimer !== null) {
        window.clearTimeout(modelLoadTimer);
      }
    };
  }, []);

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        flexDirection: "column",
        fontFamily: "system-ui, 'Segoe UI', sans-serif",
      }}
    >
      {/* Header */}
      <header
        style={{
          background: "var(--card)",
          borderBottom: "1px solid var(--border)",
          padding: "12px 24px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <h1
            style={{
              fontSize: 20,
              fontWeight: 700,
              letterSpacing: "0.05em",
              color: "var(--accent)",
              margin: 0,
            }}
          >
            GuardAI
          </h1>
          <span style={{ color: "var(--border)" }}>|</span>
          <ModelStatusBadge state={modelState} />
        </div>
        <Link
          href="/cameras"
          style={{
            fontSize: 13,
            color: "var(--muted)",
            textDecoration: "none",
          }}
        >
          View all cameras &rarr;
        </Link>
      </header>

      {/* Main content */}
      <main
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "1fr 300px",
          gridTemplateRows: "1fr",
          gap: 16,
          padding: 16,
          minHeight: 0,
        }}
      >
        {/* Webcam area */}
        <div
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
            borderRadius: 10,
            overflow: "hidden",
            position: "relative",
            minHeight: 400,
          }}
        >
          {/* Render webcam once models are ready */}
          {modelState === "ready" ? (
            <WebcamCanvas onDetections={setDetections} />
          ) : (
            <div
              style={{
                minHeight: 400,
                height: "100%",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 12,
                padding: 24,
                color: "var(--muted)",
                textAlign: "center",
              }}
            >
              <div
                style={{
                  color: "var(--text)",
                  fontSize: 15,
                  fontWeight: 700,
                }}
              >
                Detection preview loading
              </div>
              <div style={{ maxWidth: 360, fontSize: 13, lineHeight: 1.5 }}>
                The camera monitor is available while detection models initialize.
              </div>
              <Link
                href="/cameras"
                style={{
                  borderRadius: 6,
                  border: "1px solid var(--border)",
                  background: "var(--accent)",
                  color: "#000",
                  fontSize: 13,
                  fontWeight: 700,
                  padding: "8px 12px",
                  textDecoration: "none",
                }}
              >
                View all cameras
              </Link>
            </div>
          )}
        </div>

        {/* Detection panel */}
        <DetectionPanel detections={detections} modelState={modelState} />
      </main>

      <style>{`
        @media (max-width: 900px) {
          main {
            grid-template-columns: 1fr !important;
            grid-template-rows: auto auto !important;
          }
        }
      `}</style>
    </div>
  );
}
