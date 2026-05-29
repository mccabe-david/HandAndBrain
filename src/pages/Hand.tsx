import { useEffect, useRef, useState } from 'react'
import { Chess } from 'chess.js'
import Board from '../components/Board'
import ResultBanner from '../components/ResultBanner'
import SetupScreen from '../components/SetupScreen'
import PieceIcon from '../components/PieceIcon'
import {
  LS_LICHESS_TOKEN,
  LS_PASSPHRASE,
  SEEK_INCREMENT_SECONDS,
  SEEK_TIME_MINUTES,
} from '../config'
import { connectCoord, type CoordClient, type CoordState } from '../lib/coord'
import {
  createSeek,
  getOngoingGame,
  makeMove,
  resign,
  streamAccountEvents,
  streamBoardGame,
  validateToken,
} from '../lib/lichess'
import type { BoardEvent, GameFullEvent } from '../lib/lichess'
import type { HintMessage, PieceType } from '../lib/protocol'

type Phase =
  | { kind: 'needs-setup' }
  | { kind: 'validating' }
  | { kind: 'idle'; account: string }
  | { kind: 'seeking'; account: string }
  | {
      kind: 'in-game'
      account: string
      gameId: string
      ourColor: 'white' | 'black'
      opponent: string
    }
  | {
      kind: 'game-over'
      account: string
      gameId: string
      result: 'win' | 'loss' | 'draw'
      reason: string
    }

const PIECE_CHAR: Record<string, PieceType> = {
  p: 'pawn',
  n: 'knight',
  b: 'bishop',
  r: 'rook',
  q: 'queen',
  k: 'king',
}

interface BoardSnapshot {
  fen: string
  turnColor: 'white' | 'black'
  lastMove?: [string, string]
  ply: number
  // Legal moves grouped by from-square, filtered to current hint piece type
  // (empty map if no hint or no legal moves for it).
  dests: Map<string, string[]>
  hasAnyLegalForHint: boolean
}

export default function Hand() {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(LS_LICHESS_TOKEN),
  )
  const [passphrase, setPassphrase] = useState<string | null>(() =>
    localStorage.getItem(LS_PASSPHRASE),
  )
  const [phase, setPhase] = useState<Phase>(() =>
    token && passphrase
      ? { kind: 'validating' }
      : { kind: 'needs-setup' },
  )
  const [setupError, setSetupError] = useState<string | null>(null)

  const [hint, setHint] = useState<HintMessage | null>(null)
  const [coordState, setCoordState] = useState<CoordState>('connecting')
  const [board, setBoard] = useState<BoardSnapshot | null>(null)
  const [clocks, setClocks] = useState<{ white: number; black: number }>({
    white: 0,
    black: 0,
  })

  const coordRef = useRef<CoordClient | null>(null)
  const gameStreamAbortRef = useRef<AbortController | null>(null)
  const accountStreamAbortRef = useRef<AbortController | null>(null)
  const seekAbortRef = useRef<AbortController | null>(null)
  const phaseRef = useRef(phase)
  phaseRef.current = phase
  const hintRef = useRef(hint)
  hintRef.current = hint

  // 1. Validate token on mount.
  useEffect(() => {
    if (phase.kind !== 'validating' || !token) return
    let cancelled = false
    void (async () => {
      try {
        const account = await validateToken(token)
        if (cancelled) return
        setPhase({ kind: 'idle', account: account.username })
      } catch {
        if (cancelled) return
        localStorage.removeItem(LS_LICHESS_TOKEN)
        setToken(null)
        setSetupError('Token rejected by Lichess. Re-enter it.')
        setPhase({ kind: 'needs-setup' })
      }
    })()
    return () => {
      cancelled = true
    }
  }, [phase.kind, token])

  // 2. Open coord client once token + passphrase are valid.
  useEffect(() => {
    if (!token || !passphrase) return
    if (phase.kind === 'needs-setup' || phase.kind === 'validating') return
    const client = connectCoord({ role: 'hand', passphrase })
    coordRef.current = client
    const offState = client.onState(setCoordState)
    const offMsg = client.onMessage((msg) => {
      if (msg.type === 'hint') {
        setHint(msg)
      } else if (msg.type === 'snapshot' && msg.hint) {
        setHint(msg.hint)
      }
    })
    return () => {
      offState()
      offMsg()
      client.destroy()
      coordRef.current = null
    }
  }, [token, passphrase, phase.kind])

  // 3. Once idle, look for an in-progress game.
  useEffect(() => {
    if (phase.kind !== 'idle' || !token) return
    let cancelled = false
    void (async () => {
      try {
        const ongoing = await getOngoingGame(token)
        if (cancelled || !ongoing) return
        setPhase({
          kind: 'in-game',
          account: phase.account,
          gameId: ongoing.gameId,
          ourColor: ongoing.color,
          opponent: ongoing.opponent.username,
        })
      } catch {
        // Stay idle; user can manually find a game.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [phase, token])

  // 4. Subscribe to account events to detect games starting from seeks.
  useEffect(() => {
    if (!token) return
    if (phase.kind === 'needs-setup' || phase.kind === 'validating') return
    const controller = new AbortController()
    accountStreamAbortRef.current = controller
    void streamAccountEvents(
      token,
      (event) => {
        if (event.type === 'gameStart') {
          // Cancel any open seek; this event resolves it.
          seekAbortRef.current?.abort()
          seekAbortRef.current = null
          const current = phaseRef.current
          const account =
            current.kind === 'in-game' ||
            current.kind === 'idle' ||
            current.kind === 'seeking' ||
            current.kind === 'game-over'
              ? current.account
              : ''
          setPhase({
            kind: 'in-game',
            account,
            gameId: event.game.gameId,
            ourColor: event.game.color,
            opponent: '',
          })
        }
      },
      controller.signal,
    ).catch(() => {
      // Reconnect logic could go here; for now the user can refresh.
    })
    return () => {
      controller.abort()
      accountStreamAbortRef.current = null
    }
  }, [token, phase.kind])

  // 5. Open board stream when a game is active.
  useEffect(() => {
    if (phase.kind !== 'in-game' || !token) return
    const controller = new AbortController()
    gameStreamAbortRef.current = controller

    const chess = new Chess()
    let initialFen = chess.fen()
    let opponentName = phase.opponent
    let opponentRating: number | undefined
    let initialSec = SEEK_TIME_MINUTES * 60
    let incSec = SEEK_INCREMENT_SECONDS

    const applyState = (
      moves: string,
      wtime: number,
      btime: number,
      status: BoardEvent extends { status: infer S } ? S : string,
      winner?: 'white' | 'black',
    ): void => {
      chess.load(initialFen)
      const moveList = moves.trim().length ? moves.trim().split(/\s+/) : []
      for (const m of moveList) {
        try {
          chess.move({
            from: m.slice(0, 2),
            to: m.slice(2, 4),
            promotion: m.length === 5 ? (m[4] as 'q' | 'r' | 'b' | 'n') : undefined,
          })
        } catch {
          // ignore malformed
        }
      }
      const fen = chess.fen()
      const turnColor = chess.turn() === 'w' ? 'white' : 'black'
      const lastMove =
        moveList.length > 0
          ? [
              moveList[moveList.length - 1].slice(0, 2),
              moveList[moveList.length - 1].slice(2, 4),
            ] as [string, string]
          : undefined

      setClocks({ white: wtime, black: btime })

      // FEN + last move snapshot — dests are recomputed below from chess + hint.
      const ourTurn = phase.kind === 'in-game' && turnColor === phase.ourColor
      const dests = ourTurn
        ? computeDests(chess, hintRef.current?.piece)
        : new Map<string, string[]>()
      const hasAnyLegal = !ourTurn || dests.size > 0

      const snap: BoardSnapshot = {
        fen,
        turnColor,
        lastMove,
        ply: moveList.length,
        dests,
        hasAnyLegalForHint: hasAnyLegal,
      }
      setBoard(snap)

      // Forward to Brain.
      coordRef.current?.send({
        type: 'fen',
        fen,
        lastMove:
          moveList.length > 0 ? moveList[moveList.length - 1] : undefined,
        turn: turnColor,
        ply: moveList.length,
        whiteClockMs: wtime,
        blackClockMs: btime,
      })

      if (status !== 'started' && status !== 'created') {
        const result = winner
          ? winner === phase.ourColor
            ? 'win'
            : 'loss'
          : 'draw'
        const reason = describeReason(status)
        coordRef.current?.send({
          type: 'gameOver',
          gameId: phase.gameId,
          result,
          reason,
        })
        setPhase({
          kind: 'game-over',
          account: phase.account,
          gameId: phase.gameId,
          result,
          reason,
        })
      }
    }

    const onEvent = (event: BoardEvent): void => {
      if (event.type === 'gameFull') {
        const full = event as GameFullEvent
        initialFen =
          !full.initialFen || full.initialFen === 'startpos'
            ? new Chess().fen()
            : full.initialFen
        const opp = phase.ourColor === 'white' ? full.black : full.white
        opponentName = opp.name
        opponentRating = opp.rating
        initialSec = (full.clock?.initial ?? initialSec * 1000) / 1000
        incSec = (full.clock?.increment ?? incSec * 1000) / 1000

        coordRef.current?.send({
          type: 'gameStart',
          gameId: phase.gameId,
          ourColor: phase.ourColor,
          opponent: opponentName,
          opponentRating,
          initialSeconds: initialSec,
          incrementSeconds: incSec,
        })

        applyState(
          full.state.moves,
          full.state.wtime,
          full.state.btime,
          full.state.status,
          full.state.winner,
        )
      } else if (event.type === 'gameState') {
        applyState(
          event.moves,
          event.wtime,
          event.btime,
          event.status,
          event.winner,
        )
      }
    }

    void streamBoardGame(token, phase.gameId, onEvent, controller.signal).catch(
      () => {
        // Stream ended or errored — UI will reflect last state.
      },
    )

    return () => {
      controller.abort()
      gameStreamAbortRef.current = null
    }
    // We intentionally do not re-subscribe on `hint` changes; the dests are
    // recomputed in a separate effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.kind, phase.kind === 'in-game' ? phase.gameId : null, token])

  // Recompute dests when the hint changes without re-opening the stream.
  useEffect(() => {
    if (phase.kind !== 'in-game') return
    setBoard((prev) => {
      if (!prev) return prev
      // Only filter if it's our turn.
      const ourTurn = prev.turnColor === phase.ourColor
      const chess = new Chess(prev.fen)
      const dests = ourTurn
        ? computeDests(chess, hint?.piece)
        : new Map<string, string[]>()
      return {
        ...prev,
        dests,
        hasAnyLegalForHint: !ourTurn || dests.size > 0 || !hint,
      }
    })
  }, [hint, phase])

  // Submit / setup handlers ------------------------------------------------

  const handleSetup = async (values: Record<string, string>) => {
    setSetupError(null)
    const t = values.token.trim()
    const p = values.passphrase.trim()
    if (!t || !p) {
      setSetupError('Both fields are required.')
      return
    }
    try {
      await validateToken(t)
    } catch {
      setSetupError('Token rejected by Lichess.')
      return
    }
    localStorage.setItem(LS_LICHESS_TOKEN, t)
    localStorage.setItem(LS_PASSPHRASE, p)
    setToken(t)
    setPassphrase(p)
    setPhase({ kind: 'validating' })
  }

  const startSeek = async () => {
    if (phase.kind !== 'idle' || !token) return
    setPhase({ kind: 'seeking', account: phase.account })
    const controller = new AbortController()
    seekAbortRef.current = controller
    try {
      await createSeek(
        token,
        { minutes: SEEK_TIME_MINUTES, increment: SEEK_INCREMENT_SECONDS },
        controller.signal,
      )
    } catch {
      // Aborted or failed — gameStart event will move us to in-game if it succeeded.
    }
    // If we got here without a gameStart, fall back to idle.
    if (phaseRef.current.kind === 'seeking') {
      setPhase({ kind: 'idle', account: phase.account })
    }
  }

  const handleResign = async () => {
    if (phase.kind !== 'in-game' || !token) return
    try {
      await resign(token, phase.gameId)
    } catch {
      // Stream will deliver the final status.
    }
  }

  const handleMove = async (from: string, to: string, promotion?: string) => {
    if (phase.kind !== 'in-game' || !token) return
    const uci = `${from}${to}${promotion ?? ''}`
    try {
      await makeMove(token, phase.gameId, uci)
    } catch {
      // Lichess will refuse; the next gameState will re-sync the position.
    }
  }

  // Render ------------------------------------------------------------------

  if (phase.kind === 'needs-setup') {
    return (
      <SetupScreen
        title="Set up Hand"
        fields={[
          {
            key: 'token',
            label: 'Lichess token (board:play scope)',
            type: 'password',
            placeholder: 'lip_xxxxxxxxxxxx',
          },
          {
            key: 'passphrase',
            label: 'Room passphrase',
            placeholder: 'shared with Brain',
          },
        ]}
        submitLabel="Save & connect"
        onSubmit={handleSetup}
        error={setupError}
      />
    )
  }
  if (phase.kind === 'validating') {
    return <p className="mt-16 text-center text-slate-600">Validating token…</p>
  }

  const renderSidebar = () => (
    <div className="space-y-3 text-sm">
      <CoordBadge state={coordState} />
      <p className="text-slate-700">
        Signed in as <span className="font-medium">{phase.kind === 'idle' || phase.kind === 'seeking' || phase.kind === 'in-game' || phase.kind === 'game-over' ? phase.account : ''}</span>
      </p>
    </div>
  )

  if (phase.kind === 'idle') {
    return (
      <div className="space-y-4">
        {renderSidebar()}
        <button
          onClick={startSeek}
          className="rounded bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800"
        >
          Find a game ({SEEK_TIME_MINUTES}+{SEEK_INCREMENT_SECONDS})
        </button>
      </div>
    )
  }

  if (phase.kind === 'seeking') {
    return (
      <div className="space-y-4">
        {renderSidebar()}
        <p className="text-slate-700">Looking for an opponent…</p>
      </div>
    )
  }

  if (phase.kind === 'in-game') {
    const ourTurn =
      board !== null && board.turnColor === phase.ourColor
    return (
      <div className="grid gap-6 md:grid-cols-[480px_1fr]">
        <div>
          {board && (
            <Board
              fen={board.fen}
              orientation={phase.ourColor}
              turnColor={board.turnColor}
              viewOnly={!ourTurn}
              lastMove={board.lastMove}
              dests={ourTurn ? board.dests : undefined}
              onMove={(m) =>
                void handleMove(m.from, m.to, m.promotion)
              }
            />
          )}
        </div>
        <div className="space-y-3">
          {renderSidebar()}
          <p className="text-sm text-slate-700">
            vs {phase.opponent || 'opponent'}
          </p>
          <Clocks
            ourColor={phase.ourColor}
            white={clocks.white}
            black={clocks.black}
          />
          <HintBadge
            hint={hint}
            ourTurn={ourTurn}
            hasAnyLegal={board?.hasAnyLegalForHint ?? true}
          />
          <button
            onClick={() => void handleResign()}
            className="rounded border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-50"
          >
            Resign
          </button>
        </div>
      </div>
    )
  }

  // game-over
  return (
    <div className="space-y-4">
      {renderSidebar()}
      <ResultBanner
        result={phase.result}
        reason={phase.reason}
        gameId={phase.gameId}
        onNext={() => setPhase({ kind: 'idle', account: phase.account })}
      />
    </div>
  )
}

function computeDests(
  chess: Chess,
  hintPiece: PieceType | undefined,
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!hintPiece) return out
  const allowed = invertPieceChar(hintPiece)
  const moves = chess.moves({ verbose: true })
  for (const m of moves) {
    if (m.piece !== allowed) continue
    const list = out.get(m.from) ?? []
    list.push(m.to)
    out.set(m.from, list)
  }
  return out
}

function invertPieceChar(piece: PieceType): string {
  for (const [char, name] of Object.entries(PIECE_CHAR)) {
    if (name === piece) return char
  }
  return ''
}

function describeReason(status: string): string {
  switch (status) {
    case 'mate':
      return 'checkmate'
    case 'resign':
      return 'resignation'
    case 'stalemate':
      return 'stalemate'
    case 'timeout':
    case 'outoftime':
      return 'time forfeit'
    case 'draw':
      return 'draw agreed'
    case 'aborted':
      return 'aborted'
    case 'variantEnd':
      return 'variant end'
    default:
      return status
  }
}

function CoordBadge({ state }: { state: CoordState }) {
  const label = {
    connecting: 'Brain link: connecting…',
    open: 'Brain link: connected',
    rejected: 'Brain link: passphrase rejected',
    closed: 'Brain link: disconnected',
  }[state]
  const color = state === 'open' ? 'text-emerald-700' : 'text-slate-500'
  return <p className={`text-xs ${color}`}>{label}</p>
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
        You {formatClock(ourMs)}
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

function HintBadge({
  hint,
  ourTurn,
  hasAnyLegal,
}: {
  hint: HintMessage | null
  ourTurn: boolean
  hasAnyLegal: boolean
}) {
  if (!ourTurn) {
    return <p className="text-sm text-slate-500">Opponent's turn</p>
  }
  if (!hint) {
    return (
      <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-800">
        Waiting for Brain to pick a piece…
      </p>
    )
  }
  if (!hasAnyLegal) {
    return (
      <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
        No legal <PieceIcon piece={hint.piece} /> move — Brain needs to pick again.
      </p>
    )
  }
  return (
    <p className="rounded bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
      Move a <PieceIcon piece={hint.piece} className="text-lg" />{' '}
      <span className="font-semibold uppercase">{hint.piece}</span>
      {hint.locked ? ' (locked)' : ' (Brain may still revise)'}
    </p>
  )
}
