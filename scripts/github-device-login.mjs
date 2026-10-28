#!/usr/bin/env node
/**
 * GitHub device-flow login — obtain a token without the user copying anything.
 *
 * Prints a short code and a URL; the user opens the URL once, types the code, approves.
 * This process polls in the background and, on approval, writes the token into
 * .publish-tokens.json (permission 0600 where the platform supports it). The token is
 * never printed.
 *
 * Usage:
 *   node scripts/github-device-login.mjs [--token-file <path>] [--scope repo,read:user]
 *
 * Env:
 *   GITHUB_OAUTH_CLIENT_ID  override the public OAuth client id used for the flow.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

// Public OAuth client id of the GitHub CLI. Device flow is enabled for it; it identifies
// the *application*, not an account, so no secret is involved.
const clientId = flag('--client-id') ?? process.env.GITHUB_OAUTH_CLIENT_ID ?? 'Iv1.b507a08c87ecfe98'
const scope = flag('--scope') ?? 'repo,read:user'
const tokenFile = path.resolve(flag('--token-file') ?? path.join(root, '.publish-tokens.json'))

async function post(url, form) {
  let lastErr
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(form).toString(),
        signal: AbortSignal.timeout(20000),
      })
      const text = await res.text()
      try {
        return JSON.parse(text)
      } catch {
        return { error: 'bad_response', error_description: text.slice(0, 300) }
      }
    } catch (err) {
      lastErr = err
      // 本机直连 github.com 会偶发超时；重试而不是让整个授权流程崩掉
      if (attempt < 4) await new Promise((r) => setTimeout(r, 1500 * attempt))
    }
  }
  throw lastErr
}

const start = await post('https://github.com/login/device/code', { client_id: clientId, scope })
if (!start.device_code) {
  console.error(`device code request failed: ${start.error_description ?? JSON.stringify(start)}`)
  process.exit(1)
}

const interval = Math.max(5, Number(start.interval) || 5)
const deadline = Date.now() + Math.min(Number(start.expires_in) || 900, 1800) * 1000

console.log('CODE=' + start.user_code)
console.log('URL=' + start.verification_uri)
console.log(`expires in ${Math.round((deadline - Date.now()) / 1000)}s, polling every ${interval}s`)

let announced = 0
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, interval * 1000))
  const res = await post('https://github.com/login/oauth/access_token', {
    client_id: clientId,
    device_code: start.device_code,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })
  if (res.access_token) {
    let current = {}
    try {
      current = JSON.parse(await fs.readFile(tokenFile, 'utf8'))
    } catch {}
    current.github = res.access_token
    await fs.writeFile(tokenFile, `${JSON.stringify(current, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    console.log(`authorized — token written to ${tokenFile}`)
    process.exit(0)
  }
  if (res.error === 'authorization_pending') {
    announced += 1
    if (announced % 6 === 0) console.log('still waiting for approval…')
    continue
  }
  if (res.error === 'slow_down') continue
  console.error(`login failed: ${res.error} ${res.error_description ?? ''}`)
  process.exit(1)
}
console.error('device code expired before approval')
process.exit(1)
