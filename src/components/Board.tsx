import { useEffect, useMemo, useRef } from 'react'
import { Chessground } from 'chessground'
import type { Api } from 'chessground/api'
import type { Config } from 'chessground/config'
import type { Color, Key } from 'chessground/types'

export interface BoardMove {
  from: string
  to: string
  promotion?: 'q' | 'r' | 'b' | 'n'
}

export default function Board({
  fen,
  orientation,
  turnColor,
  viewOnly,
  lastMove,
  dests,
  onMove,
}: {
  fen: string
  orientation: Color
  turnColor: Color
  viewOnly: boolean
  lastMove?: [string, string]
  // Map of origin square → legal destination squares. Pass undefined when
  // there is no current hint; the board will refuse all moves.
  dests?: Map<string, string[]>
  onMove?: (move: BoardMove) => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const apiRef = useRef<Api | null>(null)
  const onMoveRef = useRef(onMove)
  onMoveRef.current = onMove

  // Stable ground config — only the bits chessground reads once at init.
  const initialConfig = useMemo<Config>(
    () => ({
      fen,
      orientation,
      turnColor,
      viewOnly,
      coordinates: true,
      animation: { enabled: true, duration: 150 },
      movable: {
        free: false,
        color: viewOnly ? undefined : orientation,
        dests: (dests as Map<Key, Key[]> | undefined) ?? new Map(),
        showDests: true,
        events: {
          after: (orig: Key, dest: Key) => {
            const move: BoardMove = { from: orig, to: dest }
            // Auto-promote to queen. A more thoughtful flow would prompt, but
            // for this app the moving piece type is already constrained, and
            // a chooser would be wasted UI in 99% of games.
            const rank = dest[1]
            if (
              !viewOnly &&
              (rank === '1' || rank === '8') &&
              isPawnAt(apiRef.current?.state.pieces, dest)
            ) {
              move.promotion = 'q'
            }
            onMoveRef.current?.(move)
          },
        },
      },
      lastMove: lastMove as [Key, Key] | undefined,
      highlight: { lastMove: true, check: true },
      drawable: { enabled: false },
    }),
    // We only want this on mount; subsequent prop changes flow through the
    // update effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  useEffect(() => {
    if (!containerRef.current) return
    const api = Chessground(containerRef.current, initialConfig)
    apiRef.current = api
    return () => {
      api.destroy()
      apiRef.current = null
    }
  }, [initialConfig])

  // Push prop changes into chessground.
  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    api.set({
      fen,
      orientation,
      turnColor,
      viewOnly,
      lastMove: lastMove as [Key, Key] | undefined,
      movable: {
        color: viewOnly ? undefined : orientation,
        dests: (dests as Map<Key, Key[]> | undefined) ?? new Map(),
      },
    })
  }, [fen, orientation, turnColor, viewOnly, lastMove, dests])

  return (
    <div className="aspect-square w-full max-w-[480px]">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  )
}

function isPawnAt(
  pieces: Map<Key, { role: string }> | undefined,
  square: Key,
): boolean {
  if (!pieces) return false
  const piece = pieces.get(square)
  return piece?.role === 'pawn'
}
