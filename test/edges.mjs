/**
 * Edge-case test for dsh-lancedb-memory.
 *
 * Covers the paths the smoke test does not: validation errors, merges into an
 * existing target, semantic-merge fallbacks, concurrent writes, attachment
 * survival across rename, session TTL cleanup, and browser-route validation.
 */

import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from '@lancedb/lancedb'
import { apply } from '../index.js'

/**
 * Minimal Cordis context with an injectable model.
 * @param {object} options - Optional llm/defaultModel fakes.
 * @returns Context and registries.
 */
function createContext(options = {}) {
  const tools = new Map()
  const services = new Map()
  const disposers = []
  const routes = new Map()
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
    get(name) {
      if (name === 'llm') return options.llm
      if (name === 'agentDefaultModel') return options.defaultModel
      return undefined
    },
    inject(_deps, callback) {
      const scope = Object.create(ctx)
      scope.connection = {
        fetch: {
          register(route) {
            routes.set(route.path, route)
            return async () => { routes.delete(route.path) }
          },
        },
      }
      callback(scope)
    },
  }
  return { ctx, tools, services, disposers, routes }
}

/**
 * Boot one plugin instance.
 * @param {object} config - Row config.
 * @param {object} options - Model fakes.
 * @returns Tools, routes, and stop.
 */
function boot(config, options = {}) {
  const instance = createContext(options)
  apply(instance.ctx, config)
  return {
    tools: instance.tools,
    routes: instance.routes,
    stop() { instance.disposers.forEach(dispose => dispose()) },
  }
}

/**
 * Call one registered tool as a session.
 * @param {Map<string, any>} tools - Tools.
 * @param {string} name - Tool name.
 * @param {object} input - Arguments.
 * @param {string} session - Session id.
 * @returns Tool value.
 */
async function call(tools, name, input, session = 's1') {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} is registered`)
  return definition.execute(input, { signal: new AbortController().signal, agent: { id: session } })
}

/**
 * POST a browser-route body.
 * @param {any} route - Registered fetch route.
 * @param {object} body - JSON body.
 * @returns HTTP response.
 */
function routePost(route, body) {
  return route.fetch(new Request('http://host/api/lancedb', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

/**
 * Fake model that always answers with the given text.
 * @param {string} text - Reply.
 * @returns llm/defaultModel pair.
 */
function fakeModel(text) {
  return {
    llm: {
      async *stream() {
        yield { type: 'text-delta', text }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    },
    defaultModel: { currentSelection: () => ({ provider: 'fake', model: 'fake' }) },
  }
}

const root = await mkdtemp(join(tmpdir(), 'lancedb-edges-'))
const configFor = directory => ({
  directory,
  table: 'memories',
  embedding: { provider: 'hash', dimension: 128 },
})

try {
  // --- Validation errors ---------------------------------------------------
  const plugin = boot(configFor(join(root, 'core')))
  const souls = (input, session) => call(plugin.tools, 'lancedb_souls', input, session)

  await souls({ action: 'create', name: 'alpha', description: 'A' })
  await assert.rejects(souls({ action: 'create', name: 'Alpha', description: 'x' }), /soul 名/u)
  await assert.rejects(souls({ action: 'create', name: 'alpha' }), /description/u)
  await assert.rejects(souls({ action: 'create', name: 'alpha', description: 'x' }), /已存在/u)
  await assert.rejects(souls({ action: 'copy', name: 'alpha', target: 'alpha' }), /复制到它自己/u)
  await assert.rejects(souls({ action: 'copy', name: 'missing', target: 'x' }), /不存在/u)
  await assert.rejects(souls({ action: 'copy', name: 'alpha', target: 'Alpha' }), /soul 名/u)
  await assert.rejects(souls({ action: 'rename', name: 'alpha', to: 'x' }), /soul 名|target/u)
  await assert.rejects(souls({ action: 'delete', name: 'alpha' }), /force/u)
  await assert.rejects(souls({ action: 'merge', sources: ['alpha'], target: 'alpha' }), /不能同时是来源/u)
  await assert.rejects(souls({ action: 'merge', sources: ['missing'], target: 'x' }), /不存在/u)
  await assert.rejects(souls({ action: 'merge', sources: [], target: 'x' }), /至少给一个/u)

  await assert.rejects(call(plugin.tools, 'lancedb_attach', { souls: ['nope'] }), /不存在/u)
  await assert.rejects(call(plugin.tools, 'lancedb_store', { text: 'x', importance: 11 }), /importance/u)
  await assert.rejects(call(plugin.tools, 'lancedb_store', { text: 'x', soul: 'ghost' }), /不存在/u)
  await assert.rejects(call(plugin.tools, 'lancedb_search', { query: 'x', limit: 51 }), /limit/u)
  await assert.rejects(call(plugin.tools, 'lancedb_search', { query: 'x', limit: 0 }), /limit/u)
  await assert.rejects(call(plugin.tools, 'lancedb_search', { query: 'x', minScore: 2 }), /minScore/u)
  await assert.rejects(call(plugin.tools, 'lancedb_list', { limit: 101 }), /limit/u)
  await assert.rejects(
    call(plugin.tools, 'lancedb_promote', { ids: [], soul: 'alpha' }),
    /ids/u,
  )
  await assert.rejects(
    call(plugin.tools, 'lancedb_promote', { ids: ['zzz'], soul: 'alpha' }),
    /十六进制/u,
  )

  // --- Merge into an existing target --------------------------------------
  await souls({ action: 'create', name: 'beta', description: 'B' })
  await call(plugin.tools, 'lancedb_store', { soul: 'alpha', text: '共同的一条', kind: 'fact' })
  await call(plugin.tools, 'lancedb_store', { soul: 'beta', text: '共同的一条', kind: 'fact' })
  await call(plugin.tools, 'lancedb_store', { soul: 'beta', text: '只有 beta 有', kind: 'fact' })
  const firstMerge = await souls({ action: 'merge', sources: ['alpha'], target: 'beta' })
  assert.equal(firstMerge.skipped, 1, 'exact duplicate already in the target is skipped')
  assert.equal(firstMerge.copied, 0)

  const crossMerge = await souls({
    action: 'merge', sources: ['alpha', 'beta'], target: 'gamma', semantic: false,
  })
  assert.equal(crossMerge.copied, 2, 'duplicate text across sources collapses to one')
  assert.equal(crossMerge.skipped, 1)
  assert.equal(crossMerge.semantic, false)

  await assert.rejects(
    call(plugin.tools, 'lancedb_search', { query: 'x', souls: ['missing'] }),
    /不存在/u,
  )

  const copyRace = await Promise.allSettled([
    souls({ action: 'copy', name: 'beta', target: 'beta-copy' }),
    souls({ action: 'copy', name: 'beta', target: 'beta-copy' }),
  ])
  assert.equal(copyRace.filter(result => result.status === 'fulfilled').length, 1, 'one copy wins')
  const betaCount = (await call(plugin.tools, 'lancedb_list', { soul: 'beta' })).memories.length
  const copiedCount = (await call(plugin.tools, 'lancedb_list', { soul: 'beta-copy' })).memories.length
  assert.equal(copiedCount, betaCount, 'no duplicated rows from a copy race')

  await Promise.all([
    souls({ action: 'merge', sources: ['beta'], target: 'race-target', semantic: false }),
    souls({ action: 'merge', sources: ['beta'], target: 'race-target', semantic: false }),
  ])
  const raceRows = await call(plugin.tools, 'lancedb_list', { soul: 'race-target' })
  assert.equal(new Set(raceRows.memories.map(row => row.id)).size, raceRows.memories.length, 'no duplicate ids from a merge race')

  // --- Semantic fallbacks --------------------------------------------------
  const brokenDirectory = join(root, 'broken')
  const broken = boot(configFor(brokenDirectory), fakeModel('这不是 JSON'))
  await call(broken.tools, 'lancedb_souls', { action: 'create', name: 'p', description: 'P' })
  await call(broken.tools, 'lancedb_souls', { action: 'create', name: 'q', description: 'Q' })
  await call(broken.tools, 'lancedb_store', { soul: 'p', text: '同样的意思一', kind: 'note' })
  await call(broken.tools, 'lancedb_store', { soul: 'q', text: '同样的意思二', kind: 'note' })
  const fallback = await call(broken.tools, 'lancedb_souls', {
    action: 'merge', sources: ['p', 'q'], target: 'pq',
  })
  assert.equal(fallback.semantic, false)
  assert.match(fallback.semanticError, /JSON/u)
  assert.equal(fallback.copied, 2)
  broken.stop()

  const unknownIds = boot(configFor(join(root, 'unknown-ids')), fakeModel(JSON.stringify({
    groups: [{ ids: ['0'.repeat(32), '1'.repeat(32)], text: '假的合并', kind: 'note' }],
  })))
  await call(unknownIds.tools, 'lancedb_souls', { action: 'create', name: 'u1', description: '1' })
  await call(unknownIds.tools, 'lancedb_souls', { action: 'create', name: 'u2', description: '2' })
  await call(unknownIds.tools, 'lancedb_store', { soul: 'u1', text: '未知 id 一' })
  await call(unknownIds.tools, 'lancedb_store', { soul: 'u2', text: '未知 id 二' })
  const ignored = await call(unknownIds.tools, 'lancedb_souls', {
    action: 'merge', sources: ['u1', 'u2'], target: 'uu',
  })
  assert.equal(ignored.mergedGroups, 0)
  assert.equal(ignored.copied, 2)
  unknownIds.stop()

  // --- Concurrent writes ---------------------------------------------------
  const parallel = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    call(plugin.tools, 'lancedb_store', { text: `并发笔记 ${index}`, kind: 'note' }, 'conc')))
  assert.equal(parallel.filter(result => result.created).length, 8)
  const parallelList = await call(plugin.tools, 'lancedb_list', { limit: 50 }, 'conc')
  assert.equal(parallelList.memories.length, 8)
  assert.equal(new Set(parallelList.memories.map(row => row.id)).size, 8)

  // --- Attachments survive rename -----------------------------------------
  await call(plugin.tools, 'lancedb_attach', { souls: ['alpha'] }, 'sess-x')
  await souls({ action: 'rename', name: 'alpha', target: 'alpha-renamed' })
  const catalog = await souls({ action: 'list' }, 'sess-x')
  assert.ok(catalog.souls.some(soul => soul.name === 'alpha-renamed' && soul.attached === true))
  assert.equal(catalog.souls.some(soul => soul.name === 'alpha'), false)

  // --- Forget rules --------------------------------------------------------
  const betaRows = await call(plugin.tools, 'lancedb_list', { soul: 'beta' }, 'sess-x')
  const betaId = betaRows.memories[0].id
  await assert.rejects(
    call(plugin.tools, 'lancedb_forget', { id: betaId }, 'sess-x'),
    /只能删当前会话/u,
  )
  const deleted = await call(plugin.tools, 'lancedb_forget', { id: betaId, soul: 'beta' }, 'sess-x')
  assert.equal(deleted.deleted, true)

  // --- Browser-route validation -------------------------------------------
  const deleteRoute = plugin.routes.get('/api/lancedb/delete')
  const restoreRoute = plugin.routes.get('/api/lancedb/restore')
  const renameRoute = plugin.routes.get('/api/lancedb/souls/rename')
  const copyRoute = plugin.routes.get('/api/lancedb/souls/copy')
  const notesRoute = plugin.routes.get('/api/lancedb/notes')
  assert.equal((await routePost(deleteRoute, { soul: 'beta', id: 'nope' })).status, 400)
  assert.equal((await routePost(restoreRoute, { soul: 'beta', text: '' })).status, 400)
  assert.equal((await routePost(renameRoute, { from: 'beta', to: 'Bad Name' })).status, 400)
  assert.equal((await routePost(copyRoute, { from: 'beta', to: 'beta' })).status, 400)
  assert.equal((await routePost(notesRoute, { soul: 'beta', limit: 1e9 })).status, 200)

  plugin.stop()

  // --- Session TTL cleanup -------------------------------------------------
  const ttlDirectory = join(root, 'ttl')
  const ttl = boot({ ...configFor(ttlDirectory), sessionTtlDays: 1 })
  await call(ttl.tools, 'lancedb_store', { text: '旧会话的东西' }, 'old-session')
  await call(ttl.tools, 'lancedb_store', { text: '当前会话的东西' }, 'new-session')

  const db = await connect(ttlDirectory)
  const table = await db.openTable('memories')
  const stale = Date.now() - 10 * 86_400_000
  await table.update({ where: "scope = 'session:old-session'", values: { lastAccessedAt: stale } })
  const stats = await call(ttl.tools, 'lancedb_stats', {}, 'new-session')
  assert.equal(stats.purgedSessions, 1)
  assert.equal(stats.rows, 1, 'current session survives the purge')
  const reopened = await db.openTable('memories')
  const oldRows = await reopened.query().where("scope = 'session:old-session'").toArray()
  assert.equal(oldRows.length, 0)
  await db.close?.()
  ttl.stop()

  // --- Dimension mismatch ---------------------------------------------------
  const dimDirectory = join(root, 'dim')
  const dimDb = await connect(dimDirectory)
  await dimDb.createTable('memories', [{
    id: 'f'.repeat(32),
    text: '旧维度的一行',
    kind: 'note',
    metadata: '{}',
    vector: [0.1, 0.2, 0.3],
    createdAt: Date.now(),
  }])
  await dimDb.close?.()
  const dimPlugin = boot(configFor(dimDirectory))
  await assert.rejects(
    call(dimPlugin.tools, 'lancedb_store', { text: '新维度的写入' }),
    /维度/u,
  )
  dimPlugin.stop()

  console.log('dsh-lancedb-memory edge test: ok')
} finally {
  await rm(root, { recursive: true, force: true })
}
