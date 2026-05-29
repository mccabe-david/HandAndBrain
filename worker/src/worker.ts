import type {
  ClientToServer,
  FenMessage,
  GameOverMessage,
  GameStartMessage,
  HintMessage,
  Role,
  ServerToClient,
} from '../../src/lib/protocol'

interface Env {
  ROOM: DurableObjectNamespace
  ROOM_PASSPHRASE: string
}

const STATE_TTL_MS = 5 * 60 * 1000

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname !== '/ws') {
      return new Response('Hand and Brain coordination worker', { status: 200 })
    }
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected websocket', { status: 426 })
    }
    // Single hardcoded room.
    const id = env.ROOM.idFromName('manoybrain')
    const stub = env.ROOM.get(id)
    return stub.fetch(request)
  },
}

interface Snapshot {
  game?: GameStartMessage
  position?: FenMessage
  hint?: HintMessage
}

export class Room {
  private sockets = new Map<Role, WebSocket>()
  private snapshot: Snapshot = {}
  private cleanupAlarmSetAt: number | null = null

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair()
    const client = pair[0]
    const server = pair[1]
    server.accept()
    this.attach(server)
    return new Response(null, { status: 101, webSocket: client })
  }

  private attach(ws: WebSocket): void {
    let role: Role | null = null

    const send = (msg: ServerToClient): void => {
      try {
        ws.send(JSON.stringify(msg))
      } catch {
        // Socket closed mid-send; cleanup handles it.
      }
    }

    ws.addEventListener('message', (event) => {
      let msg: ClientToServer
      try {
        msg = JSON.parse(event.data as string) as ClientToServer
      } catch {
        send({ type: 'rejected', reason: 'malformed' })
        ws.close(1003, 'malformed')
        return
      }

      if (role === null) {
        if (msg.type !== 'hello') {
          send({ type: 'rejected', reason: 'malformed' })
          ws.close(1003, 'expected hello')
          return
        }
        if (msg.passphrase !== this.env.ROOM_PASSPHRASE) {
          send({ type: 'rejected', reason: 'bad_passphrase' })
          ws.close(1008, 'bad passphrase')
          return
        }
        if (msg.role !== 'hand' && msg.role !== 'brain') {
          send({ type: 'rejected', reason: 'malformed' })
          ws.close(1003, 'bad role')
          return
        }
        role = msg.role

        // Last-writer-wins: evict any existing socket for this role.
        const existing = this.sockets.get(role)
        if (existing && existing !== ws) {
          try {
            existing.close(4000, 'replaced')
          } catch {
            // ignore
          }
        }
        this.sockets.set(role, ws)
        this.cancelCleanup()

        send({ type: 'welcome', role })
        const peerRole: Role = role === 'hand' ? 'brain' : 'hand'
        send({
          type: 'snapshot',
          game: this.snapshot.game,
          position: this.snapshot.position,
          hint: this.snapshot.hint,
          peerConnected: this.sockets.has(peerRole),
        })
        // Notify the peer that we connected.
        this.sendTo(peerRole, { type: 'peer', role, connected: true })
        return
      }

      this.handleAuthenticated(role, msg)
    })

    const onClose = (): void => {
      if (role !== null && this.sockets.get(role) === ws) {
        this.sockets.delete(role)
        const peerRole: Role = role === 'hand' ? 'brain' : 'hand'
        this.sendTo(peerRole, { type: 'peer', role, connected: false })
        // Hand leaving means no new positions will arrive; current hint is
        // stale relative to whatever Hand did next. We still keep the snapshot
        // for the reconnect window so a quick refresh resumes cleanly.
      }
      if (this.sockets.size === 0) {
        this.scheduleCleanup()
      }
    }
    ws.addEventListener('close', onClose)
    ws.addEventListener('error', onClose)
  }

  private handleAuthenticated(role: Role, msg: ClientToServer): void {
    if (msg.type === 'hello') {
      // Ignore second hello.
      return
    }

    // Authorisation by role: Brain sends hints; Hand sends game state.
    if (msg.type === 'hint') {
      if (role !== 'brain') return
      this.snapshot.hint = msg
      this.sendTo('hand', msg)
      return
    }
    if (msg.type === 'fen') {
      if (role !== 'hand') return
      this.snapshot.position = msg
      // A new ply invalidates the previous turn's hint.
      if (this.snapshot.hint && this.snapshot.hint.turnPly !== msg.ply) {
        this.snapshot.hint = undefined
      }
      this.sendTo('brain', msg)
      return
    }
    if (msg.type === 'gameStart') {
      if (role !== 'hand') return
      this.snapshot = { game: msg }
      this.sendTo('brain', msg)
      return
    }
    if (msg.type === 'gameOver') {
      if (role !== 'hand') return
      this.snapshot.hint = undefined
      this.sendTo('brain', msg)
      return
    }
  }

  private sendTo(role: Role, msg: ServerToClient): void {
    const ws = this.sockets.get(role)
    if (!ws) return
    try {
      ws.send(JSON.stringify(msg))
    } catch {
      // ignore
    }
  }

  private scheduleCleanup(): void {
    const at = Date.now() + STATE_TTL_MS
    this.cleanupAlarmSetAt = at
    void this.state.storage.setAlarm(at)
  }

  private cancelCleanup(): void {
    this.cleanupAlarmSetAt = null
    void this.state.storage.deleteAlarm()
  }

  async alarm(): Promise<void> {
    if (this.cleanupAlarmSetAt !== null && this.sockets.size === 0) {
      this.snapshot = {}
    }
    this.cleanupAlarmSetAt = null
  }
}
