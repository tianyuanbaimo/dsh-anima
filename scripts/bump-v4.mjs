// 一次性更新 v0.4 的版本号与文档（可重复执行，幂等）
import { promises as fs } from 'node:fs'

const root = 'D:/大肥鱼的工作区/dsh-anima'
const read = (p) => fs.readFile(`${root}/${p}`, 'utf8')
const write = (p, t) => fs.writeFile(`${root}/${p}`, t, 'utf8')

// 1) package.json → 0.4.0
const pkg = JSON.parse(await read('package.json'))
pkg.version = '0.4.0'
pkg.description = 'AGENT 之外的那一半：摘要索引 + 细节外挂的长期记忆，带归属隔离、软遗忘与上下文转生'
pkg.exports['./lib/cards.js'] = './lib/cards.js'
pkg.exports['./lib/retrieve.js'] = './lib/retrieve.js'
await write('package.json', JSON.stringify(pkg, null, 2) + '\n')

// 2) cordis.patch.yml
const patch = [
  '# dsh-anima 的 bundle 补丁层：把插件作为一行插进 profile。',
  '# name 必须是【裸包名】dsh-anima；dataDir 留空时用 $DSH_HOME/anima（一般是 ~/.dsh/anima）。',
  '- insert:',
  '    - id: soul',
  '      name: dsh-anima',
  '      config:',
  '        dataDir: ""',
  '        inject: true',
  '        promptMaxChars: 4000',
  '        # 记忆注入的硬预算（字）：超了就按 相关 → 最近 → 重要 的顺序砍',
  '        memBudget: 2000',
  '        injectRelevant: 3',
  '        recentCards: 5',
  '        importantCards: 8',
  '        injectEpisodes: 6',
  '        captureEpisodes: true',
  '        captureCues: true',
  '        # 5 分钟没消息就把当前话题压成一张卡',
  '        idleWriteMs: 300000',
  '        autoConsolidate: true',
  '        consolidateAt: 300',
  '        decayDays: 120',
  '        # 上下文水位到 95% 时，等这一轮收尾后生成项目交接',
  '        handoffAt: 0.95',
  '        autoHandoff: true',
  '        handoffNewSession: true',
  '        # 32K tokens 触发转生：交接 + 新会话，新会话开头读一次交接',
  '        rebirthAt: 32000',
  '        # 可选重排后端（本地 Ollama）；留空 = 只用三因子打分',
  '        rerankModel: ""',
  '        rerankBase: "http://127.0.0.1:11434"',
  '        rerankTimeoutMs: 2000',
  '        sectionOrder: 10050',
  '',
].join('\n')
await write('cordis.patch.yml', patch)

// 3) CHANGELOG
const CL = [
  '## 0.4.0',
  '',
  '摘要索引 + 细节外挂：',
  '',
  '- 数据模型：cards.jsonl 存卡片（标题/摘要/实体/关键词/类型/归属/权重），facts.jsonl 存挂在卡下的细节；不存聊天原文切片，细节按需用 soul_card 展开；旧 memory.jsonl 首次启动自动迁移。',
  '- 写入流水线：显式"记住…"立刻落卡；话题终结（相邻两轮词重叠 < 0.12）与 5 分钟空闲（idleWriteMs）把话题压成一张卡；低信息量闲聊不占卡；关键词兜底判类型；≥0.85 相似度合并去重。',
  '- 读取三路：人格 + 最近 5 张卡 + 相关 Top-3（检索 Top-10 → 可选本地小模型重排 → 取 3），2000 字硬预算；重排带 10 分钟缓存、2 秒超时降级、启动预热。',
  '- 归属隔离：每张卡带 owner，私聊卡在群里查不到。',
  '- 软遗忘：三因子（0.7 语义 / 0.2 新鲜 / 0.1 频率）；90 天没用、命中 <2、权重 ≤3、非重要的卡自动归档；rule 与 important 永不软遗忘。',
  '- 转生：上下文到 rebirthAt（默认 32000 tokens）时，本轮收尾后生成项目交接并新建下一个项目会话；新会话开头读一次交接。',
  '- 新工具 soul_card；新命令 /soul cards|card|stats|sweep；/soul status 改为卡片口径。',
  '- 自测 108 项全绿：smoke 24 / test-v4 31 / test-upgrade 32 / test-handoff 21。',
  '',
  '',
].join('\n')

let log = await read('CHANGELOG.md')
if (!log.includes('## 0.4.0')) {
  const idx = log.indexOf('\n\n')
  log = log.slice(0, idx + 2) + CL + log.slice(idx + 2)
  await write('CHANGELOG.md', log)
}

// 4) README.zh.md
const zhBlock = [
  '## 记忆的形态（v0.4）',
  '',
  '记忆分两层，**摘要进上下文，细节等要用再取**：',
  '',
  '| 层 | 文件 | 进上下文吗 | 干什么 |',
  '| --- | --- | --- | --- |',
  '| 卡片 | `cards.jsonl` | 只进摘要 | 标题 + 一句话摘要 + 实体 + 类型 + 归属 + 权重 |',
  '| 细节 | `facts.jsonl` | 不进 | 挂在卡下的原话、数字、路径、结论；`soul_card <id>` 才展开 |',
  '',
  '**写入怎么触发**：说"记住…"立刻落卡；相邻两轮词重叠很低（换话题）或 5 分钟没消息，就把刚才那几轮压成一张卡；"嗯""好""哈哈"不占卡。类型靠关键词兜底判：必须遵守的 → `rule`，偏好 → `preference`，情绪 → `emotion`，拍板 → `decision`。写入前按 ≥0.85 相似度合并。',
  '',
  '**读取怎么节流**：每次装配最多 3 路 —— 人格（永远在）、最近 5 张卡、和眼下这件事相关的 Top-3（先检索 Top-10，再用本地小模型重排，2 秒超时或失败退回原排序）。总预算 `memBudget`（默认 2000 字），超了先砍"相关"、再砍"最近"，人格最后才动。',
  '',
  '**归属与遗忘**：每张卡有 `owner`（默认 `shared`，由会话 `meta.owner` 决定），私聊的卡在群里检索不到。90 天没用、没被引用、权重又低的卡软归档；`important` 和 `rule` 永不归档。',
  '',
  '**转生**：上下文到 `rebirthAt`（默认 32000 tokens）时，本轮收尾 → 写项目交接 → 新建下一个项目会话；新项目开头读一次交接（目标 / 决定 / 进度 / 待办 / 动过的路径），读完不再重复注入。',
  '',
  '新增工具 `soul_card`；新增命令 `/soul cards`、`/soul card <id>`、`/soul stats`、`/soul sweep`；新增配置 `memBudget`、`recentCards`、`importantCards`、`idleWriteMs`、`rebirthAt`、`rerankModel`、`rerankBase`、`rerankTimeoutMs`。',
  '',
  '',
].join('\n')

let zh = await read('README.zh.md')
if (!zh.includes('## 记忆的形态（v0.4）')) {
  zh = zh.replace('## 记忆整理与休眠（v0.2）', `${zhBlock}## 记忆整理与休眠（v0.2）`)
  await write('README.zh.md', zh)
}

// 5) README.md（英文）
const enBlock = [
  '## Memory model (v0.4)',
  '',
  'Two layers, so the context carries compact summaries only:',
  '',
  '| layer | file | injected | purpose |',
  '| --- | --- | --- | --- |',
  '| card | `cards.jsonl` | summary only | title, one-line summary, entities, tags, type, owner, weight |',
  '| detail | `facts.jsonl` | no | quotes, numbers, paths, conclusions; expanded by `soul_card <id>` |',
  '',
  'Writes: an explicit "remember ..." becomes a card at once; a topic switch (low overlap between two turns) or five idle minutes (`idleWriteMs`) folds recent turns into one card; greetings are skipped; types are guessed from keywords (rule / preference / emotion / decision / relationship / fact); cards similar at >=0.85 are merged.',
  '',
  'Reads: persona + 5 recent cards + top 3 related cards (retrieve top 10, optional local rerank, keep 3) under a hard `memBudget` (2000 chars). Rerank has a 10-minute cache, a 2-second timeout, a startup warm-up, and falls back to plain scoring.',
  '',
  'Ownership: cards carry an `owner` (default `shared`, from session `meta.owner`); private cards are invisible to other owners. Soft forget archives cards unused for 90 days with low hits/weight; `important` and `rule` cards are never archived.',
  '',
  'Rebirth: at `rebirthAt` tokens (32000 default), after the current turn ends, the plugin writes a project handoff and starts the next project session, which reads the handoff once.',
  '',
  'New: `soul_card` tool; `/soul cards|card|stats|sweep`; `memBudget`, `recentCards`, `importantCards`, `idleWriteMs`, `rebirthAt`, `rerankModel`, `rerankBase`, `rerankTimeoutMs`.',
  '',
  '',
].join('\n')

let en = await read('README.md')
if (!en.includes('## Memory model (v0.4)')) {
  en = en.replace('## Memory upkeep (v0.2)', `${enBlock}## Memory upkeep (v0.2)`)
  await write('README.md', en)
}

console.log('docs updated to v0.4.0')
