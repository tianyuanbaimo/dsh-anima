# Changelog

## 0.4.0

摘要索引 + 细节外挂：

- 数据模型：cards.jsonl 存卡片（标题/摘要/实体/关键词/类型/归属/权重），facts.jsonl 存挂在卡下的细节；不存聊天原文切片，细节按需用 soul_card 展开；旧 memory.jsonl 首次启动自动迁移。
- 写入流水线：显式"记住…"立刻落卡；话题终结（相邻两轮词重叠 < 0.12）与 5 分钟空闲（idleWriteMs）把话题压成一张卡；低信息量闲聊不占卡；关键词兜底判类型；≥0.85 相似度合并去重。
- 读取三路：人格 + 最近 5 张卡 + 相关 Top-3（检索 Top-10 → 可选本地小模型重排 → 取 3），2000 字硬预算；重排带 10 分钟缓存、2 秒超时降级、启动预热。
- 归属隔离：每张卡带 owner，私聊卡在群里查不到。
- 软遗忘：三因子（0.7 语义 / 0.2 新鲜 / 0.1 频率）；90 天没用、命中 <2、权重 ≤3、非重要的卡自动归档；rule 与 important 永不软遗忘。
- 转生：上下文到 rebirthAt（默认 32000 tokens）时，本轮收尾后生成项目交接并新建下一个项目会话；新会话开头读一次交接。
- 新工具 soul_card；新命令 /soul cards|card|stats|sweep；/soul status 改为卡片口径。
- 自测 108 项全绿：smoke 24 / test-v4 31 / test-upgrade 32 / test-handoff 21。

## 0.3.0

Project handoffs: when this context window is nearly full, the project gets wrapped up instead of losing the thread.

- **Context pressure watch**: reads `ctx.tokenMeter.measure(session)` against the model window (from `request/context` or `llm.resolveModelInfo()`), arming at `handoffAt` (default `0.95`).
- **Wait for the project to finish**: while a tool call is still pending, nothing happens. The handoff fires on the `turn/end` that completes the armed project, so work is never cut mid-sentence.
- **Structured handoff**: goal, decisions, recent progress, touched paths, unfinished todos — written to `handoffs/<time>-<id>.md` plus a line in `handoffs.jsonl`, and decisions/todos are fed back into long-term memory (`tags: ["handoff"]`), so memory and handoff never disagree.
- **Read once, then forget**: the newest handoff is injected as `## 上一个项目的交接` only in a session that has no episodes yet; after the first turn it drops out of the block, keeping the prefix cache warm.
- **Nudge instead of silence**: while armed, the block carries `## 上下文水位告警` telling the model to wrap up and call `soul_handoff`.
- **New tool** `soul_handoff` and `/soul handoff [now|status]` for manual handoffs and listing recent ones.
- **Degrades honestly**: `ctx.sessions.create` is attempted when `handoffNewSession` is on; if the host refuses (a live session usually needs an agent handle), the handoff is still on disk and the next session picks it up.
- New `scripts/test-handoff.mjs` — 21 assertions driving the full chain with a fake host (pressure → arm → wait → handoff → injection).
- `smoke.mjs` / `test-upgrade.mjs` tool-count assertions updated for the fifth tool.

## 0.2.0

Memory gets maintenance, and the prompt gets layers. Nothing is ever hard-deleted.

- **Memory consolidation** (`consolidate`, `/soul merge [dry]`): same-type memories whose token sets overlap ≥ 0.75 (`jaccard`) are merged into the highest-weight/longest one — hits summed, tags unioned — and the rest are archived with `mergedInto`. `autoConsolidate` runs it once after startup when live memories exceed `consolidateAt`.
- **Dormancy** (`dormantMemories`, `wakeMemory`, `/soul dormant`, `/soul wake`): weight ≤ 2, fewer than 2 hits, and untouched for `decayDays` (default 120) → dropped from resident injection but still searchable, with a small rank penalty.
- **Layered injection**: besides resident memories, the block now carries `## 和眼下这件事有关的记忆`, retrieved from the session title's tokens and frozen per session so the system-prompt prefix stays stable.
- **Better recall**: `idf` weighting rewards rare shared tokens, `hits`/`lastHitAt` are now persisted (batched, flushed on dispose), and `soul_recall` takes a `tags` filter.
- **Backup & migration**: `/soul export` writes a Markdown snapshot into the data dir; `/soul import <path>` accepts JSONL or JSON (including a previous export) and skips duplicates.
- **Persona history**: `/soul snapshots` lists snapshots, `/soul rollback [n|name]` restores one (and snapshots the current version first, so rollback is itself reversible).
- **Stats**: `/soul stats` and `state.stats()` report type/weight distribution, hits, dormancy and decay settings; `/soul status` now shows dormant count too.
- **Fixed**: budget trimming could return text longer than `promptMaxChars` (the loop only cut whole sections); trimming is now stepped and hard-truncates as a last resort.
- **Fixed**: the injected block is now guaranteed to keep the persona even when memories/episodes are trimmed away.
- Schema 2 on disk (`state.schema`), migrated in place on load.
- New `scripts/test-upgrade.mjs` — 32 assertions covering consolidation, dormancy, rollback, export/import, layered injection and budget trimming.

## 0.1.1

Fix: episodes were never written in a real host (always `0`), even though the smoke test passed.

- Root cause: the host's `user/message` event has **no `turn` field** (`assistant/message` and `turn/end` do), so buffering by `${sessionId}:${turn}` put the user text under `:0` while `turn/end` looked for `:N`. Records never matched.
- Capture now queues one record per turn per session and pairs `turn/end` with the latest real user message, instead of trusting turn numbers.
- `assistant/message` content mixes `reasoning` and `text` parts; only `type: "text"` is captured now, so thinking-out-loud never lands in an episode.
- Injected host context (`Current runtime context.`, `Time sampled while preparing…`, `<system-reminder>`) is filtered out so episodes contain what the user actually said.
- `/soul status` shows capture counters (user / assistant / turn-end / episodes / skipped) so the pipeline is observable without reading logs.
- New `scripts/replay.mjs`: replays a decoded session log through the plugin to verify capture without restarting DSH.
- Smoke test gained two regression cases modelled on the real event shapes.

## 0.1.0

First public release.

- Resident system-prompt injection of persona, top memories and recent episodes, cached by persona/memory revision so it stays KV-cache friendly.
- Passive capture from `session/event`: episodes on `turn/end`, explicit cues promoted to long-term memories.
- Tools: `soul_remember`, `soul_recall`, `soul_forget`, `soul_reflect`.
- Command: `/soul` with `status`, `remember`, `recall`, `forget`, `persona`, `journal`, `export`, `help`.
- Storage: append-only JSONL with atomic writes, dedupe, compaction, 800-episode window, 40 persona snapshots.
- Zero runtime dependencies; only `node:fs` and `node:path`.
- Market index (`market/index.json`, format 1) discoverable through a custom index source.
