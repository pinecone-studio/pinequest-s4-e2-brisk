"use client";

import { useState } from "react";
import type { CameraView } from "../lib/cameraTypes";

export interface CameraCredentials {
  username: string;
  password: string;
}

export default function CameraCredentialsModal({
  camera,
  initialCredentials,
  onClose,
  onSave,
}: {
  camera: CameraView;
  initialCredentials: CameraCredentials;
  onClose: () => void;
  onSave: (credentials: CameraCredentials) => void;
}) {
  const [username, setUsername] = useState(initialCredentials.username);
  const [password, setPassword] = useState(initialCredentials.password);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Credentials for ${camera.name ?? camera.id}`}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-[rgba(0,0,0,0.55)] p-4"
    >
      <div
        onClick={(event) => event.stopPropagation()}
        className="w-full max-w-[380px] rounded-xl border border-[#272727] bg-[#1a1a1a] p-[18px]"
      >
        <div className="text-[15px] font-semibold text-[#e8e8e8] mb-1">
          Camera credentials
        </div>
        <div className="text-[12px] text-[#8a8a8a] mb-3.5">
          {camera.name ?? camera.id}
          {camera.host ? ` · ${camera.host}` : ""}
        </div>

        <label className="block text-[11px] text-[#8a8a8a] mb-1">
          Username
        </label>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoFocus
          className="w-full h-[38px] mb-2.5 px-2.5 rounded-lg border border-[#272727] bg-[#1f1f1f] text-[#e8e8e8] text-[13px] outline-none"
        />

        <label className="block text-[11px] text-[#8a8a8a] mb-1">
          Password
        </label>
        <input
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          className="w-full h-[38px] mb-4 px-2.5 rounded-lg border border-[#272727] bg-[#1f1f1f] text-[#e8e8e8] text-[13px] outline-none"
        />

        <div className="flex gap-2 justify-end">
          <button
            type="button"
            onClick={onClose}
            className="h-9 px-3.5 rounded-lg border border-[#272727] bg-transparent text-[#8a8a8a] text-[13px] cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave({ username, password })}
            className="h-9 px-3.5 rounded-lg border-none bg-[#f0652c] text-white text-[13px] font-semibold cursor-pointer"
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
