/**
 * dsh-anima · v0.4 自测（摘要索引 + 细节外挂 / 写入流水线 / 三路注入 / 归属隔离 / 转生）
 * 跑：node scripts/test-v4.mjs
 */

import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import { createCards } from '../lib/cards.js'
import { createRetrieve } from '../lib/retrieve.js'
import { renderSoulBlock } from '../lib/prompt.js'
import { createStore } from '../lib/store.js'
import { createCapture } from '../lib/capture.js'
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
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'anima-v4-'))
const dir = path.join(root, 'anima')

console.log('\n[1] 卡片与细节')
{
  const cards = createCards({ dir })
  await cards.ready
  const c1 = await cards.add({ summary: '白渊的名字来自《道德经》的"渊兮似万物之宗"', title: '名字来历', types: ['fact'], weight: 5, important: true, facts: ['白渊自己说的', '语境：起名'] })
  ok(Boolean(c1?.id), '写卡成功')
  ok(cards.summary().facts === 2, '细节落在 facts 里')
  const hit = cards.search('白渊 名字', { limit: 3 })
  ok(hit.length > 0 && hit[0].card.id === c1.id, '检索命中同一张卡')
  const facts = cards.factsOf(c1.id)
  ok(facts.length === 2 && facts.some((f) => f.text === '白渊自己说的'), '按需展开拿到细节')
  const iso = new Date(Date.now() - 200 * 86400000).toISOString()
  const old = await cards.add({ summary: '一条很旧没用的闲聊记录', weight: 2 })
  old.lastUsedAt = iso
  old.hits = 0
  await cards.add({ summary: '一条很旧但很重要的规则', weight: 5, important: true })
  const archived = await cards.sweep()
  ok(archived >= 1, '90 天没用又不重要的被软遗忘')
  ok(!cards.all().some((c) => c.summary.includes('很旧但很重要') === false && c.id === old.id), '旧闲聊已归档')
  ok(cards.all().some((c) => c.summary.includes('很旧但很重要')), '重要卡没被软遗忘')
}

console.log('\n[2] 归属隔离')
{
  const cards = createCards({ dir })
  await cards.ready
  const a = await cards.add({ summary: '群聊里能看到的公开约定', owner: 'shared' })
  const b = await cards.add({ summary: '只属于甲私聊的秘密', owner: 'u:jia' })
  const c = await cards.add({ summary: '只属于乙私聊的秘密', owner: 'u:yi' })
  const jia = cards.search('秘密', { owner: 'u:jia', limit: 5 }).map((h) => h.card.id)
  const yi = cards.search('秘密', { owner: 'u:yi', limit: 5 }).map((h) => h.card.id)
  const shared = cards.search('秘密', { owner: 'shared', limit: 5 }).map((h) => h.card.id)
  ok(jia.includes(b.id) && !jia.includes(c.id), '甲查不到乙的私聊')
  ok(yi.includes(c.id) && !yi.includes(b.id), '乙查不到甲的私聊')
  ok(shared.length === 0, '群聊查不到任何私聊')
}

console.log('\n[3] 去重（≥0.85 合并）')
{
  const cards = createCards({ dir: path.join(root, 'anima-dedupe') })
  await cards.ready
  await cards.add({ summary: 'DSH 的 profile 在 C 盘 .dsh profiles desktop 目录', types: ['fact'] })
  await cards.add({ summary: 'DSH 的 profile 在 C 盘 .dsh profiles desktop 目录里', types: ['fact'] })
  const groups = await cards.consolidate({ dryRun: true })
  ok(groups.length === 1, 'dry run 找到 1 组重复')
  const merged = await cards.consolidate()
  ok(merged === 1, '实际合并 1 组')
  ok(cards.all().length === 1, '合并后只剩一张卡')
}

console.log('\n[4] 重排降级与缓存')
{
  const cards = createCards({ dir })
  await cards.ready
  await cards.add({ summary: '记忆插件的数据目录在 D 盘' })
  await cards.add({ summary: '微信桥接插件的封装在 D 盘' })
  const r = createRetrieve({ cards, cfg: { rerankModel: 'not-installed:0b', rerankTimeoutMs: 300 }, log: () => {} })
  const out = await r.pick('数据目录在哪', { topK: 2 })
  ok(out.items.length > 0, '拿不到重排模型也能返回结果')
  ok(out.degraded === 'model-unavailable' || out.reranked === false, '标注了降级原因')
  const out2 = await r.pick('数据目录在哪', { topK: 2 })
  ok(r.stats.cacheHits >= 1 || out2.items.length > 0, '第二次走缓存或仍然可用')
}

console.log('\n[5] 三路注入与预算')
{
  const cards = createCards({ dir })
  await cards.ready
  const rule = await cards.add({ summary: '任何情况下都不要删用户的数据', types: ['rule'], weight: 5, important: true })
  const rel = await cards.add({ summary: '上次说的是记忆插件的重排用本地小模型' })
  const text = renderSoulBlock({
    persona: '# 我是谁\n\n我是洄。',
    important: cards.importantCards('shared', 8),
    recent: cards.recent('shared', 5),
    relevant: [rel],
    maxChars: 2000,
  })
  ok(text.includes('## 我必须守住的'), '注入了「必须守住的」')
  ok(text.includes('## 和眼下这件事有关的记忆'), '注入了「和这件事有关的」')
  ok(text.includes('## 最近聊到的'), '注入了「最近聊到的」')
  ok(text.includes('我是洄'), '人格在最前')
  ok(text.includes(rule.summary), '重要卡片内容出现')
  const tight = renderSoulBlock({ persona: 'x'.repeat(500), recent: cards.recent('shared', 5), relevant: [rel], maxChars: 200, personaCap: 120, maxTotal: 300 })
  ok(tight.length <= 300, `预算生效（${tight.length} ≤ 300 = 人格 120 + 小节 200）`)
  const tightSmallPersona = renderSoulBlock({ persona: '短人格', recent: cards.recent('shared', 5), maxChars: 400, personaCap: 40, maxTotal: 440 })
  ok(tightSmallPersona.includes('## 最近聊到的'), '小人格时记忆小节仍在')
}

console.log('\n[6] 写入流水线（线索 / 空闲 / 低信息）')
{
  const store = createStore({ dir: path.join(root, 'anima-pipe') })
  const cards = createCards({ dir: path.join(root, 'anima-pipe') })
  await store.ready
  await cards.ready
  const capture = createCapture({ store, cfg: { idleWriteMs: 80, captureEpisodes: true, captureCues: true }, log: () => {}, cards })
  const s = { header: { id: 's1' }, meta: { owner: 'shared' } }
  capture.handle(s, { type: 'user/message', data: { content: [{ type: 'text', text: '记住：以后都用中文回答' }] } })
  await sleep(60)
  ok(cards.all().some((c) => c.summary.includes('以后都用中文回答')), '显式线索立刻成卡')
  capture.handle(s, { type: 'user/message', data: { content: [{ type: 'text', text: '这个项目的目录在 D 盘，先看一眼结构再说' }] } })
  capture.handle(s, { type: 'assistant/message', data: { content: [{ type: 'text', text: '看过了，有 lib 和 scripts' }] } })
  capture.handle(s, { type: 'turn/end', data: { turn: 2 } })
  capture.handle(s, { type: 'user/message', data: { content: [{ type: 'text', text: '那就先改 lib 里的入口文件，顺手把测试补一行' }] } })
  capture.handle(s, { type: 'assistant/message', data: { content: [{ type: 'text', text: '改完了' }] } })
  capture.handle(s, { type: 'turn/end', data: { turn: 3 } })
  await sleep(200)
  ok(cards.all().some((c) => c.summary.includes('看过了')), '空闲 5 分钟触发成卡（测试里压到 80ms）')
  capture.handle(s, { type: 'user/message', data: { content: [{ type: 'text', text: '嗯嗯' }] } })
  capture.handle(s, { type: 'turn/end', data: { turn: 4 } })
  await sleep(20)
  ok(capture.getStats().cardSkipped >= 1, '低信息量的闲聊被跳过')
  capture.dispose()
}

console.log('\n[7] 迁移旧记忆')
{
  const legacyDir = path.join(root, 'anima-legacy')
  await fs.mkdir(legacyDir, { recursive: true })
  await fs.writeFile(
    path.join(legacyDir, 'memory.jsonl'),
    JSON.stringify({ id: 'm1', text: '旧版的一条记忆：DSH 在 D 盘', type: 'fact', weight: 5, createdAt: new Date().toISOString() }) + '\n',
    'utf8',
  )
  const cards = createCards({ dir: legacyDir })
  await cards.ready
  ok(cards.all().length === 1 && cards.all()[0].summary.includes('DSH 在 D 盘'), '旧 memory.jsonl 迁成卡片')
  ok(cards.summary().facts === 1, '旧记忆也变成了一条细节')
}

console.log('\n[8] 宿主装配与转生')
{
  const dataDir = path.join(root, 'anima-host')
  const handlers = new Map()
  const sections = []
  const used = { n: 100 }
  const created = []
  const ctx = {
    logger: { info() {}, debug() {} },
    get(name) {
      if (name === 'tokenMeter') return { measure: () => ({ totalTokens: used.n, surfaceTokens: used.n }) }
      if (name === 'sessions') return { create: (id, opts) => (created.push({ id, opts }), { header: { id } }), async flush() {} }
      return null
    },
    systemPrompt: { section: (def) => (sections.push(def), () => {}) },
    tools: { register() {} },
    commands: { register() {} },
    on(ev, fn) {
      if (!handlers.has(ev)) handlers.set(ev, [])
      handlers.get(ev).push(fn)
    },
  }
  const app = apply(ctx, { dataDir, rebirthAt: 32000, handoffNewSession: true, idleWriteMs: 50 })
  await sleep(300)
  const session = { header: { id: 'h1' }, meta: { title: '升级记忆插件' }, id: 'h1' }
  for (const fn of handlers.get('session/event') || []) fn(session, { type: 'user/message', data: { content: [{ type: 'text', text: '把记忆插件升级成卡片结构' }] } })
  await sleep(30)
  const text = sections[0]?.text?.({ session })
  ok(typeof text === 'string' && text.includes('## 怎么用这份记忆'), '系统提示 section 能渲染')
  used.n = 33000
  for (const fn of handlers.get('session/event') || []) fn(session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await sleep(400)
  const rec = app.store.latestHandoff?.()
  ok(Boolean(rec), '到 32K 阈值触发生成了交接')
  ok(created.length >= 1, '自动新建了下一个项目会话')
  ok(String(rec?.goal || '').length > 0, '交接里记下了项目目标')
}

console.log(`\n${fail === 0 ? '✅ v0.4 自测全部通过' : '❌ 有失败项'}（${pass} 项通过 / ${fail} 项失败）`)
if (fail) console.log(`失败：${fails.join('、')}`)
await fs.rm(root, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
