// A bucket's page: the top bar with its name and the Objects, Uploads and
// Settings tabs. The tab and prefix live in the hash route.

import { useEffect, useState, type ReactNode } from "react"
import { Button } from "@ui-sdk/react/button"
import { Tabs, TabsList, TabsPanel, TabsTab } from "@ui-sdk/react/tabs"
import { api, isApiError, type BucketDetails } from "../api"
import { TABS, bucketRoute, navigate, type Tab } from "../route"
import { TrashIcon } from "./Icons"
import { ObjectsTab } from "./ObjectsTab"
import { SettingsTab } from "./SettingsTab"
import { TopBar } from "./TopBar"
import { UploadsTab } from "./UploadsTab"

const TAB_LABELS: Record<Tab, string> = { objects: "Objects", uploads: "Uploads", settings: "Settings" }

type Loaded = { bucket: string; details?: BucketDetails; error?: unknown }

export function BucketPage({
  bucket,
  tab,
  prefix,
  sidebarOpen,
  onToggleSidebar,
  onDelete,
}: {
  bucket: string
  tab: Tab
  prefix: string
  sidebarOpen: boolean
  onToggleSidebar: () => void
  onDelete: (bucket: string) => void
}) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    let live = true
    api.getBucket(bucket).then(
      (details) => live && setLoaded({ bucket, details }),
      (error) => live && setLoaded({ bucket, error }),
    )
    return () => {
      live = false
    }
  }, [bucket])

  const current = loaded?.bucket === bucket ? loaded : null
  const missing = current?.error && isApiError(current.error, "NoSuchBucket")

  let body: ReactNode
  if (!current) {
    body = <p className="muted page">Loading…</p>
  } else if (current.error) {
    body = (
      <div className="empty page" role="alert">
        <p>{missing ? `The bucket "${bucket}" does not exist.` : "Could not load this bucket."}</p>
        {!missing && isApiError(current.error) && (
          <p className="muted">
            {current.error.message} ({current.error.code})
          </p>
        )}
        <a href="#/">Back to buckets</a>
      </div>
    )
  }

  return (
    <Tabs
      value={tab}
      onValueChange={(next) => {
        if (next) navigate(bucketRoute(bucket, next as Tab, next === "objects" ? prefix : ""))
      }}
      className="bucket-page"
    >
      <TopBar
        title={<span className="mono">{bucket}</span>}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onToggleSidebar}
      >
        {current?.details && (
          <div className="topbar-row tabs-row">
            <TabsList aria-label="Bucket" className="tabs">
              {TABS.map((t) => (
                <TabsTab key={t} value={t}>
                  {TAB_LABELS[t]}
                </TabsTab>
              ))}
            </TabsList>
            <div className="spacer" />
            <Button onClick={() => onDelete(bucket)}>
              <TrashIcon /> Delete bucket
            </Button>
          </div>
        )}
      </TopBar>
      <main id="main" className="content">
        {body ?? (
          <>
            <TabsPanel value="objects" className="page">
              {tab === "objects" && <ObjectsTab key={prefix} bucket={bucket} prefix={prefix} />}
            </TabsPanel>
            <TabsPanel value="uploads" className="page">
              {tab === "uploads" && <UploadsTab bucket={bucket} />}
            </TabsPanel>
            <TabsPanel value="settings" className="page">
              {tab === "settings" && current?.details && <SettingsTab details={current.details} />}
            </TabsPanel>
          </>
        )}
      </main>
    </Tabs>
  )
}
