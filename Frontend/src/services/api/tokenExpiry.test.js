import test from "node:test"
import assert from "node:assert/strict"

/**
 * Deciding when a token is worth renewing early.
 *
 * Mirrors expiryOf/isExpiringSoon in axios.js, which cannot be imported here
 * without pulling in the whole client. Getting this wrong is not cosmetic in
 * either direction: too eager and every call refreshes, too shy and the console
 * fills with 401s again.
 */
const REFRESH_LEEWAY_SECONDS = 60

const b64url = (obj) =>
  Buffer.from(JSON.stringify(obj))
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")

const tokenExpiringIn = (seconds) =>
  `header.${b64url({ exp: Math.floor(Date.now() / 1000) + seconds })}.signature`

const expiryOf = (token) => {
  try {
    const payload = String(token || "").split(".")[1]
    if (!payload) return null
    const json = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString()
    const exp = Number(JSON.parse(json)?.exp)
    return Number.isFinite(exp) ? exp : null
  } catch {
    return null
  }
}

const isExpiringSoon = (token) => {
  const exp = expiryOf(token)
  if (exp === null) return false
  return exp - Date.now() / 1000 <= REFRESH_LEEWAY_SECONDS
}

test("a token with plenty of life is left alone", () => {
  assert.equal(isExpiringSoon(tokenExpiringIn(15 * 60)), false)
  assert.equal(isExpiringSoon(tokenExpiringIn(120)), false)
})

test("a token inside the leeway is renewed early", () => {
  // The whole point: renew before the request that would have 401'd.
  assert.equal(isExpiringSoon(tokenExpiringIn(59)), true)
  assert.equal(isExpiringSoon(tokenExpiringIn(5)), true)
})

test("an already expired token counts as expiring", () => {
  // Otherwise a tab left open overnight would send the dead token once, take
  // the 401, and only then refresh -- the behaviour being removed.
  assert.equal(isExpiringSoon(tokenExpiringIn(-3600)), true)
})

test("a token that cannot be read is sent as it is", () => {
  // Never guess. An unreadable token falls through to the 401 path, which is
  // the behaviour that already worked.
  for (const junk of ["", null, undefined, "not-a-jwt", "a.b", "a.!!!.c"]) {
    assert.equal(isExpiringSoon(junk), false, JSON.stringify(junk))
  }
})

test("a token with no exp claim is sent as it is", () => {
  assert.equal(isExpiringSoon(`header.${b64url({ sub: "x" })}.sig`), false)
})

test("a non-numeric exp is not treated as expiring", () => {
  assert.equal(isExpiringSoon(`header.${b64url({ exp: "soon" })}.sig`), false)
})

test("the leeway is under the token lifetime", () => {
  // A leeway at or above the ~15 minute lifetime would refresh on every single
  // request, which is worse than the 401s.
  assert.ok(REFRESH_LEEWAY_SECONDS < 15 * 60)
})
