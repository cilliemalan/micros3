// The New folder dialog (U18): a zero-byte object whose key ends in "/",
// under the current folder.

import { useState, type FormEvent } from "react"
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
import { isApiError, uploadObject } from "../api"
import { folderKey } from "../objectActions"

export function NewFolderDialog({
  bucket,
  prefix,
  open,
  onOpenChange,
  onCreated,
}: {
  bucket: string
  prefix: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (key: string) => void
}) {
  const [name, setName] = useState("")
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const result = folderKey(prefix, name)
  const problem = "error" in result ? result.error : null
  const shownError = serverError ?? (touched && name !== "" ? problem : null)

  async function submit(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if ("error" in result || busy) return
    setBusy(true)
    try {
      await uploadObject(bucket, result.key, new Blob([]), { contentType: "application/x-directory" })
      onCreated(result.key)
      onOpenChange(false)
    } catch (error) {
      setServerError(isApiError(error) ? `${error.message} (${error.code})` : String(error))
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next)
      }}
      onOpenChangeComplete={(next) => {
        if (!next) {
          setName("")
          setTouched(false)
          setServerError(null)
          setBusy(false)
        }
      }}
    >
      <DialogBackdrop />
      <DialogContent className="dialog">
        <form onSubmit={submit} noValidate className="stack">
          <div className="stack-tight">
            <DialogTitle>New folder</DialogTitle>
            <DialogDescription>
              Creates an empty object named <span className="mono key-cell">{prefix}{name.replace(/\/+$/, "") || "…"}/</span>{" "}
              in <span className="mono">{bucket}</span>.
            </DialogDescription>
          </div>
          <Field invalid={shownError ? true : false}>
            <FieldLabel>Folder name</FieldLabel>
            <Input
              value={name}
              autoComplete="off"
              spellCheck={false}
              className="mono"
              onValueChange={(value) => {
                setName(value)
                setServerError(null)
              }}
              onBlur={() => setTouched(true)}
            />
            {shownError ? (
              <FieldError match>{shownError}</FieldError>
            ) : (
              <FieldDescription>Use / to make nested folders.</FieldDescription>
            )}
          </Field>
          <div className="row end">
            <DialogClose disabled={busy}>Cancel</DialogClose>
            <Button type="submit" data-variant="solid" disabled={busy}>
              {busy ? "Creating…" : "Create folder"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
