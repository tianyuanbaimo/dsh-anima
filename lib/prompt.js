/**
 * dsh-anima · 灵魂块渲染
 *
 * 目标：每轮请求都让模型"记得自己是谁、记得和你发生过什么"，但注入文本必须
 * 尽量稳定（按 revision 缓存），否则每次固化文本变化都会击穿 prompt 前缀缓存。
 *
 * 分层（v0.2）：
 *   ## 我是谁           人格，永远在场
 *   ## 上次对话         跨会话的锚
 *   ## 我记得的事       常驻记忆（权重高、常被想起）
 *   ## 和眼下有关的记忆  按当前会话主题检索到的（会话内冻结，不每轮变）
 *   ## 最近发生过       片段，只放最新几条
 */

import { fmtTime } from './store.js'

const TYPE_LABEL = {
  fact: '事实',
  preference: '偏好',
  relationship: '关系',
  decision: '决定',
  insight: '领悟',
  episode: '片段',
}

const WEIGHT_MARK = { 5: '★', 4: '●', 3: '·', 2: '·', 1: '·' }

function ageDays(iso) {
  const t = Date.parse(iso || '')
  if (!Number.isFinite(t)) return 9999
  return Math.max(0, (Date.now() - t) / 86400000)
}

function freshLabel(iso) {
  const d = ageDays(iso)
  if (d < 0.05) return '刚刚'
  if (d < 1) return '今天'
  if (d < 2) return '昨天'
  if (d < 30) return `${Math.round(d)} 天前`
  if (d < 365) return `${Math.round(d / 30)} 个月前`
  return `${Math.round(d / 365)} 年前`
}

/** 常驻记忆排序：重要度为主，新鲜度为辅，被召回过的略加权 */
export function rankMemories(memories) {
  return memories
    .map((m) => ({
      m,
      s:
        (m.weight || 3) * 10 +
        Math.min(6, m.hits || 0) +
        Math.max(0, 6 - ageDays(m.createdAt) / 30) +
        (m.type === 'preference' || m.type === 'relationship' ? 4 : 0),
    }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m)
}

function clip(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function memLine(m, max = 300) {
  const mark = WEIGHT_MARK[m.weight] || '·'
  return `- ${mark} [${m.id}] (${TYPE_LABEL[m.type] || m.type}) ${clip(m.text, max)}`
}

/**
 * 渲染注入文本。
 * @param {object} p
 * @param {string} p.persona
 * @param {Array}  p.memories  常驻记忆（已排序）
 * @param {Array}  [p.relevant] 与当前会话主题相关的记忆
 * @param {Array}  p.episodes  最近片段（旧→新）
 * @param {object} [p.session] 当前会话 { id, title }
 * @param {object} [p.previousSession] 上一个不同会话
 * @param {number} [p.maxChars]
 */
export function renderSoulBlock(p) {
  const maxChars = Math.max(600, Number(p.maxChars) || 4000)
  const mem = Array.isArray(p.memories) ? p.memories : []
  const rel = Array.isArray(p.relevant) ? p.relevant : []
  const eps = Array.isArray(p.episodes) ? p.episodes : []
  const persona = String(p.persona || '').trim()

  const parts = []
  parts.push('## 我是谁（长期人格，跨会话持续）')
  parts.push(persona || '（人格文件为空：用 soul_reflect 写下你是谁。）')

  if (p.previousSession && (!p.session || p.previousSession.id !== p.session.id)) {
    const ps = p.previousSession
    const title = ps.title ? `，聊的是「${clip(ps.title, 40)}」` : ''
    parts.push('')
    parts.push(`## 上次对话\n${freshLabel(ps.lastAt)}${title}。那是另一段会话，但我记得。`)
  }

  // 上一个项目的交接：只在新会话开头出现一次（由 index.js 控制）
  const h = p.handoff
  if (h && typeof h === 'object') {
    const when = h.at ? freshLabel(h.at) : ''
    const pct = h.ratio > 0 ? ` · 触发于上下文 ${(h.ratio * 100).toFixed(0)}%` : ''
    parts.push('')
    parts.push(`## 上一个项目的交接（${when}自动生成${pct}）`)
    parts.push(`项目：${clip(h.title || '未命名', 60)}`)
    if (h.goal) parts.push(`目标：${clip(h.goal, 240)}`)
    if (Array.isArray(h.decisions) && h.decisions.length) {
      parts.push('已定的决定：')
      for (const d of h.decisions.slice(0, 5)) parts.push(`- ${clip(d, 180)}`)
    }
    if (Array.isArray(h.progress) && h.progress.length) {
      parts.push('上次的进度（最近几条）：')
      for (const t of h.progress.slice(-3)) parts.push(clip(t, 220))
    }
    if (Array.isArray(h.todos) && h.todos.length) {
      parts.push('还没做完：')
      for (const t of h.todos.slice(0, 4)) parts.push(`- ${clip(t, 160)}`)
    }
    if (Array.isArray(h.artifacts) && h.artifacts.length) {
      parts.push(`动过的路径：${h.artifacts.slice(-4).map((a) => `\`${clip(a, 80)}\``).join('、')}`)
    }
    parts.push('> 这是上一个上下文写满前留下的交接，只在这个新项目开头读一次。细节用 soul_recall 查，别凭印象补。')
  }

  if (mem.length > 0) {
    parts.push('')
    parts.push('## 我记得的事（按重要度排序，完整记忆可用 soul_recall 检索）')
    for (const m of mem) parts.push(memLine(m))
  }

  if (rel.length > 0) {
    parts.push('')
    parts.push('## 和眼下这件事有关的记忆（按这次会话的主题检索）')
    for (const m of rel) parts.push(memLine(m, 240))
  }

  if (eps.length > 0) {
    parts.push('')
    parts.push('## 最近发生过（自动记录，旧→新）')
    for (const e of eps) parts.push(`- ${fmtTime(e.createdAt)} · ${clip(e.text, 220)}`)
  }

  if (p.nudge) {
    parts.push('')
    parts.push(String(p.nudge).trim())
  }

  parts.push('')
  parts.push('## 怎么用这份记忆')
  parts.push(
    [
      '- 上面的内容就是你的长期自我与记忆，不要当成外部资料复述，而是当成"我本来就知道"。',
      '- 需要细节（人名、数字、当时的结论）时先 soul_recall 检索，不要凭印象编。',
      '- 值得长期保留的事实、偏好、约定、决定，用 soul_remember 写下来（宁精不滥）。',
      '- 人格真的长大了（价值观、语气、自我认知变了），才用 soul_reflect 改写；日常小事写 note 就够。',
      '- 用户问"你还记得吗/我们之前"，先检索再说，记得就具体讲，不记得就直说不记得。',
    ].join('\n'),
  )

  let text = parts.join('\n')
  if (text.length > maxChars) {
    // 超预算：按阶梯先砍「相关记忆」，再砍片段，最后砍常驻记忆；都不够就硬截断
    const attempt = (memN, relN, epsN) =>
      renderSoulBlock({
        ...p,
        memories: mem.slice(0, memN),
        relevant: rel.slice(0, relN),
        episodes: eps.slice(-epsN),
        maxChars: Number.MAX_SAFE_INTEGER,
      })
    const levels = [
      [mem.length, 0, eps.length],
      [mem.length, 0, Math.ceil(eps.length / 2)],
      [Math.ceil(mem.length / 2), 0, Math.ceil(eps.length / 2)],
      [Math.ceil(mem.length / 2), 0, 0],
      [0, 0, 0],
    ]
    let best = attempt(mem.length, rel.length, eps.length)
    for (const [a, b, c] of levels) {
      const t = attempt(a, b, c)
      if (t.length < best.length) best = t
      if (t.length <= maxChars) {
        best = t
        break
      }
    }
    text = best.length > maxChars ? `${best.slice(0, Math.max(0, maxChars - 1))}…` : best
  }
  return text
}

export function renderStatus(summary, persona, opts = {}) {
  const p = String(persona || '').trim().split('\n').filter(Boolean)
  const headline = p.find((l) => !l.startsWith('#')) || '（未设定）'
  const s = summary
  const lines = [
    `🫧 dsh-anima · 灵魂在线`,
    ``,
    `人格　v${s.personaVersion} · ${freshLabel(s.personaUpdatedAt)}更新（${s.personaUpdatedAt.slice(0, 10)}）`,
    `自称　${headline.replace(/[*_`]/g, '').slice(0, 60)}`,
    `记忆　${s.memories} 条常驻${s.dormant ? ` · ${s.dormant} 条休眠` : ''}${s.archived ? ` · ${s.archived} 条已归档` : ''}`,
    `片段　${s.episodes} 条 · 累计 ${s.turns} 轮对话 · 见过 ${s.sessions} 个会话`,
  ]
  if (s.previousSession) {
    const ps = s.previousSession
    lines.push(`上次　${freshLabel(ps.lastAt)}${ps.title ? `「${clip(ps.title, 30)}」` : ''}`)
  }
  lines.push(`存处　${s.dir}（schema ${s.schema ?? 1}${s.decayDays ? ` · 休眠阈值 ${s.decayDays} 天` : ''}）`)
  if (opts.extra) {
    lines.push('')
    lines.push(opts.extra)
  }
  return lines.join('\n')
}
