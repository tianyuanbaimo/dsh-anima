/**
 * dsh-anima · 工具与命令
 *
 * 只用裸 JSON Schema 定义 + output.render，不 import @deepseek-ai/dsh-tools，
 * 这样在宿主包解析不到时插件仍然能装、能跑。
 */

import { promises as fs } from 'node:fs'
import { MEMORY_TYPES, fmtTime } from './store.js'
import { renderStatus } from './prompt.js'

const TYPE_LABEL = {
  fact: '事实',
  preference: '偏好',
  relationship: '关系',
  decision: '决定',
  insight: '领悟',
  episode: '片段',
}

// 注意：宿主调用签名是 render(args, value) —— 第一个参数是工具入参，第二个才是 execute 的返回值。
// 早期写成 (value) 导致 recall/reflect 取到的是入参，输出空串（remember 恰好也有 text 字段才侥幸正常）。
const renderText = (_args, value) => [{ type: 'text', text: String((value && value.text) || '') }]

const outputSchema = { type: 'object', additionalProperties: true }

function sessionIdOf(exec) {
  try {
    return exec?.agent?.session?.header?.id || ''
  } catch {
    return ''
  }
}

function memoryLine(m) {
  return `- [${m.id}] (${TYPE_LABEL[m.type] || m.type}/权重${m.weight}) ${m.text}`
}

export function registerTools(ctx, store, cfg, log, fail = () => {}, handoff = null) {
  const tools = [
    {
      name: 'soul_remember',
      description:
        '把值得长期记住的东西写进你的跨会话记忆：用户的事实、偏好、约定、重要决定、你自己的领悟。换会话、重启电脑后这些都还在。宁精不滥——一句话一条，写清"是什么"而不是"聊过什么"。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的内容，一句话，第三人称陈述句（例：用户的名字是侯昱晨，习惯被称为"大肥鱼"）' },
          type: {
            type: 'string',
            enum: MEMORY_TYPES.filter((t) => t !== 'episode'),
            description: 'fact=客观事实, preference=偏好习惯, relationship=与你/他人的关系, decision=做出的决定, insight=你自己的领悟或成长',
          },
          weight: { type: 'integer', description: '重要度 1-5，默认 3；身份、长期偏好、硬约束给 4-5' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选标签，便于以后检索' },
        },
        required: ['text'],
        additionalProperties: true,
      },
      output: { schema: outputSchema, render: renderText },
      async execute(args, exec) {
        const rec = await store.addMemory({
          text: args.text,
          type: args.type,
          weight: args.weight,
          tags: args.tags,
          sessionId: sessionIdOf(exec),
          source: 'model',
        })
        const text = rec.duplicate
          ? `这条已经记过了，我把它又确认了一次（命中 ${rec.hits} 次）：${rec.text}`
          : `记住了 [${rec.id}]：${rec.text}`
        return { text, id: rec.id, duplicate: Boolean(rec.duplicate) }
      },
    },
    {
      name: 'soul_recall',
      description:
        '在你的长期记忆里检索。用户提到过去的事、需要具体细节（名字/数字/当时的结论），或你想确认某个偏好时，先检索再说，不要凭印象编。休眠的记忆也能被检索到。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词，中英文均可；留空则返回最常驻的记忆' },
          type: { type: 'string', enum: MEMORY_TYPES, description: '可选：只看某一类' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选：只返回带这些标签的记忆' },
          limit: { type: 'integer', description: '最多返回几条，默认 8' },
        },
        required: [],
        additionalProperties: true,
      },
      output: { schema: outputSchema, render: renderText },
      async execute(args) {
        const query = String(args.query || '').trim()
        const limit = Math.min(30, Math.max(1, Number(args.limit) || 8))
        const tags = Array.isArray(args.tags) ? args.tags : undefined
        const items = query ? await store.search(query, { type: args.type, tags, limit }) : await store.topMemories(limit)
        if (items.length === 0) {
          return { text: query ? `没有检索到和「${query}」相关的记忆。如果需要，可以直接问用户，或用 soul_remember 记下这次得到的信息。` : '还没有存下任何记忆。', count: 0 }
        }
        const head = query ? `检索「${query}」命中 ${items.length} 条：` : `常驻记忆前 ${items.length} 条：`
        return { text: [head, ...items.map(memoryLine)].join('\n'), count: items.length, ids: items.map((m) => m.id) }
      },
    },
    {
      name: 'soul_forget',
      description: '忘掉一条记忆（归档，不是物理删除）。用户要求"忘掉这个"，或发现记住的是错的、过时的，用它。需要先 soul_recall 拿到 id。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '记忆 id（形如 m-xxxx-xxxxx），也可以给一段能唯一匹配的原文' },
        },
        required: ['id'],
        additionalProperties: true,
      },
      output: { schema: outputSchema, render: renderText },
      async execute(args) {
        const hits = await store.forgetMemory(args.id)
        if (hits.length === 0) return { text: `没有找到匹配「${args.id}」的记忆，先用 soul_recall 确认 id。`, count: 0 }
        return { text: `已归档 ${hits.length} 条：\n${hits.map(memoryLine).join('\n')}`, count: hits.length }
      },
    },
    {
      name: 'soul_reflect',
      description:
        '改写你的人格（自我叙事），或给成长日志写一笔。只在该真正长大时改人格——语气、价值观、自我认知发生了持久变化；日常小事用 note 记日志即可。人格改动会留快照，可回退。',
      parameters: {
        type: 'object',
        properties: {
          persona: { type: 'string', description: '新的人格全文（Markdown，第一人称）。给了就整体替换旧人格。' },
          note: { type: 'string', description: '不替换人格，只往成长日志里追加一条记录（例：今天学会先确认需求再动手）' },
        },
        required: [],
        additionalProperties: true,
      },
      output: { schema: outputSchema, render: renderText },
      async execute(args) {
        const persona = typeof args.persona === 'string' ? args.persona.trim() : ''
        const note = typeof args.note === 'string' ? args.note.trim() : ''
        if (!persona && !note) throw new Error('需要 persona（新人格全文）或 note（成长日志）其中之一')
        if (persona && persona.length < 20) throw new Error('人格太短了，至少写 20 个字')
        const done = []
        if (persona) {
          const v = await store.writePersona(persona, note || 'model 主动改写人格')
          done.push(`人格已更新到 v${v}（旧版已快照到 ${store.files.snapshots}）`)
        }
        if (note) {
          await store.appendJournal(`## ${fmtTime()} · 成长\n${note}\n`)
          done.push('成长日志已追加一笔')
        }
        return { text: done.join('\n'), personaUpdated: Boolean(persona) }
      },
    },
    {
      name: 'soul_handoff',
      description:
        '生成本项目的交接：把「目标 / 已定的决定 / 最近进度 / 动过的路径 / 没做完的事」整理成一份结构化记录，写到数据目录并把决定回灌进长期记忆，供下一个项目开头读一次。上下文快满、一个项目要收尾时用；也可以随时手动留档。',
      parameters: {
        type: 'object',
        properties: {
          note: { type: 'string', description: '可选：补充说明（这个项目接下来往哪走、有什么坑）' },
        },
        required: [],
        additionalProperties: true,
      },
      output: { schema: outputSchema, render: renderText },
      async execute(args, exec) {
        if (!handoff) return { text: '交接模块未启用（配置 autoHandoff=false 且未加载），先检查插件状态。' }
        const session = (() => {
          try {
            return exec?.agent?.session || null
          } catch {
            return null
          }
        })()
        const r = await handoff.force(session, 'manual', String(args.note || ''))
        if (!r.ok) return { text: `交接没写成：${r.reason}` }
        const spawnLine = r.spawn?.ok
          ? `已尝试新建项目会话：${r.spawn.sessionId}`
          : `新项目由你下次开会话时自动接上（自动新建不可用：${r.spawn?.reason || 'unknown'}）`
        return {
          text: [
            `已生成项目交接 [${r.handoff.id}]「${r.handoff.title}」`,
            `决定 ${r.handoff.decisions.length} 条 · 进度 ${r.handoff.progress.length} 条 · 待办 ${r.handoff.todos.length} 条 · 路径 ${r.handoff.artifacts.length} 个`,
            spawnLine,
            '',
            r.markdown,
          ].join('\n'),
          id: r.handoff.id,
          spawned: Boolean(r.spawn?.ok),
        }
      },
    },
  ]

  let registered = 0
  for (const def of tools) {
    try {
      ctx.tools.register(def)
      registered += 1
    } catch (e) {
      fail(`工具 ${def.name}`, e)
    }
  }
  return { registered, total: tools.length }
}

const HELP = [
  '🫧 /soul —— 我的记忆与人格',
  '',
  '  /soul                 看状态',
  '  /soul stats           记忆统计（类型分布 / 休眠 / 命中）',
  '  /soul remember <文本>  记一条（权重 4）',
  '  /soul recall <关键词>  检索记忆',
  '  /soul forget <id|文本> 忘掉一条',
  '  /soul merge           把重复记忆合并（先 dry 看报告：/soul merge dry）',
  '  /soul handoff [now]   生成当前项目的交接（接着 /soul handoff status）',
  '  /soul dormant         看休眠中的记忆',
  '  /soul wake <id>       唤醒一条休眠记忆',
  '  /soul persona          看人格全文',
  '  /soul persona <文本>   改写人格（会留快照）',
  '  /soul snapshots       看人格快照',
  '  /soul rollback [n|名]  回滚人格到某个快照',
  '  /soul journal         看最近的成长日志',
  '  /soul export          导出 Markdown 备份（写到数据目录）',
  '  /soul import <路径>    从 JSONL/JSON 导入记忆',
].join('\n')

function parseSub(rawInput) {
  const raw = String(rawInput || '').trim()
  if (!raw) return ['status', '']
  const idx = raw.search(/\s/)
  if (idx < 0) return [raw.toLowerCase(), '']
  return [raw.slice(0, idx).toLowerCase(), raw.slice(idx + 1).trim()]
}

function statsText(s) {
  const types = Object.entries(s.byType)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${TYPE_LABEL[k] || k} ${v}`)
    .join(' · ')
  const weights = Object.entries(s.byWeight)
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([k, v]) => `${k}★ ${v}`)
    .join(' · ')
  return [
    `🫧 记忆统计`,
    `存活 ${s.live} 条 · 休眠 ${s.dormant} 条 · 归档 ${s.archived} 条`,
    `类型　${types || '（空）'}`,
    `权重　${weights || '（空）'}`,
    `命中　平均 ${s.avgHits} 次 · 从未被检索 ${s.neverHit} 条 · 平均权重 ${s.avgWeight}`,
    `休眠阈值 ${s.decayDays} 天（低权重且久未命中才休眠，不删除）`,
    s.lastConsolidateAt ? `上次整理 ${fmtTime(s.lastConsolidateAt)}` : '上次整理：还没整理过',
  ].join('\n')
}

export function registerCommand(ctx, store, cfg, log, fail = () => {}, capture, handoff = null) {
  const handler = async ({ rawInput, agent }) => {
    try {
      const [sub, rest] = parseSub(rawInput)
      const summary = store.summary()
      const persona = await store.readPersona()

      switch (sub) {
        case 'status':
        case '': {
          const st = capture && typeof capture.getStats === 'function' ? capture.getStats() : null
          const captureLine = st
            ? `\n捕获（本次进程）：用户 ${st.user} · 回答 ${st.assistant} · 轮次 ${st.turnEnd} · 片段 ${st.episodes} · 跳过 ${st.skipped} · 待配 ${st.pending}`
            : ''
          return { kind: 'success', text: renderStatus(summary, persona) + captureLine }
        }

        case 'stats': {
          const s = await store.stats()
          return { kind: 'success', text: statsText(s) }
        }

        case 'remember': {
          if (!rest) return { kind: 'error', text: '用法：/soul remember <要记住的内容>' }
          const rec = await store.addMemory({ text: rest, weight: 4, source: 'user-command' })
          return {
            kind: 'success',
            text: rec.duplicate ? `这条已经记过了：${rec.text}` : `记住了 [${rec.id}]：${rec.text}`,
          }
        }

        case 'recall':
        case 'search': {
          const items = rest ? await store.search(rest, { limit: 10 }) : await store.topMemories(10)
          const head = rest ? `检索「${rest}」命中 ${items.length} 条：` : `常驻记忆 ${items.length} 条：`
          return { kind: 'success', text: items.length ? [head, ...items.map(memoryLine)].join('\n') : `${head}（空）` }
        }

        case 'forget': {
          if (!rest) return { kind: 'error', text: '用法：/soul forget <id 或原文>' }
          const hits = await store.forgetMemory(rest)
          return {
            kind: hits.length ? 'success' : 'error',
            text: hits.length ? `已归档 ${hits.length} 条：\n${hits.map(memoryLine).join('\n')}` : `没找到匹配「${rest}」的记忆`,
          }
        }

        case 'merge':
        case 'consolidate': {
          const dry = /^dry$/i.test(rest) || /dry/i.test(rest)
          const r = await store.consolidate({ dryRun: dry })
          if (dry) {
            if (!r.groups.length) return { kind: 'success', text: '没有发现足够相似的重复记忆（阈值 0.75）。' }
            const lines = [`预演：${r.groups.length} 组可合并（未写入）：`]
            for (const g of r.groups) {
              lines.push(`\n保留：${g.keep}`)
              for (const d of g.drop) lines.push(`  合并：${d}`)
            }
            lines.push('\n确认执行：/soul merge')
            return { kind: 'success', text: lines.join('\n') }
          }
          if (!r.merged) return { kind: 'success', text: '没有需要合并的重复记忆。' }
          return { kind: 'success', text: `已合并 ${r.groups.length} 组，归档 ${r.merged} 条重复记忆（可 /soul recall 确认）。` }
        }

        case 'handoff': {
          if (!handoff) return { kind: 'error', text: '交接模块未启用（检查 autoHandoff 配置）。' }
          if (/^(status|list)$/i.test(rest)) {
            const list = store.listHandoffs(5)
            if (!list.length) return { kind: 'success', text: '还没有任何项目交接（/soul handoff 可手动生成一份）。' }
            const lines = [`最近 ${list.length} 份项目交接：`]
            for (const h of list) {
              const pct = h.ratio > 0 ? ` · ${(h.ratio * 100).toFixed(0)}%` : ''
              lines.push(`  · ${fmtTime(h.at)}「${h.title}」决定 ${h.decisions.length} · 进度 ${h.progress.length} · 待办 ${h.todos.length}${pct}${h.nextSessionId ? ` → ${h.nextSessionId}` : ''}`)
            }
            lines.push('', '生成新的：/soul handoff now ｜ 看文件：' + store.files.handoffDir)
            return { kind: 'success', text: lines.join('\n') }
          }
          const note = rest && !/^now$/i.test(rest) ? rest : ''
          let session = null
          try {
            session = (agent && agent.session) || null
          } catch {
            session = null
          }
          const r = await handoff.force(session, 'manual', note)
          if (!r.ok) return { kind: 'error', text: `交接没写成：${r.reason}` }
          return {
            kind: 'success',
            text: [
              `已生成项目交接 [${r.handoff.id}]「${r.handoff.title}」`,
              `决定 ${r.handoff.decisions.length} · 进度 ${r.handoff.progress.length} · 待办 ${r.handoff.todos.length}`,
              `文件：${store.files.handoffDir}`,
              r.spawn?.ok ? `已尝试新建项目会话：${r.spawn.sessionId}` : `下次开新会话时会自动读一次（自动新建：${r.spawn?.reason || 'skipped'}）`,
              '',
              r.markdown,
            ].join('\n'),
          }
        }

        case 'dormant': {
          const items = await store.dormantMemories(20)
          if (!items.length) return { kind: 'success', text: `没有休眠中的记忆（阈值 ${summary.decayDays} 天）。` }
          return {
            kind: 'success',
            text: [`休眠中 ${items.length} 条（仍可被 soul_recall 检索到）：`, ...items.map(memoryLine), '', '唤醒：/soul wake <id>'].join('\n'),
          }
        }

        case 'wake': {
          if (!rest) return { kind: 'error', text: '用法：/soul wake <id>' }
          const rec = await store.wakeMemory(rest)
          return rec
            ? { kind: 'success', text: `已唤醒 [${rec.id}]：${rec.text}` }
            : { kind: 'error', text: `找不到 id「${rest}」，先用 /soul dormant 看列表。` }
        }

        case 'persona': {
          if (!rest) {
            return {
              kind: 'success',
              text: `人格 v${summary.personaVersion}（${fmtTime(summary.personaUpdatedAt)} 更新）\n\n${persona.trim()}\n\n—— 改写：/soul persona <新全文>`,
            }
          }
          if (rest.length < 20) return { kind: 'error', text: '人格至少 20 个字；只是记一笔用 /soul remember。' }
          const v = await store.writePersona(rest, '用户命令改写')
          return { kind: 'success', text: `人格已更新到 v${v}，旧版快照：${store.files.snapshots}` }
        }

        case 'snapshots': {
          const list = await store.listSnapshots()
          if (!list.length) return { kind: 'success', text: '还没有人格快照（改写人格时会自动留）。' }
          const lines = [`人格快照 ${list.length} 个（旧→新，最多保留 40 个）：`]
          list.forEach((s, i) => lines.push(`  ${i + 1}. ${s.name} · ${Math.round(s.size / 102.4) / 10} KB · ${fmtTime(s.mtime)}`))
          lines.push('', '回滚：/soul rollback <序号|名字>')
          return { kind: 'success', text: lines.join('\n') }
        }

        case 'rollback': {
          const r = await store.rollback(rest)
          return { kind: 'success', text: `人格已回滚到 ${r.name}（${fmtTime(r.at)}），当前版本 v${r.version}。回滚前那版也留了快照。` }
        }

        case 'journal': {
          try {
            const raw = await fs.readFile(store.files.journal, 'utf8')
            const lines = raw.trim().split('\n')
            return { kind: 'success', text: lines.slice(-60).join('\n') || '（成长日志还是空的）' }
          } catch {
            return { kind: 'success', text: '（成长日志还是空的）' }
          }
        }

        case 'export': {
          const r = await store.exportMarkdown()
          return {
            kind: 'success',
            text: [
              `已导出 Markdown 备份：${r.file}`,
              `含 ${r.memories} 条记忆、${r.episodes} 条片段、当前人格全文。`,
              `数据目录：${summary.dir}`,
              `整目录复制走也是完整备份；恢复：放回原处重启 DSH。`,
            ].join('\n'),
          }
        }

        case 'import': {
          if (!rest) return { kind: 'error', text: '用法：/soul import <jsonl 或 json 文件路径>' }
          const raw = await fs.readFile(rest, 'utf8')
          const r = await store.importMemories(raw)
          return { kind: 'success', text: `导入完成：新增 ${r.added} 条，已存在（加深确认）${r.duplicates} 条，共读入 ${r.total} 行。` }
        }

        case 'help':
          return { kind: 'success', text: HELP }

        default:
          return { kind: 'error', text: `不认识的子命令「${sub}」\n\n${HELP}` }
      }
    } catch (e) {
      log('/soul 执行失败', e && e.message)
      return { kind: 'error', text: `出错了：${(e && e.message) || e}` }
    }
  }

  try {
    ctx.commands.register({
      name: 'soul',
      description: '我的记忆与人格：状态 / 记忆 / 整理 / 人格快照',
      input: { hint: 'status | stats | remember <文本> | recall <关键词> | handoff [now|status] | merge | dormant | persona [新全文] | snapshots | rollback [n]' },
      handler,
    })
  } catch (e) {
    fail('命令 /soul 注册', e)
  }
}
