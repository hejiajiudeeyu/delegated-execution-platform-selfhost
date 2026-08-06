// The guarantee this pins: a backup whose artifact bytes do not match what the
// database recorded must FAIL verification, loudly.
//
// The platform refuses to call an artifact `delivered` when its checksum does
// not match (NFR-R03). A backup that drops or corrupts the bytes while keeping
// the descriptor would reintroduce exactly that lie one layer down — the
// restored stack would serve a committed artifact that cannot be fetched, or
// worse, different bytes under the same checksum. A silent verifier is the way
// that gets shipped, so each failure mode gets a test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { artifactIndexFromSnapshot, crossCheckArtifacts } from "../../scripts/stack-backup.mjs";

const created = [];

function tempRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stack-backup-test-"));
  created.push(dir);
  return dir;
}

function writeArtifact(root, artifactId, contents) {
  fs.writeFileSync(path.join(root, artifactId), contents);
  return {
    artifact_id: artifactId,
    lifecycle_state: "committed",
    size_bytes: Buffer.byteLength(contents),
    checksum: { algorithm: "sha256", value: crypto.createHash("sha256").update(contents).digest("hex") }
  };
}

afterEach(() => {
  while (created.length > 0) {
    fs.rmSync(created.pop(), { recursive: true, force: true });
  }
});

describe("artifactIndexFromSnapshot", () => {
  it("reads the platform snapshot's artifact entries", () => {
    const index = artifactIndexFromSnapshot({
      artifacts: [
        ["art_b", { request_id: "req_2", role: "output", lifecycle_state: "committed", size_bytes: 2, checksum: { algorithm: "sha256", value: "bb" } }],
        ["art_a", { request_id: "req_1", role: "input", lifecycle_state: "allocated", size_bytes: 0, checksum: null }]
      ]
    });

    // Sorted, so two backups of the same state produce comparable indexes.
    expect(index.map((item) => item.artifact_id)).toEqual(["art_a", "art_b"]);
    expect(index[1]).toMatchObject({ role: "output", lifecycle_state: "committed" });
  });

  it("survives a snapshot with no artifacts at all", () => {
    expect(artifactIndexFromSnapshot(null)).toEqual([]);
    expect(artifactIndexFromSnapshot({})).toEqual([]);
  });
});

describe("crossCheckArtifacts", () => {
  it("passes when every committed artifact has its recorded bytes", () => {
    const root = tempRoot();
    const index = [writeArtifact(root, "art_one", "hello"), writeArtifact(root, "art_two", "world")];

    const result = crossCheckArtifacts(index, root);

    expect(result.blockers).toEqual([]);
    expect(result.checked).toBe(2);
    expect(result.committed).toBe(2);
  });

  it("blocks when a committed artifact has no bytes", () => {
    const root = tempRoot();
    const present = writeArtifact(root, "art_present", "here");
    const missing = { ...present, artifact_id: "art_missing" };

    const result = crossCheckArtifacts([present, missing], root);

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toContain("art_missing");
    expect(result.blockers[0]).toContain("no bytes in the backup");
  });

  it("blocks when the bytes do not hash to the recorded checksum", () => {
    const root = tempRoot();
    const entry = writeArtifact(root, "art_tampered", "original");
    fs.writeFileSync(path.join(root, "art_tampered"), "tampered");
    entry.size_bytes = Buffer.byteLength("tampered");

    const result = crossCheckArtifacts([entry], root);

    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toContain("sha256");
  });

  it("blocks when the size disagrees, without needing to hash", () => {
    const root = tempRoot();
    const entry = writeArtifact(root, "art_short", "12345");
    entry.size_bytes = 999;

    const result = crossCheckArtifacts([entry], root);

    expect(result.blockers[0]).toContain("size 5 != recorded 999");
  });

  it("ignores artifacts the database never called committed", () => {
    const root = tempRoot();
    const allocated = { artifact_id: "art_allocated", lifecycle_state: "allocated", size_bytes: 0, checksum: null };

    const result = crossCheckArtifacts([allocated], root);

    expect(result.blockers).toEqual([]);
    expect(result.committed).toBe(0);
  });

  it("warns rather than blocks on bytes with no database record", () => {
    const root = tempRoot();
    const entry = writeArtifact(root, "art_known", "known");
    fs.writeFileSync(path.join(root, "art_orphan"), "unreferenced");

    const result = crossCheckArtifacts([entry], root);

    expect(result.blockers).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("art_orphan"))).toBe(true);
  });

  it("refuses to pretend an unknown checksum algorithm was verified", () => {
    const root = tempRoot();
    const entry = writeArtifact(root, "art_md5", "content");
    entry.checksum = { algorithm: "md5", value: "whatever" };

    const result = crossCheckArtifacts([entry], root);

    expect(result.blockers).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("cannot be verified"))).toBe(true);
  });
});
