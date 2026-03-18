import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT_DIR = process.cwd();

const SERVICE_PACKAGES = [
  {
    workspace: "@delexec/platform-api",
    bin: "delexec-platform-api",
    env: () => ({
      TOKEN_SECRET: "service-package-test-token-secret",
      ENABLE_BOOTSTRAP_SELLERS: "false"
    })
  },
  {
    workspace: "@delexec/transport-relay",
    bin: "delexec-relay",
    env: () => ({})
  }
];

const LIBRARY_PACKAGES = [
  {
    workspace: "@delexec/postgres-store",
    assertExpression: '(mod) => typeof mod.createPostgresSnapshotStore === "function"'
  }
];

const ALL_PACKAGES = [
  ...SERVICE_PACKAGES.map((item) => item.workspace),
  ...LIBRARY_PACKAGES.map((item) => item.workspace)
];

function packageInstallPath(installDir, workspace) {
  return path.join(installDir, "node_modules", ...workspace.split("/"));
}

function randomPort(base) {
  return base + Math.floor(Math.random() * 500);
}

async function packWorkspace(workspace, packDir) {
  const packed = await execFileAsync("npm", ["pack", "--workspace", workspace, "--pack-destination", packDir], {
    cwd: ROOT_DIR
  });
  const tarballName = packed.stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!tarballName) {
    throw new Error(`package_pack_missing_tarball:${workspace}`);
  }
  return path.join(packDir, tarballName);
}

function resolveBinEntry(packageRoot, binName) {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  if (typeof manifest.bin === "string") {
    return path.join(packageRoot, manifest.bin);
  }
  const relative = manifest.bin?.[binName] || Object.values(manifest.bin || {})[0];
  if (!relative) {
    throw new Error(`package_bin_missing:${manifest.name}`);
  }
  return path.join(packageRoot, relative);
}

async function waitForHealth(baseUrl, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.status === 200) {
        return;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`service_health_timeout:${baseUrl}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.killed) {
    return;
  }
  await new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        resolve();
      }
    };
    child.once("exit", finish);
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      finish();
    }, 1000);
  });
}

async function verifyLibraryPackage(item, installDir) {
  const expression = `
    const pkg = await import(${JSON.stringify(item.workspace)});
    const assertFn = ${item.assertExpression};
    if (!assertFn(pkg)) {
      throw new Error("library_export_assertion_failed");
    }
  `;
  await execFileAsync(process.execPath, ["--input-type=module", "-e", expression], {
    cwd: installDir,
    env: {
      ...process.env,
      DELEXEC_HOME: path.join(installDir, ".delexec-home")
    }
  });
  console.log(`[check-service-packages] ok library=${item.workspace}`);
}

async function verifyServicePackage(item, installDir) {
  const packageRoot = packageInstallPath(installDir, item.workspace);
  const binPath = resolveBinEntry(packageRoot, item.bin);
  const port = randomPort(47000);
  const logs = [];
  const child = spawn(process.execPath, [binPath], {
    cwd: installDir,
    env: {
      ...process.env,
      ...item.env(),
      PORT: String(port),
      DELEXEC_HOME: path.join(installDir, ".delexec-home")
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => logs.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => logs.push(chunk.toString("utf8")));

  try {
    await waitForHealth(`http://127.0.0.1:${port}`);
    console.log(`[check-service-packages] ok service=${item.workspace} bin=${item.bin}`);
  } catch (error) {
    throw new Error(`${item.workspace} failed: ${error.message}\n${logs.join("")}`);
  } finally {
    await stopChild(child);
  }
}

async function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "service-pack-check-"));
  const packDir = path.join(tempRoot, "pack");
  const installDir = path.join(tempRoot, "install");
  fs.mkdirSync(packDir, { recursive: true });
  fs.mkdirSync(installDir, { recursive: true });

  try {
    const tarballs = [];
    for (const workspace of ALL_PACKAGES) {
      tarballs.push(await packWorkspace(workspace, packDir));
    }

    await execFileAsync("npm", ["init", "-y"], { cwd: installDir });
    await execFileAsync("npm", ["install", ...tarballs], {
      cwd: installDir,
      maxBuffer: 1024 * 1024 * 16
    });

    for (const item of LIBRARY_PACKAGES) {
      await verifyLibraryPackage(item, installDir);
    }
    for (const item of SERVICE_PACKAGES) {
      await verifyServicePackage(item, installDir);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[check-service-packages] ${error.stack || error.message}`);
  process.exit(1);
});
