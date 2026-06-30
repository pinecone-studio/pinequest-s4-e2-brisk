"use client";

import { ACTIVE_MODEL } from "@/lib/modelConfig";

interface Props {
  state: "loading" | "ready" | "error";
}

export default function ModelStatusBadge({ state }: Props) {
  const dot = {
    loading: { color: "#888", label: "Loading" },
    ready:   { color: "#22c55e", label: "Ready" },
    error:   { color: "#ef4444", label: "Error" },
  }[state];

  return (
    <div className="flex items-center gap-1.5 bg-[rgba(255,255,255,0.05)] border border-[#272727] rounded-md px-2.5 py-[3px] text-[11px] text-[#8a8a8a]">
      <span
        className="w-[7px] h-[7px] rounded-full shrink-0"
        style={{
          background: dot.color,
          boxShadow: state === "ready" ? `0 0 5px ${dot.color}` : undefined,
        }}
      />
      <span className="font-semibold tracking-[0.04em]">{ACTIVE_MODEL}</span>
      <span className="text-[#555]">&bull;</span>
      <span>{dot.label}</span>
    </div>
  );
}
