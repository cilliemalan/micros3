// Display formats for sizes and times.

const UNITS = ["KB", "MB", "GB", "TB"]

/** A byte count for people: "512 B", "1.5 KB", "12 MB". Binary units, as S3 consoles use. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const text = value < 10 ? value.toFixed(1) : Math.round(value).toString()
  return `${text.replace(/\.0$/, "")} ${UNITS[unit]}`
}

/** An ISO time as a full local date and time, for titles and details. */
export function formatAbsolute(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 30],
  ["month", 12],
  ["year", Infinity],
]

/** An ISO time relative to `now`: "just now", "5 minutes ago", "in 2 days". */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const time = new Date(iso).getTime()
  if (Number.isNaN(time)) return iso
  let value = (time - now) / 1000
  if (Math.abs(value) < 10) return "just now"
  const format = new Intl.RelativeTimeFormat("en", { numeric: "auto" })
  for (const [unit, size] of STEPS) {
    if (Math.abs(value) < size) return format.format(Math.round(value), unit)
    value /= size
  }
  return format.format(Math.round(value), "year")
}
