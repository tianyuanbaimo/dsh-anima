# 把 dsh-anima 挂进 DSH 插件市场

DSH 的「发现」页读的是**市场索引（format 1）**：一份 JSON，列出可安装的 bundle 及其元数据、版本和安装来源。索引不在 DSH 里，而在任意 http(s) URL 上——所以「进市场」有两条路，第一条今天就能自己走完。

## 一、自带索引源（推荐，完全自主）

仓库里的 [`market/index.json`](../market/index.json) 就是一份合法的 format 1 索引，只包含 dsh-anima 自己。发布后它同时在这些地址可用：

```
https://cdn.jsdelivr.net/npm/dsh-anima/market/index.json
https://raw.githubusercontent.com/OWNER/dsh-anima/main/market/index.json
```

在 DSH 里：**插件 → 发现 → 索引源（Index sources）→ 添加**，填上面任意一条，然后在发现页就能看到卡片并一键安装。

注意：插件的安装来源由索引里的 `source` 决定——

- `{"type":"npm"}`：`pnpm add dsh-anima@<version>`，最快，需要包已经发布到 npm；
- `{"type":"git","url":"https://github.com/tianyuanbaimo/dsh-anima","commit":"<40 位 SHA>"}`：从 GitHub 指定提交安装，不需要 npm 账号，但要求仓库公开且 commit 是完整 SHA。

`node scripts/make-index.mjs` 会自动二选一：在 git 工作树里取 `HEAD` 写 git 源，否则写 npm 源；也可以 `--npm` / `--git <sha>` 强制。

## 二、进公共目录（让别人默认就能搜到）

公共目录是别人维护的，需要向它们提交收录：

| 目录 | 收录方式 |
| --- | --- |
| `dsh-plugin-catalog`（npm 包，jsDelivr 分发） | 向其仓库提 PR，把自己的条目加进 `index.json` 的 `plugins` |
| `awesome-dsh-plugin.com`（精选列表 + 讨论区） | 按其 README 的收录规则提 PR / issue |

提交时可以直接用 `market/index.json` 里 `plugins[0]` 这一段（`name`、`title`、`description`、`author`、`homepage`、`repository`、`metadata`、`versions`）。对方通常会要求：仓库公开、有 LICENSE、有 README、`engines.dsh` 声明正确。

## 校验

索引格式的校验器是 `@deepseek-ai/dsh-plugin-market-index` 的 `parseMarketIndex(value, indexUrl)`，常见硬性规则：

- `format` 必须是 `1`；`title` 的本地化对象必须含 `en` 键；
- `name` 必须是合法 npm 包名；同一份索引内不能重名、同版本不能重复；
- `version` 必须是精确 SemVer；`publishTimestamp` 是 Unix 秒的整数；
- `source.type` 只能是 `npm` 或 `git`；git 的 `commit` 必须是 40 位小写十六进制；
- `engines.dsh` 必须是合法 SemVer range，不能是 `workspace:`；
- `icon` 若是相对路径，必须能解析成 https 或与索引同源。
