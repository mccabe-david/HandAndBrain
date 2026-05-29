import { WORKER_WS_URL } from '../config'
import type {
  ClientToServer,
  Role,
  ServerToClient,
} from './protocol'

export type CoordState = 'connecting' | 'open' | 'rejected' | 'closed'

type Listener = (msg: ServerToClient) => void
type StateListener = (state: CoordState) => void

export interface CoordClient {
  send(msg: ClientToServer): void
  onMessage(listener: Listener): () => void
  onState(listener: StateListener): () => void
  getState(): CoordState
  destroy(): void
}

export function connectCoord({
  role,
  passphrase,
}: {
  role: Role
  passphrase: string
}): CoordClient {
  const messageListeners = new Set<Listener>()
  const stateListeners = new Set<StateListener>()

  let ws: WebSocket | null = null
  let state: CoordState = 'connecting'
  let destroyed = false
  let backoffMs = 500
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null
  // Buffer outgoing messages while a fresh socket is opening.
  let outbox: ClientToServer[] = []

  const setState = (next: CoordState): void => {
    if (state === next) return
    state = next
    for (const l of stateListeners) l(state)
  }

  const open = (): void => {
    if (destroyed) return
    setState('connecting')
    const socket = new WebSocket(`${WORKER_WS_URL}/ws`)
    ws = socket

    socket.addEventListener('open', () => {
      const hello: ClientToServer = { type: 'hello', role, passphrase }
      socket.send(JSON.stringify(hello))
      for (const msg of outbox) socket.send(JSON.stringify(msg))
      outbox = []
      backoffMs = 500
      setState('open')
    })

    socket.addEventListener('message', (event) => {
      let msg: ServerToClient
      try {
        msg = JSON.parse(event.data as string) as ServerToClient
      } catch {
        return
      }
      if (msg.type === 'rejected') {
        setState('rejected')
        // Don't auto-reconnect on credential rejection; let the UI clear state.
        destroyed = true
        try {
          socket.close()
        } catch {
          // ignore
        }
        return
      }
      for (const l of messageListeners) l(msg)
    })

    const onClose = (): void => {
      if (ws !== socket) return
      ws = null
      if (destroyed) {
        setState('closed')
        return
      }
      setState('closed')
      reconnectTimer = setTimeout(open, backoffMs)
      backoffMs = Math.min(backoffMs * 2, 10_000)
    }
    socket.addEventListener('close', onClose)
    socket.addEventListener('error', onClose)
  }

  open()

  return {
    send(msg) {
      if (ws && ws.readyState === WebSocket.OPEN && state === 'open') {
        ws.send(JSON.stringify(msg))
      } else {
        outbox.push(msg)
      }
    },
    onMessage(listener) {
      messageListeners.add(listener)
      return () => {
        messageListeners.delete(listener)
      }
    },
    onState(listener) {
      stateListeners.add(listener)
      listener(state)
      return () => {
        stateListeners.delete(listener)
      }
    },
    getState() {
      return state
    },
    destroy() {
      destroyed = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      if (ws) {
        try {
          ws.close()
        } catch {
          // ignore
        }
        ws = null
      }
      setState('closed')
    },
  }
}
