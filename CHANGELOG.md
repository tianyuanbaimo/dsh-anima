# Changelog

## 0.1.0

First public release.

- Resident system-prompt injection of persona, top memories and recent episodes, cached by persona/memory revision so it stays KV-cache friendly.
- Passive capture from `session/event`: episodes on `turn/end`, explicit cues promoted to long-term memories.
- Tools: `soul_remember`, `soul_recall`, `soul_forget`, `soul_reflect`.
- Command: `/soul` with `status`, `remember`, `recall`, `forget`, `persona`, `journal`, `export`, `help`.
- Storage: append-only JSONL with atomic writes, dedupe, compaction, 800-episode window, 40 persona snapshots.
- Zero runtime dependencies; only `node:fs` and `node:path`.
- Market index (`market/index.json`, format 1) discoverable through a custom index source.
