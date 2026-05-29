import { Link, Route, Routes } from 'react-router-dom'
import Hand from './pages/Hand'
import Brain from './pages/Brain'

export default function App() {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <nav className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-5xl items-center gap-6 px-6 py-4">
          <span className="font-semibold">Hand & Brain</span>
          <Link to="/hand" className="text-slate-700 hover:text-slate-950">Hand</Link>
          <Link to="/brain" className="text-slate-700 hover:text-slate-950">Brain</Link>
        </div>
      </nav>
      <main className="mx-auto max-w-5xl px-6 py-8">
        <Routes>
          <Route path="/" element={<Hand />} />
          <Route path="/hand" element={<Hand />} />
          <Route path="/brain" element={<Brain />} />
        </Routes>
      </main>
    </div>
  )
}
