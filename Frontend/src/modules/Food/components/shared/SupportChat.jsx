import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Loader2, Paperclip, Send, X } from "lucide-react"
import { toast } from "sonner"

import { chatAPI } from "@food/api"
import { useChatSocket } from "@food/hooks/useChatSocket"

/**
 * One conversation with support, from the customer's or the rider's side.
 *
 * The same screen serves both because the difference between them is two
 * strings: which stored token to authenticate with, and which module the API
 * client should attribute the call to. Everything else -- the thread, the
 * history, the socket room -- the server works out from who is signed in.
 *
 * Support is a single destination rather than a person: conversation ids are
 * derived from the two parties, so there is exactly one thread per customer and
 * it is found rather than chosen. Nobody has to pick who to write to.
 */

const MAX_ATTACHMENTS = 5

const clockTime = (value) =>
  value
    ? new Date(value).toLocaleString("en-GB", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      })
    : ""

export default function SupportChat({
  contextModule = "user",
  tokenKeys = ["accessToken"],
  heading = "Chat with support",
  subheading = "We usually reply within a few minutes.",
  orderId = null,
  className = "",
}) {
  const requestConfig = useMemo(() => ({ contextModule }), [contextModule])

  const [conversationId, setConversationId] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  const [pending, setPending] = useState([])
  const [uploading, setUploading] = useState(false)
  const [lightbox, setLightbox] = useState(null)

  const bottomRef = useRef(null)
  const fileRef = useRef(null)
  const conversationIdRef = useRef(null)
  conversationIdRef.current = conversationId

  const token = useMemo(() => {
    for (const key of tokenKeys) {
      try {
        const value = localStorage.getItem(key)
        if (value) return value
      } catch {
        return ""
      }
    }
    return ""
  }, [tokenKeys])

  // Find the existing thread rather than opening a new one. A second "start
  // chat" must not fork the conversation, and the server derives the same id
  // from the same two parties either way.
  useEffect(() => {
    let cancelled = false

    const open = async () => {
      try {
        const listed = await chatAPI.listConversations({}, requestConfig)
        const rows = listed?.data?.data?.conversations ?? []
        const support = rows.find((c) => c.peerToken === "ADMIN")

        let id = support?.conversationId
        if (!id) {
          const created = await chatAPI.createConversation(
            { peerToken: "ADMIN", ...(orderId ? { orderId } : {}) },
            requestConfig,
          )
          id = created?.data?.data?.conversation?.conversationId
        }
        if (cancelled || !id) return

        setConversationId(id)
        const history = await chatAPI.getHistory({ conversationId: id, limit: 100 }, requestConfig)
        if (!cancelled) setMessages(history?.data?.data?.messages ?? [])
      } catch (error) {
        if (!cancelled) toast.error("Could not open the support chat")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    open()
    return () => {
      cancelled = true
    }
  }, [requestConfig, orderId])

  const handleIncoming = useCallback((payload) => {
    const message = payload?.message || payload
    if (!message?.conversationId) return
    // The room carries every thread this account is in; only this one belongs
    // on screen.
    if (message.conversationId !== conversationIdRef.current) return
    setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
  }, [])

  useChatSocket({ token, onMessage: handleIncoming })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" })
  }, [messages])

  const handleFiles = async (fileList) => {
    const files = [...(fileList || [])]
    if (!files.length) return
    const room = MAX_ATTACHMENTS - pending.length
    if (room <= 0) {
      toast.error(`At most ${MAX_ATTACHMENTS} images per message`)
      return
    }

    setUploading(true)
    try {
      for (const file of files.slice(0, room)) {
        const response = await chatAPI.uploadAttachment(file, requestConfig)
        const attachment = response?.data?.data?.attachment
        if (attachment) setPending((prev) => [...prev, attachment])
      }
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not upload that image")
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const handleSend = async () => {
    const text = draft.trim()
    if ((!text && pending.length === 0) || sending) return

    setSending(true)
    try {
      const response = await chatAPI.sendMessage(
        {
          text,
          ...(pending.length ? { attachments: pending } : {}),
          peerRole: "ADMIN",
          ...(orderId ? { orderId } : {}),
        },
        requestConfig,
      )
      const sent = response?.data?.data?.message
      setDraft("")
      setPending([])
      if (sent) {
        if (!conversationIdRef.current) setConversationId(sent.conversationId)
        setMessages((prev) => (prev.some((m) => m.id === sent.id) ? prev : [...prev, sent]))
      }
    } catch (error) {
      toast.error(error?.response?.data?.message || "Message not sent")
    } finally {
      setSending(false)
    }
  }

  return (
    <div className={`flex flex-col rounded-xl border border-slate-200 bg-white ${className}`}>
      <div className="border-b border-slate-200 p-4">
        <h2 className="text-base font-semibold text-slate-900">{heading}</h2>
        <p className="text-sm text-slate-500">{subheading}</p>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {loading ? (
          <div className="flex h-full items-center justify-center py-10">
            <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
          </div>
        ) : messages.length === 0 ? (
          <p className="py-10 text-center text-sm text-slate-500">
            Tell us what went wrong and we will pick it up from here.
          </p>
        ) : (
          <div className="space-y-3">
            {messages.map((message) => {
              const mine = message.senderRole !== "ADMIN"
              return (
                <div key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[80%] rounded-lg p-3 ${
                      mine ? "bg-teal-600 text-white" : "bg-slate-100 text-slate-900"
                    }`}
                  >
                    {message.attachments?.length ? (
                      <div className="mb-1 flex flex-wrap gap-2">
                        {message.attachments.map((file) => (
                          <button
                            key={file.path}
                            type="button"
                            onClick={() => setLightbox(file.url)}
                            className="block"
                          >
                            <img
                              src={file.url}
                              alt={file.name || "Attachment"}
                              loading="lazy"
                              className="max-h-48 max-w-[12rem] rounded-md object-cover"
                            />
                          </button>
                        ))}
                      </div>
                    ) : null}
                    {message.text ? (
                      <p className="text-sm whitespace-pre-wrap break-words">{message.text}</p>
                    ) : null}
                    <p className={`mt-1 text-xs ${mine ? "text-teal-100" : "text-slate-500"}`}>
                      {clockTime(message.createdAt)}
                    </p>
                  </div>
                </div>
              )
            })}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <div className="border-t border-slate-200 p-4">
        {pending.length ? (
          <div className="mb-3 flex flex-wrap gap-2">
            {pending.map((file) => (
              <div key={file.path} className="relative">
                <img
                  src={file.url}
                  alt={file.name || "Attachment"}
                  className="h-16 w-16 rounded-md border border-slate-200 object-cover"
                />
                <button
                  type="button"
                  aria-label="Remove attachment"
                  onClick={() => setPending((prev) => prev.filter((f) => f.path !== file.path))}
                  className="absolute -right-1.5 -top-1.5 rounded-full bg-slate-800 p-0.5 text-white"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={uploading || pending.length >= MAX_ATTACHMENTS}
            aria-label="Attach a photo"
            className="flex-shrink-0 rounded-lg border border-slate-300 p-2.5 text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {uploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Paperclip className="h-4 w-4" />
            )}
          </button>
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="Describe the issue..."
            maxLength={2000}
            className="flex-1 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm focus:border-teal-500 focus:outline-none focus:ring-2 focus:ring-teal-500"
          />
          <button
            type="button"
            onClick={handleSend}
            disabled={sending || (!draft.trim() && pending.length === 0)}
            aria-label="Send"
            className="inline-flex flex-shrink-0 items-center gap-2 rounded-lg bg-teal-700 px-4 py-2.5 text-sm font-medium text-white hover:bg-teal-800 disabled:opacity-50"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>

      {lightbox ? (
        <div
          role="presentation"
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-6"
        >
          <img
            src={lightbox}
            alt="Attachment"
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        </div>
      ) : null}
    </div>
  )
}
