// Downloads an object (U18). The browser fetches the content URL through a
// link with the `download` attribute, so the page never navigates to it,
// and the server's `Content-Disposition: attachment` (with the name in
// RFC 5987 form) makes the browser save it rather than show it.

import { objectUrl } from "./api"
import { downloadName } from "./objectActions"

export function downloadObject(bucket: string, key: string): void {
  const link = document.createElement("a")
  link.href = objectUrl(bucket, key)
  link.download = downloadName(key)
  link.rel = "noopener"
  link.style.display = "none"
  document.body.append(link)
  link.click()
  link.remove()
}
