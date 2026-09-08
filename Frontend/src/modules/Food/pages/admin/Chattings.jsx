import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Info, Loader2, Paperclip, Search, Send, X } from "lucide-react"
import { toast } from "sonner"

import { chatAPI } from "@food/api"
import { useChatSocket } from "@food/hooks/useChatSocket"

/**
 * The support inbox.
 *
 * This screen existed as a shell reading `emptyConversations`, a hardcoded empty
 * array, so it had never shown anything. The backend it needed was already
 * there: threads, history, read receipts, open/closed status, and sockets that
 * push both new messages and thread updates into the admin room.
 *
 * Everything an admin sees is one room's worth of events. Nothing subscribes to
 * a single thread -- the server puts every admin in `rooms.admin()` -- which is
 * why a message on a conversation that is not open on screen still moves it to
 * the top of the list and raises its unread count.
 */

const TABS = [
  { key: "USER", label: "Customers" },
  { key: "DELIVERY_PARTNER", label: "Delivery" },
  { key: "RESTAURANT", label: "Restaurants" },
]

// Admin calls must say so: the token is looked up per module, and without this
// the chat endpoints would be sent the customer app's token.
const ADMIN_CONFIG = { contextModule: "admin" }

/** Matches the server, which refuses a sixth. */
const MAX_ATTACHMENTS = 5

/** What a list row says for a message that is only pictures. */
const photoSummary = (count) => `${count} photo${count === 1 ? "" : "s"}`

const timeAgo = (value) => {
  if (!value) return ""
  const then = new Date(value).getTime()
  if (Number.isNaN(then)) return ""
  const seconds = Math.round((Date.now() - then) / 1000)
  if (seconds < 60) return "just now"
  if (seconds < 3600) return Math.floor(seconds / 60) + "m"
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h"
  if (seconds < 604800) return Math.floor(seconds / 86400) + "d"
  return new Date(value).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })
}

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

const initialsOf = (name) =>
  String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || "")
    .join("") || "?"

export default function Chattings() {
  const [activeTab, setActiveTab] = useState("USER")
  const [searchQuery, setSearchQuery] = useState("")
  const [conversations, setConversations] = useState([])
  const [loadingList, setLoadingList] = useState(true)

  const [selectedId, setSelectedId] = useState(null)
  const [messages, setMessages] = useState([])
  const [loadingThread, setLoadingThread] = useState(false)
  const [draft, setDraft] = useState("")
  const [sending, setSending] = useState(false)
  // Uploaded and held until the message is sent, so the picture is already on
  // the server by the time Send is pressed.
  const [pending, setPending] = useState([])
  const [uploading, setUploading] = useState(false)
  const [lightbox, setLightbox] = useState(null)
  const [updatingStatus, setUpdatingStatus] = useState(false)
  const [assigning, setAssigning] = useState(false)
  // Whose threads are mine. Read from the token rather than fetched: it is
  // already in hand, and this only decides which label a button shows.
  const myAdminId = useMemo(() => {
    try {
      const raw = localStorage.getItem("admin_accessToken") || ""
      const body = raw.split(".")[1]
      if (!body) return ""
      return JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/")))?.userId || ""
    } catch {
      return ""
    }
  }, [])

  const bottomRef = useRef(null)
  const fileRef = useRef(null)
  // Read inside the socket handlers, which must not re-subscribe when it moves.
  const selectedIdRef = useRef(null)
  selectedIdRef.current = selectedId

  const token = (() => {
    try {
      return localStorage.getItem("admin_accessToken") || ""
    } catch {
      return ""
    }
  })()

  const loadConversations = useCallback(async () => {
    try {
      const response = await chatAPI.listConversations({}, ADMIN_CONFIG)
      const rows = response?.data?.data?.conversations ?? []
      setConversations(Array.isArray(rows) ? rows : [])
    } catch (error) {
      toast.error("Could not load conversations")
      setConversations([])
    } finally {
      setLoadingList(false)
    }
  }, [])

  useEffect(() => {
    loadConversations()
  }, [loadConversations])

  const openConversation = useCallback(async (conversationId) => {
    setSelectedId(conversationId)
    setLoadingThread(true)
    setMessages([])
    try {
      const response = await chatAPI.getHistory({ conversationId, limit: 100 }, ADMIN_CONFIG)
      setMessages(response?.data?.data?.messages ?? [])
      // getHistory marks them read server-side; mirrored here so the badge
      // clears without waiting for the list to be fetched again.
      setConversations((prev) =>
        prev.map((c) => (c.conversationId === conversationId ? { ...c, unread: 0 } : c)),
      )
    } catch (error) {
      toast.error("Could not load this conversation")
    } finally {
      setLoadingThread(false)
    }
  }, [])

  // A message can arrive for a thread that is not on screen, so the list is
  // updated whether or not it is the open one.
  const handleIncoming = useCallback(
    (payload) => {
      const message = payload?.message || payload
      const conversationId = message?.conversationId
      if (!conversationId) return

      if (conversationId === selectedIdRef.current) {
        setMessages((prev) => (prev.some((m) => m.id === message.id) ? prev : [...prev, message]))
      }

      setConversations((prev) => {
        const index = prev.findIndex((c) => c.conversationId === conversationId)
        if (index === -1) {
          // The first message of a thread this admin has not listed yet.
          loadConversations()
          return prev
        }
        const existing = prev[index]
        const updated = {
          ...existing,
          lastMessage:
            message.text ||
            (message.attachments?.length ? photoSummary(message.attachments.length) : existing.lastMessage),
          lastAt: message.createdAt ?? existing.lastAt,
          unread:
            conversationId === selectedIdRef.current
              ? 0
              : Number(existing.unread || 0) + (message.senderRole === "ADMIN" ? 0 : 1),
        }
        // Newest first, the same order the list is fetched in.
        return [updated, ...prev.slice(0, index), ...prev.slice(index + 1)]
      })
    },
    [loadConversations],
  )

  const handleConversationUpdate = useCallback(
    (payload) => {
      const doc = payload?.conversation || payload
      if (!doc?.conversationId) return
      setConversations((prev) => {
        const index = prev.findIndex((c) => c.conversationId === doc.conversationId)
        if (index === -1) {
          loadConversations()
          return prev
        }
        const next = [...prev]
        // Merged, not replaced: the socket payload carries the thread's own
        // fields and zeroes for the ones derived from messages.
        next[index] = {
          ...next[index],
          status: doc.status,
          title: doc.title,
          closedAt: doc.closedAt,
        }
        return next
      })
    },
    [loadConversations],
  )

  useChatSocket({
    token,
    onMessage: handleIncoming,
    onConversationUpdate: handleConversationUpdate,
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" })
  }, [messages])

  const selected = useMemo(
    () => conversations.find((c) => c.conversationId === selectedId) || null,
    [conversations, selectedId],
  )

  const visible = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    return conversations.filter((c) => {
      if ((c.peer?.role || "") !== activeTab) return false
      if (!query) return true
      return (
        String(c.peer?.name || "").toLowerCase().includes(query) ||
        String(c.peer?.phone || "").includes(query) ||
        String(c.title || "").toLowerCase().includes(query)
      )
    })
  }, [conversations, activeTab, searchQuery])

  const unreadByTab = useMemo(() => {
    const counts = {}
    for (const c of conversations) {
      const role = c.peer?.role || ""
      counts[role] = (counts[role] || 0) + Number(c.unread || 0)
    }
    return counts
  }, [conversations])

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
        const response = await chatAPI.uploadAttachment(file, ADMIN_CONFIG)
        const attachment = response?.data?.data?.attachment
        if (attachment) setPending((prev) => [...prev, attachment])
      }
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not upload that image")
    } finally {
      setUploading(false)
      // Or picking the same file twice in a row fires no change event.
      if (fileRef.current) fileRef.current.value = ""
    }
  }

  const handleSend = async () => {
    const text = draft.trim()
    // A photo on its own is a message; nothing at all is not.
    if ((!text && pending.length === 0) || !selected || sending) return

    setSending(true)
    try {
      const response = await chatAPI.sendMessage(
        {
          text,
          ...(pending.length ? { attachments: pending } : {}),
          conversationId: selected.conversationId,
          peerRole: selected.peer?.role,
          peerId: selected.peer?.id,
          ...(selected.orderId ? { orderId: selected.orderId } : {}),
        },
        ADMIN_CONFIG,
      )
      const sent = response?.data?.data?.message
      setDraft("")
      setPending([])
      if (sent) {
        // Only if the server agrees it belongs here. Conversation ids are
        // derived from who is talking, not taken from the request, so a reply
        // can land in a different thread than the one on screen -- appending
        // it regardless would draw a message into a conversation it is not in.
        if (sent.conversationId !== selected.conversationId) {
          loadConversations()
          openConversation(sent.conversationId)
          return
        }
        setMessages((prev) => (prev.some((m) => m.id === sent.id) ? prev : [...prev, sent]))
        setConversations((prev) =>
          prev.map((c) =>
            c.conversationId === selected.conversationId
              ? {
                  ...c,
                  lastMessage: sent.text || photoSummary(sent.attachments?.length || 0),
                  lastAt: sent.createdAt,
                }
              : c,
          ),
        )
      }
    } catch (error) {
      toast.error(error?.response?.data?.message || "Message not sent")
    } finally {
      setSending(false)
    }
  }

  const toggleAssignment = async () => {
    if (!selected || assigning) return
    const take = selected.assignedAdminId !== myAdminId
    setAssigning(true)
    try {
      const response = await chatAPI.assign(selected.conversationId, take, ADMIN_CONFIG)
      const updated = response?.data?.data?.conversation
      setConversations((prev) =>
        prev.map((c) =>
          c.conversationId === selected.conversationId
            ? {
                ...c,
                assignedAdminId: updated?.assignedAdminId ?? null,
                assignedAdmin: updated?.assignedAdmin ?? null,
                status: updated?.status ?? c.status,
              }
            : c,
        ),
      )
      toast.success(take ? "Assigned to you" : "Released")
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not change the assignment")
    } finally {
      setAssigning(false)
    }
  }

  const toggleStatus = async () => {
    if (!selected || updatingStatus) return
    const next = selected.status === "closed" ? "open" : "closed"
    setUpdatingStatus(true)
    try {
      await chatAPI.setStatus(selected.conversationId, next, ADMIN_CONFIG)
      setConversations((prev) =>
        prev.map((c) =>
          c.conversationId === selected.conversationId ? { ...c, status: next } : c,
        ),
      )
      toast.success(next === "closed" ? "Conversation closed" : "Conversation reopened")
    } catch (error) {
      toast.error(error?.response?.data?.message || "Could not update the conversation")
    } finally {
      setUpdatingStatus(false)
    }
  }

  return (
    <div className="p-4 lg:p-6 bg-slate-50 min-h-screen">
      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="grid grid-cols-1 lg:grid-cols-[22rem_1fr] h-[calc(100vh-10rem)]">
            {/* Conversation list */}
            <div className="border-r border-slate-200 flex flex-col min-h-0">
              <div className="p-4 border-b border-slate-200">
                <h1 className="text-xl font-bold text-slate-900 mb-3">Conversations</h1>

                <div className="relative mb-3">
                  <input
                    type="text"
                    placeholder="Search by name, phone or subject"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2.5 text-sm rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-2 focus:ring-slate-400 focus:border-slate-400"
                  />
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                </div>

                <div className="flex items-center gap-1 border-b border-slate-200">
                  {TABS.map((tab) => (
                    <button
                      key={tab.key}
                      type="button"
                      onClick={() => setActiveTab(tab.key)}
                      className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                        activeTab === tab.key
                          ? "border-teal-600 text-teal-700"
                          : "border-transparent text-slate-600 hover:text-slate-900"
                      }`}
                    >
                      {tab.label}
                      {unreadByTab[tab.key] ? (
                        <span className="ml-1.5 inline-flex min-w-[1.25rem] justify-center rounded-full bg-red-500 px-1 text-xs font-semibold text-white">
                          {unreadByTab[tab.key]}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex-1 overflow-y-auto min-h-0">
                {loadingList ? (
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                  </div>
                ) : visible.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full p-6 text-center">
                    <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-4">
                      <Info className="w-8 h-8 text-slate-400" />
                    </div>
                    <p className="text-sm text-slate-500">No conversations here yet</p>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-100">
                    {visible.map((conversation) => (
                      <button
                        key={conversation.conversationId}
                        type="button"
                        onClick={() => openConversation(conversation.conversationId)}
                        className={`w-full p-4 text-left hover:bg-slate-50 transition-colors ${
                          selectedId === conversation.conversationId ? "bg-teal-50" : ""
                        }`}
                      >
                        <div className="flex items-center gap-3">
                          <div className="w-11 h-11 rounded-full bg-slate-200 flex items-center justify-center flex-shrink-0 text-sm font-semibold text-slate-600">
                            {initialsOf(conversation.peer?.name)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-2 mb-0.5">
                              <h3 className="text-sm font-semibold text-slate-900 truncate">
                                {conversation.peer?.name || "Unknown"}
                              </h3>
                              <span className="text-xs text-slate-500 flex-shrink-0">
                                {timeAgo(conversation.lastAt || conversation.createdAt)}
                              </span>
                            </div>
                            <p className="text-xs text-slate-500 truncate">
                              {[conversation.peer?.phone, conversation.orderId ? "order" : ""]
                                .filter(Boolean)
                                .join(" · ") || conversation.title || ""}
                            </p>
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm text-slate-600 truncate">
                                {conversation.lastMessage || "No messages yet"}
                              </p>
                              {conversation.unread ? (
                                <span className="inline-flex min-w-[1.25rem] justify-center rounded-full bg-red-500 px-1 text-xs font-semibold text-white flex-shrink-0">
                                  {conversation.unread}
                                </span>
                              ) : null}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1">
                              {conversation.status === "closed" ? (
                                <span className="inline-block rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                                  Closed
                                </span>
                              ) : null}
                              {conversation.assignedAdmin ? (
                                <span className="inline-block rounded bg-teal-50 px-1.5 py-0.5 text-xs text-teal-700">
                                  {conversation.assignedAdminId === myAdminId
                                    ? "You"
                                    : conversation.assignedAdmin.name}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Thread */}
            <div className="flex flex-col min-h-0">
              {selected ? (
                <>
                  <div className="p-4 border-b border-slate-200 flex items-center justify-between gap-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-11 h-11 rounded-full bg-slate-200 flex items-center justify-center flex-shrink-0 text-sm font-semibold text-slate-600">
                        {initialsOf(selected.peer?.name)}
                      </div>
                      <div className="min-w-0">
                        <h2 className="text-base font-semibold text-slate-900 truncate">
                          {selected.peer?.name || "Unknown"}
                        </h2>
                        <p className="text-sm text-slate-500 truncate">
                          {/* A customer can have several threads once they ask
                              about particular orders, so the order this one is
                              about is what tells them apart. */}
                          {[
                            selected.peer?.phone,
                            selected.title,
                            selected.orderId ? `Order ${selected.orderId}` : "",
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                        <p className="text-xs text-slate-500 truncate">
                          {selected.assignedAdmin
                            ? `Handled by ${
                                selected.assignedAdminId === myAdminId
                                  ? "you"
                                  : selected.assignedAdmin.name
                              }`
                            : "Nobody has picked this up"}
                        </p>
                      </div>
                    </div>
                    <div className="flex flex-shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={toggleAssignment}
                        disabled={assigning}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {selected.assignedAdminId === myAdminId ? "Release" : "Assign to me"}
                      </button>
                      <button
                        type="button"
                        onClick={toggleStatus}
                        disabled={updatingStatus}
                        className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {selected.status === "closed" ? "Reopen" : "Close"}
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 overflow-y-auto p-6 min-h-0">
                    {loadingThread ? (
                      <div className="flex h-full items-center justify-center">
                        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                      </div>
                    ) : messages.length === 0 ? (
                      <p className="text-center text-sm text-slate-500">
                        No messages in this conversation yet.
                      </p>
                    ) : (
                      <div className="space-y-3">
                        {messages.map((message) => {
                          const mine = message.senderRole === "ADMIN"
                          return (
                            <div
                              key={message.id}
                              className={`flex ${mine ? "justify-end" : "justify-start"}`}
                            >
                              <div
                                className={`max-w-[70%] rounded-lg p-3 ${
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
                                          className="max-h-48 max-w-[14rem] rounded-md object-cover"
                                        />
                                      </button>
                                    ))}
                                  </div>
                                ) : null}
                                {message.text ? (
                                  <p className="text-sm whitespace-pre-wrap break-words">
                                    {message.text}
                                  </p>
                                ) : null}
                                <p
                                  className={`mt-1 text-xs ${
                                    mine ? "text-teal-100" : "text-slate-500"
                                  }`}
                                >
                                  {/* Which admin replied. The thread reads as one
                                      voice to the customer, but a desk of five
                                      needs to see who said what. */}
                                  {[message.senderName, clockTime(message.createdAt)]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </p>
                              </div>
                            </div>
                          )
                        })}
                        <div ref={bottomRef} />
                      </div>
                    )}
                  </div>

                  <div className="p-4 border-t border-slate-200">
                    {selected.status === "closed" ? (
                      <p className="text-center text-sm text-slate-500">
                        This conversation is closed. Reopen it to reply.
                      </p>
                    ) : (
                      <>
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
                                  onClick={() =>
                                    setPending((prev) => prev.filter((f) => f.path !== file.path))
                                  }
                                  className="absolute -right-1.5 -top-1.5 rounded-full bg-slate-800 p-0.5 text-white"
                                >
                                  <X className="h-3 w-3" />
                                </button>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <div className="flex items-center gap-3">
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
                            aria-label="Attach an image"
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
                          placeholder="Type a message..."
                          maxLength={2000}
                          className="flex-1 px-4 py-2.5 border border-slate-300 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-teal-500 focus:border-teal-500 text-sm"
                        />
                        <button
                          type="button"
                          onClick={handleSend}
                          disabled={sending || (!draft.trim() && pending.length === 0)}
                          className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-medium rounded-lg bg-teal-700 text-white hover:bg-teal-800 disabled:opacity-50"
                        >
                          {sending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Send className="h-4 w-4" />
                          )}
                          Send
                        </button>
                        </div>
                      </>
                    )}
                  </div>
                </>
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-center">
                    <div className="w-24 h-24 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
                      <Info className="w-12 h-12 text-slate-400" />
                    </div>
                    <p className="text-sm text-slate-600">
                      Select a conversation to read and reply.
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Full size: a receipt or a damaged bag is unreadable at bubble size. */}
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
          <button
            type="button"
            aria-label="Close image"
            className="absolute right-6 top-6 rounded-full bg-white/10 p-2 text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      ) : null}
    </div>
  )
}
