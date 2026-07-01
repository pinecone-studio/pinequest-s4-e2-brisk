"use client";

import { useEffect, useMemo } from "react";
import type { CameraView } from "../lib/cameraTypes";
import { pruneCameraScanStates } from "../lib/cameraScanStore";
import { subscribeToBackgroundScan } from "../lib/backgroundScanScheduler";

export default function BackgroundScanner({
  cameras,
  aiReady,
}: {
  cameras: CameraView[];
  aiReady: boolean;
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

    const unsubscribers = scanTargets.map((camera) =>
      subscribeToBackgroundScan({ camera, aiReady }),
    );

    return () => {
      unsubscribers.forEach((unsubscribe) => unsubscribe());
    };
  }, [scanTargetKey, scanTargets, aiReady]);

  return null;
}
