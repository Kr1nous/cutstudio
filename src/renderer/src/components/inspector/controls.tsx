import { useEffect, useRef, useState, type ReactNode } from 'react'

const OPEN_KEY = 'cut-studio-insp-open'

function openState(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) || '{}') as Record<string, boolean>
  } catch {
    return {}
  }
}

/** 可折叠分组；展开状态按 id 记住。 */
export function Group({ id, title, children, defaultOpen = true, aside }: { id: string; title: string; children: ReactNode; defaultOpen?: boolean; aside?: ReactNode }) {
  const [open, setOpen] = useState(() => openState()[id] ?? defaultOpen)
  return (
    <section className={'insp-group' + (open ? ' open' : '')}>
      <header
        onClick={() => {
          const next = !open
          setOpen(next)
          try {
            localStorage.setItem(OPEN_KEY, JSON.stringify({ ...openState(), [id]: next }))
          } catch {
            /* ignore */
          }
        }}
      >
        <span className="insp-caret" />
        <span>{title}</span>
        {aside ? (
          <span className="insp-aside" onClick={(e) => e.stopPropagation()}>
            {aside}
          </span>
        ) : null}
      </header>
      {open ? <div className="insp-body">{children}</div> : null}
    </section>
  )
}

/** 一行：左标签，右控件。 */
export function Row({ label, children, keyed }: { label: string; children: ReactNode; keyed?: boolean }) {
  return (
    <div className="insp-row">
      <span className="insp-l">
        {label}
        {keyed ? <i className="kf-dot" title="有关键帧" /> : null}
      </span>
      <div className="insp-c">{children}</div>
    </div>
  )
}

/** 滑杆：拖动时只改本地显示，松手才提交一次（每次提交是一步撤销）。 */
export function Slider({
  value,
  min,
  max,
  step = 0.01,
  format,
  onCommit
}: {
  value: number
  min: number
  max: number
  step?: number
  format?: (v: number) => string
  onCommit: (v: number) => void
}) {
  const [local, setLocal] = useState<number | null>(null)
  const localRef = useRef<number | null>(null)
  localRef.current = local
  useEffect(() => {
    setLocal(null)
  }, [value])
  const shown = local ?? value
  const commit = () => {
    const v = localRef.current
    if (v == null) return
    if (v !== value) onCommit(v)
    // 服务端回来的新值会清掉本地值；没改动或失败时一会儿后也清掉
    window.setTimeout(() => setLocal((cur) => (cur === v ? null : cur)), 1500)
  }
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={shown}
        onChange={(e) => setLocal(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="insp-v">{format ? format(shown) : String(shown)}</span>
    </>
  )
}

/** 分段按钮。 */
export function Seg<T extends string>({ value, options, onChange }: { value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map(([v, label]) => (
        <button key={v} type="button" className={v === value ? 'on' : ''} onClick={() => v !== value && onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  )
}

/** 开关。 */
export function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return <button type="button" className={'toggle' + (on ? ' on' : '')} onClick={() => onChange(!on)} aria-pressed={on} />
}

/** 多行文字：失焦或 ⌘Enter 提交，Esc 放弃。 */
export function TextField({ value, onCommit, placeholder, rows = 2 }: { value: string; onCommit: (v: string) => void; placeholder?: string; rows?: number }) {
  const [draft, setDraft] = useState(value)
  const draftRef = useRef(value)
  draftRef.current = draft
  useEffect(() => setDraft(value), [value])
  const commit = () => {
    if (draftRef.current !== value) onCommit(draftRef.current)
  }
  return (
    <textarea
      className="insp-text"
      rows={rows}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          commit()
        }
        if (e.key === 'Escape') {
          draftRef.current = value
          setDraft(value)
          ;(e.target as HTMLTextAreaElement).blur()
        }
      }}
    />
  )
}

/** 颜色：停止拖动取色 0.5 秒后提交一次。 */
export function ColorField({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  const [draft, setDraft] = useState(value)
  const timer = useRef(0)
  useEffect(() => setDraft(value), [value])
  useEffect(() => () => window.clearTimeout(timer.current), [])
  return (
    <input
      type="color"
      className="insp-color"
      value={/^#[0-9a-f]{6}$/i.test(draft) ? draft : '#ffffff'}
      onChange={(e) => {
        const v = e.target.value
        setDraft(v)
        window.clearTimeout(timer.current)
        timer.current = window.setTimeout(() => v !== value && onCommit(v), 500)
      }}
    />
  )
}
