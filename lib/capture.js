/**
 * dsh-anima · 被动记忆捕获
 *
 * 挂在 session/event 上，几乎零成本、零 token：
 *   user/message → 记下这轮用户说了什么（同时作为会话标题来源）
 *   turn/end     → 把「用户说 X / 我答 Y」压成一条片段写盘
 *   显式记忆线索（"记住""我喜欢""以后都"…）→ 额外落一条高权重长期记忆
 *
 * 两个坑（2026-10-25 修）：
 *   1. 宿主的 user/message 事件 data 里**没有 turn 字段**（assistant/message 和 turn/end 才有），
 *      按 `${sid}:${turn}` 配对会让 user 存进 :0、turn/end 去找 :1，永远配不上 → 片段恒为 0。
 *      现在改成「按会话排队，turn/end 取队首那条有用户话的记录」。
 *   2. assistant/message 的 content 里混着 type:"reasoning" 的思考过程，按 'text' 键盲取会把
 *      内心独白当成回答写进片段。现在只取 type === "text" 的部分。
 *
 * 任何异常都被吞掉：记忆系统坏了也绝不能影响对话本身。
 */

import { fmtTime } from './store.js'

const CUE = /(记住|记一下|记下来|别忘了|别忘记|不要忘|以后都|以后要|以后别|从现在起|从今往后|我们约定|我们说好|我的名字|我叫[^，。,\s]{1,12}|我喜欢|我不喜欢|我讨厌|我习惯|我的偏好|remember\b|never forget|from now on|my name is|i prefer|i hate|always use|don't ever)/i

const PREF_CUE = /(我喜欢|我不喜欢|我讨厌|我习惯|我的偏好|偏好|i prefer|i hate|i like|always use|don't ever)/i

/**
 * 宿主每轮会往 user/message 里塞一段注入的运行时上下文（"Current runtime context." 开头），
 * 它不是用户说的话。若不当成用户消息，片段会被这类样板文污染 —— 回放真实日志时 29 条片段里
 * 有 14 条正是它。这里直接丢掉。
 */
const BOILERPLATE = /^(current runtime context\.|current working directory:|current dsh file policy:|approval policy:|time sampled while preparing|<system-reminder>)/i

function isInjectedContext(text) {
  if (!text) return true
  if (BOILERPLATE.test(text)) return true
  const t = text.slice(0, 400)
  if (t.includes('Browser time zone for this request:')) return true
  return t.includes('Current DSH file policy:') && t.includes('Current working directory:')
}

/**
 * 从事件数据里取「人话」。
 * - 数组：只收 type 缺省或为 "text" 的项，跳过 reasoning / tool-call 之类
 * - 对象：优先 content / message / text
 */
export function extractText(value, depth = 0) {
  if (depth > 6 || value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (!part || typeof part !== 'object') return extractText(part, depth + 1)
        const kind = part.type
        if (kind && kind !== 'text') return ''
        return extractText(part, depth + 1)
      })
      .filter(Boolean)
      .join(' ')
  }
  if (typeof value !== 'object') return ''
  for (const key of ['content', 'message', 'text', 'surface', 'parts', 'children', 'value']) {
    if (key in value) {
      const got = extractText(value[key], depth + 1)
      if (got.trim()) return got
    }
  }
  return ''
}

function sessionId(session) {
  try {
    return session?.header?.id || session?.id || ''
  } catch {
    return ''
  }
}

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

export function createCapture({ store, cfg, log = () => {} }) {
  const pending = new Map() // sessionId -> [{ user, parts: [], cued: [] }]
  const turnsRing = new Map() // sessionId -> [{ user, assistant, turn, at }]，只留最近 12 轮给交接用
  const pathsRing = new Map() // sessionId -> [path]，工具碰过的路径
  // skipped 分原因统计：出问题时能一眼看出是「注入被误判」还是「配对没对上」
  const stats = { user: 0, assistant: 0, turnEnd: 0, episodes: 0, skipped: 0, skippedInjected: 0, skippedEmpty: 0 }
  let current = { sessionId: '' }

  function ring(map, sid, max) {
    let list = map.get(sid)
    if (!list) {
      list = []
      map.set(sid, list)
      if (map.size > 64) map.delete(map.keys().next().value)
    }
    if (list.length > max) list.splice(0, list.length - max)
    return list
  }

  function queue(sid) {
    let q = pending.get(sid)
    if (!q) {
      q = []
      pending.set(sid, q)
      if (pending.size > 64) pending.delete(pending.keys().next().value)
    }
    return q
  }

  function newRecord(sid) {
    const q = queue(sid)
    const rec = { user: '', parts: [], cued: [] }
    q.push(rec)
    if (q.length > 8) q.shift()
    return rec
  }

  /** 当前这一轮：队列尾若还没用户话就复用它，否则新开一条 */
  function turnRecord(sid) {
    const q = queue(sid)
    const last = q[q.length - 1]
    if (last && !last.user) return last
    return newRecord(sid)
  }

  /** 回答永远挂到队列尾（那一轮）上：即便它已经有用户话了 */
  function answerRecord(sid) {
    const q = queue(sid)
    return q.length ? q[q.length - 1] : newRecord(sid)
  }

  function textOf(event) {
    return extractText(event?.data).trim()
  }

  async function onUserMessage(session, event) {
    const sid = sessionId(session)
    if (!sid) return
    const text = textOf(event)
    if (!text || text.startsWith('/')) {
      stats.skippedEmpty++
      return
    }
    if (isInjectedContext(text)) {
      stats.skippedInjected++
      return
    }
    const rec = turnRecord(sid)
    if (rec.user) return // 同一轮多段输入只记第一段，避免重复
    rec.user = clip(text, 1200)
    stats.user++
    if (CUE.test(text)) rec.cued.push(...text.split(/\n+/).slice(0, 3).map((s) => s.trim()).filter(Boolean))

    const isFirst = !(store.sessionIndex().get(sid) || {}).title
    if (isFirst) {
      try {
        await store.touchSession({ id: sid, title: clip(text, 60) })
      } catch (e) {
        log('会话标题写入失败', e && e.message)
      }
    }
    current = { sessionId: sid }
  }

  function onAssistantMessage(session, event) {
    const sid = sessionId(session)
    if (!sid) return
    const text = textOf(event)
    if (!text) return
    const rec = answerRecord(sid)
    rec.parts.push(clip(text, 1200))
    if (rec.parts.length > 6) rec.parts.shift()
    stats.assistant++
  }

  async function onTurnEnd(session, event) {
    const sid = sessionId(session)
    if (!sid) return
    stats.turnEnd++
    const q = queue(sid)
    const turn = Number(event?.data?.turn ?? 0) || 0

    // 取「最后一条」有用户话的记录：一轮里可能有多段输入，最新那段才是这一轮的问
    let idx = -1
    for (let i = q.length - 1; i >= 0; i--) {
      if (q[i].user) {
        idx = i
        break
      }
    }
    if (idx < 0) {
      stats.skipped++
      return
    }
    const rec = q.splice(idx, 1)[0]
    if (idx > 0) q.splice(0, idx) // 更早的残留记录（上个没人收尾的轮）一并丢掉，避免跨轮错位
    const assistant = rec.parts.join(' … ')

    // 交接用的环形缓冲：只留最近 12 轮，供 soul_handoff 组装「进度」
    const turns = ring(turnsRing, sid, 12)
    turns.push({ user: rec.user, assistant: assistant.slice(0, 800), turn, at: new Date().toISOString() })
    if (turns.length > 12) turns.splice(0, turns.length - 12)

    // 1) 片段：给下一次对话/下一个会话提供连续性
    if (cfg.captureEpisodes !== false) {
      const line = `用户：${rec.user.slice(0, 300)}${assistant ? ` ｜ 我：${assistant.slice(0, 400)}` : ''}`
      try {
        await store.addEpisode({ text: line, sessionId: sid, turn, title: rec.user.slice(0, 60) })
        stats.episodes++
      } catch (e) {
        log('片段写入失败', e && e.message)
      }
    }

    // 2) 显式线索：直接升格为长期记忆
    if (cfg.captureCues !== false && rec.cued.length > 0) {
      const merged = clip(rec.cued.join(' ／ '), 400)
      try {
        await store.addMemory({
          text: merged,
          type: PREF_CUE.test(merged) ? 'preference' : 'fact',
          weight: 4,
          tags: ['auto'],
          sessionId: sid,
          source: 'cue',
        })
      } catch (e) {
        log('线索记忆写入失败', e && e.message)
      }
    }
    log(`turn ${turn} 已记忆 · ${fmtTime()}（片段 ${stats.episodes}）`)
  }

  /** 交接用：最近几轮的「用户说 / 我答」 */
  function recentTurns(sid, limit = 8) {
    const list = turnsRing.get(sid) || []
    return list.slice(-Math.max(1, limit))
  }

  /** 交接用：这段会话里工具碰过的路径 */
  function recentPaths(sid, limit = 20) {
    const list = pathsRing.get(sid) || []
    return [...new Set(list)].slice(-Math.max(1, limit))
  }

  function collectPaths(sid, event) {
    if (event?.type !== 'tool/call') return
    let raw = ''
    try {
      raw = JSON.stringify(event.data || {})
    } catch {
      return
    }
    const hits = raw.match(/[A-Za-z]:\\\\[^"',;]{2,180}|[A-Za-z]:\\[^"',;]{2,180}|\/(?:home|Users|opt|srv|tmp|var)\/[^"',;\s]{2,180}/g) || []
    if (!hits.length) return
    const list = ring(pathsRing, sid, 40)
    for (const h of hits) {
      const p = h.replace(/\\\\/g, '\\').replace(/[\s)]+$/, '')
      if (p.length > 3) list.push(p)
    }
    if (list.length > 40) list.splice(0, list.length - 40)
  }

  function handle(session, event) {
    const type = event?.type
    if (!type) return
    Promise.resolve()
      .then(() => {
        if (type === 'tool/call') {
          const sid = sessionId(session)
          if (sid) collectPaths(sid, event)
          return undefined
        }
        if (type === 'user/message') return onUserMessage(session, event)
        if (type === 'assistant/message') return onAssistantMessage(session, event)
        if (type === 'turn/end') return onTurnEnd(session, event)
        return undefined
      })
      .catch((e) => log('捕获异常（已忽略）', e && e.message))
  }

  return {
    handle,
    recentTurns,
    recentPaths,
    getStats: () => ({ ...stats, pending: [...pending.values()].reduce((n, q) => n + q.length, 0) }),
    get activeSessionId() {
      return current.sessionId
    },
  }
}
