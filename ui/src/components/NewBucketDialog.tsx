// The New bucket dialog (U15): a name, checked with the same rules as the
// server, and a region.

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectTrigger,
  SelectValue,
} from "@ui-sdk/react/select"
import { api, isApiError, type Bucket } from "../api"
import { DEFAULT_REGION, REGIONS, bucketNameProblem } from "../bucketName"

export function NewBucketDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (bucket: Bucket) => void
}) {
  const [name, setName] = useState("")
  const [region, setRegion] = useState<string>(DEFAULT_REGION)
  const [touched, setTouched] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const problem = bucketNameProblem(name)
  const shownError = serverError ?? (touched && name !== "" ? problem : null)

  function reset() {
    setName("")
    setRegion(DEFAULT_REGION)
    setTouched(false)
    setServerError(null)
    setBusy(false)
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setTouched(true)
    if (problem || busy) return
    setBusy(true)
    try {
      const bucket = await api.createBucket(name, region)
      onCreated(bucket)
      onOpenChange(false)
    } catch (error) {
      if (isApiError(error, "BucketAlreadyOwnedByYou") || isApiError(error, "BucketAlreadyExists")) {
        setServerError(`A bucket named "${name}" already exists.`)
      } else if (isApiError(error)) {
        setServerError(`${error.message} (${error.code})`)
      } else {
        setServerError(String(error))
      }
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
        if (!next) reset()
      }}
    >
      <DialogBackdrop />
      <DialogContent className="dialog">
        <form onSubmit={submit} noValidate className="stack">
          <div className="stack-tight">
            <DialogTitle>New bucket</DialogTitle>
            <DialogDescription>Bucket names are unique on this server and cannot be changed.</DialogDescription>
          </div>
          <Field invalid={shownError ? true : false}>
            <FieldLabel>Name</FieldLabel>
            <Input
              value={name}
              autoComplete="off"
              spellCheck={false}
              placeholder="my-bucket"
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
              <FieldDescription>3 to 63 lowercase letters, digits, dots and hyphens.</FieldDescription>
            )}
          </Field>
          <Field>
            <FieldLabel>Region</FieldLabel>
            <Select value={region} onValueChange={(value) => value && setRegion(value as string)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REGIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <div className="row end">
            <DialogClose disabled={busy}>Cancel</DialogClose>
            <Button type="submit" data-variant="solid" disabled={busy}>
              {busy ? "Creating…" : "Create bucket"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
