// Deleting a bucket (U15). An alert dialog asks first. If the bucket is
// not empty, the server answers BucketNotEmpty and the dialog offers to
// empty it and then delete it.

import { useState } from "react"
import { Button } from "@ui-sdk/react/button"
import {
  AlertDialog,
  AlertDialogBackdrop,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "@ui-sdk/react/alert-dialog"
import { api, isApiError } from "../api"

type Step = "confirm" | "not-empty"

export function DeleteBucketDialog({
  bucket,
  onClose,
  onDeleted,
}: {
  /** The bucket to delete; the dialog is open while this is set. */
  bucket: string | null
  onClose: () => void
  onDeleted: (bucket: string) => void
}) {
  const [step, setStep] = useState<Step>("confirm")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Keep the name on screen while the dialog closes.
  const [shown, setShown] = useState(bucket)
  if (bucket && bucket !== shown) setShown(bucket)

  async function run(empty: boolean) {
    if (!bucket) return
    setBusy(true)
    setError(null)
    try {
      if (empty) await api.emptyBucket(bucket)
      await api.deleteBucket(bucket)
      onDeleted(bucket)
      onClose()
    } catch (e) {
      if (!empty && isApiError(e, "BucketNotEmpty")) {
        setStep("not-empty")
      } else if (isApiError(e, "NoSuchBucket")) {
        // Someone else deleted it; the result is what was asked for.
        onDeleted(bucket)
        onClose()
      } else {
        setError(isApiError(e) ? `${e.message} (${e.code})` : String(e))
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <AlertDialog
      open={bucket !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
      onOpenChangeComplete={(next) => {
        if (!next) {
          setStep("confirm")
          setError(null)
        }
      }}
    >
      <AlertDialogBackdrop />
      <AlertDialogContent className="dialog">
        <div className="stack">
          <div className="stack-tight">
            <AlertDialogTitle>
              {step === "confirm" ? "Delete bucket?" : "Bucket is not empty"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {step === "confirm" ? (
                <>
                  This deletes <strong className="mono">{shown}</strong>. It cannot be undone.
                </>
              ) : (
                <>
                  <strong className="mono">{shown}</strong> still has objects or uploads in progress.
                  Empty it first? Every object and upload in it will be deleted.
                </>
              )}
            </AlertDialogDescription>
          </div>
          {error && (
            <p role="alert" className="error-text">
              {error}
            </p>
          )}
          <div className="row end">
            <Button onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            {step === "confirm" ? (
              <Button data-variant="destructive" onClick={() => run(false)} disabled={busy}>
                {busy ? "Deleting…" : "Delete"}
              </Button>
            ) : (
              <Button data-variant="destructive" onClick={() => run(true)} disabled={busy}>
                {busy ? "Emptying…" : "Empty and delete"}
              </Button>
            )}
          </div>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  )
}
