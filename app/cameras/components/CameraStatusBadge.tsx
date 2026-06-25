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
  const background = status === "online"
    ? "var(--green)"
    : status === "disabled" || status === "stream_unavailable"
      ? "var(--red)"
      : "var(--yellow)";
  const color = status === "online" || status === "unknown" || status === "loading" ? "#000" : "#fff";
  const badgeClassName = status === "online"
    ? "bg-[var(--green)] text-black"
    : status === "disabled" || status === "stream_unavailable"
      ? "bg-[var(--red)] text-white"
      : "bg-[var(--yellow)] text-black";

  return (
    <span
      className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${badgeClassName}`}
      style={{
        flexShrink: 0,
        borderRadius: 4,
        padding: "2px 6px",
        background,
        color,
        fontSize: 10,
        fontWeight: 700,
      }}
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
