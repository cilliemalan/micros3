// The Objects tab (U17): one level of a bucket under the route's prefix.
// A breadcrumb for the prefix, a filter on the start of names (sent to the
// server, so it works across pages), and a table of folders and objects
// with checkboxes, paged with "Load more". The page keys it on the
// prefix, so a new folder starts with no filter and no selection.

import { useEffect, useState } from "react"
import { Button } from "@ui-sdk/react/button"
import { Checkbox, CheckboxGroup, CheckboxIndicator } from "@ui-sdk/react/checkbox"
import { Field, FieldLabel } from "@ui-sdk/react/field"
import { Input, InputClear, InputGroup } from "@ui-sdk/react/input"
import { api, isApiError } from "../api"
import { formatSize } from "../format"
import {
  PAGE_SIZE,
  countText,
  displayEtag,
  emptyText,
  entryName,
  listPrefix,
  mergeRows,
  pageRows,
  type Rows,
} from "../objects"
import { bucketRoute, routeHash } from "../route"
import { Breadcrumb } from "./Breadcrumb"
import { FileIcon, FolderIcon, RefreshIcon, SearchIcon } from "./Icons"
import { Time } from "./Time"
import { notifyError } from "./Toasts"

/** How long typing in the filter waits before listing again. */
const FILTER_DELAY_MS = 250

type State = Rows & {
  /** The `after` value for the next page; absent on the last page. */
  next?: string
  loading: boolean
  error?: unknown
}

const EMPTY: State = { folders: [], objects: [], loading: true }

export function ObjectsTab({ bucket, prefix }: { bucket: string; prefix: string }) {
  const [filterText, setFilterText] = useState("")
  const [filter, setFilter] = useState("")
  const [state, setState] = useState<State>(EMPTY)
  const [reloads, setReloads] = useState(0)
  const [selected, setSelected] = useState<string[]>([])

  useEffect(() => {
    const timer = window.setTimeout(() => setFilter(filterText), FILTER_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [filterText])

  useEffect(() => {
    let live = true
    setState(EMPTY)
    setSelected([])
    api.listObjects(bucket, { prefix: listPrefix(prefix, filter), limit: PAGE_SIZE }).then(
      (page) => live && setState({ ...pageRows(page, prefix), next: page.next, loading: false }),
      (error) => live && setState({ ...EMPTY, loading: false, error }),
    )
    return () => {
      live = false
    }
  }, [bucket, prefix, filter, reloads])

  async function loadMore() {
    if (!state.next || state.loading) return
    setState((s) => ({ ...s, loading: true }))
    try {
      const page = await api.listObjects(bucket, {
        prefix: listPrefix(prefix, filter),
        after: state.next,
        limit: PAGE_SIZE,
      })
      setState((s) => ({ ...mergeRows(s, pageRows(page, prefix)), next: page.next, loading: false }))
    } catch (error) {
      setState((s) => ({ ...s, loading: false }))
      notifyError("Could not load more objects", error)
    }
  }

  const reload = () => setReloads((n) => n + 1)
  const { folders, objects, next, loading, error } = state
  const firstLoad = loading && folders.length === 0 && objects.length === 0
  const missing = isApiError(error, "NoSuchBucket")

  if (missing) {
    return (
      <div className="empty" role="alert">
        <p>The bucket "{bucket}" no longer exists.</p>
        <a href="#/">Back to buckets</a>
      </div>
    )
  }

  return (
    <div className="stack">
      <Breadcrumb bucket={bucket} prefix={prefix} />
      <div className="toolbar">
        <Field className="object-filter">
          <FieldLabel className="sr-only">Filter by name</FieldLabel>
          <InputGroup>
            <SearchIcon />
            <Input
              type="search"
              placeholder="Filter by name prefix"
              value={filterText}
              onValueChange={setFilterText}
              spellCheck={false}
              autoComplete="off"
            />
            <InputClear aria-label="Clear filter" />
          </InputGroup>
        </Field>
        <p className="muted" aria-live="polite">
          {firstLoad || error
            ? ""
            : selected.length > 0
              ? `${selected.length} selected of ${countText(state, Boolean(next))}`
              : countText(state, Boolean(next))}
        </p>
        <div className="spacer" />
        <Button onClick={reload} disabled={loading}>
          <RefreshIcon /> Refresh
        </Button>
      </div>
      {error ? (
        <div className="empty" role="alert">
          <p>Could not list the objects.</p>
          <p className="muted">{isApiError(error) ? `${error.message} (${error.code})` : String(error)}</p>
          <Button onClick={reload}>Try again</Button>
        </div>
      ) : firstLoad ? (
        <p className="muted">Loading…</p>
      ) : folders.length === 0 && objects.length === 0 ? (
        <div className="empty">
          <p>{emptyText(prefix, filter)}</p>
          {filter && <Button onClick={() => setFilterText("")}>Clear filter</Button>}
        </div>
      ) : (
        <>
          <CheckboxGroup
            value={selected}
            onValueChange={setSelected}
            allValues={objects.map((o) => o.key)}
            aria-label="Selected objects"
          >
            <table className="table objects-table">
              <thead>
                <tr>
                  <th scope="col" className="select">
                    {objects.length > 0 && (
                      <Checkbox parent aria-label="Select all objects shown">
                        {/* No icon of ours: web.css draws the check, or the dash when some are selected. */}
                        <CheckboxIndicator />
                      </Checkbox>
                    )}
                  </th>
                  <th scope="col">Name</th>
                  <th scope="col" className="num">
                    Size
                  </th>
                  <th scope="col">Last modified</th>
                  <th scope="col">ETag</th>
                </tr>
              </thead>
              <tbody>
                {folders.map((folder) => (
                  <tr key={`f:${folder}`} className="folder-row">
                    <td className="select" />
                    <td className="mono key-cell">
                      <a href={routeHash(bucketRoute(bucket, "objects", folder))} className="entry">
                        <FolderIcon />
                        <span>{entryName(folder, prefix)}</span>
                      </a>
                    </td>
                    <td className="num muted">—</td>
                    <td className="muted">—</td>
                    <td className="muted">—</td>
                  </tr>
                ))}
                {objects.map((object) => {
                  const name = entryName(object.key, prefix)
                  return (
                    <tr key={`o:${object.key}`}>
                      <td className="select">
                        <Checkbox value={object.key} aria-label={`Select ${name}`}>
                          <CheckboxIndicator />
                        </Checkbox>
                      </td>
                      <td className="mono key-cell">
                        <span className="entry" title={object.key}>
                          <FileIcon />
                          <span>{name}</span>
                        </span>
                      </td>
                      <td className="num" title={`${object.size.toLocaleString()} bytes`}>
                        {formatSize(object.size)}
                      </td>
                      <td className="nowrap">
                        <Time iso={object.lastModified} />
                      </td>
                      <td className="mono truncate etag" title={displayEtag(object.etag)}>
                        {displayEtag(object.etag)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </CheckboxGroup>
          {next && (
            <div className="row center">
              <Button onClick={() => void loadMore()} disabled={loading}>
                {loading ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
