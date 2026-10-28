#!/usr/bin/env node
/**
 * npm 网页授权登录（不需要用户粘贴 token）
 *
 * 复刻 npm CLI 9+ 的 `npm login --auth-type=web` 协议：
 *   1. POST https://registry.npmjs.org/-/v1/login  拿到 { loginUrl, doneUrl }
 *   2. 用户在浏览器里打开 loginUrl 并确认（若已登录会直接确认）
 *   3. 轮询 doneUrl，拿到访问令牌，写进 ~/.npmrc
 *
 * 用法：
 *   node --use-system-ca scripts/npm-web-login.mjs            # 打印链接并等待
 *   node --use-system-ca scripts/npm-web-login.mjs --token-only
 */
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'

const REGISTRY = 'https://registry.npmjs.org/'
const UA = 'npm/10.9.0 node/' + process.version.replace(/^v/, '') + ' ' + process.platform + ' ' + process.arch

const session = randomUUID()

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': UA,
      // registry 用这两个头把请求识别成 CLI 的网页登录，否则一律 401
      'npm-command': 'login',
      'npm-auth-type': 'web',
      ...headers,
    },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json, text }
}

async function main() {
  const tokenOnly = process.argv.includes('--token-only')
  const payload = {
    hostname: 'localhost',
    npm_session: session,
    npm_version: '10.9.0',
    node_version: process.version.replace(/^v/, ''),
    npm_user_agent: UA,
    gyp_install_runtime: 'node',
  }
  const r = await post(REGISTRY + '-/v1/login', payload)
  if (r.status !== 200 || !r.json) {
    console.error(`[npm-login] 创建登录会话失败 HTTP ${r.status}: ${r.text.slice(0, 300)}`)
    process.exit(1)
  }
  const { loginUrl, doneUrl } = r.json
  if (!loginUrl || !doneUrl) {
    console.error('[npm-login] 响应缺少 loginUrl/doneUrl: ' + r.text.slice(0, 300))
    process.exit(1)
  }
  console.log('\n  👉 在浏览器打开这个链接确认授权（浏览器里已登录 npm 的话点一下就行）：\n')
  console.log('    ' + loginUrl + '\n')
  if (!tokenOnly) console.log('  等待确认中（最多 5 分钟）…\n')

  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000))
    const res = await fetch(doneUrl, {
      headers: { 'user-agent': UA, authorization: `Bearer ${session}` },
    })
    if (res.status === 404) continue
    const body = await res.json().catch(() => null)
    if (res.status === 200 && body && body.token) {
      const outIdx = process.argv.indexOf('--out')
      const outFile = outIdx > 0 ? process.argv[outIdx + 1] : ''
      if (outFile) {
        // 工作区内写入（沙箱允许），发布脚本用 --token-file 读取
        await fs.writeFile(outFile, JSON.stringify({ token: body.token, created: new Date().toISOString() }, null, 2), 'utf8')
        console.log('  ✅ 登录成功，令牌已写入 ' + outFile)
        console.log('  发布：node --use-system-ca scripts/publish-npm.mjs --token-file ' + outFile)
        return
      }
      const npmrc = path.join(os.homedir(), '.npmrc')
      let content = ''
      try { content = await fs.readFile(npmrc, 'utf8') } catch { /* 没有就算了 */ }
      const line = `//registry.npmjs.org/:_authToken=${body.token}`
      if (!/registry\.npmjs\.org\/:_authToken=/.test(content)) {
        content = content.trim() ? content.trimEnd() + '\n' + line + '\n' : line + '\n'
        await fs.writeFile(npmrc, content, 'utf8')
      }
      console.log('  ✅ 登录成功，令牌已写入 ' + npmrc)
      console.log('  发布：node --use-system-ca scripts/publish-npm.mjs')
      return
    }
    if (body && body.message) console.log('  … ' + body.message)
  }
  console.error('  ⌛ 超时，未完成授权')
  process.exit(1)
}

main().catch((e) => {
  console.error('[npm-login] 失败：' + (e && e.message))
  process.exit(1)
})
