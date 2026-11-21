import { formatAbsolute, formatRelative } from "../format"

/** A time shown relative to now, with the absolute time in its title and datetime. */
export function Time({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={formatAbsolute(iso)}>
      {formatRelative(iso)}
    </time>
  )
}
