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
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,0.55)",
        padding: 16,
      }}
    >
      <div
        onClick={(event) => event.stopPropagation()}
        style={{
          width: "100%",
          maxWidth: 380,
          borderRadius: 12,
          border: "1px solid var(--border)",
          background: "var(--card)",
          padding: 18,
        }}
      >
        <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
          Camera credentials
        </div>
        <div style={{ fontSize: 12, color: "var(--muted)", marginBottom: 14 }}>
          {camera.name ?? camera.id}
          {camera.host ? ` · ${camera.host}` : ""}
        </div>

        <label style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
          Username
        </label>
        <input
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoFocus
          style={{
            width: "100%",
            height: 38,
            marginBottom: 10,
            padding: "0 10px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--elevated)",
            color: "var(--text)",
            fontSize: 13,
            outline: "none",
          }}
        />

        <label style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
          Password
        </label>
        <input
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          type="password"
          style={{
            width: "100%",
            height: 38,
            marginBottom: 16,
            padding: "0 10px",
            borderRadius: 8,
            border: "1px solid var(--border)",
            background: "var(--elevated)",
            color: "var(--text)",
            fontSize: 13,
            outline: "none",
          }}
        />

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              height: 36,
              padding: "0 14px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "transparent",
              color: "var(--muted)",
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSave({ username, password })}
            style={{
              height: 36,
              padding: "0 14px",
              borderRadius: 8,
              border: "none",
              background: "var(--brand)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
