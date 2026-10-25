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
https://cdn.jsdelivr.net/npm/dsh-anima/market/index.json
```

then install **dsh-anima** from Discover.

From a shell:

```sh
dsh plugin --profile web add dsh-anima
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
3. **Active read/write** — four tools plus a `/soul` command.

| Tool | Purpose |
| --- | --- |
| `soul_remember` | write a long-term memory (type / weight / tags) |
| `soul_recall` | search memories (CJK bigrams + latin words, ranked by weight and hits) |
| `soul_forget` | archive a memory (not a hard delete) |
| `soul_reflect` | replace the persona (snapshot first) or append a journal note |

| Command | Purpose |
| --- | --- |
| `/soul` | status: persona version, counts, data dir |
| `/soul remember <text>` / `recall` / `forget` | manual memory management |
| `/soul persona` / `journal` / `export` / `help` | inspect, export |

## Configuration

Override keys in your profile's `cordis.patch.yml`:

```yaml
- id: soul
  name: dsh-anima
  config:
    dataDir: "D:/my-soul"   # default ~/.dsh/anima ($DSH_HOME wins)
    promptMaxChars: 4000
    injectMemories: 24
    injectEpisodes: 6
    captureEpisodes: true
    captureCues: true
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

Backup = copy the directory. Migrate = change `dataDir`. Start over = delete it.

## Design notes

- **`node:fs` only, zero dependencies** — no `@deepseek-ai/*` imports, so a host upgrade or an unresolved package cannot take the whole plugin down.
- **No `ctx.storage`** — that hub needs extra backend and form wiring; plain files are simpler, portable and legible to humans.
- **Cache-safe injection** — the soul block is request prefix, so it is only rebuilt when the persona or memory revision changes.
- **Failures are loud** — any tool that fails to register prints `[dsh-anima] FATAL ...` instead of degrading silently.
- **Precision over recall** — a search with no overlap returns nothing rather than padding with unrelated memories.

## Privacy

Everything stays in `dataDir`; the plugin makes no network requests. Memories are injected into your own model requests, so treat them like anything else you type — do not store secrets in them. Use `/soul export` to audit or move your data.

## Compatibility

DSH `>= 0.2.0` (verified on 0.2.1), Node `>= 22` (bundled with DSH). Host half only — no client bundle — so it installs into any profile (`web`, `headless`, `desktop`).

## Development

```sh
node scripts/smoke.mjs   # 34 assertions against a fake ctx; DSH need not be running
```

## License

MIT — see [LICENSE](LICENSE).
