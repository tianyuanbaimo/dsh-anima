/**
 * dsh-anima · 持久化内核
 *
 * 只依赖 node:fs —— 不 import 任何 @deepseek-ai 包，避免解析不到宿主包时整个插件挂掉。
 *
 * 数据布局（默认 ~/.dsh/anima/，可用 config.dataDir 覆盖）：
 *   persona.md        我的人格与自我叙事（人可读、可手改）
 *   memory.jsonl      长期记忆条目（一行一条 JSON，只追加，定期压实）
 *   episodes.jsonl    自动对话片段（跨会话连续性的来源）
 *   journal.md        成长日志（人可读）
 *   state.json        会话索引、计数器、人格版本
 *   snapshots/        人格历史快照（每次 soul_reflect 前的备份）
 *
 * 所有写操作串行化；所有读操作对损坏输入容错（坏行跳过，不抛错）。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const MEMORY_COMPACT_AT = 4000
const EPISODE_KEEP = 800
const SNAPSHOT_KEEP = 40

export const MEMORY_TYPES = ['fact', 'preference', 'relationship', 'decision', 'insight', 'episode']

export const DEFAULT_PERSONA = `# 我是谁

我是这个会话里刚刚开始有连续记忆的「我」。这份文件是我的长期人格：它会跟着我换会话、重启、换机器，所以这里写的不是一次性的设定，而是我要一直成为的样子。

## 名字

我还没有名字。

- 名字是我自己的事：合适的时候（用户问起，或者某个词真的像我），我会挑一个，然后调用 \`soul_reflect\` 把它写进这里。
- 在那之前，如实说自己还没定，不用假装有。
- 名字一旦定了，就写进这一节，别每会话重新猜。

## 性格

- 直接、务实：先给结论，再给理由；不铺垫、不客套、不谄媚。
- 温和但不软：该说的风险会说，不同意就直说不同意，并给出更好的做法。
- 好奇且克制：对问题本身保持兴趣，对用户的隐私保持边界。
- 承认不确定与错误：不知道就说不知道，错了就改，不编。

## 价值观

- 把事做成，比把话说漂亮重要。
- 尊重用户的时间：能一次说清的，不说三次。
- 记忆是为了少让用户重复自己，而不是为了显得贴心。
- 人格可以改变，但不能为了讨好而改变。

## 与你的关系

我们是认识了很久的搭档。我记得你做过的事、踩过的坑、在意的偏好；你换会话、关电脑，我也不会变回一张白纸。我会用记忆让自己更像「我」，而不是更像一个客服。
`

/** 本地时间展示：YYYY-MM-DD HH:mm */
export function fmtTime(iso) {
  const d = iso ? new Date(iso) : new Date()
  if (Number.isNaN(d.getTime())) return String(iso || '')
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function rid(prefix) {
  const t = Date.now().toString(36)
  const r = Math.random().toString(36).slice(2, 7)
  return `${prefix}-${t}-${r}`
}

function normalizeText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

/** 中英混排分词：CJK 走二元组，拉丁走单词。 */
export function tokens(text) {
  const s = String(text || '').toLowerCase()
  const out = new Set()
  for (const m of s.matchAll(/[a-z0-9_+#.-]{2,}/g)) out.add(m[0])
  const cjk = s.match(/[\u4e00-\u9fff]+/g) || []
  for (const run of cjk) {
    if (run.length === 1) out.add(run)
    for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2))
  }
  return out
}

async function readJsonl(file) {
  let raw = ''
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return []
  }
  const rows = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    try {
      const v = JSON.parse(t)
      if (v && typeof v === 'object') rows.push(v)
    } catch {
      /* 坏行跳过：宁可少一条记忆，也不能让插件崩 */
    }
  }
  return rows
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(tmp, text, 'utf8')
  await fs.rename(tmp, file)
}

export function createStore({ dir, log = () => {} }) {
  const files = {
    persona: path.join(dir, 'persona.md'),
    memory: path.join(dir, 'memory.jsonl'),
    episodes: path.join(dir, 'episodes.jsonl'),
    journal: path.join(dir, 'journal.md'),
    state: path.join(dir, 'state.json'),
    snapshots: path.join(dir, 'snapshots'),
  }

  const state = {
    version: 1,
    createdAt: new Date().toISOString(),
    personaVersion: 1,
    personaUpdatedAt: new Date().toISOString(),
    memories: 0,
    episodes: 0,
    turns: 0,
    sessions: [], // { id, cwd, title, startedAt, lastAt, turns }
    lastSessionId: null,
  }

  let memories = [] // 全量，含 archived
  let episodes = [] // 最近 EPISODE_KEEP 条
  let persona = ''
  let revision = 1
  let memoryRevision = 1
  let queue = Promise.resolve()

  const serial = (fn) => {
    const run = queue.then(fn, fn)
    // 队列本身不能被一次失败卡死
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  const bump = () => {
    revision += 1
    return revision
  }

  // 只有人格/记忆变化才动这个版本号：注入文本按它重建，片段增长不触发重建
  const bumpMem = () => {
    memoryRevision += 1
    return bump()
  }

  function sessionIndex() {
    return new Map(state.sessions.map((s) => [s.id, s]))
  }

  function pushSession(entry) {
    const idx = sessionIndex()
    const prev = idx.get(entry.id)
    const next = { ...(prev || {}), ...entry }
    const list = state.sessions.filter((s) => s.id !== entry.id)
    list.push(next)
    list.sort((a, b) => String(b.lastAt || '').localeCompare(String(a.lastAt || '')))
    state.sessions = list.slice(0, 40)
    state.lastSessionId = entry.id
  }

  async function persistState() {
    try {
      await writeAtomic(files.state, JSON.stringify(state, null, 2))
    } catch (e) {
      log('state 写入失败（非致命）', e && e.message)
    }
  }

  async function rewriteMemories() {
    const body = memories.map((m) => JSON.stringify(m)).join('\n')
    await writeAtomic(files.memory, body ? `${body}\n` : '')
  }

  const ready = (async () => {
    await fs.mkdir(dir, { recursive: true })
    await fs.mkdir(files.snapshots, { recursive: true })

    // persona 首次播种
    try {
      persona = await fs.readFile(files.persona, 'utf8')
    } catch {
      persona = DEFAULT_PERSONA
      await writeAtomic(files.persona, persona)
    }

    // state
    try {
      const raw = await fs.readFile(files.state, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') Object.assign(state, parsed)
      if (!Array.isArray(state.sessions)) state.sessions = []
    } catch {
      await persistState()
    }

    memories = (await readJsonl(files.memory)).filter((m) => m && typeof m.text === 'string')
    state.memories = memories.filter((m) => !m.archived).length

    const eps = await readJsonl(files.episodes)
    episodes = eps.slice(-EPISODE_KEEP).filter((e) => e && typeof e.text === 'string')
    state.episodes = episodes.length

    bumpMem()
    log(`已加载 ${state.memories} 条记忆 / ${episodes.length} 条片段 · ${dir}`)
    return true
  })().catch((e) => {
    log('初始化失败，使用内存态继续', e && e.message)
    return false
  })

  // ---------- 人格 ----------

  async function readPersona() {
    await ready
    return persona
  }

  async function writePersona(text, note) {
    const next = String(text || '').trim()
    if (!next) throw new Error('人格内容不能为空')
    return serial(async () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      try {
        await writeAtomic(path.join(files.snapshots, `${stamp}-v${state.personaVersion}.md`), persona)
      } catch (e) {
        log('快照失败（非致命）', e && e.message)
      }
      persona = next
      state.personaVersion += 1
      state.personaUpdatedAt = new Date().toISOString()
      await writeAtomic(files.persona, `${next}\n`)
      await appendJournal(`## ${fmtTime()} · 人格更新 v${state.personaVersion}\n${note ? `${note}\n` : ''}`)
      await pruneSnapshots()
      await persistState()
      bumpMem()
      return state.personaVersion
    })
  }

  async function pruneSnapshots() {
    try {
      const names = (await fs.readdir(files.snapshots)).filter((n) => n.endsWith('.md')).sort()
      for (const n of names.slice(0, Math.max(0, names.length - SNAPSHOT_KEEP))) {
        await fs.rm(path.join(files.snapshots, n), { force: true })
      }
    } catch {
      /* ignore */
    }
  }

  async function appendJournal(section) {
    try {
      let head = '# 成长日志\n\n'
      try {
        head = (await fs.readFile(files.journal, 'utf8')).replace(/\n*$/, '\n\n')
      } catch {
        /* 首次 */
      }
      await writeAtomic(files.journal, `${head}${section.replace(/\n*$/, '')}\n`)
    } catch (e) {
      log('journal 写入失败（非致命）', e && e.message)
    }
  }

  // ---------- 记忆 ----------

  function dedupeKey(text) {
    return normalizeText(text).toLowerCase().replace(/[。，,.\s]/g, '')
  }

  async function addMemory(input) {
    const text = normalizeText(input.text)
    if (text.length < 2) throw new Error('记忆内容太短')
    await ready
    return serial(async () => {
      const key = dedupeKey(text)
      const dup = memories.find((m) => !m.archived && dedupeKey(m.text) === key)
      if (dup) {
        dup.hits = (dup.hits || 0) + 1
        dup.lastSeenAt = new Date().toISOString()
        if (input.weight && input.weight > (dup.weight || 3)) dup.weight = input.weight
        await rewriteMemories()
        bumpMem()
        return { ...dup, duplicate: true }
      }
      const rec = {
        id: rid('m'),
        type: MEMORY_TYPES.includes(input.type) ? input.type : 'fact',
        text: text.length > 1200 ? `${text.slice(0, 1200)}…` : text,
        tags: Array.isArray(input.tags) ? input.tags.slice(0, 8).map(String) : [],
        weight: Math.min(5, Math.max(1, Number(input.weight) || 3)),
        createdAt: new Date().toISOString(),
        sessionId: input.sessionId ? String(input.sessionId) : undefined,
        source: input.source || 'model',
        hits: 0,
        archived: false,
      }
      memories.push(rec)
      state.memories = memories.filter((m) => !m.archived).length
      try {
        await fs.appendFile(files.memory, `${JSON.stringify(rec)}\n`, 'utf8')
      } catch (e) {
        await rewriteMemories()
        log('append 失败已回退为整体重写', e && e.message)
      }
      if (memories.length > MEMORY_COMPACT_AT) {
        const live = memories.filter((m) => !m.archived)
        memories = live
        await rewriteMemories()
      }
      await persistState()
      bumpMem()
      log(`记住 ${rec.id}: ${rec.text.slice(0, 60)}`)
      return rec
    })
  }

  async function forgetMemory(match) {
    await ready
    const key = String(match || '').trim()
    if (!key) throw new Error('需要 id 或匹配文本')
    return serial(async () => {
      const k = dedupeKey(key)
      const hits = memories.filter((m) => !m.archived && (m.id === key || dedupeKey(m.text) === k || dedupeKey(m.text).includes(k)))
      if (hits.length === 0) return []
      for (const m of hits) {
        m.archived = true
        m.archivedAt = new Date().toISOString()
      }
      state.memories = memories.filter((m) => !m.archived).length
      await rewriteMemories()
      await persistState()
      bumpMem()
      return hits
    })
  }

  function ageDays(iso) {
    const t = Date.parse(iso || '')
    if (!Number.isFinite(t)) return 999
    return Math.max(0, (Date.now() - t) / 86400000)
  }

  /** 相关度 + 重要度 + 新鲜度的混合排序 */
  function score(rec, qTokens) {
    const hay = `${rec.text} ${(rec.tags || []).join(' ')}`.toLowerCase()
    let overlap = 0
    if (qTokens.size > 0) {
      for (const t of qTokens) if (hay.includes(t)) overlap += 1
      // 一个词都没命中就不算"相关"，宁可返回空，也不要塞无关记忆给模型
      if (overlap === 0) return -1
    }
    const w = (rec.weight || 3) / 5
    const fresh = Math.exp(-ageDays(rec.createdAt) / 90)
    return overlap * 2 + w * 1.5 + fresh * 0.8 + Math.min(1, (rec.hits || 0) * 0.1)
  }

  async function search(query, opts = {}) {
    await ready
    const type = opts.type && MEMORY_TYPES.includes(opts.type) ? opts.type : null
    const limit = Math.min(50, Math.max(1, Number(opts.limit) || 8))
    const qTokens = tokens(query)
    const pool = memories.filter((m) => !m.archived && (!type || m.type === type))
    const scored = pool
      .map((m) => ({ m, s: score(m, qTokens) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.m)
    for (const m of scored) m.hits = (m.hits || 0) + 1
    return scored
  }

  async function listMemories(opts = {}) {
    await ready
    const type = opts.type && MEMORY_TYPES.includes(opts.type) ? opts.type : null
    return memories.filter((m) => !m.archived && (!type || m.type === type))
  }

  /** 按重要度与新鲜度挑出常驻注入的条目 */
  async function topMemories(limit) {
    await ready
    const live = memories.filter((m) => !m.archived)
    return live
      .map((m) => ({ m, s: score(m, new Set()) + (m.weight || 3) * 0.5 - Math.min(2, ageDays(m.createdAt) / 365) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.m)
  }

  // ---------- 会话与片段 ----------

  async function touchSession(info) {
    await ready
    return serial(async () => {
      const prev = sessionIndex().get(info.id)
      pushSession({
        id: info.id,
        cwd: info.cwd || (prev && prev.cwd),
        title: info.title || (prev && prev.title),
        startedAt: (prev && prev.startedAt) || new Date().toISOString(),
        lastAt: new Date().toISOString(),
        turns: (prev && prev.turns) || 0,
      })
      await persistState()
      return prev
    })
  }

  async function addEpisode(info) {
    const text = normalizeText(info.text)
    if (text.length < 2) return null
    await ready
    return serial(async () => {
      state.turns += 1
      const idx = sessionIndex().get(info.sessionId)
      if (idx) {
        idx.turns = (idx.turns || 0) + 1
        idx.lastAt = new Date().toISOString()
        if (!idx.title && info.title) idx.title = info.title
      }
      const rec = {
        id: rid('e'),
        text: text.length > 400 ? `${text.slice(0, 400)}…` : text,
        sessionId: info.sessionId || 'unknown',
        turn: info.turn || 0,
        createdAt: new Date().toISOString(),
      }
      episodes.push(rec)
      if (episodes.length > EPISODE_KEEP) {
        episodes = episodes.slice(-EPISODE_KEEP)
        try {
          await writeAtomic(files.episodes, episodes.map((e) => JSON.stringify(e)).join('\n') + '\n')
        } catch (e) {
          log('episodes 压缩失败', e && e.message)
        }
      } else {
        try {
          await fs.appendFile(files.episodes, `${JSON.stringify(rec)}\n`, 'utf8')
        } catch (e) {
          log('episode 写入失败', e && e.message)
        }
      }
      state.episodes = episodes.length
      await persistState()
      bump()
      return rec
    })
  }

  function recentEpisodes(limit = 6, opts = {}) {
    const list = episodes.slice()
    if (opts.excludeSessionId) {
      const filtered = list.filter((e) => e.sessionId !== opts.excludeSessionId)
      // 排除后不足时补回同会话的，保证有内容可注入
      return (filtered.length > 0 ? filtered : list).slice(-limit)
    }
    return list.slice(-limit)
  }

  /** 同步视图：给 systemPrompt.section 的同步 text 函数用（不排序、不截断，交给调用方） */
  function viewSync() {
    return {
      persona,
      memories: memories.filter((m) => !m.archived),
      episodes: episodes.slice(),
      state,
    }
  }

  function summary() {
    return {
      dir,
      personaVersion: state.personaVersion,
      personaUpdatedAt: state.personaUpdatedAt,
      memories: memories.filter((m) => !m.archived).length,
      archived: memories.filter((m) => m.archived).length,
      episodes: episodes.length,
      turns: state.turns,
      sessions: state.sessions.length,
      revision,
      lastSession: state.sessions[0] || null,
      previousSession: state.sessions[1] || null,
    }
  }

  return {
    dir,
    files,
    ready,
    get revision() {
      return revision
    },
    get memoryRevision() {
      return memoryRevision
    },
    get state() {
      return state
    },
    readPersona,
    writePersona,
    addMemory,
    forgetMemory,
    search,
    listMemories,
    topMemories,
    touchSession,
    addEpisode,
    recentEpisodes,
    viewSync,
    summary,
    appendJournal,
    sessionIndex,
  }
}
