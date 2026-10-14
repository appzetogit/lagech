import test from "node:test"
import assert from "node:assert/strict"

import { formatDate, formatTime, formatDateTime, formatShortDateTime, formatClock } from "./dateTime.js"

/**
 * The panels' one date/time format, as the old panel showed it:
 * "14 Oct 2026, 03:50 PM", in India time whatever the browser's zone.
 */

// 10:20 UTC is 15:50 in India.
const AFTERNOON = "2026-10-14T10:20:00.000Z"

test("a date and time reads like the old panel, on a 12-hour clock", () => {
  assert.equal(formatDateTime(AFTERNOON), "14 Oct 2026, 03:50 PM")
  assert.equal(formatDate(AFTERNOON), "14 Oct 2026")
  assert.equal(formatTime(AFTERNOON), "03:50 PM")
  assert.equal(formatShortDateTime(AFTERNOON), "14 Oct, 03:50 PM")
})

test("midnight and noon are 12, never 00", () => {
  assert.equal(formatTime("2026-10-13T18:30:00.000Z"), "12:00 AM")
  assert.equal(formatTime("2026-10-14T06:30:00.000Z"), "12:00 PM")
})

test("India time decides the day, not UTC", () => {
  // 20:00 UTC on the 14th is 01:30 on the 15th in India.
  assert.equal(formatDateTime("2026-10-14T20:00:00.000Z"), "15 Oct 2026, 01:30 AM")
})

test("months are three letters", () => {
  assert.equal(formatDate("2026-09-05T06:00:00.000Z"), "05 Sep 2026")
})

test("empty or broken values show the fallback", () => {
  assert.equal(formatDateTime(null), "-")
  assert.equal(formatDateTime(""), "-")
  assert.equal(formatDateTime("not a date"), "-")
  assert.equal(formatDate(undefined, ""), "")
  assert.equal(formatTime(null, "N/A"), "N/A")
})

test("a wall-clock time from opening hours reads on a 12-hour clock", () => {
  assert.equal(formatClock("15:30"), "03:30 PM")
  assert.equal(formatClock("09:05:00"), "09:05 AM")
  assert.equal(formatClock("00:00"), "12:00 AM")
  assert.equal(formatClock("12:00"), "12:00 PM")
  assert.equal(formatClock("3:50 pm"), "03:50 PM")
  assert.equal(formatClock("Closed"), "Closed")
  assert.equal(formatClock(""), "-")
})
