import type { ReactNode } from 'react'
import { cx } from '../lib/view'

export function Card({ title, icon, children, className }: {
  title?: ReactNode
  icon?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cx('rounded-xl border border-space-700 bg-space-850/80 p-4 backdrop-blur', className)}>
      {title && (
        <h3 className="mb-3 flex items-center gap-2 text-[13px] font-semibold text-slate-100">
          {icon && <span className="text-sun-400">{icon}</span>}
          {title}
        </h3>
      )}
      {children}
    </section>
  )
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 text-[11px] font-semibold tracking-[0.14em] text-slate-500 uppercase">{children}</h2>
}

export function Kpi({ value, label, tone = 'sun' }: { value: ReactNode; label: string; tone?: 'sun' | 'ice' | 'slate' }) {
  const color = { sun: 'text-sun-400', ice: 'text-ice-400', slate: 'text-slate-200' }[tone]
  return (
    <div className="rounded-lg border border-space-700 bg-space-950/60 px-2 py-2.5 text-center">
      <div className={cx('tabular text-lg leading-tight font-bold', color)}>{value}</div>
      <div className="mt-1 text-[11px] leading-tight text-slate-500">{label}</div>
    </div>
  )
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="inline-flex rounded-lg border border-space-700 bg-space-900 p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cx(
            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition',
            value === o.value ? 'bg-space-700 text-sun-300 shadow' : 'text-slate-400 hover:text-slate-200',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function InfernoLegend({ left, middle, right }: { left: string; middle: string; right: string }) {
  return (
    <div>
      <div className="bg-inferno h-2.5 rounded-full" />
      <div className="mt-1 flex justify-between text-[11px] text-slate-500">
        <span>{left}</span>
        <span>{middle}</span>
        <span>{right}</span>
      </div>
    </div>
  )
}

export function KeyValue({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-slate-500">{k}</dt>
          <dd className="tabular text-right text-slate-200">{v}</dd>
        </div>
      ))}
    </dl>
  )
}
