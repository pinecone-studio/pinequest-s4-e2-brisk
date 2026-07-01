/**
 * Smoke-test GET list query parsing + listEvidenceEvents via dev store.
 * Run: npx tsx scripts/verify-evidence-list.ts
 */
import { listEvidenceEvents } from "../lib/evidenceEventsDb";
import { parseListEvidenceQuery } from "../lib/evidenceListQuery";
import { getDevEvidenceBindings } from "../lib/devEvidenceStore";
import { insertEvidenceEvent } from "../lib/evidenceEventsDb";

async function main() {
  const bad = parseListEvidenceQuery(new URLSearchParams("limit=-1"));
  if (!("error" in bad)) throw new Error("expected limit error");

  const dev = getDevEvidenceBindings();
  dev.reset();

  await insertEvidenceEvent(dev.db, {
    id: "evt_a",
    cameraId: "cam_010",
    label: "Litter",
    confidence: 0.8,
    occurredAt: 100,
    r2Key: "evidence/cam_010/100-litter.jpg",
    createdAt: 101,
  });
  await insertEvidenceEvent(dev.db, {
    id: "evt_b",
    cameraId: "cam_020",
    label: "Cigarette",
    confidence: 0.9,
    occurredAt: 200,
    r2Key: "evidence/cam_020/200-cigarette.jpg",
    createdAt: 201,
  });

  const all = await listEvidenceEvents(dev.db, { limit: 10 });
  if (all.length !== 2 || all[0].id !== "evt_b") {
    throw new Error("expected newest first");
  }

  const filtered = await listEvidenceEvents(dev.db, { cameraId: "cam_010" });
  if (filtered.length !== 1 || filtered[0].id !== "evt_a") {
    throw new Error("cameraId filter failed");
  }

  console.log("verify-evidence-list: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
