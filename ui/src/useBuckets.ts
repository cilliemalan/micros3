import { useCallback, useEffect, useState } from "react"
import { api, type Bucket } from "./api"

export interface BucketsState {
  /** The buckets, sorted by name, or null before the first reply. */
  buckets: Bucket[] | null
  /** The error of the last load, if it failed. */
  error: unknown
  loading: boolean
  reload: () => Promise<void>
}

/** The bucket list, shared by the sidebar and the Buckets page. */
export function useBuckets(): BucketsState {
  const [buckets, setBuckets] = useState<Bucket[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const list = await api.listBuckets()
      setBuckets([...list].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)))
      setError(null)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  return { buckets, error, loading, reload }
}
