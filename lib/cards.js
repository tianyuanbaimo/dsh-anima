/**
 * dsh-anima · 卡片层：摘要索引 + 细节外挂（v0.4）
 *
 * 思路（对齐"摘要索引 + 细节外挂"）：
 *   - cards.jsonl 每行一张「卡」：标题、摘要、实体、关键词、类型、归属、重要与否、使用计数
 *   - facts.jsonl 每行一条「细节」：挂在某张卡下面，平时不注入，需要时用 soul_card 展开
 *   - 不存聊天原文切片：卡是提炼后的结构化信息，靠 tokens() 的 idf 加权检索
 *
 * 零依赖：只 import node:fs / node:path。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fmtTime, tokens } from './store.js'

export const CARD_SCHEMA = 3
export const CARD_KINDS = ['rule', 'preference', 'emotion', 'fact', 'decision', 'relationship', 'insight', 'episode']
const MERGE_AT = 0.85
const SOFT_DAYS = 90
const KEEP_HITS = 2

function rid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

/** 从文本里抽实体：中文引号内容、保留大小写的拉丁词、URL、路径 */
export function entitiesOf(text) {
  const out = new Set()
  const s = String(text || '')
  for (const m of s.matchAll(/[“"「]([^”"」]{2,20})[”"」]/g)) out.add(m[1])
  for (const m of s.matchAll(/[A-Za-z][A-Za-z0-9_.+#-]{2,}/g)) out.add(m[0])
  for (const m of s.matchAll(/[A-Za-z]:\\[^\s，。；、]+/g)) out.add(m[0])
  return [...out].slice(0, 12)
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
      /* 坏行跳过 */
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

function freshScore(iso) {
  const d = Date.parse(iso || '') || 0
  if (!d) return 0
  const days = (Date.now() - d) / 86400000
  return Math.exp(-Math.max(0, days) / 30)
}

function freqScore(hits) {
  return Math.min(1, (Number(hits) || 0) / 5)
}

/**
 * @param {{dir:string, log?:(m:string)=>void, legacyFile?:string}} opts
 */
export function createCards({ dir, log = () => {}, legacyFile } = {}) {
  const files = {
    cards: path.join(dir, 'cards.jsonl'),
    facts: path.join(dir, 'facts.jsonl'),
    state: path.join(dir, 'cards-state.json'),
    legacy: legacyFile || path.join(dir, 'memory.jsonl'),
  }

  let cards = []
  let facts = []
  let state = { schema: CARD_SCHEMA, createdAt: new Date().toISOString(), migratedAt: null, lastSweepAt: null }
  let chain = Promise.resolve()
  let cardTokens = new Map()
  let df = new Map()

  function serial(fn) {
    chain = chain.then(fn, fn)
    return chain
  }

  function reindex() {
    cardTokens = new Map()
    df = new Map()
    for (const c of cards) {
      if (c.archived) continue
      const set = tokens(`${c.title} ${c.summary} ${(c.keywords || []).join(' ')} ${(c.entities || []).join(' ')}`)
      cardTokens.set(c.id, set)
      for (const t of set) df.set(t, (df.get(t) || 0) + 1)
    }
  }

  async function persist() {
    await writeAtomic(files.cards, cards.map((c) => JSON.stringify(c)).join('\n') + (cards.length ? '\n' : ''))
    await writeAtomic(files.facts, facts.map((f) => JSON.stringify(f)).join('\n') + (facts.length ? '\n' : ''))
    await writeAtomic(files.state, JSON.stringify(state, null, 2))
  }

  async function migrateLegacy() {
    const legacy = await readJsonl(files.legacy)
    if (!legacy.length) return 0
    let n = 0
    for (const m of legacy) {
      if (!m || typeof m.text !== 'string' || m.archived) continue
      const types = CARD_KINDS.includes(m.type) ? [m.type] : ['fact']
      const card = {
        id: rid('c'),
        owner: m.owner || 'shared',
        title: clip(m.text, 28),
        summary: clip(m.text, 320),
        entities: entitiesOf(m.text),
        keywords: (m.tags || []).slice(0, 8),
        types,
        important: Boolean(m.important) || (Number(m.weight) || 0) >= 5,
        weight: Number(m.weight) || 3,
        sources: ['legacy'],
        createdAt: m.createdAt || new Date().toISOString(),
        updatedAt: m.updatedAt || m.lastSeenAt || m.createdAt || new Date().toISOString(),
        lastUsedAt: m.lastHitAt || m.lastSeenAt || m.createdAt || new Date().toISOString(),
        hits: Number(m.hits) || 0,
        factsCount: 1,
        archived: false,
        mergedInto: null,
      }
      cards.push(card)
      facts.push({
        id: rid('f'),
        cardId: card.id,
        owner: card.owner,
        text: String(m.text),
        kind: types[0],
        createdAt: card.createdAt,
        lastUsedAt: card.lastUsedAt,
        hits: 0,
        important: card.important,
      })
      n += 1
    }
    state.migratedAt = new Date().toISOString()
    return n
  }

  const ready = (async () => {
    await fs.mkdir(dir, { recursive: true })
    try {
      state = { ...state, ...JSON.parse(await fs.readFile(files.state, 'utf8')) }
    } catch {
      /* 首次运行 */
    }
    cards = (await readJsonl(files.cards)).filter((c) => c && c.id)
    facts = (await readJsonl(files.facts)).filter((f) => f && f.id && f.cardId)
    if (!state.migratedAt) {
      const n = await migrateLegacy()
      if (n) {
        log(`已把 ${n} 条旧记忆迁成卡片`)
        if (state.schema < CARD_SCHEMA) state.schema = CARD_SCHEMA
        await persist()
      }
    }
    reindex()
    await sweep()
    log(`卡片 ${liveCards().length} 张 / 细节 ${facts.length} 条 · ${dir}`)
    return true
  })()

  function liveCards() {
    return cards.filter((c) => !c.archived)
  }

  function cardById(id) {
    const key = String(id || '').trim()
    return cards.find((c) => c.id === key) || null
  }

  function factsOf(cardId) {
    return facts.filter((f) => f.cardId === cardId && !f.archived).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  }

  /** 三因子：0.7 语义 + 0.2 新鲜 + 0.1 频率（spec 口径） */
  function scoreCard(card, qTokens) {
    const set = cardTokens.get(card.id) || tokens(card.title)
    let semantic = 0
    if (qTokens.size) {
      let covered = 0
      let weightSum = 0
      for (const t of qTokens) {
        const w = Math.log(1 + liveCards().length / (1 + (df.get(t) || 0)))
        weightSum += w
        if (set.has(t)) covered += w * (card.important ? 1.3 : 1)
      }
      semantic = weightSum > 0 ? Math.min(1, covered / weightSum) : 0
    }
    return 0.7 * semantic + 0.2 * freshScore(card.lastUsedAt || card.updatedAt) + 0.1 * freqScore(card.hits)
  }

  async function add(input = {}) {
    const text = String(input.summary || input.text || '').trim()
    if (!text) return null
    const owner = input.owner || 'shared'
    const types = (input.types || [input.type]).filter((t) => CARD_KINDS.includes(t))
    const card = {
      id: rid('c'),
      owner,
      title: clip(input.title || text, 28),
      summary: clip(text, 320),
      entities: input.entities || entitiesOf(text),
      keywords: (input.keywords || input.tags || []).slice(0, 10),
      types: types.length ? types : ['fact'],
      important: Boolean(input.important) || (Number(input.weight) || 0) >= 5,
      weight: Number(input.weight) || 3,
      sources: [input.source || 'capture'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      hits: 0,
      factsCount: input.facts?.length || 0,
      archived: false,
      mergedInto: null,
    }
    return serial(async () => {
      cards.push(card)
      for (const f of input.facts || []) {
        facts.push({
          id: rid('f'),
          cardId: card.id,
          owner,
          text: String(f.text || f).trim(),
          kind: f.kind || card.types[0],
          createdAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          hits: 0,
          important: card.important,
        })
      }
      card.factsCount = factsOf(card.id).length
      reindex()
      await persist()
      return card
    })
  }

  async function addFact(cardId, text, kind) {
    const card = cardById(cardId)
    if (!card || !String(text || '').trim()) return null
    return serial(async () => {
      const fact = {
        id: rid('f'),
        cardId: card.id,
        owner: card.owner,
        text: String(text).trim(),
        kind: kind || card.types[0],
        createdAt: new Date().toISOString(),
        lastUsedAt: new Date().toISOString(),
        hits: 0,
        important: card.important,
      }
      facts.push(fact)
      card.factsCount = factsOf(card.id).length
      await persist()
      return fact
    })
  }

  async function touch(ids) {
    const now = new Date().toISOString()
    let changed = false
    for (const id of ids) {
      const c = cardById(id)
      if (!c) continue
      c.hits += 1
      c.lastUsedAt = now
      changed = true
    }
    if (changed) await serial(persist)
  }

  function search(query, opts = {}) {
    const qTokens = tokens(query)
    const owner = opts.owner || 'shared'
    const limit = opts.limit || 10
    const pool = liveCards().filter((c) => visible(c, owner) && (!opts.types || c.types.some((t) => opts.types.includes(t))))
    const scored = pool
      .map((c) => ({ card: c, score: scoreCard(c, qTokens) }))
      .filter((x) => (qTokens.size ? hasOverlap(x.card, qTokens) && x.score > 0.18 : true))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
    return scored
  }

  /** 至少有一个词命中才算"相关"：否则新鲜度 0.2 的底分会让毫不相干的卡也混进来 */
  function hasOverlap(card, qTokens) {
    const set = cardTokens.get(card.id)
    if (!set) return false
    for (const t of qTokens) if (set.has(t)) return true
    return false
  }

  function visible(card, owner) {
    if (!owner) return true
    return card.owner === 'shared' || card.owner === owner
  }

  function recent(owner, limit = 5) {
    return liveCards()
      .filter((c) => visible(c, owner))
      .sort((a, b) => Date.parse(b.lastUsedAt || b.updatedAt) - Date.parse(a.lastUsedAt || a.updatedAt))
      .slice(0, limit)
  }

  function importantCards(owner, limit = 8) {
    return liveCards()
      .filter((c) => visible(c, owner) && (c.important || c.types.includes('rule')))
      .sort((a, b) => (b.weight || 0) - (a.weight || 0) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit)
  }

  async function forget(match) {
    const key = String(match || '').trim()
    const card = cardById(key) || liveCards().find((c) => c.title.includes(key) || c.summary.includes(key))
    if (!card) return null
    return serial(async () => {
      card.archived = true
      card.updatedAt = new Date().toISOString()
      reindex()
      await persist()
      return card
    })
  }

  async function sweep() {
    const cutoff = Date.now() - SOFT_DAYS * 86400000
    let archived = 0
    for (const c of cards) {
      if (c.archived || c.important || c.types.includes('rule')) continue
      const last = Date.parse(c.lastUsedAt || c.updatedAt) || 0
      if (last > cutoff) continue
      if ((c.hits || 0) >= KEEP_HITS) continue
      if ((c.weight || 0) > 3) continue
      c.archived = true
      c.updatedAt = new Date().toISOString()
      archived += 1
    }
    if (archived) {
      state.lastSweepAt = new Date().toISOString()
      reindex()
      await persist()
    }
    return archived
  }

  async function consolidate({ dryRun = false } = {}) {
    const pool = liveCards()
    const groups = []
    const used = new Set()
    for (let i = 0; i < pool.length; i++) {
      const a = pool[i]
      if (used.has(a.id)) continue
      const group = [a]
      const ta = cardTokens.get(a.id) || tokens(a.title)
      for (let j = i + 1; j < pool.length; j++) {
        const b = pool[j]
        if (used.has(b.id) || b.types[0] !== a.types[0]) continue
        const tb = cardTokens.get(b.id) || tokens(b.title)
        let inter = 0
        for (const t of ta) if (tb.has(t)) inter += 1
        const jac = inter / (ta.size + tb.size - inter || 1)
        if (jac >= MERGE_AT) {
          group.push(b)
          used.add(b.id)
        }
      }
      if (group.length > 1) {
        used.add(a.id)
        groups.push(group)
      }
    }
    if (dryRun) return groups.map((g) => g.map((c) => c.id))
    return serial(async () => {
      for (const group of groups) {
        const keep = [...group].sort((x, y) => (y.weight || 0) - (x.weight || 0) || y.summary.length - x.summary.length)[0]
        for (const other of group) {
          if (other.id === keep.id) continue
          for (const f of factsOf(other.id)) {
            f.cardId = keep.id
          }
          keep.hits += other.hits || 0
          keep.keywords = [...new Set([...(keep.keywords || []), ...(other.keywords || [])])]
          keep.entities = [...new Set([...(keep.entities || []), ...(other.entities || [])])]
          other.archived = true
          other.mergedInto = keep.id
        }
        keep.factsCount = factsOf(keep.id).length
      }
      reindex()
      await persist()
      return groups.length
    })
  }

  function stats() {
    const live = liveCards()
    const byType = {}
    for (const c of live) for (const t of c.types) byType[t] = (byType[t] || 0) + 1
    const byOwner = {}
    for (const c of live) byOwner[c.owner] = (byOwner[c.owner] || 0) + 1
    return {
      cards: live.length,
      archived: cards.filter((c) => c.archived).length,
      facts: facts.length,
      important: live.filter((c) => c.important).length,
      byType,
      byOwner,
      migratedAt: state.migratedAt,
      lastSweepAt: state.lastSweepAt,
    }
  }

  function summary() {
    const live = liveCards()
    return {
      cards: live.length,
      facts: facts.length,
      important: live.filter((c) => c.important).length,
      migratedAt: state.migratedAt,
      schema: state.schema,
    }
  }

  async function exportMarkdown() {
    const lines = ['# dsh-anima 记忆导出', '', `- 导出时间：${fmtTime()}`, `- 卡片：${liveCards().length} 张 · 细节：${facts.length} 条`, '']
    for (const c of liveCards().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
      lines.push(`## ${c.title}${c.important ? ' ★' : ''}`)
      lines.push('')
      lines.push(`- id：\`${c.id}\` · 类型：${c.types.join('/')} · 权重 ${c.weight} · 命中 ${c.hits}`)
      lines.push('')
      lines.push(c.summary)
      const fs2 = factsOf(c.id)
      if (fs2.length) {
        lines.push('')
        for (const f of fs2) lines.push(`- ${f.text}`)
      }
      lines.push('')
    }
    return lines.join('\n')
  }

  async function importCards(raw) {
    let rows = []
    const text = String(raw || '').trim()
    if (text.startsWith('[') || text.startsWith('{')) {
      const parsed = JSON.parse(text)
      rows = Array.isArray(parsed) ? parsed : [parsed]
    } else {
      for (const line of text.split('\n')) {
        const t = line.trim()
        if (!t) continue
        try {
          rows.push(JSON.parse(t))
        } catch {
          /* skip */
        }
      }
    }
    let n = 0
    await serial(async () => {
      for (const r of rows) {
        if (!r || (!r.summary && !r.text)) continue
        const text2 = String(r.summary || r.text).trim()
        if (liveCards().some((c) => c.summary === text2)) continue
        cards.push({
          id: rid('c'),
          owner: r.owner || 'shared',
          title: clip(r.title || text2, 28),
          summary: clip(text2, 320),
          entities: r.entities || entitiesOf(text2),
          keywords: r.keywords || r.tags || [],
          types: (r.types || [r.type || 'fact']).filter((t) => CARD_KINDS.includes(t)),
          important: Boolean(r.important),
          weight: Number(r.weight) || 3,
          sources: ['import'],
          createdAt: r.createdAt || new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastUsedAt: new Date().toISOString(),
          hits: 0,
          factsCount: 0,
          archived: false,
          mergedInto: null,
        })
        n += 1
      }
      reindex()
      await persist()
    })
    return n
  }

  return {
    ready,
    dir,
    files,
    add,
    addFact,
    addCard: add,
    get: cardById,
    factsOf,
    search,
    recent,
    importantCards,
    touch,
    forget,
    consolidate,
    sweep,
    stats,
    summary,
    exportMarkdown,
    importCards,
    all: () => liveCards(),
  }
}
