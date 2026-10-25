#!/usr/bin/env node
/**
 * Create (or update) the public GitHub repository and push this working tree —
 * no git binary required, only the GitHub REST API.
 *
 * What it does:
 *   1. resolves the account from the token (GET /user);
 *   2. rewrites every URL placeholder (https://github.com/tianyuanbaimo/...) to the real owner
 *      in package.json / READMEs / docs, so the published files point at themselves;
 *   3. makes sure the repository exists (creates it as public + MIT + issues);
 *   4. uploads every file as a blob, builds one tree and one commit, moves main.
 *
 * Token resolution (never logged):
 *   1. --token-file <path>   JSON file, e.g. {"github":"ghp_xxx"}
 *   2. GITHUB_TOKEN / GH_TOKEN env var
 *
 * Usage:
 *   node scripts/push-github.mjs --token-file D:\path\tokens.json
 *   node scripts/push-github.mjs --token-file ... --repo dsh-anima --dry-run
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
const dryRun = args.includes('--dry-run')

const API = 'https://api.github.com'
const SKIP_DIRS = new Set(['node_modules', '.git', '.tmp', 'data'])
const SKIP_FILES = /\.(log|tmp)$/
const SKIP_NAMES = new Set(['.publish-tokens.json', 'pnpm-lock.yaml'])

async function token() {
  const file = flag('--token-file')
  if (file) {
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    const t = raw.github ?? raw.GITHUB ?? raw.gh ?? raw.githubToken
    if (t) return String(t).trim()
  }
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim()
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim()
  throw new Error('no GitHub token: pass --token-file or set GITHUB_TOKEN')
}

const tokenValue = await token()

async function api(method, route, body, { allow404 = false } = {}) {
  const res = await fetch(route.startsWith('http') ? route : `${API}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${tokenValue}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-anima-publisher/1.0',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (allow404 && res.status === 404) return null
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${route} → HTTP ${res.status}: ${text.slice(0, 600)}`)
  return text ? JSON.parse(text) : null
}

const user = await api('GET', '/user')
const owner = flag('--owner') ?? user.login
const repo = flag('--repo') ?? 'dsh-anima'
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))

console.log(`account: ${user.login} → ${owner}/${repo}`)

const files = []
async function walk(dir, rel) {
  for (const ent of await fs.readdir(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name)
    const r = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue
      await walk(abs, r)
    } else if (ent.isFile() && !SKIP_FILES.test(ent.name) && !SKIP_NAMES.has(ent.name)) {
      files.push(r)
    }
  }
}
await walk(root, '')
files.sort()
console.log(`files to push: ${files.length}`)

/** Rewrite OWNER placeholders to the real account, in place, so the repo is self-consistent. */
const textTargets = files.filter((f) => /(\.(json|md|yml|yaml|js|mjs)$)/.test(f) && !f.startsWith('market/icon'))
let rewritten = 0
for (const rel of textTargets) {
  const abs = path.join(root, rel)
  const before = await fs.readFile(abs, 'utf8')
  if (!before.includes('github.com/tianyuanbaimo')) continue
  const after = before.replaceAll('github.com/tianyuanbaimo', `github.com/${owner}`)
  await fs.writeFile(abs, after, 'utf8')
  rewritten += 1
}
if (rewritten) console.log(`rewrote OWNER placeholder in ${rewritten} file(s)`)

if (dryRun) {
  console.log('dry run: nothing pushed')
  process.exit(0)
}

let meta = await api('GET', `/repos/${owner}/${repo}`, undefined, { allow404: true })
if (!meta) {
  console.log('creating repository…')
  meta = await api('POST', '/user/repos', {
    name: repo,
    description: pkg.description,
    homepage: `https://github.com/${owner}/${repo}`,
    private: false,
    has_issues: true,
    has_wiki: false,
    license_template: 'mit',
    auto_init: false,
  })
}
const defaultBranch = meta.default_branch || 'main'

const ref = await api('GET', `/repos/${owner}/${repo}/git/ref/heads/${defaultBranch}`, undefined, { allow404: true })
const parentSha = ref?.object?.sha ?? null

const blobs = []
for (const rel of files) {
  const data = await fs.readFile(path.join(root, rel))
  const blob = await api('POST', `/repos/${owner}/${repo}/git/blobs`, {
    content: data.toString('base64'),
    encoding: 'base64',
  })
  blobs.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha })
}
console.log(`uploaded ${blobs.length} blobs`)

const tree = await api('POST', `/repos/${owner}/${repo}/git/trees`, {
  tree: blobs,
  ...(parentSha ? {} : {}),
})

const commit = await api('POST', `/repos/${owner}/${repo}/git/commits`, {
  message: `release v${pkg.version}: ${pkg.name} — persistent persona + long-term memory for DSH`,
  tree: tree.sha,
  parents: parentSha ? [parentSha] : [],
})

if (parentSha) {
  await api('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${defaultBranch}`, { sha: commit.sha, force: true })
  console.log(`updated ${defaultBranch} → ${commit.sha.slice(0, 7)}`)
} else {
  await api('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${defaultBranch}`, sha: commit.sha })
  console.log(`created ${defaultBranch} → ${commit.sha.slice(0, 7)}`)
}

const htmlUrl = `https://github.com/${owner}/${repo}`
console.log(`done: ${htmlUrl}`)
console.log(`index (jsDelivr): https://cdn.jsdelivr.net/gh/${owner}/${repo}@${defaultBranch}/market/index.json`)
