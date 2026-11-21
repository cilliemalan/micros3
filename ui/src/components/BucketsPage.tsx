// The Buckets screen (U15): every bucket with its region and creation time.

import { Button } from "@ui-sdk/react/button"
import { bucketRoute, routeHash } from "../route"
import type { BucketsState } from "../useBuckets"
import { isApiError } from "../api"
import { PlusIcon, RefreshIcon, TrashIcon } from "./Icons"
import { Time } from "./Time"

export function BucketsPage({
  state,
  onNewBucket,
  onDelete,
}: {
  state: BucketsState
  onNewBucket: () => void
  onDelete: (bucket: string) => void
}) {
  const { buckets, error, loading } = state
  return (
    <section className="page" aria-labelledby="page-title">
      <div className="toolbar">
        <p className="muted">
          {buckets ? `${buckets.length} ${buckets.length === 1 ? "bucket" : "buckets"}` : ""}
        </p>
        <div className="spacer" />
        <Button onClick={() => void state.reload()} disabled={loading}>
          <RefreshIcon /> Refresh
        </Button>
        <Button data-variant="solid" onClick={onNewBucket}>
          <PlusIcon /> New bucket
        </Button>
      </div>
      {buckets === null ? (
        error ? (
          <div className="empty" role="alert">
            <p>Could not load buckets.</p>
            <p className="muted">{isApiError(error) ? `${error.message} (${error.code})` : String(error)}</p>
            <Button onClick={() => void state.reload()}>Try again</Button>
          </div>
        ) : (
          <p className="muted">Loading…</p>
        )
      ) : buckets.length === 0 ? (
        <div className="empty">
          <p>There are no buckets yet.</p>
          <Button data-variant="solid" onClick={onNewBucket}>
            <PlusIcon /> Create a bucket
          </Button>
        </div>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Region</th>
              <th scope="col">Created</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.name}>
                <td className="mono">
                  <a href={routeHash(bucketRoute(bucket.name))}>{bucket.name}</a>
                </td>
                <td className="mono">{bucket.region}</td>
                <td>
                  <Time iso={bucket.created} />
                </td>
                <td className="actions">
                  <Button
                    className="icon-button"
                    aria-label={`Delete ${bucket.name}`}
                    title="Delete"
                    onClick={() => onDelete(bucket.name)}
                  >
                    <TrashIcon />
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
