"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { AccountCameraConfig } from "../cameras/lib/applyCameraCredentials";
import { saveAccountSession } from "../cameras/lib/applyCameraCredentials";

const SESSION_COOKIE = "guardai_session";
const CONTINUED_AS_KEY = "guardai-continued-as";

interface LastUsedResponse {
  account: { id: string; name: string };
  cameraConfigs: AccountCameraConfig[];
  error?: string;
}

function setSessionCookie() {
  if (typeof document === "undefined") return;
  document.cookie = `${SESSION_COOKIE}=1; path=/; max-age=${60 * 60 * 24 * 30}; SameSite=Lax`;
}

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSkipping, setIsSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleManualSubmit(event: FormEvent) {
    event.preventDefault();
    setError("Manual login isn't wired up for this demo — use Skip Login below.");
  }

  async function handleSkipLogin() {
    setIsSkipping(true);
    setError(null);

    try {
      const response = await fetch("/api/session/last-used", { cache: "no-store" });
      const data = (await response.json()) as LastUsedResponse;
      if (!response.ok) {
        throw new Error(data.error ?? `Request failed with status ${response.status}`);
      }

      saveAccountSession({
        accountId: data.account.id,
        accountName: data.account.name,
        cameraConfigs: data.cameraConfigs,
      });
      setSessionCookie();
      if (typeof window !== "undefined") {
        window.sessionStorage.setItem(CONTINUED_AS_KEY, data.account.name);
      }

      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to skip login");
      setIsSkipping(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] p-4">
      <div className="w-full max-w-[380px] rounded-[18px] border border-[#1e1e1e] bg-[#141414] p-7">
        <div className="mb-6 text-center">
          <div className="text-[19px] font-semibold text-[#e8e8e8]">Aegis</div>
          <div className="mt-1 text-[13px] text-[#8a8a8a]">Sign in to your CCTV dashboard</div>
        </div>

        <form onSubmit={handleManualSubmit}>
          <label className="mb-1 block text-[11px] text-[#8a8a8a]">Email</label>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="you@example.com"
            className="mb-3 h-10 w-full rounded-lg border border-[#272727] bg-[#1a1a1a] px-3 text-[13px] text-[#e8e8e8] outline-none focus:border-[#3a3a3a]"
          />

          <label className="mb-1 block text-[11px] text-[#8a8a8a]">Password</label>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="••••••••"
            className="mb-4 h-10 w-full rounded-lg border border-[#272727] bg-[#1a1a1a] px-3 text-[13px] text-[#e8e8e8] outline-none focus:border-[#3a3a3a]"
          />

          <button
            type="submit"
            className="h-10 w-full rounded-lg border-none bg-[#f0652c] text-[13px] font-semibold text-white cursor-pointer"
          >
            Sign in
          </button>
        </form>

        <div className="my-5 flex items-center gap-3">
          <div className="h-px flex-1 bg-[#272727]" />
          <span className="text-[11px] text-[#5c5c5c]">or</span>
          <div className="h-px flex-1 bg-[#272727]" />
        </div>

        <button
          type="button"
          onClick={() => void handleSkipLogin()}
          disabled={isSkipping}
          className="h-10 w-full rounded-lg border border-[#f0652c] bg-transparent text-[13px] font-semibold text-[#f0652c] cursor-pointer transition-colors hover:bg-[rgba(240,101,44,0.1)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSkipping ? "Continuing…" : "Skip Login (Demo)"}
        </button>
        <p className="mt-2 text-center text-[11px] text-[#5c5c5c]">
          Instantly continues as your most recently active account and restores its camera setup.
        </p>

        {error ? (
          <div className="mt-4 rounded-lg border border-[#ef4444] bg-[rgba(239,68,68,0.08)] px-3 py-2 text-[12px] text-[#ef4444]">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
