import { useNavigate } from "react-router-dom"
import { ChevronLeft } from "lucide-react"

import SupportChat from "@food/components/shared/SupportChat"

/**
 * A rider's live line to support.
 *
 * Tickets already existed, and they are the right shape for something that
 * needs a paper trail. They are the wrong shape for "I am standing outside a
 * closed restaurant with the customer's food" -- which is most of what a rider
 * needs support for, and which stops mattering in twenty minutes.
 *
 * The rider's own token, and the delivery module for the API client; the server
 * works the rest out from who is signed in.
 */
export function SupportChatV2() {
  const navigate = useNavigate()

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <div className="flex items-center gap-3 border-b border-slate-200 bg-white px-4 py-3">
        <button
          type="button"
          onClick={() => navigate(-1)}
          aria-label="Go back"
          className="rounded-lg p-1 text-slate-600 hover:bg-slate-100"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <h1 className="text-base font-semibold text-slate-900">Chat with support</h1>
      </div>

      <SupportChat
        className="m-4 min-h-0 flex-1 border-0 shadow-sm"
        contextModule="delivery"
        // The rider app keeps its own token; the generic one is the fallback
        // for a session that predates the split.
        tokenKeys={["delivery_accessToken", "accessToken"]}
        heading="Support"
        subheading="Photos help — the restaurant, the address, whatever you are looking at."
      />
    </div>
  )
}

export default SupportChatV2
