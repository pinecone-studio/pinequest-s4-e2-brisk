export interface CameraSettings {
  unifi_api_key: string | null;
  unifi_protect_host: string | null;
  unifi_protect_username: string | null;
  unifi_protect_password: string | null;
}

export type CameraSettingsKey = keyof CameraSettings;

const runtimeSettings: Partial<Record<CameraSettingsKey, string | null>> = {};

function normalizeOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

export function maskRuntimeSettings(
  settings: Partial<Record<CameraSettingsKey, string | null>>,
): CameraSettings {
  const password = settings.unifi_protect_password;
  return {
    unifi_api_key: settings.unifi_api_key ?? null,
    unifi_protect_host: settings.unifi_protect_host ?? null,
    unifi_protect_username: settings.unifi_protect_username ?? null,
    unifi_protect_password:
      password && password.length > 0 ? "***" : "",
  };
}

export function getMaskedRuntimeSettings(): CameraSettings {
  return maskRuntimeSettings(runtimeSettings);
}

export function updateRuntimeSettings(
  partial: Partial<CameraSettings>,
): CameraSettings {
  for (const key of Object.keys(partial) as CameraSettingsKey[]) {
    if (!Object.prototype.hasOwnProperty.call(partial, key)) continue;

    if (key === "unifi_protect_password") {
      const incoming = partial.unifi_protect_password;
      if (incoming === "***") continue;
      if (incoming === null && runtimeSettings.unifi_protect_password) continue;
    }

    runtimeSettings[key] = normalizeOptionalString(partial[key]);
  }
  return getMaskedRuntimeSettings();
}

export function getRawRuntimeSetting(name: CameraSettingsKey): string | null {
  const value = runtimeSettings[name];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

export function getEffectiveUniFiCredentials(): {
  apiKey: string | null;
  protectHost: string | null;
} {
  return {
    apiKey: getRawRuntimeSetting("unifi_api_key") ?? process.env.UNIFI_API_KEY?.trim() ?? null,
    protectHost:
      getRawRuntimeSetting("unifi_protect_host") ?? process.env.UNIFI_PROTECT_HOST?.trim() ?? null,
  };
}
