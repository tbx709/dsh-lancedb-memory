/**
 * Browser half of dsh-lancedb-memory.
 *
 * Renders one strip inside the composer dock. The collapsed row shows only the
 * souls attached to the current session plus a picker toggle, so a store with
 * dozens of souls never grows the composer. Expanding shows the picker: a
 * filter box, a scrollable list, and per-soul note previews so the user can
 * read what a soul actually remembers before using it.
 *
 * The strip talks to the host through owner-only routes mounted on the
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
    const NOTES_ROUTE = '/api/lancedb/notes'
    const DELETE_ROUTE = '/api/lancedb/delete'
    const RESTORE_ROUTE = '/api/lancedb/restore'
    /** Attached chips beyond this collapse into a "+N" marker. */
    const MAX_ATTACHED_CHIPS = 8
    /** The filter box only appears once the list is worth filtering. */
    const FILTER_THRESHOLD = 6
    /** Notes fetched per preview. */
    const NOTES_LIMIT = 50

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
      view: '查看',
      hide: '收起',
      notesLoading: '读取中…',
      notesEmpty: '这个 soul 还没有内容',
      notesFailed: '读取失败',
      showing: '只显示前 {n} 条',
      deleteNote: '删除这条',
      deleted: '已删除',
      undo: '撤销',
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
.dsh-ldb-souls-list { display: flex; flex-direction: column; gap: 2px; max-height: 320px; overflow-y: auto; }
.dsh-ldb-souls-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 5px 8px;
  border: 1px solid transparent;
  border-radius: 8px;
}
.dsh-ldb-souls-item:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-ldb-souls-item-row { display: flex; align-items: center; gap: 8px; }
.dsh-ldb-souls-item-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.dsh-ldb-souls-item-main:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; }
.dsh-ldb-souls-item-main[aria-pressed="true"] { color: var(--dsw-alias-brand-primary); }
.dsh-ldb-souls-item-main:disabled { opacity: .6; cursor: progress; }
.dsh-ldb-souls-item-head { display: flex; align-items: baseline; gap: 6px; }
.dsh-ldb-souls-item-name { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-ldb-souls-item-desc {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: .75;
}
.dsh-ldb-souls-item-preview {
  flex: none;
  padding: 2px 7px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
}
.dsh-ldb-souls-item-preview:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.dsh-ldb-souls-item-preview[aria-expanded="true"] { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-ldb-souls-notes {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 2px 0 6px 2px;
  padding-left: 8px;
  border-left: 2px solid var(--dsw-alias-border-l1);
}
.dsh-ldb-souls-note { display: flex; flex-direction: column; gap: 2px; }
.dsh-ldb-souls-note-meta { display: flex; gap: 8px; opacity: .7; }
.dsh-ldb-souls-note-kind { font-weight: 500; }
.dsh-ldb-souls-note-text { white-space: pre-wrap; word-break: break-word; }
.dsh-ldb-souls-note-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-ldb-souls-note-delete {
  flex: none;
  padding: 0 5px;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
  opacity: .55;
}
.dsh-ldb-souls-note-delete:hover { color: var(--dsw-alias-state-error-primary); opacity: 1; }
.dsh-ldb-souls-note-delete:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-ldb-souls-note-delete:disabled { opacity: .3; cursor: progress; }
.dsh-ldb-souls-undo {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border: 1px dashed var(--dsw-alias-border-l1);
  border-radius: 6px;
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
     * Readable date for a stored timestamp.
     * @param {unknown} value - Epoch milliseconds.
     * @returns Local date text, or empty for a bad value.
     */
    function dateText(value) {
      const time = Number(value)
      return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleDateString() : ''
    }

    /**
     * One soul's notes inside the picker, each with a one-click delete.
     * @param {{ name?: string, status: string, notes: Array, total: number, error?: string }} preview - Preview state.
     * @param {Function} t - Bound copy.
     * @param {object} ui - Deleting id, last deletion, and callbacks.
     * @returns React element.
     */
    function NotePreview(preview, t, ui) {
      if (preview.status === 'loading') {
        return h('div', { className: 'dsh-ldb-souls-muted' }, t('notesLoading'))
      }
      if (preview.status === 'error') {
        return h('div', { className: 'dsh-ldb-souls-error' }, preview.error ?? t('notesFailed'))
      }
      if (preview.notes.length === 0) {
        return h('div', { className: 'dsh-ldb-souls-muted' }, t('notesEmpty'))
      }
      const undoable = ui.lastDeleted !== undefined && ui.lastDeleted.soul === preview.name
      return h('div', { className: 'dsh-ldb-souls-notes' },
        preview.notes.map(note => h('article', { key: note.id, className: 'dsh-ldb-souls-note' },
          h('div', { className: 'dsh-ldb-souls-note-head' },
            h('div', { className: 'dsh-ldb-souls-note-meta' },
              h('span', { className: 'dsh-ldb-souls-note-kind' }, note.kind),
              h('time', null, dateText(note.createdAt))),
            h('button', {
              type: 'button',
              className: 'dsh-ldb-souls-note-delete',
              'aria-label': t('deleteNote'),
              title: t('deleteNote'),
              disabled: ui.deleting === note.id,
              onClick: () => ui.onDelete(note),
            }, '\u00d7')),
          h('div', { className: 'dsh-ldb-souls-note-text' }, note.text))),
        undoable
          ? h('div', { className: 'dsh-ldb-souls-undo' },
            h('span', null, t('deleted')),
            h('button', { type: 'button', className: 'dsh-ldb-souls-link', onClick: ui.onUndo }, t('undo')))
          : null,
        preview.total > preview.notes.length
          ? h('div', { className: 'dsh-ldb-souls-muted' }, fill(t('showing'), preview.notes.length))
          : null)
    }

    /**
     * Pure presentation: attached chips, the picker panel, and note previews.
     * @param {object} props - Souls, attachment state, preview state, callbacks.
     * @returns React element.
     */
    function SoulStripView(props) {
      const { souls, attached, status, error, expanded, query, pending, preview, deleting, lastDeleted, t } = props
      const attachedSouls = souls.filter(soul => attached.includes(soul.name))
      const shown = attachedSouls.slice(0, MAX_ATTACHED_CHIPS)
      const hidden = attachedSouls.length - shown.length
      const needle = query.trim().toLowerCase()
      const matches = needle.length === 0
        ? souls
        : souls.filter(soul => `${soul.name} ${soul.description ?? ''}`.toLowerCase().includes(needle))
      const openName = preview.name

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
          }, h('span', { className: 'dsh-ldb-souls-name' }, soul.name)))
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
          const isOpen = openName === soul.name
          const description = soul.description === undefined || soul.description.length === 0 ? '\u00a0' : soul.description
          return h('div', { key: soul.name, className: 'dsh-ldb-souls-item' },
            h('div', { className: 'dsh-ldb-souls-item-row' },
              h('button', {
                type: 'button',
                className: 'dsh-ldb-souls-item-main',
                'aria-pressed': isAttached,
                disabled: pending === soul.name,
                onClick: () => props.onToggle(soul.name, !isAttached),
              },
              h('span', { className: 'dsh-ldb-souls-item-head' },
                h('span', { className: 'dsh-ldb-souls-item-name' }, soul.name),
                h('span', { className: 'dsh-ldb-souls-count' }, fill(t('notes'), soul.notes ?? 0))),
              h('span', { className: 'dsh-ldb-souls-item-desc' }, description)),
              h('button', {
                type: 'button',
                className: 'dsh-ldb-souls-item-preview',
                'aria-expanded': isOpen,
                onClick: () => props.onNotes(soul.name),
              }, isOpen ? t('hide') : t('view'))),
            isOpen
              ? NotePreview(preview, t, {
                deleting,
                lastDeleted,
                onDelete: props.onDelete,
                onUndo: props.onUndo,
              })
              : null)
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
     * Stateful strip: fetch the catalog, toggle attachments, preview notes.
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
      const [preview, setPreview] = React.useState({ name: undefined, status: 'idle', notes: [], total: 0 })
      const [deleting, setDeleting] = React.useState(undefined)
      const [lastDeleted, setLastDeleted] = React.useState(undefined)

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

      const loadNotes = React.useCallback(name => {
        post(NOTES_ROUTE, { soul: name, limit: NOTES_LIMIT }).then(
          data => setPreview(previous => previous.name === name
            ? { name, status: 'ready', notes: data.memories ?? [], total: data.total ?? 0 }
            : previous),
          error => setPreview(previous => previous.name === name
            ? { name, status: 'error', notes: [], total: 0, error: error.message }
            : previous),
        )
      }, [])

      const showNotes = name => {
        if (preview.name === name) {
          setPreview({ name: undefined, status: 'idle', notes: [], total: 0 })
          setLastDeleted(undefined)
          return
        }
        setPreview({ name, status: 'loading', notes: [], total: 0 })
        loadNotes(name)
      }

      const deleteNote = note => {
        const soul = preview.name
        if (deleting !== undefined || soul === undefined) return
        setDeleting(note.id)
        post(DELETE_ROUTE, { soul, id: note.id }).then(result => {
          if (result.deleted !== true) throw new Error('这条已经不在了')
          setPreview(previous => previous.name === soul
            ? { ...previous, notes: previous.notes.filter(item => item.id !== note.id), total: Math.max(0, previous.total - 1) }
            : previous)
          setLastDeleted({ soul, note })
        }).catch(error => setState(previous => ({ ...previous, error: error.message })))
          .finally(() => setDeleting(undefined))
      }

      const undoDelete = () => {
        if (lastDeleted === undefined) return
        const { soul, note } = lastDeleted
        post(RESTORE_ROUTE, {
          soul,
          text: note.text,
          kind: note.kind,
          metadata: note.metadata,
          importance: note.importance,
        }).then(() => {
          setLastDeleted(undefined)
          loadNotes(soul)
        }).catch(error => setState(previous => ({ ...previous, error: error.message })))
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
        preview,
        deleting,
        lastDeleted,
        t: translate,
        onRetry: load,
        onExpand: () => {
          if (expanded) setLastDeleted(undefined)
          setExpanded(!expanded)
        },
        onQuery: setQuery,
        onToggle: toggle,
        onNotes: showNotes,
        onDelete: deleteNote,
        onUndo: undoDelete,
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
              view: '查看',
              hide: '收起',
              notesLoading: '读取中…',
              notesEmpty: '这个 soul 还没有内容',
              notesFailed: '读取失败',
              showing: '只显示前 {n} 条',
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
              view: 'View',
              hide: 'Hide',
              notesLoading: 'Loading…',
              notesEmpty: 'This soul has no notes yet',
              notesFailed: 'Could not load notes',
              showing: 'Showing the first {n}',
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
