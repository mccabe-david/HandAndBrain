import type { PieceType } from '../lib/protocol'

const GLYPHS: Record<PieceType, string> = {
  king: '♚',
  queen: '♛',
  rook: '♜',
  bishop: '♝',
  knight: '♞',
  pawn: '♟',
}

export default function PieceIcon({
  piece,
  className,
}: {
  piece: PieceType
  className?: string
}) {
  return (
    <span aria-label={piece} className={className}>
      {GLYPHS[piece]}
    </span>
  )
}
