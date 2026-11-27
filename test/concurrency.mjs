import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const { connect } = await import('@lancedb/lancedb')
const { apply } = await import('../index.js')

const root = await mkdtemp(join(tmpdir(), 'lancedb-conc-'))
const tools = new Map()
const ctx = {
  tools: { register: d => { tools.set(d.name, d); return () => {} } },
  provide: () => () => {}, effect: f => f(), get: () => undefined,
  inject: (_d, cb) => cb({ effect: f => f(), connection: { fetch: { register: () => async () => {} } } }),
}
apply(ctx, { directory: root, table: 'memories', embedding: { provider: 'hash', dimension: 128 } })
const call = (name, args, session = 'c1') => tools.get(name).execute(args, { signal: new AbortController().signal, agent: { id: session } })

await call('lancedb_souls', { action: 'create', name: 'x', description: 'x' })
await call('lancedb_souls', { action: 'create', name: 'y', description: 'y' })
await call('lancedb_store', { soul: 'y', text: '只有 y 有', kind: 'note' })

// 30 parallel stores
const stores = await Promise.all(Array.from({ length: 30 }, (_, index) =>
  call('lancedb_store', { text: `并发条目 ${index}`, kind: 'note' })))
if (new Set(stores.map(result => result.id)).size !== 30) throw new Error('store ids not unique')

// duplicate promote of the same ids
const list = await call('lancedb_list', {})
const ids = list.memories.slice(0, 5).map(row => row.id)
const promotes = await Promise.allSettled([
  call('lancedb_promote', { ids, soul: 'x' }),
  call('lancedb_promote', { ids, soul: 'x' }),
])
const promoteOk = promotes.filter(result => result.status === 'fulfilled').map(result => result.value)
const copiedTotal = promoteOk.reduce((sum, result) => sum + result.copied.length, 0)
if (copiedTotal !== 5) throw new Error(`promote copied ${copiedTotal}, expected 5`)
const xList = await call('lancedb_list', { soul: 'x' })
if (xList.memories.length !== 5) throw new Error(`x has ${xList.memories.length} rows after duplicate promote`)

// duplicate copy to the same target
const copies = await Promise.allSettled([
  call('lancedb_souls', { action: 'copy', name: 'x', target: 'x-copy' }),
  call('lancedb_souls', { action: 'copy', name: 'x', target: 'x-copy' }),
])
if (copies.filter(result => result.status === 'fulfilled').length !== 1) throw new Error('copy race did not settle to one winner')
const copyList = await call('lancedb_list', { soul: 'x-copy' })
if (copyList.memories.length !== 5) throw new Error(`copy has ${copyList.memories.length} rows`)

// duplicate rename of the same soul to two targets
const renames = await Promise.allSettled([
  call('lancedb_souls', { action: 'rename', name: 'x', target: 'r1' }),
  call('lancedb_souls', { action: 'rename', name: 'x', target: 'r2' }),
])
if (renames.filter(result => result.status === 'fulfilled').length !== 1) throw new Error('rename race did not settle to one winner')
const catalog = await call('lancedb_souls', { action: 'list' })
const renamed = catalog.souls.filter(soul => soul.name === 'r1' || soul.name === 'r2')
if (renamed.length !== 1) throw new Error(`expected one renamed soul, got ${renamed.map(soul => soul.name)}`)
const sourceGone = catalog.souls.some(soul => soul.name === 'x')
if (sourceGone) throw new Error('source still present after rename')

// duplicate merge into the same target
await Promise.allSettled([
  call('lancedb_souls', { action: 'merge', sources: ['y'], target: 'm', semantic: false }),
  call('lancedb_souls', { action: 'merge', sources: ['y'], target: 'm', semantic: false }),
])
const mergedList = await call('lancedb_list', { soul: 'm' })
const mergedIds = mergedList.memories.map(row => row.id)
if (new Set(mergedIds).size !== mergedIds.length) throw new Error('duplicate ids in merged soul')
if (mergedList.memories.length !== 1) throw new Error(`merged soul has ${mergedList.memories.length} rows`)

// duplicate delete
const deletes = await Promise.allSettled([
  call('lancedb_souls', { action: 'delete', name: 'y', force: true }),
  call('lancedb_souls', { action: 'delete', name: 'y', force: true }),
])
if (deletes.filter(result => result.status === 'fulfilled').length !== 1) throw new Error('delete race did not settle to one winner')

const db = await connect(root)
const table = await db.openTable('memories')
const rows = await table.query().select(['id']).toArray()
if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('duplicate ids in table')
console.log(`dsh-lancedb-memory concurrency test: ok (${rows.length} rows, ${new Set(rows.map(row => row.id)).size} ids)`)
await db.close?.()
await rm(root, { recursive: true, force: true })
