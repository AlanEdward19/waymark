# ADR-0004: Teammates: Waymark composes the pipeline, the operator's runtime does the work

- Status: Accepted
- Date: 2026-11-02

## Context

Teams want AI teammates that do real work from a chat mention or the CLI. An example:

1. A manager notices blank currency data in an add-in and mentions the bot in Teams.
2. The teammate works out that the data comes from service X, which is fed by CDC replication of
   another system's database through project Y.
3. It calls the API, then the service database, then the source database, and finds the gap in the
   replication.
4. It reads project Y's logs and code, and tells whether a commit introduced the bug.
5. It then proposes a fix, or writes the card a human needs.

Companies that run such "agentic factories" in production share one architecture:

- a **work plane** (intake, system of record);
- a **control plane** (contract, dispatcher, identity);
- an **execution plane** (runtime, capabilities, instructions);
- a **quality plane** (gates, observability, evals);
- a cross-cutting **brain**: company knowledge shared by people and agents.

Waymark already is the brain:

- sources, hybrid search and MCP;
- agent hooks, handoffs and organisational memory (#16);
- its own identity at each source (ADR-0002);
- users, linked chat identities and tokens (ADR-0003);
- a team server (#95) and chat bots (#19) on the way.

Two constraints shape the rest:

- **Waymark is self-hosted.** Every byte of infra (VMs, model API keys, CI minutes) belongs to the
  team running it, and the team picks its own agent runtime. Examples: a 24/7 VM with Hermes Agent, a
  Claude API key used by Claude Code, or any other CLI agent.
- **Building an agent loop or a sandbox is out of reach** and out of place. Mature runtimes exist,
  and running untrusted agent code safely is a product of its own.

## Decision

### 1. Responsibilities

| Waymark does                                                                            | The operator's runtime and infra do                         |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Teammate definition: name, chat persona, Waymark user, runtime, playbooks               | The agent loop and the model                                |
| Triggers: CLI, chat mention, API (for a schedule, the OS scheduler or CI calls the CLI) | Sandboxing and isolation of the machine that runs the agent |
| Playbooks: stages, instructions, allowed tools, budgets, routing, autonomy level        | The real tools: databases, APIs, logs, CI/CD                |
| Context: system map, search, experts, conventions, past runs                            | Model API keys and runtime secrets                          |
| Tool gateway: one MCP endpoint per run, allow-listed and audited                        | Deployments (through its own CD)                            |
| Run state, routing between stages, reports, cards, audit                                |                                                             |

Waymark never executes model-generated code or shell commands itself. It never holds the runtime's
model API keys.

### 2. Teammate

A teammate is configured in `config.json` and validated by zod like every other section:

```json
{
  "teammates": [
    {
      "name": "atlas",
      "user": "atlas",
      "runtime": "claude-code",
      "playbooks": ["investigate-data-gap"],
      "defaultPlaybook": "investigate-data-gap",
      "access": { "groups": ["data-ops"] }
    }
  ]
}
```

- **`user`:** a Waymark user (ADR-0003) the teammate acts as. Source visibility (#97), attribution
  and audit all use this user. Its chat persona is the bot of the platform it is mentioned on (#19).
- **`runtime`:** the name of a runtime adapter configured on a runner (§6).
- **`access.groups`:** who may start runs. Admins always may.
- **`defaultPlaybook`:** started by a chat mention. Without it, the bot only answers questions (#101).

### 3. Playbooks

A playbook is a YAML file at `$WAYMARK_HOME/playbooks/<name>.yaml`. It is meant to be versioned in
git and edited by hand or by any editor, and Waymark exports a JSON Schema for editors.

```yaml
version: 1
name: investigate-data-gap
description: Find why data is missing and where the chain broke
autonomy: observe # observe | propose — v1 accepts only observe
card: { github: acme/data-platform } # where `goto: card` files the write-up
inputs:
  request: { type: string, required: true }
stages:
  - id: diagnose
    instructions: |
      Trace the data from where the user saw it back to its origin.
      Prove each hop with a tool call before moving on.
    tools: [waymark, currency-db__query, replica-db__query, cdc-logs__search] # `waymark` = all waymark__* tools; `server` = every allowed tool of that server
    budget: { maxTurns: 60, maxMinutes: 30, maxCostUsd: 3 }
    next:
      - when: { outcome: root_cause_found }
        goto: report
      - when: { outcome: needs_human }
        goto: card
      - goto: report
```

- Stage `id`s and playbook names follow the ADR-0003 name regex.
- `goto` targets another stage or a built-in action:
  - `report` replies in the thread and saves the run report.
  - `card` creates an issue with the full write-up.
  - `stop` ends the run.
- `when` matches fields of the stage verdict (§5) by equality. Rules are evaluated in order. A rule
  without `when` is the default.
- **Loops are rejected at validation.** A playbook is a DAG, and every run terminates.
- **Autonomy levels:**
  - `observe`: read-only tools, no writes anywhere except the report and card.
  - `propose`: may open branches and PRs, never merge.
  - v1 implements `observe` only. `propose` is reserved and rejected with an actionable message
    until its phase ships. Merging and deploying without a human are out of scope for the core.

### 4. Context handed to each stage

The prompt of a stage is assembled by Waymark, in this order:

1. The playbook and stage instructions.
2. The run input and the previous stages' verdicts.
3. The tools available and how to finish the stage.

Knowledge is **not** pasted in. The runtime fetches it through the gateway's `waymark` tools:

- `search`, `get_document`;
- `system_map` (§8), `who_knows` (#86), `conventions` (#88);
- past runs, which are wiki documents under `agent/run/`.

Each lookup goes through the access checks of the teammate's user, keeps the prompt small, and is
audited.

### 5. Stage verdict

A stage ends when the runtime calls the gateway tool `waymark__finish_stage` once with a verdict:

```json
{
  "outcome": "root_cause_found",
  "summary": "Replication job of 2026-10-30 failed on a decimal overflow; source rows exist, replica rows do not.",
  "findings": [
    {
      "claim": "API returns null for 2026-10-30",
      "evidence": [{ "tool": "currency-api__get", "ref": "call-3" }]
    }
  ],
  "rootCause": {
    "entity": "component:cdc-y",
    "location": "src/sink/mapper.ts:88",
    "introducedBy": "a1b2c3d"
  },
  "complexity": "low",
  "confidence": 0.8,
  "proposedActions": ["Widen DECIMAL(10,2) to DECIMAL(18,6) in the sink mapper"]
}
```

| Field             | Values                                                                               | Required |
| ----------------- | ------------------------------------------------------------------------------------ | -------- |
| `outcome`         | `resolved`, `root_cause_found`, `needs_human`, `inconclusive`, `failed`              | yes      |
| `summary`         | at most 2 000 characters                                                             | yes      |
| `findings`        | list of claims, each with evidence pointing to gateway tool-call ids or document ids | no       |
| `rootCause`       | `entity`, `location`, `introducedBy`                                                 | no       |
| `complexity`      | `low`, `medium`, `high`                                                              | no       |
| `confidence`      | number from 0 to 1                                                                   | no       |
| `proposedActions` | list of strings                                                                      | no       |

- Every evidence `ref` must exist in the run's tool-call log or the index. Unknown refs are rejected,
  so the runtime has to fix its verdict.
- A stage that ends without a verdict (the runtime exits, the budget runs out, the deadline passes)
  gets `{ outcome: "inconclusive" }` with the runtime's last output as the summary.
- **The verdict is the only channel** between runtime and pipeline. That keeps routing deterministic
  and runtime-agnostic: any agent that speaks MCP can finish a stage.

### 6. Runners and runtime adapters

**Pull-only runners.** `waymark runner` runs on the operator's machine (a VM, a laptop, a CI job).
It authenticates with an ADR-0003 API token of a user listed in config `runners`. It long-polls the
server for jobs over HTTPS, so the machine needs **no inbound port**, the same model as GitHub's
self-hosted runners.

**Protocol.** HTTP JSON under `/api/v1/runner/` on `waymark serve`:

| Call       | Behaviour                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `claim`    | Long-polls up to 30 s. Returns a job or nothing.                                               |
| `events`   | Batches log, tool, message and cost events. Doubles as the heartbeat and returns `{ cancel }`. |
| `complete` | Reports the final status, cost and turns.                                                      |

- A job is leased for 60 s and renewed by events every 15 s. When a lease expires, the stage fails
  with `runner_lost`; v1 does not retry automatically.

**Adapters.** An adapter turns a job into a local process and maps its output to events. v1 ships:

- **`claude-code`:** `claude -p` with `--output-format stream-json`, `--mcp-config` pointing only at
  the run's gateway endpoint (`--strict-mcp-config`), `--max-turns`, `--max-budget-usd`, and the
  stage prompt appended to the system prompt.
- **`hermes`:** submits the stage to the Hermes API server (`/v1/runs`) on the same host. Hermes
  reads MCP servers from its own config, so the runner exposes one stable gateway URL. That URL serves
  the runner's current job, so the concurrency of this adapter is 1.
- **`command`:** any CLI agent. It gets the prompt file path, gateway URL and run token as environment
  variables.

A Claude Agent SDK adapter can follow, as an optional dependency.

Runtime secrets (model keys, `API_SERVER_KEY`) stay in the runner's environment and are never sent
to Waymark.

**Local mode.** `waymark run <playbook> --local` runs the server side and a runner in one process,
bound to loopback. It is for one person and for tests, and needs no `waymark serve`.

### 7. Tool gateway

Each stage gets one MCP endpoint (Streamable HTTP) on the server. It authenticates with a **run
token**:

- format `wmr_` + 32 random bytes in base64url;
- valid for that stage until its deadline;
- stored as SHA-256 only, like ADR-0003 tokens;
- a redaction rule, so a leaked one never reaches the wiki.

The endpoint exposes two kinds of tools:

- **`waymark__*`:** the knowledge tools of §4 plus `finish_stage`, run as the teammate's user.
- **Downstream tools:** from operator-configured MCP servers (`tools` in config, stdio or HTTP). They
  are named `<serverId>__<tool>`, prefixed as the MCP spec recommends for aggregators. Credentials
  come from environment variables, by reference.

**Policy:**

- Default deny. A downstream tool is reachable only if it is in the server's `allow` list **and** in
  the stage's `tools` list.
- MCP tool annotations (`readOnlyHint` and the rest) are hints from possibly untrusted servers. They
  are shown to the model but never used for authorization.
- **Read-only is guaranteed by credentials, not by Waymark.** The docs require read-only database
  users and API keys for `observe` playbooks.

**Every call is audited** (#94) with event `tool.call` and the fields run, stage, tool, outcome and
duration. Arguments are logged only when `audit.toolArgs` is true. Results are capped at 64 KB and
pass through `redact()` before reaching the model.

### 8. System map

The brain needs to know how data flows between systems. Waymark reads catalog files in the
**Backstage descriptor format**:

- file name `catalog-info.yaml`;
- kinds Component, API, Resource and System;
- fields `spec.dependsOn`, `spec.providesApis` and `spec.consumesApis`.

These files live in the repos the git source already syncs. Waymark adds two annotations:

- **`waymark.dev/feeds`:** the entities a component writes to. Backstage has no data-lineage
  direction, and an investigation needs it: CDC project Y feeds the replica database.
- **`waymark.dev/tools`:** gateway tool names that inspect this entity, so the agent knows that
  `replica-db` is checked with `replica-db__query`.

Entities become documents `catalog/<kind>/<name>`. Edges live in a rebuildable index table. The
`waymark__system_map(ref, depth)` tool returns upstream and downstream entities with their owners,
repos, docs and tools.

Waymark does not infer the map with an LLM. Inferred lineage is wrong often enough to send an
investigation to the wrong system. Agents may propose catalog edits (phase 2), and humans merge them.

### 9. Runs

**Run state is state, not cache.** It lives in `$WAYMARK_HOME/runs/runs.db` (SQLite, WAL), backed up
like `auth/`, plus one event log per run in `runs/<id>.jsonl`.

**Life cycle:** `queued` → `running` → per stage `claimed` → `finished` / `failed` / `cancelled` →
`done`.

Every finished run saves a wiki document `agent/run/<id>` with the input, the verdicts and the
evidence. The brain then remembers past investigations, and the next one starts from them.

### 10. Alternatives considered

- **Waymark runs the agent loop itself on the optional LLM client (#89).** Rejected. It means
  re-implementing a harness that runtimes already do better, and tying teams to one style of agent.
- **A workflow engine (Temporal, n8n).** Rejected for v1. It is a heavy dependency for a self-hosted
  tool. Playbooks are a small DAG, and SQLite is enough.
- **GitHub Actions as the only runtime.** Rejected. It does not fit 24/7 agents on a VM or teams
  outside GitHub, though it stays possible through the `command` adapter.
- **Push to runners (inbound webhooks).** Rejected. It needs open ports on the agent machine.
  Pull-only runners need outbound HTTPS only.
- **Authorizing tools by MCP annotations.** Rejected. The MCP spec says annotations from untrusted
  servers must not drive tool-use decisions.
- **Inferring the system map with an LLM.** Rejected for the reason in §8.

## Consequences

- Teams can run teammates on infrastructure they already pay for and switch runtimes without
  changing playbooks.
- v1 is **observe-only**: teammates investigate and report or file cards. Proposing fixes as
  pull requests (`propose`) is a later phase of the same epic.
- The quality of an investigation depends on the system map and on read-only tool coverage.
  Operators must maintain `catalog-info.yaml` and grant read-only credentials.
- **New public contracts that need care when changed:**
  - the playbook format (`version: 1`);
  - the verdict schema;
  - the runner protocol;
  - the `wmr_` run tokens;
  - the `waymark.dev/*` catalog annotations.
- Depends on the team server (#95), audit (#94) and access control (#97). Chat triggers also depend
  on the bot runtime (#102).
