export default function ResultBanner({
  result,
  reason,
  gameId,
  onNext,
}: {
  result: 'win' | 'loss' | 'draw'
  reason: string
  gameId: string
  onNext?: () => void
}) {
  const headline =
    result === 'win' ? 'You won' : result === 'loss' ? 'You lost' : 'Drawn'
  return (
    <div className="rounded border border-slate-200 bg-white p-4 text-center shadow-sm">
      <p className="text-lg font-semibold">{headline}</p>
      <p className="mt-1 text-sm text-slate-600">{reason}</p>
      <div className="mt-3 flex justify-center gap-3 text-sm">
        <a
          href={`https://lichess.org/${gameId}`}
          target="_blank"
          rel="noreferrer"
          className="text-blue-700 underline hover:text-blue-900"
        >
          Open in Lichess analysis
        </a>
        {onNext && (
          <button
            onClick={onNext}
            className="rounded bg-slate-900 px-3 py-1 text-white hover:bg-slate-800"
          >
            Find another game
          </button>
        )}
      </div>
    </div>
  )
}
