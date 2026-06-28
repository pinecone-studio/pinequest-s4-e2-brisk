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
    <div className="relative">
      <button
        type="button"
        className="h-10 px-3 rounded-[10px] border border-[#272727] bg-[#1a1a1a] text-[#8a8a8a] cursor-pointer flex items-center gap-2 text-[12px] font-medium hover:text-[#e8e8e8]"
        title="Credentials settings"
        onClick={() => setOpen((current) => !current)}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        Credentials
      </button>

      {open ? (
        <div className="absolute top-[calc(100%+8px)] right-0 z-30 w-80 p-3.5 rounded-[10px] border border-[#272727] bg-[#1a1a1a] shadow-[0_12px_32px_rgba(0,0,0,0.35)]">
          <div className="text-[13px] font-semibold text-[#e8e8e8] mb-2.5">
            Global credentials
          </div>
          <p className="text-[11px] text-[#8a8a8a] mb-3 leading-[1.4]">
            Applied to all discovered cameras. Passwords are tried in order until a stream connects.
          </p>

          <label className="block text-[11px] text-[#8a8a8a] mb-1">
            Username
          </label>
          <input
            value={credentials.username}
            onChange={(event) => onChange({ ...credentials, username: event.target.value })}
            placeholder="admin"
            className="w-full h-9 mb-2.5 px-2.5 rounded-lg border border-[#272727] bg-[#1f1f1f] text-[#e8e8e8] text-[13px] outline-none"
          />

          <label className="block text-[11px] text-[#8a8a8a] mb-1">
            Passwords (comma-separated)
          </label>
          <input
            value={credentials.passwords}
            onChange={(event) => onChange({ ...credentials, passwords: event.target.value })}
            placeholder="123456, hk123456"
            className="w-full h-9 mb-3 px-2.5 rounded-lg border border-[#272727] bg-[#1f1f1f] text-[#e8e8e8] text-[13px] outline-none"
          />

          <button
            type="button"
            onClick={() => {
              onApply();
              setOpen(false);
            }}
            className="w-full h-9 border-none rounded-lg bg-[#f0652c] text-white text-[13px] font-semibold cursor-pointer"
          >
            Apply &amp; retry streams
          </button>
        </div>
      ) : null}
    </div>
  );
}
