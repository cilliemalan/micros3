// Copying or moving one object (U18). The dialog picks the destination
// bucket and key; Copy and Move are its two actions. A move whose copy
// succeeded but whose delete failed (409 MoveIncomplete) says so.

import { useEffect, useState, type FormEvent } from "react"
import { Button } from "@ui-sdk/react/button"
import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@ui-sdk/react/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@ui-sdk/react/field"
import { Input } from "@ui-sdk/react/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select"
import { api, isApiError, type Bucket } from "../api"
import { copyProblem } from "../objectActions"
import { notify } from "./Toasts"

export interface CopyDone {
  move: boolean
  destination: { bucket: string; key: string }
  /** For a move: whether the source is gone. False after MoveIncomplete. */
  sourceDeleted: boolean
}

export function CopyObjectDialog({
  bucket,
  sourceKey,
  onClose,
  onDone,
}: {
  bucket: string
  /** The key to copy; the dialog is open while this is set. */
  sourceKey: string | null
  onClose: () => void
  onDone: (done: CopyDone) => void
}) {
  const [buckets, setBuckets] = useState<Bucket[] | null>(null)
  const [destBucket, setDestBucket] = useState(bucket)
  const [destKey, setDestKey] = useState("")
  const [busy, setBusy] = useState<"copy" | "move" | null>(null)
  const [serverError, setServerError] = useState<string | null>(null)
  // The key on screen; cleared once the dialog has closed, so opening it
  // again resets the form.
  const [shown, setShown] = useState("")
  const open = sourceKey !== null

  if (sourceKey !== null && sourceKey !== shown) {
    setShown(sourceKey)
    setDestBucket(bucket)
    setDestKey(sourceKey)
    setServerError(null)
  }

  useEffect(() => {
    if (!open) return
    let live = true
    api.listBuckets().then(
      (list) => live && setBuckets([...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))),
      () => live && setBuckets([]),
    )
    return () => {
      live = false
    }
  }, [open])

  const source = { bucket, key: shown }
  const destination = { bucket: destBucket, key: destKey }
  const problem = copyProblem(source, destination)
  const shownError = serverError ?? problem

  async function run(move: boolean) {
    if (problem || busy || sourceKey === null) return
    setBusy(move ? "move" : "copy")
    setServerError(null)
    try {
      await api.copyObject(bucket, { source, destination, move })
      notify.success(move ? "Object moved" : "Object copied", {
        description: `${destination.bucket}/${destination.key}`,
      })
      onDone({ move, destination, sourceDeleted: move })
      onClose()
    } catch (error) {
      if (move && isApiError(error, "MoveIncomplete")) {
        notify.error("Move incomplete", {
          description: `Copied to ${destination.bucket}/${destination.key}, but ${bucket}/${source.key} could not be deleted.`,
        })
        onDone({ move, destination, sourceDeleted: false })
        onClose()
      } else {
        setServerError(isApiError(error) ? `${error.message} (${error.code})` : String(error))
      }
    } finally {
      setBusy(null)
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    void run(false)
  }

  const names = buckets?.map((b) => b.name) ?? [bucket]
  if (!names.includes(bucket)) names.unshift(bucket)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose()
      }}
      onOpenChangeComplete={(next) => {
        if (!next) setShown("")
      }}
    >
      <DialogBackdrop />
      <DialogContent className="dialog dialog-wide">
        <form onSubmit={submit} noValidate className="stack">
          <div className="stack-tight">
            <DialogTitle>Copy or move</DialogTitle>
            <DialogDescription>
              From <span className="mono key-cell">{bucket}/{shown}</span>. The copy keeps the stored headers.
              An object already at the destination is replaced.
            </DialogDescription>
          </div>
          <Field>
            <FieldLabel>Destination bucket</FieldLabel>
            <Select value={destBucket} onValueChange={(value) => value && setDestBucket(value as string)}>
              <SelectTrigger className="mono">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {names.map((name) => (
                  <SelectItem key={name} value={name} className="mono">
                    {name}
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field invalid={shownError ? true : false}>
            <FieldLabel>Destination key</FieldLabel>
            <Input
              value={destKey}
              autoComplete="off"
              spellCheck={false}
              className="mono"
              onValueChange={(value) => {
                setDestKey(value)
                setServerError(null)
              }}
            />
            {shownError ? (
              <FieldError match>{shownError}</FieldError>
            ) : (
              <FieldDescription>The full key, including any folders.</FieldDescription>
            )}
          </Field>
          <div className="row end">
            <DialogClose disabled={busy !== null}>Cancel</DialogClose>
            <Button onClick={() => void run(true)} disabled={busy !== null || problem !== null}>
              {busy === "move" ? "Moving…" : "Move"}
            </Button>
            <Button type="submit" data-variant="solid" disabled={busy !== null || problem !== null}>
              {busy === "copy" ? "Copying…" : "Copy"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
