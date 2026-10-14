import { useCallback, useEffect, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { toast } from "sonner"
import { Loader2, Send } from "@food/components/admin/theme/icons"
import { chatAPI } from "@food/api"
import { EmptyState, ErrorState, Panel, Pill, Spinner, errorMessage, formatDateTime, mediaUrl, payload, titleCase } from "./shared"

/**
 * Support threads between the admin desk and this restaurant, from the same
 * chat endpoints as Live Chat, filtered to this store. A message can be sent
 * from here; the full desk (assigning, closing, photos) is on Live Chat.
 */

const ADMIN_CONFIG = { contextModule: "admin" }

export default function ConversationsTab({ restaurantId }) {
  const token = `RESTAURANT:${restaurantId}`
  const [list, setList] = useState({ loading: true, error: "", conversations: [] })
  const [selectedId, setSelectedId] = useState("")
  const [thread, setThread] = useState({ loading: false, messages: [] })
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const bottomRef = useRef(null)

  const loadList = useCallback(async () => {
    setList((s) => ({ ...s, loading: true, error: "" }))
    try {
      const all = payload(await chatAPI.listConversations({}, ADMIN_CONFIG)).conversations || []
      const mine = all.filter((c) => c.peerToken === token)
      setList({ loading: false, error: "", conversations: mine })
      setSelectedId((current) => current || mine[0]?.conversationId || "")
    } catch (err) {
      setList((s) => ({ ...s, loading: false, error: errorMessage(err, "Could not load conversations") }))
    }
  }, [token])

  const loadThread = useCallback(async (conversationId) => {
    if (!conversationId) {
      setThread({ loading: false, messages: [] })
      return
    }
    setThread((s) => ({ ...s, loading: true }))
    try {
      const messages = payload(await chatAPI.getHistory({ conversationId, limit: 100 }, ADMIN_CONFIG)).messages || []
      setThread({ loading: false, messages })
    } catch (err) {
      setThread({ loading: false, messages: [] })
      toast.error(errorMessage(err, "Could not load this conversation"))
    }
  }, [])

  useEffect(() => {
    loadList()
  }, [loadList])

  useEffect(() => {
    loadThread(selectedId)
  }, [selectedId, loadThread])

  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: "end" })
  }, [thread.messages])

  const selected = list.conversations.find((c) => c.conversationId === selectedId)

  const send = async (e) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setSending(true)
    try {
      const res = await chatAPI.sendMessage(
        {
          text,
          peerRole: "RESTAURANT",
          peerId: restaurantId,
          ...(selected ? { conversationId: selected.conversationId } : {}),
          ...(selected?.orderId ? { orderId: selected.orderId } : {}),
        },
        ADMIN_CONFIG,
      )
      const sent = payload(res).message
      setDraft("")
      if (sent && selected) {
        setThread((s) => ({ ...s, messages: [...s.messages, sent] }))
      } else {
        // A first message opens a thread; pick it up from the list.
        if (sent?.conversationId) setSelectedId(sent.conversationId)
        loadList()
      }
    } catch (err) {
      toast.error(errorMessage(err, "Could not send the message"))
    } finally {
      setSending(false)
    }
  }

  return (
    <Panel
      title="Conversations"
      bodyClassName=""
      actions={
        <Link to="/admin/food/chattings" className="text-sm font-semibold text-teal-700 hover:underline">
          Open Live Chat
        </Link>
      }
    >
      {list.loading ? (
        <Spinner />
      ) : list.error ? (
        <ErrorState message={list.error} onRetry={loadList} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-[260px_1fr]">
          <div className="max-h-72 overflow-y-auto border-b border-slate-100 md:max-h-[480px] md:border-b-0 md:border-r">
            {list.conversations.length === 0 ? (
              <EmptyState title="No conversations">The admin desk has not chatted with this store yet. Send a message to start.</EmptyState>
            ) : (
              list.conversations.map((c) => (
                <button
                  key={c.conversationId}
                  type="button"
                  onClick={() => setSelectedId(c.conversationId)}
                  className={`block w-full border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50 ${c.conversationId === selectedId ? "bg-teal-50" : ""}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-sm font-medium text-slate-800">{c.title || (c.orderNumber ? `Order ${c.orderNumber}` : "Support")}</p>
                    {c.unread > 0 && <span className="rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">{c.unread}</span>}
                  </div>
                  <p className="truncate text-xs text-slate-500">{c.lastMessage || "No messages yet"}</p>
                  <div className="mt-1 flex items-center gap-2">
                    <Pill tone={c.status === "closed" ? "slate" : "green"}>{titleCase(c.status)}</Pill>
                    <span className="text-[10px] text-slate-400">{formatDateTime(c.lastAt || c.createdAt)}</span>
                  </div>
                </button>
              ))
            )}
          </div>
          <div className="flex min-w-0 flex-col">
            <div className="h-80 overflow-y-auto bg-slate-50 p-4 md:h-[420px]">
              {thread.loading ? (
                <Spinner />
              ) : thread.messages.length === 0 ? (
                <p className="py-10 text-center text-xs text-slate-400">{selected ? "No messages in this thread." : "Write below to message this store."}</p>
              ) : (
                <div className="space-y-2">
                  {thread.messages.map((m) => {
                    const mine = m.senderRole === "ADMIN"
                    return (
                      <div key={m.id || m._id || `${m.createdAt}-${m.text}`} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${mine ? "bg-teal-600 text-white" : "bg-white text-slate-800 border border-slate-200"}`}>
                          {(m.attachments || []).map((a, i) => (
                            <a key={i} href={mediaUrl(a.url || a.path)} target="_blank" rel="noreferrer">
                              <img src={mediaUrl(a.url || a.path)} alt="" className="mb-1 max-h-40 rounded-lg" />
                            </a>
                          ))}
                          {m.text && <p className="whitespace-pre-wrap break-words">{m.text}</p>}
                          <p className={`mt-0.5 text-[10px] ${mine ? "text-teal-100" : "text-slate-400"}`}>
                            {[m.senderName, formatDateTime(m.createdAt)].filter(Boolean).join(" · ")}
                          </p>
                        </div>
                      </div>
                    )
                  })}
                  <div ref={bottomRef} />
                </div>
              )}
            </div>
            <form onSubmit={send} className="flex gap-2 border-t border-slate-100 p-3">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={2000}
                placeholder="Message this store"
                className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500"
              />
              <button type="submit" disabled={sending || !draft.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-teal-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
                {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send
              </button>
            </form>
          </div>
        </div>
      )}
    </Panel>
  )
}
