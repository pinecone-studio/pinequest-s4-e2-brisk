"use client";

import { useEffect } from "react";
import FocusCameraHero from "./FocusCameraHero";
import type { CameraView } from "../lib/cameraTypes";
import type { EvidenceEvent } from "@/lib/evidence";

function cameraTitle(camera: CameraView) {
  return camera.name || camera.id;
}

export default function CameraExpandDialog({
  camera,
  initialPreviewUrl: _initialPreviewUrl,
  onClose,
  aiReady = false,
  onEvent,
  label,
}: {
  camera: CameraView;
  initialPreviewUrl?: string | null;
  onClose: () => void;
  aiReady?: boolean;
  onEvent?: (event: EvidenceEvent) => void;
  label?: string;
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-label={`${cameraTitle(camera)} live view`}
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/75 backdrop-blur-[2px] border-none cursor-default"
        aria-label="Close camera view"
        onClick={onClose}
      />
      <div
        className="relative z-10 w-full max-w-[min(96vw,1200px)]"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-20 flex h-9 w-9 items-center justify-center rounded-full border border-[#3a3a3a] bg-[rgba(0,0,0,0.65)] text-[#e8e8e8] cursor-pointer transition-colors hover:border-[#f0652c] hover:text-[#f0652c]"
          aria-label="Close"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>
        <FocusCameraHero
          camera={camera}
          label={label ?? cameraTitle(camera)}
          aiReady={aiReady}
          onEvent={onEvent}
        />
      </div>
    </div>
  );
}
