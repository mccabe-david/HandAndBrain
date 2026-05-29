import { LICHESS_API } from '../config'

export interface LichessAccount {
  id: string
  username: string
}

export interface OngoingGame {
  gameId: string
  fullId: string
  fen: string
  color: 'white' | 'black'
  lastMove?: string
  isMyTurn: boolean
  opponent: { username: string; rating?: number }
  secondsLeft?: number
  hasMoved: boolean
  perf?: string
  rated?: boolean
  speed?: string
  variant?: { key: string }
}

interface GameStateEvent {
  type: 'gameState'
  moves: string
  wtime: number
  btime: number
  winc: number
  binc: number
  status:
    | 'created'
    | 'started'
    | 'aborted'
    | 'mate'
    | 'resign'
    | 'stalemate'
    | 'timeout'
    | 'draw'
    | 'outoftime'
    | 'cheat'
    | 'noStart'
    | 'unknownFinish'
    | 'variantEnd'
  winner?: 'white' | 'black'
}

export interface GameFullEvent {
  type: 'gameFull'
  id: string
  initialFen: string
  white: { id?: string; name: string; rating?: number }
  black: { id?: string; name: string; rating?: number }
  clock?: { initial: number; increment: number }
  state: GameStateEvent
}

export type BoardEvent =
  | GameFullEvent
  | GameStateEvent
  | { type: 'chatLine'; username: string; text: string; room: 'player' | 'spectator' }
  | { type: 'opponentGone'; gone: boolean }

export type AccountEvent =
  | { type: 'gameStart'; game: { gameId: string; fullId: string; color: 'white' | 'black' } }
  | { type: 'gameFinish'; game: { gameId: string } }
  | { type: 'challenge'; challenge: { id: string } }
  | { type: 'challengeCanceled'; challenge: { id: string } }
  | { type: 'challengeDeclined'; challenge: { id: string } }

class HttpError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message)
  }
}

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}` }
}

export async function validateToken(token: string): Promise<LichessAccount> {
  const res = await fetch(`${LICHESS_API}/api/account`, {
    headers: authHeaders(token),
  })
  if (res.status === 401) {
    throw new HttpError(401, 'Token rejected by Lichess')
  }
  if (!res.ok) {
    throw new HttpError(res.status, `Lichess responded ${res.status}`)
  }
  const json = (await res.json()) as { id: string; username: string }
  return { id: json.id, username: json.username }
}

export async function getOngoingGame(token: string): Promise<OngoingGame | null> {
  const res = await fetch(`${LICHESS_API}/api/account/playing`, {
    headers: authHeaders(token),
  })
  if (!res.ok) {
    throw new HttpError(res.status, `Lichess responded ${res.status}`)
  }
  const json = (await res.json()) as { nowPlaying: OngoingGame[] }
  return json.nowPlaying[0] ?? null
}

export async function makeMove(
  token: string,
  gameId: string,
  uci: string,
): Promise<void> {
  const res = await fetch(
    `${LICHESS_API}/api/board/game/${gameId}/move/${uci}`,
    {
      method: 'POST',
      headers: authHeaders(token),
    },
  )
  if (!res.ok) {
    const text = await res.text()
    throw new HttpError(res.status, `Move rejected: ${text}`)
  }
}

export async function resign(token: string, gameId: string): Promise<void> {
  const res = await fetch(`${LICHESS_API}/api/board/game/${gameId}/resign`, {
    method: 'POST',
    headers: authHeaders(token),
  })
  if (!res.ok) {
    throw new HttpError(res.status, `Resign failed (${res.status})`)
  }
}

// Posts an open seek. The request only resolves when a match is found (or the
// signal is aborted). The actual game appears via the account event stream.
export async function createSeek(
  token: string,
  opts: { minutes: number; increment: number; rated?: boolean },
  signal: AbortSignal,
): Promise<void> {
  const body = new URLSearchParams({
    time: String(opts.minutes),
    increment: String(opts.increment),
    rated: String(opts.rated ?? false),
    variant: 'standard',
    color: 'random',
  })
  const res = await fetch(`${LICHESS_API}/api/board/seek`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal,
  })
  if (!res.ok && res.status !== 0) {
    throw new HttpError(res.status, `Seek failed (${res.status})`)
  }
  // Drain the response so the connection lifetime matches the seek.
  if (res.body) {
    const reader = res.body.getReader()
    try {
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
    } catch {
      // Aborted — that's fine.
    }
  }
}

export async function streamAccountEvents(
  token: string,
  onEvent: (e: AccountEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  await streamNdjson(
    `${LICHESS_API}/api/stream/event`,
    token,
    (line) => onEvent(line as AccountEvent),
    signal,
  )
}

export async function streamBoardGame(
  token: string,
  gameId: string,
  onEvent: (e: BoardEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  await streamNdjson(
    `${LICHESS_API}/api/board/game/stream/${gameId}`,
    token,
    (line) => onEvent(line as BoardEvent),
    signal,
  )
}

async function streamNdjson(
  url: string,
  token: string,
  onLine: (line: unknown) => void,
  signal: AbortSignal,
): Promise<void> {
  const res = await fetch(url, { headers: authHeaders(token), signal })
  if (!res.ok || !res.body) {
    throw new HttpError(res.status, `Stream open failed (${res.status})`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const raw of lines) {
      const line = raw.trim()
      if (!line) continue
      try {
        onLine(JSON.parse(line))
      } catch {
        // Lichess occasionally sends keepalive blanks; ignore parse failures.
      }
    }
  }
}
