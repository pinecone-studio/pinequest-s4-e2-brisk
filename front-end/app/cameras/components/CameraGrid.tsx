"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import CameraCard from "./CameraCard";
import CameraExpandDialog from "./CameraExpandDialog";
import type { CameraView } from "../lib/cameraTypes";
import type { EvidenceEvent } from "@/lib/evidence";

// How many visible cameras may run Gemini AI at once. Tuned for the paid key +
// GEMINI_MAX_CONCURRENT so a full 4x4 wall can be analyzed in parallel; lower it
// to cut cost, or set it below the wall size to prioritise the selected camera.
const MAX_AI_CAMERAS = 16;
const CAMERA_RENDER_CHUNK_SIZE = 8;
const MAX_RENDERED_CAMERAS = 50;

export type StreamLoadState = "not_started" | "loading" | "online" | "stream_unavailable";

function cameraLabel(camera: CameraView, index: number): string {
  return camera.name || `CCTV ${String(index + 1).padStart(2, "0")}`;
}

export default function CameraGrid({
  cameras,
  columns = 2,
  selectedId,
  clock,
  onSelect,
  onStreamFailed,
  onCredentialsRequest,
  aiReady = false,
  onEvent,
}: {
  cameras: CameraView[];
  columns?: number;
  selectedId?: string | null;
  clock?: string;
  onSelect?: (id: string | null) => void;
  onStreamFailed?: (cameraId: string) => void;
  onCredentialsRequest?: (cameraId: string) => void;
  aiReady?: boolean;
  onEvent?: (event: EvidenceEvent) => void;
}) {
  const [renderCount, setRenderCount] = useState(CAMERA_RENDER_CHUNK_SIZE);
  const [expandedCameraId, setExpandedCameraId] = useState<string | null>(null);
  const [expandedPreviewUrl, setExpandedPreviewUrl] = useState<string | null>(null);
  const snapshotPreviewRef = useRef<Record<string, string>>({});
  const cappedCameras = useMemo(
    () => cameras.slice(0, MAX_RENDERED_CAMERAS),
    [cameras],
  );
  const cameraIdsKey = useMemo(
    () => cappedCameras.map((camera) => camera.id).join("|"),
    [cappedCameras],
  );
  const renderCameras = useMemo(
    () => cappedCameras.slice(0, renderCount),
    [cappedCameras, renderCount],
  );
  const loadableCameraIds = useMemo(
    () => renderCameras.filter((camera) => camera.enabled !== false).map((camera) => camera.id),
    [renderCameras],
  );
  const loadableCameraIdsKey = useMemo(
    () => loadableCameraIds.join("|"),
    [loadableCameraIds],
  );
  const [streamStates, setStreamStates] = useState<Record<string, StreamLoadState>>({});
  const streamUrlRef = useRef<Record<string, string>>({});

  useEffect(() => {
    setRenderCount(Math.min(CAMERA_RENDER_CHUNK_SIZE, cappedCameras.length));
  }, [cameraIdsKey, cappedCameras.length]);

  useEffect(() => {
    if (renderCount >= cappedCameras.length) return;

    const timeout = window.setTimeout(() => {
      setRenderCount((current) => Math.min(current + CAMERA_RENDER_CHUNK_SIZE, cappedCameras.length));
    }, 0);

    return () => {
      window.clearTimeout(timeout);
    };
  }, [renderCount, cappedCameras.length]);

  useEffect(() => {
    if (loadableCameraIds.length === 0) {
      setStreamStates({});
      return;
    }

    setStreamStates((current) => {
      const next: Record<string, StreamLoadState> = {};
      let changed = false;

      for (const cameraId of loadableCameraIds) {
        next[cameraId] = current[cameraId] ?? "not_started";
        if (next[cameraId] !== current[cameraId]) {
          changed = true;
        }
      }
      if (Object.keys(current).length !== loadableCameraIds.length) {
        changed = true;
      }

      return changed ? next : current;
    });
  }, [loadableCameraIdsKey]);

  useEffect(() => {
    setStreamStates((current) => {
      const next = { ...current };
      let changed = false;

      for (const camera of renderCameras) {
        if (camera.enabled === false) continue;

        const nextUrl = camera.stream_url ?? "";
        const previousUrl = streamUrlRef.current[camera.id];
        if (previousUrl === nextUrl) continue;

        streamUrlRef.current[camera.id] = nextUrl;
        next[camera.id] = "not_started";
        changed = true;
      }

      return changed ? next : current;
    });
  }, [renderCameras]);

  useEffect(() => {
    if (loadableCameraIds.length === 0) return;

    setStreamStates((current) => {
      const next = { ...current };
      let changed = false;

      for (const cameraId of loadableCameraIds) {
        if ((next[cameraId] ?? "not_started") !== "not_started") continue;

        next[cameraId] = "loading";
        changed = true;
      }

      return changed ? next : current;
    });
  }, [loadableCameraIdsKey]);

  const aiCameraIds = useMemo(() => {
    const online = renderCameras.filter((c) => c.enabled !== false).map((c) => c.id);
    const ids = new Set<string>();
    if (selectedId && online.includes(selectedId)) {
      ids.add(selectedId);
    }
    for (const id of online) {
      if (ids.size >= MAX_AI_CAMERAS) break;
      ids.add(id);
    }
    return ids;
  }, [renderCameras, selectedId]);

  const expandedCamera = useMemo(
    () =>
      expandedCameraId
        ? cameras.find((camera) => camera.id === expandedCameraId) ?? null
        : null,
    [cameras, expandedCameraId],
  );

  const handleExpandCamera = (cameraId: string) => {
    setExpandedCameraId(cameraId);
    setExpandedPreviewUrl(snapshotPreviewRef.current[cameraId] ?? null);
    onSelect?.(cameraId);
  };

  const handleCloseExpanded = () => {
    setExpandedCameraId(null);
    setExpandedPreviewUrl(null);
    onSelect?.(null);
  };

  const handleSnapshotPreview = (cameraId: string, previewUrl: string | null) => {
    if (previewUrl) {
      snapshotPreviewRef.current[cameraId] = previewUrl;
      if (expandedCameraId === cameraId) {
        setExpandedPreviewUrl(previewUrl);
      }
      return;
    }
    delete snapshotPreviewRef.current[cameraId];
  };

  const gridPaused = expandedCamera !== null;

  if (cappedCameras.length === 0) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-[10px] border border-[#272727] bg-[#1a1a1a] text-[#8a8a8a] text-[13px]">
        No cameras configured
      </div>
    );
  }

  return (
    <>
      {expandedCamera ? (
        <CameraExpandDialog
          camera={expandedCamera}
          initialPreviewUrl={expandedPreviewUrl}
          onClose={handleCloseExpanded}
        />
      ) : null}
      {cameras.length > MAX_RENDERED_CAMERAS ? (
        <div className="mb-3 rounded-[10px] border border-[#272727] bg-[#1a1a1a] px-3 py-2 text-[12px] text-[#8a8a8a]">
          Showing first {MAX_RENDERED_CAMERAS} of {cameras.length} cameras.
        </div>
      ) : null}
      <div
        className="grid gap-2.5"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
      >
        {renderCameras.map((camera, index) => (
          <CameraCard
            key={camera.id}
            camera={camera}
            label={cameraLabel(camera, index)}
            selected={selectedId === camera.id || expandedCameraId === camera.id}
            clock={clock}
            liveStream={selectedId === camera.id}
            onSelect={onSelect ? () => handleExpandCamera(camera.id) : undefined}
            streamState={streamStates[camera.id] ?? "not_started"}
            onStreamSettled={(state) => {
              setStreamStates((current) => {
                if (current[camera.id] === state) return current;
                return { ...current, [camera.id]: state };
              });
              if (state === "stream_unavailable") {
                onStreamFailed?.(camera.id);
              }
            }}
            onCredentialsRequest={
              onCredentialsRequest ? () => onCredentialsRequest(camera.id) : undefined
            }
            aiReady={aiReady}
            aiActive={aiCameraIds.has(camera.id) && !gridPaused}
            gridPaused={gridPaused}
            onSnapshotPreview={(previewUrl) => handleSnapshotPreview(camera.id, previewUrl)}
            onEvent={onEvent}
          />
        ))}
      </div>
    </>
  );
}
