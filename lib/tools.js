/**
 * dsh-anima · 工具与命令（v0.4）
 *
 * 工具面向"卡 + 细节"两层：
 *   soul_remember  写一张卡（可带 facts 细节）
 *   soul_recall    检索卡片（摘要层），返回时附"细节 N 条"
 *   soul_card      按 id 展开一张卡的细节（按需展开，省 token 的那一半）
 *   soul_forget    归档一张卡
 *   soul_reflect   改写人格（这一轮真长大了才用）
 *   soul_handoff   手动交接当前项目
 *
 * 注意：宿主调用渲染函数是 output.render(args, value)，第一个参数是**入参**，
 * 这里一律写成 (_args, value)，别只取第一个参数（2026-10-25 踩过）。
 */

import { promises as fs } from 'node:fs'

const renderText = (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }]

const OUT = {
  schema: { type: 'object', additionalProperties: true },
  render: renderText,
}

const HELP = [
  '/soul status —— 现状（卡片数、细节数、人格版本、目录）',
  '/soul cards [N] —— 列出最近 N 张卡（默认 10）',
  '/soul card <id> —— 展开一张卡的细节',
  '/soul search <关键词> —— 检索卡片',
  '/soul remember <内容> —— 记一张卡',
  '/soul forget <id|关键词> —— 归档一张卡',
  '/soul persona —— 看当前人格第一行',
  '/soul journal [N] —— 看成长日志',
  '/soul export —— 导出全部记忆为 Markdown 文件',
  '/soul import <路径> —— 从 JSON/JSONL 导入卡片',
  '/soul merge [dry] —— 合并重复卡片',
  '/soul sweep —— 软遗忘（90 天没用又不重要的归档）',
  '/soul handoff [now|status] —— 交接项目 / 看最近交接',
  '/soul stats —— 取用统计（重排成功/降级/缓存命中）',
]

function cardLine(c) {
  const mark = c.important ? '★' : ''
  return `- ${mark}\`${c.id}\` [${(c.types || []).join('/')}] ${c.title}${c.factsCount ? `（细节 ${c.factsCount}）` : ''}`
}

export function registerTools(ctx, store, cfg, log, fail, handoff = null, cards = null) {
  let registered = 0

  const defs = [
    {
      name: 'soul_remember',
      description:
        '把值得长期留着的事记成一张记忆卡（一句话摘要）。同一件事的细节可以放进 facts 数组，平时不注入、需要时用 soul_card 展开。',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '摘要，一句话，写清楚"是什么"' },
          title: { type: 'string', description: '可选，卡片标题（默认截取摘要前 28 字）' },
          type: {
            type: 'string',
            enum: ['fact', 'preference', 'relationship', 'decision', 'insight', 'rule', 'emotion'],
            description: '卡片类型，默认 fact；必须遵守的规则用 rule',
          },
          weight: { type: 'number', description: '权重 1-5，默认 3；核心事实给 5' },
          important: { type: 'boolean', description: '重要卡片永不软遗忘，且每轮都注入' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
          facts: { type: 'array', items: { type: 'string' }, description: '可选细节（原话、数字、路径等）' },
        },
        required: ['summary'],
      },
      output: OUT,
      async execute(args, exec) {
        const owner = String(exec?.agent?.session?.meta?.owner || 'shared')
        const card = await cards.add({
          owner,
          summary: String(args.summary || ''),
          title: args.title,
          types: args.type ? [String(args.type)] : undefined,
          weight: args.weight,
          important: args.important,
          keywords: args.tags,
          facts: (args.facts || []).map((t) => ({ text: String(t) })),
          source: 'manual',
        })
        if (!card) return { ok: false, text: '没写成：摘要为空。' }
        return { ok: true, id: card.id, text: `已记成卡片 \`${card.id}\`：${card.title}` }
      },
    },
    {
      name: 'soul_recall',
      description: '在自己的记忆卡片里检索（只返回摘要层，需要细节再用 soul_card <id> 展开）。回答"上次说过…"之前先用它查。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词或问题' },
          limit: { type: 'number', description: '返回条数，默认 5' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选，限定关键词' },
        },
        required: ['query'],
      },
      output: OUT,
      async execute(args, exec) {
        const owner = String(exec?.agent?.session?.meta?.owner || 'shared')
        const limit = Math.min(20, Math.max(1, Number(args.limit) || 5))
        const hits = cards.search(String(args.query || ''), { owner, limit })
        const filtered = args.tags?.length
          ? hits.filter((h) => h.card.keywords.some((k) => args.tags.includes(k)) || h.card.types.some((t) => args.tags.includes(t)))
          : hits
        if (!filtered.length) return { ok: true, count: 0, text: `没找到和「${args.query}」有关的记忆。` }
        await cards.touch(filtered.map((h) => h.card.id))
        const lines = [`和「${args.query}」有关的记忆（${filtered.length} 条）：`]
        for (const h of filtered) {
          lines.push(`${cardLine(h.card)}`)
          lines.push(`  ${h.card.summary}（相关度 ${h.score.toFixed(2)}）`)
        }
        return { ok: true, count: filtered.length, ids: filtered.map((h) => h.card.id), text: lines.join('\n') }
      },
    },
    {
      name: 'soul_card',
      description: '按 id（或标题片段）展开一张记忆卡的细节。检索先返回摘要，确认需要细节时再用它。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '卡片 id 或标题里的片段' } },
        required: ['id'],
      },
      output: OUT,
      async execute(args) {
        const key = String(args.id || '').trim()
        const card = cards.get(key) || cards.all().find((c) => c.title.includes(key) || c.summary.includes(key))
        if (!card) return { ok: false, text: `没找到卡片「${key}」。` }
        await cards.touch([card.id])
        const facts = cards.factsOf(card.id)
        const lines = [
          `# ${card.title}${card.important ? ' ★' : ''}`,
          `- id：\`${card.id}\` · 类型 ${card.types.join('/')} · 权重 ${card.weight} · 归属 ${card.owner}`,
          '',
          card.summary,
        ]
        if (facts.length) {
          lines.push('', `细节（${facts.length} 条）：`)
          for (const f of facts.slice(0, 20)) lines.push(`- ${f.text}`)
        }
        return { ok: true, id: card.id, facts: facts.length, text: lines.join('\n') }
      },
    },
    {
      name: 'soul_forget',
      description: '归档一张记忆卡（不物理删除，只是不再注入；需要时可找回）。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: '卡片 id 或标题片段' } },
        required: ['id'],
      },
      output: OUT,
      async execute(args) {
        const card = await cards.forget(String(args.id || ''))
        if (!card) return { ok: false, text: `没找到「${args.id}」。` }
        return { ok: true, id: card.id, text: `已归档 \`${card.id}\`：${card.title}` }
      },
    },
    {
      name: 'soul_reflect',
      description: '整体改写人格文件（这是我自己的叙事，只在该真正长大时改）。不替换人格时用 note 只追加一条成长日志。',
      parameters: {
        type: 'object',
        properties: {
          persona: { type: 'string', description: '新的人格全文（Markdown，第一人称）；给了就整体替换' },
          note: { type: 'string', description: '只追加一条成长日志，不替换人格' },
        },
      },
      output: OUT,
      async execute(args) {
        if (args.persona && String(args.persona).trim().length > 40) {
          const v = await store.writePersona(String(args.persona), args.note)
          return { ok: true, personaVersion: v, text: `人格已更新到 v${v}（旧版留了快照）。` }
        }
        const note = String(args.note || '').trim()
        if (!note) return { ok: false, text: '既没给 persona 也没给 note。' }
        await store.appendJournal(`## ${new Date().toISOString().slice(0, 10)} · 成长\n${note}`)
        return { ok: true, text: '成长日志已记。' }
      },
    },
  ]

  if (cards) {
    defs.push({
      name: 'soul_handoff',
      description: '把当前项目的进度、决定、待办整理成一份交接（供下一个项目开头读一次）。正常说一句"交接"就行，不必手动调用。',
      parameters: {
        type: 'object',
        properties: { note: { type: 'string', description: '可选，补一句这次交接的重点' } },
      },
      output: OUT,
      async execute(args, exec) {
        if (!handoff) return { ok: false, text: '交接模块未装配。' }
        const session = exec?.agent?.session
        const rec = await handoff.force(session, 'manual', args.note)
        if (!rec) return { ok: false, text: '交接生成失败。' }
        return { ok: true, id: rec.id, text: rec.markdown || `已生成交接 ${rec.id}` }
      },
    })
  }

  for (const def of defs) {
    try {
      ctx.tools.register(def)
      registered += 1
    } catch (err) {
      fail(`tool ${def.name}`, err)
    }
  }
  return { registered, total: defs.length }
}

export function registerCommand(ctx, store, cfg, log, fail, capture, handoff, cards, retrieve) {
  try {
    ctx.commands.register({
      name: 'soul',
      description: 'dsh-anima：看记忆、记卡片、交接项目',
      input: { hint: 'status | cards | card <id> | search <词> | remember <内容> | handoff | stats | export' },
      handler: async ({ rawInput, agent }) => {
        const raw = String(rawInput || '').trim()
        const [cmd = 'status', ...rest] = raw.split(/\s+/)
        const arg = rest.join(' ')
        const session = agent?.session
        const owner = String(session?.meta?.owner || 'shared')
        const st = cards ? cards.stats() : {}
        const sum = store.summary()

        switch (cmd.toLowerCase()) {
          case 'cards': {
            const n = Math.min(50, Math.max(1, Number(arg) || 10))
            const list = cards.all().sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, n)
            if (!list.length) return { kind: 'success', text: '还没有卡片。' }
            return { kind: 'success', text: ['最近的卡片：', ...list.map(cardLine)].join('\n') }
          }
          case 'card': {
            if (!arg) return { kind: 'error', text: '用法：/soul card <id>' }
            const card = cards.get(arg) || cards.all().find((c) => c.title.includes(arg))
            if (!card) return { kind: 'error', text: `没找到「${arg}」。` }
            const facts = cards.factsOf(card.id)
            return {
              kind: 'success',
              text: [`# ${card.title}`, card.summary, '', ...facts.map((f) => `- ${f.text}`)].join('\n'),
            }
          }
          case 'search': {
            if (!arg) return { kind: 'error', text: '用法：/soul search <关键词>' }
            const hits = cards.search(arg, { owner, limit: 8 })
            if (!hits.length) return { kind: 'success', text: `没找到「${arg}」。` }
            return {
              kind: 'success',
              text: [`和「${arg}」有关：`, ...hits.map((h) => `${cardLine(h.card)}\n  ${h.card.summary}`)].join('\n'),
            }
          }
          case 'remember': {
            if (!arg) return { kind: 'error', text: '用法：/soul remember <内容>' }
            const card = await cards.add({ owner, summary: arg, source: 'command' })
            return { kind: 'success', text: card ? `已记成 \`${card.id}\`：${card.title}` : '没写成（内容为空）。' }
          }
          case 'forget': {
            if (!arg) return { kind: 'error', text: '用法：/soul forget <id|关键词>' }
            const card = await cards.forget(arg)
            return { kind: card ? 'success' : 'error', text: card ? `已归档 \`${card.id}\`。` : `没找到「${arg}」。` }
          }
          case 'merge': {
            const dry = rest.includes('dry')
            const n = await cards.consolidate({ dryRun: dry })
            const count = Array.isArray(n) ? n.length : n
            return { kind: 'success', text: dry ? `可以合并 ${count} 组（还没动）。` : `已合并 ${count} 组。` }
          }
          case 'sweep': {
            const n = await cards.sweep()
            return { kind: 'success', text: `软遗忘归档了 ${n} 张卡。` }
          }
          case 'import': {
            if (!arg) return { kind: 'error', text: '用法：/soul import <文件路径>' }
            const raw2 = await fs.readFile(arg, 'utf8')
            const n = await cards.importCards(raw2)
            return { kind: 'success', text: `导入了 ${n} 张卡片。` }
          }
          case 'persona': {
            const persona = await store.readPersona()
            return { kind: 'success', text: `人格 v${sum.personaVersion}（${String(sum.personaUpdatedAt || '').slice(0, 19)}）\n\n${persona.slice(0, 600)}` }
          }
          case 'journal': {
            const n = Math.min(50, Math.max(1, Number(arg) || 10))
            const raw2 = await fs.readFile(store.files.journal, 'utf8').catch(() => '')
            const blocks = raw2.split(/\n## /).filter(Boolean).slice(-n)
            return { kind: 'success', text: blocks.length ? blocks.map((b) => `## ${b}`).join('\n') : '还没有成长日志。' }
          }
          case 'export': {
            const md = await cards.exportMarkdown()
            const out = `${store.dir}\\export-${Date.now()}.md`
            await fs.writeFile(out, md, 'utf8')
            return { kind: 'success', text: `已导出到 ${out}（${md.length} 字）` }
          }
          case 'handoff': {
            const sub = rest[0] || 'now'
            if (sub === 'status') {
              const rec = store.latestHandoff?.()
              return { kind: 'success', text: rec ? `最近交接：${rec.title}（${rec.at}）` : '还没有交接。' }
            }
            const rec = await handoff?.force(session, 'manual', rest.slice(1).join(' ') || undefined)
            return { kind: rec ? 'success' : 'error', text: rec?.markdown || '交接失败（没有内容可交接）。' }
          }
          case 'stats': {
            const rs = retrieve?.stats || {}
            const cs = capture?.getStats?.() || {}
            return {
              kind: 'success',
              text: [
                `卡片 ${st.cards} · 细节 ${st.facts} · 重要 ${st.important} · 归档 ${st.archived}`,
                `类型：${Object.entries(st.byType || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`,
                `归属：${Object.entries(st.byOwner || {}).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`,
                `取用：重排 ${rs.rerankCalls || 0} 次（成功 ${rs.rerankHits || 0} / 降级 ${rs.rerankFails || 0}）· 缓存命中 ${rs.cacheHits || 0}`,
                `捕获：用户 ${cs.user || 0} · 回答 ${cs.assistant || 0} · 卡片 ${cs.cards || 0} · 跳过 ${cs.cardSkipped || 0}`,
              ].join('\n'),
            }
          }
          case 'help': {
            return { kind: 'success', text: HELP.join('\n') }
          }
          default: {
            const lines = [
              `🫧 dsh-anima v${cfg.__version || '?'} · 人格 v${sum.personaVersion}`,
              `卡片 ${st.cards} 张 / 细节 ${st.facts} 条 / 重要 ${st.important} 张`,
              `数据：${store.dir}`,
              `最近的：${cards.all().slice(0, 3).map((c) => c.title).join('；') || '—'}`,
              '用 /soul help 看全部子命令',
            ]
            return { kind: 'success', text: lines.join('\n') }
          }
        }
      },
    })
    return true
  } catch (err) {
    fail('command /soul', err)
    return false
  }
}
