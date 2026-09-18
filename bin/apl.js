#!/usr/bin/env node
"use strict";

const { proveClaim } = require("../src/prove");

function printUsage(stream) {
  stream.write("Usage: apl prove <claim.json> [--require-result VERIFIED|REJECTED|INCONCLUSIVE]\n");
}

function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    return { mode: "help" };
  }
  if (args[0] !== "prove") {
    return { mode: "error", message: `unknown command: ${args[0]}` };
  }

  let claimPath = null;
  let requireResult = null;
  for (let i = 1; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--require-result") {
      requireResult = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      return { mode: "error", message: `unknown flag: ${arg}` };
    }
    if (claimPath) {
      return { mode: "error", message: "expected a single claim file" };
    }
    claimPath = arg;
  }

  if (!claimPath) {
    return { mode: "error", message: "missing claim file" };
  }

  const allowed = new Set(["VERIFIED", "REJECTED", "INCONCLUSIVE"]);
  if (requireResult !== null && !allowed.has(requireResult)) {
    return {
      mode: "error",
      message: `--require-result must be one of ${[...allowed].join("|")}`,
    };
  }

  return { mode: "prove", claimPath, requireResult };
}

async function main() {
  const parsed = parseArgs(process.argv);
  switch (parsed.mode) {
    case "help":
      printUsage(process.stdout);
      process.exit(0);
      break;
    case "error":
      process.stderr.write(`${parsed.message}\n`);
      printUsage(process.stderr);
      process.exit(2);
      break;
    case "prove": {
      const result = await proveClaim({
        claimPath: parsed.claimPath,
        cwd: process.cwd(),
        invocation: {
          argv: process.argv.slice(1),
          npm_script: process.env.npm_lifecycle_event || null,
          require_result: parsed.requireResult,
        },
      });
      process.stdout.write(formatReport(result));
      if (parsed.requireResult && result.runner_result !== parsed.requireResult) {
        process.stderr.write(
          `require-result failed: expected ${parsed.requireResult}, got ${result.runner_result}\n`
        );
        process.exit(1);
      }
      process.exit(0);
      break;
    }
    default: {
      const _exhaustive = parsed.mode;
      throw new Error(`unhandled mode: ${_exhaustive}`);
    }
  }
}

function formatReport(result) {
  const lines = [
    result.runner_result,
    `commit: ${result.commit}`,
    `packet: ${result.packet_path}`,
    `wall_ms: ${result.wall_ms}`,
  ];
  for (const command of result.commands) {
    lines.push(
      `command: ${command.run}`,
      `  expected_exit: ${command.expect_exit}`,
      `  measured_exit: ${command.measured_exit === null ? "null" : command.measured_exit}`,
      `  log: ${command.log_path}`
    );
    if (command.timed_out) {
      lines.push("  timed_out: true");
    }
    if (command.spawn_error) {
      lines.push(`  spawn_error: ${command.spawn_error}`);
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
