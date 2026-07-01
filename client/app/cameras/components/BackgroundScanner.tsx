"use client";

import { useEffect, useMemo } from "react";
import type { EvidenceEvent } from "@/lib/evidence";
import type { CameraView } from "../lib/cameraTypes";
import { pruneCameraScanStates } from "../lib/cameraScanStore";
import { subscribeToBackgroundScan } from "../lib/backgroundScanScheduler";

export default function BackgroundScanner({
  cameras,
  aiReady,
  onEvent,
}: {
  cameras: CameraView[];
  aiReady: boolean;
  onEvent?: (event: EvidenceEvent) => void;
}) {
  const scanTargets = useMemo(
    () => cameras.filter((camera) => camera.enabled !== false && Boolean(camera.stream_url)),
    [cameras],
  );

  const scanTargetKey = useMemo(
    () => scanTargets.map((camera) => `${camera.id}:${camera.stream_url}`).join("|"),
    [scanTargets],
  );

  useEffect(() => {
    const activeIds = new Set(scanTargets.map((camera) => camera.id));
    pruneCameraScanStates(activeIds);

    const unsubscribers = scanTargets.map((camera, index) =>
      subscribeToBackgroundScan({
        camera,
        aiReady,
        onEvent,
        sourceLabel: camera.name || `CCTV ${String(index + 1).padStart(2, "0")}`,
      }),
    );

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [scanTargetKey, scanTargets, aiReady, onEvent]);

  return null;
}
