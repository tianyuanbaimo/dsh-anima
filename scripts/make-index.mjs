#!/usr/bin/env node
/**
 * Regenerate market/index.json (plugin market index format 1).
 *
 * Reads the identity from package.json, then pins the release to either:
 *   - a git commit, when the working tree is a git checkout (source.type "git"), or
 *   - the npm release (source.type "npm") otherwise.
 *
 * Usage:
 *   node scripts/make-index.mjs                 # auto-detect
 *   node scripts/make-index.mjs --npm           # force npm source
 *   node scripts/make-index.mjs --git <sha>     # force git source with an explicit 40-hex commit
 *   node scripts/make-index.mjs --timestamp 1761264000
 */

import { execFileSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

function repoUrl() {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (!raw) return undefined
  return raw.replace(/^git\+/, '').replace(/\.git$/, '')
}

function headCommit() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    return /^[0-9a-f]{40}$/.test(sha) ? sha : undefined
  } catch {
    return undefined
  }
}

const forcedGit = flag('--git')
const commit = forcedGit ?? (args.includes('--npm') ? undefined : headCommit())
const timestamp = Number(flag('--timestamp') ?? Math.floor(Date.now() / 1000))
const repo = repoUrl()

const source = commit && repo ? { type: 'git', url: repo, commit } : { type: 'npm' }

const index = {
  format: 1,
  title: { en: 'dsh-anima', zh: 'dsh-anima' },
  description: {
    en: 'Persistent persona and long-term memory that survive restarts, new sessions and compaction.',
    zh: '跨重启、跨会话持久的人格与长期记忆。',
  },
  metadata: {
    categories: { memory: { title: { en: 'Memory', zh: '记忆' } } },
    labels: {},
    sortKeys: {},
  },
  plugins: [
    {
      name: pkg.name,
      title: { en: 'dsh-anima', zh: 'dsh-anima · 记忆与人格' },
      description: {
        en: 'Give DSH a soul: persona and long-term memory that survive restarts and new sessions.',
        zh: '给 DSH 一个灵魂：关机、重启、换会话之后，它还是它。',
      },
      ...(typeof pkg.author === 'string' ? { author: pkg.author } : {}),
      ...(pkg.homepage ? { homepage: pkg.homepage } : {}),
      ...(repo ? { repository: { url: repo } } : {}),
      metadata: {
        category: 'memory',
        keywords: pkg.keywords ?? [],
        labels: [],
        sortKeys: {},
      },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: timestamp,
          source,
          engines: { dsh: pkg.dsh?.compatibility?.dshReleases ?? '>=0.2.0' },
        },
      ],
    },
  ],
}

const out = path.join(root, 'market', 'index.json')
await writeFile(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`wrote ${out} (${source.type}${commit ? ` @ ${commit.slice(0, 7)}` : ''})`)
