/**
 * dsh-anima · 入口（v0.4）
 *
 * 装配顺序：store（人格/片段/会话索引） → cards（摘要索引 + 细节外挂） → retrieve（检索/重排）
 *          → capture（写入流水线） → handoff（水位交接/转生） → 工具与命令。
 *
 * 注入只用同步数据：检索与重排在 user/message 时异步跑一次，结果按会话冻结，
 * 所以系统提示在同一个会话里不会因为"记忆变了"而反复变化（护住前缀缓存）。
 */

import { createStore } from './store.js'
import { createCards } from './cards.js'
import { createRetrieve } from './retrieve.js'
import { createCapture } from './capture.js'
import { createHandoff } from './handoff.js'
import { renderSoulBlock, renderStatus } from './prompt.js'
import { registerCommand, registerTools } from './tools.js'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-anima'
export const inject = ['tools', 'commands', 'systemPrompt']

const DEFAULTS = {
  dataDir: '',
  inject: true,
  promptMaxChars: 4000,
  memBudget: 2000,
  injectRelevant: 3,
  recentCards: 5,
  importantCards: 8,
  injectEpisodes: 6,
  captureEpisodes: true,
  captureCues: true,
  idleWriteMs: 5 * 60 * 1000,
  autoConsolidate: true,
  consolidateAt: 300,
  decayDays: 120,
  handoffAt: 0.95,
  autoHandoff: true,
  handoffNewSession: true,
  rebirthAt: 32000,
  rerankModel: '',
  rerankBase: 'http://127.0.0.1:11434',
  rerankTimeoutMs: 2000,
  sectionOrder: 10050,
}

function resolveDir(config, env = process.env) {
  const raw = String(config.dataDir || '').trim()
  if (!raw) {
    const home = String(env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh')
    return path.join(home, 'anima')
  }
  if (raw === '~') return os.homedir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return path.join(os.homedir(), raw.slice(2))
  const expanded = raw.replace(/\$\{?([A-Z_][A-Z0-9_]*)\}?/g, (m, key) => env[key] ?? m)
  return path.isAbsolute(expanded) ? expanded : path.resolve(expanded)
}

async function readVersion() {
  try {
    const raw = await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')
    return JSON.parse(raw).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

function ownerOf(session) {
  const meta = session?.meta || session?.header?.meta || {}
  return String(meta.owner || meta.ownerId || 'shared')
}

function titleOf(session) {
  return String(session?.meta?.title || session?.header?.title || '').trim()
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const log = (msg) => {
    try {
      ctx.logger?.info?.(`dsh-anima: ${msg}`)
    } catch {
      /* 忽略 */
    }
  }
  const fail = (where, err) => {
    const msg = `[dsh-anima] ${where} failed: ${err?.stack || err?.message || err}`
    try {
      console.error(msg)
    } catch {
      /* 忽略 */
    }
  }

  const dir = resolveDir(cfg)
  const store = createStore({ dir, log, decayDays: cfg.decayDays })
  const cards = createCards({ dir, log })
  const retrieve = createRetrieve({ cards, cfg, log })
  const capture = createCapture({ store, cfg, log, cards })
  const handoff = createHandoff({ ctx, store, capture, cfg, log })

  /** 每个会话的"当前相关卡片"，由异步检索填充，供同步渲染读取 */
  const relevance = new Map()
  /** 每个会话的渲染快照，保证同会话文本稳定 */
  const snapshots = new Map()
  /** 已经触发过转生的会话，避免重复 */
  const reborn = new Set()

  function relevantIds(sid) {
    const hit = relevance.get(sid)
    return hit ? hit.ids : []
  }

  async function refreshRelevance(session, sid, query) {
    try {
      const owner = ownerOf(session)
      const { items } = await retrieve.pick(query || titleOf(session), { owner, topK: cfg.injectRelevant, pool: 10 })
      const ids = items.map((i) => i.card.id)
      const prev = relevance.get(sid)
      if (prev && prev.query === query && prev.ids.join(',') === ids.join(',')) return
      relevance.set(sid, { ids, query, at: Date.now() })
      // 引用即"用过"：更新命中，让频繁被想起来的卡排前面
      if (ids.length) await cards.touch(ids)
    } catch (err) {
      fail('retrieve', err)
    }
  }

  function buildText(session) {
    const sid = session?.id || 'unknown'
    const owner = ownerOf(session)
    const sum = cards.summary()
    const persona = String(store.viewSync?.().persona || cfg.__personaCache || '')
    const important = cards.importantCards(owner, cfg.importantCards)
    const recent = cards.recent(owner, cfg.recentCards)
    const ids = relevantIds(sid)
    const relevant = (ids.length
      ? ids.map((id) => cards.get(id)).filter(Boolean)
      : cards.search(titleOf(session) || '', { owner, limit: cfg.injectRelevant }).map((h) => h.card)
    ).slice(0, cfg.injectRelevant)
    const episodes = cfg.captureEpisodes ? store.recentEpisodes(cfg.injectEpisodes, { excludeSessionId: sid }) : []
    const handoffRec = handoff.forPrompt(session)
    const nudge = handoff.nudge(session)
    const key = `${sum.cards}|${sum.facts}|${sid}|${ids.join(',')}|${recent.map((c) => c.id).join(',')}|${handoffRec?.id || ''}|${nudge ? 'n' : ''}`
    const cached = snapshots.get(key)
    if (cached !== undefined && Date.now() - (snapshots.get(`${key}:at`) || 0) < 30 * 1000) return cached
    const text = renderSoulBlock({
      persona,
      important,
      recent,
      relevant,
      episodes,
      session: store.sessionIndex().get(sid) || { id: sid, title: titleOf(session) },
      previousSession: store.summary().previousSession,
      maxChars: cfg.memBudget,
      maxTotal: cfg.promptMaxChars,
      personaCap: Math.max(600, Math.min(1800, Math.round(cfg.promptMaxChars * 0.45))),
      handoff: handoffRec,
      nudge,
    })
    snapshots.set(key, text)
    snapshots.set(`${key}:at`, Date.now())
    return text
  }

  function registerSection() {
    if (!cfg.inject || !ctx.systemPrompt?.section) return
    ctx.systemPrompt.section({
      name: 'soul:identity',
      order: cfg.sectionOrder,
      text: (context) => buildText(context?.session),
    })
  }

  function registerCapture() {
    ctx.on?.(
      'session/event',
      (session, event) => {
        try {
          capture.handle(session, event)
          handoff.observe(session, event)
          const sid = session?.id
          if (!sid || !event) return
          const type = String(event.type || '')

          if (type === 'user/message') {
            const text = capture.latestUserText?.(sid) || ''
            if (text) void refreshRelevance(session, sid, text)
          } else if (type === 'turn/end' && cfg.rebirthAt > 0 && !reborn.has(sid)) {
            const p = handoff.pressure(session)
            if (p.used >= cfg.rebirthAt) {
              reborn.add(sid)
              log(`上下文 ${p.used} tokens 达到转生阈值 ${cfg.rebirthAt}，开始交接`)
              // 延后一个宏任务：让 capture 先把这一轮写进环形缓冲，交接才有内容可写
              setTimeout(() => {
                void handoff.force(session, 'rebirth')
              }, 50)
            }
          }
        } catch (err) {
          fail('session-event', err)
        }
      },
      { global: true },
    )
  }

  async function boot() {
    await store.ready
    await cards.ready
    await retrieve.warmup()
    const persona = await store.readPersona()
    cfg.__personaCache = persona
    void readVersion().then((v) => {
      cfg.__version = v
    })
    registerSection()
    registerCapture()

    const personaVersion = store.summary().personaVersion || 1
    const cardSum = cards.summary()
    const toolsReg = registerTools(ctx, store, cfg, log, fail, handoff, cards)
    registerCommand(ctx, store, cfg, log, fail, capture, handoff, cards, retrieve)

    const dormant = (await store.summary()).dormant || 0
    const line = [
      `就绪 · v${await readVersion()} · 人格 v${personaVersion}`,
      `${cardSum.cards} 张卡 / ${cardSum.facts} 条细节${dormant ? ` / ${dormant} 休眠` : ''}`,
      `${(await store.summary()).handoffs || 0} 份交接`,
      `工具 ${toolsReg.registered}/${toolsReg.total}`,
      dir,
    ].join(' · ')
    log(line)

    if (cfg.autoConsolidate && cardSum.cards >= Math.max(20, cfg.consolidateAt)) {
      void cards
        .consolidate()
        .then((n) => (n ? log(`自动合并了 ${n} 组重复卡片`) : null))
        .catch((err) => fail('consolidate', err))
    }
  }

  boot().catch((err) => fail('boot', err))

  ctx.on?.('dispose', () => {
    void store.flush?.()
  })

  return {
    store,
    cards,
    retrieve,
    capture,
    handoff,
    buildText,
    renderStatus,
    flush: async () => {
      capture.dispose()
      await store.flush?.()
    },
  }
}
