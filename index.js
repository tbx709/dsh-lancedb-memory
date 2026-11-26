/**
 * Embedded LanceDB memory.
 *
 * One local LanceDB table stores text notes with a vector per note. The plugin
 * exposes the table as the `lancedb` Host service and registers five agent
 * tools: store, search, forget, list, and stats.
 *
 * Retrieval is hybrid: cosine vector search plus BM25 full-text search (ICU
 * tokenizer, so Chinese is segmented by dictionary), fused with reciprocal
 * rank fusion. Fused scores are then nudged by recency decay and importance,
 * and recalled rows are reinforced by an access counter.
 *
 * Vectors come from a deterministic local hash embedder by default, so the
 * plugin works offline and with Chinese text (character bigrams). Setting
 * `embedding.provider: http` points it at an OpenAI-compatible `/embeddings`
 * endpoint instead, and the dimension is taken from the first response.
 *
 * @module dsh-lancedb-memory
 */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { connect, Index } from '@lancedb/lancedb'

/** Cordis plugin name. */
export const name = 'dsh-lancedb-memory'

/** Registers agent tools; the tools service must be present first. */
export const inject = ['tools']

const ID_PATTERN = /^[0-9a-f]{32}$/u
const TABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu
const WORD = /[a-z0-9][a-z0-9_'-]*/gu

/** Query cap shared by the tools and the service. */
const MAX_LIMIT = 50
/** Reject oversized notes; a memory table is not a file store. */
const MAX_TEXT = 20_000
/** Reject oversized metadata payloads. */
const MAX_METADATA = 8_192
/** Milliseconds in a day, for the recency half-life. */
const DAY_MS = 86_400_000
/** Candidate pool is at least this wide, so small limits still rank well. */
const MIN_POOL = 12

/**
 * Resolve and validate the row config. Throws before any tool registers, so a
 * bad row fails activation with a readable message instead of at first call.
 * @param {unknown} raw - Config object from the bundle patch.
 * @returns Resolved settings.
 */
function resolveSettings(raw) {
  const config = isRecord(raw) ? raw : {}
  const embedding = isRecord(config.embedding) ? config.embedding : {}
  const search = isRecord(config.search) ? config.search : {}
  const dedupe = isRecord(config.dedupe) ? config.dedupe : {}

  const table = config.table ?? 'memories'
  if (typeof table !== 'string' || !TABLE_PATTERN.test(table)) {
    throw new Error(`dsh-lancedb-memory: table 必须是字母或下划线开头的标识符，收到 ${JSON.stringify(table)}`)
  }

  const topK = config.topK ?? 5
  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_LIMIT) {
    throw new Error(`dsh-lancedb-memory: topK 必须是 1-${MAX_LIMIT} 的整数，收到 ${JSON.stringify(topK)}`)
  }

  const directory = typeof config.directory === 'string' && config.directory.length > 0
    ? resolve(config.directory)
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'lancedb')

  return {
    table,
    topK,
    directory,
    embedding: resolveEmbedding(embedding),
    search: {
      vectorWeight: ratio(search.vectorWeight, 0.7, 'search.vectorWeight'),
      bm25Weight: ratio(search.bm25Weight, 0.3, 'search.bm25Weight'),
      minScore: ratio(search.minScore, 0, 'search.minScore'),
      recencyWeight: ratio(search.recencyWeight, 0.1, 'search.recencyWeight'),
      importanceWeight: ratio(search.importanceWeight, 0.1, 'search.importanceWeight'),
      recencyHalfLifeDays: positive(search.recencyHalfLifeDays, 30, 'search.recencyHalfLifeDays'),
      trackAccess: search.trackAccess ?? true,
    },
    dedupe: {
      enabled: dedupe.enabled ?? true,
      threshold: ratio(dedupe.threshold, 0.95, 'dedupe.threshold'),
    },
  }
}

/**
 * Validate one 0-1 ratio.
 * @param {unknown} value - Raw value.
 * @param {number} fallback - Default.
 * @param {string} label - Field name for the error message.
 * @returns Valid ratio.
 */
function ratio(value, fallback, label) {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved < 0 || resolved > 1) {
    throw new Error(`dsh-lancedb-memory: ${label} 必须是 0-1 的数，收到 ${JSON.stringify(resolved)}`)
  }
  return resolved
}

/**
 * Validate one positive number.
 * @param {unknown} value - Raw value.
 * @param {number} fallback - Default.
 * @param {string} label - Field name for the error message.
 * @returns Valid positive number.
 */
function positive(value, fallback, label) {
  const resolved = value ?? fallback
  if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`dsh-lancedb-memory: ${label} 必须是正数，收到 ${JSON.stringify(resolved)}`)
  }
  return resolved
}

/**
 * Validate the embedding block.
 * @param {Record<string, unknown>} embedding - Raw embedding config.
 * @returns Hash or HTTP embedder settings.
 */
function resolveEmbedding(embedding) {
  const provider = embedding.provider ?? 'hash'
  if (provider === 'hash') {
    const dimension = embedding.dimension ?? 384
    if (!Number.isInteger(dimension) || dimension < 32 || dimension > 4096) {
      throw new Error(`dsh-lancedb-memory: embedding.dimension 必须是 32-4096 的整数，收到 ${JSON.stringify(dimension)}`)
    }
    return { provider, dimension }
  }
  if (provider !== 'http') {
    throw new Error(`dsh-lancedb-memory: embedding.provider 只能是 hash 或 http，收到 ${JSON.stringify(provider)}`)
  }
  if (typeof embedding.baseUrl !== 'string' || embedding.baseUrl.length === 0) {
    throw new Error('dsh-lancedb-memory: embedding.provider 为 http 时必须配置 embedding.baseUrl（OpenAI 兼容地址）')
  }
  if (typeof embedding.model !== 'string' || embedding.model.length === 0) {
    throw new Error('dsh-lancedb-memory: embedding.provider 为 http 时必须配置 embedding.model')
  }
  return {
    provider,
    baseUrl: embedding.baseUrl,
    model: embedding.model,
    apiKeyEnv: typeof embedding.apiKeyEnv === 'string' && embedding.apiKeyEnv.length > 0
      ? embedding.apiKeyEnv
      : 'DSH_LANCEDB_EMBEDDING_KEY',
  }
}

/**
 * Build the text-to-vector function described by the settings.
 * @param {ReturnType<typeof resolveEmbedding>} settings - Resolved embedding config.
 * @returns An async embedder with a stable identity string.
 */
function createEmbedder(settings) {
  if (settings.provider === 'hash') {
    return {
      id: `hash-${settings.dimension}`,
      dimension: settings.dimension,
      async embed(text) {
        return hashEmbed(text, settings.dimension)
      },
    }
  }
  const apiKey = process.env[settings.apiKeyEnv]
  return {
    id: `http:${settings.model}`,
    dimension: null,
    async embed(text) {
      return httpEmbed(text, settings, apiKey)
    },
  }
}

/**
 * Tokenize mixed Chinese/Latin text for the hash embedder.
 * Chinese runs contribute unigrams (lower weight) and bigrams (higher weight).
 * @param {string} text - Raw text.
 * @returns Array of token/weight pairs.
 */
function tokenize(text) {
  const normalized = text.normalize('NFKC').toLowerCase()
  /** @type {Array<[string, number]>} */
  const tokens = []
  for (const match of normalized.matchAll(WORD)) tokens.push([match[0], 1])
  for (const match of normalized.matchAll(CJK)) {
    const run = match[0]
    for (let index = 0; index < run.length; index += 1) tokens.push([run[index], 0.6])
    for (let index = 0; index + 1 < run.length; index += 1) tokens.push([run.slice(index, index + 2), 1])
  }
  return tokens
}

/**
 * FNV-1a over UTF-16 code units.
 * @param {string} value - Token.
 * @returns Unsigned 32-bit hash.
 */
function fnv1a(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/**
 * Signed hashing trick: each token lands in one bucket, then the vector is L2
 * normalized so cosine distance ranks lexical overlap.
 * @param {string} text - Raw text.
 * @param {number} dimension - Vector length.
 * @returns Normalized vector.
 */
function hashEmbed(text, dimension) {
  /** @type {Float64Array} */
  const vector = new Float64Array(dimension)
  for (const [token, weight] of tokenize(text)) {
    const hash = fnv1a(token)
    const index = hash % dimension
    vector[index] += (hash & 0x80000000) === 0 ? weight : -weight
  }
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  if (norm === 0) throw new Error('dsh-lancedb-memory: 这段文字没有可用的词元，无法计算向量')
  const result = new Array(dimension)
  for (let index = 0; index < dimension; index += 1) result[index] = vector[index] / norm
  return result
}

/**
 * Call an OpenAI-compatible embeddings endpoint.
 * @param {string} text - Raw text.
 * @param {{ baseUrl: string, model: string }} settings - Endpoint config.
 * @param {string | undefined} apiKey - Bearer token.
 * @returns Embedding vector.
 */
async function httpEmbed(text, settings, apiKey) {
  const base = settings.baseUrl.endsWith('/') ? settings.baseUrl : `${settings.baseUrl}/`
  const headers = { 'content-type': 'application/json' }
  if (apiKey !== undefined && apiKey.length > 0) headers.authorization = `Bearer ${apiKey}`
  const response = await fetch(new URL('embeddings', base), {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: settings.model, input: text }),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 200)
    throw new Error(`dsh-lancedb-memory: embedding 接口返回 ${response.status}: ${detail}`)
  }
  const payload = await response.json()
  const vector = payload?.data?.[0]?.embedding
  if (!Array.isArray(vector) || vector.length === 0
    || !vector.every(value => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('dsh-lancedb-memory: embedding 接口返回的向量无效')
  }
  return vector
}

/**
 * The LanceDB table, its hybrid index, and the queue that serializes writes.
 */
class MemoryStore {
  #settings
  #embedder
  #queue = Promise.resolve()
  #connection
  #migrating
  #indexing
  #migrated = false
  #ftsReady = false
  #ftsAttempted = false
  #ftsError

  /** @param {ReturnType<typeof resolveSettings>} settings - Resolved config. */
  constructor(settings) {
    this.#settings = settings
    this.#embedder = createEmbedder(settings.embedding)
  }

  /** Stable description of the table, embedder, and retrieval mode. */
  describe() {
    return {
      directory: this.#settings.directory,
      table: this.#settings.table,
      embedder: this.#embedder.id,
      dimension: this.#embedder.dimension,
      retrieval: this.#ftsReady ? 'hybrid' : 'vector',
      ...this.#ftsError === undefined ? {} : { ftsError: this.#ftsError },
    }
  }

  /**
   * Open (once) the LanceDB connection.
   * @returns LanceDB connection.
   */
  async #db() {
    this.#connection ??= (async () => {
      await mkdir(this.#settings.directory, { recursive: true })
      return connect(this.#settings.directory)
    })()
    return this.#connection
  }

  /**
   * Run a write after all earlier writes, regardless of their outcome.
   * @template T
   * @param {() => Promise<T>} task - Write to serialize.
   * @returns The task result.
   */
  #serial(task) {
    const run = this.#queue.then(task, task)
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * Open the memory table, or return undefined when it does not exist yet.
   * @returns Table or undefined.
   */
  async #table() {
    const db = await this.#db()
    const names = await db.tableNames()
    if (!names.includes(this.#settings.table)) return undefined
    return db.openTable(this.#settings.table)
  }

  /**
   * Add the lifecycle columns to an older table. Rows written by v0.1 already
   * carry `createdAt`, so new columns can be derived from it. Concurrent callers
   * share one migration.
   * @param {any} table - Open table.
   */
  async #migrate(table) {
    if (this.#migrated) return
    this.#migrating ??= (async () => {
      const schema = await table.schema()
      const names = new Set(schema.fields.map(field => field.name))
      const now = Date.now()
      const added = []
      if (!names.has('importance')) added.push({ name: 'importance', valueSql: '5.0' })
      if (!names.has('accessCount')) added.push({ name: 'accessCount', valueSql: '0' })
      if (!names.has('lastAccessedAt')) {
        added.push({ name: 'lastAccessedAt', valueSql: names.has('createdAt') ? 'createdAt' : `${now}` })
      }
      if (!names.has('updatedAt')) {
        added.push({ name: 'updatedAt', valueSql: names.has('createdAt') ? 'createdAt' : `${now}` })
      }
      if (added.length > 0) await table.addColumns(added)
      this.#migrated = true
    })().catch((error) => {
      this.#migrating = undefined
      throw error
    })
    await this.#migrating
  }

  /**
   * Make sure the BM25 index exists. An empty table defers the work to the next
   * call; a failure degrades search to vector-only and is reported by stats.
   * @param {any} table - Open table.
   */
  async #ensureFts(table) {
    if (this.#ftsReady || this.#ftsAttempted) return
    const rows = await table.countRows()
    if (rows === 0) return
    this.#indexing ??= (async () => {
      this.#ftsAttempted = true
      const indices = await table.listIndices()
      const indexed = indices.some(item => item.indexType === 'FTS'
        && (Array.isArray(item.columns) ? item.columns.includes('text') : String(item.columns).includes('text')))
      if (!indexed) {
        try {
          await table.createIndex('text', { config: Index.fts({ baseTokenizer: 'icu' }) })
        } catch (error) {
          this.#ftsError = error instanceof Error ? error.message : String(error)
          return
        }
      }
      this.#ftsReady = true
    })().finally(() => {
      this.#indexing = undefined
    })
    await this.#indexing
  }

  /**
   * Prepare an existing table for reads and writes: lifecycle columns first,
   * then the BM25 index. Cheap after the first successful call.
   * @param {any} table - Open table.
   */
  async #prepare(table) {
    await this.#migrate(table)
    await this.#ensureFts(table)
  }

  /**
   * Store one note. The same kind and text hash to the same id, and a note that
   * is already present at `dedupe.threshold` cosine similarity also returns the
   * existing row instead of adding a near-duplicate.
   * @param {{ text: string, kind?: string, metadata?: Record<string, unknown>, importance?: number }} input - Note to store.
   * @returns Stored id, row count, and whether a new row was written.
   */
  async store(input) {
    const text = normalizeText(input.text)
    const kind = normalizeKind(input.kind)
    const metadata = normalizeMetadata(input.metadata)
    const importance = normalizeImportance(input.importance)
    const id = createHash('sha256').update(`${kind}\u0000${text}`).digest('hex').slice(0, 32)
    const createdAt = Date.now()

    return this.#serial(async () => {
      const vector = await this.#embedder.embed(text)
      this.#embedder.dimension = vector.length
      const table = await this.#table()

      if (table === undefined) {
        const db = await this.#db()
        const created = await db.createTable(this.#settings.table, [{
          id, text, kind, metadata: JSON.stringify(metadata), vector, createdAt, importance,
          accessCount: 0, lastAccessedAt: createdAt, updatedAt: createdAt,
        }])
        this.#migrated = true
        await this.#ensureFts(created)
        return { id, kind, created: true, total: await created.countRows(), dimension: vector.length }
      }

      await this.#prepare(table)
      const found = await table.query().where(`id = '${id}'`).limit(1).toArray()
      if (found.length > 0) {
        return { id, kind, created: false, total: await table.countRows(), dimension: vector.length }
      }

      if (this.#settings.dedupe.enabled) {
        const near = await table.search(vector).limit(1).distanceType('cosine')
          .where(`kind = '${escapeSql(kind)}'`).toArray()
          .catch(() => [])
        const similarity = near.length === 0 ? -1 : 1 - near[0]._distance
        if (similarity >= this.#settings.dedupe.threshold) {
          return {
            id: near[0].id, kind, created: false, duplicate: true,
            similarity: round(similarity), total: await table.countRows(), dimension: vector.length,
          }
        }
      }

      try {
        await table.add([{
          id, text, kind, metadata: JSON.stringify(metadata), vector, createdAt, importance,
          accessCount: 0, lastAccessedAt: createdAt, updatedAt: createdAt,
        }])
      } catch (error) {
        throw await describeWriteFailure(table, vector.length, error)
      }
      return { id, kind, created: true, total: await table.countRows(), dimension: vector.length }
    })
  }

  /**
   * Hybrid search: cosine vectors plus BM25, fused with RRF, then nudged by
   * recency and importance. Recalled rows are reinforced for the next ranking.
   * @param {{ query: string, kind?: string, limit?: number, minScore?: number }} input - Search request.
   * @returns Ranked matches and the table row count.
   */
  async search(input) {
    const text = normalizeText(input.query, 'query')
    const kind = input.kind === undefined ? undefined : normalizeKind(input.kind)
    const limit = input.limit ?? this.#settings.topK
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error(`dsh-lancedb-memory: limit 必须是 1-${MAX_LIMIT} 的整数，收到 ${JSON.stringify(limit)}`)
    }
    const minScore = input.minScore === undefined
      ? this.#settings.search.minScore
      : ratio(input.minScore, this.#settings.search.minScore, 'minScore')

    const table = await this.#table()
    if (table === undefined) return { results: [], total: 0, table: this.#settings.table, retrieval: 'empty' }
    await this.#prepare(table)

    const vector = await this.#embedder.embed(text)
    this.#embedder.dimension = vector.length
    const total = await table.countRows()
    const pool = Math.max(limit * 4, MIN_POOL)

    let vectorQuery = table.search(vector).limit(pool).distanceType('cosine')
    if (kind !== undefined) vectorQuery = vectorQuery.where(`kind = '${escapeSql(kind)}'`)
    let vectorRows = []
    try {
      vectorRows = await vectorQuery.toArray()
    } catch (error) {
      throw await describeWriteFailure(table, vector.length, error)
    }

    let ftsRows = []
    if (this.#ftsReady) {
      try {
        let ftsQuery = table.search(text, 'fts', ['text']).limit(pool)
        if (kind !== undefined) ftsQuery = ftsQuery.where(`kind = '${escapeSql(kind)}'`)
        ftsRows = await ftsQuery.toArray()
      } catch {
        // A broken index must not break recall; vector results still answer.
        ftsRows = []
      }
    }

    const now = Date.now()
    const ranked = fuse(vectorRows, ftsRows, this.#settings.search, now)
      .filter(item => item.score >= minScore)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)

    if (this.#settings.search.trackAccess && ranked.length > 0) {
      const ids = ranked.map(item => `'${item.row.id}'`).join(', ')
      await table.update({
        where: `id IN (${ids})`,
        valuesSql: { accessCount: 'accessCount + 1', lastAccessedAt: `${now}` },
      }).catch(() => {})
    }

    return {
      results: ranked.map(toResult),
      total,
      table: this.#settings.table,
      retrieval: this.#ftsReady ? 'hybrid' : 'vector',
    }
  }

  /**
   * Delete one note by the id `store` returned.
   * @param {string} id - 32 hex characters.
   * @returns Whether a row was removed.
   */
  async forget(id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new Error('dsh-lancedb-memory: id 必须是 lancedb_store 返回的 32 位十六进制字符串')
    }
    return this.#serial(async () => {
      const table = await this.#table()
      if (table === undefined) return { id, deleted: false, total: 0 }
      const before = await table.countRows()
      await table.delete(`id = '${id}'`)
      const after = await table.countRows()
      return { id, deleted: before > after, total: after }
    })
  }

  /**
   * Browse notes newest first, optionally by kind.
   * @param {{ kind?: string, limit?: number }} input - Listing request.
   * @returns Notes without vectors.
   */
  async list(input) {
    const kind = input.kind === undefined ? undefined : normalizeKind(input.kind)
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error(`dsh-lancedb-memory: limit 必须是 1-100 的整数，收到 ${JSON.stringify(limit)}`)
    }
    const table = await this.#table()
    if (table === undefined) return { memories: [], total: 0 }
    await this.#prepare(table)
    let query = table.query().select([
      'id', 'text', 'kind', 'metadata', 'importance', 'createdAt', 'accessCount', 'lastAccessedAt',
    ])
    if (kind !== undefined) query = query.where(`kind = '${escapeSql(kind)}'`)
    const rows = await query.orderBy({ columnName: 'createdAt', ascending: false }).limit(limit).toArray()
    return {
      memories: rows.map(row => ({
        id: row.id,
        text: row.text,
        kind: row.kind,
        importance: Number(row.importance),
        createdAt: Number(row.createdAt),
        accessCount: Number(row.accessCount),
        lastAccessedAt: Number(row.lastAccessedAt),
        metadata: parseMetadata(row.metadata),
      })),
      total: await table.countRows(),
    }
  }

  /**
   * Table size, per-kind counts, index state, and the resolved location.
   * @returns Stats payload.
   */
  async stats() {
    const table = await this.#table()
    if (table === undefined) return { ...this.describe(), exists: false, rows: 0, kinds: [] }
    await this.#prepare(table)
    const rows = await table.countRows()
    const counts = new Map()
    const kinds = await table.query().select(['kind']).toArray()
    for (const row of kinds) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1)
    return {
      ...this.describe(),
      exists: true,
      rows,
      kinds: [...counts].map(([kind, count]) => ({ kind, count })).sort((left, right) => right.count - left.count),
      search: this.#settings.search,
    }
  }

  /** Drop the cached connection so unload does not keep the native handle. */
  close() {
    const connection = this.#connection
    this.#connection = undefined
    if (connection !== undefined) connection.then(db => db.close?.()).catch(() => {})
  }
}

/**
 * Fuse vector and BM25 results, then apply the lifecycle multiplier.
 *
 * Vector similarity is already 0-1 for normalized embeddings; BM25 is unbounded,
 * so it is divided by the strongest BM25 hit in this candidate pool. The two are
 * then combined with the configured weights. A row one modality missed scores 0
 * for that modality rather than dropping out, which is why a keyword-only hit
 * can still surface on a semantic query.
 *
 * @param {any[]} vectorRows - Cosine results with `_distance`.
 * @param {any[]} ftsRows - BM25 results with `_score`.
 * @param {ReturnType<typeof resolveSettings>['search']} settings - Ranking config.
 * @param {number} now - Current time.
 * @returns Scored candidates.
 */
function fuse(vectorRows, ftsRows, settings, now) {
  // A row found by both modalities is stored once, so scores live in side maps.
  const vectorRank = new Map(vectorRows.map((row, index) => [row.id, index]))
  const ftsRank = new Map(ftsRows.map((row, index) => [row.id, index]))
  const distance = new Map(vectorRows.map(row => [row.id, Number(row._distance)]))
  const bm25Score = new Map(ftsRows.map(row => [row.id, Number(row._score) || 0]))
  const rows = new Map()
  for (const row of vectorRows) rows.set(row.id, row)
  for (const row of ftsRows) if (!rows.has(row.id)) rows.set(row.id, row)

  const strongestBm25 = Math.max(0, ...bm25Score.values())
  const weightSum = settings.vectorWeight + settings.bm25Weight
  const scored = []
  for (const [id, row] of rows) {
    const vRank = vectorRank.get(id)
    const fRank = ftsRank.get(id)
    const similarity = vRank === undefined ? 0 : clamp01(1 - (distance.get(id) ?? 1))
    const bm25 = fRank === undefined || strongestBm25 === 0
      ? 0
      : clamp01((bm25Score.get(id) ?? 0) / strongestBm25)
    const fused = weightSum === 0
      ? 0
      : (settings.vectorWeight * similarity + settings.bm25Weight * bm25) / weightSum
    if (fused === 0) continue
    const ageDays = Math.max(0, now - Number(row.lastAccessedAt ?? row.createdAt ?? 0)) / DAY_MS
    const recency = 0.5 ** (ageDays / settings.recencyHalfLifeDays)
    const importance = clamp01((Number(row.importance ?? 5) - 1) / 9)
    const boost = 1
      + settings.recencyWeight * (recency - 0.5) * 2
      + settings.importanceWeight * (importance - 0.5) * 2
    const usedVector = vRank !== undefined && settings.vectorWeight > 0
    const usedFts = fRank !== undefined && settings.bm25Weight > 0
    scored.push({
      row,
      similarity: vRank === undefined ? undefined : similarity,
      match: usedVector && usedFts ? 'both' : usedVector ? 'vector' : 'bm25',
      score: fused * boost,
    })
  }
  return scored
}

/**
 * Shape one ranked row for the tool and service surface.
 * @param {{ row: any, similarity: number | undefined, match: string, score: number }} item - Ranked item.
 * @returns Result object.
 */
function toResult(item) {
  const row = item.row
  return {
    id: row.id,
    text: row.text,
    kind: row.kind,
    score: round(item.score),
    ...item.similarity === undefined ? {} : { similarity: round(item.similarity) },
    match: item.match,
    importance: Number(row.importance ?? 5),
    accessCount: Number(row.accessCount ?? 0),
    createdAt: Number(row.createdAt ?? 0),
    lastAccessedAt: Number(row.lastAccessedAt ?? row.createdAt ?? 0),
    metadata: parseMetadata(row.metadata),
  }
}

/**
 * Explain a failed read or write when the stored vector length disagrees with
 * the table.
 * @param {any} table - Open table.
 * @param {number} dimension - Vector length used for this call.
 * @param {unknown} error - Original failure.
 * @returns Error with dimension context when known.
 */
async function describeWriteFailure(table, dimension, error) {
  const stored = await storedDimension(table)
  const suffix = stored !== undefined && stored !== dimension
    ? `（vector 列的维度是 ${stored}，本次是 ${dimension}；换 embedding 配置后需要新建表或清空旧表）`
    : ''
  const message = error instanceof Error ? error.message : String(error)
  return new Error(`dsh-lancedb-memory: 写入或检索失败${suffix}: ${message}`)
}

/**
 * Read the fixed-size list length of the vector column.
 * @param {any} table - Open table.
 * @returns Dimension when it can be read.
 */
async function storedDimension(table) {
  try {
    const schema = await table.schema()
    const field = schema.fields.find(item => item.name === 'vector')
    const match = /\[(\d+)\]/u.exec(String(field?.type ?? ''))
    return match === null ? undefined : Number(match[1])
  } catch {
    return undefined
  }
}

/**
 * Normalize note or query text.
 * @param {unknown} value - Raw text.
 * @param {string} field - Field name for the error message.
 * @returns Trimmed text.
 */
function normalizeText(value, field = 'text') {
  if (typeof value !== 'string') throw new Error(`dsh-lancedb-memory: ${field} 必须是字符串`)
  const text = value.trim()
  if (text.length === 0) throw new Error(`dsh-lancedb-memory: ${field} 不能为空`)
  if (text.length > MAX_TEXT) throw new Error(`dsh-lancedb-memory: ${field} 最长 ${MAX_TEXT} 字符`)
  return text
}

/**
 * Normalize the optional kind label.
 * @param {unknown} value - Raw kind.
 * @returns Kind label.
 */
function normalizeKind(value) {
  if (value === undefined) return 'note'
  if (typeof value !== 'string') throw new Error('dsh-lancedb-memory: kind 必须是字符串')
  const kind = value.trim()
  if (kind.length === 0) throw new Error('dsh-lancedb-memory: kind 不能为空')
  if (kind.length > 64) throw new Error('dsh-lancedb-memory: kind 最长 64 字符')
  return kind
}

/**
 * Normalize the optional metadata object.
 * @param {unknown} value - Raw metadata.
 * @returns Plain JSON object.
 */
function normalizeMetadata(value) {
  if (value === undefined) return {}
  if (!isRecord(value)) throw new Error('dsh-lancedb-memory: metadata 必须是 JSON 对象')
  const text = JSON.stringify(value)
  if (text.length > MAX_METADATA) throw new Error(`dsh-lancedb-memory: metadata 序列化后最长 ${MAX_METADATA} 字节`)
  return value
}

/**
 * Normalize the 1-10 importance used by lifecycle ranking.
 * @param {unknown} value - Raw importance.
 * @returns Integer 1-10.
 */
function normalizeImportance(value) {
  if (value === undefined) return 5
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error('dsh-lancedb-memory: importance 必须是 1-10 的数')
  }
  const importance = Math.round(value)
  if (importance < 1 || importance > 10) {
    throw new Error(`dsh-lancedb-memory: importance 必须在 1-10 之间，收到 ${JSON.stringify(value)}`)
  }
  return importance
}

/**
 * Parse a metadata column back to an object, tolerating hand-written rows.
 * @param {unknown} value - Stored JSON string.
 * @returns Parsed object.
 */
function parseMetadata(value) {
  if (typeof value !== 'string' || value.length === 0) return {}
  try {
    const parsed = JSON.parse(value)
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Quote a value for a LanceDB SQL predicate.
 * @param {string} value - Raw string.
 * @returns Escaped literal contents.
 */
function escapeSql(value) {
  return value.replace(/\\/gu, '\\\\').replace(/'/gu, "''")
}

/**
 * Clamp to the 0-1 range.
 * @param {number} value - Raw number.
 * @returns Clamped number.
 */
function clamp01(value) {
  return Math.min(1, Math.max(0, value))
}

/**
 * Round to four decimals for stable output.
 * @param {number} value - Raw number.
 * @returns Rounded number.
 */
function round(value) {
  return Math.round(value * 10000) / 10000
}

/**
 * Check for a non-null, non-array object.
 * @param {unknown} value - Candidate.
 * @returns Whether it is a plain record.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Render a tool value as one JSON text block.
 * @param {unknown} value - Tool result.
 * @returns Content blocks.
 */
function jsonContent(value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
}

/**
 * Build one model-facing tool definition.
 * @param {{ name: string, description: string, parameters: Record<string, unknown>, execute: Function }} spec - Tool spec.
 * @returns Tool definition.
 */
function tool(spec) {
  return {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    timeoutMs: 30_000,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => jsonContent(value),
    },
    execute: spec.execute,
  }
}

/**
 * Register the service and tools. Storage is opened lazily on the first call so
 * activation stays cheap and never blocks on the native module.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {unknown} config - Row config.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const store = new MemoryStore(settings)

  ctx.effect(() => ctx.provide('lancedb', {
    describe: () => store.describe(),
    store: input => store.store(input),
    search: input => store.search(input),
    forget: id => store.forget(id),
    list: input => store.list(input),
    stats: () => store.stats(),
  }))
  ctx.effect(() => () => store.close())

  const tools = [
    tool({
      name: 'lancedb_store',
      description: '把一条笔记写入记忆库并返回 id。适合记住事实、决定、代码位置或用户偏好；'
        + '同样的 kind 和文本重复写入不会产生重复行，语义上高度相近的笔记也会归到已有那条。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要记住的文字，最多 20000 字符' },
          kind: {
            type: 'string',
            description: '分类标签，默认 note；检索时可用它过滤，例如 decision、preference、snippet',
          },
          metadata: {
            type: 'object',
            additionalProperties: true,
            description: '附加信息，原样保存，例如 { "source": "src/a.ts", "line": 42 }',
          },
          importance: {
            type: 'number',
            description: '重要度 1-10，默认 5；重要度高的笔记排序略靠前，衰减也更慢',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: input => store.store(input),
    }),
    tool({
      name: 'lancedb_search',
      description: '按相似度检索记忆库：向量检索和 BM25 全文检索融合排序，返回最相关的笔记。'
        + 'score 越大越相关，match 说明命中方式。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要检索的内容' },
          limit: { type: 'number', description: '返回条数，1-50，省略时用默认值' },
          kind: { type: 'string', description: '只在这类笔记里检索' },
          minScore: { type: 'number', description: '最低分 0-1，省略时用插件配置；过滤掉明显不相关的结果' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: input => store.search(input),
    }),
    tool({
      name: 'lancedb_list',
      description: '按写入时间倒序列出记忆，可按 kind 过滤，用来查看记忆库里到底有什么。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回条数，1-100，默认 20' },
          kind: { type: 'string', description: '只看这类笔记' },
        },
        additionalProperties: false,
      },
      execute: input => store.list(input),
    }),
    tool({
      name: 'lancedb_forget',
      description: '按 id 删除一条记忆。只删除你确认已过时或错误的内容。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'lancedb_store 返回的 id' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      execute: input => store.forget(input.id),
    }),
    tool({
      name: 'lancedb_stats',
      description: '查看记忆库状态：存储目录、表名、行数、各 kind 数量、向量维度、检索模式（hybrid/vector）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: () => store.stats(),
    }),
  ]

  for (const definition of tools) {
    ctx.effect(() => ctx.tools.register(definition))
  }
}
