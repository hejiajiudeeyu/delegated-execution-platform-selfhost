// Artifact byte storage.
//
// Decision A-01 puts artifact metadata and authorization in the Platform and
// the bytes in S3-compatible object storage. This module is the seam that
// makes that swap a backend change rather than a protocol change: nothing
// above it ever learns a bucket name, object key or presigned URL — callers
// address bytes only by artifact id, exactly as the protocol descriptor does.
//
// The filesystem backend is the first implementation and is what the current
// single-host Compose deployment uses. An S3/MinIO backend implements the same
// four methods and changes nothing else.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const CHECKSUM_ALGORITHM = "sha256";

export function checksumOf(buffer) {
  return crypto.createHash(CHECKSUM_ALGORITHM).update(buffer).digest("hex");
}

// Artifact ids come from us, but they end up in a filesystem path, so treat
// them as untrusted anyway: a traversal here would read arbitrary host files.
function assertSafeArtifactId(artifactId) {
  if (typeof artifactId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(artifactId)) {
    throw new Error("artifact_id_unsafe");
  }
  return artifactId;
}

export function createMemoryArtifactStore() {
  const blobs = new Map();
  return {
    kind: "memory",
    async put(artifactId, buffer) {
      assertSafeArtifactId(artifactId);
      blobs.set(artifactId, Buffer.from(buffer));
      return { size_bytes: buffer.length, checksum: checksumOf(buffer) };
    },
    async get(artifactId) {
      assertSafeArtifactId(artifactId);
      return blobs.has(artifactId) ? Buffer.from(blobs.get(artifactId)) : null;
    },
    async delete(artifactId) {
      assertSafeArtifactId(artifactId);
      return blobs.delete(artifactId);
    },
    async close() {}
  };
}

export function createFilesystemArtifactStore({ root }) {
  if (!root) {
    throw new Error("artifact_store_root_required");
  }
  const resolvedRoot = path.resolve(root);
  fs.mkdirSync(resolvedRoot, { recursive: true });

  function pathFor(artifactId) {
    const resolved = path.resolve(resolvedRoot, assertSafeArtifactId(artifactId));
    if (resolved !== path.join(resolvedRoot, artifactId)) {
      throw new Error("artifact_id_unsafe");
    }
    return resolved;
  }

  return {
    kind: "filesystem",
    root: resolvedRoot,
    async put(artifactId, buffer) {
      const target = pathFor(artifactId);
      // Write to a temporary name and rename, so a crash mid-write cannot
      // leave a half-written blob that would later fail its checksum.
      const temporary = `${target}.${crypto.randomUUID()}.part`;
      await fs.promises.writeFile(temporary, buffer);
      await fs.promises.rename(temporary, target);
      return { size_bytes: buffer.length, checksum: checksumOf(buffer) };
    },
    async get(artifactId) {
      try {
        return await fs.promises.readFile(pathFor(artifactId));
      } catch (error) {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    async delete(artifactId) {
      try {
        await fs.promises.unlink(pathFor(artifactId));
        return true;
      } catch (error) {
        if (error.code === "ENOENT") {
          return false;
        }
        throw error;
      }
    },
    async close() {}
  };
}
