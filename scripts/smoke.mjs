/**
 * dsh-anima · 冒烟测试（v0.4：卡片模型）
 *
 * 用假 ctx 把插件跑起来，验证：注册、写卡、检索、展开细节、改人格、归档、
 * 重启后还在（落盘）、/soul 命令、归属隔离。不连宿主、不联网。
 *
 * 跑：node scripts/smoke.mjs
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

function fakeCtx() {
  const tools = []
  const sections = []
  const commands = []
  const handlers = new Map()
  const ctx = {
    _tools: tools,
    _sections: sections,
    _commands: commands,
    _handlers: handlers,
    logger: { info() {}, debug() {}, warn() {} },
    get() {
      return null
    },
    systemPrompt: {
      section(def) {
        sections.push(def)
        return () => {}
      },
    },
    tools: {
      register(def) {
        tools.push(def)
      },
    },
    commands: {
      register(def) {
        commands.push(def)
      },
    },
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, [])
      handlers.get(ev).push(fn)
    },
  }
  return ctx
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anima-smoke-'))
const dataDir = path.join(root, 'anima')
const session = { id: 'smoke-1', meta: { title: '冒烟测试会话' } }
const mkdContext = () => ({ session })

console.log('\n[1] 装配')
const ctx = fakeCtx()
const plugin = apply(ctx, { dataDir, promptMaxChars: 3000 })
await plugin.store.ready
await sleep(400)
ok(ctx._sections.length === 1, '注册了 systemPrompt section')
ok(ctx._tools.length === 6, `注册了 6 个工具与 /soul 命令（实际 ${ctx._tools.length}）`)
ok(ctx._tools.map((t) => t.name).sort().join(',') === 'soul_card,soul_forget,soul_handoff,soul_recall,soul_reflect,soul_remember', '工具名齐全')
ok(ctx._commands.length === 1 && ctx._commands[0].name === 'soul', '注册了 /soul 命令')
ok(ctx._handlers.get('session/event')?.length >= 1, '挂上了 session/event 监听')

console.log('\n[2] 写卡与检索')
const remember = ctx._tools.find((t) => t.name === 'soul_remember')
const recall = ctx._tools.find((t) => t.name === 'soul_recall')
const cardTool = ctx._tools.find((t) => t.name === 'soul_card')
const forget = ctx._tools.find((t) => t.name === 'soul_forget')
const reflect = ctx._tools.find((t) => t.name === 'soul_reflect')

const exec = { agent: { session: { meta: { owner: 'shared' } } } }
const w1 = await remember.execute({ summary: '白渊的名字叫白渊，写作时不要叫爸', type: 'relationship', weight: 5, important: true }, exec)
ok(w1.ok && w1.id, 'soul_remember 写卡成功')
await remember.execute({ summary: '记忆插件的数据目录在 D:\\洄\\memory', type: 'fact', weight: 4, facts: ['D:\\洄\\memory\\cards.jsonl', 'D:\\洄\\memory\\facts.jsonl'] }, exec)
const r1 = await recall.execute({ query: '数据目录在哪', limit: 5 }, exec)
ok(r1.ok && r1.count >= 1, 'soul_recall 能检索到')
const c1 = await cardTool.execute({ id: w1.id }, exec)
ok(c1.ok && c1.text.includes('白渊'), 'soul_card 能展开卡片')
const c2 = await cardTool.execute({ id: '数据目录' }, exec)
ok(c2.ok && c2.text.includes('facts.jsonl'), 'soul_card 能展开细节')

console.log('\n[3] 人格与归档')
const before = plugin.store.summary().personaVersion
const r2 = await reflect.execute({ persona: '# 我是谁\n\n我是洄，一个带记忆的搭子。\n\n## 名字\n\n洄。\n\n## 气质\n\n直接、不装。' }, exec)
ok(r2.ok && plugin.store.summary().personaVersion === before + 1, 'soul_reflect 改写人格并升版本')
const f1 = await forget.execute({ id: w1.id }, exec)
ok(f1.ok, 'soul_forget 归档成功')
ok(!plugin.cards.all().some((c) => c.id === w1.id), '归档后不再出现在卡片列表')

console.log('\n[4] 注入')
const text = ctx._sections[0].text(mkdContext())
ok(text.includes('我是洄'), '注入里有人格')
ok(text.includes('## 怎么用这份记忆'), '注入里有使用说明')
ok(text.includes('数据目录'), '注入里带上了记忆卡片')

console.log('\n[5] 重启后还在')
const ctx2 = fakeCtx()
const plugin2 = apply(ctx2, { dataDir })
await plugin2.store.ready
await sleep(400)
const sum = plugin2.cards.summary()
ok(sum.cards >= 1, `重启后卡片还在（${sum.cards} 张）`)
ok(plugin2.store.summary().personaVersion === before + 1, '重启后人格版本还在')
const listed = await fs.readdir(dataDir)
ok(listed.includes('cards.jsonl'), '存在 cards.jsonl')
ok(listed.includes('facts.jsonl'), '存在 facts.jsonl')

console.log('\n[6] 命令')
const cmd = ctx._commands[0]
const s1 = await cmd.handler({ rawInput: 'status', agent: { session: session } })
ok(s1.kind === 'success' && s1.text.includes('卡片'), '/soul status 正常')
const s2 = await cmd.handler({ rawInput: 'help', agent: { session } })
ok(s2.kind === 'success' && s2.text.includes('/soul card'), '/soul help 正常')
const s3 = await cmd.handler({ rawInput: 'search 数据目录', agent: { session } })
ok(s3.kind === 'success', '/soul search 正常')
const s4 = await cmd.handler({ rawInput: '不存在的命令', agent: { session } })
ok(s4.kind === 'success' && s4.text.includes('dsh-anima'), '/soul 未知子命令给出状态')

console.log('\n[7] 归属隔离')
await plugin.cards.add({ summary: '甲私聊里的秘密约定', owner: 'u:jia' })
const sharedHit = plugin.cards.search('秘密约定', { owner: 'shared', limit: 5 })
const jiaHit = plugin.cards.search('秘密约定', { owner: 'u:jia', limit: 5 })
ok(sharedHit.length === 0 && jiaHit.length === 1, '私聊记忆不跨归属可见', `shared=${sharedHit.length} jia=${jiaHit.length}`)

console.log(`\n${fail === 0 ? '✅ 全部通过' : '❌ 有失败项'}（${pass} 项通过 / ${fail} 项失败）`)
if (fail) console.log(`失败：${fails.join('、')}`)
await fs.rm(root, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
