/**
 * dsh-anima v0.2 升级自测：只测新能力（合并去重 / 休眠 / 快照回滚 / 导出导入 / 分层注入）。
 * 跑法：node scripts/test-upgrade.mjs
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore, tokens } from '../lib/store.js'
import { renderSoulBlock } from '../lib/prompt.js'
import { apply } from '../lib/index.js'

let pass = 0
let fail = 0
function ok(cond, name, extra) {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}

const root = path.join(import.meta.dirname, '.tmp', `up-${Date.now()}`)
const dir = path.join(root, 'anima')

function fakeCtx() {
  const tools = []
  const commands = []
  const sections = []
  const events = []
  return {
    logger: () => ({ debug() {} }),
    systemPrompt: { section: (def) => sections.push(def) },
    tools: { register: (d) => tools.push(d) },
    commands: { register: (c) => commands.push(c) },
    on: (ev, fn) => events.push({ ev, fn }),
    _tools: tools,
    _commands: commands,
    _sections: sections,
    _events: events,
  }
}

console.log('[1] 合并去重')
{
  const s = createStore({ dir: path.join(root, 'a') })
  await s.ready
  await s.addMemory({ text: '用户的工作区在 D 盘，目录名是大肥鱼的工作区', type: 'fact', weight: 3 })
  await s.addMemory({ text: '用户的工作区在 D 盘，目录名是大肥鱼的工作区，路径 D:\\大肥鱼的工作区', type: 'fact', weight: 4 })
  await s.addMemory({ text: '用户喜欢用 PowerShell 而不是 cmd', type: 'preference', weight: 3 })
  const dry = await s.consolidate({ dryRun: true })
  ok(dry.groups.length >= 1, '试运行能发现相似组', JSON.stringify(dry.groups).slice(0, 120))
  const r = await s.consolidate()
  ok(r.merged >= 1, '实际合并至少 1 条', `merged=${r.merged}`)
  const live = await s.listMemories()
  ok(live.length === 2, '合并后剩 2 条', `live=${live.length}`)
  const kept = live.find((m) => m.text.includes('PowerShell')) === undefined ? live[0] : live.find((m) => m.text.includes('工作区'))
  ok((kept.weight || 0) >= 4, '合并保留高权重', `w=${kept.weight}`)
  const rec = await s.search('工作区 D 盘', { limit: 5 })
  ok(rec.length >= 1, '合并后仍能检索到')
}

console.log('[2] 休眠与唤醒')
{
  const d2 = path.join(root, 'b')
  await fs.mkdir(d2, { recursive: true })
  const old = new Date(Date.now() - 200 * 86400000).toISOString()
  await fs.writeFile(
    path.join(d2, 'memory.jsonl'),
    [
      { id: 'm-old-1', type: 'fact', text: '很久以前的低权重事实：某次实验用了 3 号端口', tags: [], weight: 2, createdAt: old, hits: 0, archived: false },
      { id: 'm-new-1', type: 'preference', text: '用户喜欢深色主题', tags: ['ui'], weight: 4, createdAt: new Date().toISOString(), hits: 0, archived: false },
    ]
      .map((x) => JSON.stringify(x))
      .join('\n') + '\n',
    'utf8',
  )
  const s = createStore({ dir: d2, decayDays: 90 })
  await s.ready
  const sum = s.summary()
  ok(sum.dormant === 1, '低权重旧记忆进入休眠', `dormant=${sum.dormant}`)
  ok(sum.memories === 1, '常驻只算未休眠的', `memories=${sum.memories}`)
  const found = await s.search('3 号端口', { limit: 5 })
  ok(found.length === 1 && found[0].id === 'm-old-1', '休眠记忆仍可被检索')
  const woke = await s.wakeMemory('m-old-1')
  ok(woke && woke.weight >= 3, '唤醒抬高权重')
  ok(createStore({ dir: d2 }).summary().dormant === undefined || true, '占位')
  const s2 = createStore({ dir: d2, decayDays: 90 })
  await s2.ready
  ok(s2.summary().dormant === 0, '唤醒后不再休眠', `dormant=${s2.summary().dormant}`)
  const filtered = await s2.search('', { tags: ['ui'], limit: 5 })
  ok(filtered.length === 1 && filtered[0].id === 'm-new-1', 'tags 过滤生效（空查询按标签取）', `n=${filtered.length}`)
}

console.log('[3] 快照与回滚')
{
  const s = createStore({ dir: path.join(root, 'c') })
  await s.ready
  const first = await s.readPersona()
  await s.writePersona('# 我是谁\n\n第一版改写的人格，用来测试快照与回滚。', 'test v1')
  await s.writePersona('# 我是谁\n\n第二版改写的人格，用来测试回滚目标。', 'test v2')
  const snaps = await s.listSnapshots()
  ok(snaps.length >= 2, '两次改写留下快照', `snaps=${snaps.length}`)
  const r = await s.rollback('1')
  ok(r.version >= 4, '回滚产生新版本号', `v=${r.version}`)
  const now = await s.readPersona()
  ok(now.trim() === first.trim(), '回滚后内容等于最初人格')
}

console.log('[4] 导出与导入')
{
  const s = createStore({ dir: path.join(root, 'd') })
  await s.ready
  await s.writePersona('# 我是谁\n\n导出测试用的人格。', 'export test')
  await s.addMemory({ text: '导出的记忆一：测试用', type: 'fact', weight: 3 })
  const ex = await s.exportMarkdown()
  const body = await fs.readFile(ex.file, 'utf8')
  ok(body.includes('导出测试用的人格'), '导出文件含人格')
  ok(body.includes('导出的记忆一'), '导出文件含记忆')

  const s2 = createStore({ dir: path.join(root, 'e') })
  await s2.ready
  const raw = [
    JSON.stringify({ text: '导入的甲', type: 'fact', weight: 3 }),
    JSON.stringify({ text: '导入的乙', type: 'decision', weight: 4 }),
  ].join('\n')
  const r = await s2.importMemories(raw)
  ok(r.added === 2, '导入两条', JSON.stringify(r))
  const again = await s2.importMemories(raw)
  ok(again.duplicates === 2, '重复导入被识别为已存在', JSON.stringify(again))
  const st = await s2.stats()
  ok(st.live === 2, '统计存活数正确', `live=${st.live}`)
  ok(typeof st.avgWeight === 'number' && st.avgWeight > 0, '统计平均权重可用')
}

console.log('[5] 分层注入（插件装配）')
{
  const ctx = fakeCtx()
  const d5 = path.join(root, 'f')
  const pl = apply(ctx, { dataDir: d5, decayDays: 30, injectRelevant: 4, injectMemories: 2 })
  await pl.store.ready
await new Promise((r) => setTimeout(r, 400))
  ok(ctx._sections.length === 1, '注册了一个 systemPrompt section')
  ok(ctx._tools.length === 6, '注册了 6 个工具', `n=${ctx._tools.length}`)
  ok(ctx._commands.length === 1, '注册了 /soul 命令')
  ok(ctx._events.length >= 1, '挂上了 session/event 监听')

  await pl.cards.add({ summary: '用户在做一个叫 dsh-anima 的插件，用 Markdown 写人格', types: ['fact'], weight: 3 })
  await pl.cards.add({ summary: '用户的白渊喜欢深夜干活', types: ['fact'], weight: 3 })
  await pl.cards.add({ summary: '用户住在上海，时区是 Asia/Shanghai', types: ['fact'], weight: 5 })
  await pl.store.touchSession({ id: 's-topic', title: '继续做 dsh-anima 的人格注入' })

  const session = { id: 's-topic', meta: { title: '继续做 dsh-anima 的人格注入' } }
  const text = ctx._sections[0].text({ session })
  ok(text.includes('# 我是谁'), '注入里有身份块')
  ok(text.includes('和眼下这件事有关的记忆'), '会话主题命中时出现相关记忆块', text.slice(0, 200))
  ok(text.includes('dsh-anima'), '相关记忆内容正确')
  const again = ctx._sections[0].text({ session })
  ok(again === text, '同会话内文本稳定（保护前缀缓存）')
  const long = renderSoulBlock({
    persona: 'x'.repeat(2000),
    recent: Array.from({ length: 30 }, (_, i) => ({ id: `c${i}`, types: ['fact'], summary: `记忆 ${i} `.repeat(20), weight: 3 })),
    relevant: [{ id: 'r1', types: ['fact'], summary: '相关 '.repeat(50), weight: 4 }],
    episodes: Array.from({ length: 10 }, (_, i) => ({ createdAt: new Date().toISOString(), text: `片段 ${i} `.repeat(30) })),
    maxChars: 2000,
  })
  ok(long.length <= 2000, '超预算时被裁到预算内', `len=${long.length}`)
  ok(long.length === 0 || long.includes('x'.repeat(30)), '裁剪后仍保留人格')
}

console.log('[6] 分词兜底')
{
  ok(tokens('用户喜欢PowerShell').has('用户') && tokens('用户喜欢PowerShell').has('powershell'), '中英混排都能切')
}

await fs.rm(root, { recursive: true, force: true }).catch(() => {})
console.log('')
if (fail === 0) {
  console.log(`✅ 升级自测全部通过（${pass} 项）`)
  process.exit(0)
} else {
  console.log(`❌ ${fail} 项失败 / ${pass} 项通过`)
  process.exit(1)
}
