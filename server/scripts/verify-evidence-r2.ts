/**
 * Smoke-test evidenceR2 against an in-memory mock R2 bucket.
 * Run: npx tsx scripts/verify-evidence-r2.ts
 */
import { buildEvidenceR2Key, saveEvidenceImage } from "../lib/evidenceR2";
import type { R2Bucket, R2Object, R2PutOptions } from "../lib/r2Types";

function createMockR2(): R2Bucket & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();

  return {
    objects,
    async put(
      key: string,
      value: ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob | null,
      options?: R2PutOptions,
    ): Promise<R2Object | null> {
      if (value === null) return null;

      let bytes: Uint8Array;
      if (value instanceof Uint8Array) {
        bytes = value;
      } else if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else if (typeof value === "string") {
        bytes = new TextEncoder().encode(value);
      } else {
        throw new Error("mock R2: unsupported value type");
      }

      objects.set(key, bytes);

      if (options?.httpMetadata?.contentType !== "image/jpeg") {
        throw new Error("expected image/jpeg content type");
      }

      return { key, size: bytes.byteLength, etag: "mock-etag" };
    },
  };
}

async function main() {
  const key = buildEvidenceR2Key("cam_010", "Litter", 1_751_470_000_000);
  if (key !== "evidence/cam_010/1751470000000-litter.jpg") {
    throw new Error(`unexpected key: ${key}`);
  }

  const bucket = createMockR2();
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  const r2Key = await saveEvidenceImage(
    bucket,
    "cam_010",
    "Litter",
    1_751_470_000_000,
    jpeg,
  );

  if (r2Key !== key) {
    throw new Error("saveEvidenceImage returned unexpected key");
  }

  const stored = bucket.objects.get(r2Key);
  if (!stored || stored.byteLength !== jpeg.byteLength) {
    throw new Error("object not stored in mock bucket");
  }

  console.log("verify-evidence-r2: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
