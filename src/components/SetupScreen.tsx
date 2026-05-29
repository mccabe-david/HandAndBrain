import { useState, type FormEvent } from 'react'

export interface SetupField {
  key: string
  label: string
  type?: 'text' | 'password'
  placeholder?: string
}

export default function SetupScreen({
  title,
  fields,
  submitLabel,
  onSubmit,
  error,
}: {
  title: string
  fields: SetupField[]
  submitLabel: string
  onSubmit: (values: Record<string, string>) => void | Promise<void>
  error?: string | null
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((f) => [f.key, ''])),
  )
  const [busy, setBusy] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await onSubmit(values)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mx-auto mt-16 max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
      <h1 className="mb-4 text-xl font-semibold">{title}</h1>
      <form onSubmit={submit} className="space-y-4">
        {fields.map((field) => (
          <label key={field.key} className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              {field.label}
            </span>
            <input
              type={field.type ?? 'text'}
              placeholder={field.placeholder}
              value={values[field.key]}
              onChange={(e) =>
                setValues({ ...values, [field.key]: e.target.value })
              }
              className="w-full rounded border border-slate-300 px-3 py-2 focus:border-slate-500 focus:outline-none"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        ))}
        {error && (
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-700">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded bg-slate-900 px-4 py-2 font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? 'Working…' : submitLabel}
        </button>
      </form>
    </div>
  )
}
