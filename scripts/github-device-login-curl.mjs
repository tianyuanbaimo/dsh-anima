// GitHub 设备授权（走 curl.exe，绕开被墙的 github.com 解析）
// 本机 github.com 的 DNS 指向被封锁的 IP，但 20.27.177.113 / 140.82.112.3 可以直连。
// 用法：node scripts/github-device-login-curl.mjs [--token-file path] [--scope repo,read:user]
import { promises as fs } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (n) => {
  const i = args.indexOf(n)
  return i >= 0 ? args[i + 1] : undefined
}

const CLIENT_ID = flag('--client-id') ?? '01ab8ac9400c4e429b23'
const SCOPE = flag('--scope') ?? 'repo,read:user'
const TOKEN_FILE = path.resolve(flag('--token-file') ?? path.join(root, '.publish-tokens.json'))
const IPS = ['20.27.177.113', '20.27.177.114', '4.237.22.38']
const curl = 'C:\\WINDOWS\\system32\\curl.exe'
const DIRECT = process.env.GH_DIRECT === '1'
function resolveArgs(ip) {
  return DIRECT ? [] : ['--resolve', `github.com:443:${ip}`]
}

function post(form, ips = IPS) {
  let lastErr
  for (const ip of ips) {
    try {
      const out = execFileSync(
        curl,
        [
          '-sS', '--max-time', '40', '--resolve', `github.com:443:${ip}`,
          '-X', 'POST',
          '-H', 'accept: application/json',
          '-H', 'content-type: application/x-www-form-urlencoded',
          '-d', new URLSearchParams(form).toString(),
          'https://github.com/login/device/code',
        ],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      )
      return JSON.parse(out)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

function postToken(form, ips = IPS) {
  let lastErr
  for (const ip of ips) {
    try {
      const out = execFileSync(
        curl,
        [
          '-sS', '--max-time', '40', '--resolve', `github.com:443:${ip}`,
          '-X', 'POST',
          '-H', 'accept: application/json',
          '-H', 'content-type: application/x-www-form-urlencoded',
          '-d', new URLSearchParams(form).toString(),
          'https://github.com/login/oauth/access_token',
        ],
        { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
      )
      return JSON.parse(out)
    } catch (err) {
      lastErr = err
    }
  }
  throw lastErr
}

const start = post({ client_id: CLIENT_ID, scope: SCOPE })
if (!start.device_code) {
  console.error(`device code failed: ${JSON.stringify(start)}`)
  process.exit(1)
}

const interval = Math.max(5, Number(start.interval) || 5)
const deadline = Date.now() + Math.min(Number(start.expires_in) || 900, 1800) * 1000
console.log(`CODE=${start.user_code}`)
console.log(`URL=${start.verification_uri}`)
console.log(`expires ${Math.round((deadline - Date.now()) / 1000)}s`)

while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, interval * 1000))
  let res
  try {
    res = postToken({
      client_id: CLIENT_ID,
      device_code: start.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    })
  } catch {
    // 网络抖动不该让整个授权流程死掉：10 秒后继续轮询
    console.log('poll retry')
    await new Promise((r) => setTimeout(r, 10000))
    continue
  }
  if (res.access_token) {
    let cur = {}
    try {
      cur = JSON.parse(await fs.readFile(TOKEN_FILE, 'utf8'))
    } catch {}
    cur.github = res.access_token
    cur.githubAt = new Date().toISOString()
    await fs.writeFile(TOKEN_FILE, `${JSON.stringify(cur, null, 2)}\n`, 'utf8')
    console.log('AUTHORIZED')
    process.exit(0)
  }
  if (res.error === 'authorization_pending' || res.error === 'slow_down') continue
  console.error(`login failed: ${res.error} ${res.error_description ?? ''}`)
  process.exit(1)
}
console.error('device code expired')
process.exit(1)
