"use client";

import Link from "next/link";
import { FormEvent, useEffect, useState } from "react";

const SETTINGS_STORAGE_KEY = "aegis.settings";

interface AppSettings {
  unifiApiKey: string;
  unifiProtectHost: string;
  unifiProtectUsername: string;
  unifiProtectPassword: string;
  policeAlertContactNumber: string;
  hospitalAlertContactNumber: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  unifiApiKey: "",
  unifiProtectHost: "",
  unifiProtectUsername: "",
  unifiProtectPassword: "",
  policeAlertContactNumber: "",
  hospitalAlertContactNumber: "",
};

export default function SettingsPage() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saveConfirmation, setSaveConfirmation] = useState("");

  useEffect(() => {
    try {
      const rawSettings = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
      if (!rawSettings) return;

      setSettings({
        ...DEFAULT_SETTINGS,
        ...(JSON.parse(rawSettings) as Partial<AppSettings>),
      });
    } catch {
      setSettings(DEFAULT_SETTINGS);
    }
  }, []);

  function updateSetting(key: keyof AppSettings, value: string) {
    setSettings((current) => ({
      ...current,
      [key]: value,
    }));
    setSaveConfirmation("");
  }

  function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    setSaveConfirmation("Settings saved.");
  }

  return (
    <div className="flex h-screen p-4 bg-[#0a0a0a]">
      <div className="flex flex-1 min-w-0 overflow-hidden bg-[#141414] border border-[#1e1e1e] rounded-[18px]">
        <aside className="w-[300px] shrink-0 flex flex-col border-r border-[#1e1e1e] px-3 py-[18px] overflow-y-auto max-[1200px]:w-[240px]">
          <div className="flex items-center justify-between px-2 pb-[14px]">
            <span className="text-[15px] font-semibold text-[#e8e8e8]">Aegis</span>
          </div>
          <div className="px-1 pb-3 border-b border-[#1e1e1e]">
            <Link
              href="/"
              className="flex items-center gap-2.5 w-full px-2 py-[9px] rounded-lg text-left text-[13.5px] text-[#8a8a8a] transition-all hover:bg-[#1f1f1f] hover:text-[#e8e8e8]"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 7l-7 5 7 5zM1 5h15v14H1z" />
              </svg>
              <span>Cameras</span>
            </Link>
            <div className="flex items-center gap-2.5 w-full px-2 py-[9px] rounded-lg text-left text-[13.5px] text-[#f0652c] bg-[rgba(240,101,44,0.14)] font-semibold">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 15.5A3.5 3.5 0 1 0 12 8a3.5 3.5 0 0 0 0 7.5z" />
                <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1.1V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1.1-.4H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1.1V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9c.12.39.33.73.6 1 .3.27.7.4 1.1.4H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.6z" />
              </svg>
              <span>Settings</span>
            </div>
          </div>
        </aside>

        <main className="flex-1 min-w-0 overflow-y-auto px-[22px] py-[22px]">
          <div className="max-w-[760px]">
            <div className="mb-6">
              <h1 className="text-[22px] font-semibold text-[#e8e8e8]">Settings</h1>
            </div>

            <form onSubmit={handleSave} className="space-y-5">
              <section className="border border-[#272727] rounded-xl bg-[#1a1a1a] overflow-hidden">
                <div className="px-4 py-3 border-b border-[#272727]">
                  <h2 className="text-[14px] font-semibold text-[#e8e8e8]">UniFi</h2>
                </div>
                <div className="grid gap-4 p-4 md:grid-cols-2">
                  <label className="flex flex-col gap-2 md:col-span-2">
                    <span className="text-[12px] font-medium text-[#8a8a8a]">UniFi Site Manager API key</span>
                    <input
                      className="h-10 px-3 bg-[#141414] border border-[#272727] rounded-[10px] text-[#e8e8e8] text-[13.5px] outline-none focus:border-[#3a3a3a]"
                      type="password"
                      value={settings.unifiApiKey}
                      onChange={(event) => updateSetting("unifiApiKey", event.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="text-[12px] font-medium text-[#8a8a8a]">UniFi Protect host</span>
                    <input
                      className="h-10 px-3 bg-[#141414] border border-[#272727] rounded-[10px] text-[#e8e8e8] text-[13.5px] outline-none focus:border-[#3a3a3a]"
                      value={settings.unifiProtectHost}
                      onChange={(event) => updateSetting("unifiProtectHost", event.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="text-[12px] font-medium text-[#8a8a8a]">UniFi Protect username</span>
                    <input
                      className="h-10 px-3 bg-[#141414] border border-[#272727] rounded-[10px] text-[#e8e8e8] text-[13.5px] outline-none focus:border-[#3a3a3a]"
                      value={settings.unifiProtectUsername}
                      onChange={(event) => updateSetting("unifiProtectUsername", event.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-2 md:col-span-2">
                    <span className="text-[12px] font-medium text-[#8a8a8a]">UniFi Protect password</span>
                    <input
                      className="h-10 px-3 bg-[#141414] border border-[#272727] rounded-[10px] text-[#e8e8e8] text-[13.5px] outline-none focus:border-[#3a3a3a]"
                      type="password"
                      value={settings.unifiProtectPassword}
                      onChange={(event) => updateSetting("unifiProtectPassword", event.target.value)}
                    />
                  </label>
                </div>
              </section>

              <section className="border border-[#272727] rounded-xl bg-[#1a1a1a] overflow-hidden">
                <div className="px-4 py-3 border-b border-[#272727]">
                  <h2 className="text-[14px] font-semibold text-[#e8e8e8]">Alerts</h2>
                </div>
                <div className="grid gap-4 p-4 md:grid-cols-2">
                  <label className="flex flex-col gap-2">
                    <span className="text-[12px] font-medium text-[#8a8a8a]">Police alert contact number</span>
                    <input
                      className="h-10 px-3 bg-[#141414] border border-[#272727] rounded-[10px] text-[#e8e8e8] text-[13.5px] outline-none focus:border-[#3a3a3a]"
                      type="tel"
                      value={settings.policeAlertContactNumber}
                      onChange={(event) => updateSetting("policeAlertContactNumber", event.target.value)}
                    />
                  </label>
                  <label className="flex flex-col gap-2">
                    <span className="text-[12px] font-medium text-[#8a8a8a]">Hospital alert contact number</span>
                    <input
                      className="h-10 px-3 bg-[#141414] border border-[#272727] rounded-[10px] text-[#e8e8e8] text-[13.5px] outline-none focus:border-[#3a3a3a]"
                      type="tel"
                      value={settings.hospitalAlertContactNumber}
                      onChange={(event) => updateSetting("hospitalAlertContactNumber", event.target.value)}
                    />
                  </label>
                </div>
              </section>

              <div className="flex items-center gap-3">
                <button
                  type="submit"
                  className="h-10 px-4 rounded-[10px] border border-[#f0652c] bg-[#f0652c] text-[#141414] cursor-pointer text-[13px] font-semibold transition-all hover:bg-[#ff7a3d]"
                >
                  Save Settings
                </button>
                {saveConfirmation ? (
                  <span className="text-[13px] text-[#22c55e]" role="status">
                    {saveConfirmation}
                  </span>
                ) : null}
              </div>
            </form>
          </div>
        </main>
      </div>
    </div>
  );
}
