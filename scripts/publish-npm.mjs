#!/usr/bin/env node
/**
 * Publish this package to the npm registry — no npm CLI required.
 *
 * Only node built-ins are used: the tarball is written by hand (ustar) and gzipped
 * with zlib, then sent to the registry through its publish endpoint.
 *
 * Token resolution (first hit wins, never logged):
 *   1. --token-file <path>   JSON file, e.g. {"npm":"npm_xxx"} or {"npm":"npm_xxx","github":"ghp_xxx"}
 *   2. NPM_TOKEN env var
 *   3. ~/.npmrc  (//registry.npmjs.org/:_authToken=...)
 *
 * Usage:
 *   node scripts/publish-npm.mjs --token-file D:\path\tokens.json
 *   node scripts/publish-npm.mjs --dry-run
 */

import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const dryRun = args.includes('--dry-run')

const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
const registry = (flag('--registry') ?? 'https://registry.npmjs.org').replace(/\/+$/, '')

async function token() {
  const file = flag('--token-file')
  if (file) {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    const t = raw.npm ?? raw.NPM ?? raw.npmToken ?? raw.token
    if (t) return String(t).trim()
  }
  if (process.env.NPM_TOKEN) return process.env.NPM_TOKEN.trim()
  try {
    const npmrc = await fs.readFile(path.join(os.homedir(), '.npmrc'), 'utf8')
    const m = npmrc.match(/\/\/registry\.npmjs\.org\/:_authToken\s*=\s*(\S+)/)
    if (m) return m[1]
  } catch {}
  throw new Error('no npm token: pass --token-file, or set NPM_TOKEN, or add //registry.npmjs.org/:_authToken= to ~/.npmrc')
}

/** Collect the files npm would pack, honouring package.json "files". */
async function collectFiles() {
  const out = new Map()
  const walk = async (dir, rel) => {
    for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name)
      const r = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) {
        if (['node_modules', '.git', '.tmp'].includes(ent.name)) continue
        await walk(abs, r)
      } else if (ent.isFile()) {
        const base = ent.name
        if (/\.(log|tmp)$/.test(base)) continue
        out.set(r, abs)
      }
    }
  }
  for (const entry of pkg.files ?? []) {
    const abs = path.join(root, entry)
    const st = await fs.stat(abs).catch(() => null)
    if (!st) continue
    if (st.isDirectory()) await walk(abs, entry)
    else out.set(entry, abs)
  }
  for (const name of ['package.json', 'README.md', 'README.zh.md', 'LICENSE', 'CHANGELOG.md']) {
    const abs = path.join(root, name)
    if (await fs.stat(abs).catch(() => null)) out.set(name, abs)
  }
  return [...out.entries()].sort(([a], [b]) => a.localeCompare(b))
}

/** Minimal ustar writer (npm tarballs prefix every path with "package/"). */
function tarGz(files) {
  const chunks = []
  const now = Math.floor(Date.now() / 1000)
  for (const [rel, abs, data] of files) {
    const name = `package/${rel}`
    const header = Buffer.alloc(512, 0)
    const put = (str, off, len) => Buffer.from(str, 'utf8').copy(header, off, 0, len)
    put(name.length > 100 ? name.slice(-100) : name, 0, 100)
    put('0000644\0', 100, 8) // mode
    put('0000000\0', 108, 8) // uid
    put('0000000\0', 116, 8) // gid
    put(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12)
    put(`${now.toString(8).padStart(11, '0')}\0`, 136, 12)
    put('        ', 148, 8) // checksum placeholder
    put('0', 156, 1) // typeflag: regular file
    put('ustar\x0000', 257, 8)
    let sum = 0
    for (const byte of header) sum += byte
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8)
    chunks.push(header, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) chunks.push(Buffer.alloc(pad, 0))
  }
  chunks.push(Buffer.alloc(1024, 0))
  return gzipSync(Buffer.concat(chunks), { level: 9 })
}

const entries = await collectFiles()
const files = []
for (const [rel, abs] of entries) files.push([rel, abs, await fs.readFile(abs)])

const tarball = tarGz(files)
const shasum = createHash('sha1').update(tarball).digest('hex')
const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`
const tgzName = `${pkg.name}-${pkg.version}.tgz`
const tarballUrl = `${registry}/${pkg.name}/-/${tgzName}`

console.log(`packed ${files.length} files → ${(tarball.length / 1024).toFixed(1)} KB (${shasum.slice(0, 12)}…)`)
for (const [rel, , data] of files) console.log(`  ${String(data.length).padStart(7)}  ${rel}`)

if (dryRun) {
  console.log('dry run: not uploading')
  process.exit(0)
}

const tokenValue = await token()
const manifest = JSON.parse(JSON.stringify(pkg))
manifest._id = `${pkg.name}@${pkg.version}`
manifest.dist = { shasum, integrity, tarball: tarballUrl }
delete manifest.scripts?.prepublishOnly
delete manifest.devDependencies

const body = {
  _id: pkg.name,
  name: pkg.name,
  description: pkg.description,
  'dist-tags': { latest: pkg.version },
  versions: { [pkg.version]: manifest },
  readme: await fs.readFile(path.join(root, 'README.md'), 'utf8').catch(() => ''),
  _attachments: {
    [tgzName]: {
      content_type: 'application/octet-stream',
      data: tarball.toString('base64'),
      length: tarball.length,
    },
  },
}

const res = await fetch(`${registry}/${pkg.name}`, {
  method: 'PUT',
  headers: {
    authorization: `Bearer ${tokenValue}`,
    'content-type': 'application/json',
    'npm-auth-type': 'legacy',
    'npm-command': 'publish',
    'user-agent': 'dsh-anima-publisher/1.0',
    // 账号开了 2FA 时，npm 要求带上一次性验证码
    ...(flag('--otp') ? { 'npm-otp': String(flag('--otp')) } : {}),
  },
  body: JSON.stringify(body),
})

const text = await res.text()
if (!res.ok) {
  console.error(`publish failed: HTTP ${res.status}\n${text.slice(0, 1200)}`)
  process.exit(1)
}
console.log(`published ${pkg.name}@${pkg.version} → ${registry}`)

const check = await fetch(`${registry}/${pkg.name}`, { headers: { accept: 'application/json' } })
if (check.ok) {
  const doc = await check.json()
  const ok = Boolean(doc.versions?.[pkg.version])
  console.log(`verify: ${ok ? 'version visible in registry ✓' : 'version NOT visible yet (propagation delay?)'}`)
  if (!ok) process.exit(1)
}
