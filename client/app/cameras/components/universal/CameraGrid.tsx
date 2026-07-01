"use client";

import { useMemo } from "react";
import { gridColumns } from "../../lib/universalCameraApi";
import type { UniversalCamera } from "../../lib/universalCameraTypes";
import CameraTile from "./CameraTile";

export default function CameraGrid({ cameras }: { cameras: UniversalCamera[] }) {
  const columns = useMemo(() => gridColumns(cameras.length), [cameras.length]);

  if (cameras.length === 0) {
    return (
      <div className="flex min-h-[280px] items-center justify-center rounded-xl border border-dashed border-zinc-700 bg-zinc-900/60 text-sm text-zinc-400">
        No cameras discovered on the local network
      </div>
    );
  }

  return (
    <div
      className="grid gap-4"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {cameras.map((camera) => (
        <CameraTile key={camera.id} camera={camera} />
      ))}
    </div>
  );
}
