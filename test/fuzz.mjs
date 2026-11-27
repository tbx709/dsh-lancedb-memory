import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { connect } = await import('@lancedb/lancedb')
const { apply } = await import('../index.js')

const root = await mkdtemp(join(tmpdir(), 'lancedb-fuzz-'))
let seed = 42
const seeded = bound => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % bound }
const tools = new Map()
const routes = new Map()
const ctx = {
  tools: { register: d => { tools.set(d.name, d); return () => {} } },
  provide: () => () => {}, effect: f => f(), get: () => undefined,
  inject: (_d, cb) => cb({ effect: f => f(), connection: { fetch: { register: r => { routes.set(r.path, r); return async () => {} } } } }),
}
apply(ctx, { directory: root, table: 'memories', embedding: { provider: 'hash', dimension: 128 } })
const call = (name, args, session = 'fa') => tools.get(name).execute(args, { signal: new AbortController().signal, agent: { id: session } })
const db = await connect(root)
const readRows = async () => {
  const names = await db.tableNames()
  if (!names.includes('memories')) return []
  const table = await db.openTable('memories')
  return table.query().select(['id', 'scope', 'text']).toArray()
}

const sessions = ['fa', 'fb']
const random = n => seeded(n)
const pick = list => list[random(list.length)]
let souls = []
const log = []

const createSoul = async name => {
  await call('lancedb_souls', { action: 'create', name, description: 'fuzz' })
  souls = (await call('lancedb_souls', { action: 'list' })).souls.map(soul => soul.name)
}
const freshName = prefix => {
  let index = 1
  while (souls.includes(`${prefix}-${index}`)) index += 1
  return `${prefix}-${index}`
}

await createSoul('base')
for (const session of sessions) await call('lancedb_attach', { souls: ['base'] }, session)

let counter = 0
const storeOne = async session => {
  const toSoul = souls.length > 0 && Math.random() < 0.4
  const soul = toSoul ? pick(souls) : undefined
  const text = `模糊测试笔记 ${counter} 号 ${['规则', '结果', '偏好'][random(3)]}`
  counter += 1
  return call('lancedb_store', { text, kind: ['note', 'rule'][random(2)], soul }, session)
}

const invariants = async () => {
  const rows = await readRows()
  const ids = rows.map(row => row.id)
  if (new Set(ids).size !== ids.length) throw new Error(`duplicate ids: ${ids.length} rows, ${new Set(ids).size} ids`)
  const stats = await call('lancedb_stats', {}, 'fa')
  if (stats.rows !== rows.length) throw new Error(`stats rows ${stats.rows} != table ${rows.length}`)
  const byScope = new Map()
  for (const row of rows) byScope.set(row.scope, (byScope.get(row.scope) ?? 0) + 1)
  for (const soul of stats.scopes.souls) {
    const actual = byScope.get(`soul:${soul.name}`) ?? 0
    if (actual !== soul.notes) throw new Error(`soul ${soul.name}: stats ${soul.notes} != rows ${actual}`)
  }
  for (const scope of byScope.keys()) {
    if (scope.startsWith('soul:')) {
      const name = scope.slice(5)
      if (!stats.scopes.souls.some(soul => soul.name === name)) throw new Error(`orphan soul scope ${scope}`)
    }
  }
  return stats
}

const operations = 120
for (let step = 0; step < operations; step += 1) {
  const session = pick(sessions)
  const roll = Math.random()
  try {
    if (roll < 0.34) {
      await storeOne(session)
    } else if (roll < 0.45) {
      const soul = pick(souls)
      const attach = Math.random() < 0.6
      await call('lancedb_attach', { souls: [soul], detach: !attach }, session)
    } else if (roll < 0.55) {
      const list = await call('lancedb_list', {}, session)
      const ids = list.memories.slice(0, 3).map(row => row.id)
      if (ids.length > 0) {
        const soul = pick(souls)
        await call('lancedb_promote', { ids, soul, move: Math.random() < 0.3 }, session)
      }
    } else if (roll < 0.63) {
      const from = pick(souls)
      await call('lancedb_souls', { action: 'copy', name: from, target: freshName(from) })
      souls = (await call('lancedb_souls', { action: 'list' })).souls.map(soul => soul.name)
    } else if (roll < 0.71) {
      const from = pick(souls)
      await call('lancedb_souls', { action: 'rename', name: from, target: freshName('ren' ) })
      souls = (await call('lancedb_souls', { action: 'list' })).souls.map(soul => soul.name)
    } else if (roll < 0.79) {
      if (souls.length >= 2) {
        const [left, right] = [pick(souls), pick(souls)]
        if (left !== right) {
          await call('lancedb_souls', { action: 'merge', sources: [left, right], target: freshName('merge'), semantic: false })
          souls = (await call('lancedb_souls', { action: 'list' })).souls.map(soul => soul.name)
        }
      }
    } else if (roll < 0.85) {
      if (souls.length > 1) {
        const victim = pick(souls)
        await call('lancedb_souls', { action: 'delete', name: victim, force: true })
        souls = (await call('lancedb_souls', { action: 'list' })).souls.map(soul => soul.name)
      }
    } else if (roll < 0.92) {
      const list = await call('lancedb_list', {}, session)
      if (list.memories.length > 0) {
        await call('lancedb_forget', { id: pick(list.memories).id }, session)
      }
    } else {
      const search = await call('lancedb_search', { query: '模糊测试', limit: 10 }, session)
      const scores = search.results.map(row => row.score)
      if (scores.some((score, index) => index > 0 && scores[index - 1] < score)) throw new Error('unsorted search results')
      if (search.results.some(row => row.scope.startsWith('session:') && !row.scope.endsWith(session))) {
        throw new Error('session isolation broken')
      }
    }
  } catch (error) {
    log.push(`op ${step} failed: ${error.message}`)
  }
  if (step % 7 === 0) await invariants()
}
const stats = await invariants()
if (log.length > 0) throw new Error(`fuzz operations failed:\n${log.join('\n')}`)
console.log(`dsh-lancedb-memory fuzz test: ok (${operations} ops, ${souls.length} souls, ${stats.rows} rows)`)
await db.close?.()
await rm(root, { recursive: true, force: true })
