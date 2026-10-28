/**
 * 用真实会话日志回放，验证捕获链路（不需要重启 DSH）。
 *
 * 用法：
 *   node scripts/replay.mjs <解压后的 session.txt> [--limit N]
 *
 * session.txt 是 sessions/<dir>/session.v4.jsonl.zstd 解压出来的 jsonl；
 * 仓库里不带解码器，因为 zstd 帧格式随宿主版本变动，宁可手工解。
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const file = process.argv[2]
if (!file) {
  console.error('用法：node scripts/replay.mjs <session.txt> [--limit N]')
  process.exit(2)
}
const limitArg = process.argv.indexOf('--limit')
const limit = limitArg > 0 ? Number(process.argv[limitArg + 1]) || 0 : 0

const lines = (await fs.readFile(file, 'utf8')).split('\n').filter((l) => l.trim())
const events = []
for (const line of lines) {
  try {
    const ev = JSON.parse(line)
    if (!ev.type) continue
    if (!['user/message', 'assistant/message', 'turn/end'].includes(ev.type)) continue
    events.push(ev)
  } catch {
    /* 跳过坏行 */
  }
}
const total = events.length
const picked = limit > 0 ? events.slice(-limit) : events

const dataDir = path.join(os.tmpdir(), `anima-replay-${Date.now()}`)
const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const sections = []
const tools = new Map()
const commands = new Map()
const handlers = new Map()

const ctx = {
  logger: () => logger,
  systemPrompt: { section: (def) => sections.push(def) },
  tools: { register: (def) => tools.set(def.name, def), restrict() {}, get: (n) => tools.get(n) },
  commands: { register: (def) => commands.set(def.name, def) },
  on: (event, handler) => handlers.set(event, handler),
  effect: () => {},
}

apply(ctx, { dataDir, promptMaxChars: 1500, injectMemories: 8, injectEpisodes: 4 })
const handle = handlers.get('session/event')
if (!handle) {
  console.error('没有挂上 session/event')
  process.exit(1)
}

const session = { header: { id: 'replay-session' } }
for (const ev of picked) {
  handle(session, ev)
  await new Promise((r) => setTimeout(r, 0))
}
await new Promise((r) => setTimeout(r, 400))

const read = async (f) => {
  try {
    return (await fs.readFile(path.join(dataDir, f), 'utf8')).split('\n').filter((l) => l.trim())
  } catch {
    return []
  }
}
const episodes = await read('episodes.jsonl')
const memories = await read('memory.jsonl')
const state = JSON.parse(await fs.readFile(path.join(dataDir, 'state.json'), 'utf8'))

const parsed = episodes.map((l) => JSON.parse(l))
const withAnswer = parsed.filter((e) => e.text.includes('我：')).length
const leaked = parsed.filter((e) => /内心|reasoning/i.test(e.text)).length

console.log(`回放事件：${picked.length}/${total}（user ${picked.filter((e) => e.type === 'user/message').length} / assistant ${picked.filter((e) => e.type === 'assistant/message').length} / turn-end ${picked.filter((e) => e.type === 'turn/end').length}）`)
console.log(`片段：${episodes.length} 条（含我的回答 ${withAnswer} 条 · 疑似 reasoning 泄漏 ${leaked} 条）`)
console.log(`记忆：${memories.length} 条 · state.turns=${state.turns} episodes=${state.episodes}`)
for (const e of parsed.slice(0, 2)) console.log(`  样例｜${e.text.slice(0, 140)}`)
for (const e of parsed.slice(-2)) console.log(`  末尾｜${e.text.slice(0, 140)}`)
console.log(`数据目录：${dataDir}`)
