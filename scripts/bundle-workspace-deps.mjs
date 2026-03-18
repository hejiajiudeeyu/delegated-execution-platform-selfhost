import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function removePath(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyDir(sourceDir, targetDir) {
  fs.cpSync(sourceDir, targetDir, {
    recursive: true,
    force: true,
    dereference: true,
    filter(source) {
      const relative = path.relative(sourceDir, source);
      if (!relative) {
        return true;
      }
      const firstSegment = relative.split(path.sep)[0];
      if (["node_modules", ".git", "coverage", "dist"].includes(firstSegment)) {
        return false;
      }
      return true;
    }
  });
}

function collectWorkspacePackageDirs() {
  const packageDirs = [];
  for (const baseDir of ["apps", "packages"]) {
    const absoluteBaseDir = path.join(ROOT_DIR, baseDir);
    if (!fs.existsSync(absoluteBaseDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(absoluteBaseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directPackageJson = path.join(absoluteBaseDir, entry.name, "package.json");
      if (fs.existsSync(directPackageJson)) {
        packageDirs.push(path.join(absoluteBaseDir, entry.name));
        continue;
      }
      for (const nested of fs.readdirSync(path.join(absoluteBaseDir, entry.name), { withFileTypes: true })) {
        if (!nested.isDirectory()) {
          continue;
        }
        const nestedPackageJson = path.join(absoluteBaseDir, entry.name, nested.name, "package.json");
        if (fs.existsSync(nestedPackageJson)) {
          packageDirs.push(path.join(absoluteBaseDir, entry.name, nested.name));
        }
      }
    }
  }
  return packageDirs;
}

function workspacePackageIndex() {
  const index = new Map();
  for (const packageDir of collectWorkspacePackageDirs()) {
    const manifest = readJson(path.join(packageDir, "package.json"));
    if (manifest.name) {
      index.set(manifest.name, {
        dir: packageDir,
        manifest
      });
    }
  }
  return index;
}

function resolveTargetDir() {
  const relativeTarget = process.argv[3] || "apps/ops";
  return path.resolve(ROOT_DIR, relativeTarget);
}

function buildTargetPaths(targetDir) {
  const stagedNodeModulesDir = path.join(targetDir, "node_modules");
  const stageMarker = path.join(stagedNodeModulesDir, ".workspace-bundle-stage.json");
  return {
    targetDir,
    stagedNodeModulesDir,
    stageMarker
  };
}

function stageBundledWorkspaces(targetDir) {
  const targetManifest = readJson(path.join(targetDir, "package.json"));
  const bundledDependencies = Array.isArray(targetManifest.bundleDependencies) ? targetManifest.bundleDependencies : [];
  const workspaceIndex = workspacePackageIndex();
  const staged = [];
  const { stageMarker } = buildTargetPaths(targetDir);

  for (const packageName of bundledDependencies) {
    const workspacePackage = workspaceIndex.get(packageName);
    if (!workspacePackage) {
      continue;
    }
    const segments = packageName.split("/");
    const dependencyTargetDir = path.join(targetDir, "node_modules", ...segments);
    ensureDir(path.dirname(dependencyTargetDir));
    removePath(dependencyTargetDir);
    copyDir(workspacePackage.dir, dependencyTargetDir);
    staged.push(dependencyTargetDir);
  }

  writeJson(stageMarker, {
    staged_at: new Date().toISOString(),
    staged
  });

  return staged;
}

function cleanupBundledWorkspaces(targetDir) {
  const { stagedNodeModulesDir, stageMarker } = buildTargetPaths(targetDir);
  if (!fs.existsSync(stageMarker)) {
    return;
  }
  const marker = readJson(stageMarker);
  for (const stagedPath of marker.staged || []) {
    if (typeof stagedPath === "string" && stagedPath.startsWith(stagedNodeModulesDir)) {
      removePath(stagedPath);
    }
  }
  removePath(stageMarker);
  if (fs.existsSync(stagedNodeModulesDir) && fs.readdirSync(stagedNodeModulesDir).length === 0) {
    removePath(stagedNodeModulesDir);
  }
}

const action = process.argv[2] || "stage";
const targetDir = resolveTargetDir();
if (action === "stage") {
  stageBundledWorkspaces(targetDir);
} else if (action === "cleanup") {
  cleanupBundledWorkspaces(targetDir);
} else {
  throw new Error(`unsupported_bundle_workspace_action:${action}`);
}
