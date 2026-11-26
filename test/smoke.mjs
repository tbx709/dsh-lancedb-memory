/**
 * Smoke test for the LanceDB memory plugin without a Host process.
 *
 * It drives the same tool definitions the model calls, against temporary
 * tables, and covers: hybrid retrieval (vector + BM25), kind filtering,
 * lifecycle ranking (importance, recency), access reinforcement, near-duplicate
 * suppression, schema migration from v0.1, and an OpenAI-compatible HTTP
 * embedder served locally.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from '@lancedb/lancedb'
import { apply } from '../index.js'

/**
 * Minimal Cordis context: capture tools, services, and disposers.
 * @returns Fake context and its registries.
 */
function createContext() {
  const tools = new Map()
  const services = new Map()
  const disposers = []
  const ctx = {
    tools: {
      register(definition) {
        assert.equal(tools.has(definition.name), false, `duplicate tool ${definition.name}`)
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    provide(name, value) {
      services.set(name, value)
      return () => services.delete(name)
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
  return { ctx, tools, services, disposers }
}

/**
 * Boot one plugin instance and return its tools plus a disposer.
 * @param {object} config - Row config.
 * @returns Tools map and cleanup.
 */
function boot(config) {
  const instance = createContext()
  apply(instance.ctx, config)
  return {
    tools: instance.tools,
    services: instance.services,
    stop() {
      instance.disposers.forEach(dispose => dispose())
    },
  }
}

/**
 * Call a registered tool the way the executor does.
 * @param {Map<string, any>} tools - Registered tools.
 * @param {string} name - Tool name.
 * @param {object} input - Tool arguments.
 * @returns The tool value.
 */
async function call(tools, name, input) {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} is registered`)
  return definition.execute(input, { signal: new AbortController().signal })
}

/**
 * Build a deterministic one-hot legacy vector.
 * @param {number} dimension - Vector length.
 * @returns Vector.
 */
function oneHot(dimension) {
  const vector = new Array(dimension).fill(0)
  vector[0] = 1
  return vector
}

const root = await mkdtemp(join(tmpdir(), 'lancedb-plugin-'))
const hashConfig = directory => ({
  directory,
  table: 'memories',
  topK: 3,
  embedding: { provider: 'hash', dimension: 128 },
})

try {
  // --- Core store / list / search / forget --------------------------------
  const directory = join(root, 'core')
  const plugin = boot(hashConfig(directory))
  assert.deepEqual([...plugin.tools.keys()].sort(), [
    'lancedb_forget', 'lancedb_list', 'lancedb_search', 'lancedb_stats', 'lancedb_store',
  ])
  assert.ok(plugin.services.get('lancedb'), 'service is provided')

  const apple = await call(plugin.tools, 'lancedb_store', { text: '苹果是红色的水果', kind: 'fact' })
  assert.equal(apple.created, true)
  assert.match(apple.id, /^[0-9a-f]{32}$/u)

  const duplicate = await call(plugin.tools, 'lancedb_store', { text: '苹果是红色的水果', kind: 'fact' })
  assert.equal(duplicate.created, false)
  assert.equal(duplicate.total, 1)

  const nearCopy = await call(plugin.tools, 'lancedb_store', { text: '苹果是红色的水果！', kind: 'fact' })
  assert.equal(nearCopy.duplicate, true, 'near-duplicate collapses into the stored row')
  assert.equal(nearCopy.id, apple.id)

  await call(plugin.tools, 'lancedb_store', {
    text: '香蕉是黄色的水果',
    kind: 'fact',
    metadata: { source: 'test', line: 2 },
  })
  await call(plugin.tools, 'lancedb_store', { text: '用户偏好简短的回答', kind: 'preference' })

  const listed = await call(plugin.tools, 'lancedb_list', {})
  assert.equal(listed.total, 3)
  assert.deepEqual(listed.memories.map(row => row.text), [
    '用户偏好简短的回答', '香蕉是黄色的水果', '苹果是红色的水果',
  ], 'list is newest first')

  const found = await call(plugin.tools, 'lancedb_search', { query: '红色水果', limit: 2 })
  assert.equal(found.retrieval, 'hybrid', 'BM25 index is live')
  assert.equal(found.results[0].text, '苹果是红色的水果')
  assert.ok(found.results[0].score > found.results[1].score)
  assert.ok(['both', 'vector', 'bm25'].includes(found.results[0].match))

  const filtered = await call(plugin.tools, 'lancedb_search', { query: '用户偏好', kind: 'fact' })
  assert.ok(filtered.results.every(row => row.kind === 'fact'))
  const preference = await call(plugin.tools, 'lancedb_search', { query: '简短回答', kind: 'preference' })
  assert.equal(preference.results[0].text, '用户偏好简短的回答')

  // Access reinforcement: two recalls move accessCount and lastAccessedAt.
  await call(plugin.tools, 'lancedb_search', { query: '香蕉', kind: 'fact' })
  const afterRecall = await call(plugin.tools, 'lancedb_list', { kind: 'fact' })
  const banana = afterRecall.memories.find(row => row.text === '香蕉是黄色的水果')
  assert.ok(banana.accessCount >= 1, 'recalled rows are reinforced')
  assert.ok(banana.lastAccessedAt >= banana.createdAt)

  await assert.rejects(call(plugin.tools, 'lancedb_search', { query: 'x', minScore: 2 }), /minScore/u)
  await assert.rejects(call(plugin.tools, 'lancedb_forget', { id: 'not-an-id' }), /32 位十六进制/u)
  await assert.rejects(call(plugin.tools, 'lancedb_store', { text: '   ' }), /不能为空/u)
  await assert.rejects(call(plugin.tools, 'lancedb_store', { text: 'x', importance: 0 }), /importance/u)

  const stats = await call(plugin.tools, 'lancedb_stats', {})
  assert.equal(stats.rows, 3)
  assert.equal(stats.retrieval, 'hybrid')
  assert.deepEqual(stats.kinds, [{ kind: 'fact', count: 2 }, { kind: 'preference', count: 1 }])
  assert.equal(stats.dimension, 128)
  assert.equal(stats.ftsError, undefined)

  const forgotten = await call(plugin.tools, 'lancedb_forget', { id: apple.id })
  assert.equal(forgotten.deleted, true)
  assert.equal(forgotten.total, 2)

  plugin.stop()
  assert.equal(plugin.tools.size, 0, 'tools unregister on dispose')
  assert.equal(plugin.services.size, 0, 'service unregisters on dispose')

  // --- Reopen: rows and the index survive ---------------------------------
  const reopened = boot(hashConfig(directory))
  const persisted = await call(reopened.tools, 'lancedb_stats', {})
  assert.equal(persisted.rows, 2)
  const reopenedSearch = await call(reopened.tools, 'lancedb_search', { query: '黄色水果' })
  assert.equal(reopenedSearch.results[0].text, '香蕉是黄色的水果')
  reopened.stop()

  // --- Importance and recency nudge equal text apart ----------------------
  const rankDirectory = join(root, 'rank')
  const ranked = boot(hashConfig(rankDirectory))
  const sameText = '完全相同的记忆文本'
  const low = await call(ranked.tools, 'lancedb_store', { text: sameText, kind: 'low', importance: 1 })
  const high = await call(ranked.tools, 'lancedb_store', { text: sameText, kind: 'high', importance: 10 })
  const importanceSearch = await call(ranked.tools, 'lancedb_search', { query: sameText, limit: 2 })
  assert.equal(importanceSearch.results[0].kind, 'high', 'importance breaks the tie')

  const db = await connect(rankDirectory)
  const table = await db.openTable('memories')
  const stale = Date.now() - 120 * 86_400_000
  await table.update({ where: `id = '${low.id}'`, values: { createdAt: stale, lastAccessedAt: stale } })
  const recencySearch = await call(ranked.tools, 'lancedb_search', { query: sameText, limit: 2 })
  assert.equal(recencySearch.results.find(row => row.id === high.id).score > recencySearch.results.find(row => row.id === low.id).score, true, 'recency breaks the tie')
  await db.close?.()
  ranked.stop()

  // --- BM25-only retrieval finds Chinese keywords -------------------------
  const ftsDirectory = join(root, 'fts')
  const ftsOnly = boot({
    directory: ftsDirectory,
    table: 'memories',
    embedding: { provider: 'hash', dimension: 128 },
    search: { vectorWeight: 0, bm25Weight: 1 },
  })
  await call(ftsOnly.tools, 'lancedb_store', { text: '蓝莓酱的做法：小火慢熬' })
  await call(ftsOnly.tools, 'lancedb_store', { text: '香蕉要放熟再吃' })
  await call(ftsOnly.tools, 'lancedb_store', { text: '苹果派需要肉桂' })
  const ftsHit = await call(ftsOnly.tools, 'lancedb_search', { query: '蓝莓酱', limit: 3 })
  assert.equal(ftsHit.results.length, 1, 'only the BM25 match survives zero vector weight')
  assert.equal(ftsHit.results[0].match, 'bm25')
  assert.equal(ftsHit.results[0].text, '蓝莓酱的做法：小火慢熬')
  ftsOnly.stop()

  // --- Migration from the v0.1 schema -------------------------------------
  const legacyDirectory = join(root, 'legacy')
  const legacyDb = await connect(legacyDirectory)
  const legacy = await legacyDb.createTable('memories', [{
    id: 'a'.repeat(32),
    text: '旧版本写入的笔记，讲的是向量检索',
    kind: 'fact',
    metadata: '{}',
    vector: oneHot(128),
    createdAt: Date.now() - 86_400_000,
  }])
  assert.equal((await legacy.schema()).fields.length, 6)
  await legacyDb.close?.()

  const migrated = boot(hashConfig(legacyDirectory))
  const migratedStats = await call(migrated.tools, 'lancedb_stats', {})
  assert.equal(migratedStats.rows, 1)
  assert.equal(migratedStats.retrieval, 'hybrid', 'index is built for an existing table')
  const migratedSearch = await call(migrated.tools, 'lancedb_search', { query: '向量检索' })
  assert.equal(migratedSearch.results[0].id, 'a'.repeat(32))
  assert.equal(migratedSearch.results[0].importance, 5, 'new column is backfilled')
  const migratedList = await call(migrated.tools, 'lancedb_list', {})
  assert.equal(migratedList.memories[0].accessCount, 1, 'migrated rows can be reinforced')
  const migratedTable = await (await connect(legacyDirectory)).openTable('memories')
  const names = (await migratedTable.schema()).fields.map(field => field.name)
  for (const column of ['importance', 'accessCount', 'lastAccessedAt', 'updatedAt']) {
    assert.ok(names.includes(column), `migration added ${column}`)
  }
  migrated.stop()

  // --- HTTP embedder ------------------------------------------------------
  let requestCount = 0
  const server = createServer((request, response) => {
    requestCount += 1
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const text = JSON.parse(body).input
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ embedding: [text.length % 7, 1, 0.5, 0.25] }] }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  try {
    const remote = boot({
      directory: join(root, 'http'),
      table: 'remote',
      embedding: {
        provider: 'http',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: 'test-embed',
        apiKeyEnv: 'DSH_LANCEDB_TEST_KEY',
      },
    })
    const stored = await call(remote.tools, 'lancedb_store', { text: '远程嵌入写入' })
    assert.equal(stored.dimension, 4)
    const searched = await call(remote.tools, 'lancedb_search', { query: '远程嵌入检索' })
    assert.equal(searched.retrieval, 'hybrid')
    assert.equal(searched.results.length, 1)
    assert.ok(requestCount >= 2, 'both store and search called the endpoint')
    remote.stop()
  } finally {
    server.close()
  }

  console.log('dsh-lancedb-memory smoke test: ok')
} finally {
  await rm(root, { recursive: true, force: true })
}
