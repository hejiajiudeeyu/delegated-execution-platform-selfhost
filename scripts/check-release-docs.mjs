import fs from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, "package.json"), "utf8"));
const version = packageJson.version;
const tag = `v${version}`;
const releasesDir = path.join(rootDir, "docs", "archive", "releases");
const notesFile = path.join(releasesDir, `${tag}.md`);
const matrixFile = path.join(releasesDir, "compatibility-matrix.md");

function fail(message) {
  console.error(`[check-release-docs] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(notesFile)) {
  fail(`missing release notes file: ${path.relative(rootDir, notesFile)}`);
}

if (!fs.existsSync(matrixFile)) {
  fail(`missing compatibility matrix: ${path.relative(rootDir, matrixFile)}`);
}

const notesText = fs.readFileSync(notesFile, "utf8");
if (!notesText.includes(tag)) {
  fail(`release notes file does not mention ${tag}`);
}

const matrixText = fs.readFileSync(matrixFile, "utf8");
if (!matrixText.includes(`\`${tag}\``) && !matrixText.includes(tag)) {
  fail(`compatibility matrix does not include ${tag}`);
}

console.log(`[check-release-docs] ok for ${tag}`);
