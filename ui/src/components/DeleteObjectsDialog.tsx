// Deleting objects (U18): one from its row menu, or the selected ones.
// Keys go to the server in batches of at most 1,000. Keys the server
// could not delete are listed with their error, and the dialog stays open
// so they can be read.

import { useState } from "react"
import { Button } from "@ui-sdk/react/button"
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@ui-sdk/react/alert-dialog"
import { api, isApiError, type DeleteResult } from "../api"
import { batches, mergeDeleteResults } from "../objectActions"
import { notify } from "./Toasts"

export function DeleteObjectsDialog({
  bucket,
  keys,
  onClose,
  onDeleted,
}: {
  bucket: string
  /** The keys to delete; the dialog is open while this is set. */
  keys: string[] | null
  onClose: () => void
  /** Called with the keys deleted, even if some others failed. */
  onDeleted: (keys: string[]) => void
}) {
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [result, setResult] = useState<DeleteResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Keep the keys on screen while the dialog closes.
  const [shown, setShown] = useState<string[]>(keys ?? [])
  if (keys && keys !== shown) setShown(keys)

  async function run() {
    if (!keys) return
    setBusy(true)
    setError(null)
    setResult(null)
    const results: DeleteResult[] = []
    let failedBatch = false
    try {
      let done = 0
      setProgress({ done, total: keys.length })
      for (const batch of batches(keys)) {
        results.push(await api.deleteObjects(bucket, batch))
        done += batch.length
        setProgress({ done, total: keys.length })
      }
    } catch (e) {
      failedBatch = true
      setError(isApiError(e) ? `${e.message} (${e.code})` : String(e))
    }
    const merged = mergeDeleteResults(results)
    setBusy(false)
    setProgress(null)
    if (merged.deleted.length > 0) {
      onDeleted(merged.deleted)
      notify.success(
        merged.deleted.length === 1 ? "Object deleted" : `${merged.deleted.length.toLocaleString()} objects deleted`,
        merged.deleted.length === 1 ? { description: merged.deleted[0] } : undefined,
      )
    }
    if (merged.errors.length > 0) {
      setResult(merged)
    } else if (!failedBatch) {
      onClose()
    }
  }

  const count = shown.length
  const failed = result?.errors ?? []

  return (
    <AlertDialog
      open={keys !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
      onOpenChangeComplete={(next) => {
        if (!next) {
          setResult(null)
          setError(null)
        }
      }}
    >
      <AlertDialogBackdrop />
      <AlertDialogContent className="dialog dialog-wide">
        <div className="stack">
          <div className="stack-tight">
            <AlertDialogTitle>
              {failed.length > 0
                ? "Some objects were not deleted"
                : count === 1
                  ? "Delete object?"
                  : `Delete ${count.toLocaleString()} objects?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {failed.length > 0 ? (
                <>
                  {result!.deleted.length.toLocaleString()} deleted, {failed.length.toLocaleString()} failed.
                </>
              ) : count === 1 ? (
                <>
                  This deletes <strong className="mono key-cell">{shown[0]}</strong>. It cannot be undone.
                </>
              ) : (
                <>This deletes the selected objects. It cannot be undone.</>
              )}
            </AlertDialogDescription>
          </div>
          {failed.length > 0 && (
            <ul className="error-list" aria-label="Keys not deleted">
              {failed.map((f, i) => (
                <li key={`${i}:${f.key}`}>
                  <span className="mono key-cell">{f.key === "" ? "(empty key)" : f.key}</span>
                  <span className="error-text small">
                    {f.message} ({f.code})
                  </span>
                </li>
              ))}
            </ul>
          )}
          {progress && (
            <p className="muted small" aria-live="polite">
              Deleted {progress.done.toLocaleString()} of {progress.total.toLocaleString()}…
            </p>
          )}
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <div className="row end">
            {failed.length > 0 ? (
              <Button onClick={onClose}>Close</Button>
            ) : (
              <>
                <Button onClick={onClose} disabled={busy}>
                  Cancel
                </Button>
                <Button data-variant="destructive" onClick={() => void run()} disabled={busy}>
                  {busy ? "Deleting…" : "Delete"}
                </Button>
              </>
            )}
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
