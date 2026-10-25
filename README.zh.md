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

---

## 安装

### 从插件市场

1. 打开 **插件 → 发现 → 索引源（Index sources）**
2. 添加：
   ```
   https://cdn.jsdelivr.net/npm/dsh-anima/market/index.json
   ```
3. 在「发现」里找到 **dsh-anima**，点安装。

### 从命令行

```sh
dsh plugin --profile web add dsh-anima
```

桌面端用自己的 profile（常见是 `desktop`）：

```sh
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
| `soul_recall` | 检索记忆（中英混排分词 + 权重 + 命中次数排序） |
| `soul_forget` | 归档一条记忆（不是物理删除） |
| `soul_reflect` | 改写人格（自动留快照），或只往成长日志追加一笔 |

## 命令

| 命令 | 作用 |
| --- | --- |
| `/soul` | 状态：人格版本、记忆数、片段数、数据目录 |
| `/soul remember <内容>` | 手动记一条 |
| `/soul recall <关键词>` | 检索 |
| `/soul forget <id 或原文>` | 归档 |
| `/soul persona` | 查看当前人格 |
| `/soul journal` | 查看成长日志 |
| `/soul export` | 导出全部记忆为 JSON |
| `/soul help` | 帮助 |

---

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（只需写要改的键）：

```yaml
- id: soul
  name: dsh-anima
  config:
    dataDir: "D:/my-soul"      # 默认 ~/.dsh/anima（$DSH_HOME 优先）
    promptMaxChars: 4000       # 注入文本预算，超了先砍片段再砍记忆
    injectMemories: 24         # 常驻记忆条数
    injectEpisodes: 6          # 常驻片段条数
    captureEpisodes: true      # 自动压片段
    captureCues: true          # 自动升格显式线索
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

备份 = 复制这个目录；迁移 = 改 `dataDir`；彻底重来 = 删掉目录。

---

## 设计取舍

- **只用 `node:fs`，零依赖**——不 import 任何 `@deepseek-ai/*` 包，宿主升级或包解析不到时也不会让整个插件崩掉。
- **不用 `ctx.storage`**——那个 hub 需要额外后端与数据形式装配；纯文件更简单、更可移植、更容易被人类直接看懂。
- **注入文本按版本缓存**——系统提示词是请求前缀，每轮变动会让 KV 缓存全量失效。人格不常变，记忆版本号变才重建。
- **注册失败必须喊出来**——四个工具任何一个没注册上都会打 `FATAL`，而不是静默降级。
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
node scripts/smoke.mjs     # 34 项断言，假 ctx 跑通全部链路，不需要 DSH 在跑
```

目录：

```
lib/store.js     持久化内核（原子写、串行化、去重、压实、快照）
lib/prompt.js    注入块渲染与预算裁剪
lib/capture.js   会话事件 → 片段 / 线索记忆
lib/tools.js     4 个工具 + /soul 命令
lib/index.js     装配（systemPrompt / session / tools / commands）
scripts/make-index.mjs  重新生成 market/index.json
```

## 许可

MIT，见 [LICENSE](LICENSE)。
