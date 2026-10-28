# dsh-anima · 让 DSH 拥有不会随关机消失的记忆与人格

[English](README.md) | 中文

给 DeepSeek Harness 装一个「灵魂」：关掉电脑、隔天开机、换一个新会话、上下文被压缩掉——**它还是它**。记得自己是谁，也记得和你发生过什么。

人格与记忆都不在会话里，而在磁盘上的一堆纯文本文件里：可读、可改、可备份、可回退。

---

## 它解决什么

DSH 原生的一切状态都属于「会话」：换会话、重启、上下文压缩之后，人格和记忆就归零，每次都要重新自我介绍、重新交代偏好。

| 原本会丢的 | 装上 dsh-anima 之后 |
| --- | --- |
| 对话结束后的上下文 | 自动压成「片段」落盘，下次开会话开头就能接上 |
| 说过的重要偏好 / 事实 | 显式线索自动升格为长期记忆；模型也能主动写 |
| 人格是否稳定 | 人格存在 `persona.md`，有版本、有快照、可回滚 |
| 换会话 = 失忆 | 记忆全局共享：任何会话、任何重启后都在 |
| 上下文写满 = 项目断掉 | 水位到 95% 时自动整理「项目交接」，新项目开头读一次（v0.3） |

---

## 安装

### 从插件市场

1. 打开 **插件 → 发现 → 索引源（Index sources）**
2. 添加：
   ```
   https://raw.githubusercontent.com/tianyuanbaimo/dsh-anima/main/market/index.json
   ```
3. 在「发现」里找到 **dsh-anima**，点安装。

`raw.githubusercontent.com` 每次都取最新内容；想要可复现的固定版本，把 URL 换成 jsDelivr 的 commit 固定形式：

```
https://cdn.jsdelivr.net/gh/tianyuanbaimo/dsh-anima@<commit>/market/index.json
```

> 注意：索引里用的是 **git 源**，安装时 pnpm 需要调用 `git`。没装 git 的机器请先装 Git for Windows（或把便携版 MinGit 的 `cmd` 目录加进 PATH）。

### 从命令行

```sh
# git 源（无需 npm 发布）
dsh plugin --profile desktop add "git+https://github.com/tianyuanbaimo/dsh-anima.git#<commit>"

# npm 发布之后
dsh plugin --profile desktop add dsh-anima
```

### 从源码（本地开发）

```sh
dsh plugin --profile desktop add "link:/path/to/dsh-anima"
```

`link:` 会建一个目录联接，改完源码重启 DSH 即生效。

装完重启一次 DSH。启动日志里会出现一行：

```
[dsh-anima] ready · persona v1 · 0 memories / 0 episodes · tools 4/4 · ~/.dsh/anima
```

工具数不是 `4/4` 说明注册失败（日志里会有 `[dsh-anima] FATAL ...`），照着报错修。

---

## 它怎么工作

```
            ┌──────────────── 宿主进程 ─────────────────┐
用户消息 →  │  session/event ──► capture ──► episodes.jsonl │
            │                       └────► memory.jsonl  │
            │                                             │
请求装配 →  │  systemPrompt.section('soul:identity')      │
            │      ▲ persona + 高频记忆 + 最近片段（缓存）│
            │                                             │
模型调用 →  │  tools: soul_remember / recall / forget / reflect │
用户输入 →  │  command: /soul                             │
            └─────────────────────────────────────────────┘
                                │
                      ~/.dsh/anima/（纯文件）
```

三件事：

1. **常驻注入**——每轮请求的系统提示词里都有一段「我是谁 + 我记得什么」。它按「人格版本 + 记忆版本 + 会话」缓存：同一会话内文本冻结，记忆或人格变了才重建。这样既保证自我连续，又不会每轮打穿前缀缓存。
2. **被动捕获**——监听 `session/event`，零 token 地把对话压成片段；命中「记住 / 我喜欢 / 以后都 / remember / my name is…」这类线索时，升格成带权重的长期记忆。
3. **主动读写**——模型可以自己写记忆、改人格；你也可以用 `/soul` 直接查看和编辑。

---

## 工具

| 工具 | 作用 |
| --- | --- |
| `soul_remember` | 写入长期记忆（类型 / 权重 / 标签） |
| `soul_recall` | 检索记忆（中英混排分词 + 稀有词加权 + 权重 + 命中次数；休眠记忆也能搜到） |
| `soul_forget` | 归档一条记忆（不是物理删除） |
| `soul_reflect` | 改写人格（自动留快照），或只往成长日志追加一笔 |
| `soul_handoff` | 生成本项目的交接（目标 / 决定 / 进度 / 路径 / 待办），并回灌进长期记忆 |

## 项目交接（v0.3）

上下文写满时，最糟的不是忘字，是把"做到哪一步了"丢掉。v0.3 做三件事：

1. **盯水位**：每轮用 `ctx.tokenMeter.measure(session)` 对比模型容量（来自 `request/context` 或 `llm.resolveModelInfo()`），到 `handoffAt`（默认 0.95）就进入警戒。
2. **等项目收尾**：只要还有没返回的工具调用就不动手；等到那个"把项目做完"的 `turn/end` 才交接，绝不把活切在半句上。
3. **交接并接上**：把目标、已定的决定、最近进度、动过的路径、没做完的待办写成 `handoffs/<时间>-<id>.md` 和一行 JSON；决定与待办同时回灌成长期记忆（`tags: ["handoff"]`）。新项目的第一轮会把这份交接以 `## 上一个项目的交接` 注入一次，之后自动退出注入块——读一次、不常驻、不打断前缀缓存。

警戒期间注入块里会出现 `## 上下文水位告警`，让模型先把当前项目收尾，而不是接着开新话题。手动留档：`soul_handoff` 工具或 `/soul handoff now`。

> 自动新建项目这一步会尝试 `ctx.sessions.create`；宿主若拒绝（活会话需要 agent 句柄），交接照样落盘，等你下次开会话时自动接上——不假装成功。

## 记忆整理与休眠（v0.2）

记忆用久了会攒重复、堆无用条目。v0.2 加了两条自动机制，都**不删除任何内容**：

- **合并去重**：同类型、文本相似度 ≥ 0.75 的条目并成一条（保留权重最高、最完整的那条，命中次数相加），被合并的标记 `mergedInto` 归档。`/soul merge` 手动触发，`/soul merge dry` 先看预演；开启 `autoConsolidate` 时，记忆数超过 `consolidateAt` 会在启动后自动跑一次。
- **休眠**：重要度 ≤ 2、命中少于 2 次、且超过 `decayDays` 天没被想起的条目，不再占用常驻注入的位置；但 `soul_recall` 仍能检索到它，`/soul dormant` 可查看，`/soul wake <id>` 可唤醒。

注入也分层了：`## 我记得的事` 是常驻记忆，`## 和眼下这件事有关的记忆` 是按当前会话主题检索出来的（会话内冻结，不会每轮变动）。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/soul` | 状态：人格版本、记忆数、片段数、数据目录 |
| `/soul stats` | 记忆统计：类型分布、权重分布、休眠数、命中情况 |
| `/soul remember <内容>` | 手动记一条 |
| `/soul recall <关键词>` | 检索 |
| `/soul forget <id 或原文>` | 归档 |
| `/soul merge [dry]` | 合并重复记忆（先 `dry` 看预演） |
| `/soul handoff [now\|status]` | 生成当前项目的交接 / 看最近几份交接 |
| `/soul dormant` | 查看休眠中的记忆 |
| `/soul wake <id>` | 唤醒一条休眠记忆 |
| `/soul persona` | 查看当前人格 |
| `/soul snapshots` | 查看人格快照列表 |
| `/soul rollback [序号\|名字]` | 把人格拉回某个快照（回滚前也会留一份） |
| `/soul journal` | 查看成长日志 |
| `/soul export` | 导出 Markdown 备份到数据目录 |
| `/soul import <路径>` | 从 JSONL / JSON 导入记忆（跨机器搬运） |
| `/soul help` | 帮助 |

---

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（只需写要改的键）：

```yaml
- id: soul
  name: dsh-anima
  config:
    dataDir: "D:/my-soul"      # 默认 ~/.dsh/anima（$DSH_HOME 优先）
    promptMaxChars: 4000       # 注入文本预算，超了先砍相关记忆、再砍片段、最后砍常驻记忆
    injectMemories: 24         # 常驻记忆条数
    injectRelevant: 6          # 按会话主题检索的相关记忆条数（0 = 关）
    injectEpisodes: 6          # 常驻片段条数
    captureEpisodes: true      # 自动压片段
    captureCues: true          # 自动升格显式线索
    autoConsolidate: true      # 记忆攒多了自动合并重复
    consolidateAt: 300         # 触发自动合并的存活条目数
    decayDays: 120             # 低权重记忆多少天没被想起就休眠
    handoffAt: 0.95            # 上下文水位到多少就准备项目交接
    autoHandoff: true          # 项目收尾后自动生成交接（false = 只手动）
    handoffNewSession: true    # 尝试开新项目会话（宿主拒绝时只落盘交接）
    inject: true               # 关掉就是不注入（工具仍然可用）
    sectionOrder: 10050        # 灵魂块在系统提示词里的位置
```

## 数据

都在 `dataDir` 里，全是人可读的文本：

| 文件 | 内容 |
| --- | --- |
| `persona.md` | 人格与自我叙事，可直接手改 |
| `memory.jsonl` | 长期记忆，一行一条 JSON，只追加、定期压实 |
| `episodes.jsonl` | 对话片段（跨会话连续性的来源） |
| `journal.md` | 成长日志 |
| `state.json` | 会话索引、计数器、人格版本 |
| `snapshots/` | 人格历史快照（改写前自动备份，保留最近 40 份） |
| `handoffs.jsonl` | 项目交接记录（结构化，一行一份） |
| `handoffs/` | 同名交接的 Markdown 版本，人可直接读 |

备份 = 复制这个目录；迁移 = 改 `dataDir`；彻底重来 = 删掉目录。

---

## 设计取舍

- **只用 `node:fs`，零依赖**——不 import 任何 `@deepseek-ai/*` 包，宿主升级或包解析不到时也不会让整个插件崩掉。
- **不用 `ctx.storage`**——那个 hub 需要额外后端与数据形式装配；纯文件更简单、更可移植、更容易被人类直接看懂。
- **注入文本按版本缓存**——系统提示词是请求前缀，每轮变动会让 KV 缓存全量失效。人格不常变，记忆版本号变才重建；相关记忆在会话内冻结。
- **整理只归档，不删除**——合并与休眠都保留原始条目（`mergedInto` / 休眠仍是可检索记录），后悔了还能捞回来。
- **命中计数延迟落盘**——检索是高频操作，`hits` 攒 0.8 秒再写，退出前 flush，避免每轮写文件。
- **注册失败必须喊出来**——四个工具任何一个没注册上都会打 `FATAL`，而不是静默降级。
- **交接等在项目收尾后**——水位到 95% 不立刻打断，等没有挂起工具调用的 `turn/end` 才动手；宁可晚一轮，也不把活切在半句上。
- **记忆宁缺勿滥**——检索命中不到就返回空，绝不塞不相干的记忆凑数。

## 隐私

- 全部数据留在本地 `dataDir`，插件不发起任何网络请求。
- 记忆会被注入你自己的模型请求，和你说的话一样会离开本机——不要把密钥写进记忆。
- 想把数据带走或审查：`/soul export`。

## 兼容性

- DSH `>= 0.2.0`（`dsh.bundle.patch` 与 `systemPrompt.section` 在 0.2.1 上验证）。
- Node `>= 22`（宿主自带，无需单独安装）。
- 只注册宿主半体，不需要 `dsh.client`，因此任何 profile（`web` / `headless` / `desktop`）都能装。

## 开发

```sh
node scripts/smoke.mjs        # 34 项断言，假 ctx 跑通全部链路，不需要 DSH 在跑
node scripts/test-upgrade.mjs # 32 项断言，只测 v0.2 新能力（合并 / 休眠 / 回滚 / 导入导出 / 分层注入）
node scripts/test-handoff.mjs # 21 项断言，测 v0.3 项目交接（水位 → 警戒 → 等收尾 → 交接 → 新项目读一次）
```

目录：

```
lib/store.js     持久化内核（原子写、串行化、去重、压实、快照、合并、休眠、交接记录）
lib/prompt.js    注入块渲染与预算裁剪（常驻记忆 + 相关记忆 + 片段 + 交接 / 水位告警）
lib/capture.js   会话事件 → 片段 / 线索记忆 / 交接用的最近几轮与路径
lib/handoff.js   上下文水位与项目交接（组装、落盘、回灌记忆、尝试开新会话）
lib/tools.js     5 个工具 + /soul 命令
lib/index.js     装配（systemPrompt / session / tools / commands）
scripts/make-index.mjs  重新生成 market/index.json
```

## 许可

MIT，见 [LICENSE](LICENSE)。
