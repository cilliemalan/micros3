// The one toast region of the app. Code anywhere reports a result with
// `notify.success(...)` or `notify.error(...)`.

import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastRegion,
  ToastTitle,
  toast,
} from "@ui-sdk/react/toast"
import { isApiError } from "../api"

export const notify = toast

/** Reports a failed action, with the API's error code when there is one. */
export function notifyError(title: string, error: unknown) {
  const description = isApiError(error)
    ? `${error.message} (${error.code})`
    : error instanceof Error
      ? error.message
      : String(error)
  notify.error(title, { description })
}

export function Toasts() {
  return (
    <ToastRegion toaster={toast}>
      {() => (
        <Toast>
          <div className="toast-text">
            <ToastTitle />
            <ToastDescription />
          </div>
          <ToastClose aria-label="Dismiss" />
        </Toast>
      )}
    </ToastRegion>
  )
}
