# agent-proof-layer

Tiny claim runner for **Exp-1**. It executes commands declared in a claim file and emits `VERIFIED`, `REJECTED`, or `INCONCLUSIVE` with measured exit codes, a commit SHA, and a log path.

This is not a dashboard, plugin host, or multi-agent OS. `verdict` is reserved for Eng Proof; the CLI only reports a measured `runner_result`.

## Stranger re-run (cold checkout, <2 minutes)

Requires Node 18+. No `npm install` — there are no runtime dependencies.

```bash
git clone https://github.com/nyfeblade/agent-proof-layer.git
cd agent-proof-layer
npm run demo:reject
```

Three commands on default `main` — no branch checkout, no install step.

Equivalent:

```bash
node ./bin/apl.js prove claims/planted-false.json --require-result REJECTED
```

Expected stdout (first line must be `REJECTED`):

```
REJECTED
commit: <git sha>
packet: evidence/runs/exp-1-planted-false/<timestamp>/packet.json
wall_ms: <number>
command: node fixtures/failing.js
  expected_exit: 0
  measured_exit: 1
  log: evidence/runs/exp-1-planted-false/<timestamp>/cmd-0.log
```

`demo:reject` exits 0 only if the runner prints `REJECTED`. The planted-false fixture exits `1` while the claim expects `0`.

## Claim file

JSON object:

| field | meaning |
| --- | --- |
| `experiment_id` | id used under `evidence/runs/` |
| `title` | human label |
| `commands[].run` | argv string, split on whitespace (`node fixtures/failing.js`) |
| `commands[].cwd` | relative working directory (default `.`) |
| `commands[].expect_exit` | integer the claim asserts |
| `commands[].timeout_s` | kill after N seconds (default 60) |

## Packet

Each run writes `evidence/runs/<experiment_id>/<timestamp>/packet.json` plus per-command logs. `evidence/runs/` is gitignored — every stranger generates their own. A committed exemplar of the current shape lives at `evidence/exp-1-agent-proof-layer/cold-clone-run/packet.json`, measured from a cold clone; `evidence/exp-1-agent-proof-layer/spike-run/packet.json` is the older spike run, kept as-is. Experiment-level fields for Eng Proof live in `evidence/exp-1-agent-proof-layer/packet.json`.

Every packet carries the fields needed to re-run it without asking the author. The runner refuses to write a packet that is missing any of them:

| field | meaning |
| --- | --- |
| `schema_version` | packet shape (`1`) |
| `experiment_id`, `title` | what was run |
| `claim_path` | the claim file, repo-relative |
| `rerun.command` | pasteable re-run from a cold clone |
| `rerun.npm_script` | npm script name if invoked via npm, else `null` |
| `rerun.argv` | argv as actually invoked (measured) |
| `command[]` | claim as declared |
| `commands[]` | per command: `run`, `cwd`, `expect_exit`, `measured_exit`, `wall_ms`, `log_path` |
| `runner_result` | `VERIFIED` \| `REJECTED` \| `INCONCLUSIVE` |
| `result.logs_uri`, `result.wall_ms` | log directory and total wall time |
| `provenance.commit` | git SHA at run time |
| `provenance.started_at`, `ended_at`, `node_version`, `platform` | when and where |

`verdict` is always written as `null` with `verdict_by: "Eng Proof"`. The authoring agent does not set it.
