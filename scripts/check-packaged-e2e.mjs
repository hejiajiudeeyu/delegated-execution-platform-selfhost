import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT_DIR = process.cwd();

const PACKAGES = [
  { workspace: "@delexec/platform-api", envKey: "PLATFORM", bin: "delexec-platform-api" },
  { workspace: "@delexec/buyer-controller", envKey: "BUYER", bin: "delexec-buyer-controller" },
  { workspace: "@delexec/seller-controller", envKey: "SELLER", bin: "delexec-seller-controller" },
  { workspace: "@delexec/transport-relay", envKey: "RELAY", bin: "delexec-relay" },
  { workspace: "@delexec/ops", envKey: "OPS_SUPERVISOR", bin: "delexec-ops", args: ["start"] }
];

function packageInstallPath(installDir, workspace) {
  return path.join(installDir, "node_modules", ...workspace.split("/"));
}

function resolveBinEntry(packageRoot, binName) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (typeof manifest.bin === "string") {
    return path.join(packageRoot, manifest.bin);
  }
  const relative = manifest.bin?.[binName] || Object.values(manifest.bin || {})[0];
  if (!relative) {
    throw new Error(`packaged_bin_missing:${manifest.name}`);
  }
  return path.join(packageRoot, relative);
}

async function packWorkspace(workspace, packDir) {
  const packed = await execFileAsync("npm", ["pack", "--workspace", workspace, "--pack-destination", packDir], {
    cwd: ROOT_DIR
  });
  const tarballName = packed.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!tarballName) {
    throw new Error(`packaged_tarball_missing:${workspace}`);
  }
  return path.join(packDir, tarballName);
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "packaged-e2e-"));
  const packDir = path.join(tempRoot, "pack");
  const installDir = path.join(tempRoot, "install");
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });

  try {
    const tarballs = [];
    for (const item of PACKAGES) {
      tarballs.push(await packWorkspace(item.workspace, packDir));
    }

    await execFileAsync("npm", ["init", "-y"], { cwd: installDir });
    await execFileAsync("npm", ["install", ...tarballs], { cwd: installDir, maxBuffer: 1024 * 1024 * 16 });

    const env = { ...process.env };
    for (const item of PACKAGES) {
      const packageRoot = packageInstallPath(installDir, item.workspace);
      const entryPath = resolveBinEntry(packageRoot, item.bin);
      env[`E2E_${item.envKey}_CMD`] = process.execPath;
      env[`E2E_${item.envKey}_ARGS`] = JSON.stringify([entryPath, ...(item.args || [])]);
    }

    const result = await execFileAsync("npm", ["run", "test:e2e"], {
      cwd: ROOT_DIR,
      env,
      maxBuffer: 1024 * 1024 * 16
    });

    if (result.stdout.trim()) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr.trim()) {
      process.stderr.write(result.stderr);
    }
    console.log(`[check-packaged-e2e] ok install_dir=${installDir}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[check-packaged-e2e] ${error.stack || error.message}`);
  process.exit(1);
});
