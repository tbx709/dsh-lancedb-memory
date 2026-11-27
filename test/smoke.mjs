/**
 * Smoke test for the LanceDB memory plugin without a Host process.
 *
 * Drives the same tool definitions the model calls and covers: session
 * isolation, souls (create/attach/promote/delete), explicit-scope search,
 * cross-session access rules, hybrid retrieval, dedupe, lifecycle ranking,
 * access reinforcement, the v0.2 migration into the `imported` soul, and an
 * OpenAI-compatible HTTP embedder served locally.
 */

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from '@lancedb/lancedb'
import { apply } from '../index.js'

const TOOLS = [
  'lancedb_attach', 'lancedb_forget', 'lancedb_list', 'lancedb_promote',
  'lancedb_search', 'lancedb_souls', 'lancedb_stats', 'lancedb_store',
]

/**
 * Minimal Cordis context: capture tools, services, and disposers.
 * @returns Fake context and its registries.
 */
function createContext() {
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
 * @returns Tools, services, and a stop function.
 */
function boot(config) {
  const instance = createContext()
  apply(instance.ctx, config)
  return {
    tools: instance.tools,
    services: instance.services,
    routes: instance.routes,
    stop() {
      instance.disposers.forEach(dispose => dispose())
    },
  }
}

let sequence = 0
/**
 * Call a registered tool the way the executor does, as one session.
 * @param {Map<string, any>} tools - Registered tools.
 * @param {string} name - Tool name.
 * @param {object} input - Tool arguments.
 * @param {string} session - Session id.
 * @returns The tool value.
 */
async function call(tools, name, input, session = 'session-a') {
  const definition = tools.get(name)
  assert.ok(definition, `tool ${name} is registered`)
  sequence += 1
  return definition.execute(input, {
    signal: new AbortController().signal,
    agent: { id: session },
  })
}

/**
 * Build a deterministic one-hot vector for legacy rows.
 * @param {number} dimension - Vector length.
 * @returns Vector.
 */
function oneHot(dimension) {
  const vector = new Array(dimension).fill(0)
  vector[0] = 1
  return vector
}

const root = await mkdtemp(join(tmpdir(), 'lancedb-plugin-'))
const configFor = directory => ({
  directory,
  table: 'memories',
  topK: 3,
  embedding: { provider: 'hash', dimension: 128 },
})

try {
  // --- Session isolation ---------------------------------------------------
  const directory = join(root, 'core')
  const plugin = boot(configFor(directory))
  assert.deepEqual([...plugin.tools.keys()].sort(), TOOLS)
  assert.ok(plugin.services.get('lancedb'), 'service is provided')

  const apple = await call(plugin.tools, 'lancedb_store', { text: '苹果是红色的水果', kind: 'fact' }, 'a')
  assert.equal(apple.created, true)
  assert.equal(apple.scope, 'session:a')

  const leaked = await call(plugin.tools, 'lancedb_search', { query: '红色水果' }, 'b')
  assert.equal(leaked.results.length, 0, 'session b cannot see session a')
  const leakedList = await call(plugin.tools, 'lancedb_list', {}, 'b')
  assert.equal(leakedList.memories.length, 0)

  const own = await call(plugin.tools, 'lancedb_store', { text: '苹果是红色的水果', kind: 'fact' }, 'b')
  assert.notEqual(own.id, apple.id, 'ids are scoped')
  assert.equal(own.total, 2)

  // --- Souls: create, list, attach ----------------------------------------
  const writing = await call(plugin.tools, 'lancedb_souls', {
    action: 'create', name: 'writing', description: '用户的文案偏好与定稿案例',
  })
  assert.equal(writing.soul, 'writing')
  await assert.rejects(
    call(plugin.tools, 'lancedb_souls', { action: 'create', name: 'Writing', description: 'x' }),
    /soul 名/u,
  )
  await assert.rejects(
    call(plugin.tools, 'lancedb_souls', { action: 'create', name: 'writing', description: 'x' }),
    /已存在/u,
  )
  await assert.rejects(
    call(plugin.tools, 'lancedb_souls', { action: 'create', name: 'empty' }),
    /description/u,
  )

  let catalog = await call(plugin.tools, 'lancedb_souls', { action: 'list' }, 'b')
  assert.equal(catalog.souls.length, 1)
  assert.equal(catalog.souls[0].name, 'writing')
  assert.equal(catalog.souls[0].notes, 0)
  assert.equal(catalog.souls[0].attached, false)

  const attached = await call(plugin.tools, 'lancedb_attach', { souls: ['writing'] }, 'b')
  assert.deepEqual(attached.attached, ['writing'])
  catalog = await call(plugin.tools, 'lancedb_souls', { action: 'list' }, 'b')
  assert.equal(catalog.souls[0].attached, true)
  await assert.rejects(call(plugin.tools, 'lancedb_attach', { souls: ['nope'] }, 'b'), /不存在/u)

  // --- Browser routes behind the authenticated /api carrier ---------------
  const soulsRoute = plugin.routes.get('/api/lancedb/souls')
  const attachRoute = plugin.routes.get('/api/lancedb/attach')
  const notesRoute = plugin.routes.get('/api/lancedb/notes')
  assert.ok(soulsRoute, 'souls route is registered')
  assert.ok(attachRoute, 'attach route is registered')
  assert.ok(notesRoute, 'notes route is registered')

  const routePost = (route, body) => route.fetch(new Request('http://host/api/lancedb', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))

  const soulsAnswer = await routePost(soulsRoute, { sessionId: 'ui' })
  assert.equal(soulsAnswer.status, 200)
  const soulsBody = await soulsAnswer.json()
  assert.equal(soulsBody.souls[0].name, 'writing')
  assert.equal(soulsBody.souls[0].attached, false)
  assert.deepEqual(soulsBody.attached, [])

  const attachAnswer = await routePost(attachRoute, { sessionId: 'ui', souls: ['writing'] })
  assert.deepEqual((await attachAnswer.json()).attached, ['writing'])
  const afterAttach = await (await routePost(soulsRoute, { sessionId: 'ui' })).json()
  assert.equal(afterAttach.souls[0].attached, true)

  const detachAnswer = await routePost(attachRoute, { sessionId: 'ui', souls: ['writing'], detach: true })
  assert.deepEqual((await detachAnswer.json()).attached, [])
  const missingSession = await routePost(soulsRoute, {})
  assert.equal(missingSession.status, 400)
  const unknownSoul = await routePost(attachRoute, { sessionId: 'ui', souls: ['nope'] })
  assert.equal(unknownSoul.status, 400)
  const emptyNotes = await routePost(notesRoute, { soul: 'writing' })
  assert.equal(emptyNotes.status, 200)
  assert.equal((await emptyNotes.json()).memories.length, 0)
  const badNotes = await routePost(notesRoute, { soul: 'Bad Name' })
  assert.equal(badNotes.status, 400)

  // --- Promote from a session into a soul ---------------------------------
  const draft = await call(plugin.tools, 'lancedb_store', {
    text: '文案标题尽量控制在 20 字以内',
    kind: 'preference',
    importance: 8,
  }, 'a')
  await assert.rejects(
    call(plugin.tools, 'lancedb_promote', { ids: [draft.id], soul: 'nope' }, 'a'),
    /不存在/u,
  )
  const promoted = await call(plugin.tools, 'lancedb_promote', { ids: [draft.id], soul: 'writing' }, 'a')
  assert.equal(promoted.copied.length, 1)
  assert.equal(promoted.copied[0].id, draft.id)
  assert.notEqual(promoted.copied[0].newId, draft.id)

  const again = await call(plugin.tools, 'lancedb_promote', { ids: [draft.id], soul: 'writing' }, 'a')
  assert.equal(again.copied.length, 0)
  assert.equal(again.skipped[0].reason, 'already-in-soul')

  const notesRouteAgain = plugin.routes.get('/api/lancedb/notes')
  const previewNotes = await (await routePost(notesRouteAgain, { soul: 'writing' })).json()
  assert.equal(previewNotes.memories.length, 1)
  assert.match(previewNotes.memories[0].text, /文案标题/u)

  // The picker deletes one note, then restores it from the undo snapshot.
  const deleteRoute = plugin.routes.get('/api/lancedb/delete')
  const restoreRoute = plugin.routes.get('/api/lancedb/restore')
  assert.ok(deleteRoute, 'delete route is registered')
  assert.ok(restoreRoute, 'restore route is registered')
  const removedNote = await (await routePost(deleteRoute, { soul: 'writing', id: previewNotes.memories[0].id })).json()
  assert.equal(removedNote.deleted, true)
  assert.equal((await (await routePost(notesRouteAgain, { soul: 'writing' })).json()).memories.length, 0)
  const restoredNote = await (await routePost(restoreRoute, {
    soul: 'writing',
    text: previewNotes.memories[0].text,
    kind: previewNotes.memories[0].kind,
    importance: previewNotes.memories[0].importance,
  })).json()
  assert.equal(restoredNote.created, true)
  assert.equal((await (await routePost(notesRouteAgain, { soul: 'writing' })).json()).memories.length, 1)

  // Soul-level copy, merge, and delete from the picker.
  const copyRoute = plugin.routes.get('/api/lancedb/souls/copy')
  const mergeRoute = plugin.routes.get('/api/lancedb/souls/merge')
  const deleteSoulRoute = plugin.routes.get('/api/lancedb/souls/delete')
  assert.ok(copyRoute, 'copy route is registered')
  assert.ok(mergeRoute, 'merge route is registered')
  assert.ok(deleteSoulRoute, 'delete-soul route is registered')

  const copiedSoul = await (await routePost(copyRoute, { from: 'writing', to: 'writing-copy' })).json()
  assert.equal(copiedSoul.copied, 1)
  assert.equal((await (await routePost(notesRouteAgain, { soul: 'writing-copy' })).json()).memories.length, 1)
  assert.equal((await (await routePost(notesRouteAgain, { soul: 'writing' })).json()).memories.length, 1, 'copy keeps the source')

  const merged = await (await routePost(mergeRoute, { sources: ['writing', 'writing-copy'], target: 'writing-all' })).json()
  assert.equal(merged.copied, 1)
  assert.equal(merged.skipped, 1)
  assert.equal((await (await routePost(notesRouteAgain, { soul: 'writing-all' })).json()).memories.length, 1)
  assert.equal((await (await routePost(notesRouteAgain, { soul: 'writing-copy' })).json()).memories.length, 1, 'merge keeps sources')

  const removedCopy = await (await routePost(deleteSoulRoute, { name: 'writing-copy' })).json()
  assert.equal(removedCopy.deletedRows, 1)
  const removedAll = await (await routePost(deleteSoulRoute, { name: 'writing-all' })).json()
  assert.equal(removedAll.deletedRows, 1)
  const catalogAfter = await (await routePost(soulsRoute, { sessionId: 'ui' })).json()
  assert.deepEqual(catalogAfter.souls.map(soul => soul.name), ['writing'])

  // The same operations through the agent tool.
  const toolCopy = await call(plugin.tools, 'lancedb_souls', { action: 'copy', name: 'writing', target: 'tool-copy' }, 'a')
  assert.equal(toolCopy.copied, 1)
  const toolMerge = await call(plugin.tools, 'lancedb_souls', {
    action: 'merge', sources: ['tool-copy'], target: 'tool-all',
  }, 'a')
  assert.equal(toolMerge.copied, 1)
  await call(plugin.tools, 'lancedb_souls', { action: 'delete', name: 'tool-copy', force: true }, 'a')
  await call(plugin.tools, 'lancedb_souls', { action: 'delete', name: 'tool-all', force: true }, 'a')

  const foreign = await call(plugin.tools, 'lancedb_promote', { ids: [own.id], soul: 'writing' }, 'a')
  assert.equal(foreign.skipped[0].reason, 'not-in-session', 'cannot promote another session note')

  // b attached the soul, so its recall now crosses the boundary deliberately.
  const recalled = await call(plugin.tools, 'lancedb_search', { query: '文案标题' }, 'b')
  assert.equal(recalled.results[0].id, promoted.copied[0].newId)
  assert.equal(recalled.results[0].scope, 'soul:writing')
  assert.equal(recalled.retrieval, 'hybrid')

  // Explicit scope selection overrides attachments.
  const explicit = await call(plugin.tools, 'lancedb_search', { query: '文案标题', souls: [] }, 'b')
  assert.equal(explicit.results.length, 0)
  assert.deepEqual(await call(plugin.tools, 'lancedb_attach', { souls: ['writing'], detach: true }, 'b')
    .then(result => result.attached), [])

  const soulList = await call(plugin.tools, 'lancedb_list', { soul: 'writing' }, 'b')
  assert.equal(soulList.memories.length, 1)
  assert.equal(soulList.scope, 'soul:writing')

  // --- Store straight into a soul -----------------------------------------
  await assert.rejects(
    call(plugin.tools, 'lancedb_store', { text: '直接写进不存在的 soul', soul: 'ghost' }),
    /不存在/u,
  )
  const direct = await call(plugin.tools, 'lancedb_store', {
    text: '标题里不要用问号', kind: 'preference', soul: 'writing',
  }, 'b')
  assert.equal(direct.scope, 'soul:writing')
  assert.equal(direct.created, true)

  // --- Forget rules --------------------------------------------------------
  await assert.rejects(
    call(plugin.tools, 'lancedb_forget', { id: apple.id }, 'b'),
    /只能删当前会话/u,
  )
  await assert.rejects(
    call(plugin.tools, 'lancedb_forget', { id: direct.id }, 'b'),
    /只能删当前会话/u,
  )
  const deletedSoulNote = await call(plugin.tools, 'lancedb_forget', { id: direct.id, soul: 'writing' }, 'b')
  assert.equal(deletedSoulNote.deleted, true)
  const deletedOwn = await call(plugin.tools, 'lancedb_forget', { id: own.id }, 'b')
  assert.equal(deletedOwn.deleted, true)

  // --- Lifecycle ranking and access reinforcement --------------------------
  await call(plugin.tools, 'lancedb_store', { text: '完全相同的记忆文本', kind: 'low', importance: 1 }, 'c')
  const high = await call(plugin.tools, 'lancedb_store', {
    text: '完全相同的记忆文本', kind: 'high', importance: 10,
  }, 'c')
  const importanceSearch = await call(plugin.tools, 'lancedb_search', { query: '完全相同的记忆文本' }, 'c')
  assert.equal(importanceSearch.results[0].kind, 'high')

  await call(plugin.tools, 'lancedb_search', { query: '红色水果' }, 'a')
  const reinforced = await call(plugin.tools, 'lancedb_list', { kind: 'fact' }, 'a')
  assert.ok(reinforced.memories[0].accessCount >= 1, 'recalled rows are reinforced')
  assert.ok(reinforced.memories[0].lastAccessedAt >= reinforced.memories[0].createdAt)
  assert.ok(high.total >= 2)

  // --- Stats ---------------------------------------------------------------
  const stats = await call(plugin.tools, 'lancedb_stats', {}, 'c')
  assert.equal(stats.exists, true)
  assert.ok(stats.rows >= 3)
  assert.ok(stats.scopes.sessions >= 2)
  assert.equal(stats.scopes.souls.find(soul => soul.name === 'writing').notes, 1)
  assert.equal(stats.retrieval, 'hybrid')

  // --- Soul deletion removes rows and attachments -------------------------
  await call(plugin.tools, 'lancedb_attach', { souls: ['writing'] }, 'b')
  await assert.rejects(
    call(plugin.tools, 'lancedb_souls', { action: 'delete', name: 'writing' }, 'b'),
    /force/u,
  )
  const removed = await call(plugin.tools, 'lancedb_souls', { action: 'delete', name: 'writing', force: true }, 'b')
  assert.equal(removed.soul, 'writing')
  assert.equal(removed.deletedRows, 1)
  assert.equal(removed.detachedSessions, 1)
  catalog = await call(plugin.tools, 'lancedb_souls', { action: 'list' }, 'b')
  assert.equal(catalog.souls.length, 0)

  plugin.stop()
  assert.equal(plugin.tools.size, 0)

  // --- Reopen: rows and attachments survive -------------------------------
  const reopened = boot(configFor(directory))
  const reopenedStats = await call(reopened.tools, 'lancedb_stats', {}, 'c')
  assert.equal(reopenedStats.rows, stats.rows - 1, 'only the soul row was deleted')
  const reopenedSearch = await call(reopened.tools, 'lancedb_search', { query: '红色水果' }, 'a')
  assert.equal(reopenedSearch.results[0].text, '苹果是红色的水果')
  reopened.stop()

  // --- v0.2 migration: rows become the imported soul ----------------------
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

  const migrated = boot(configFor(legacyDirectory))
  const migratedStats = await call(migrated.tools, 'lancedb_stats', {}, 'x')
  assert.equal(migratedStats.rows, 1)
  assert.equal(migratedStats.retrieval, 'hybrid')
  const imported = migratedStats.scopes.souls.find(soul => soul.name === 'imported')
  assert.equal(imported.notes, 1)
  const migratedSearch = await call(migrated.tools, 'lancedb_search', {
    query: '向量检索', souls: ['imported'],
  }, 'x')
  assert.equal(migratedSearch.results[0].id, 'a'.repeat(32))
  assert.equal(migratedSearch.results[0].scope, 'soul:imported')
  const migratedSession = await call(migrated.tools, 'lancedb_search', { query: '向量检索' }, 'x')
  assert.equal(migratedSession.results.length, 0, 'old rows do not leak into sessions')
  const migratedTable = await (await connect(legacyDirectory)).openTable('memories')
  const columns = (await migratedTable.schema()).fields.map(field => field.name)
  for (const column of ['importance', 'accessCount', 'lastAccessedAt', 'updatedAt', 'scope']) {
    assert.ok(columns.includes(column), `migration added ${column}`)
  }
  migrated.stop()

  // --- HTTP embedder -------------------------------------------------------
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
    const stored = await call(remote.tools, 'lancedb_store', { text: '远程嵌入写入' }, 'r')
    assert.equal(stored.dimension, 4)
    const searched = await call(remote.tools, 'lancedb_search', { query: '远程嵌入检索' }, 'r')
    assert.equal(searched.results.length, 1)
    assert.ok(requestCount >= 2)
    remote.stop()
  } finally {
    server.close()
  }

  console.log('dsh-lancedb-memory smoke test: ok')
} finally {
  await rm(root, { recursive: true, force: true })
}
