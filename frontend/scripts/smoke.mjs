import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import process from "node:process";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const makeCommand = process.env.MAKE || "make";
const healthURL = process.env.KIKOTO_SMOKE_HEALTH_URL || "http://127.0.0.1:17659/health";
const smokeBaseURL = process.env.PLAYWRIGHT_BASE_URL || "http://127.0.0.1:17655";
const maxAttempts = 15;
const requestTimeoutMilliseconds = 2_000;
const retryDelayMilliseconds = 2_000;

function run(command, argumentsList, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${command} ${argumentsList.join(" ")} exited with ${signal || `code ${code}`}`));
    });
  });
}

function runMake(argumentsList, options = {}) {
  return run(makeCommand, argumentsList, { ...options, cwd: options.cwd || workspaceRoot });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function waitForHealth() {
  let lastError = "no response";
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(healthURL, {
        signal: AbortSignal.timeout(requestTimeoutMilliseconds),
      });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < maxAttempts) {
      await delay(retryDelayMilliseconds);
    }
  }
  throw new Error(`backend health check failed after ${maxAttempts} attempts: ${lastError}`);
}

async function runSmoke() {
  let stackAttempted = false;
  try {
    stackAttempted = true;
    await runMake(["smoke-up"]);
    await waitForHealth();
    await runMake(["frontend-e2e-smoke"], {
      env: { ...process.env, PLAYWRIGHT_BASE_URL: smokeBaseURL },
    });
  } catch (error) {
    if (stackAttempted) {
      try {
        await runMake(["smoke-status"]);
      } catch {
        // Preserve the original smoke failure when status is unavailable.
      }
      try {
        await runMake(["smoke-logs"]);
      } catch {
        // Preserve the original smoke failure when diagnostics are unavailable.
      }
    }
    throw error;
  } finally {
    if (stackAttempted) {
      try {
        await runMake(["smoke-down"]);
      } catch (error) {
        console.error(`failed to stop smoke containers: ${error.message}`);
      }
    }
  }
}

const command = process.argv[2];
if (command === "wait-for-health") {
  await waitForHealth();
} else if (command === "run") {
  await runSmoke();
} else {
  console.error("usage: node frontend/scripts/smoke.mjs <run|wait-for-health>");
  process.exitCode = 2;
}
