"use client";

import { useEffect, useState } from "react";

export interface GlobalCredentials {
  username: string;
  passwords: string;
}

interface UniFiSettings {
  unifiApiKey: string;
  unifiProtectHost: string;
  unifiProtectUsername: string;
  unifiProtectPassword: string;
}

interface UniFiSettingsResponse {
  unifi_api_key: string | null;
  unifi_protect_host: string | null;
  unifi_protect_username: string | null;
  unifi_protect_password: string | null;
}

const EMPTY_UNIFI_SETTINGS: UniFiSettings = {
  unifiApiKey: "",
  unifiProtectHost: "",
  unifiProtectUsername: "",
  unifiProtectPassword: "",
};

function emptyToNull(value: string): string | null {
  const trimmedValue = value.trim();
  return trimmedValue ? trimmedValue : null;
}

function unifiSettingsPayload(settings: UniFiSettings): UniFiSettingsResponse {
  return {
    unifi_api_key: emptyToNull(settings.unifiApiKey),
    unifi_protect_host: emptyToNull(settings.unifiProtectHost),
    unifi_protect_username: emptyToNull(settings.unifiProtectUsername),
    unifi_protect_password: emptyToNull(settings.unifiProtectPassword),
  };
}

export default function CredentialsPanel({
  credentials,
  onChange,
  onApply,
  onUniFiSaved,
}: {
  credentials: GlobalCredentials;
  onChange: (next: GlobalCredentials) => void;
  onApply: () => void;
  onUniFiSaved?: () => void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<"global" | "unifi">("global");
  const [unifiSettings, setUniFiSettings] = useState<UniFiSettings>(EMPTY_UNIFI_SETTINGS);
  const [unifiStatus, setUniFiStatus] = useState<"" | "saving" | "saved" | "error">("");

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    async function loadUniFiSettings() {
      try {
        const response = await fetch("/api/cameras/settings", { cache: "no-store" });
        if (!response.ok) return;

        const data = (await response.json()) as Partial<UniFiSettingsResponse>;
        if (cancelled) return;

        setUniFiSettings((current) => ({
          ...current,
          unifiApiKey: data.unifi_api_key ?? current.unifiApiKey,
          unifiProtectHost: data.unifi_protect_host ?? current.unifiProtectHost,
          unifiProtectUsername: data.unifi_protect_username ?? current.unifiProtectUsername,
          unifiProtectPassword:
            data.unifi_protect_password &&
            data.unifi_protect_password !== "***" &&
            !current.unifiProtectPassword
              ? data.unifi_protect_password
              : current.unifiProtectPassword,
        }));
      } catch {
        // Keep the modal usable when the backend settings endpoint is unavailable.
      }
    }

    void loadUniFiSettings();

    return () => {
      cancelled = true;
    };
  }, [open]);

  function updateUniFiSetting(key: keyof UniFiSettings, value: string) {
    setUniFiSettings((current) => ({
      ...current,
      [key]: value,
    }));
    setUniFiStatus("");
  }

  async function saveUniFiSettings() {
    setUniFiStatus("saving");

    try {
      const response = await fetch("/api/cameras/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(unifiSettingsPayload(unifiSettings)),
      });

      if (!response.ok) {
        throw new Error(`Settings API returned ${response.status}`);
      }

      await fetch("/api/cameras/unifi/streams", { cache: "no-store" });
      setUniFiStatus("saved");
      await onUniFiSaved?.();
    } catch {
      setUniFiStatus("error");
    }
  }

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
          <div className="flex gap-1 p-1 mb-3 rounded-lg border border-[#272727] bg-[#141414]">
            <button
              type="button"
              onClick={() => setActiveTab("global")}
              className={`flex-1 h-8 rounded-md text-[12px] font-semibold cursor-pointer ${
                activeTab === "global"
                  ? "bg-[#1f1f1f] text-[#e8e8e8]"
                  : "bg-transparent text-[#8a8a8a] hover:text-[#e8e8e8]"
              }`}
            >
              Global credentials
            </button>
            <button
              type="button"
              onClick={() => setActiveTab("unifi")}
              className={`flex-1 h-8 rounded-md text-[12px] font-semibold cursor-pointer ${
                activeTab === "unifi"
                  ? "bg-[#1f1f1f] text-[#e8e8e8]"
                  : "bg-transparent text-[#8a8a8a] hover:text-[#e8e8e8]"
              }`}
            >
              UniFi Protect
            </button>
          </div>

          {activeTab === "global" ? (
            <>
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
            </>
          ) : (
            <>
              <div className="text-[13px] font-semibold text-[#e8e8e8] mb-2.5">
                UniFi Protect
              </div>
              <p className="text-[11px] text-[#8a8a8a] mb-3 leading-[1.4]">
                Used to resolve UniFi Protect RTSP streams from the local controller.
              </p>

              <label className="block text-[11px] text-[#8a8a8a] mb-1">
                UniFi API key
              </label>
              <input
                value={unifiSettings.unifiApiKey}
                onChange={(event) => updateUniFiSetting("unifiApiKey", event.target.value)}
                className="w-full h-9 mb-2.5 px-2.5 rounded-lg border border-[#272727] bg-[#1f1f1f] text-[#e8e8e8] text-[13px] outline-none"
              />

              <label className="block text-[11px] text-[#8a8a8a] mb-1">
                Protect host
              </label>
              <input
                value={unifiSettings.unifiProtectHost}
                onChange={(event) => updateUniFiSetting("unifiProtectHost", event.target.value)}
                placeholder="192.168.1.1"
                className="w-full h-9 mb-2.5 px-2.5 rounded-lg border border-[#272727] bg-[#1f1f1f] text-[#e8e8e8] text-[13px] outline-none"
              />

              <label className="block text-[11px] text-[#8a8a8a] mb-1">
                Protect username
              </label>
              <input
                value={unifiSettings.unifiProtectUsername}
                onChange={(event) => updateUniFiSetting("unifiProtectUsername", event.target.value)}
                className="w-full h-9 mb-2.5 px-2.5 rounded-lg border border-[#272727] bg-[#1f1f1f] text-[#e8e8e8] text-[13px] outline-none"
              />

              <label className="block text-[11px] text-[#8a8a8a] mb-1">
                Protect password
              </label>
              <input
                type="password"
                value={unifiSettings.unifiProtectPassword}
                onChange={(event) => updateUniFiSetting("unifiProtectPassword", event.target.value)}
                className="w-full h-9 mb-3 px-2.5 rounded-lg border border-[#272727] bg-[#1f1f1f] text-[#e8e8e8] text-[13px] outline-none"
              />

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void saveUniFiSettings()}
                  disabled={unifiStatus === "saving"}
                  className="flex-1 h-9 border-none rounded-lg bg-[#f0652c] text-white text-[13px] font-semibold cursor-pointer disabled:opacity-[0.65] disabled:cursor-not-allowed"
                >
                  Save UniFi settings
                </button>
                {unifiStatus ? (
                  <span className={`text-[11px] ${unifiStatus === "error" ? "text-[#ef4444]" : "text-[#8a8a8a]"}`} role="status">
                    {unifiStatus === "saving"
                      ? "Saving…"
                      : unifiStatus === "saved"
                        ? "Saved"
                        : "Couldn't reach backend"}
                  </span>
                ) : null}
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
