/**
 * dsh-anima · 项目交接（v0.3）
 *
 * 解决的问题：一个项目干到上下文快满时，模型会开始忘事、答非所问，而宿主压缩
 * 只会把旧消息压成摘要（丢分类、丢待办）。所以在水位到 95% 时，把"这个项目到
 * 哪一步了"整理成一份结构化交接，落到磁盘，并在下一个项目开头自动读一次。
 *
 * 三步：
 *   1) 盯水位：ctx.tokenMeter.measure(session) / 模型容量 → ratio
 *   2) 等收尾：本轮有未完成的工具调用时不打断，turn/end 且无挂起调用才算"项目完成"
 *   3) 交接：写成 handoffs/<时间>-<id>.md + 一条 JSON 记录 + 把决定写回记忆（与记忆插件对齐）
 *
 * 依赖全用宿主可选服务（ctx.get），拿不到就降级，绝不抛到对话里。
 */

import { fmtTime } from './store.js'

function sidOf(session) {
  try {
    return session?.header?.id || session?.id || ''
  } catch {
    return ''
  }
}

function cwdOf(session) {
  try {
    return session?.header?.cwd || session?.meta?.cwd || ''
  } catch {
    return ''
  }
}

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function uniq(list) {
  return [...new Set(list.filter(Boolean))]
}

/** 从事件里抠出可能被"动过"的路径：工具参数里的绝对路径 */
function pathsOf(data) {
  let raw = ''
  try {
    raw = JSON.stringify(data || {})
  } catch {
    return []
  }
  const out = []
  const win = raw.match(/[A-Za-z]:\\\\[^"',;]{2,180}/g) || []
  const win2 = raw.match(/[A-Za-z]:\\[^"',;]{2,180}/g) || []
  const posix = raw.match(/\/(?:home|Users|opt|srv|tmp|var)\/[^"',;\s]{2,180}/g) || []
  for (const m of [...win, ...win2, ...posix]) {
    const p = m.replace(/\\\\/g, '\\').replace(/[\s)]+$/, '')
    if (p.length > 3) out.push(p)
  }
  return uniq(out).slice(0, 8)
}

/** 从回答里挑出"待办/下一步"这类句子 */
function todosFrom(text) {
  const out = []
  for (const line of String(text || '').split(/\n+/)) {
    const s = line.trim()
    if (!s) continue
    if (/^[-*]\s*\[?\s?\]?\s*(待办|下一步|TODO|todo)/.test(s) || /(待办|下一步要|还没做|尚未|需要你确认|等你确认)/.test(s)) {
      out.push(clip(s.replace(/^[-*]\s*/, ''), 160))
    }
  }
  return out.slice(0, 6)
}

export function createHandoff({ ctx, store, capture, cfg = {}, log = () => {} }) {
  const threshold = Math.min(0.99, Math.max(0.5, Number(cfg.handoffAt) || 0.95))
  const track = new Map() // sid -> { window, model, pendingCalls, armed, ratio, firedId, lastNote }
  let lastWindow = 0 // request/context 里看到的最近一个容量，作为兜底

  function stateFor(sid) {
    let s = track.get(sid)
    if (!s) {
      s = { window: 0, model: '', pendingCalls: 0, armed: false, ratio: 0, firedId: '', lastNote: '' }
      track.set(sid, s)
      if (track.size > 64) track.delete(track.keys().next().value)
    }
    return s
  }

  function windowOf(sid) {
    const s = stateFor(sid)
    if (s.window > 0) return s.window
    if (lastWindow > 0) {
      s.window = lastWindow
      return lastWindow
    }
    try {
      const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : null
      const info = llm?.resolveModelInfo?.()
      const w = Number(info?.context || info?.contextWindow || info?.maxContext || 0)
      if (w > 0) {
        s.window = w
        s.model = info?.model || s.model
        return w
      }
    } catch {
      /* 拿不到就算了 */
    }
    return 0
  }

  /** 当前上下文水位：已知容量与用量时才给 known=true */
  function pressure(session) {
    const sid = sidOf(session)
    const s = stateFor(sid)
    let used = 0
    try {
      const tm = typeof ctx?.get === 'function' ? ctx.get('tokenMeter') : null
      const m = tm?.measure?.(session)
      used = Number(m?.totalTokens || m?.surfaceTokens || 0) || 0
    } catch {
      /* ignore */
    }
    const win = windowOf(sid)
    const ratio = win > 0 && used > 0 ? Math.min(1, used / win) : 0
    s.ratio = ratio
    return { used, window: win, ratio, known: win > 0 && used > 0, armed: s.armed }
  }

  function observeWindow(event) {
    if (!event || event.type !== 'request/context') return
    const d = event.data || {}
    const w = Number(d.contextWindow || d.window || d.context?.window || d.limit || 0)
    if (w > 0) lastWindow = w
    for (const s of track.values()) {
      if (w > 0 && (!s.window || s.window > w * 4)) s.window = w
    }
  }

  function rememberPaths(sid, event) {
    const s = stateFor(sid)
    const hit = pathsOf(event?.data)
    if (hit.length) s.paths = uniq([...(s.paths || []), ...hit]).slice(-40)
    if (event?.type === 'tool/call') s.pendingCalls += 1
    if (event?.type === 'tool/result') s.pendingCalls = Math.max(0, s.pendingCalls - 1)
  }

  /** 组装交接内容（纯函数，便于测试） */
  function build(session, opts = {}) {
    const sid = sidOf(session)
    const st = stateFor(sid)
    const sess = store.sessionIndex?.().get(sid) || {}
    const turns = (capture?.recentTurns?.(sid, 8) || []).slice()
    const memView = store.viewSync()
    const inSession = memView.memories.filter((m) => m.sessionId === sid)
    const decisions = (inSession.length ? inSession : memView.memories)
      .filter((m) => m.type === 'decision')
      .slice(-6)
      .map((m) => clip(m.text, 180))
    const goal = clip(turns[0]?.user || sess.title || '', 260)
    const progress = turns.slice(-6).map((t) => {
      const ask = clip(t.user, 120)
      const ans = t.assistant ? ` → 我：${clip(t.assistant, 200)}` : ''
      return `- 用户：${ask}${ans}`
    })
    const todos = uniq(turns.flatMap((t) => todosFrom(t.assistant))).slice(0, 6)
    const artifacts = uniq([...(st.paths || []), ...(capture?.recentPaths?.(sid, 20) || [])]).slice(-12)
    const p = pressure(session)
    return {
      sessionId: sid,
      cwd: cwdOf(session),
      title: clip(sess.title || turns[0]?.user || '未命名项目', 80),
      ratio: p.ratio,
      window: p.window,
      used: p.used,
      reason: opts.reason || 'threshold',
      goal,
      decisions,
      progress,
      todos,
      artifacts,
      note: clip(opts.note || '', 300),
      turns: turns.length,
      at: new Date().toISOString(),
    }
  }

  function toMarkdown(rec) {
    const lines = []
    lines.push(`# 项目交接 · ${rec.title}`)
    lines.push('')
    lines.push(`- 时间：${fmtTime(rec.at)}`)
    lines.push(`- 来源会话：\`${rec.sessionId || '未知'}\`${rec.cwd ? ` · 工作目录 \`${rec.cwd}\`` : ''}`)
    if (rec.window > 0) {
      lines.push(`- 触发：上下文 ${(rec.ratio * 100).toFixed(1)}%（${rec.used.toLocaleString()} / ${rec.window.toLocaleString()} tokens）`)
    } else {
      lines.push(`- 触发：${rec.reason}`)
    }
    lines.push('')
    lines.push('## 目标')
    lines.push(rec.goal || '（没记到明确目标）')
    lines.push('')
    lines.push('## 已定的决定')
    lines.push(rec.decisions.length ? rec.decisions.map((d) => `- ${d}`).join('\n') : '- （这一段没有落成决定的条目）')
    lines.push('')
    lines.push('## 进度（最近几轮）')
    lines.push(rec.progress.length ? rec.progress.join('\n') : '- （无）')
    lines.push('')
    lines.push('## 动过的文件/路径')
    lines.push(rec.artifacts.length ? rec.artifacts.map((a) => `- \`${a}\``).join('\n') : '- （无）')
    lines.push('')
    lines.push('## 待办 / 没做完的')
    lines.push(rec.todos.length ? rec.todos.map((t) => `- ${t}`).join('\n') : '- （没有显式待办；接着做时先看「进度」最后一条）')
    if (rec.note) {
      lines.push('')
      lines.push('## 补充说明')
      lines.push(rec.note)
    }
    return lines.join('\n')
  }

  /** 写盘 + 把决定回灌记忆（和记忆插件对齐） */
  async function write(rec) {
    const markdown = toMarkdown(rec)
    let saved = null
    try {
      saved = await store.addHandoff({ ...rec, markdown })
    } catch (e) {
      log('交接写入失败', e && e.message)
      return { ok: false, reason: String((e && e.message) || e), markdown }
    }
    // 决定与待办回灌成长期记忆：这样即便交接文件丢了，记忆里也有
    for (const d of rec.decisions.slice(-4)) {
      try {
        await store.addMemory({ text: d, type: 'decision', weight: 4, tags: ['handoff'], sessionId: rec.sessionId, source: 'handoff' })
      } catch (e) {
        log('交接决定回灌失败（忽略）', e && e.message)
      }
    }
    for (const t of rec.todos.slice(0, 3)) {
      try {
        await store.addMemory({ text: `待办（交接留下）：${t}`, type: 'decision', weight: 3, tags: ['handoff', 'todo'], sessionId: rec.sessionId, source: 'handoff' })
      } catch (e) {
        log('交接待办回灌失败（忽略）', e && e.message)
      }
    }
    // 兜底：即使没有决定/待办，也留一条可检索的项目记忆，保证"与记忆插件对齐"
    if (rec.decisions.length === 0 && rec.todos.length === 0) {
      try {
        await store.addMemory({
          text: `项目交接「${rec.title}」：${clip(rec.goal || '（无明确目标）', 320)}`,
          type: 'insight',
          weight: 3,
          tags: ['handoff'],
          sessionId: rec.sessionId,
          source: 'handoff',
        })
      } catch (e) {
        log('交接摘要回灌失败（忽略）', e && e.message)
      }
    }
    try {
      await store.appendJournal(`## ${fmtTime(rec.at)} · 项目交接「${rec.title}」\n${rec.goal ? `${rec.goal}\n` : ''}${rec.todos.length ? `待办 ${rec.todos.length} 条。\n` : ''}`)
    } catch {
      /* 日志写不进去不影响交接 */
    }
    return { ok: true, handoff: saved, markdown }
  }

  /** 尽力开一个新会话（宿主不暴露持久化句柄时会失败，失败就只留交接文件） */
  async function spawnNext(rec) {
    if (cfg.handoffNewSession === false) return { ok: false, reason: 'disabled-by-config' }
    let sessions = null
    try {
      sessions = (typeof ctx?.get === 'function' ? ctx.get('sessions') : null) || ctx?.sessions || null
    } catch {
      sessions = null
    }
    if (!sessions || typeof sessions.create !== 'function') return { ok: false, reason: 'no-sessions-service' }
    const id = `anima-${Date.now().toString(36)}`
    try {
      const created = sessions.create(id, { meta: { cwd: rec.cwd || undefined } })
      try {
        await sessions.flush?.(created)
      } catch {
        /* 不是所有宿主都实现 flush */
      }
      return { ok: true, sessionId: id }
    } catch (e) {
      return { ok: false, reason: String((e && e.message) || e) }
    }
  }

  /** 立即生成一份交接（工具/命令/自动触发共用） */
  async function force(session, reason = 'manual', note = '') {
    const rec = build(session, { reason, note })
    const wrote = await write(rec)
    let spawn = { ok: false, reason: 'skipped' }
    if (wrote.ok && (cfg.autoHandoff !== false || reason === 'manual')) {
      spawn = await spawnNext(rec)
      if (spawn.ok) {
        try {
          await store.markHandoffSpawned(wrote.handoff.id, spawn.sessionId)
        } catch {
          /* 标记失败不影响主线 */
        }
      }
    }
    const st = stateFor(rec.sessionId)
    st.armed = false
    st.firedId = wrote.handoff?.id || ''
    return { ...wrote, spawn, rec }
  }

  /** 每个事件都调：只做常量级判断 */
  function observe(session, event) {
    try {
      const type = event?.type
      const sid = sidOf(session)
      if (!type || !sid) return
      if (type === 'request/context') {
        observeWindow(event)
        return
      }
      if (type === 'tool/call' || type === 'tool/result') {
        rememberPaths(sid, event)
        return
      }
      // 用户新消息 / 轮次结束都可以判水位：警戒要早，收尾要等
      if (type === 'user/message' || type === 'turn/end') {
        if (cfg.autoHandoff === false) return
        const st = stateFor(sid)
        const p = pressure(session)
        if (p.known && p.ratio >= threshold && !st.armed) {
          st.armed = true
          log(`上下文 ${(p.ratio * 100).toFixed(1)}% ≥ 阈值 ${(threshold * 100).toFixed(0)}%：本项目收尾后自动交接`)
          if (type === 'user/message') return
        }
        if (type !== 'turn/end') return
        // 已警戒：等"项目完成"（无挂起的工具调用、本轮正常结束）再交接。
        // 延后到下一个宏任务：让 capture 先把本轮片段/回答写进环形缓冲，交接才能读到最新一轮。
        if (st.armed && st.pendingCalls === 0) {
          const kind = event?.data?.reason?.kind || event?.data?.reason || 'completed'
          if (kind === 'completed' || kind === 'stop' || kind === 'end_turn') {
            setTimeout(() => {
              force(session, 'threshold').catch((e) => log('自动交接失败（忽略）', e && e.message))
            }, 0)
          }
        }
      }
    } catch (e) {
      log('交接观察异常（已忽略）', e && e.message)
    }
  }

  /** 给注入块用：水位告警（只在警戒中且有会话时返回文本） */
  function nudge(session) {
    const sid = sidOf(session || {})
    const st = stateFor(sid)
    if (!st.armed) return ''
    const pct = st.ratio > 0 ? `${(st.ratio * 100).toFixed(0)}%` : '接近上限'
    return [
      `## 上下文水位告警（当前约 ${pct}）`,
      '- 这一段上下文快装不下了：先把当前项目**收尾**（给结论、写清没做完的），别急着开新话题。',
      '- 收尾完调用 `soul_handoff`（或用户输入 `/soul handoff now`）生成本项目交接；插件会在新项目开头自动读一次。',
    ].join('\n')
  }

  /** 给注入块用：新项目开头读一次的交接内容 */
  function forPrompt(session) {
    const sid = sidOf(session || {})
    const latest = store.latestHandoff?.()
    if (!latest) return null
    if (!sid) return latest
    if (latest.sessionId === sid) return null // 同一会话里不重复喂自己刚写的交接
    // 只在新会话开头读一次：该会话还没有任何片段
    const view = store.viewSync()
    if (view.episodes.some((e) => e.sessionId === sid)) return null
    return latest
  }

  return { pressure, nudge, forPrompt, build, write, force, observe, threshold }
}
