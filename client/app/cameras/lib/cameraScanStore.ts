"use client";

import { useSyncExternalStore } from "react";

export type CameraScanStatus = "idle" | "loading" | "online" | "unavailable";

export interface CameraScanState {
  status: CameraScanStatus;
  snapshotUrl: string | null;
  analyzing: boolean;
  hasPerson: boolean;
  yoloImage: string | null;
  lastScanAt: number | null;
}

const DEFAULT_STATE: CameraScanState = {
  status: "idle",
  snapshotUrl: null,
  analyzing: false,
  hasPerson: false,
  yoloImage: null,
  lastScanAt: null,
};

const states = new Map<string, CameraScanState>();
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function getCameraScanState(cameraId: string): CameraScanState {
  return states.get(cameraId) ?? DEFAULT_STATE;
}

export function patchCameraScanState(cameraId: string, partial: Partial<CameraScanState>): void {
  const current = states.get(cameraId) ?? { ...DEFAULT_STATE };
  states.set(cameraId, { ...current, ...partial });
  emit();
}

export function clearCameraScanState(cameraId: string): void {
  if (!states.delete(cameraId)) return;
  emit();
}

export function pruneCameraScanStates(activeCameraIds: Set<string>): void {
  let changed = false;
  for (const cameraId of states.keys()) {
    if (!activeCameraIds.has(cameraId)) {
      states.delete(cameraId);
      changed = true;
    }
  }
  if (changed) emit();
}

export function subscribeCameraScanStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCameraScan(cameraId: string): CameraScanState {
  return useSyncExternalStore(
    subscribeCameraScanStore,
    () => getCameraScanState(cameraId),
    () => DEFAULT_STATE,
  );
}
