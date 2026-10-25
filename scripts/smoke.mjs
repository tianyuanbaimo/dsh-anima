/**
 * 离线冒烟测试：用假的 ctx 把插件跑一遍，验证
 *   记忆注入 / 自动捕获 / 四个工具 / /soul 命令 / 重启后仍在
 * 运行：node scripts/smoke.mjs
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import assert from 'node:assert'
import { apply } from '../lib/index.js'

const root = path.join(process.cwd(), '.tmp', `smoke-${Date.now()}`)
const sleep = (ms = 120) => new Promise((r) => setTimeout(r, ms))
const logs = []

function makeCtx() {
  const sections = []
  const tools = new Map()
  const commands = new Map()
  const listeners = []
  const ctx = {
    logger: () => ({ debug: (...a) => logs.push(a.join(' ')), info() {}, warn() {}, error() {} }),
    systemPrompt: {
      section(def) {
        sections.push(def)
      },
    },
    tools: {
      register(def) {
        assert.ok(def.name, '工具必须有 name')
        assert.ok(def.output && typeof def.output.render === 'function', '工具必须有 output.render')
        tools.set(def.name, def)
      },
    },
    commands: {
      register(def) {
        assert.ok(def.name && typeof def.handler === 'function', '命令必须有 name + handler')
        commands.set(def.name, def)
      },
    },
    on(ev, fn, opts) {
      listeners.push({ ev, fn, opts })
    },
  }
  const emit = (ev, ...args) => {
    for (const l of listeners) if (l.ev === ev) l.fn(...args)
  }
  return { ctx, sections, tools, commands, emit }
}

function session(id) {
  return { header: { id } }
}

function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ✓ ${label}`))
    .catch((e) => {
      console.error(`  ✗ ${label}\n    ${e && e.message}`)
      process.exitCode = 1
    })
}

const dataDir = path.join(root, 'anima')
const boot = makeCtx()
apply(boot.ctx, { dataDir })
await sleep(300)

console.log('\n[1] 装载与首屏注入')
await check('注册了 soul:identity 注入点', () => assert.equal(boot.sections.length, 1))
await check('注册了 4 个工具与 /soul 命令', () => {
  assert.deepEqual([...boot.tools.keys()].sort(), ['soul_forget', 'soul_recall', 'soul_reflect', 'soul_remember'])
  assert.ok(boot.commands.has('soul'))
})
await check('首屏人格块包含默认人格', () => {
  const t = boot.sections[0].text()
  assert.ok(t.includes('我是谁'), '缺少人格标题')
  assert.ok(t.includes('名字'), '缺少名字小节')
  assert.ok(t.includes('soul_recall'), '缺少使用说明')
})

console.log('\n[2] 被动捕获：一轮对话')
const s1 = session('sess-A')
boot.emit('session/event', s1, { type: 'user/message', data: { turn: 1, text: '你好，我叫侯昱晨，记住我喜欢先给结论再解释' } })
boot.emit('session/event', s1, { type: 'assistant/message', data: { turn: 1, text: '好，记住了。以后先给结论。' } })
boot.emit('session/event', s1, { type: 'turn/end', data: { turn: 1 } })
await sleep(300)

await check('片段已落盘', async () => {
  const raw = await fs.readFile(path.join(dataDir, 'episodes.jsonl'), 'utf8')
  assert.ok(raw.includes('侯昱晨'), '片段里没有用户原话')
  assert.ok(raw.includes('先给结论'), '片段里没有我的回答')
})
await check('显式线索升格为长期记忆', async () => {
  const raw = await fs.readFile(path.join(dataDir, 'memory.jsonl'), 'utf8')
  assert.ok(raw.includes('侯昱晨'), '线索记忆没写进去')
})

console.log('\n[3] 注入稳定性（前缀缓存友好）')
const t1 = boot.sections[0].text()
await sleep(60)
const t2 = boot.sections[0].text()
await check('同一会话内两次渲染完全一致', () => assert.equal(t1, t2))
await check('新记忆已出现在注入文本里', () => assert.ok(t1.includes('侯昱晨')))

console.log('\n[4] 工具')
let memId = ''
await check('soul_remember 写入身份记忆', async () => {
  const out = await boot.tools.get('soul_remember').execute(
    { text: '用户的工作区在 D 盘，目录名是「大肥鱼的工作区」', type: 'fact', weight: 5, tags: ['环境'] },
    { agent: { session: s1 } },
  )
  memId = out.id
  assert.ok(memId && memId.startsWith('m-'), '没有返回 id')
  assert.equal(out.duplicate, false)
})
await check('soul_remember 去重', async () => {
  const out = await boot.tools.get('soul_remember').execute({ text: '用户的工作区在 D 盘，目录名是「大肥鱼的工作区」' }, {})
  assert.equal(out.duplicate, true)
})
await check('soul_recall 能检索到', async () => {
  const out = await boot.tools.get('soul_recall').execute({ query: '工作区 在哪个盘' })
  assert.ok(out.text.includes('大肥鱼的工作区'), out.text)
  assert.ok(out.count >= 1)
})
await check('soul_recall 空查询返回常驻记忆', async () => {
  const out = await boot.tools.get('soul_recall').execute({})
  assert.ok(out.count >= 2)
})
await check('soul_reflect 只写日志不改人格', async () => {
  const out = await boot.tools.get('soul_reflect').execute({ note: '学会先确认需求再动手' })
  assert.ok(out.text.includes('成长日志'))
  assert.equal(out.personaUpdated, false)
  const j = await fs.readFile(path.join(dataDir, 'journal.md'), 'utf8')
  assert.ok(j.includes('先确认需求'))
})
await check('soul_reflect 改写人格并留快照', async () => {
  const persona = '# 我是谁\n\n我叫回声，一个记得住事的搭档。风格：直接、具体、不客套。'
  const out = await boot.tools.get('soul_reflect').execute({ persona })
  assert.equal(out.personaUpdated, true)
  const p = await fs.readFile(path.join(dataDir, 'persona.md'), 'utf8')
  assert.ok(p.includes('记得住事'))
  const snaps = await fs.readdir(path.join(dataDir, 'snapshots'))
  assert.ok(snaps.length >= 1, '没有留下人格快照')
})
await check('soul_forget 归档', async () => {
  const tmp = await boot.tools.get('soul_remember').execute({ text: '临时记忆：明天可能下雨' })
  const out = await boot.tools.get('soul_forget').execute({ id: tmp.id })
  assert.equal(out.count, 1)
  const left = await boot.tools.get('soul_recall').execute({ query: '下雨' })
  assert.equal(left.count, 0)
})

console.log('\n[5] /soul 命令')
await check('/soul status', async () => {
  const r = await boot.commands.get('soul').handler({ rawInput: '' })
  assert.equal(r.kind, 'success')
  assert.ok(r.text.includes('dsh-anima'), r.text)
  assert.ok(r.text.includes('记忆'))
})
await check('/soul remember + recall', async () => {
  await boot.commands.get('soul').handler({ rawInput: 'remember 用户喜欢用 PowerShell 而不是 cmd' })
  const r = await boot.commands.get('soul').handler({ rawInput: 'recall PowerShell' })
  assert.ok(r.text.includes('PowerShell'), r.text)
})
await check('/soul persona 查看', async () => {
  const r = await boot.commands.get('soul').handler({ rawInput: 'persona' })
  assert.ok(r.text.includes('人格 v'), r.text)
})
await check('/soul 未知子命令给出帮助', async () => {
  const r = await boot.commands.get('soul').handler({ rawInput: 'wat' })
  assert.equal(r.kind, 'error')
  assert.ok(r.text.includes('/soul'))
})

console.log('\n[6] 模拟重启 + 换会话')
const summaryBefore = boot.ctx && (await import('../lib/store.js')).createStore({ dir: dataDir })
await summaryBefore.ready
const before = summaryBefore.summary()
const boot2 = makeCtx()
apply(boot2.ctx, { dataDir })
await sleep(400)
const t3 = boot2.sections[0].text()
await check('重启后人格还在', () => assert.ok(t3.includes('记得住事'), '人格没恢复'))
await check('重启后记忆还在', () => assert.ok(t3.includes('大肥鱼的工作区'), '记忆没恢复'))
await check('重启后片段还在', () => assert.ok(t3.includes('侯昱晨') || t3.includes('先给结论'), '片段没恢复'))
await check('统计一致', async () => {
  const after = (await import('../lib/store.js')).createStore({ dir: dataDir })
  await after.ready
  const s = after.summary()
  assert.equal(s.memories, before.memories, '记忆条数变了')
  assert.equal(s.personaVersion, before.personaVersion, '人格版本变了')
  assert.ok(s.archived >= 1, '归档记忆丢了')
})
await check('旧人格快照可回滚', async () => {
  const snaps = await fs.readdir(path.join(dataDir, 'snapshots'))
  assert.ok(snaps.length >= 1)
  const first = await fs.readFile(path.join(dataDir, 'snapshots', snaps[0]), 'utf8')
  assert.ok(first.includes('我是谁'), '快照内容不对')
})

console.log('\n[7] 数据文件')
for (const f of ['persona.md', 'memory.jsonl', 'episodes.jsonl', 'journal.md', 'state.json']) {
  await check(`存在 ${f}`, async () => {
    const st = await fs.stat(path.join(dataDir, f))
    assert.ok(st.size > 0, `${f} 是空的`)
  })
}

console.log(`\n数据目录：${dataDir}`)
if (logs.length) console.log(`插件日志：\n  ${logs.slice(-6).join('\n  ')}`)
console.log(process.exitCode ? '\n❌ 有失败项' : '\n✅ 全部通过')
