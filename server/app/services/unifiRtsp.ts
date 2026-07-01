import https from "node:https";

const DEFAULT_CACHE_TTL_SECONDS = 30;
const DEFAULT_TIMEOUT_MS = 10_000;
const LEGACY_RTSP_PORT = 7447;
const SECURE_RTSP_PORT = 7441;

export class UniFiRtspAuthError extends Error {
  constructor(message = "invalid_or_expired_api_key") {
    super(message);
    this.name = "UniFiRtspAuthError";
  }
}

export class UniFiRtspPermissionError extends Error {
  constructor(message = "insufficient_permission_scope") {
    super(message);
    this.name = "UniFiRtspPermissionError";
  }
}

export type StreamQuality = "high" | "medium" | "low";

export interface CameraStream {
  quality: StreamQuality;
  url: string;
  enabled: boolean;
}

export interface CameraStreams {
  camera_id: string;
  name: string;
  model: string;
  online: boolean;
  source: "unifi";
  streams: CameraStream[];
  error?: string | null;
  host?: string | null;
}

interface ProtectCapabilities {
  scheme: "rtsp" | "rtsps";
  port: number;
  version: string;
}

type JsonRecord = Record<string, unknown>;

const cache = new Map<string, { expiresAt: number; cameras: CameraStreams[] }>();

function resolveVerifyTls(): boolean {
  const value = process.env.UNIFI_PROTECT_VERIFY_TLS;
  if (value === undefined) return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function resolveCacheTtlSeconds(): number {
  const value = process.env.UNIFI_RTSP_CACHE_TTL_SECONDS;
  if (value && /^\d+$/.test(value)) {
    return Number(value);
  }
  return DEFAULT_CACHE_TTL_SECONDS;
}

function cleanHost(host: string): string {
  let cleaned = host.trim().replace(/\/+$/, "");
  if (cleaned.startsWith("https://")) cleaned = cleaned.slice("https://".length);
  if (cleaned.startsWith("http://")) cleaned = cleaned.slice("http://".length);
  return cleaned;
}

function firstString(entry: JsonRecord, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstBool(entry: JsonRecord, ...keys: string[]): boolean | null {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "boolean") return value;
  }
  return null;
}

function firstInt(entry: JsonRecord, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = entry[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  }
  return null;
}

function firstDict(entry: JsonRecord, ...keys: string[]): JsonRecord | null {
  for (const key of keys) {
    const value = entry[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as JsonRecord;
    }
  }
  return null;
}

function extractList(payload: unknown, ...keys: string[]): JsonRecord[] {
  if (Array.isArray(payload)) {
    return payload.filter((entry): entry is JsonRecord => !!entry && typeof entry === "object");
  }
  if (!payload || typeof payload !== "object") return [];
  const record = payload as JsonRecord;
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is JsonRecord => !!entry && typeof entry === "object");
    }
  }
  return [];
}

class UniFiProtectRtspClient {
  private readonly apiKey: string;
  private readonly protectHost: string;
  private readonly baseUrl: string;
  private readonly agent: https.Agent;

  constructor(apiKey: string, protectHost: string, verifyTls: boolean) {
    this.apiKey = apiKey;
    this.protectHost = cleanHost(protectHost);
    this.baseUrl = `https://${this.protectHost}/proxy/protect/integration/v1`;
    this.agent = new https.Agent({ rejectUnauthorized: verifyTls });
  }

  async resolveCameraStreams(): Promise<CameraStreams[]> {
    const capabilities = await this.fetchCapabilities();
    const cameras = await this.fetchCameras();
    const resolved: CameraStreams[] = [];

    for (const camera of cameras) {
      try {
        resolved.push(await this.resolveCamera(camera, capabilities));
      } catch (error) {
        const cameraId = this.cameraId(camera) ?? "";
        resolved.push({
          camera_id: cameraId,
          name: this.cameraName(camera),
          model: this.cameraModel(camera),
          online: this.cameraOnline(camera),
          source: "unifi",
          streams: [],
          error: error instanceof Error ? error.message : "camera_resolution_failed",
          host: this.cameraHost(camera),
        });
      }
    }

    return resolved;
  }

  private async fetchCapabilities(): Promise<ProtectCapabilities> {
    const payload = await this.getJson(`${this.baseUrl}/bootstrap`);
    const controller =
      firstDict(payload as JsonRecord, "nvr", "systemInfo", "settings") ?? (payload as JsonRecord);
    const version =
      firstString(controller, "version", "firmwareVersion", "nvrVersion") ?? "";

    const rtspSettings =
      firstDict(controller, "rtsp", "rtspSettings", "streaming") ?? controller;
    const secureEnabled = firstBool(
      rtspSettings,
      "isRtspsEnabled",
      "rtspsEnabled",
      "isSrtpEnabled",
      "srtpEnabled",
    );
    const rtspPort = firstInt(rtspSettings, "rtspPort", "rtsp_port") ?? LEGACY_RTSP_PORT;
    const rtspsPort =
      firstInt(rtspSettings, "rtspsPort", "rtsps_port", "srtpPort", "srtp_port") ??
      SECURE_RTSP_PORT;

    if (secureEnabled) {
      return { scheme: "rtsps", port: rtspsPort, version };
    }
    return { scheme: "rtsp", port: rtspPort, version };
  }

  private async fetchCameras(): Promise<JsonRecord[]> {
    const payload = await this.getJson(`${this.baseUrl}/cameras`);
    return extractList(payload, "cameras", "data");
  }

  private async fetchCamera(cameraId: string): Promise<JsonRecord | null> {
    try {
      const payload = await this.getJson(`${this.baseUrl}/cameras/${cameraId}`);
      if (payload && typeof payload === "object" && !Array.isArray(payload)) {
        const record = payload as JsonRecord;
        const data = record.data;
        return data && typeof data === "object" && !Array.isArray(data)
          ? (data as JsonRecord)
          : record;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async resolveCamera(
    camera: JsonRecord,
    capabilities: ProtectCapabilities,
  ): Promise<CameraStreams> {
    const cameraId = this.cameraId(camera) ?? "";
    const result: CameraStreams = {
      camera_id: cameraId,
      name: this.cameraName(camera),
      model: this.cameraModel(camera),
      online: this.cameraOnline(camera),
      source: "unifi",
      streams: [],
      host: this.cameraHost(camera),
    };

    if (!result.online) {
      result.error = "camera_offline";
    }

    const channels = this.cameraChannels(camera);
    if (channels.length === 0) {
      result.error = result.error ?? "rtsp_not_supported";
      return result;
    }

    for (let index = 0; index < channels.length; index += 1) {
      const channel = channels[index];
      const quality = this.channelQuality(channel, index);
      let enabled = this.channelRtspEnabled(channel);
      let alias = this.channelRtspAlias(channel);

      if (!alias && !enabled && cameraId) {
        const enableResult = await this.enableChannelRtsp(cameraId, index, quality);
        if (enableResult.error) {
          result.error = enableResult.error;
        }
        if (enableResult.enabled) {
          const refreshed = await this.fetchCamera(cameraId);
          if (refreshed) {
            const refreshedChannels = this.cameraChannels(refreshed);
            if (index < refreshedChannels.length) {
              alias = this.channelRtspAlias(refreshedChannels[index]);
            }
          }
        }
      }

      if (!alias) continue;

      result.streams.push({
        quality,
        url: `${capabilities.scheme}://${this.protectHost}:${capabilities.port}/${alias}`,
        enabled: true,
      });
    }

    if (result.streams.length === 0) {
      result.error = result.error ?? "rtsp_not_supported";
    }

    return result;
  }

  private async enableChannelRtsp(
    cameraId: string,
    index: number,
    quality: StreamQuality,
  ): Promise<{ enabled: boolean; error: string | null }> {
    const payloads: JsonRecord[] = [
      { channels: { [String(index)]: { isRtspEnabled: true } } },
      { channels: [{ id: String(index), isRtspEnabled: true, quality }] },
      { channel: quality, isRtspEnabled: true },
    ];

    for (const payload of payloads) {
      try {
        await this.patchJson(`${this.baseUrl}/cameras/${cameraId}`, payload);
        return { enabled: true, error: null };
      } catch (error) {
        if (error instanceof UniFiRtspAuthError || error instanceof UniFiRtspPermissionError) {
          return { enabled: false, error: error.message };
        }
        if (error instanceof UniFiHttpError) {
          if (error.status === 401 || error.status === 403) {
            return { enabled: false, error: "insufficient_permission_scope" };
          }
        }
      }
    }

    return { enabled: false, error: "rtsp_enable_failed" };
  }

  private async getJson(url: string): Promise<unknown> {
    return this.readJson(url, "GET");
  }

  private async patchJson(url: string, payload: JsonRecord): Promise<unknown> {
    return this.readJson(url, "PATCH", payload);
  }

  private async readJson(
    url: string,
    method: "GET" | "PATCH",
    payload?: JsonRecord,
  ): Promise<unknown> {
    const parsedUrl = new URL(url);
    const body = method === "PATCH" && payload ? JSON.stringify(payload) : undefined;

    return new Promise((resolve, reject) => {
      const request = https.request(
        parsedUrl,
        {
          method,
          agent: this.agent,
          timeout: DEFAULT_TIMEOUT_MS,
          headers: {
            Accept: "application/json",
            "X-API-KEY": this.apiKey,
            ...(body
              ? {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(body),
                }
              : {}),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf-8");
            const status = response.statusCode ?? 0;

            if (status < 200 || status >= 300) {
              if (status === 401) {
                reject(new UniFiRtspAuthError());
                return;
              }
              if (status === 403) {
                reject(new UniFiRtspPermissionError());
                return;
              }
              reject(new UniFiHttpError(status, text || response.statusMessage || "Request failed"));
              return;
            }

            if (!text) {
              resolve({});
              return;
            }

            try {
              resolve(JSON.parse(text) as unknown);
            } catch (error) {
              reject(error);
            }
          });
        },
      );

      request.on("timeout", () => {
        request.destroy(new Error("UniFi Protect request timed out"));
      });
      request.on("error", reject);
      if (body) request.write(body);
      request.end();
    });
  }

  private cameraId(camera: JsonRecord): string | null {
    return firstString(camera, "id", "_id", "cameraId");
  }

  private cameraName(camera: JsonRecord): string {
    return firstString(camera, "name", "displayName") ?? "UniFi Camera";
  }

  private cameraModel(camera: JsonRecord): string {
    return (
      firstString(camera, "model", "modelKey", "type", "productName") ?? "UniFi Camera"
    );
  }

  private cameraHost(camera: JsonRecord): string | null {
    return firstString(camera, "host", "ip", "ipAddress", "address");
  }

  private cameraOnline(camera: JsonRecord): boolean {
    const state = firstString(camera, "state", "connectionState", "status");
    if (state) {
      return ["connected", "online", "ready"].includes(state.toLowerCase());
    }
    const online = firstBool(camera, "online", "isOnline", "connected");
    return Boolean(online);
  }

  private cameraChannels(camera: JsonRecord): JsonRecord[] {
    const channels = extractList(camera, "channels", "videoChannels");
    if (channels.length > 0) return channels;
    const videoSettings = firstDict(camera, "videoSettings");
    if (videoSettings) {
      return extractList(videoSettings, "channels");
    }
    return [];
  }

  private channelQuality(channel: JsonRecord, index: number): StreamQuality {
    const value = firstString(channel, "quality", "name", "id", "stream");
    const normalized = (value ?? "").toLowerCase();
    if (normalized.includes("high") || normalized === "0" || normalized === "default") {
      return "high";
    }
    if (normalized.includes("medium") || normalized.includes("med") || normalized === "1") {
      return "medium";
    }
    if (normalized.includes("low") || normalized === "2") {
      return "low";
    }
    const qualities: StreamQuality[] = ["high", "medium", "low"];
    return qualities[index] ?? "low";
  }

  private channelRtspEnabled(channel: JsonRecord): boolean {
    const value = firstBool(
      channel,
      "isRtspEnabled",
      "rtspEnabled",
      "enabled",
      "isRtspsEnabled",
    );
    return Boolean(value);
  }

  private channelRtspAlias(channel: JsonRecord): string | null {
    const direct = firstString(
      channel,
      "rtspAlias",
      "rtspsAlias",
      "rtsp_alias",
      "streamAlias",
    );
    if (direct) return direct.replace(/^\/+|\/+$/g, "");

    const rtsp = firstDict(channel, "rtsp", "rtsps");
    if (rtsp) {
      const nested = firstString(rtsp, "alias", "rtspAlias", "rtspsAlias");
      if (nested) return nested.replace(/^\/+|\/+$/g, "");
    }
    return null;
  }
}

class UniFiHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UniFiHttpError";
  }
}

export function clearUniFiRtspCache(): void {
  cache.clear();
}

export async function resolveCameraStreams(
  apiKey: string,
  protectHost: string,
): Promise<CameraStreams[]> {
  if (!apiKey || !protectHost) {
    return [];
  }

  const verifyTls = resolveVerifyTls();
  const ttlSeconds = resolveCacheTtlSeconds();
  const cacheKey = `${cleanHost(protectHost)}:${apiKey}:${verifyTls}`;
  const now = Date.now();
  const cached = cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.cameras;
  }

  const client = new UniFiProtectRtspClient(apiKey, protectHost, verifyTls);
  const cameras = await client.resolveCameraStreams();
  cache.set(cacheKey, { expiresAt: now + ttlSeconds * 1000, cameras });
  return cameras;
}
