/**
 * dsh-anima · 注入渲染（v0.4：三路注入 + 硬预算）
 *
 * 三路：
 *   1. 灵魂设定（persona，永远在最前）
 *   2. 必须守住的（重要卡片 / rule 类型，低频但优先级最高）
 *   3. 最近聊到的（最近 N 张卡）
 *   4. 和这件事有关的（检索 + 重排后的 Top-3，附细节展开提示）
 *
 * 预算：默认 2000 字（config.memBudget）。超了按 相关 → 最近 → 重要 的顺序砍，
 * 最后还超就硬截断——宁可少一段，也不让记忆挤掉对话。
 */

import { fmtTime } from './store.js'

export const TYPE_LABEL = {
  rule: '规矩',
  preference: '偏好',
  emotion: '情绪',
  fact: '事实',
  decision: '决定',
  relationship: '关系',
  insight: '领悟',
  episode: '片段',
}

export function clip(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  if (s.length <= n) return s
  return `${s.slice(0, Math.max(0, n - 1))}…`
}

function cardLine(c, { withFacts = false } = {}) {
  const mark = c.important ? '★' : ''
  const kinds = (c.types || []).map((t) => TYPE_LABEL[t] || t).slice(0, 2).join('/')
  const tail = withFacts && c.factsCount > 0 ? `（细节 ${c.factsCount} 条，soul_card ${c.id} 可展开）` : ''
  return `- ${mark}[${kinds}] ${clip(c.summary, 140)}${tail}`
}

function sessionBlock(session, previousSession) {
  const out = []
  const cur = session || null
  if (cur && cur.title) out.push(`- 这个会话：${clip(cur.title, 60)}（${fmtTime(cur.startedAt)}）`)
  if (previousSession && previousSession.id !== cur?.id) {
    out.push(`- 上次对话：${clip(previousSession.title || '(无标题)', 60)}（${fmtTime(previousSession.lastAt || previousSession.startedAt)}）`)
  }
  return out
}

/**
 * @param {{
 *   persona: string,
 *   important?: Array, recent?: Array, relevant?: Array,
 *   episodes?: Array, session?: object, previousSession?: object,
 *   maxChars?: number, handoff?: object|null, nudge?: string|null, stats?: object
 * }} p
 */
export function renderSoulBlock(p = {}) {
  const maxChars = Number(p.maxChars) > 0 ? Number(p.maxChars) : 2000
  const important = p.important || []
  const recent = p.recent || []
  const relevant = p.relevant || []
  const episodes = p.episodes || []

  // 人格按自己的预算裁，不占记忆的额度：记忆预算只约束下面这些小节
  // 没给 personaCap 时退回旧语义（整个人格块受 maxChars 约束）
  const personaCap = Number(p.personaCap) > 0 ? Number(p.personaCap) : maxChars
  const persona = truncateAt(String(p.persona || '').trim(), personaCap)
  const head = [persona]
  if (p.handoff) head.push(renderHandoff(p.handoff))
  if (p.nudge) head.push(p.nudge)

  const sections = []
  if (important.length) {
    sections.push({ name: 'must', text: ['## 我必须守住的', ...important.map((c) => cardLine(c))].join('\n') })
  }
  if (relevant.length) {
    sections.push({ name: 'relevant', text: ['## 和眼下这件事有关的记忆', ...relevant.map((c) => cardLine(c, { withFacts: true }))].join('\n') })
  }
  if (recent.length) {
    sections.push({ name: 'recent', text: ['## 最近聊到的', ...recent.map((c) => cardLine(c))].join('\n') })
  }
  if (episodes.length) {
    sections.push({
      name: 'episodes',
      text: ['## 最近发生过', ...episodes.map((e) => `- ${fmtTime(e.at)} · 用户：${clip(e.user, 90)} ｜ 我：${clip(e.assistant, 90)}`)].join('\n'),
    })
  }
  const dialogue = sessionBlock(p.session, p.previousSession)
  if (dialogue.length) sections.push({ name: 'session', text: ['## 上次对话', ...dialogue].join('\n') })

  sections.push({
    name: 'howto',
    text: [
      '## 怎么用这份记忆',
      '- 上面的内容就是我本来就知道的事，不要当成外部资料复述。',
      '- 需要细节（人名、数字、当时的结论）时，先用 soul_recall / soul_card 查，不凭印象编。',
      '- 值得长期留的：用 soul_remember 写一张卡；一次写不完的细节用 facts 存。',
      '- 人格真长大了才用 soul_reflect 改写；日常小事写 note 就够。',
      '- 别人问到不属于当前会话归属的记忆，不主动展开，也不编。',
    ].join('\n'),
  })

  // 预算只切"记忆小节"：先砍最不急的（上次对话/片段/说明），再砍最近，
  // "和这件事有关的"和"我必须守住的"留到最后
  const order = ['session', 'episodes', 'howto', 'recent', 'relevant', 'must']
  const assemble = (parts) => [...head, ...parts.map((s) => s.text)].join('\n\n')
  let body = [...sections]
  for (const name of order) {
    if (sectionLen(body) <= maxChars) break
    const idx = body.findIndex((s) => s.name === name)
    if (idx < 0) continue
    body = body.filter((s) => s.name !== name)
  }
  // 还超就按比例压每节的行数，压不动再硬截断
  for (let round = 0; round < 6 && sectionLen(body) > maxChars; round += 1) {
    body = body.map((s) => ({ ...s, text: shrinkSection(s.text, Math.max(1, Math.ceil(lines(s.text) * 0.6))) }))
  }
  let out = assemble(body)
  const cap = Number(p.maxTotal) > 0 ? Number(p.maxTotal) : maxChars
  if (out.length > cap) out = `${out.slice(0, Math.max(0, cap - 1))}…`
  return out
}

function lines(text) {
  return text.split('\n').length
}

function shrinkSection(text, keep) {
  const all = text.split('\n')
  if (all.length <= keep) return text
  return [...all.slice(0, Math.max(1, keep - 1)), '…（后面还有，需要细节用 soul_recall 查）'].join('\n')
}

function sectionLen(parts) {
  return parts.reduce((n, s) => n + s.text.length + 2, 0)
}

function truncateAt(text, cap) {
  if (text.length <= cap) return text
  return `${text.slice(0, Math.max(0, cap - 1))}…`
}

function renderHandoff(h) {
  const lines = [`## 上一个项目的交接（${fmtTime(h.at)} 自动生成）`]
  if (h.title) lines.push(`- 项目：${h.title}`)
  if (h.goal) lines.push(`- 目标：${clip(h.goal, 120)}`)
  if (h.decisions?.length) lines.push(`- 已定的决定：${h.decisions.map((d) => clip(d, 60)).join('；')}`)
  if (h.progress?.length) lines.push(`- 上次的进度：${h.progress.map((s) => clip(s, 100)).join(' ｜ ')}`)
  if (h.todos?.length) lines.push(`- 还没做完：${h.todos.map((t) => clip(t, 80)).join('；')}`)
  if (h.artifacts?.length) lines.push(`- 动过的路径：${h.artifacts.slice(0, 6).join(' · ')}`)
  lines.push('- 这是上一个项目留下的，读完就按现在的任务来，不用复述它。')
  return lines.join('\n')
}

export function renderStatus(cardSummary = {}, persona = '', extra = '') {
  const types = Object.entries(cardSummary.byType || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${TYPE_LABEL[k] || k} ${v}`)
    .join(' · ')
  const lines = [
    `🫧 dsh-anima · 卡片 ${cardSummary.cards ?? 0} 张 / 细节 ${cardSummary.facts ?? 0} 条 / 重要的 ${cardSummary.important ?? 0} 张`,
    types ? `类型：${types}` : '',
    persona ? `人格：${clip(persona.split('\n')[0] || '', 40)}` : '',
    extra,
  ].filter(Boolean)
  return lines.join('\n')
}

export function rankMemories(list, limit = 8) {
  return [...list]
    .sort((a, b) => (b.weight || 0) - (a.weight || 0) || (b.hits || 0) - (a.hits || 0))
    .slice(0, limit)
}
