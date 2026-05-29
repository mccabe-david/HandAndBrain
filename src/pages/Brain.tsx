import { useEffect, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import Board from '../components/Board'
import PieceIcon from '../components/PieceIcon'
import ResultBanner from '../components/ResultBanner'
import SetupScreen from '../components/SetupScreen'
import { LS_PASSPHRASE, REVISION_WINDOW_MS } from '../config'
import { connectCoord, type CoordClient, type CoordState } from '../lib/coord'
import {
  PIECE_TYPES,
  type FenMessage,
  type GameStartMessage,
  type PieceType,
} from '../lib/protocol'

interface GameState {
  start: GameStartMessage
  position?: FenMessage
}

interface OverState {
  start: GameStartMessage
  result: 'win' | 'loss' | 'draw'
  reason: string
}

const PIECE_CHARS: Record<PieceType, string> = {
  pawn: 'p',
  knight: 'n',
  bishop: 'b',
  rook: 'r',
  queen: 'q',
  king: 'k',
}

export default function Brain() {
  const [passphrase, setPassphrase] = useState<string | null>(() =>
    localStorage.getItem(LS_PASSPHRASE),
  )
  const [setupError, setSetupError] = useState<string | null>(null)

  const [coordState, setCoordState] = useState<CoordState>('connecting')
  const [handConnected, setHandConnected] = useState(false)
  const [game, setGame] = useState<GameState | null>(null)
  const [over, setOver] = useState<OverState | null>(null)

  const [pick, setPick] = useState<PieceType | null>(null)
  const [locked, setLocked] = useState(false)

  const coordRef = useRef<CoordClient | null>(null)
  const pickRef = useRef<PieceType | null>(null)
  pickRef.current = pick
  const lockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lockedPlyRef = useRef<number | null>(null)

  useEffect(() => {
    if (!passphrase) return
    const client = connectCoord({ role: 'brain', passphrase })
    coordRef.current = client
    const offState = client.onState((s) => {
      setCoordState(s)
      if (s === 'rejected') {
        localStorage.removeItem(LS_PASSPHRASE)
        setPassphrase(null)
        setSetupError('Passphrase rejected.')
      }
    })
    const offMsg = client.onMessage((msg) => {
      if (msg.type === 'snapshot') {
        if (msg.game) setGame({ start: msg.game, position: msg.position })
        if (msg.hint) {
          setPick(msg.hint.piece)
          if (msg.hint.locked) {
            setLocked(true)
            lockedPlyRef.current = msg.hint.turnPly
          }
        }
        setHandConnected(msg.peerConnected)
      } else if (msg.type === 'peer' && msg.role === 'hand') {
        setHandConnected(msg.connected)
      } else if (msg.type === 'gameStart') {
        setGame({ start: msg })
        setOver(null)
        setPick(null)
        setLocked(false)
        lockedPlyRef.current = null
      } else if (msg.type === 'fen') {
        setGame((prev) =>
          prev ? { ...prev, position: msg } : prev,
        )
        // Clearing pick/lock on new turns is handled in the effect below.
      } else if (msg.type === 'gameOver') {
        setOver({
          start: game?.start ?? ({} as GameStartMessage),
          result: msg.result,
          reason: msg.reason,
        })
        clearLockTimer()
      }
    })
    return () => {
      offState()
      offMsg()
      client.destroy()
      coordRef.current = null
      clearLockTimer()
    }
    // We intentionally only re-establish the client when the passphrase changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [passphrase])

  // When a new turn begins on our side, reset pick + lock state and (re)start
  // the lock-in timer if a pre-commit is already set.
  useEffect(() => {
    if (!game?.position || !game.start) return
    const ourTurn = game.position.turn === game.start.ourColor
    const ply = game.position.ply

    if (!ourTurn) {
      // Opponent's turn — Brain is free to pre-commit. Cancel any leftover lock.
      clearLockTimer()
      setLocked(false)
      lockedPlyRef.current = null
      return
    }

    // Our turn. If we just transitioned to this ply, decide whether to start
    // the lock-in timer (pre-commit present) or wait for first legal pick.
    if (lockedPlyRef.current === ply) return // already handled this ply
    clearLockTimer()
    setLocked(false)

    if (pickRef.current && isPickLegal(game.position.fen, pickRef.current)) {
      startLockTimer(ply)
    }
    // If no pick yet, the timer will be started when the user makes one (below).
  }, [game?.position, game?.start])

  function clearLockTimer(): void {
    if (lockTimerRef.current) {
      clearTimeout(lockTimerRef.current)
      lockTimerRef.current = null
    }
  }

  function startLockTimer(ply: number): void {
    clearLockTimer()
    lockTimerRef.current = setTimeout(() => {
      const piece = pickRef.current
      if (!piece) return
      coordRef.current?.send({
        type: 'hint',
        piece,
        locked: true,
        turnPly: ply,
      })
      setLocked(true)
      lockedPlyRef.current = ply
      lockTimerRef.current = null
    }, REVISION_WINDOW_MS)
  }

  const handlePick = (piece: PieceType): void => {
    if (locked) return
    if (!game?.position) {
      // No position yet (game just started, awaiting first FEN). Buffer pick.
      setPick(piece)
      return
    }
    const ourTurn = game.position.turn === game.start.ourColor
    const ply = game.position.ply
    if (ourTurn && !isPickLegal(game.position.fen, piece)) {
      // Don't send impossible picks during our turn — they can't lock and
      // would just confuse Hand. UI greys these out anyway.
      return
    }
    setPick(piece)
    coordRef.current?.send({
      type: 'hint',
      piece,
      locked: false,
      turnPly: ply,
    })
    if (ourTurn && lockTimerRef.current === null && !locked) {
      startLockTimer(ply)
    }
  }

  // Render -----------------------------------------------------------------

  if (!passphrase) {
    return (
      <SetupScreen
        title="Set up Brain"
        fields={[
          { key: 'passphrase', label: 'Room passphrase' },
        ]}
        submitLabel="Connect"
        onSubmit={(v) => {
          const p = v.passphrase.trim()
          if (!p) {
            setSetupError('Required.')
            return
          }
          localStorage.setItem(LS_PASSPHRASE, p)
          setPassphrase(p)
        }}
        error={setupError}
      />
    )
  }

  if (over) {
    return (
      <div className="space-y-4">
        <CoordBadge state={coordState} handConnected={handConnected} />
        <ResultBanner
          result={over.result}
          reason={over.reason}
          gameId={over.start.gameId}
        />
        <p className="text-sm text-slate-600">Waiting for Hand to find another game…</p>
      </div>
    )
  }

  if (!game?.start || !game.position) {
    return (
      <div className="space-y-4">
        <CoordBadge state={coordState} handConnected={handConnected} />
        <p className="text-slate-700">
          {handConnected
            ? 'Hand connected — waiting for game to start.'
            : 'Waiting for Hand to connect.'}
        </p>
      </div>
    )
  }

  const fen = game.position.fen
  const ourTurn = game.position.turn === game.start.ourColor
  const legalTypes = legalPieceTypesForActiveSide(fen)
  return (
    <div className="grid gap-6 md:grid-cols-[480px_1fr]">
      <div>
        <Board
          fen={fen}
          orientation={game.start.ourColor}
          turnColor={game.position.turn}
          viewOnly
          lastMove={
            game.position.lastMove
              ? [
                  game.position.lastMove.slice(0, 2),
                  game.position.lastMove.slice(2, 4),
                ]
              : undefined
          }
        />
      </div>
      <div className="space-y-4">
        <CoordBadge state={coordState} handConnected={handConnected} />
        <p className="text-sm text-slate-700">vs {game.start.opponent || 'opponent'}</p>
        <Clocks
          ourColor={game.start.ourColor}
          white={game.position.whiteClockMs}
          black={game.position.blackClockMs}
        />
        <p className="text-sm text-slate-700">
          {ourTurn
            ? locked
              ? 'Locked — Hand is playing.'
              : 'Your turn — pick a piece.'
            : 'Opponent’s turn — you may pre-commit.'}
        </p>
        <PiecePicker
          pick={pick}
          locked={locked}
          legalTypes={ourTurn ? legalTypes : new Set(PIECE_TYPES)}
          onPick={handlePick}
        />
      </div>
    </div>
  )
}

function isPickLegal(fen: string, piece: PieceType): boolean {
  return legalPieceTypesForActiveSide(fen).has(piece)
}

function legalPieceTypesForActiveSide(fen: string): Set<PieceType> {
  const chess = new Chess(fen)
  const out = new Set<PieceType>()
  for (const m of chess.moves({ verbose: true })) {
    for (const [piece, char] of Object.entries(PIECE_CHARS) as [
      PieceType,
      string,
    ][]) {
      if (m.piece === char) out.add(piece)
    }
  }
  return out
}

function PiecePicker({
  pick,
  locked,
  legalTypes,
  onPick,
}: {
  pick: PieceType | null
  locked: boolean
  legalTypes: Set<PieceType>
  onPick: (p: PieceType) => void
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {PIECE_TYPES.map((p) => {
        const disabled = locked || !legalTypes.has(p)
        const selected = pick === p
        return (
          <button
            key={p}
            disabled={disabled}
            onClick={() => onPick(p)}
            className={[
              'flex flex-col items-center rounded border px-3 py-3',
              selected
                ? 'border-emerald-500 bg-emerald-50'
                : 'border-slate-300 bg-white',
              disabled ? 'opacity-40' : 'hover:bg-slate-50',
            ].join(' ')}
          >
            <PieceIcon piece={p} className="text-3xl" />
            <span className="text-xs uppercase">{p}</span>
          </button>
        )
      })}
    </div>
  )
}

function CoordBadge({
  state,
  handConnected,
}: {
  state: CoordState
  handConnected: boolean
}) {
  if (state !== 'open') {
    return (
      <p className="text-xs text-slate-500">
        {state === 'connecting'
          ? 'Connecting…'
          : state === 'rejected'
          ? 'Passphrase rejected.'
          : 'Disconnected.'}
      </p>
    )
  }
  return (
    <p className={`text-xs ${handConnected ? 'text-emerald-700' : 'text-amber-700'}`}>
      Hand {handConnected ? 'connected' : 'disconnected'}
    </p>
  )
}

function Clocks({
  ourColor,
  white,
  black,
}: {
  ourColor: 'white' | 'black'
  white: number
  black: number
}) {
  const ourMs = ourColor === 'white' ? white : black
  const theirMs = ourColor === 'white' ? black : white
  return (
    <div className="flex gap-3 text-sm">
      <span className="rounded bg-slate-100 px-2 py-1">
        Hand {formatClock(ourMs)}
      </span>
      <span className="rounded bg-slate-100 px-2 py-1">
        Opp {formatClock(theirMs)}
      </span>
    </div>
  )
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}
