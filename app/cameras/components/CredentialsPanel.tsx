"use client";

import { useState } from "react";

export interface GlobalCredentials {
  username: string;
  passwords: string;
}

export default function CredentialsPanel({
  credentials,
  onChange,
  onApply,
}: {
  credentials: GlobalCredentials;
  onChange: (next: GlobalCredentials) => void;
  onApply: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        className="icon-btn"
        title="Credentials settings"
        onClick={() => setOpen((current) => !current)}
        style={{
          width: "auto",
          padding: "0 12px",
          gap: 8,
          display: "flex",
          alignItems: "center",
          fontSize: 12,
          fontWeight: 500,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        Credentials
      </button>

      {open ? (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 30,
            width: 320,
            padding: 14,
            borderRadius: 10,
            border: "1px solid var(--border)",
            background: "var(--card)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.35)",
          }}
        >
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 10 }}>
            Global credentials
          </div>
          <p style={{ fontSize: 11, color: "var(--muted)", margin: "0 0 12px", lineHeight: 1.4 }}>
            Applied to all discovered cameras. Passwords are tried in order until a stream connects.
          </p>

          <label style={{ display: "block", fontSize: 11, color: "var(--muted)", marginBottom: 4 }}>
            Username
          </label>
          <input
            value={credentials.username}
            onChange={(event) => onChange({ ...credentials, username: event.target.value })}
            placeholder="admin"
            style={{
              width: "100%",
              height: 36,
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
            Passwords (comma-separated)
          </label>
          <input
            value={credentials.passwords}
            onChange={(event) => onChange({ ...credentials, passwords: event.target.value })}
            placeholder="123456, hk123456"
            style={{
              width: "100%",
              height: 36,
              marginBottom: 12,
              padding: "0 10px",
              borderRadius: 8,
              border: "1px solid var(--border)",
              background: "var(--elevated)",
              color: "var(--text)",
              fontSize: 13,
              outline: "none",
            }}
          />

          <button
            type="button"
            onClick={() => {
              onApply();
              setOpen(false);
            }}
            style={{
              width: "100%",
              height: 36,
              border: "none",
              borderRadius: 8,
              background: "var(--brand)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Apply &amp; retry streams
          </button>
        </div>
      ) : null}
    </div>
  );
}
