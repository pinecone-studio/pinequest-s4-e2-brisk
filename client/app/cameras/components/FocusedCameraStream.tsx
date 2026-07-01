"use client";

import { useEffect, useMemo, useState } from "react";
import { buildCameraStreamUrl } from "../lib/cameraApi";
import type { CameraView } from "../lib/cameraTypes";

function cameraTitle(camera: CameraView) {
  return camera.name || camera.id;
}

export default function FocusedCameraStream({
  camera,
  className = "",
  initialPreviewUrl,
}: {
  camera: CameraView;
  className?: string;
  initialPreviewUrl?: string | null;
}) {
  const streamUrl = buildCameraStreamUrl(camera);

  const snapshotSrc = useMemo(() => {
    const params = new URLSearchParams({
      cameraId: camera.id,
      streamUrl,
    });
    return `/api/snapshot/rtsp?${params.toString()}`;
  }, [camera.id, streamUrl]);

  const mjpegSrc = useMemo(() => {
    const params = new URLSearchParams({
      cameraId: camera.id,
      streamUrl,
    });
    return `/api/stream/mjpeg?${params.toString()}`;
  }, [camera.id, streamUrl]);

  const [liveReady, setLiveReady] = useState(false);
  const previewSrc = initialPreviewUrl ?? snapshotSrc;

  useEffect(() => {
    setLiveReady(false);
  }, [camera.id, mjpegSrc]);

  return (
    <div
      className={`mb-4 overflow-hidden rounded-[12px] border border-[#f0652c] bg-black shadow-[0_0_0_3px_rgba(240,101,44,0.14)] ${className}`.trim()}
    >
      <div className="flex items-center justify-between border-b border-[#272727] bg-[#1a1a1a] px-3.5 py-2">
        <span className="text-[13px] font-semibold text-[#e8e8e8]">{cameraTitle(camera)}</span>
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-[#f0652c]">
          {liveReady ? "Live" : "Connecting"}
        </span>
      </div>
      <div className="relative aspect-video w-full bg-black">
        <img
          src={previewSrc}
          alt={cameraTitle(camera)}
          className="absolute inset-0 block h-full w-full object-cover"
        />
        <img
          key={mjpegSrc}
          src={mjpegSrc}
          alt=""
          aria-hidden="true"
          className={`absolute inset-0 block h-full w-full object-cover transition-opacity duration-300 ${
            liveReady ? "opacity-100" : "opacity-0"
          }`}
          onLoad={() => setLiveReady(true)}
        />
        {!liveReady ? (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <div
              className="h-10 w-10 rounded-full border-[3px] border-[rgba(255,255,255,0.18)] border-t-[#f0652c] animate-spin"
              aria-hidden="true"
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
