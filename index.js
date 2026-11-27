/**
 * Embedded LanceDB memory with souls.
 *
 * Storage is one local LanceDB table. Every row carries a `scope`:
 *
 *   session:<id>   the working memory of one conversation, isolated by default
 *   soul:<name>    a curated, reusable memory domain the user promotes into
 *
 * A session recalls its own notes plus the souls it attached. Nothing crosses
 * that boundary unless `lancedb_promote` copies a note into a soul.
 *
 * Retrieval is hybrid: cosine vector search plus BM25 full-text search (ICU
 * tokenizer, so Chinese is segmented by dictionary), weighted by the configured
 * vector/BM25 balance, then nudged by recency and importance. Recalled rows are
 * reinforced with an access counter.
 *
 * Vectors come from a deterministic local hash embedder by default, so the
 * plugin works offline and with Chinese text (character bigrams). Setting
 * `embedding.provider: http` points it at an OpenAI-compatible `/embeddings`
 * endpoint instead, and the dimension is taken from the first response.
 *
 * @module dsh-lancedb-memory
 */

import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { connect, Index } from '@lancedb/lancedb'

/** Cordis plugin name. */
export const name = 'dsh-lancedb-memory'

/** Registers agent tools; the tools service must be present first. */
export const inject = ['tools']

const ID_PATTERN = /^[0-9a-f]{32}$/u
const TABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
const SOUL_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/gu
const WORD = /[a-z0-9][a-z0-9_'-]*/gu

const SESSION_PREFIX = 'session:'
const SOUL_PREFIX = 'soul:'
/** Soul that receives rows written by v0.2, which had no scope at all. */
const IMPORTED_SOUL = 'imported'

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
/** One promote call stays small enough to report item by item. */
const MAX_PROMOTE_IDS = 50

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

  const sessionTtlDays = config.sessionTtlDays ?? 0
  if (typeof sessionTtlDays !== 'number' || !Number.isFinite(sessionTtlDays) || sessionTtlDays < 0) {
    throw new Error(`dsh-lancedb-memory: sessionTtlDays 必须是非负数，收到 ${JSON.stringify(sessionTtlDays)}`)
  }

  const directory = typeof config.directory === 'string' && config.directory.length > 0
    ? resolve(config.directory)
    : join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'lancedb')

  return {
    table,
    topK,
    directory,
    sessionTtlDays,
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
 * A tiny JSON file with atomic writes, used for the soul registry and the
 * session attachments.
 */
class JsonStore {
  #file
  #data
  #loading
  #writing = Promise.resolve()

  /** @param {string} file - Absolute path. */
  constructor(file) {
    this.#file = file
  }

  /**
   * Read the current value, defaulting to an empty object.
   * @returns Parsed object.
   */
  async read() {
    if (this.#data !== undefined) return this.#data
    this.#loading ??= (async () => {
      try {
        const parsed = JSON.parse(await readFile(this.#file, 'utf8'))
        this.#data = isRecord(parsed) ? parsed : {}
      } catch {
        this.#data = {}
      }
      return this.#data
    })()
    return this.#loading
  }

  /**
   * Replace the whole file, serialized with other writes.
   * @param {(current: Record<string, any>) => Record<string, any>} mutate - Pure update.
   * @returns The stored value.
   */
  async update(mutate) {
    const run = this.#writing.then(async () => {
      const current = await this.read()
      const next = mutate(current)
      await mkdir(dirname(this.#file), { recursive: true })
      const temporary = `${this.#file}.${process.pid}.tmp`
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await rename(temporary, this.#file)
      this.#data = next
      return next
    })
    this.#writing = run.then(() => undefined, () => undefined)
    return run
  }
}

/**
 * The LanceDB table, the soul registry, and the session attachments.
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
  #soulsFile
  #sessionsFile

  /** @param {ReturnType<typeof resolveSettings>} settings - Resolved config. */
  constructor(settings) {
    this.#settings = settings
    this.#embedder = createEmbedder(settings.embedding)
    this.#soulsFile = new JsonStore(join(settings.directory, 'souls.json'))
    this.#sessionsFile = new JsonStore(join(settings.directory, 'sessions.json'))
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
   * Add the scope column to a v0.2 table (its rows become the `imported` soul),
   * plus the lifecycle columns. Concurrent callers share one migration.
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
      if (!names.has('scope')) added.push({ name: 'scope', valueSql: `'${soulScope(IMPORTED_SOUL)}'` })
      if (added.length > 0) await table.addColumns(added)
      this.#migrated = true
      if (added.some(column => column.name === 'scope')) {
        const imported = await table.countRows(`scope = '${escapeSql(soulScope(IMPORTED_SOUL))}'`)
        if (imported > 0) {
          await this.#writeSoul(IMPORTED_SOUL, {
            description: '从 v0.2 全局记忆迁移过来的内容',
            keepUpdatedAt: true,
          })
        }
      }
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
   * Prepare an existing table for reads and writes.
   * @param {any} table - Open table.
   */
  async #prepare(table) {
    await this.#migrate(table)
    await this.#ensureFts(table)
  }

  /**
   * Read the soul registry.
   * @returns Soul map keyed by name.
   */
  async #souls() {
    return this.#soulsFile.read()
  }

  /**
   * Create or update one soul entry.
   * @param {string} name - Validated soul name.
   * @param {{ description: string, keepUpdatedAt?: boolean }} entry - Registry fields.
   */
  async #writeSoul(name, entry) {
    const now = Date.now()
    await this.#soulsFile.update(current => ({
      ...current,
      [name]: {
        description: entry.description,
        createdAt: current[name]?.createdAt ?? now,
        lastUpdatedAt: entry.keepUpdatedAt === true ? current[name]?.lastUpdatedAt ?? now : now,
      },
    }))
  }

  /**
   * Bump a soul's last activity timestamp.
   * @param {string} name - Soul name.
   */
  async #touchSoul(name) {
    const souls = await this.#souls()
    const entry = souls[name]
    if (entry === undefined) return
    await this.#soulsFile.update(current => ({
      ...current,
      [name]: { ...entry, lastUpdatedAt: Date.now() },
    }))
  }

  /**
   * Reject unknown souls before they reach storage.
   * @param {string} name - Soul name.
   */
  async #requireSoul(name) {
    const souls = await this.#souls()
    if (souls[name] === undefined) {
      throw new Error(`dsh-lancedb-memory: soul "${name}" 不存在，先用 lancedb_souls 建一个`)
    }
  }

  /**
   * Create a soul.
   * @param {{ name: unknown, description: unknown }} input - Request.
   * @returns The created soul entry.
   */
  async createSoul(input) {
    const name = normalizeSoulName(input.name)
    if (typeof input.description !== 'string' || input.description.trim().length === 0) {
      throw new Error('dsh-lancedb-memory: 新建 soul 要写 description，说明它适合记什么')
    }
    const description = input.description.trim().slice(0, 200)
    return this.#serial(async () => {
      const souls = await this.#souls()
      if (souls[name] !== undefined) throw new Error(`dsh-lancedb-memory: soul "${name}" 已存在`)
      await this.#writeSoul(name, { description })
      return { soul: name, description, createdAt: Date.now() }
    })
  }

  /**
   * Delete a soul, its rows, and every attachment to it.
   * @param {{ name: unknown, force: unknown }} input - Request.
   * @returns Rows removed and sessions detached.
   */
  async deleteSoul(input) {
    const name = normalizeSoulName(input.name)
    if (input.force !== true) {
      throw new Error('dsh-lancedb-memory: 删 soul 会连它记住的内容一起删，确认后传 force: true')
    }
    return this.#serial(async () => {
      const souls = await this.#souls()
      if (souls[name] === undefined) throw new Error(`dsh-lancedb-memory: soul "${name}" 不存在`)
      const table = await this.#table()
      let deletedRows = 0
      if (table !== undefined) {
        await this.#prepare(table)
        const before = await table.countRows(`scope = '${escapeSql(soulScope(name))}'`)
        if (before > 0) await table.delete(`scope = '${escapeSql(soulScope(name))}'`)
        deletedRows = before
      }
      await this.#soulsFile.update(current => {
        const next = { ...current }
        delete next[name]
        return next
      })
      let detached = 0
      await this.#sessionsFile.update(current => {
        const next = {}
        for (const [session, entry] of Object.entries(current)) {
          const previous = Array.isArray(entry?.souls) ? entry.souls : []
          const kept = previous.filter(item => item !== name)
          if (kept.length !== previous.length) detached += 1
          if (kept.length > 0) next[session] = { ...entry, souls: kept }
        }
        return next
      })
      return { soul: name, deletedRows, detachedSessions: detached }
    })
  }

  /**
   * Copy every note of one soul into a new soul, leaving the source intact.
   * @param {{ from: unknown, to: unknown, description?: unknown }} input - Request.
   * @returns Copy summary.
   */
  async copySoul(input) {
    const from = normalizeSoulName(input.from)
    const to = normalizeSoulName(input.to)
    if (from === to) throw new Error('dsh-lancedb-memory: 不能把 soul 复制到它自己')
    await this.#requireSoul(from)
    if ((await this.#souls())[to] !== undefined) throw new Error(`dsh-lancedb-memory: soul "${to}" 已存在`)
    const description = typeof input.description === 'string' && input.description.trim().length > 0
      ? input.description.trim().slice(0, 200)
      : `复制自 ${from}`
    const target = soulScope(to)

    return this.#serial(async () => {
      const table = await this.#table()
      let copied = 0
      if (table !== undefined) {
        await this.#prepare(table)
        const rows = await table.query().where(`scope = '${escapeSql(soulScope(from))}'`).toArray()
        const now = Date.now()
        for (const row of rows) {
          await table.add([{
            id: hashId(target, row.kind, row.text),
            text: row.text,
            kind: row.kind,
            metadata: row.metadata,
            vector: Array.from(row.vector),
            createdAt: Number(row.createdAt),
            importance: Number(row.importance ?? 5),
            accessCount: 0,
            lastAccessedAt: now,
            updatedAt: now,
            scope: target,
          }])
          copied += 1
        }
      }
      await this.#writeSoul(to, { description })
      return { from, to, copied }
    })
  }

  /**
   * Rename a soul: move its notes under the new scope, keep the description and
   * creation time, and update every session attachment that named the old name.
   * @param {{ from: unknown, to: unknown }} input - Request.
   * @returns Move summary.
   */
  async renameSoul(input) {
    const from = normalizeSoulName(input.from)
    const to = normalizeSoulName(input.to)
    if (from === to) throw new Error('dsh-lancedb-memory: 新名字和原来一样')
    await this.#requireSoul(from)
    const souls = await this.#souls()
    if (souls[to] !== undefined) throw new Error(`dsh-lancedb-memory: soul "${to}" 已存在`)
    const entry = souls[from]
    const target = soulScope(to)

    return this.#serial(async () => {
      const table = await this.#table()
      let moved = 0
      if (table !== undefined) {
        await this.#prepare(table)
        const rows = await table.query().where(`scope = '${escapeSql(soulScope(from))}'`).toArray()
        const now = Date.now()
        for (const row of rows) {
          await table.add([{
            id: hashId(target, row.kind, row.text),
            text: row.text,
            kind: row.kind,
            metadata: row.metadata,
            vector: Array.from(row.vector),
            createdAt: Number(row.createdAt),
            importance: Number(row.importance ?? 5),
            accessCount: Number(row.accessCount ?? 0),
            lastAccessedAt: Number(row.lastAccessedAt ?? row.createdAt ?? now),
            updatedAt: now,
            scope: target,
          }])
          moved += 1
        }
        if (rows.length > 0) await table.delete(`scope = '${escapeSql(soulScope(from))}'`)
      }
      await this.#soulsFile.update(current => {
        const next = { ...current }
        delete next[from]
        next[to] = { description: entry.description, createdAt: entry.createdAt, lastUpdatedAt: Date.now() }
        return next
      })
      await this.#sessionsFile.update(current => {
        const next = {}
        for (const [session, value] of Object.entries(current)) {
          const names = Array.isArray(value?.souls) ? value.souls.map(name => name === from ? to : name) : []
          if (names.length > 0) next[session] = { ...value, souls: [...new Set(names)] }
        }
        return next
      })
      return { from, to, moved }
    })
  }

  /**
   * Merge several souls into one target, keeping every source as it was. Notes
   * that already exist in the target (same kind and text) are skipped.
   * @param {{ sources: unknown, target: unknown, description?: unknown }} input - Request.
   * @returns Merge summary.
   */
  async mergeSouls(input) {
    if (!Array.isArray(input.sources) || input.sources.length === 0) {
      throw new Error('dsh-lancedb-memory: sources 至少给一个 soul')
    }
    const sources = [...new Set(input.sources.map(normalizeSoulName))]
    const target = normalizeSoulName(input.target)
    if (sources.includes(target)) throw new Error('dsh-lancedb-memory: 目标 soul 不能同时是来源')
    for (const name of sources) await this.#requireSoul(name)
    const existing = await this.#souls()
    const description = typeof input.description === 'string' && input.description.trim().length > 0
      ? input.description.trim().slice(0, 200)
      : `合并自 ${sources.join('、')}`
    if (existing[target] === undefined) {
      await this.#writeSoul(target, { description })
    }
    const targetScope = soulScope(target)

    return this.#serial(async () => {
      const table = await this.#table()
      const copied = []
      const skipped = []
      if (table !== undefined) {
        await this.#prepare(table)
        const byId = new Map()
        for (const name of sources) {
          const rows = await table.query().where(`scope = '${escapeSql(soulScope(name))}'`).toArray()
          for (const row of rows) {
            const id = hashId(targetScope, row.kind, row.text)
            if (byId.has(id)) {
              skipped.push({ from: name, text: row.text, reason: 'duplicate' })
              continue
            }
            byId.set(id, { row, from: name })
          }
        }
        const existingRows = await table.query().where(`scope = '${escapeSql(targetScope)}'`).select(['id']).toArray()
        const present = new Set(existingRows.map(row => row.id))
        const now = Date.now()
        for (const [id, entry] of byId) {
          if (present.has(id)) {
            skipped.push({ from: entry.from, text: entry.row.text, reason: 'already-in-target' })
            continue
          }
          await table.add([{
            id,
            text: entry.row.text,
            kind: entry.row.kind,
            metadata: entry.row.metadata,
            vector: Array.from(entry.row.vector),
            createdAt: Number(entry.row.createdAt),
            importance: Number(entry.row.importance ?? 5),
            accessCount: 0,
            lastAccessedAt: now,
            updatedAt: now,
            scope: targetScope,
          }])
          copied.push({ from: entry.from, id })
        }
      }
      if (copied.length > 0) await this.#touchSoul(target)
      return { target, sources, copied: copied.length, skipped: skipped.length }
    })
  }

  /**
   * List souls with row counts and the caller's attachments.
   * @param {string | undefined} sessionScopeValue - Caller scope, for the attached flag.
   * @returns Soul catalog.
   */
  async soulCatalog(sessionScopeValue) {
    const souls = await this.#souls()
    const attached = sessionScopeValue === undefined ? [] : await this.attachedSouls(sessionScopeValue)
    const counts = new Map()
    const table = await this.#table()
    if (table !== undefined) {
      await this.#prepare(table)
      const rows = await table.query().select(['scope']).toArray()
      for (const row of rows) {
        const name = soulNameOf(row.scope)
        if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1)
      }
    }
    return {
      souls: Object.entries(souls)
        .map(([entryName, entry]) => ({
          name: entryName,
          description: entry.description,
          notes: counts.get(entryName) ?? 0,
          attached: attached.includes(entryName),
          createdAt: Number(entry.createdAt),
          lastUpdatedAt: Number(entry.lastUpdatedAt),
        }))
        .sort((left, right) => right.lastUpdatedAt - left.lastUpdatedAt),
      attached,
    }
  }

  /**
   * Read the souls attached to one session.
   * @param {string} sessionScopeValue - `session:<id>`.
   * @returns Attached soul names.
   */
  async attachedSouls(sessionScopeValue) {
    const id = sessionIdOf(sessionScopeValue)
    if (id === undefined) return []
    const sessions = await this.#sessionsFile.read()
    return Array.isArray(sessions[id]?.souls) ? sessions[id].souls : []
  }

  /**
   * Attach or detach souls for one session.
   * @param {string} sessionScopeValue - `session:<id>`.
   * @param {{ souls: unknown, detach?: unknown }} input - Request.
   * @returns The resulting attachment list.
   */
  async attach(sessionScopeValue, input) {
    const id = sessionIdOf(sessionScopeValue)
    if (id === undefined) throw new Error('dsh-lancedb-memory: 只能在会话里挂载 soul')
    const names = Array.isArray(input.souls) ? input.souls.map(normalizeSoulName) : []
    const detach = input.detach === true
    return this.#serial(async () => {
      const souls = await this.#souls()
      for (const name of names) {
        if (souls[name] === undefined) throw new Error(`dsh-lancedb-memory: soul "${name}" 不存在`)
      }
      const next = await this.#sessionsFile.update(current => {
        const previous = Array.isArray(current[id]?.souls) ? current[id].souls : []
        const merged = detach
          ? previous.filter(item => !names.includes(item))
          : [...new Set([...previous, ...names])]
        const next = { ...current }
        if (merged.length === 0) delete next[id]
        else next[id] = { souls: merged, updatedAt: Date.now() }
        return next
      })
      return { attached: next[id]?.souls ?? [] }
    })
  }

  /**
   * Store one note in a scope. Same scope + kind + text hashes to one id, and a
   * note already present at `dedupe.threshold` similarity returns the old row.
   * @param {string} scope - `session:<id>` or `soul:<name>`.
   * @param {{ text: string, kind?: string, metadata?: Record<string, unknown>, importance?: number }} input - Note to store.
   * @returns Stored id, row count, and whether a new row was written.
   */
  async store(scope, input) {
    const text = normalizeText(input.text)
    const kind = normalizeKind(input.kind)
    const metadata = normalizeMetadata(input.metadata)
    const importance = normalizeImportance(input.importance)
    const soul = soulNameOf(scope)
    if (soul !== undefined) await this.#requireSoul(soul)
    const id = hashId(scope, kind, text)
    const createdAt = Date.now()

    return this.#serial(async () => {
      const vector = await this.#embedder.embed(text)
      this.#embedder.dimension = vector.length
      const table = await this.#table()

      if (table === undefined) {
        const db = await this.#db()
        const created = await db.createTable(this.#settings.table, [{
          id, text, kind, metadata: JSON.stringify(metadata), vector, createdAt, importance,
          accessCount: 0, lastAccessedAt: createdAt, updatedAt: createdAt, scope,
        }])
        this.#migrated = true
        await this.#ensureFts(created)
        if (soul !== undefined) await this.#touchSoul(soul)
        return { id, scope, kind, created: true, total: await created.countRows(), dimension: vector.length }
      }

      await this.#prepare(table)
      const found = await table.query().where(`id = '${id}'`).limit(1).toArray()
      if (found.length > 0) {
        return { id, scope, kind, created: false, total: await table.countRows(), dimension: vector.length }
      }

      if (this.#settings.dedupe.enabled) {
        const near = await table.search(vector).limit(1).distanceType('cosine')
          .where(`${scopePredicate([scope])} AND kind = '${escapeSql(kind)}'`).toArray()
          .catch(() => [])
        const similarity = near.length === 0 ? -1 : 1 - near[0]._distance
        if (similarity >= this.#settings.dedupe.threshold) {
          return {
            id: near[0].id, scope, kind, created: false, duplicate: true,
            similarity: round(similarity), total: await table.countRows(), dimension: vector.length,
          }
        }
      }

      try {
        await table.add([{
          id, text, kind, metadata: JSON.stringify(metadata), vector, createdAt, importance,
          accessCount: 0, lastAccessedAt: createdAt, updatedAt: createdAt, scope,
        }])
      } catch (error) {
        throw await describeWriteFailure(table, vector.length, error)
      }
      if (soul !== undefined) await this.#touchSoul(soul)
      return { id, scope, kind, created: true, total: await table.countRows(), dimension: vector.length }
    })
  }

  /**
   * Hybrid search over a set of scopes.
   * @param {string[]} scopes - Session scope plus attached souls.
   * @param {{ query: string, kind?: string, limit?: number, minScore?: number }} input - Search request.
   * @returns Ranked matches.
   */
  async search(scopes, input) {
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
    if (table === undefined) return { results: [], total: 0, scopes, retrieval: 'empty' }
    await this.#prepare(table)

    const predicate = this.#predicate(scopes, kind)
    const vector = await this.#embedder.embed(text)
    this.#embedder.dimension = vector.length
    const total = await table.countRows(predicate)
    const pool = Math.max(limit * 4, MIN_POOL)

    let vectorRows = []
    try {
      vectorRows = await table.search(vector).limit(pool).distanceType('cosine').where(predicate).toArray()
    } catch (error) {
      throw await describeWriteFailure(table, vector.length, error)
    }

    let ftsRows = []
    if (this.#ftsReady) {
      try {
        ftsRows = await table.search(text, 'fts', ['text']).limit(pool).where(predicate).toArray()
      } catch {
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
      scopes,
      retrieval: this.#ftsReady ? 'hybrid' : 'vector',
    }
  }

  /**
   * Copy selected session notes into a soul.
   * @param {string} sessionScopeValue - Source session scope.
   * @param {{ ids: unknown, soul: unknown, move?: unknown }} input - Request.
   * @returns Per-id outcome.
   */
  async promote(sessionScopeValue, input) {
    const soul = normalizeSoulName(input.soul)
    const ids = Array.isArray(input.ids) ? input.ids : []
    if (ids.length === 0 || ids.length > MAX_PROMOTE_IDS) {
      throw new Error(`dsh-lancedb-memory: ids 需要 1-${MAX_PROMOTE_IDS} 个`)
    }
    for (const id of ids) {
      if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
        throw new Error(`dsh-lancedb-memory: id 必须是 32 位十六进制，收到 ${JSON.stringify(id)}`)
      }
    }
    await this.#requireSoul(soul)
    const target = soulScope(soul)
    const move = input.move === true

    return this.#serial(async () => {
      const table = await this.#table()
      if (table === undefined) throw new Error('dsh-lancedb-memory: 记忆库还是空的，没有可 promote 的内容')
      await this.#prepare(table)
      const rows = await table.query().where(`id IN (${ids.map(id => `'${id}'`).join(', ')})`).toArray()
      const byId = new Map(rows.map(row => [row.id, row]))
      const copied = []
      const skipped = []
      const now = Date.now()

      for (const id of ids) {
        const row = byId.get(id)
        if (row === undefined || row.scope !== sessionScopeValue) {
          skipped.push({ id, reason: 'not-in-session' })
          continue
        }
        const nextId = hashId(target, row.kind, row.text)
        const exact = await table.query().where(`id = '${nextId}'`).limit(1).toArray()
        if (exact.length > 0) {
          skipped.push({ id, reason: 'already-in-soul' })
          continue
        }
        if (this.#settings.dedupe.enabled) {
          const near = await table.search(Array.from(row.vector)).limit(1).distanceType('cosine')
            .where(`${scopePredicate([target])} AND kind = '${escapeSql(row.kind)}'`).toArray()
            .catch(() => [])
          const similarity = near.length === 0 ? -1 : 1 - near[0]._distance
          if (similarity >= this.#settings.dedupe.threshold) {
            skipped.push({ id, reason: 'duplicate', similarity: round(similarity) })
            continue
          }
        }
        await table.add([{
          id: nextId,
          text: row.text,
          kind: row.kind,
          metadata: row.metadata,
          vector: Array.from(row.vector),
          createdAt: Number(row.createdAt),
          importance: Number(row.importance ?? 5),
          accessCount: 0,
          lastAccessedAt: now,
          updatedAt: now,
          scope: target,
        }])
        copied.push({ id, newId: nextId, text: row.text })
        if (move) await table.delete(`id = '${id}'`)
      }

      if (copied.length > 0) await this.#touchSoul(soul)
      return { soul, copied, skipped, moved: move }
    })
  }

  /**
   * Delete one note, but only from the caller's session or an explicitly named
   * soul.
   * @param {string} sessionScopeValue - Caller session scope.
   * @param {{ id: unknown, soul?: unknown }} input - Request.
   * @returns Whether a row was removed.
   */
  async forget(sessionScopeValue, input) {
    const id = input.id
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new Error('dsh-lancedb-memory: id 必须是 lancedb_store 返回的 32 位十六进制字符串')
    }
    const soul = input.soul === undefined ? undefined : normalizeSoulName(input.soul)
    return this.#serial(async () => {
      const table = await this.#table()
      if (table === undefined) return { id, deleted: false, total: 0 }
      const rows = await table.query().where(`id = '${id}'`).limit(1).toArray()
      const row = rows[0]
      if (row === undefined) return { id, deleted: false, total: await table.countRows() }
      const allowed = row.scope === sessionScopeValue
        || (soul !== undefined && row.scope === soulScope(soul))
      if (!allowed) {
        throw new Error('dsh-lancedb-memory: 只能删当前会话里的记忆；删 soul 里的要显式传 soul')
      }
      await table.delete(`id = '${id}'`)
      return { id, deleted: true, total: await table.countRows() }
    })
  }

  /**
   * Delete one note from a soul on behalf of the browser picker. The caller is
   * already the owner Peer, so naming the soul is the whole authorization.
   * @param {string} soul - Soul name.
   * @param {string} id - Note id.
   * @returns Whether a row was removed.
   */
  async deleteInSoul(soul, id) {
    if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
      throw new Error('dsh-lancedb-memory: id 必须是 32 位十六进制字符串')
    }
    const scope = soulScope(soul)
    return this.#serial(async () => {
      const table = await this.#table()
      if (table === undefined) return { id, deleted: false, total: 0 }
      await this.#prepare(table)
      const rows = await table.query().where(`id = '${id}'`).limit(1).toArray()
      if (rows[0] === undefined || rows[0].scope !== scope) {
        return { id, deleted: false, total: await table.countRows() }
      }
      await table.delete(`id = '${id}'`)
      return { id, deleted: true, total: await table.countRows() }
    })
  }

  /**
   * Browse notes newest first inside one scope.
   * @param {string} scope - Session or soul scope.
   * @param {{ kind?: string, limit?: number }} input - Listing request.
   * @returns Notes without vectors.
   */
  async list(scope, input) {
    const kind = input.kind === undefined ? undefined : normalizeKind(input.kind)
    const limit = input.limit ?? 20
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error(`dsh-lancedb-memory: limit 必须是 1-100 的整数，收到 ${JSON.stringify(limit)}`)
    }
    const table = await this.#table()
    if (table === undefined) return { scope, memories: [], total: 0 }
    await this.#prepare(table)
    const predicate = this.#predicate([scope], kind)
    const rows = await table.query()
      .select(['id', 'text', 'kind', 'metadata', 'importance', 'createdAt', 'accessCount', 'lastAccessedAt'])
      .where(predicate)
      .orderBy({ columnName: 'createdAt', ascending: false })
      .limit(limit)
      .toArray()
    return {
      scope,
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
      total: await table.countRows(predicate),
    }
  }

  /**
   * Table size, scope breakdown, and the resolved location.
   * @param {string | undefined} sessionScopeValue - Caller session, for counts and TTL.
   * @returns Stats payload.
   */
  async stats(sessionScopeValue) {
    const table = await this.#table()
    if (table === undefined) {
      return {
        ...this.describe(), exists: false, rows: 0, kinds: [],
        scopes: { session: 0, sessions: 0, souls: [] },
      }
    }
    await this.#prepare(table)
    let purged = 0
    if (this.#settings.sessionTtlDays > 0 && sessionScopeValue !== undefined) {
      const cutoff = Date.now() - this.#settings.sessionTtlDays * DAY_MS
      try {
        const stale = `scope LIKE '${SESSION_PREFIX}%' AND lastAccessedAt < ${cutoff} AND scope != '${escapeSql(sessionScopeValue)}'`
        const before = await table.countRows(stale)
        if (before > 0) await table.delete(stale)
        purged = before
      } catch {
        purged = -1
      }
    }

    const rows = await table.countRows()
    const kinds = new Map()
    const scopes = new Map()
    const all = await table.query().select(['scope', 'kind']).toArray()
    for (const row of all) {
      kinds.set(row.kind, (kinds.get(row.kind) ?? 0) + 1)
      scopes.set(row.scope, (scopes.get(row.scope) ?? 0) + 1)
    }
    const souls = Object.entries(await this.#souls())
      .map(([entryName, entry]) => ({
        name: entryName,
        description: entry.description,
        notes: scopes.get(soulScope(entryName)) ?? 0,
      }))
      .sort((left, right) => right.notes - left.notes)
    const sessionScopes = [...scopes.keys()].filter(scope => scope.startsWith(SESSION_PREFIX))
    return {
      ...this.describe(),
      exists: true,
      rows,
      kinds: [...kinds].map(([kind, count]) => ({ kind, count })).sort((left, right) => right.count - left.count),
      scopes: {
        session: sessionScopeValue === undefined ? 0 : scopes.get(sessionScopeValue) ?? 0,
        sessions: sessionScopes.length,
        souls,
      },
      ...purged === 0 ? {} : { purgedSessions: purged },
      search: this.#settings.search,
    }
  }

  /**
   * Build the SQL predicate for a set of scopes and an optional kind.
   * @param {string[]} scopes - Scopes to include.
   * @param {string | undefined} kind - Optional kind filter.
   * @returns SQL predicate.
   */
  #predicate(scopes, kind) {
    const list = scopes.map(scope => `'${escapeSql(scope)}'`).join(', ')
    return kind === undefined
      ? `scope IN (${list})`
      : `scope IN (${list}) AND kind = '${escapeSql(kind)}'`
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
 * so it is divided by the strongest BM25 hit in this candidate pool.
 *
 * @param {any[]} vectorRows - Cosine results with `_distance`.
 * @param {any[]} ftsRows - BM25 results with `_score`.
 * @param {ReturnType<typeof resolveSettings>['search']} settings - Ranking config.
 * @param {number} now - Current time.
 * @returns Scored candidates.
 */
function fuse(vectorRows, ftsRows, settings, now) {
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
    scope: row.scope,
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
 * Normalize a soul name.
 * @param {unknown} value - Raw name.
 * @returns Valid soul name.
 */
function normalizeSoulName(value) {
  if (typeof value !== 'string' || !SOUL_PATTERN.test(value)) {
    throw new Error(`dsh-lancedb-memory: soul 名只能用小写字母、数字、_ 和 -，最长 32，收到 ${JSON.stringify(value)}`)
  }
  return value
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
 * Stable id for a note inside one scope.
 * @param {string} scope - Target scope.
 * @param {string} kind - Kind label.
 * @param {string} text - Note text.
 * @returns 32 hex characters.
 */
function hashId(scope, kind, text) {
  return createHash('sha256').update(`${scope}\u0000${kind}\u0000${text}`).digest('hex').slice(0, 32)
}

/**
 * Build the SQL predicate for a set of scopes and an optional kind.
 * @param {string[]} scopes - Scopes to include.
 * @param {string | undefined} kind - Optional kind filter.
 * @returns SQL predicate.
 */
function scopePredicate(scopes, kind) {
  const list = scopes.map(scope => `'${escapeSql(scope)}'`).join(', ')
  return kind === undefined
    ? `scope IN (${list})`
    : `scope IN (${list}) AND kind = '${escapeSql(kind)}'`
}

/** @param {string} nameValue - Soul name. */
function soulScope(nameValue) {
  return `${SOUL_PREFIX}${nameValue}`
}

/** @param {string} session - Session id. */
function sessionScope(session) {
  return `${SESSION_PREFIX}${session}`
}

/**
 * Extract a soul name from a scope string.
 * @param {unknown} scope - Scope value.
 * @returns Soul name when the scope is a soul.
 */
function soulNameOf(scope) {
  return typeof scope === 'string' && scope.startsWith(SOUL_PREFIX)
    ? scope.slice(SOUL_PREFIX.length)
    : undefined
}

/**
 * Extract a session id from a scope string.
 * @param {unknown} scope - Scope value.
 * @returns Session id when the scope is a session.
 */
function sessionIdOf(scope) {
  return typeof scope === 'string' && scope.startsWith(SESSION_PREFIX)
    ? scope.slice(SESSION_PREFIX.length)
    : undefined
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
 * Human-readable message for a rejected browser request.
 * @param {unknown} error - Thrown value.
 * @returns Message.
 */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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
 * Resolve the calling session's scope from a tool execution.
 * @param {{ agent?: { id?: unknown } }} exec - Tool run context.
 * @returns Session scope.
 */
function scopeOfExecution(exec) {
  const id = exec?.agent?.id
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('dsh-lancedb-memory: 这个工具只能在会话里调用')
  }
  return sessionScope(id)
}

/**
 * Register the service and tools.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Plugin context.
 * @param {unknown} config - Row config.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config)
  const store = new MemoryStore(settings)

  ctx.effect(() => ctx.provide('lancedb', {
    describe: () => store.describe(),
    store: (scope, input) => store.store(scope, input),
    search: (scopes, input) => store.search(scopes, input),
    list: (scope, input) => store.list(scope, input),
    promote: (sessionScopeValue, input) => store.promote(sessionScopeValue, input),
    forget: (sessionScopeValue, input) => store.forget(sessionScopeValue, input),
    souls: sessionScopeValue => store.soulCatalog(sessionScopeValue),
    createSoul: input => store.createSoul(input),
    deleteSoul: input => store.deleteSoul(input),
    attach: (sessionScopeValue, input) => store.attach(sessionScopeValue, input),
    stats: sessionScopeValue => store.stats(sessionScopeValue),
  }))
  ctx.effect(() => () => store.close())

  // Browser surface: the composer's soul strip lists souls and toggles the
  // current session's attachments. Routed through the authenticated /api
  // carrier, so only the owner peer can read or change them.
  ctx.inject(['connection'], (scope) => {
    const sessionOf = async (request) => {
      const body = await request.json().catch(() => ({}))
      const id = typeof body.sessionId === 'string' ? body.sessionId : ''
      if (id.length === 0) throw new Error('sessionId 缺失')
      return { body, session: sessionScope(id) }
    }
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/lancedb/souls',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const { session } = await sessionOf(request)
          return Response.json(await store.soulCatalog(session))
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 400 })
        }
      },
    }))
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/lancedb/attach',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const { body, session } = await sessionOf(request)
          const souls = Array.isArray(body.souls) ? body.souls : []
          return Response.json(await store.attach(session, { souls, detach: body.detach === true }))
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 400 })
        }
      },
    }))
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/lancedb/notes',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}))
          const name = normalizeSoulName(body.soul)
          const limit = Number.isInteger(body.limit) ? Math.min(Math.max(body.limit, 1), 100) : 50
          return Response.json(await store.list(soulScope(name), { limit }))
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 400 })
        }
      },
    }))
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/lancedb/delete',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}))
          const name = normalizeSoulName(body.soul)
          return Response.json(await store.deleteInSoul(name, body.id))
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 400 })
        }
      },
    }))
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/lancedb/restore',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}))
          const name = normalizeSoulName(body.soul)
          const stored = await store.store(soulScope(name), {
            text: body.text,
            kind: body.kind,
            metadata: body.metadata,
            importance: body.importance,
          })
          return Response.json(stored)
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 400 })
        }
      },
    }))
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/lancedb/souls/copy',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}))
          return Response.json(await store.copySoul({ from: body.from, to: body.to, description: body.description }))
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 400 })
        }
      },
    }))
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/lancedb/souls/merge',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}))
          return Response.json(await store.mergeSouls({
            sources: body.sources, target: body.target, description: body.description,
          }))
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 400 })
        }
      },
    }))
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/lancedb/souls/delete',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}))
          return Response.json(await store.deleteSoul({ name: body.name, force: true }))
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 400 })
        }
      },
    }))
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/lancedb/souls/rename',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}))
          return Response.json(await store.renameSoul({ from: body.from, to: body.to }))
        } catch (error) {
          return Response.json({ error: errorMessage(error) }, { status: 400 })
        }
      },
    }))
  })

  const tools = [
    tool({
      name: 'lancedb_store',
      description: '把一条笔记写进记忆库并返回 id。默认写当前会话；指定 soul 时直接写进那个 soul（soul 要先建）。'
        + '同样的 scope、kind 和文本重复写入不会产生重复行。',
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
          soul: { type: 'string', description: '写入指定 soul；省略时写当前会话' },
        },
        required: ['text'],
        additionalProperties: false,
      },
      execute: (input, exec) => store.store(
        input.soul === undefined ? scopeOfExecution(exec) : soulScope(normalizeSoulName(input.soul)),
        input,
      ),
    }),
    tool({
      name: 'lancedb_search',
      description: '按相似度检索记忆：向量 + BM25 融合排序。默认范围是当前会话加上已挂载的 soul；'
        + '传 souls 可临时改查哪些 soul。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '要检索的内容' },
          limit: { type: 'number', description: '返回条数，1-50，省略时用默认值' },
          kind: { type: 'string', description: '只在这类笔记里检索' },
          minScore: { type: 'number', description: '最低分 0-1，省略时用插件配置' },
          souls: {
            type: 'array',
            items: { type: 'string' },
            description: '改查这些 soul（仍包含当前会话），省略时用已挂载的 soul',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      execute: async (input, exec) => {
        const session = scopeOfExecution(exec)
        const explicit = input.souls === undefined
          ? await store.attachedSouls(session)
          : input.souls.map(normalizeSoulName)
        return store.search([session, ...explicit.map(soulScope)], input)
      },
    }),
    tool({
      name: 'lancedb_promote',
      description: '把当前会话里指定的记忆复制进某个 soul。默认 copy，move: true 时从会话删掉。',
      parameters: {
        type: 'object',
        properties: {
          ids: { type: 'array', items: { type: 'string' }, description: 'lancedb_store 返回的 id' },
          soul: { type: 'string', description: '目标 soul，必须先创建' },
          move: { type: 'boolean', description: 'true 表示复制后从当前会话删除，默认只复制' },
        },
        required: ['ids', 'soul'],
        additionalProperties: false,
      },
      execute: (input, exec) => store.promote(scopeOfExecution(exec), input),
    }),
    tool({
      name: 'lancedb_souls',
      description: '管理 soul：list 列表，create 新建，copy 复制成新 soul，rename 改名，'
        + 'merge 合并多个（来源保留），delete 连内容一起删（要 force: true）。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'create', 'copy', 'rename', 'merge', 'delete'],
            description: '要做的操作',
          },
          name: { type: 'string', description: 'copy / rename / delete 的来源 soul；小写字母、数字、_ 和 -，最长 32' },
          target: { type: 'string', description: 'copy / merge 的目标 soul 名；merge 时不存在会自动新建' },
          sources: {
            type: 'array',
            items: { type: 'string' },
            description: 'merge 的来源 soul 列表，合并后来源 soul 保留',
          },
          description: { type: 'string', description: 'create 时必填；copy / merge 时可给新 soul 写描述' },
          force: { type: 'boolean', description: 'delete 时必须传 true' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      execute: async (input, exec) => {
        if (input.action === 'list') return store.soulCatalog(scopeOfExecution(exec))
        if (input.action === 'copy') {
          return store.copySoul({ from: input.name, to: input.target, description: input.description })
        }
        if (input.action === 'rename') {
          return store.renameSoul({ from: input.name, to: input.target })
        }
        if (input.action === 'merge') {
          return store.mergeSouls({ sources: input.sources, target: input.target, description: input.description })
        }
        if (input.action === 'delete') return store.deleteSoul(input)
        return store.createSoul(input)
      },
    }),
    tool({
      name: 'lancedb_attach',
      description: '把 soul 挂到当前会话（之后 search 默认包含它），或 detach 卸掉。',
      parameters: {
        type: 'object',
        properties: {
          souls: { type: 'array', items: { type: 'string' }, description: '要挂载或卸下的 soul 名' },
          detach: { type: 'boolean', description: 'true 表示卸下，默认挂载' },
        },
        required: ['souls'],
        additionalProperties: false,
      },
      execute: (input, exec) => store.attach(scopeOfExecution(exec), input),
    }),
    tool({
      name: 'lancedb_list',
      description: '按写入时间倒序列出记忆。默认列当前会话；传 soul 时列那个 soul。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: '返回条数，1-100，默认 20' },
          kind: { type: 'string', description: '只看这类笔记' },
          soul: { type: 'string', description: '看某个 soul 而不是当前会话' },
        },
        additionalProperties: false,
      },
      execute: (input, exec) => store.list(
        input.soul === undefined ? scopeOfExecution(exec) : soulScope(normalizeSoulName(input.soul)),
        input,
      ),
    }),
    tool({
      name: 'lancedb_forget',
      description: '按 id 删除一条记忆。默认只能删当前会话的；删 soul 里的要显式传 soul。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'lancedb_store 返回的 id' },
          soul: { type: 'string', description: '从哪个 soul 删' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      execute: (input, exec) => store.forget(scopeOfExecution(exec), input),
    }),
    tool({
      name: 'lancedb_stats',
      description: '查看记忆库状态：目录、行数、kind 分布、当前会话与各 soul 的数量、检索模式。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      execute: (_input, exec) => store.stats(scopeOfExecution(exec)),
    }),
  ]

  for (const definition of tools) {
    ctx.effect(() => ctx.tools.register(definition))
  }
}
