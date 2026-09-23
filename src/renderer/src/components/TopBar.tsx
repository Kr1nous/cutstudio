import { useState } from 'react'
import type { ExportProgress, RecentProject } from '@shared/types'
import { Icon } from './Icon'
import { useContextMenu } from './ContextMenu'

/** 顶栏：项目名（带项目菜单）、命令搜索、撤销重做、导入导出、终端和设置。整条可拖动窗口。 */
export function TopBar({
  name,
  projectPath,
  canUndo,
  canRedo,
  undoLabel,
  redoLabel,
  terminalOpen,
  exporting,
  onRename,
  onPalette,
  onUndo,
  onRedo,
  onImport,
  onExport,
  onTerminal,
  onSettings,
  onNew,
  onOpen,
  onOpenPath,
  onClose,
  loadRecent
}: {
  name: string
  projectPath: string | null
  canUndo: boolean
  canRedo: boolean
  undoLabel?: string
  redoLabel?: string
  terminalOpen: boolean
  exporting: ExportProgress | null
  onRename: (name: string) => void
  onPalette: () => void
  onUndo: () => void
  onRedo: () => void
  onImport: () => void
  onExport: () => void
  onTerminal: () => void
  onSettings: () => void
  onNew: () => void
  onOpen: () => void
  onOpenPath: (path: string) => void
  onClose: () => void
  loadRecent: () => Promise<(RecentProject & { exists: boolean })[]>
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const menu = useContextMenu()

  async function openMenu(e: React.MouseEvent) {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const recent = (await loadRecent().catch(() => [])).filter((x) => x.exists && x.path !== projectPath).slice(0, 6)
    menu.open({ clientX: r.left, clientY: r.bottom + 4, preventDefault: () => {}, stopPropagation: () => {} }, [
      { label: '新建项目…', onClick: onNew, hint: '⌘N' },
      { label: '打开项目…', onClick: onOpen, hint: '⌘O' },
      ...(recent.length ? (['sep'] as const) : []),
      ...recent.map((p) => ({ label: p.name, onClick: () => onOpenPath(p.path) })),
      'sep',
      { label: '关闭项目', onClick: onClose }
    ])
  }

  return (
    <header className="topbar" data-tauri-drag-region>
      <div className="tb-left" data-tauri-drag-region>
        <input
          className="project-name"
          value={draft ?? name}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft != null && draft.trim() && draft !== name) onRename(draft.trim())
            setDraft(null)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setDraft(null)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          spellCheck={false}
        />
        <button type="button" className="icon-btn" title="项目" onClick={(e) => void openMenu(e)}>
          <Icon name="chevron" size={14} />
        </button>
      </div>
      <button type="button" className="tb-search" onClick={onPalette}>
        <Icon name="search" size={14} />
        <span>搜索命令</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="tb-right" data-tauri-drag-region>
        <button type="button" className="icon-btn" disabled={!canUndo} title={undoLabel ? `撤销：${undoLabel}` : '撤销'} onClick={onUndo}>
          <Icon name="undo" />
        </button>
        <button type="button" className="icon-btn" disabled={!canRedo} title={redoLabel ? `重做：${redoLabel}` : '重做'} onClick={onRedo}>
          <Icon name="redo" />
        </button>
        <span className="tb-sep" />
        <button type="button" className="btn" onClick={onImport}>
          <Icon name="import" size={14} />
          导入
        </button>
        {exporting && exporting.status === 'running' ? (
          <button type="button" className="btn export-pill" onClick={onExport} title="导出中，点开查看">
            <span className="pill-bar" style={{ width: `${Math.round(exporting.ratio * 100)}%` }} />
            <span>导出 {Math.round(exporting.ratio * 100)}%</span>
          </button>
        ) : (
          <button type="button" className="btn primary" onClick={onExport} title="导出 ⌘E">
            <Icon name="export" size={14} />
            导出
          </button>
        )}
        <span className="tb-sep" />
        <button type="button" className={'icon-btn' + (terminalOpen ? ' on' : '')} title="终端 ⌘`" onClick={onTerminal}>
          <Icon name="terminal" />
        </button>
        <button type="button" className="icon-btn" title="设置" onClick={onSettings}>
          <Icon name="gear" />
        </button>
      </div>
      {menu.node}
    </header>
  )
}
