// The three page states shared by every screen (docs/todo.md, U20), so
// loading, empty and error look and read the same everywhere.

import type { ReactNode } from "react"
import { errorDetail } from "../api"
import { AlertIcon } from "./Icons"

/** A quiet placeholder while the first reply is awaited. */
export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <p className="state-loading" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </p>
  )
}

/** Nothing to show: a title, an optional hint, and optional actions. */
export function EmptyState({
  title,
  hint,
  icon,
  children,
  className,
}: {
  title: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  children?: ReactNode
  className?: string
}) {
  return (
    <div className={className ? `state state-empty ${className}` : "state state-empty"}>
      {icon && <div className="state-icon">{icon}</div>}
      <p className="state-title">{title}</p>
      {hint && <p className="state-hint">{hint}</p>}
      {children && <div className="state-actions">{children}</div>}
    </div>
  )
}

/**
 * Something failed: a title, the error's detail (or `detail` if given),
 * and optional actions such as "Try again". Announced as an alert.
 */
export function ErrorState({
  title,
  error,
  detail,
  children,
  className,
}: {
  title: ReactNode
  error?: unknown
  detail?: ReactNode
  children?: ReactNode
  className?: string
}) {
  const text = detail ?? (error === undefined ? undefined : errorDetail(error))
  return (
    <div className={className ? `state state-error ${className}` : "state state-error"} role="alert">
      <div className="state-icon">
        <AlertIcon />
      </div>
      <p className="state-title">{title}</p>
      {text && <p className="state-hint">{text}</p>}
      {children && <div className="state-actions">{children}</div>}
    </div>
  )
}
