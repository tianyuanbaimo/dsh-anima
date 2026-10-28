/**
 * dsh-anima —— 让 DSH 拥有不会随关机、换会话而消失的记忆与人格。
 *
 * 三个注入点：
 *   1) systemPrompt.section  —— 每轮都在场的「我是谁 + 我记得什么」（按版本缓存，不破坏前缀缓存）
 *   2) session/event 监听    —— 零 token 地把你我发生过的对话压缩成片段与线索记忆
 *   3) tools + commands      —— 模型可主动读写记忆；用户可用 /soul 查看、整理、回滚
 *
 * 持久化在 ~/.dsh/anima/（$DSH_HOME 优先），与工作区、会话都无关。
 */

import os from 'node:os'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { createStore } from './store.js'
import { createCapture } from './capture.js'
import { createHandoff } from './handoff.js'
import { renderSoulBlock, rankMemories } from './prompt.js'
import { registerTools, registerCommand } from './tools.js'

export const name = 'dsh-anima'
export const inject = ['tools', 'commands', 'systemPrompt']

// 启动行里带上版本：重启后一眼能确认加载的是哪一版代码
let version = 'unknown'
try {
  version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version || 'unknown'
} catch {
  /* 读不到就当 unknown，不影响功能 */
}

const DEFAULTS = {
  dataDir: '',
  inject: true,
  promptMaxChars: 4000,
  injectMemories: 24,
  injectRelevant: 6,
  injectEpisodes: 6,
  captureEpisodes: true,
  captureCues: true,
  autoConsolidate: true,
  consolidateAt: 300,
  decayDays: 120,
  handoffAt: 0.95,
  autoHandoff: true,
  handoffNewSession: true,
  sectionOrder: 10050,
}

function resolveDir(custom) {
  if (custom && String(custom).trim()) {
    const raw = String(custom).trim()
    return raw.startsWith('~') ? path.join(os.homedir(), raw.slice(1)) : path.resolve(raw)
  }
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : path.join(os.homedir(), '.dsh')
  return path.join(home, 'anima')
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  const dir = resolveDir(cfg.dataDir)

  const log = (msg, err) => {
    const line = err ? `${msg}: ${err}` : msg
    let wrote = false
    try {
      const logger = ctx.logger?.('dsh-anima')
      if (logger) {
        logger.debug?.(line)
        wrote = true
      }
    } catch {
      /* logger 不存在就算了 */
    }
    if (!wrote) {
      try {
        console.log(`[dsh-anima] ${line}`)
      } catch {
        /* 连 console 都没有就放弃 */
      }
    }
  }

  // 注册失败必须能被看见：静默失败比崩溃更糟
  const fail = (what, err) => {
    try {
      console.error(`[dsh-anima] 严重：${what} 失败 → ${(err && (err.stack || err.message)) || err}`)
    } catch {
      /* ignore */
    }
  }

  const store = createStore({ dir, log, decayDays: cfg.decayDays })
  const capture = createCapture({ store, cfg, log })
  const handoff = createHandoff({ ctx, store, capture, cfg, log })

  // ---- 1. 常驻注入 ----
  if (cfg.inject !== false) {
    // 同一会话内保持文本稳定：按「记忆版本 + 会话」缓存。
    // 片段快照与"相关记忆"在会话首次装配时冻结，避免每轮击穿前缀缓存。
    const episodeSnapshots = new Map()
    const relevantSnapshots = new Map()
    let cache = { key: '', text: '' }

    const buildText = () => {
      try {
        const sum = store.summary()
        const sid = sum.lastSession ? sum.lastSession.id : ''
        const memRev = store.memoryRevision
        const pseudo = { id: sid }
        const pendingHandoff = handoff.forPrompt(pseudo)
        const nudge = handoff.nudge(pseudo)
        if (!episodeSnapshots.has(sid)) {
          if (episodeSnapshots.size > 16) episodeSnapshots.clear()
          episodeSnapshots.set(sid, store.viewSync().episodes.length)
        }
        const epCount = episodeSnapshots.get(sid)
        const key = `${memRev}|${sid}|${epCount}|${pendingHandoff ? pendingHandoff.id : ''}|${nudge ? 'n' : ''}`
        if (cache.key === key) return cache.text

        const view = store.viewSync()
        const memLimit = Math.max(1, cfg.injectMemories)
        const memories = rankMemories(view.memories).slice(0, memLimit)

        // 相关记忆：用本会话的标题（首条用户消息）当查询，会话内只算一次
        let relevant = []
        const relLimit = Math.max(0, Number(cfg.injectRelevant) || 0)
        const topic = sum.lastSession && sum.lastSession.title ? sum.lastSession.title : ''
        if (relLimit > 0 && topic) {
          const relKey = `${memRev}|${sid}`
          if (!relevantSnapshots.has(relKey)) {
            if (relevantSnapshots.size > 32) relevantSnapshots.clear()
            const ids = new Set(memories.map((m) => m.id))
            let picked = []
            try {
              // 这里不能 await：text 必须是同步函数。用同步视图按 token 打分兜底。
              const toks = topic
                .toLowerCase()
                .match(/[a-z0-9_+#.-]{2,}|[\u4e00-\u9fff]{2}/g) || []
              picked = view.memories
                .filter((m) => !ids.has(m.id))
                .map((m) => {
                  const hay = `${m.text} ${(m.tags || []).join(' ')}`.toLowerCase()
                  const hit = toks.filter((t) => hay.includes(t)).length
                  return { m, hit }
                })
                .filter((x) => x.hit > 0)
                .sort((a, b) => b.hit - a.hit || (b.m.weight || 3) - (a.m.weight || 3))
                .slice(0, relLimit)
                .map((x) => x.m)
            } catch (e) {
              log('相关记忆选取失败（本轮跳过）', e && e.message)
            }
            relevantSnapshots.set(relKey, picked)
          }
          relevant = relevantSnapshots.get(relKey) || []
        }

        const episodes = view.episodes.slice(0, epCount).slice(-Math.max(0, cfg.injectEpisodes))
        const text = renderSoulBlock({
          persona: view.persona,
          memories,
          relevant,
          episodes,
          handoff: pendingHandoff,
          nudge,
          session: sum.lastSession,
          previousSession: sum.previousSession,
          maxChars: cfg.promptMaxChars,
        })
        cache = { key, text }
        return text
      } catch (e) {
        log('灵魂块渲染失败（本轮退化为无注入）', e && e.message)
        return ''
      }
    }

    ctx.systemPrompt.section({
      name: 'soul:identity',
      order: Number(cfg.sectionOrder) || DEFAULTS.sectionOrder,
      text: buildText,
    })
  }

  // ---- 2. 被动捕获 + 项目交接观察 ----
  if (cfg.captureEpisodes !== false || cfg.captureCues !== false || cfg.autoHandoff !== false) {
    ctx.on(
      'session/event',
      (session, event) => {
        capture.handle(session, event)
        handoff.observe(session, event)
      },
      { global: true },
    )
  }

  // ---- 3. 工具与命令 ----
  let tools = { registered: 0, total: 0 }
  try {
    tools = registerTools(ctx, store, cfg, log, fail, handoff)
  } catch (e) {
    fail('工具注册', e)
  }
  registerCommand(ctx, store, cfg, log, fail, capture, handoff)

  // 启动即预热，首个请求就能带上记忆；这一行也用于确认工具真的注册上了
  store.ready.then(async (ok) => {
    const s = store.summary()
    console.log(
      `[dsh-anima] 就绪${ok ? '' : '（降级：仅内存态）'} · v${version} · 人格 v${s.personaVersion} · ${s.memories} 条记忆${s.dormant ? `（含 ${s.dormant} 条休眠）` : ''} / ${s.episodes} 条片段 · ${s.handoffs || 0} 份交接 · 工具 ${tools.registered}/${tools.total} · ${dir}`,
    )
    // 记忆攒多了自动整理一次：只合并高度重复的，不删任何内容
    if (ok && cfg.autoConsolidate !== false && s.memories >= Math.max(20, Number(cfg.consolidateAt) || 300)) {
      try {
        const r = await store.consolidate()
        if (r.merged) log(`自动整理：合并 ${r.groups.length} 组（归档 ${r.merged} 条重复）`)
      } catch (e) {
        log('自动整理失败（非致命）', e && e.message)
      }
    }
  })

  // 退出前把命中计数写回磁盘
  try {
    if (typeof ctx.on === 'function') {
      ctx.on('dispose', () => {
        store.flush().catch(() => {})
      })
    }
  } catch {
    /* 宿主没有 dispose 事件也不影响 */
  }

  return {
    dir,
    store,
    capture,
    handoff,
    flush: () => store.flush(),
  }
}
