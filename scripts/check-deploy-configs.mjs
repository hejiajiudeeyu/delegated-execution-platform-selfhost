import { spawnSync } from "node:child_process";

const commands = [
  ["docker", ["compose", "-f", "docker-compose.yml", "config"]],
  ["docker", ["compose", "-f", "deploy/platform/docker-compose.yml", "--env-file", "deploy/platform/.env.example", "config"]],
  ["docker", ["compose", "-f", "deploy/public-stack/docker-compose.yml", "--env-file", "deploy/public-stack/.env.example", "config"]],
  ["docker", ["compose", "-f", "deploy/ops/docker-compose.yml", "--env-file", "deploy/ops/.env.example", "config"]],
  ["docker", ["compose", "-f", "deploy/relay/docker-compose.yml", "--env-file", "deploy/relay/.env.example", "config"]],
  ["docker", ["compose", "-f", "deploy/buyer/docker-compose.yml", "--env-file", "deploy/buyer/.env.example", "config"]],
  ["docker", ["compose", "-f", "deploy/seller/docker-compose.yml", "--env-file", "deploy/seller/.env.example", "config"]],
  ["docker", ["compose", "-f", "deploy/all-in-one/docker-compose.yml", "--env-file", "deploy/all-in-one/.env.example", "config"]]
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
