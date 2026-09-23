import { useEffect, useMemo, useRef, useState } from 'react'
import { COMMANDS, matchCommand, resolveCommand, type Command, type CommandCtx } from '../lib/commands'

const MRU_KEY = 'cut-studio-cmd-mru'

function loadMru(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(MRU_KEY) || '[]')
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

function saveMru(id: string): void {
  try {
    localStorage.setItem(MRU_KEY, JSON.stringify([id, ...loadMru().filter((x) => x !== id)].slice(0, 8)))
  } catch {
    /* ignore */
  }
}

/** ⌘K 命令面板：搜索全部剪辑工具；需要输入的命令在面板里接着填。 */
export function CommandPalette({
  ctx,
  onRun,
  onApp,
  onClose
}: {
  ctx: CommandCtx
  onRun: (tool: string, args: Record<string, unknown>) => void
  onApp: (action: string) => void
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const [active, setActive] = useState(0)
  const [asking, setAsking] = useState<{ cmd: Command; args: Record<string, unknown> } | null>(null)
  const [answer, setAnswer] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const list = useMemo(() => {
    const mru = loadMru()
    const scored = COMMANDS.map((cmd) => ({ cmd, score: matchCommand(cmd, q), res: resolveCommand(cmd, ctx) })).filter((x) => x.score > 0)
    if (!q.trim()) {
      const recent = mru.map((id) => scored.find((x) => x.cmd.id === id)).filter((x): x is (typeof scored)[number] => Boolean(x))
      const rest = scored.filter((x) => !mru.includes(x.cmd.id))
      return [...recent.map((x) => ({ ...x, recent: true })), ...rest.map((x) => ({ ...x, recent: false }))]
    }
    return scored
      .sort((a, b) => b.score - a.score || Number(b.res.ok) - Number(a.res.ok))
      .map((x) => ({ ...x, recent: false }))
  }, [q, ctx])

  useEffect(() => {
    setActive(0)
  }, [q])

  useEffect(() => {
    inputRef.current?.focus()
  }, [asking])

  useEffect(() => {
    listRef.current?.querySelector('.pal-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  function run(item: (typeof list)[number]) {
    if (!item.res.ok) return
    const { cmd } = item
    saveMru(cmd.id)
    if (cmd.app) {
      onClose()
      onApp(cmd.app)
      return
    }
    if (cmd.ask) {
      setAsking({ cmd, args: item.res.args })
      setAnswer(cmd.ask.default ?? '')
      return
    }
    onClose()
    onRun(cmd.tool!, item.res.args)
  }

  function submitAnswer() {
    if (!asking) return
    const { cmd, args } = asking
    const ask = cmd.ask!
    const raw = answer.trim()
    if (!raw) return
    let value: unknown = raw
    if (ask.number) {
      const n = Number(raw)
      if (!Number.isFinite(n)) return
      value = n * (ask.scale ?? 1)
    }
    onClose()
    onRun(cmd.tool!, { ...args, [ask.key]: value })
  }

  return (
    <div className="palette-back" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        {asking ? (
          <>
            <div className="pal-asking">{asking.cmd.label.replace(/…$/, '')}</div>
            <input
              ref={inputRef}
              className="pal-input"
              value={answer}
              placeholder={asking.cmd.ask!.label}
              onChange={(e) => setAnswer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitAnswer()
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setAsking(null)
                }
              }}
            />
            <div className="pal-foot">
              {asking.cmd.ask!.label} · Enter 确定 · Esc 返回
            </div>
          </>
        ) : (
          <>
            <input
              ref={inputRef}
              className="pal-input"
              value={q}
              placeholder="搜索命令：去静音、字幕、转场、导出…"
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setActive((i) => Math.min(list.length - 1, i + 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActive((i) => Math.max(0, i - 1))
                } else if (e.key === 'Enter') {
                  const item = list[active]
                  if (item) run(item)
                } else if (e.key === 'Escape') {
                  onClose()
                }
              }}
            />
            <div className="pal-list" ref={listRef}>
              {list.length === 0 ? <div className="pal-empty">没有匹配的命令</div> : null}
              {list.map((item, i) => {
                const prev = list[i - 1]
                const head = item.recent ? '最近使用' : item.cmd.group
                const prevHead = prev ? (prev.recent ? '最近使用' : prev.cmd.group) : null
                return (
                  <div key={item.cmd.id + (item.recent ? ':r' : '')}>
                    {!q.trim() && head !== prevHead ? <div className="pal-group">{head}</div> : null}
                    <button
                      type="button"
                      className={'pal-item' + (i === active ? ' active' : '') + (item.res.ok ? '' : ' disabled')}
                      onMouseMove={() => setActive(i)}
                      onClick={() => run(item)}
                    >
                      <span className="pal-label">{item.cmd.label}</span>
                      {q.trim() ? <span className="pal-tag">{item.cmd.group}</span> : null}
                      <span className="pal-meta">
                        {!item.res.ok ? item.res.reason : item.res.note ?? ''}
                        {item.cmd.hint ? <kbd>{item.cmd.hint}</kbd> : null}
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
            <div className="pal-foot">↑↓ 选择 · Enter 执行 · Esc 关闭 · 选中片段后命令只作用于它</div>
          </>
        )}
      </div>
    </div>
  )
}
