import { spawn } from "node:child_process";

const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";

console.log("\x1b[36m%s\x1b[0m", "Starting RecallAI API (port 4000) and Web App (port 3000)...");

const api = spawn(npmCmd, ["run", "dev", "--workspace", "@recallai/api"], {
  stdio: "inherit",
  shell: isWin,
});

const web = spawn(npmCmd, ["run", "dev", "--workspace", "@recallai/web"], {
  stdio: "inherit",
  shell: isWin,
});

function killProcess(child) {
  if (!child || !child.pid) return;
  if (isWin) {
    try {
      spawn("taskkill", ["/pid", child.pid.toString(), "/f", "/t"], { stdio: "ignore" });
    } catch {}
  } else {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

function cleanup() {
  killProcess(api);
  killProcess(web);
}

process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});

process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

api.on("exit", (code) => {
  if (code && code !== 0) {
    console.error(`[API] Exited with code ${code}`);
  }
});

web.on("exit", (code) => {
  if (code && code !== 0) {
    console.error(`[Web] Exited with code ${code}`);
  }
});

