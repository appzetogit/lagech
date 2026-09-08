import { useEffect } from "react"

/**
 * Let a table's scroll box run to the bottom of the screen.
 *
 * The box has to have a height for its sticky header to work at all -- with no
 * height it never scrolls, the page scrolls instead, and the header goes with
 * it. That height started as `calc(100vh - 20rem)`: one constant standing in
 * for the chrome above the table. It cannot be right on more than one page.
 * Order Detect has nine stat cards above its table, All Orders has a title, and
 * the same subtraction leaves the second one with a couple of hundred pixels of
 * dead space underneath and a scrollbar it does not need.
 *
 * So it is measured instead. The CSS keeps the constant as its fallback, which
 * is what applies before this runs and if it never does.
 */

/** Breathing room under the table, so it does not sit flush on the edge. */
const GAP = 24

export function useFitTablesToViewport(mainRef, deps = []) {
    useEffect(() => {
        const main = mainRef?.current
        if (!main) return undefined

        let frame = 0

        const measure = () => {
            frame = 0
            const mainTop = main.getBoundingClientRect().top

            for (const box of main.querySelectorAll(".overflow-x-auto")) {
                if (!box.querySelector(":scope > table")) continue

                // Distance from the top of the scrolled content, not from the top
                // of the screen: taken from the screen it would change as the
                // admin scrolls and the table would resize under them.
                const offsetWithinMain =
                    box.getBoundingClientRect().top - mainTop + main.scrollTop

                // Whatever the card puts under the table -- the pagination strip
                // lives outside the scroll box but inside the same card, so a
                // height that ignored it pushed the card past the bottom by
                // exactly the height of the line saying how many rows there are.
                let below = 0
                for (let next = box.nextElementSibling; next; next = next.nextElementSibling) {
                    below += next.getBoundingClientRect().height
                }

                const available = Math.round(main.clientHeight - offsetWithinMain - below - GAP)

                // Too small to be useful means the table is far enough down the
                // page that it gets its own screen; the CSS floor covers that.
                if (available < 200) {
                    box.style.removeProperty("--table-max-h")
                    continue
                }

                const next = `${available}px`
                if (box.style.getPropertyValue("--table-max-h") !== next) {
                    box.style.setProperty("--table-max-h", next)
                }
            }
        }

        const schedule = () => {
            if (frame) return
            frame = requestAnimationFrame(measure)
        }

        schedule()

        // The size of the window, of anything above the table, and the arrival of
        // the table itself all move the answer.
        const resizeObserver = new ResizeObserver(schedule)
        resizeObserver.observe(main)

        const mutationObserver = new MutationObserver(schedule)
        mutationObserver.observe(main, { childList: true, subtree: true })

        window.addEventListener("resize", schedule)

        return () => {
            if (frame) cancelAnimationFrame(frame)
            resizeObserver.disconnect()
            mutationObserver.disconnect()
            window.removeEventListener("resize", schedule)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
}
