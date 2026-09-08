import { useEffect, useRef } from "react"
import { io } from "socket.io-client"

import { API_BASE_URL } from "@food/api/config"

/**
 * Live chat events for whoever is signed in.
 *
 * The server already broadcasts `chat:message` and `chat:conversation_update`
 * into the room for each party -- the admin room, or one keyed to a user or
 * rider id -- so a client only has to connect and listen. Nothing subscribes to
 * a thread: the room is the subscription, which is why the admin sees every
 * conversation without asking for any of them.
 *
 * Handlers are held in a ref and read at event time. Passed to `on()` directly
 * they would tear the socket down and reconnect on every render of the screen,
 * which loses messages in the gap.
 */
export function useChatSocket({ token, onMessage, onConversationUpdate, enabled = true }) {
    const handlers = useRef({ onMessage, onConversationUpdate })
    handlers.current = { onMessage, onConversationUpdate }

    const socketRef = useRef(null)

    useEffect(() => {
        if (!enabled || !token || !API_BASE_URL) return undefined

        // Socket.IO lives on the origin; the API base carries an /api/v1 path.
        let origin = API_BASE_URL
        try {
            const relativeTo = String(origin).startsWith("http")
                ? undefined
                : typeof window !== "undefined"
                  ? window.location.origin
                  : undefined
            origin = new URL(origin, relativeTo).origin
        } catch {
            origin = String(origin).replace(/\/api\/v\d+\/?$/, "")
        }

        const socket = io(origin, {
            path: "/socket.io/",
            transports: ["polling", "websocket"],
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 1000,
            reconnectionDelayMax: 5000,
            auth: { token },
            query: { token },
        })
        socketRef.current = socket

        socket.on("chat:message", (payload) => handlers.current.onMessage?.(payload))
        socket.on("chat:conversation_update", (payload) =>
            handlers.current.onConversationUpdate?.(payload),
        )

        return () => {
            socket.off("chat:message")
            socket.off("chat:conversation_update")
            socket.disconnect()
            socketRef.current = null
        }
    }, [enabled, token])

    return socketRef
}
