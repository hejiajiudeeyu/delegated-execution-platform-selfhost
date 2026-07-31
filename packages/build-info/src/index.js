// Observed build facts reported by a running service.
//
// Per workspace decision A-09, this repository never generates a canonical
// cross-repo release manifest: services only *report* what they observe about
// themselves, and the workspace compares those observations against the
// manifest it froze. Everything here is therefore descriptive, never
// authoritative — an unset value is reported as null rather than guessed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ENV_KEYS = Object.freeze({
  gitSha: "DELEXEC_BUILD_GIT_SHA",
  imageDigest: "DELEXEC_BUILD_IMAGE_DIGEST",
  builtAt: "DELEXEC_BUILD_AT",
  releaseId: "DELEXEC_RELEASE_ID",
  manifestSha256: "DELEXEC_RELEASE_MANIFEST_SHA256"
});

function readEnv(env, key) {
  const value = env[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Build the observed-facts payload for one component.
 *
 * @param {object} options
 * @param {string} options.component   stable component id (e.g. "platform-api")
 * @param {string} [options.version]   package version of the running code
 * @param {object} [options.env]       env source, defaults to process.env
 * @param {object} [options.extra]     component-specific observed facts
 */
export function buildInfoPayload({ component, version = null, env = process.env, extra = null } = {}) {
  if (!component) {
    throw new Error("build-info requires a component name");
  }
  const payload = {
    component,
    version: version || null,
    git_sha: readEnv(env, ENV_KEYS.gitSha),
    image_digest: readEnv(env, ENV_KEYS.imageDigest),
    built_at: readEnv(env, ENV_KEYS.builtAt),
    release_id: readEnv(env, ENV_KEYS.releaseId),
    manifest_sha256: readEnv(env, ENV_KEYS.manifestSha256),
    observed_at: new Date().toISOString()
  };
  if (extra && typeof extra === "object") {
    for (const [key, value] of Object.entries(extra)) {
      payload[key] = value === undefined ? null : value;
    }
  }
  return payload;
}

/**
 * Read the version of the package that owns `metaUrl` (its nearest
 * package.json walking upward). Returns null instead of throwing: a missing
 * version must degrade to "unknown", never take a service down.
 *
 * @param {string} metaUrl  import.meta.url of the calling module
 */
export function readPackageVersion(metaUrl) {
  try {
    let dir = path.dirname(fileURLToPath(metaUrl));
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = path.join(dir, "package.json");
      if (fs.existsSync(candidate)) {
        const parsed = JSON.parse(fs.readFileSync(candidate, "utf8"));
        return parsed.version || null;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  } catch {
    return null;
  }
  return null;
}

export const BUILD_INFO_ENV_KEYS = ENV_KEYS;
