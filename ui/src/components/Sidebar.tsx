// The left sidebar: the bucket list, a search box and New bucket.

import { useState } from "react"
import { Button } from "@ui-sdk/react/button"
import { Field, FieldLabel } from "@ui-sdk/react/field"
import { Input, InputClear, InputGroup } from "@ui-sdk/react/input"
import type { Route } from "../route"
import { bucketRoute, routeHash } from "../route"
import type { BucketsState } from "../useBuckets"
import { BucketIcon, PlusIcon, SearchIcon } from "./Icons"

export function Sidebar({
  route,
  state,
  onNewBucket,
}: {
  route: Route
  state: BucketsState
  onNewBucket: () => void
}) {
  const [search, setSearch] = useState("")
  const query = search.trim().toLowerCase()
  const shown = state.buckets?.filter((b) => b.name.includes(query)) ?? []
  const current = route.page === "bucket" ? route.bucket : null

  return (
    <aside id="sidebar" className="sidebar" aria-label="Sidebar">
      <a className="brand" href="#/" aria-current={route.page === "buckets" ? "page" : undefined}>
        <BucketIcon />
        <span>MicroS3</span>
      </a>
      <Button className="new-bucket" data-variant="solid" onClick={onNewBucket}>
        <PlusIcon /> New bucket
      </Button>
      <Field className="sidebar-search">
        <FieldLabel className="sr-only">Search buckets</FieldLabel>
        <InputGroup>
          <SearchIcon />
          <Input type="search" placeholder="Search buckets" value={search} onValueChange={setSearch} />
          <InputClear aria-label="Clear search" />
        </InputGroup>
      </Field>
      <nav aria-label="Buckets" className="bucket-nav">
        {state.buckets === null ? (
          <p className="muted small">{state.error ? "Could not load buckets." : "Loading…"}</p>
        ) : shown.length === 0 ? (
          <p className="muted small">{query ? "No bucket matches." : "No buckets yet."}</p>
        ) : (
          <ul>
            {shown.map((bucket) => (
              <li key={bucket.name}>
                <a
                  href={routeHash(bucketRoute(bucket.name))}
                  aria-current={bucket.name === current ? "page" : undefined}
                  title={bucket.name}
                >
                  {bucket.name}
                </a>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </aside>
  )
}
