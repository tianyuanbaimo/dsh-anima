/**
 * dsh-anima · 工具与命令
 *
 * 只用裸 JSON Schema 定义 + output.render，不 import @deepseek-ai/dsh-tools，
 * 这样在宿主包解析不到时插件仍然能装、能跑。
 */

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

export function registerTools(ctx, store, cfg, log, fail = () => {}) {
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
        '在你的长期记忆里检索。用户提到过去的事、需要具体细节（名字/数字/当时的结论），或你想确认某个偏好时，先检索再说，不要凭印象编。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '检索词，中英文均可；留空则返回最常驻的记忆' },
          type: { type: 'string', enum: MEMORY_TYPES, description: '可选：只看某一类' },
          limit: { type: 'integer', description: '最多返回几条，默认 8' },
        },
        required: [],
        additionalProperties: true,
      },
      output: { schema: outputSchema, render: renderText },
      async execute(args) {
        const query = String(args.query || '').trim()
        const limit = Math.min(30, Math.max(1, Number(args.limit) || 8))
        const items = query ? await store.search(query, { type: args.type, limit }) : (await store.topMemories(limit))
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
  '  /soul remember <文本>  记一条（权重 4）',
  '  /soul recall <关键词>  检索记忆',
  '  /soul forget <id|文本> 忘掉一条',
  '  /soul persona          看人格全文',
  '  /soul persona <文本>   改写人格（会留快照）',
  '  /soul journal         看最近的成长日志',
  '  /soul export          数据目录与备份提示',
].join('\n')

function parseSub(rawInput) {
  const raw = String(rawInput || '').trim()
  if (!raw) return ['status', '']
  const idx = raw.search(/\s/)
  if (idx < 0) return [raw.toLowerCase(), '']
  return [raw.slice(0, idx).toLowerCase(), raw.slice(idx + 1).trim()]
}

export function registerCommand(ctx, store, cfg, log, fail = () => {}) {
  const handler = async ({ rawInput }) => {
    try {
      const [sub, rest] = parseSub(rawInput)
      const summary = store.summary()
      const persona = await store.readPersona()

      switch (sub) {
        case 'status':
        case '':
          return { kind: 'success', text: renderStatus(summary, persona) }

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

        case 'journal': {
          try {
            const fs = await import('node:fs/promises')
            const raw = await fs.readFile(store.files.journal, 'utf8')
            const lines = raw.trim().split('\n')
            return { kind: 'success', text: lines.slice(-60).join('\n') || '（成长日志还是空的）' }
          } catch {
            return { kind: 'success', text: '（成长日志还是空的）' }
          }
        }

        case 'export': {
          return {
            kind: 'success',
            text: [
              `数据目录：${summary.dir}`,
              `  人格文件 persona.md · 记忆 memory.jsonl · 片段 episodes.jsonl · 日志 journal.md · 快照 snapshots/`,
              `备份：整个目录复制走即可；恢复：放回原处，重启 DSH。`,
            ].join('\n'),
          }
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
      description: '我的记忆与人格：状态 / 记住 / 检索 / 忘掉 / 改写人格',
      input: { hint: 'status | remember <文本> | recall <关键词> | persona [新全文]' },
      handler,
    })
  } catch (e) {
    fail('命令 /soul 注册', e)
  }
}
