import type { CameraView } from "../lib/cameraTypes";

type CameraDisplayStatus = "online" | "unknown" | "loading" | "stream_unavailable" | "disabled";

export default function CameraStatusBadge({
  camera,
  displayStatus,
}: {
  camera: CameraView;
  displayStatus?: CameraDisplayStatus;
}) {
  const disabled = camera.status === "disabled" || camera.enabled === false;
  const status: CameraDisplayStatus = disabled
    ? "disabled"
    : displayStatus ?? (camera.online ? "online" : "unknown");
  const badgeClassName = status === "online"
    ? "bg-[#22c55e] text-black"
    : status === "disabled" || status === "stream_unavailable"
      ? "bg-[#ef4444] text-white"
      : "bg-[#eab308] text-black";

  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${badgeClassName}`}
    >
      {status === "online"
        ? "ONLINE"
        : status === "stream_unavailable"
          ? "STREAM UNAVAILABLE"
          : status === "disabled"
            ? "OFFLINE"
            : status === "loading"
              ? "LOADING"
              : "UNKNOWN"}
    </span>
  );
}
