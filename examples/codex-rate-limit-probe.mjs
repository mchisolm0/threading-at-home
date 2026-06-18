#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const codexBin = process.env.CODEX_BIN || "codex";
const proc = spawn(codexBin, ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
});

let nextId = 1;
const pending = new Map();
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS || 15000);

const timeout = setTimeout(() => {
  console.error(`Timed out after ${timeoutMs}ms waiting for codex app-server.`);
  proc.kill();
  process.exit(1);
}, timeoutMs);

function send(message) {
  proc.stdin.write(`${JSON.stringify(message)}\n`);
}

function request(method, params) {
  const id = nextId++;
  send({ method, id, ...(params === undefined ? {} : { params }) });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
  });
}

const stderr = [];
proc.stderr.on("data", (chunk) => {
  const text = chunk.toString("utf8").trim();
  if (text) stderr.push(text);
});

const rl = createInterface({ input: proc.stdout });
rl.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }

  if (!("id" in message)) return;
  const waiter = pending.get(message.id);
  if (!waiter) return;
  pending.delete(message.id);

  if (message.error) {
    waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
    return;
  }
  waiter.resolve(message.result);
});

proc.on("exit", (code) => {
  if (pending.size > 0) {
    for (const { reject } of pending.values()) {
      reject(new Error(`codex app-server exited with code ${code}`));
    }
    pending.clear();
  }
});

try {
  await request("initialize", {
    clientInfo: {
      name: "oss_capacity_probe",
      title: "OSS Capacity Probe",
      version: "0.0.1",
    },
    capabilities: { experimentalApi: true },
  });
  send({ method: "initialized", params: {} });

  const account = await request("account/read", { refreshToken: false });
  const limits = await request("account/rateLimits/read");

  const safeAccount =
    account.account == null
      ? null
      : {
          type: account.account.type,
          planType: account.account.planType ?? null,
        };

  console.log(
    JSON.stringify(
      {
        account: safeAccount,
        requiresOpenaiAuth: account.requiresOpenaiAuth,
        rateLimits: limits.rateLimits,
        rateLimitResetCredits: limits.rateLimitResetCredits ?? null,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (stderr.length > 0) {
    console.error(stderr.slice(-5).join("\n"));
  }
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  rl.close();
  proc.kill();
}
