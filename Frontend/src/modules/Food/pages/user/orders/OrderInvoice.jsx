import { useParams, Link } from "react-router-dom"

import { Download, ArrowLeft, Printer } from "lucide-react"
import { useState, useEffect } from "react"
import { toast } from "sonner"
import AnimatedPage from "@food/components/user/AnimatedPage"
import ScrollReveal from "@food/components/user/ScrollReveal"
import { Card, CardContent } from "@food/components/ui/card"
import { Button } from "@food/components/ui/button"
import { Badge } from "@food/components/ui/badge"
import { orderAPI } from "@food/api"
import { printOrderInvoice } from "@food/utils/printInvoice"

/**
 * Customer copy of the order invoice. Every number comes from the shared
 * invoice endpoint (GET /food/user/orders/:orderId/invoice), the same builder
 * the admin and restaurant copies print from, so all copies match.
 */

/** "₹ 150" / "₹ 12.50", as the receipt prints it. */
const money = (value) => {
  const v = Math.round((Number(value) || 0) * 100) / 100
  return `₹ ${Number.isInteger(v) ? v : v.toFixed(2)}`
}

const lineAmount = (line) => {
  if (line.display) return line.display
  const text = money(Math.abs(line.amount))
  if (line.sign === "-") return `- ${text}`
  if (line.sign === "+" && !["subtotal", "itemsPrice", "addonCost"].includes(line.key)) return `+ ${text}`
  return text
}

export default function OrderInvoice() {
  const { orderId } = useParams()
  const [invoice, setInvoice] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [printing, setPrinting] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    orderAPI
      .getOrderInvoice(orderId)
      .then((response) => {
        if (!active) return
        const data = response?.data?.data?.invoice
        if (data) setInvoice(data)
        else setError("Invoice not found")
      })
      .catch((err) => {
        if (active) setError(err?.response?.status === 404 ? "Invoice not found" : "Failed to load invoice details")
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [orderId])

  const handlePrint = async (size) => {
    if (printing) return
    setPrinting(true)
    try {
      await printOrderInvoice((params) => orderAPI.getOrderInvoice(orderId, params), { size })
    } catch {
      toast.error("Could not open the invoice")
    } finally {
      setPrinting(false)
    }
  }

  if (loading) {
    return (
      <AnimatedPage className="min-h-screen bg-[#f5f5f5] dark:bg-[#0a0a0a] p-4">
        <div className="max-w-4xl mx-auto text-center py-20">
          <div className="w-8 h-8 border-2 border-[#EB590E] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Generating invoice...</p>
        </div>
      </AnimatedPage>
    )
  }

  if (error || !invoice) {
    return (
      <AnimatedPage className="min-h-screen bg-[#f5f5f5] dark:bg-[#0a0a0a] p-4">
        <div className="max-w-4xl mx-auto text-center py-20">
          <h1 className="text-lg sm:text-xl md:text-2xl font-bold mb-4">{error || "Order Not Found"}</h1>
          <Link to="/user/orders">
            <Button>Back to Orders</Button>
          </Link>
        </div>
      </AnimatedPage>
    )
  }

  const { restaurant, customer, items, lines, payment, footer } = invoice

  return (
    <AnimatedPage className="min-h-screen bg-gradient-to-b from-yellow-50/30 via-white to-orange-50/20 dark:from-[#0a0a0a] dark:via-[#1a1a1a] dark:to-[#0a0a0a] p-3 sm:p-4 md:p-6 lg:p-8">
      <div className="max-w-2xl mx-auto space-y-4 sm:space-y-6">
        <ScrollReveal>
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 sm:gap-4">
            <div className="flex items-center gap-3 sm:gap-4">
              <Link to={`/user/orders/${orderId}`}>
                <Button variant="ghost" size="icon" className="rounded-full h-8 w-8 sm:h-10 sm:w-10">
                  <ArrowLeft className="h-4 w-4 sm:h-5 sm:w-5" />
                </Button>
              </Link>
              <div>
                <h1 className="text-lg sm:text-xl md:text-2xl font-bold">Invoice</h1>
                <p className="text-muted-foreground text-sm sm:text-base">Order #{invoice.orderId}</p>
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => handlePrint("thermal")}
                disabled={printing}
                className="flex items-center gap-2 text-xs sm:text-sm h-9 sm:h-10"
              >
                <Printer className="h-3 w-3 sm:h-4 sm:w-4" />
                <span>Print receipt</span>
              </Button>
              <Button
                onClick={() => handlePrint("a4")}
                disabled={printing}
                className="bg-[#EB590E] hover:bg-[#D94F0C] flex items-center gap-2 text-xs sm:text-sm h-9 sm:h-10"
              >
                <Download className="h-3 w-3 sm:h-4 sm:w-4 text-white" />
                <span className="text-white">Download (A4)</span>
              </Button>
            </div>
          </div>
        </ScrollReveal>

        <ScrollReveal delay={0.1}>
          <Card className="dark:bg-[#1a1a1a] dark:border-gray-800">
            <CardContent className="p-4 sm:p-6 md:p-8 font-mono text-sm">
              <div className="text-center space-y-0.5">
                <h2 className="text-lg font-bold font-sans">{restaurant.name}</h2>
                {restaurant.address ? <p className="text-xs text-muted-foreground">{restaurant.address}</p> : null}
                {restaurant.phone ? <p className="text-xs text-muted-foreground">Phone : {restaurant.phone}</p> : null}
                {restaurant.gstNumber ? <p className="text-xs text-muted-foreground">GSTIN : {restaurant.gstNumber}</p> : null}
                <p className="font-bold pt-2">{invoice.title}</p>
                {invoice.isCancelled ? (
                  <Badge className="bg-rose-600 text-white">CANCELLED</Badge>
                ) : null}
              </div>

              <div className="border-t border-dashed my-3" />
              <p>Order id : {invoice.orderId}</p>
              <p>{invoice.date}</p>
              <div className="border-t border-dashed my-3" />
              <p>Contact name : {customer.name}</p>
              {customer.phone ? <p>Phone : {customer.phone}</p> : null}
              <p>Address : {customer.address}</p>

              <div className="border-t border-dashed my-3" />
              <table className="w-full">
                <thead>
                  <tr className="border-b border-dashed">
                    <th className="text-left py-1">Desc</th>
                    <th className="text-center py-1 w-12">Qty</th>
                    <th className="text-right py-1">Price</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.sl} className="align-top">
                      <td className="py-1 pr-2">
                        <div className="font-bold">{item.name}</div>
                        <div className="text-xs text-muted-foreground">{money(item.unitPrice)}</div>
                        {item.variantName ? <div className="text-xs text-muted-foreground">Size: {item.variantName}</div> : null}
                        {item.addons.map((addon, i) => (
                          <div key={i} className="text-xs text-muted-foreground">+ {addon.name} ({money(addon.price)})</div>
                        ))}
                        {item.notes ? <div className="text-xs text-muted-foreground">Note: {item.notes}</div> : null}
                      </td>
                      <td className="py-1 text-center">{item.quantity}</td>
                      <td className="py-1 text-right whitespace-nowrap">{money(item.lineTotal)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="border-t border-dashed my-3" />
              <div className="space-y-1">
                {lines.map((line) => (
                  <div key={line.key} className={`flex justify-between gap-3 ${line.info ? "text-muted-foreground" : ""}`}>
                    <span>{line.label} :</span>
                    <span className="whitespace-nowrap">{lineAmount(line)}</span>
                  </div>
                ))}
                <div className="flex justify-between gap-3 border-t border-dashed pt-2 mt-2 text-base font-bold">
                  <span>Total :</span>
                  <span>{money(invoice.total)}</span>
                </div>
              </div>

              <div className="mt-2 space-y-0.5">
                <div className="flex justify-between gap-3">
                  <span>Payment :</span>
                  <span className="text-right">{payment.methodLabel} · {payment.statusLabel}</span>
                </div>
                {payment.split.map((part) => (
                  <div key={part.key} className="flex justify-between gap-3 text-xs text-muted-foreground">
                    <span>{part.label}</span>
                    <span>{money(part.amount)}</span>
                  </div>
                ))}
                {payment.refund ? (
                  <div className="flex justify-between gap-3 text-xs text-muted-foreground">
                    <span>Refunded</span>
                    <span>{money(payment.refund.amount)}</span>
                  </div>
                ) : null}
              </div>

              <div className="border-t border-dashed my-3" />
              <div className="text-center">
                <p className="font-bold">{footer.thanks}</p>
                <p className="text-xs text-muted-foreground">{footer.text}</p>
              </div>
            </CardContent>
          </Card>
        </ScrollReveal>

        <ScrollReveal delay={0.2}>
          <div className="flex flex-col sm:flex-row gap-2 sm:gap-4">
            <Link to={`/user/orders/${orderId}`} className="flex-1">
              <Button variant="outline" className="w-full text-sm sm:text-base h-10 sm:h-11">
                Track Order
              </Button>
            </Link>
            <Link to="/user/orders" className="flex-1">
              <Button variant="outline" className="w-full text-sm sm:text-base h-10 sm:h-11">
                Back to Orders
              </Button>
            </Link>
          </div>
        </ScrollReveal>
      </div>
    </AnimatedPage>
  )
}
