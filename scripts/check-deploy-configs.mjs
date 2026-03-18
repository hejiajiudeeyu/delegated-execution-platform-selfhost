import { spawnSync } from "node:child_process";

const commands = [
  ["docker", ["compose", "-f", "deploy/platform/docker-compose.yml", "--env-file", "deploy/platform/.env.example", "config"]],
  ["docker", ["compose", "-f", "deploy/public-stack/docker-compose.yml", "--env-file", "deploy/public-stack/.env.example", "config"]],
  ["docker", ["compose", "-f", "deploy/relay/docker-compose.yml", "--env-file", "deploy/relay/.env.example", "config"]]
];

for (const [cmd, args] of commands) {
  const result = spawnSync(cmd, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    encoding: "utf8"
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log("[deploy-config] all compose files resolved successfully");
