/**
 * Browser half of dsh-lancedb-memory.
 *
 * Renders one strip inside the composer dock. The collapsed row shows only the
 * souls attached to the current session plus a picker toggle, so a store with
 * dozens of souls never grows the composer. Expanding shows the full picker:
 * a filter box and a scrollable list with description and note count.
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
    /** Attached chips beyond this collapse into a "+N" marker. */
    const MAX_ATTACHED_CHIPS = 8
    /** The filter box only appears once the list is worth filtering. */
    const FILTER_THRESHOLD = 6

    const FALLBACK = {
      label: 'Souls',
      loading: '加载中…',
      empty: '还没有 soul，让 agent 用 lancedb_souls 建一个',
      retry: '重试',
      failed: '读取失败',
      none: '未挂载',
      choose: '选择',
      collapse: '收起',
      filter: '筛选 soul',
      noMatch: '没有匹配的 soul',
      more: '还有 {n} 个',
      notes: '{n} 条',
    }

    const CSS = `
.dsh-ldb-souls {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 6px 6px 2px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.dsh-ldb-souls-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.dsh-ldb-souls-label { font-weight: 500; margin-right: 2px; }
.dsh-ldb-souls-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 200px;
  padding: 2px 9px;
  border: 1px solid var(--dsw-alias-brand-primary);
  border-radius: 999px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
  color: var(--dsw-alias-brand-primary);
  font: inherit;
  cursor: pointer;
}
.dsh-ldb-souls-chip:hover { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 20%, transparent); }
.dsh-ldb-souls-chip:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-ldb-souls-chip:disabled { opacity: .6; cursor: progress; }
.dsh-ldb-souls-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ldb-souls-count { opacity: .6; font-variant-numeric: tabular-nums; }
.dsh-ldb-souls-muted { opacity: .8; }
.dsh-ldb-souls-error { color: var(--dsw-alias-state-error-primary); }
.dsh-ldb-souls-link {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-decoration: underline;
  cursor: pointer;
}
.dsh-ldb-souls-toggle {
  margin-left: auto;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  cursor: pointer;
}
.dsh-ldb-souls-toggle:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.dsh-ldb-souls-toggle[aria-expanded="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-ldb-souls-panel {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 10px;
  background: var(--dsw-alias-bg-overlay);
}
.dsh-ldb-souls-filter {
  box-sizing: border-box;
  width: 100%;
  padding: 4px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  font: inherit;
}
.dsh-ldb-souls-filter:focus { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; }
.dsh-ldb-souls-list { display: flex; flex-direction: column; gap: 2px; max-height: 220px; overflow-y: auto; }
.dsh-ldb-souls-item {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh-ldb-souls-item:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-ldb-souls-item:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; }
.dsh-ldb-souls-item[aria-pressed="true"] {
  border-color: var(--dsw-alias-brand-primary);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent);
  color: var(--dsw-alias-brand-primary);
}
.dsh-ldb-souls-item:disabled { opacity: .6; cursor: progress; }
.dsh-ldb-souls-item-head { display: flex; align-items: baseline; gap: 6px; }
.dsh-ldb-souls-item-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ldb-souls-item-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: .75;
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
     * Interpolate the one placeholder the copy uses.
     * @param {string} template - Copy with `{n}`.
     * @param {number} value - Replacement.
     * @returns Text.
     */
    function fill(template, value) {
      return template.replace('{n}', String(value))
    }

    /**
     * Pure presentation: attached chips plus the optional picker panel.
     * @param {object} props - Souls, attachment state, and callbacks.
     * @returns React element.
     */
    function SoulStripView(props) {
      const { souls, attached, status, error, expanded, query, pending, t } = props
      const attachedSouls = souls.filter(soul => attached.includes(soul.name))
      const shown = attachedSouls.slice(0, MAX_ATTACHED_CHIPS)
      const hidden = attachedSouls.length - shown.length
      const needle = query.trim().toLowerCase()
      const matches = needle.length === 0
        ? souls
        : souls.filter(soul => `${soul.name} ${soul.description ?? ''}`.toLowerCase().includes(needle))

      const row = [
        h('span', { key: 'label', className: 'dsh-ldb-souls-label' }, t('label')),
      ]

      if (status === 'loading' && souls.length === 0) {
        row.push(h('span', { key: 'loading', className: 'dsh-ldb-souls-muted' }, t('loading')))
      } else if (status === 'error') {
        row.push(h('span', { key: 'err', className: 'dsh-ldb-souls-error' }, error ?? t('failed')))
        row.push(h('button', { key: 'retry', type: 'button', className: 'dsh-ldb-souls-link', onClick: props.onRetry }, t('retry')))
      } else if (souls.length === 0) {
        row.push(h('span', { key: 'empty', className: 'dsh-ldb-souls-muted' }, t('empty')))
      } else {
        if (shown.length === 0) {
          row.push(h('span', { key: 'none', className: 'dsh-ldb-souls-muted' }, t('none')))
        }
        for (const soul of shown) {
          row.push(h('button', {
            key: soul.name,
            type: 'button',
            className: 'dsh-ldb-souls-chip',
            title: soul.description === undefined || soul.description.length === 0 ? soul.name : soul.description,
            disabled: pending === soul.name,
            onClick: () => props.onToggle(soul.name, false),
          },
          h('span', { className: 'dsh-ldb-souls-name' }, soul.name),
          h('span', { className: 'dsh-ldb-souls-count' }, String(soul.notes ?? 0))))
        }
        if (hidden > 0) {
          row.push(h('span', { key: 'more', className: 'dsh-ldb-souls-muted' }, fill(t('more'), hidden)))
        }
        row.push(h('button', {
          key: 'toggle',
          type: 'button',
          className: 'dsh-ldb-souls-toggle',
          'aria-expanded': expanded,
          onClick: props.onExpand,
        }, expanded ? t('collapse') : `${t('choose')} (${souls.length})`))
      }

      if (error !== undefined && status === 'ready') {
        row.push(h('span', { key: 'stale', className: 'dsh-ldb-souls-error' }, error))
      }

      const children = [
        h('style', { key: 'style' }, CSS),
        h('div', { key: 'row', className: 'dsh-ldb-souls-row' }, row),
      ]

      if (expanded && status === 'ready' && souls.length > 0) {
        const panel = []
        if (souls.length > FILTER_THRESHOLD) {
          panel.push(h('input', {
            key: 'filter',
            className: 'dsh-ldb-souls-filter',
            type: 'search',
            value: query,
            placeholder: t('filter'),
            'aria-label': t('filter'),
            onChange: event => props.onQuery(event.target.value),
            onKeyDown: event => { if (event.key === 'Escape') props.onExpand() },
          }))
        }
        const items = matches.map(soul => {
          const isAttached = attached.includes(soul.name)
          return h('button', {
            key: soul.name,
            type: 'button',
            className: 'dsh-ldb-souls-item',
            'aria-pressed': isAttached,
            disabled: pending === soul.name,
            onClick: () => props.onToggle(soul.name, !isAttached),
          },
          h('span', { className: 'dsh-ldb-souls-item-head' },
            h('span', { className: 'dsh-ldb-souls-item-name' }, soul.name),
            h('span', { className: 'dsh-ldb-souls-count' }, fill(t('notes'), soul.notes ?? 0))),
          h('span', { className: 'dsh-ldb-souls-item-desc' },
            soul.description === undefined || soul.description.length === 0 ? '\u00a0' : soul.description))
        })
        panel.push(h('div', { key: 'list', className: 'dsh-ldb-souls-list' },
          matches.length === 0
            ? h('span', { key: 'no-match', className: 'dsh-ldb-souls-muted' }, t('noMatch'))
            : items))
        children.push(h('div', { key: 'panel', className: 'dsh-ldb-souls-panel', role: 'region', 'aria-label': t('label') }, panel))
      }

      return h('div', { className: 'dsh-ldb-souls', role: 'group', 'aria-label': t('label') }, children)
    }

    /**
     * Stateful strip: fetch the catalog, toggle attachments, own the panel.
     * @param {object} props - Slot props; `sessionId` identifies the session.
     * @returns React element or null without a session.
     */
    function SoulStrip(props) {
      const sessionId = props.sessionId
      const translate = typeof props.t === 'function' ? props.t : key => FALLBACK[key] ?? key
      const [state, setState] = React.useState({ status: 'loading', souls: [], attached: [], error: undefined })
      const [pending, setPending] = React.useState(undefined)
      const [expanded, setExpanded] = React.useState(false)
      const [query, setQuery] = React.useState('')

      const load = React.useCallback(() => {
        if (sessionId === undefined) return
        setState(previous => ({ ...previous, status: 'loading', error: undefined }))
        post(SOULS_ROUTE, { sessionId }).then(
          data => setState({ status: 'ready', souls: data.souls ?? [], attached: data.attached ?? [], error: undefined }),
          error => setState(previous => ({ ...previous, status: 'error', error: error.message })),
        )
      }, [sessionId])

      React.useEffect(() => { load() }, [load])

      const toggle = (name, wantAttached) => {
        if (pending !== undefined || sessionId === undefined) return
        setPending(name)
        post(ATTACH_ROUTE, { sessionId, souls: [name], detach: !wantAttached }).then(
          data => setState(previous => ({ ...previous, attached: data.attached ?? [], error: undefined })),
          error => setState(previous => ({ ...previous, error: error.message })),
        ).finally(() => setPending(undefined))
      }

      if (sessionId === undefined) return null

      return h(SoulStripView, {
        souls: state.souls,
        attached: state.attached,
        status: state.status,
        error: state.error,
        expanded,
        query,
        pending,
        t: translate,
        onRetry: load,
        onExpand: () => setExpanded(value => !value),
        onQuery: setQuery,
        onToggle: toggle,
      })
    }

    // The pure view is exposed for headless verification without a browser.
    SoulStrip.View = SoulStripView

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
              none: '未挂载',
              choose: '选择',
              collapse: '收起',
              filter: '筛选 soul',
              noMatch: '没有匹配的 soul',
              more: '还有 {n} 个',
              notes: '{n} 条',
            },
            en: {
              label: 'Souls',
              loading: 'Loading…',
              empty: 'No souls yet — ask the agent to create one with lancedb_souls',
              retry: 'Retry',
              failed: 'Could not load souls',
              none: 'None attached',
              choose: 'Choose',
              collapse: 'Close',
              filter: 'Filter souls',
              noMatch: 'No matching soul',
              more: '+{n} more',
              notes: '{n} notes',
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
