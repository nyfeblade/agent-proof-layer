# agent-proof-layer

Tiny claim runner for **Exp-1**. It executes commands declared in a claim file and emits `VERIFIED`, `REJECTED`, or `INCONCLUSIVE` with measured exit codes, a commit SHA, and a log path.

This is not a dashboard, plugin host, or multi-agent OS. `verdict` is reserved for Eng Proof; the CLI only reports a measured `runner_result`.

## Stranger re-run (cold checkout, <2 minutes)

Requires Node 18+. No `npm install` — there are no runtime dependencies.

```bash
git clone https://github.com/nyfeblade/agent-proof-layer.git
cd agent-proof-layer
git checkout cursor/exp-1-agent-proof-layer-cd66
npm run demo:reject
```

After merge to `main`, drop the `git checkout` line.

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

Each run writes `evidence/runs/<experiment_id>/<timestamp>/packet.json` plus per-command logs. Experiment-level fields for Eng Proof live in `evidence/exp-1-agent-proof-layer/packet.json`. The authoring agent does not set `verdict`.
