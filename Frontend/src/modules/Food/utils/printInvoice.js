/**
 * Opens an order invoice (the server-rendered printable page from
 * GET .../orders/:orderId/invoice?format=html) in a new tab and brings up the
 * print dialog, like the old panel's "Print invoice".
 *
 * The tab is opened synchronously, inside the click, so popup blockers allow
 * it; the HTML is fetched with the signed-in module's token (a plain link
 * could not carry it) and written into the tab. When the popup is blocked
 * anyway, the page is printed from a hidden iframe instead.
 *
 * @param {(params: object) => Promise<{data: string}>} fetchHtml  e.g. (p) => adminAPI.getOrderInvoice(id, p)
 * @param {{ size?: "thermal" | "a4" }} options
 */
export async function printOrderInvoice(fetchHtml, { size = "thermal" } = {}) {
  const win = window.open("", "_blank")
  if (win) {
    try {
      win.document.write('<p style="font-family:sans-serif;padding:16px">Preparing invoice…</p>')
    } catch {
      /* ignore */
    }
  }

  let html
  try {
    const res = await fetchHtml({ format: "html", size })
    html = typeof res?.data === "string" ? res.data : ""
    if (!html) throw new Error("Empty invoice")
  } catch (error) {
    if (win) win.close()
    throw error
  }

  const triggerPrint = (target) => {
    setTimeout(() => {
      try {
        target.focus()
        target.print()
      } catch {
        /* the user can still print from the tab */
      }
    }, 400)
  }

  if (win && !win.closed) {
    win.document.open()
    win.document.write(html)
    win.document.close()
    triggerPrint(win)
    return
  }

  const frame = document.createElement("iframe")
  frame.style.position = "fixed"
  frame.style.width = "0"
  frame.style.height = "0"
  frame.style.border = "0"
  frame.setAttribute("aria-hidden", "true")
  document.body.appendChild(frame)
  const doc = frame.contentWindow.document
  doc.open()
  doc.write(html)
  doc.close()
  triggerPrint(frame.contentWindow)
  setTimeout(() => frame.remove(), 60000)
}
