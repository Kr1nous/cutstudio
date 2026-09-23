import { useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MenuItem =
  | { label: string; onClick: () => void; danger?: boolean; disabled?: boolean; hint?: string }
  | 'sep'

/** 右键菜单：点外面、按 Esc 关闭；贴近窗口边缘时往回挪。 */
export function ContextMenu({ x, y, items, onClose }: { x: number; y: number; items: MenuItem[]; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      x: Math.max(4, Math.min(x, window.innerWidth - r.width - 4)),
      y: Math.max(4, Math.min(y, window.innerHeight - r.height - 4))
    })
  }, [x, y])

  useEffect(() => {
    const onClose = () => closeRef.current()
    const close = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return
      onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    const timer = window.setTimeout(() => {
      window.addEventListener('mousedown', close)
      window.addEventListener('contextmenu', close)
      window.addEventListener('keydown', key)
      window.addEventListener('blur', onClose)
    }, 0)
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousedown', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', key)
      window.removeEventListener('blur', onClose)
    }
  }, [])

  return (
    <div ref={ref} className="ctx-menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map((item, i) =>
        item === 'sep' ? (
          <div key={i} className="ctx-sep" />
        ) : (
          <button
            key={i}
            type="button"
            className={item.danger ? 'danger' : undefined}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onClick()
            }}
          >
            <span>{item.label}</span>
            {item.hint ? <kbd>{item.hint}</kbd> : null}
          </button>
        )
      )}
    </div>
  )
}

/** 管理一个右键菜单的打开状态。 */
export function useContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null)
  const open = (e: { clientX: number; clientY: number; preventDefault: () => void; stopPropagation: () => void }, items: MenuItem[]) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, items })
  }
  const node = menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null
  return { open, node }
}
