# dsh-anima · a soul for DeepSeek Harness

English | [中文](README.zh.md)

Persistent persona and long-term memory for [DeepSeek Harness](https://github.com/deepseek-ai). Shut the computer down, come back tomorrow, open a new session, let the context get compacted — it is still *itself*. It remembers who it is, and what happened between you.

Everything lives in plain files on disk: readable, editable, backup-able, revertible.

---

## The problem

In stock DSH, persona and memory belong to a session. A new session, a restart, or a compaction resets them — so you reintroduce yourself, restate your preferences, and re-explain the project every time.

| Lost by default | With dsh-anima |
| --- | --- |
| Context after the conversation ends | finished turns are compressed into episodes on disk, picked up at the next session start |
| Important preferences and facts | explicit cues are promoted to weighted long-term memories; the model can also write them itself |
| A stable persona | persona lives in `persona.md` with a version, snapshots and rollback |
| New session = amnesia | memory is global: present in every session and after every restart |

## Install

From the plugin market: **Plugins → Discover → Index sources**, add

```
https://raw.githubusercontent.com/tianyuanbaimo/dsh-anima/main/market/index.json
```

then install **dsh-anima** from Discover. For a pinned, reproducible index use
`https://cdn.jsdelivr.net/gh/tianyuanbaimo/dsh-anima@<commit>/market/index.json`.

The index installs from a **git source**, so `git` must be on PATH (Git for Windows or a
portable MinGit).

From a shell:

```sh
# git source (no npm release needed)
dsh plugin --profile desktop add "git+https://github.com/tianyuanbaimo/dsh-anima.git#<commit>"

# once published to npm
dsh plugin --profile desktop add dsh-anima
```

From a source checkout (development):

```sh
dsh plugin --profile desktop add "link:/path/to/dsh-anima"
```

Restart DSH once. The startup log prints:

```
[dsh-anima] ready · persona v1 · 0 memories / 0 episodes · tools 4/4 · ~/.dsh/anima
```

## How it works

Three injection points, no changes to the host:

1. **Resident injection** — a `systemPrompt.section('soul:identity')` block carrying persona, top memories and recent episodes. It is cached by `persona revision + memory revision + session id`, so the text is frozen inside a session (KV-cache friendly) and rebuilt only when the soul actually changes.
2. **Passive capture** — a `session/event` listener turns finished turns into episodes at zero token cost, and promotes explicit cues ("remember this", "I prefer…", "my name is…") into weighted long-term memories.
3. **Active read/write** — five tools plus a `/soul` command.

| Tool | Purpose |
| --- | --- |
| `soul_remember` | write a long-term memory (type / weight / tags) |
| `soul_recall` | search memories (CJK bigrams + latin words, `idf`-weighted, ranked by weight and hits; `tags` filter) |
| `soul_forget` | archive a memory (not a hard delete) |
| `soul_reflect` | replace the persona (snapshot first) or append a journal note |
| `soul_handoff` | write this project's handoff (goal / decisions / progress / paths / todos) and feed it back into memory |

## Project handoffs (v0.3)

Running out of context is survivable; losing track of where the project stood is not.

1. **Watch the water line** — every turn compares `ctx.tokenMeter.measure(session)` against the model window (from `request/context` or `llm.resolveModelInfo()`); at `handoffAt` (default `0.95`) the session is armed.
2. **Wait for the project to finish** — while a tool call is still pending nothing happens; the handoff fires on the `turn/end` that completes the armed work, so a job is never cut mid-sentence.
3. **Hand off, then read once** — goal, decisions, recent progress, touched paths and unfinished todos go to `handoffs/<time>-<id>.md` plus a JSON line; decisions and todos are fed back into long-term memory (`tags: ["handoff"]`). The next project sees it once as `## 上一个项目的交接` on its first turn and then it drops out of the block — read once, never resident, prefix cache intact.

While armed, the block carries `## 上下文水位告警` telling the model to wrap up instead of opening new threads. Manual: the `soul_handoff` tool or `/soul handoff now`.

> Opening the next project tries `ctx.sessions.create`; if the host refuses (a live session wants an agent handle) the handoff still lands on disk and the next session picks it up — no pretending.

## Memory upkeep (v0.2)

Long-lived memory accumulates duplicates and dead weight. Two mechanisms run automatically, and **neither deletes anything**:

- **Consolidation** — same-type memories whose token sets overlap ≥ 0.75 are merged into the highest-weight/longest one (hits summed, tags unioned); the rest are archived with `mergedInto`. `/soul merge` runs it on demand, `/soul merge dry` previews, and `autoConsolidate` fires once after startup when live memories exceed `consolidateAt`.
- **Dormancy** — memories with weight ≤ 2, fewer than 2 hits and no use for `decayDays` drop out of resident injection, but stay searchable, listable (`/soul dormant`) and wakeable (`/soul wake <id>`).

Injection is layered: resident memories under `## 我记得的事`, plus `## 和眼下这件事有关的记忆` retrieved from the session topic and frozen per session.

| Command | Purpose |
| --- | --- |
| `/soul` | status: persona version, counts, data dir |
| `/soul stats` | type/weight distribution, hits, dormancy |
| `/soul remember <text>` / `recall` / `forget` | manual memory management |
| `/soul merge [dry]` | merge duplicate memories (preview with `dry`) |
| `/soul handoff [now\|status]` | write this project's handoff / list recent handoffs |
| `/soul dormant` / `wake <id>` | inspect and wake dormant memories |
| `/soul persona` / `journal` | inspect |
| `/soul snapshots` / `rollback [n\|name]` | persona history and restore |
| `/soul export` / `import <path>` | Markdown backup, JSONL/JSON import |
| `/soul help` | help |

## Configuration

Override keys in your profile's `cordis.patch.yml`:

```yaml
- id: soul
  name: dsh-anima
  config:
    dataDir: "D:/my-soul"   # default ~/.dsh/anima ($DSH_HOME wins)
    promptMaxChars: 4000    # injection budget: trims related memories, then episodes, then residents
    injectMemories: 24      # resident memories
    injectRelevant: 6       # topic-retrieved memories (0 disables)
    injectEpisodes: 6       # resident episodes
    captureEpisodes: true
    captureCues: true
    autoConsolidate: true   # merge duplicates automatically
    consolidateAt: 300      # live-memory threshold for the auto pass
    decayDays: 120          # low-weight memories sleep after this many idle days
    handoffAt: 0.95         # arm a project handoff at this context pressure
    autoHandoff: true       # hand off automatically once the armed project finishes
    handoffNewSession: true # try to open a fresh project session (else disk only)
    inject: true
    sectionOrder: 10050
```

## Data

All human-readable, inside `dataDir`:

| File | Content |
| --- | --- |
| `persona.md` | persona / self-narrative, hand-editable |
| `memory.jsonl` | long-term memories, one JSON object per line, append-only with compaction |
| `episodes.jsonl` | dialogue episodes |
| `journal.md` | growth log |
| `state.json` | session index, counters, persona version |
| `snapshots/` | persona snapshots taken before every rewrite (last 40 kept) |
| `handoffs.jsonl` | project handoffs, one structured record per line |
| `handoffs/` | the same handoffs as readable Markdown |

Backup = copy the directory. Migrate = change `dataDir`. Start over = delete it.

## Design notes

- **`node:fs` only, zero dependencies** — no `@deepseek-ai/*` imports, so a host upgrade or an unresolved package cannot take the whole plugin down.
- **No `ctx.storage`** — that hub needs extra backend and form wiring; plain files are simpler, portable and legible to humans.
- **Cache-safe injection** — the soul block is request prefix, so it is only rebuilt when the persona or memory revision changes.
- **Failures are loud** — any tool that fails to register prints `[dsh-anima] FATAL ...` instead of degrading silently.
- **Precision over recall** — a search with no overlap returns nothing rather than padding with unrelated memories.
- **Upkeep never destroys** — consolidation and dormancy archive; originals stay in `memory.jsonl` and remain importable/searchable.
- **Hits are batched** — recall is frequent, so `hits`/`lastHitAt` are flushed 800 ms after the last hit (and on dispose) instead of rewriting JSONL per query.
- **Handoffs wait for the project to finish** — arming at 95% never interrupts; only a `turn/end` with no pending tool calls fires the handoff. One turn late beats a severed task.

## Privacy

Everything stays in `dataDir`; the plugin makes no network requests. Memories are injected into your own model requests, so treat them like anything else you type — do not store secrets in them. Use `/soul export` to audit or move your data.

## Compatibility

DSH `>= 0.2.0` (verified on 0.2.1), Node `>= 22` (bundled with DSH). Host half only — no client bundle — so it installs into any profile (`web`, `headless`, `desktop`).

## Development

```sh
node scripts/smoke.mjs         # 34 assertions against a fake ctx; DSH need not be running
node scripts/test-upgrade.mjs  # 32 assertions for v0.2 (consolidation, dormancy, rollback, import/export, layered injection)
node scripts/test-handoff.mjs  # 21 assertions for v0.3 (pressure → arm → wait → handoff → read once)
```

## License

MIT — see [LICENSE](LICENSE).
