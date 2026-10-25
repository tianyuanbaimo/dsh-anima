/**
 * dsh-anima · 被动记忆捕获
 *
 * 挂在 session/event 上，几乎零成本、零 token：
 *   user/message → 记下这轮用户说了什么（同时作为会话标题来源）
 *   turn/end     → 把「用户说 X / 我答 Y」压缩成一条片段写盘
 *   显式记忆线索（"记住""我喜欢""以后都"…）→ 额外落一条高权重长期记忆
 *
 * 任何异常都被吞掉：记忆系统坏了也绝不能影响对话本身。
 */

import { fmtTime } from './store.js'

const CUE = /(记住|记一下|记下来|别忘了|别忘记|不要忘|以后都|以后要|以后别|从现在起|从今往后|我们约定|我们说好|我的名字|我叫[^，。,\s]{1,12}|我喜欢|我不喜欢|我讨厌|我习惯|我的偏好|remember\b|never forget|from now on|my name is|i prefer|i hate|always use|don't ever)/i

const PREF_CUE = /(我喜欢|我不喜欢|我讨厌|我习惯|我的偏好|偏好|i prefer|i hate|i like|always use|don't ever)/i

export function extractText(value, depth = 0) {
  if (depth > 5 || value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map((v) => extractText(v, depth + 1)).filter(Boolean).join(' ')
  }
  if (typeof value !== 'object') return ''
  const keys = ['text', 'content', 'surface', 'parts', 'children', 'value', 'message']
  for (const k of keys) {
    if (k in value) {
      const got = extractText(value[k], depth + 1)
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
  const buffers = new Map() // sessionId -> { turn, user, assistant, cued }
  let current = { sessionId: '' }

  function buf(sid, turn) {
    const key = `${sid}:${turn}`
    let b = buffers.get(key)
    if (!b) {
      b = { turn, user: '', assistant: '', assistantParts: [], cued: [] }
      buffers.set(key, b)
      // 防泄漏：最多同时跟踪 32 轮
      if (buffers.size > 32) {
        const oldest = buffers.keys().next().value
        buffers.delete(oldest)
      }
    }
    return b
  }

  function textOf(event) {
    return extractText(event?.data).trim()
  }

  async function onUserMessage(session, event) {
    const sid = sessionId(session)
    if (!sid) return
    const text = textOf(event)
    if (!text || text.startsWith('/')) return
    const turn = Number(event?.data?.turn ?? 0) || 0
    const b = buf(sid, turn)
    if (b.user) return // 同一轮多段输入只记第一段，避免重复
    b.user = clip(text, 1200)
    if (CUE.test(text)) b.cued.push(...text.split(/\n+/).slice(0, 3).map((s) => s.trim()).filter(Boolean))

    const isFirst = !(store.sessionIndex().get(sid) || {}).title
    await store.touchSession({
      id: sid,
      title: isFirst ? clip(text, 60) : undefined,
    })
    current = { sessionId: sid }
  }

  function onAssistantMessage(session, event) {
    const sid = sessionId(session)
    if (!sid) return
    const text = textOf(event)
    if (!text) return
    const turn = Number(event?.data?.turn ?? 0) || 0
    const b = buf(sid, turn)
    const cleaned = text.replace(/\s+/g, ' ').trim()
    if (!cleaned) return
    b.assistantParts.push(cleaned)
    if (b.assistantParts.length > 6) b.assistantParts.shift()
    b.assistant = clip(b.assistantParts.join(' … '), 1200)
  }

  async function onTurnEnd(session, event) {
    const sid = sessionId(session)
    if (!sid) return
    const turn = Number(event?.data?.turn ?? 0) || 0
    const key = `${sid}:${turn}`
    const b = buffers.get(key)
    buffers.delete(key)
    if (!b || !b.user) return

    // 1) 片段：给下一次对话/下一个会话提供连续性
    if (cfg.captureEpisodes !== false) {
      const line = `${b.user.slice(0, 200)}${b.assistant ? ` ｜ 我：${b.assistant.slice(0, 240)}` : ''}`
      await store.addEpisode({ text: line, sessionId: sid, turn, title: b.user.slice(0, 60) })
    }

    // 2) 显式线索：直接升格为长期记忆
    if (cfg.captureCues !== false && b.cued.length > 0) {
      const merged = clip(b.cued.join(' ／ '), 400)
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
    log(`turn ${turn} 已记忆 · ${fmtTime()}`)
  }

  function handle(session, event) {
    const type = event?.type
    if (!type) return
    Promise.resolve()
      .then(() => {
        if (type === 'user/message') return onUserMessage(session, event)
        if (type === 'assistant/message') return onAssistantMessage(session, event)
        if (type === 'turn/end') return onTurnEnd(session, event)
        return undefined
      })
      .catch((e) => log('捕获异常（已忽略）', e && e.message))
  }

  return { handle, get activeSessionId() { return current.sessionId } }
}
