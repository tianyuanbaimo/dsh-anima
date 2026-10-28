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
 *
 * v0.2 起新增：
 *   - 合并去重（consolidate）：同类型、token 相似度 ≥ 0.75 的条目并成一条，旧的归档
 *   - 休眠（dormant）：低权重、久未命中、创建很久的条目不参与常驻注入，但检索仍能找到
 *   - 检索加重：token 稀有度（idf）+ 标签命中加权；命中计数延迟落盘，不再每轮写文件
 *   - 导入 / 导出 / 快照回滚
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'

const MEMORY_COMPACT_AT = 4000
const EPISODE_KEEP = 800
const SNAPSHOT_KEEP = 40
const SCHEMA_VERSION = 2
const MERGE_THRESHOLD = 0.75
const DEFAULT_DECAY_DAYS = 120
const HITS_FLUSH_MS = 800

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

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  return inter / (a.size + b.size - inter)
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

export function createStore({ dir, log = () => {}, decayDays } = {}) {
  const files = {
    persona: path.join(dir, 'persona.md'),
    memory: path.join(dir, 'memory.jsonl'),
    episodes: path.join(dir, 'episodes.jsonl'),
    journal: path.join(dir, 'journal.md'),
    state: path.join(dir, 'state.json'),
    snapshots: path.join(dir, 'snapshots'),
    handoffs: path.join(dir, 'handoffs.jsonl'),
    handoffDir: path.join(dir, 'handoffs'),
  }

  const state = {
    version: 1,
    schema: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    personaVersion: 1,
    personaUpdatedAt: new Date().toISOString(),
    memories: 0,
    episodes: 0,
    turns: 0,
    decayDays: Number(decayDays) > 0 ? Number(decayDays) : DEFAULT_DECAY_DAYS,
    lastConsolidateAt: null,
    sessions: [], // { id, cwd, title, startedAt, lastAt, turns }
    lastSessionId: null,
    lastHandoffId: null,
  }

  let memories = [] // 全量，含 archived
  let episodes = [] // 最近 EPISODE_KEEP 条
  let handoffs = [] // 最近 60 份项目交接
  let persona = ''
  let revision = 1
  let memoryRevision = 1
  let queue = Promise.resolve()
  let hitsDirty = false
  let hitsTimer = null

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
    hitsDirty = false
  }

  /** 命中计数攒一会儿再落盘：检索是高频操作，不能每次写文件 */
  function scheduleHitsFlush() {
    if (hitsTimer) return
    hitsTimer = setTimeout(() => {
      hitsTimer = null
      if (!hitsDirty) return
      serial(() => rewriteMemories()).catch((e) => log('命中计数落盘失败', e && e.message))
    }, HITS_FLUSH_MS)
    if (typeof hitsTimer.unref === 'function') hitsTimer.unref()
  }

  async function flush() {
    if (hitsTimer) {
      clearTimeout(hitsTimer)
      hitsTimer = null
    }
    if (!hitsDirty) return
    await serial(() => rewriteMemories())
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

    // 旧版本状态补齐（v1 → v2）
    if (!state.schema || state.schema < SCHEMA_VERSION) {
      state.schema = SCHEMA_VERSION
      if (!(Number(state.decayDays) > 0)) state.decayDays = DEFAULT_DECAY_DAYS
      await persistState()
      log(`state 已迁移到 schema ${SCHEMA_VERSION}`)
    }

    memories = (await readJsonl(files.memory)).filter((m) => m && typeof m.text === 'string')
    state.memories = memories.filter((m) => !m.archived && !isDormant(m)).length

    const eps = await readJsonl(files.episodes)
    episodes = eps.slice(-EPISODE_KEEP).filter((e) => e && typeof e.text === 'string')
    state.episodes = episodes.length

    const hos = await readJsonl(files.handoffs)
    handoffs = hos.slice(-60).filter((h) => h && typeof h.id === 'string')

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

  async function listSnapshots() {
    await ready
    try {
      const names = (await fs.readdir(files.snapshots)).filter((n) => n.endsWith('.md')).sort()
      const out = []
      for (const name of names) {
        try {
          const st = await fs.stat(path.join(files.snapshots, name))
          out.push({ name, size: st.size, mtime: st.mtime.toISOString() })
        } catch {
          /* 快照被别人删了也无所谓 */
        }
      }
      return out
    } catch {
      return []
    }
  }

  /** 回滚到某个快照：先给当前人格留一份，再从快照恢复 */
  async function rollback(nameOrIndex) {
    const list = await listSnapshots()
    if (list.length === 0) throw new Error('还没有任何人格快照')
    let target = null
    const raw = String(nameOrIndex || '').trim()
    if (!raw) target = list[list.length - 1]
    else if (/^\d+$/.test(raw)) {
      const i = Number(raw)
      target = i >= 1 && i <= list.length ? list[i - 1] : null
    } else {
      target = list.find((s) => s.name === raw || s.name.startsWith(raw)) || null
    }
    if (!target) throw new Error(`找不到快照「${raw}」（用 /soul snapshots 看列表）`)
    const text = await fs.readFile(path.join(files.snapshots, target.name), 'utf8')
    if (!text.trim()) throw new Error(`快照 ${target.name} 是空的`)
    const v = await writePersona(text, `回滚到快照 ${target.name}`)
    return { version: v, name: target.name, at: target.mtime }
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

  function haystack(rec) {
    return `${rec.text} ${(rec.tags || []).join(' ')}`.toLowerCase()
  }

  function ageDays(iso) {
    const t = Date.parse(iso || '')
    if (!Number.isFinite(t)) return 999
    return Math.max(0, (Date.now() - t) / 86400000)
  }

  /**
   * 休眠：重要度低 + 很久没被想起 + 建了很久。
   * 只是不参与常驻注入，检索时仍然找得到 —— 不删任何东西。
   */
  function isDormant(rec) {
    if (!rec || rec.archived) return true
    if ((rec.hits || 0) >= 2) return false
    if ((rec.weight || 3) > 2) return false
    const last = rec.lastHitAt || rec.lastSeenAt || rec.createdAt
    return ageDays(last) > (Number(state.decayDays) || DEFAULT_DECAY_DAYS)
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
        if (Array.isArray(input.tags) && input.tags.length) {
          dup.tags = [...new Set([...(dup.tags || []), ...input.tags.map(String)])].slice(0, 12)
        }
        hitsDirty = true
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
      state.memories = memories.filter((m) => !m.archived && !isDormant(m)).length
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
      state.memories = memories.filter((m) => !m.archived && !isDormant(m)).length
      await rewriteMemories()
      await persistState()
      bumpMem()
      return hits
    })
  }

  /** 让一条休眠记忆重新参与常驻注入 */
  async function wakeMemory(id) {
    await ready
    const key = String(id || '').trim()
    if (!key) throw new Error('需要 id')
    return serial(async () => {
      const rec = memories.find((m) => m.id === key && !m.archived)
      if (!rec) return null
      rec.weight = Math.max(3, rec.weight || 3)
      rec.lastHitAt = new Date().toISOString()
      await rewriteMemories()
      bumpMem()
      return rec
    })
  }

  function dfMap(qTokens, pool) {
    const df = new Map()
    for (const t of qTokens) df.set(t, 0)
    for (const rec of pool) {
      const hay = haystack(rec)
      for (const t of qTokens) if (hay.includes(t)) df.set(t, (df.get(t) || 0) + 1)
    }
    return df
  }

  /** 相关度（idf 加权）+ 重要度 + 新鲜度 + 命中史 */
  function score(rec, qTokens, df, total) {
    let overlap = 0
    if (qTokens.size > 0) {
      for (const t of qTokens) {
        if (haystack(rec).includes(t)) {
          const d = df.get(t) || 1
          overlap += Math.log(1 + total / (1 + d)) + 0.2
        }
      }
      // 一个词都没命中就不算"相关"，宁可返回空，也不要塞无关记忆给模型
      if (overlap === 0) return -1
    }
    const w = (rec.weight || 3) / 5
    const fresh = Math.exp(-ageDays(rec.createdAt) / 90)
    const dormantPenalty = isDormant(rec) ? 1.2 : 0
    return overlap * 2 + w * 1.5 + fresh * 0.8 + Math.min(1, (rec.hits || 0) * 0.1) - dormantPenalty
  }

  async function search(query, opts = {}) {
    await ready
    const type = opts.type && MEMORY_TYPES.includes(opts.type) ? opts.type : null
    const tags = Array.isArray(opts.tags) ? opts.tags.map((t) => String(t).toLowerCase()) : []
    const limit = Math.min(50, Math.max(1, Number(opts.limit) || 8))
    const qTokens = tokens(query)
    const pool = memories.filter(
      (m) =>
        !m.archived &&
        (!type || m.type === type) &&
        (tags.length === 0 || tags.every((t) => (m.tags || []).map((x) => String(x).toLowerCase()).includes(t))),
    )
    if (pool.length === 0) return []
    const df = qTokens.size > 0 ? dfMap(qTokens, pool) : new Map()
    const scored = pool
      .map((m) => ({ m, s: score(m, qTokens, df, pool.length) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.m)
    for (const m of scored) {
      m.hits = (m.hits || 0) + 1
      m.lastHitAt = new Date().toISOString()
    }
    if (scored.length) {
      hitsDirty = true
      scheduleHitsFlush()
    }
    return scored
  }

  async function listMemories(opts = {}) {
    await ready
    const type = opts.type && MEMORY_TYPES.includes(opts.type) ? opts.type : null
    const includeDormant = opts.includeDormant !== false
    return memories.filter((m) => !m.archived && (!type || m.type === type) && (includeDormant || !isDormant(m)))
  }

  /** 休眠中的记忆（诊断用） */
  async function dormantMemories(limit = 20) {
    await ready
    return memories
      .filter((m) => !m.archived && isDormant(m))
      .sort((a, b) => ageDays(a.createdAt) - ageDays(b.createdAt))
      .slice(0, Math.max(1, limit))
  }

  /** 按重要度与新鲜度挑出常驻注入的条目 */
  async function topMemories(limit) {
    await ready
    const live = memories.filter((m) => !m.archived && !isDormant(m))
    return live
      .map((m) => ({ m, s: (m.weight || 3) * 10 + Math.min(6, m.hits || 0) + Math.max(0, 6 - ageDays(m.createdAt) / 30) }))
      .sort((a, b) => b.s - a.s)
      .slice(0, limit)
      .map((x) => x.m)
  }

  /**
   * 合并去重：同类型、token 相似度 ≥ 0.75 的条目并成一条，其余归档（可恢复）。
   * 用倒排索引挑候选，避免 O(n²) 全量比对。
   */
  async function consolidate(opts = {}) {
    await ready
    const threshold = Math.min(0.98, Math.max(0.5, Number(opts.threshold) || MERGE_THRESHOLD))
    const dryRun = opts.dryRun === true
    return serial(async () => {
      const live = memories.filter((m) => !m.archived)
      if (live.length < 2) return { merged: 0, groups: [], dryRun }

      const tokenSets = new Map()
      const inverted = new Map() // token -> ids
      for (const m of live) {
        const ts = tokens(m.text)
        tokenSets.set(m.id, ts)
        for (const t of ts) {
          if (!inverted.has(t)) inverted.set(t, [])
          inverted.get(t).push(m.id)
        }
      }

      const consumed = new Set()
      const groups = []
      const byId = new Map(live.map((m) => [m.id, m]))
      for (const m of live) {
        if (consumed.has(m.id)) continue
        const ts = tokenSets.get(m.id)
        const candidates = new Set()
        for (const t of ts) for (const id of inverted.get(t) || []) if (id !== m.id && !consumed.has(id)) candidates.add(id)
        const similar = []
        for (const id of candidates) {
          const other = byId.get(id)
          if (!other || other.type !== m.type) continue
          const sim = jaccard(ts, tokenSets.get(id))
          if (sim >= threshold) similar.push({ other, sim })
        }
        if (similar.length === 0) continue
        similar.sort((a, b) => b.sim - a.s)
        const members = [m, ...similar.map((x) => x.other)]
        consumed.add(m.id)
        for (const x of similar) consumed.add(x.other.id)
        groups.push(members)
      }

      if (dryRun) {
        return {
          merged: 0,
          dryRun: true,
          groups: groups.map((g) => ({ keep: g[0].text, drop: g.slice(1).map((m) => m.text) })),
        }
      }

      let merged = 0
      const summaries = []
      for (const group of groups) {
        // 保留权重最高（同权重取最长）的那条作为主条
        group.sort((a, b) => (b.weight || 3) - (a.weight || 3) || b.text.length - a.text.length)
        const keep = group[0]
        const drop = group.slice(1)
        keep.weight = Math.max(...group.map((m) => m.weight || 3))
        keep.hits = group.reduce((n, m) => n + (m.hits || 0), 0)
        keep.tags = [...new Set(group.flatMap((m) => m.tags || []))].slice(0, 12)
        keep.lastSeenAt = new Date().toISOString()
        for (const m of drop) {
          m.archived = true
          m.archivedAt = new Date().toISOString()
          m.mergedInto = keep.id
        }
        merged += drop.length
        summaries.push({ keep: keep.text, drop: drop.map((m) => m.text) })
      }

      if (merged > 0) {
        state.memories = memories.filter((m) => !m.archived && !isDormant(m)).length
        state.lastConsolidateAt = new Date().toISOString()
        await rewriteMemories()
        await persistState()
        bumpMem()
        await appendJournal(`## ${fmtTime()} · 整理记忆\n合并 ${groups.length} 组、归档 ${merged} 条重复记忆。\n`)
      }
      return { merged, groups: summaries, dryRun: false }
    })
  }

  /** 统计：给 /soul stats 用 */
  async function stats() {
    await ready
    const live = memories.filter((m) => !m.archived)
    const byType = {}
    const byWeight = {}
    for (const m of live) {
      byType[m.type || 'fact'] = (byType[m.type || 'fact'] || 0) + 1
      byWeight[m.weight || 3] = (byWeight[m.weight || 3] || 0) + 1
    }
    const dormant = live.filter((m) => isDormant(m))
    const totalHits = live.reduce((n, m) => n + (m.hits || 0), 0)
    return {
      live: live.length,
      archived: memories.filter((m) => m.archived).length,
      dormant: dormant.length,
      byType,
      byWeight,
      avgWeight: live.length ? Math.round((live.reduce((n, m) => n + (m.weight || 3), 0) / live.length) * 10) / 10 : 0,
      avgHits: live.length ? Math.round((totalHits / live.length) * 10) / 10 : 0,
      neverHit: live.filter((m) => !m.hits).length,
      lastConsolidateAt: state.lastConsolidateAt,
      decayDays: state.decayDays,
    }
  }

  /** 导出成人可读的 Markdown（备份、跨机器搬运都够用） */
  async function exportMarkdown() {
    await ready
    const live = memories.filter((m) => !m.archived)
    const lines = [
      `# dsh-anima 记忆导出`,
      ``,
      `- 导出时间：${fmtTime()}`,
      `- 人格版本：v${state.personaVersion}（${fmtTime(state.personaUpdatedAt)}）`,
      `- 记忆：${live.length} 条（另有 ${memories.filter((m) => m.archived).length} 条已归档）`,
      `- 片段：${episodes.length} 条 · 累计 ${state.turns} 轮`,
      ``,
      `---`,
      ``,
      `## 人格`,
      ``,
      persona.trim(),
      ``,
      `## 记忆`,
      ``,
    ]
    for (const m of live.sort((a, b) => (b.weight || 3) - (a.weight || 3) || String(a.createdAt).localeCompare(String(b.createdAt)))) {
      lines.push(`- **${m.type}** · 权重 ${m.weight || 3} · [${m.id}] ${m.text}`)
    }
    lines.push('', '## 最近片段', '')
    for (const e of episodes.slice(-30)) lines.push(`- ${fmtTime(e.createdAt)} · ${e.text}`)
    const file = path.join(dir, `export-${new Date().toISOString().slice(0, 10)}.md`)
    await writeAtomic(file, `${lines.join('\n')}\n`)
    return { file, memories: live.length, episodes: episodes.length }
  }

  /** 从 JSONL / JSON 数组导入记忆（duplicate 会被合并计数，不会重复堆叠） */
  async function importMemories(raw) {
    await ready
    let rows = []
    const text = String(raw || '').trim()
    if (!text) throw new Error('导入内容为空')
    if (text.startsWith('[')) {
      const arr = JSON.parse(text)
      rows = Array.isArray(arr) ? arr : []
    } else {
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          const v = JSON.parse(t)
          if (v && typeof v === 'object') rows.push(v)
        } catch {
          /* 坏行跳过 */
        }
      }
    }
    let added = 0
    let duplicates = 0
    for (const row of rows) {
      const body = row && typeof row.text === 'string' ? row.text : ''
      if (!body.trim()) continue
      try {
        const rec = await addMemory({
          text: body,
          type: row.type,
          weight: row.weight,
          tags: row.tags,
          source: 'import',
        })
        if (rec.duplicate) duplicates += 1
        else added += 1
      } catch {
        /* 单条失败继续 */
      }
    }
    return { added, duplicates, total: rows.length }
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

  // ---------- 项目交接 ----------

  async function addHandoff(info) {
    await ready
    return serial(async () => {
      const rec = {
        id: rid('h'),
        at: new Date().toISOString(),
        sessionId: info.sessionId || '',
        cwd: info.cwd || '',
        title: normalizeText(info.title || '未命名项目').slice(0, 80),
        ratio: Number(info.ratio) || 0,
        used: Number(info.used) || 0,
        window: Number(info.window) || 0,
        reason: info.reason || 'threshold',
        goal: normalizeText(info.goal || '').slice(0, 600),
        decisions: (info.decisions || []).slice(0, 8),
        progress: (info.progress || []).slice(0, 10),
        artifacts: (info.artifacts || []).slice(0, 16),
        todos: (info.todos || []).slice(0, 8),
        note: normalizeText(info.note || '').slice(0, 400),
        nextSessionId: '',
      }
      handoffs.push(rec)
      if (handoffs.length > 60) handoffs = handoffs.slice(-60)
      try {
        await fs.appendFile(files.handoffs, `${JSON.stringify(rec)}\n`, 'utf8')
      } catch (e) {
        log('handoffs 写入失败', e && e.message)
      }
      if (info.markdown) {
        try {
          await fs.mkdir(files.handoffDir, { recursive: true })
          const stamp = rec.at.replace(/[:.]/g, '-')
          await writeAtomic(path.join(files.handoffDir, `${stamp}-${rec.id}.md`), info.markdown)
        } catch (e) {
          log('交接 Markdown 写入失败（非致命）', e && e.message)
        }
      }
      state.lastHandoffId = rec.id
      await persistState()
      bump()
      return rec
    })
  }

  async function markHandoffSpawned(id, sessionId) {
    await ready
    return serial(async () => {
      const rec = handoffs.find((h) => h.id === id)
      if (!rec) return null
      rec.nextSessionId = sessionId
      try {
        await writeAtomic(files.handoffs, handoffs.map((h) => JSON.stringify(h)).join('\n') + '\n')
      } catch (e) {
        log('handoffs 重写失败', e && e.message)
      }
      return rec
    })
  }

  function latestHandoff() {
    return handoffs.length ? handoffs[handoffs.length - 1] : null
  }

  function listHandoffs(limit = 5) {
    return handoffs.slice(-Math.max(1, limit)).reverse()
  }

  /** 同步视图：给 systemPrompt.section 的同步 text 函数用（不排序、不截断，交给调用方） */  function viewSync() {
    const live = memories.filter((m) => !m.archived && !isDormant(m))
    return {
      persona,
      memories: live,
      episodes: episodes.slice(),
      state,
      dormant: memories.filter((m) => !m.archived && isDormant(m)).length,
    }
  }

  function summary() {
    const live = memories.filter((m) => !m.archived && !isDormant(m))
    return {
      dir,
      schema: state.schema,
      personaVersion: state.personaVersion,
      personaUpdatedAt: state.personaUpdatedAt,
      memories: live.length,
      archived: memories.filter((m) => m.archived).length,
      dormant: memories.filter((m) => !m.archived && isDormant(m)).length,
      episodes: episodes.length,
      turns: state.turns,
      sessions: state.sessions.length,
      revision,
      decayDays: state.decayDays,
      handoffs: handoffs.length,
      handoff: latestHandoff(),
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
    wakeMemory,
    search,
    listMemories,
    dormantMemories,
    topMemories,
    consolidate,
    stats,
    exportMarkdown,
    importMemories,
    listSnapshots,
    rollback,
    touchSession,
    addEpisode,
    recentEpisodes,
    addHandoff,
    markHandoffSpawned,
    latestHandoff,
    listHandoffs,
    viewSync,
    summary,
    appendJournal,
    sessionIndex,
    flush,
    isDormant,
  }
}
