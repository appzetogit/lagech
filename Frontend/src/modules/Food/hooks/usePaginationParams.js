import { useCallback, useMemo } from "react"
import { useSearchParams } from "react-router-dom"

/**
 * Which page of a list is showing, kept in the URL.
 *
 * Held in component state it was invisible and unshareable: reloading threw you
 * back to page one, the back button walked out of the screen instead of back a
 * page, and a link to "the order I am looking at" was a link to page one. The
 * page size had the same problem in reverse -- it was a constant in the source,
 * so nobody could see it, let alone change it.
 *
 * Both live in the query string now, which makes them the same kind of state as
 * a filter: readable, linkable, and restored on reload.
 */

export const DEFAULT_LIMIT_OPTIONS = [10, 25, 50, 100]

const toPositiveInt = (raw, fallback) => {
    const n = Number.parseInt(String(raw ?? ""), 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
}

export function usePaginationParams({
    defaultLimit = 50,
    limitOptions = DEFAULT_LIMIT_OPTIONS,
    pageKey = "page",
    limitKey = "limit",
} = {}) {
    const [searchParams, setSearchParams] = useSearchParams()

    const page = toPositiveInt(searchParams.get(pageKey), 1)

    // A limit off the list is refused rather than honoured: it reaches the API
    // as a page size, and ?limit=100000 is a way to ask the server for the whole
    // table in one request.
    const requested = toPositiveInt(searchParams.get(limitKey), defaultLimit)
    const limit = limitOptions.includes(requested) ? requested : defaultLimit

    const write = useCallback(
        (changes, { replace = true } = {}) => {
            setSearchParams(
                (prev) => {
                    const next = new URLSearchParams(prev)
                    for (const [key, value] of Object.entries(changes)) {
                        // Page one and the default size are the absence of a
                        // parameter, so the plain URL stays plain.
                        if (value === null || value === undefined) next.delete(key)
                        else next.set(key, String(value))
                    }
                    return next
                },
                { replace },
            )
        },
        [setSearchParams],
    )

    const setPage = useCallback(
        (next) => {
            const value = typeof next === "function" ? next(page) : next
            const clamped = Math.max(1, toPositiveInt(value, 1))
            // Pushed, not replaced: moving through pages is navigation, and the
            // back button should walk back through them.
            write({ [pageKey]: clamped === 1 ? null : clamped }, { replace: false })
        },
        [page, pageKey, write],
    )

    const setLimit = useCallback(
        (next) => {
            const value = toPositiveInt(next, defaultLimit)
            const clamped = limitOptions.includes(value) ? value : defaultLimit
            // Back to page one: page 7 of 50-per-page is off the end at 100.
            write({
                [limitKey]: clamped === defaultLimit ? null : clamped,
                [pageKey]: null,
            })
        },
        [defaultLimit, limitKey, limitOptions, pageKey, write],
    )

    return useMemo(
        () => ({ page, limit, setPage, setLimit, limitOptions }),
        [page, limit, setPage, setLimit, limitOptions],
    )
}
