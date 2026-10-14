/**
 * One way to show a date or a time in the admin and restaurant panels, as the
 * old panel did: "14 Oct 2026, 03:50 PM". Always India time and a 12-hour
 * clock with AM/PM, whatever the browser's own locale or zone.
 *
 * For display only. Values sent to the API, sort keys and <input> values stay
 * as they are.
 */

const TIME_ZONE = "Asia/Kolkata"
const LOCALE = "en-IN"

const DATE_PARTS = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  day: "2-digit",
  month: "short",
  year: "numeric",
})

const TIME_PARTS = new Intl.DateTimeFormat(LOCALE, {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
})

const toDate = (value) => {
  if (value === null || value === undefined || value === "") return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

const partsOf = (formatter, date) =>
  Object.fromEntries(formatter.formatToParts(date).map((p) => [p.type, p.value]))

/** "14 Oct 2026" (fallback when the value is empty or not a date). */
export const formatDate = (value, fallback = "-") => {
  const date = toDate(value)
  if (!date) return fallback
  const p = partsOf(DATE_PARTS, date)
  // Some engines spell September "Sept"; the panel shows three letters.
  return `${p.day} ${String(p.month).slice(0, 3)} ${p.year}`
}

/** "03:50 PM" (fallback when the value is empty or not a date). */
export const formatTime = (value, fallback = "-") => {
  const date = toDate(value)
  if (!date) return fallback
  const p = partsOf(TIME_PARTS, date)
  const hour = String(p.hour === "00" ? "12" : p.hour).padStart(2, "0")
  return `${hour}:${p.minute} ${String(p.dayPeriod || "").toUpperCase()}`.trim()
}

/** "14 Oct 2026, 03:50 PM" (fallback when the value is empty or not a date). */
export const formatDateTime = (value, fallback = "-") => {
  const date = toDate(value)
  if (!date) return fallback
  return `${formatDate(date)}, ${formatTime(date)}`
}

/** "14 Oct, 03:50 PM": for timelines within the same year. */
export const formatShortDateTime = (value, fallback = "-") => {
  const date = toDate(value)
  if (!date) return fallback
  const p = partsOf(DATE_PARTS, date)
  return `${p.day} ${String(p.month).slice(0, 3)}, ${formatTime(date)}`
}

/**
 * A wall-clock "HH:mm" or "HH:mm:ss" (opening hours, slots) as "03:50 PM".
 * Already-12-hour text ("3:50 pm") is tidied the same way. Anything else is
 * returned unchanged.
 */
export const formatClock = (value, fallback = "-") => {
  const raw = String(value ?? "").trim()
  if (!raw) return fallback
  const m = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp][Mm])?$/)
  if (!m) return raw
  let h = Number(m[1])
  const minute = m[2]
  if (h > 23 || Number(minute) > 59) return raw
  let period = m[3] ? m[3].toUpperCase() : null
  if (!period) {
    period = h >= 12 ? "PM" : "AM"
    h %= 12
  } else if (h > 12) {
    return raw
  } else {
    h %= 12
  }
  return `${String(h === 0 ? 12 : h).padStart(2, "0")}:${minute} ${period}`
}
