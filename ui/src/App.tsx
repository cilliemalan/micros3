import { useEffect, useState } from "react"
import { Preferences } from "@ui-sdk/react/preferences"
import { BucketPage } from "./components/BucketPage"
import { BucketsPage } from "./components/BucketsPage"
import { DeleteBucketDialog } from "./components/DeleteBucketDialog"
import { NewBucketDialog } from "./components/NewBucketDialog"
import { Sidebar } from "./components/Sidebar"
import { Toasts, notify } from "./components/Toasts"
import { TopBar } from "./components/TopBar"
import { bucketRoute, navigate, useRoute } from "./route"
import { colorScheme } from "./theme"
import { useBuckets } from "./useBuckets"

const WIDE = "(min-width: 900px)"

export function App() {
  const route = useRoute()
  const buckets = useBuckets()
  const [sidebarOpen, setSidebarOpen] = useState(() => window.matchMedia(WIDE).matches)
  const [creating, setCreating] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  // Below 900 px the sidebar starts hidden and overlays the page when shown.
  useEffect(() => {
    const media = window.matchMedia(WIDE)
    const update = () => setSidebarOpen(media.matches)
    media.addEventListener("change", update)
    return () => media.removeEventListener("change", update)
  }, [])

  // On a narrow screen, choosing a place in the sidebar closes it.
  useEffect(() => {
    if (!window.matchMedia(WIDE).matches) setSidebarOpen(false)
  }, [route])

  const toggleSidebar = () => setSidebarOpen((open) => !open)
  const closeOverlay = () => {
    if (!window.matchMedia(WIDE).matches) setSidebarOpen(false)
  }

  return (
    <Preferences preferences={[colorScheme]}>
      <div
        className="app"
        data-sidebar={sidebarOpen ? "open" : "closed"}
        onKeyDown={(event) => {
          if (event.key === "Escape") closeOverlay()
        }}
      >
        <Sidebar route={route} state={buckets} onNewBucket={() => setCreating(true)} />
        {/* Closes the sidebar where it lies over the page; hidden by CSS from 900 px. */}
        <div className="sidebar-scrim" aria-hidden="true" onClick={closeOverlay} />
        <div className="main">
          {route.page === "bucket" ? (
            <BucketPage
              key={route.bucket}
              bucket={route.bucket}
              tab={route.tab}
              prefix={route.prefix}
              sidebarOpen={sidebarOpen}
              onToggleSidebar={toggleSidebar}
              onDelete={setDeleting}
            />
          ) : (
            <>
              <TopBar title={<span id="page-title">Buckets</span>} sidebarOpen={sidebarOpen} onToggleSidebar={toggleSidebar} />
              <main id="main" className="content">
                <BucketsPage state={buckets} onNewBucket={() => setCreating(true)} onDelete={setDeleting} />
              </main>
            </>
          )}
        </div>
      </div>
      <NewBucketDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={(bucket) => {
          notify.success("Bucket created", { description: bucket.name })
          void buckets.reload()
          navigate(bucketRoute(bucket.name))
        }}
      />
      <DeleteBucketDialog
        bucket={deleting}
        onClose={() => setDeleting(null)}
        onDeleted={(name) => {
          notify.success("Bucket deleted", { description: name })
          void buckets.reload()
          if (route.page === "bucket" && route.bucket === name) navigate({ page: "buckets" })
        }}
      />
      <Toasts />
    </Preferences>
  )
}
