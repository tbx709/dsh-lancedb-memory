/**
 * Browser half of dsh-lancedb-memory.
 *
 * Renders one compact strip inside the composer dock listing every soul of the
 * memory store. Clicking a chip attaches or detaches that soul for the current
 * session, which is exactly what `lancedb_attach` does for the agent.
 *
 * The strip talks to the host through two owner-only routes mounted on the
 * authenticated /api carrier; it owns no state beyond the current response.
 */

window.__ModuleLoader__.load({
  id: 'dsh-lancedb-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-lancedb-memory'
    const SOULS_ROUTE = '/api/lancedb/souls'
    const ATTACH_ROUTE = '/api/lancedb/attach'
    const FALLBACK = {
      label: 'Souls',
      loading: '加载中…',
      empty: '还没有 soul，让 agent 用 lancedb_souls 建一个',
      retry: '重试',
      failed: '读取失败',
    }

    const CSS = `
.dsh-ldb-souls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 6px 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-ldb-souls-label { font-weight: 500; margin-right: 2px; }
.dsh-ldb-souls-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 220px;
  padding: 2px 9px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  cursor: pointer;
}
.dsh-ldb-souls-chip:hover {
  border-color: var(--dsw-alias-border-l2);
  color: var(--dsw-alias-label-primary);
}
.dsh-ldb-souls-chip[aria-pressed="true"] {
  border-color: var(--dsw-alias-brand-primary);
  color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
}
.dsh-ldb-souls-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-ldb-souls-chip:disabled { opacity: .6; cursor: progress; }
.dsh-ldb-souls-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ldb-souls-count { opacity: .6; font-variant-numeric: tabular-nums; }
.dsh-ldb-souls-muted { opacity: .8; }
.dsh-ldb-souls-error { color: var(--dsw-alias-state-error-primary); }
.dsh-ldb-souls-retry {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
`

    /**
     * POST JSON to one host route and decode its JSON answer.
     * @param {string} route - Absolute path on this origin.
     * @param {object} body - Request body.
     * @returns Parsed response.
     */
    async function post(route, body) {
      const response = await fetch(route, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : `HTTP ${response.status}`)
      return data
    }

    /**
     * One strip under the composer: every soul, with its attachment state.
     * @param {object} props - Slot props; `sessionId` identifies the session.
     * @returns React element or null without a session.
     */
    function SoulStrip(props) {
      const sessionId = props.sessionId
      const translate = typeof props.t === 'function' ? props.t : key => FALLBACK[key] ?? key
      const [state, setState] = React.useState({ status: 'loading', souls: [], attached: [], error: undefined })
      const [pending, setPending] = React.useState(undefined)

      const load = React.useCallback(() => {
        if (sessionId === undefined) return
        setState(previous => ({ ...previous, status: 'loading', error: undefined }))
        post(SOULS_ROUTE, { sessionId }).then(
          data => setState({ status: 'ready', souls: data.souls ?? [], attached: data.attached ?? [], error: undefined }),
          error => setState(previous => ({ ...previous, status: 'error', error: error.message })),
        )
      }, [sessionId])

      React.useEffect(() => { load() }, [load])

      const toggle = name => {
        if (pending !== undefined || sessionId === undefined) return
        setPending(name)
        const detach = state.attached.includes(name)
        post(ATTACH_ROUTE, { sessionId, souls: [name], detach }).then(
          data => setState(previous => ({ ...previous, attached: data.attached ?? [], error: undefined })),
          error => setState(previous => ({ ...previous, error: error.message })),
        ).finally(() => setPending(undefined))
      }

      if (sessionId === undefined) return null

      const children = [
        h('style', { key: 'style' }, CSS),
        h('span', { key: 'label', className: 'dsh-ldb-souls-label' }, translate('label')),
      ]
      if (state.status === 'loading' && state.souls.length === 0) {
        children.push(h('span', { key: 'loading', className: 'dsh-ldb-souls-muted' }, translate('loading')))
      } else if (state.status === 'error') {
        children.push(h('span', { key: 'error', className: 'dsh-ldb-souls-error' }, state.error ?? translate('failed')))
        children.push(h('button', { key: 'retry', type: 'button', className: 'dsh-ldb-souls-retry', onClick: load }, translate('retry')))
      } else if (state.souls.length === 0) {
        children.push(h('span', { key: 'empty', className: 'dsh-ldb-souls-muted' }, translate('empty')))
      } else {
        for (const soul of state.souls) {
          const attached = state.attached.includes(soul.name)
          children.push(h('button', {
            key: soul.name,
            type: 'button',
            className: 'dsh-ldb-souls-chip',
            'aria-pressed': attached,
            'aria-label': soul.description ? `${soul.name}: ${soul.description}` : soul.name,
            title: soul.description === undefined || soul.description.length === 0 ? soul.name : soul.description,
            disabled: pending === soul.name,
            onClick: () => toggle(soul.name),
          },
          h('span', { className: 'dsh-ldb-souls-name' }, soul.name),
          h('span', { className: 'dsh-ldb-souls-count' }, String(soul.notes ?? 0))))
        }
        if (state.error !== undefined) {
          children.push(h('span', { key: 'stale-error', className: 'dsh-ldb-souls-error' }, state.error))
        }
      }

      return h('div', { className: 'dsh-ldb-souls', role: 'group', 'aria-label': translate('label') }, children)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale')
        if (locale !== undefined && typeof locale.register === 'function') {
          const dictionaries = {
            zh: {
              label: 'Souls',
              loading: '加载中…',
              empty: '还没有 soul，让 agent 用 lancedb_souls 建一个',
              retry: '重试',
              failed: '读取失败',
            },
            en: {
              label: 'Souls',
              loading: 'Loading…',
              empty: 'No souls yet — ask the agent to create one with lancedb_souls',
              retry: 'Retry',
              failed: 'Could not load souls',
            },
          }
          try {
            ctx.effect(() => locale.register(NS, dictionaries), 'lancedb-memory: soul strip copy')
          } catch {
            // A locale registry rejection must not hide the strip; fallback copy renders.
          }
        }
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'lancedb-souls',
          order: 2,
          locale: NS,
        }, SoulStrip))
      },
    }
  },
})
