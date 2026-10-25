/**
 * dsh-anima —— 让 DSH 拥有不会随关机、换会话而消失的记忆与人格。
 *
 * 三个注入点：
 *   1) systemPrompt.section  —— 每轮都在场的「我是谁 + 我记得什么」（按版本缓存，不破坏前缀缓存）
 *   2) session/event 监听    —— 零 token 地把你我发生过的对话压缩成片段与线索记忆
 *   3) tools + commands      —— 模型可主动读写记忆；用户可用 /soul 查看与改写人格
 *
 * 持久化在 ~/.dsh/anima/（$DSH_HOME 优先），与工作区、会话都无关。
 */

import os from 'node:os'
import path from 'node:path'
import { createStore } from './store.js'
import { createCapture } from './capture.js'
import { renderSoulBlock, rankMemories } from './prompt.js'
import { registerTools, registerCommand } from './tools.js'

export const name = 'dsh-anima'
export const inject = ['tools', 'commands', 'systemPrompt']

const DEFAULTS = {
  dataDir: '',
  inject: true,
  promptMaxChars: 4000,
  injectMemories: 24,
  injectEpisodes: 6,
  captureEpisodes: true,
  captureCues: true,
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

  const store = createStore({ dir, log })
  const capture = createCapture({ store, cfg, log })

  // ---- 1. 常驻注入 ----
  if (cfg.inject !== false) {
    // 同一会话内保持文本稳定：按「记忆版本 + 会话」缓存。
    // 记忆/人格一变就重建；片段快照在会话首次装配时冻结，避免每轮击穿前缀缓存。
    const episodeSnapshots = new Map()
    let cache = { key: '', text: '' }

    const buildText = () => {
      try {
        const sum = store.summary()
        const sid = sum.lastSession ? sum.lastSession.id : ''
        const memRev = store.memoryRevision
        if (!episodeSnapshots.has(sid)) {
          if (episodeSnapshots.size > 16) episodeSnapshots.clear()
          episodeSnapshots.set(sid, store.viewSync().episodes.length)
        }
        const epCount = episodeSnapshots.get(sid)
        const key = `${memRev}|${sid}|${epCount}`
        if (cache.key === key) return cache.text

        const view = store.viewSync()
        const memories = rankMemories(view.memories).slice(0, Math.max(1, cfg.injectMemories))
        const episodes = view.episodes.slice(0, epCount).slice(-Math.max(0, cfg.injectEpisodes))
        const text = renderSoulBlock({
          persona: view.persona,
          memories,
          episodes,
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

  // ---- 2. 被动捕获 ----
  if (cfg.captureEpisodes !== false || cfg.captureCues !== false) {
    ctx.on('session/event', (session, event) => capture.handle(session, event), { global: true })
  }

  // ---- 3. 工具与命令 ----
  let tools = { registered: 0, total: 0 }
  try {
    tools = registerTools(ctx, store, cfg, log, fail)
  } catch (e) {
    fail('工具注册', e)
  }
  registerCommand(ctx, store, cfg, log, fail)

  // 启动即预热，首个请求就能带上记忆；这一行也用于确认工具真的注册上了
  store.ready.then((ok) => {
    const s = store.summary()
    console.log(
      `[dsh-anima] 就绪${ok ? '' : '（降级：仅内存态）'} · 人格 v${s.personaVersion} · ${s.memories} 条记忆 / ${s.episodes} 条片段 · 工具 ${tools.registered}/${tools.total} · ${dir}`,
    )
  })

  return {
    dir,
    store,
    capture,
  }
}
