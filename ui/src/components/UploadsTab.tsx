// The Uploads tab (U16): multipart uploads in progress in this bucket,
// paged with "Load more", each with Abort behind a confirmation.

import { useEffect, useState } from "react"
import { Button } from "@ui-sdk/react/button"
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@ui-sdk/react/alert-dialog"
import { api, isApiError, type Upload, type UploadListing } from "../api"
import { RefreshIcon, UploadIcon, XIcon } from "./Icons"
import { EmptyState, ErrorState, Loading } from "./States"
import { Time } from "./Time"
import { notify, notifyError } from "./Toasts"

type State = {
  uploads: Upload[]
  next?: UploadListing["next"]
  loading: boolean
  error?: unknown
}

export function UploadsTab({ bucket }: { bucket: string }) {
  const [state, setState] = useState<State>({ uploads: [], loading: true })
  const [reloads, setReloads] = useState(0)
  const [aborting, setAborting] = useState<Upload | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    setState({ uploads: [], loading: true })
    api.listUploads(bucket).then(
      (page) => live && setState({ uploads: page.uploads, next: page.next, loading: false }),
      (error) => live && setState({ uploads: [], loading: false, error }),
    )
    return () => {
      live = false
    }
  }, [bucket, reloads])

  async function loadMore() {
    if (!state.next || state.loading) return
    setState((s) => ({ ...s, loading: true }))
    try {
      const page = await api.listUploads(bucket, state.next)
      setState((s) => ({ uploads: [...s.uploads, ...page.uploads], next: page.next, loading: false }))
    } catch (error) {
      setState((s) => ({ ...s, loading: false }))
      notifyError("Could not load more uploads", error)
    }
  }

  async function abort(upload: Upload) {
    setBusy(true)
    try {
      await api.abortUpload(bucket, upload.key, upload.uploadId)
      notify.success("Upload aborted", { description: upload.key })
    } catch (error) {
      if (!isApiError(error, "NoSuchUpload")) {
        notifyError("Could not abort the upload", error)
        setBusy(false)
        return
      }
      // Already completed or aborted elsewhere; it is gone either way.
    }
    setState((s) => ({
      ...s,
      uploads: s.uploads.filter((u) => !(u.key === upload.key && u.uploadId === upload.uploadId)),
    }))
    setAborting(null)
    setBusy(false)
  }

  const { uploads, next, loading, error } = state
  const firstLoad = loading && uploads.length === 0

  return (
    <div className="stack">
      <div className="toolbar">
        <p className="muted">
          {firstLoad || error
            ? ""
            : `${uploads.length}${next ? "+" : ""} ${uploads.length === 1 && !next ? "upload" : "uploads"} in progress`}
        </p>
        <div className="spacer" />
        <Button onClick={() => setReloads((n) => n + 1)} disabled={loading}>
          <RefreshIcon /> Refresh
        </Button>
      </div>
      {error ? (
        <ErrorState title="Could not load the uploads." error={error}>
          <Button onClick={() => setReloads((n) => n + 1)}>Try again</Button>
        </ErrorState>
      ) : firstLoad ? (
        <Loading />
      ) : uploads.length === 0 ? (
        <EmptyState
          icon={<UploadIcon />}
          title="No multipart uploads are in progress."
          hint="Uploads started through the S3 API appear here until they are completed or aborted."
        />
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Upload ID</th>
                  <th scope="col">Started</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {uploads.map((upload) => (
                  <tr key={`${upload.key}\u0000${upload.uploadId}`}>
                    <td className="mono key-cell">{upload.key}</td>
                    <td className="mono truncate" title={upload.uploadId}>
                      {upload.uploadId}
                    </td>
                    <td>
                      <Time iso={upload.initiated} />
                    </td>
                    <td className="actions">
                      <Button onClick={() => setAborting(upload)}>
                        <XIcon /> Abort<span className="sr-only"> upload of {upload.key}</span>
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {next && (
            <div className="row center">
              <Button onClick={() => void loadMore()} disabled={loading}>
                {loading ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}

      <AlertDialog
        open={aborting !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setAborting(null)
        }}
      >
        <AlertDialogBackdrop />
        <AlertDialogContent className="dialog">
          <div className="stack">
            <div className="stack-tight">
              <AlertDialogTitle>Abort upload?</AlertDialogTitle>
              <AlertDialogDescription>
                The parts uploaded so far for <strong className="mono key-cell">{aborting?.key}</strong> are deleted.
                The client that started it can no longer complete it.
              </AlertDialogDescription>
            </div>
            <div className="row end">
              <Button onClick={() => setAborting(null)} disabled={busy}>
                Cancel
              </Button>
              <Button
                data-variant="destructive"
                onClick={() => aborting && void abort(aborting)}
                disabled={busy}
              >
                {busy ? "Aborting…" : "Abort upload"}
              </Button>
            </div>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
