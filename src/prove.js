"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const RESULT = {
  VERIFIED: "VERIFIED",
  REJECTED: "REJECTED",
  INCONCLUSIVE: "INCONCLUSIVE",
};

const PACKET_SCHEMA_VERSION = 1;

// Fields Eng Proof needs to re-run a packet without asking the author anything.
const REQUIRED_PACKET_FIELDS = [
  "schema_version",
  "experiment_id",
  "title",
  "claim_path",
  "rerun.command",
  "runner_result",
  "result.logs_uri",
  "result.wall_ms",
  "provenance.commit",
  "provenance.started_at",
  "provenance.ended_at",
];

const REQUIRED_COMMAND_FIELDS = ["run", "cwd", "expect_exit", "log_path", "wall_ms"];

async function proveClaim({ claimPath, cwd, invocation }) {
  const startedAt = new Date();
  const startedMs = Date.now();
  const absClaim = path.resolve(cwd, claimPath);
  const commit = gitSha(cwd);
  const claim = loadClaim(absClaim);
  const runDir = createRunDir(cwd, claim.experiment_id, startedAt);

  const commandResults = [];
  for (let i = 0; i < claim.commands.length; i += 1) {
    const spec = claim.commands[i];
    const measured = await runDeclaredCommand(spec, cwd);
    const logPath = writeCommandLog(runDir, i, spec, measured);
    commandResults.push({
      run: spec.run,
      cwd: spec.cwd,
      expect_exit: spec.expect_exit,
      timeout_s: spec.timeout_s,
      measured_exit: measured.exit,
      timed_out: measured.timed_out,
      spawn_error: measured.spawn_error,
      wall_ms: measured.wall_ms,
      log_path: rel(cwd, logPath),
    });
  }

  const runnerResult = decideResult(commandResults);
  const endedAt = new Date();
  const packet = {
    schema_version: PACKET_SCHEMA_VERSION,
    experiment_id: claim.experiment_id,
    title: claim.title,
    hypothesis: claim.hypothesis || null,
    rerun: describeRerun(invocation, rel(cwd, absClaim)),
    command: claim.commands,
    result: {
      observed: {
        runner_result: runnerResult,
        measured_exits: commandResults.map((c) => c.measured_exit),
      },
      logs_uri: rel(cwd, runDir),
      wall_ms: Date.now() - startedMs,
    },
    provenance: {
      commit,
      cloud_agent_id: process.env.CURSOR_CLOUD_AGENT_ID || null,
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      instruments: ["apl prove"],
      node_version: process.version,
      platform: process.platform,
    },
    runner_result: runnerResult,
    verdict: null,
    verdict_by: "Eng Proof",
    measured: summarizeMeasured(commandResults),
    commands: commandResults,
    claim_path: rel(cwd, absClaim),
  };

  assertPacketComplete(packet);

  const packetPath = path.join(runDir, "packet.json");
  fs.writeFileSync(packetPath, `${JSON.stringify(packet, null, 2)}\n`);

  return {
    runner_result: runnerResult,
    commit,
    packet_path: rel(cwd, packetPath),
    wall_ms: packet.result.wall_ms,
    commands: commandResults,
  };
}

function loadClaim(absClaim) {
  if (!fs.existsSync(absClaim)) {
    throw new Error(`claim file not found: ${absClaim}`);
  }
  const raw = fs.readFileSync(absClaim, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`claim file is not valid JSON: ${err.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("claim file must be a JSON object");
  }
  if (typeof parsed.experiment_id !== "string" || !parsed.experiment_id.trim()) {
    throw new Error("claim.experiment_id is required");
  }
  if (typeof parsed.title !== "string" || !parsed.title.trim()) {
    throw new Error("claim.title is required");
  }
  if (!Array.isArray(parsed.commands) || parsed.commands.length === 0) {
    throw new Error("claim.commands must be a non-empty array");
  }
  parsed.commands = parsed.commands.map((command, index) => normalizeCommand(command, index));
  return parsed;
}

function normalizeCommand(command, index) {
  if (!command || typeof command !== "object") {
    throw new Error(`commands[${index}] must be an object`);
  }
  if (typeof command.run !== "string" || !command.run.trim()) {
    throw new Error(`commands[${index}].run is required`);
  }
  if (!Number.isInteger(command.expect_exit)) {
    throw new Error(`commands[${index}].expect_exit must be an integer`);
  }
  const timeout = command.timeout_s === undefined ? 60 : command.timeout_s;
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error(`commands[${index}].timeout_s must be a positive integer`);
  }
  return {
    run: command.run.trim(),
    cwd: typeof command.cwd === "string" && command.cwd.trim() ? command.cwd : ".",
    expect_exit: command.expect_exit,
    timeout_s: timeout,
  };
}

function runDeclaredCommand(spec, repoCwd) {
  const cwd = path.resolve(repoCwd, spec.cwd);
  const argv = spec.run.split(/\s+/).filter(Boolean);
  const bin = argv[0];
  const args = argv.slice(1);

  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(bin, args, {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(payload);
    };

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, spec.timeout_s * 1000);

    child.on("error", (err) => {
      clearTimeout(timer);
      finish({
        exit: null,
        stdout,
        stderr,
        wall_ms: Date.now() - started,
        timed_out: false,
        spawn_error: err.message,
      });
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finish({
        exit: typeof code === "number" ? code : null,
        stdout,
        stderr,
        wall_ms: Date.now() - started,
        timed_out: timedOut,
        spawn_error: null,
      });
    });
  });
}

function decideResult(commands) {
  for (const command of commands) {
    if (command.timed_out || command.spawn_error || command.measured_exit === null) {
      return RESULT.INCONCLUSIVE;
    }
  }
  for (const command of commands) {
    if (command.measured_exit !== command.expect_exit) {
      return RESULT.REJECTED;
    }
  }
  return RESULT.VERIFIED;
}

function summarizeMeasured(commands) {
  return commands
    .map(
      (command) =>
        `${command.run}: expected ${command.expect_exit}, measured ${command.measured_exit}`
    )
    .join("; ");
}

// `argv` is what was actually invoked; `command` is the portable equivalent a
// stranger can paste from a cold clone. `npm_script` is set when run via npm.
function describeRerun(invocation, claimPathRel) {
  const source = invocation || {};
  const parts = ["node", "./bin/apl.js", "prove", claimPathRel];
  if (source.require_result) {
    parts.push("--require-result", source.require_result);
  }
  return {
    command: parts.join(" "),
    npm_script: source.npm_script || null,
    cwd: ".",
    argv: Array.isArray(source.argv) ? source.argv : [],
  };
}

function assertPacketComplete(packet) {
  const missing = REQUIRED_PACKET_FIELDS.filter((field) => isEmpty(dig(packet, field)));
  if (!Array.isArray(packet.commands) || packet.commands.length === 0) {
    missing.push("commands");
  } else {
    packet.commands.forEach((command, index) => {
      for (const field of REQUIRED_COMMAND_FIELDS) {
        if (isEmpty(command[field])) {
          missing.push(`commands[${index}].${field}`);
        }
      }
      if (!("measured_exit" in command)) {
        missing.push(`commands[${index}].measured_exit`);
      }
    });
  }
  if (missing.length > 0) {
    throw new Error(`packet is missing required fields: ${missing.join(", ")}`);
  }
}

function dig(object, dottedPath) {
  return dottedPath.split(".").reduce((node, key) => (node == null ? node : node[key]), object);
}

function isEmpty(value) {
  return value === undefined || value === null || value === "";
}

function createRunDir(cwd, experimentId, startedAt) {
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const runDir = path.join(cwd, "evidence", "runs", experimentId, stamp);
  fs.mkdirSync(runDir, { recursive: true });
  return runDir;
}

function writeCommandLog(runDir, index, spec, measured) {
  const logPath = path.join(runDir, `cmd-${index}.log`);
  const body = [
    `run: ${spec.run}`,
    `cwd: ${spec.cwd}`,
    `expect_exit: ${spec.expect_exit}`,
    `measured_exit: ${measured.exit === null ? "null" : measured.exit}`,
    `timed_out: ${measured.timed_out}`,
    `spawn_error: ${measured.spawn_error || ""}`,
    `wall_ms: ${measured.wall_ms}`,
    "",
    "----- stdout -----",
    measured.stdout,
    "----- stderr -----",
    measured.stderr,
    "",
  ].join("\n");
  fs.writeFileSync(logPath, body);
  return logPath;
}

function gitSha(cwd) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function rel(cwd, absPath) {
  return path.relative(cwd, absPath) || ".";
}

module.exports = {
  proveClaim,
  RESULT,
};
