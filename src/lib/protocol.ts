// Wire protocol shared between Hand, Brain, and the Cloudflare Worker.
// All messages are JSON. The worker forwards role-specific messages to the
// other side and snapshots the latest hint and the latest game state so it
// can replay them to a reconnecting socket.

export type Role = 'hand' | 'brain'

export type PieceType = 'pawn' | 'knight' | 'bishop' | 'rook' | 'queen' | 'king'

export const PIECE_TYPES: PieceType[] = [
  'pawn',
  'knight',
  'bishop',
  'rook',
  'queen',
  'king',
]

export interface HelloMessage {
  type: 'hello'
  role: Role
  passphrase: string
}

export interface WelcomeMessage {
  type: 'welcome'
  role: Role
}

export interface RejectedMessage {
  type: 'rejected'
  reason: 'bad_passphrase' | 'malformed'
}

export interface PeerStatusMessage {
  type: 'peer'
  role: Role
  connected: boolean
}

// Brain → Hand (forwarded). The Brain re-sends this on every revision; the
// final revision before the window closes is the one Hand should act on.
// `locked` true means the Brain's revision window has expired.
export interface HintMessage {
  type: 'hint'
  piece: PieceType
  locked: boolean
  turnPly: number
}

// Hand → Brain (forwarded). FEN of the confirmed position after each ply.
export interface FenMessage {
  type: 'fen'
  fen: string
  lastMove?: string
  turn: 'white' | 'black'
  ply: number
  whiteClockMs: number
  blackClockMs: number
}

// Hand → Brain (forwarded). Sent once at the start of each game.
export interface GameStartMessage {
  type: 'gameStart'
  gameId: string
  ourColor: 'white' | 'black'
  opponent: string
  opponentRating?: number
  initialSeconds: number
  incrementSeconds: number
}

// Hand → Brain (forwarded). Sent once at game end.
export interface GameOverMessage {
  type: 'gameOver'
  gameId: string
  result: 'win' | 'loss' | 'draw'
  reason: string
}

// Worker → connecting client. Replays the room's current state.
export interface SnapshotMessage {
  type: 'snapshot'
  game?: GameStartMessage
  position?: FenMessage
  hint?: HintMessage
  peerConnected: boolean
}

export type ClientToServer =
  | HelloMessage
  | HintMessage
  | FenMessage
  | GameStartMessage
  | GameOverMessage

export type ServerToClient =
  | WelcomeMessage
  | RejectedMessage
  | PeerStatusMessage
  | SnapshotMessage
  | HintMessage
  | FenMessage
  | GameStartMessage
  | GameOverMessage
