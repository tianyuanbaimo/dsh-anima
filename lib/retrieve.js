/**
 * dsh-anima · 取用层（v0.4）：三因子打分 + 可选重排 + 预算
 *
 * 默认零依赖：用 cards.search() 的 0.7/0.2/0.1 三因子排序，取 Top-3。
 * 如果配置了本地重排后端（Ollama 的 /api/generate），就用小模型把 Top-10 重新打分：
 *   - 2 秒超时，超时或报错直接降级用原排序（不阻塞对话）
 *   - 结果进 LRU 缓存（同样的问题不重复问模型）
 *   - 启动时预热一次（探活），避免第一次用的时候卡住
 */

const CACHE_MAX = 100
const CACHE_TTL = 10 * 60 * 1000

export function createRetrieve({ cards, cfg = {}, log = () => {} }) {
  const base = String(cfg.rerankBase || 'http://127.0.0.1:11434').replace(/\/+$/, '')
  const model = String(cfg.rerankModel || '')
  const timeoutMs = Number(cfg.rerankTimeoutMs) || 2000
  const cache = new Map()
  let available = false
  let warm = null
  const stats = { rerankCalls: 0, rerankHits: 0, rerankFails: 0, cacheHits: 0 }

  async function fetchWithTimeout(url, init, ms) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), ms)
    try {
      return await fetch(url, { ...init, signal: ctrl.signal })
    } finally {
      clearTimeout(timer)
    }
  }

  async function ping() {
    if (!model) return false
    try {
      const res = await fetchWithTimeout(`${base}/api/tags`, { method: 'GET' }, 800)
      if (!res.ok) return false
      const json = await res.json()
      const names = (json.models || []).map((m) => String(m.name || ''))
      available = names.some((n) => n === model || n.startsWith(`${model}:`) || model.startsWith(n))
      if (!available) log(`重排模型 ${model} 不在本地，降级为三因子排序`)
      return available
    } catch {
      available = false
      return false
    }
  }

  /** 预热：等 ready 后探一次，之后按需重试（失败不抛） */
  function warmup() {
    if (!warm) warm = ping().catch(() => false)
    return warm
  }

  function cacheKey(owner, query) {
    return `${owner || 'shared'}::${String(query || '').trim().slice(0, 120)}`
  }

  function readCache(key) {
    const hit = cache.get(key)
    if (!hit) return null
    if (Date.now() - hit.at > CACHE_TTL) {
      cache.delete(key)
      return null
    }
    return hit.ids
  }

  function writeCache(key, ids) {
    cache.set(key, { ids, at: Date.now() })
    if (cache.size > CACHE_MAX) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) cache.delete(oldest[0])
    }
  }

  /** 让本地小模型给候选打分；失败返回 null（调用方降级） */
  async function askModel(query, candidates) {
    const numbered = candidates
      .map((c, i) => `${i + 1}. ${c.card.title} :: ${String(c.card.summary).slice(0, 120)}`)
      .join('\n')
    const prompt = [
      '你在给记忆卡片做相关性重排。只输出 JSON 数组，每一项是 0-10 的整数，顺序与输入一致。',
      `问题：${query}`,
      '候选：',
      numbered,
      '只输出数组，例如 [8,3,5]。',
    ].join('\n')
    const res = await fetchWithTimeout(
      `${base}/api/generate`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, num_predict: 120, think: false } }),
      },
      timeoutMs,
    )
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const json = await res.json()
    const text = String(json.response || '')
    const arr = text.match(/\[[\s\d,.\s]+\]/)
    if (!arr) throw new Error('no scores')
    const scores = JSON.parse(arr[0])
    if (!Array.isArray(scores) || scores.length !== candidates.length) throw new Error('bad scores')
    return scores.map((n) => Number(n) || 0)
  }

  /**
   * 取与当前话题相关的卡片。
   * @returns {Promise<{items:Array, reranked:boolean, degraded:string|null}>}
   */
  async function pick(query, opts = {}) {
    const pool = opts.pool || 10
    const topK = opts.topK || 3
    const owner = opts.owner || 'shared'
    const q = String(query || '').trim()
    if (!q) {
      const recent = cards.recent(owner, topK)
      return { items: recent.map((card) => ({ card, score: 0 })), reranked: false, degraded: null }
    }

    const key = cacheKey(owner, q)
    const cached = readCache(key)
    if (cached) {
      stats.cacheHits += 1
      const items = cached.map((id) => cards.get(id)).filter(Boolean).map((card) => ({ card, score: 0 }))
      if (items.length) return { items, reranked: true, degraded: null }
    }

    const candidates = cards.search(q, { owner, limit: pool })
    let items = candidates
    let reranked = false
    let degraded = null

    if (model) {
      await warmup()
      if (available && candidates.length > 1) {
        try {
          stats.rerankCalls += 1
          const scores = await askModel(q, candidates)
          stats.rerankHits += 1
          items = candidates
            .map((c, i) => ({ ...c, score: (scores[i] ?? 0) / 10 }))
            .sort((a, b) => b.score - a.score)
          reranked = true
        } catch (err) {
          stats.rerankFails += 1
          degraded = err?.name === 'AbortError' ? 'timeout' : String(err?.message || err)
        }
      } else {
        degraded = available ? 'too-few-candidates' : 'model-unavailable'
      }
    }

    items = items.slice(0, topK)
    if (items.length) writeCache(key, items.map((i) => i.card.id))
    return { items, reranked, degraded }
  }

  return { pick, warmup, stats, isAvailable: () => available, dir: cards.dir }
}
