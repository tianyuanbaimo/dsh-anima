/**
 * dsh-anima · 项目交接自测（v0.3）
 *
 * 不连宿主，用假 ctx 把「水位 → 警戒 → 收尾 → 交接 → 新项目读一次」整条链路跑一遍。
 * 跑：node scripts/test-handoff.mjs
 */

import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { apply } from '../lib/index.js'

let pass = 0
let fail = 0
const fails = []

function ok(cond, name, extra) {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    fails.push(name)
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function makeCtx({ usedRef, created }) {
  const handlers = new Map()
  const sections = []
  const commands = []
  return {
    sections,
    commands,
    handlers,
    ctx: {
      logger: () => ({ debug() {} }),
      get(name) {
        if (name === 'tokenMeter') return { measure: () => ({ totalTokens: usedRef.used, surfaceTokens: usedRef.used }) }
        if (name === 'sessions') {
          return {
            create(id, opts) {
              created.push({ id, opts })
              return { header: { id } }
            },
            async flush() {},
          }
        }
        return null
      },
      systemPrompt: {
        section(def) {
          sections.push(def)
          return () => {}
        },
      },
      tools: { register() {} },
      commands: {
        register(def) {
          commands.push(def)
        },
      },
      on(event, fn) {
        if (!handlers.has(event)) handlers.set(event, [])
        handlers.get(event).push(fn)
      },
    },
  }
}

async function fire(handlers, session, event) {
  for (const fn of handlers.get('session/event') || []) fn(session, event)
  await sleep(20)
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anima-handoff-'))
const dataDir = path.join(root, 'anima')

const usedRef = { used: 100 }
const created = []
const { ctx, sections, commands, handlers } = makeCtx({ usedRef, created })

const plugin = apply(ctx, { dataDir, handoffAt: 0.9, autoConsolidate: false, captureEpisodes: true })
await plugin.store.ready

const A = { header: { id: 'sess-A', cwd: 'D:\\demo' } }

// ---- 1. 水位没到：不该警戒 ----
target: {
  usedRef.used = 400
  await fire(handlers, A, { type: 'request/context', data: { contextWindow: 1000 } })
  await fire(handlers, A, { type: 'user/message', data: { content: [{ type: 'text', text: '把插件升级到 0.3：加项目交接' }] } })
  await fire(handlers, A, { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '先做交接模块。下一步：写测试。' }] } } })
  await fire(handlers, A, { type: 'tool/call', data: { name: 'bash', arguments: { path: 'D:\\大肥鱼的工作区\\dsh-anima\\lib\\handoff.js' } } })
  await fire(handlers, A, { type: 'tool/result', data: {} })
  await fire(handlers, A, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ok(plugin.store.listHandoffs().length === 0, '水位 40% 时不生成交接')
  ok(plugin.handoff.pressure(A).ratio === 0.4, '水位计算 = used/window', String(plugin.handoff.pressure(A).ratio))
}

// ---- 2. 水位到 95%：警戒但不立即打断 ----
target2: {
  usedRef.used = 950
  await fire(handlers, A, { type: 'user/message', data: { content: [{ type: 'text', text: '现在把交接做完' }] } })
  const nudge = plugin.handoff.nudge(A)
  ok(nudge.includes('上下文水位告警'), '警戒后注入块出现水位告警', nudge.slice(0, 40))
}

// ---- 3. 有挂起的工具调用：等项目完成再交接 ----
target3: {
  usedRef.used = 960
  await fire(handlers, A, { type: 'tool/call', data: { name: 'bash', arguments: { path: 'D:\\大肥鱼的工作区\\dsh-anima\\scripts\\test-handoff.mjs' } } })
  await fire(handlers, A, { type: 'assistant/message', data: { turn: 2, message: { content: [{ type: 'text', text: '测试写完，跑一遍。' }] } } })
  await fire(handlers, A, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  ok(plugin.store.listHandoffs().length === 0, '还有未完成的工具调用时不交接')
}

// ---- 4. 工具返回、项目收尾：自动交接 ----
target4: {
  await fire(handlers, A, { type: 'tool/result', data: {} })
  await fire(handlers, A, { type: 'user/message', data: { content: [{ type: 'text', text: '很好，收尾吧' }] } })
  await fire(handlers, A, { type: 'assistant/message', data: { turn: 3, message: { content: [{ type: 'text', text: '交接完了。待办：把 README 补上 0.3 的说明。' }] } } })
  await fire(handlers, A, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  await sleep(120)
  const list = plugin.store.listHandoffs()
  ok(list.length === 1, '收尾后自动生成 1 份交接', `实际 ${list.length}`)
  const h = list[0]
  ok(Boolean(h && h.id), '交接有 id')
  ok(h && h.todos.length >= 1, '交接里有待办', JSON.stringify(h && h.todos))
  ok(h && h.artifacts.some((a) => a.includes('handoff.js')), '交接里记录了动过的路径', JSON.stringify(h && h.artifacts))
  ok(h && h.goal.includes('升级'), '交接里有目标', h && h.goal)
}

// ---- 5. 落盘：handoffs.jsonl + handoffs/<时间>-<id>.md ----
target5: {
  const jsonl = await fs.readFile(path.join(dataDir, 'handoffs.jsonl'), 'utf8')
  ok(jsonl.trim().split('\n').length === 1, 'handoffs.jsonl 有一行')
  const dir = path.join(dataDir, 'handoffs')
  const files = await fs.readdir(dir)
  ok(files.length === 1 && files[0].endsWith('.md'), 'Markdown 交接文件已写出', files.join(','))
  const md = await fs.readFile(path.join(dir, files[0]), 'utf8')
  ok(md.includes('## 目标') && md.includes('## 待办'), 'Markdown 有目标与待办小节')
}

// ---- 6. 与记忆对齐：决定/待办回灌成长期记忆 ----
target6: {
  const mems = await plugin.store.listMemories()
  ok(mems.some((m) => (m.tags || []).includes('handoff')), '交接内容回灌进长期记忆')
  const s = plugin.store.summary()
  ok(s.handoffs === 1, 'summary 里能看到交接数', String(s.handoffs))
}

// ---- 7. 新项目开头读一次 ----
target7: {
  const B = { header: { id: 'sess-B', cwd: 'D:\\demo' } }
  // 模拟新会话的第一条用户消息（会 touchSession，让 lastSession 变成 B）
  await fire(handlers, B, { type: 'user/message', data: { content: [{ type: 'text', text: '接着上个项目继续' }] } })
  const section = sections[0]
  const text = section.text()
  ok(text.includes('上一个项目的交接'), '新会话注入块里出现交接', text.slice(0, 80))
  ok(text.includes('接着') === false || text.includes('## 我是谁'), '注入块结构完整')
  const h2 = plugin.handoff.forPrompt({ id: 'sess-A' })
  ok(h2 === null, '同一会话里不重复喂自己的交接')
}

// ---- 8. 命令与工具已注册 ----
target8: {
  const names = commands.map((c) => c.name)
  ok(names.includes('soul'), '/soul 命令已注册')
  ok(typeof plugin.handoff.force === 'function', 'force() 可用于手动交接')
  const r = await plugin.handoff.force(A, 'manual', '手动补一份')
  ok(r.ok && plugin.store.listHandoffs().length === 2, '手动交接可执行', String(r.ok))
}

// ---- 9. 关掉自动交接时不主动写 ----
target9: {
  const used2 = { used: 990 }
  const made = []
  const m2 = makeCtx({ usedRef: used2, created: made })
  const dir2 = path.join(root, 'anima2')
  const p2 = apply(m2.ctx, { dataDir: dir2, autoHandoff: false, autoConsolidate: false })
  await p2.store.ready
  const C = { header: { id: 'sess-C' } }
  await fire(m2.handlers, C, { type: 'request/context', data: { contextWindow: 1000 } })
  await fire(m2.handlers, C, { type: 'user/message', data: { content: [{ type: 'text', text: '随便聊聊' }] } })
  await fire(m2.handlers, C, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  ok(p2.store.listHandoffs().length === 0, 'autoHandoff=false 时不会自动交接')
  await p2.flush()
}

await plugin.flush()
await fs.rm(root, { recursive: true, force: true })

console.log('')
if (fail === 0) {
  console.log(`✅ 项目交接自测全部通过（${pass} 项）`)
} else {
  console.log(`❌ ${fail} 项失败（通过 ${pass} 项）：\n  - ${fails.join('\n  - ')}`)
  process.exitCode = 1
}
