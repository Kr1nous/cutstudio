import { useEffect, useState } from 'react'
import type { RecentProject } from '@shared/types'

type Recent = RecentProject & { exists: boolean }

function ago(iso: string): string {
  const d = (Date.now() - new Date(iso).getTime()) / 1000
  if (!Number.isFinite(d)) return ''
  if (d < 60) return '刚刚'
  if (d < 3600) return `${Math.floor(d / 60)} 分钟前`
  if (d < 86400) return `${Math.floor(d / 3600)} 小时前`
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} 天前`
  return new Date(iso).toLocaleDateString()
}

function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, '~')
}

/** 欢迎页：新建 / 打开，下面是最近项目。 */
export function Welcome({ error, onNew, onOpen, onOpenPath }: { error?: string; onNew: (name: string) => void; onOpen: () => void; onOpenPath: (path: string) => void }) {
  const [name, setName] = useState('未命名项目')
  const [recent, setRecent] = useState<Recent[]>([])

  const load = () => void window.cut.recentProjects().then(setRecent).catch(() => setRecent([]))
  useEffect(load, [])

  return (
    <div className="welcome" data-tauri-drag-region>
      <div className="welcome-card">
        <div className="mark" />
        <h1>剪辑台</h1>
        <p>导入素材，在底部终端里让 claude / codex 等 AI 剪辑，你在时间线上微调。</p>
        <div className="welcome-new">
          <input
            className="welcome-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onNew(name)}
            placeholder="项目名称"
          />
          <button type="button" className="btn primary" onClick={() => onNew(name)}>
            新建项目
          </button>
          <button type="button" className="btn" onClick={onOpen}>
            打开…
          </button>
        </div>
        {error ? <p className="welcome-err">{error}</p> : null}
        {recent.length ? (
          <div className="recent">
            <div className="recent-h">最近项目</div>
            {recent.map((r) => (
              <div key={r.path} className={'recent-row' + (r.exists ? '' : ' missing')}>
                <button type="button" disabled={!r.exists} onClick={() => onOpenPath(r.path)} title={r.path}>
                  <b>{r.name}</b>
                  <small>{r.exists ? shortPath(r.path) : '找不到了：' + shortPath(r.path)}</small>
                </button>
                <time>{ago(r.openedAt)}</time>
                <button
                  type="button"
                  className="recent-x"
                  title="从列表移除"
                  onClick={() => void window.cut.forgetRecent(r.path).then(load)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}
