import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, MediaAsset, Project, TimelineOp } from '@shared/types'
import { timelineDurationMs } from '@shared/types'
import { Library } from './components/Library'
import { Viewer } from './components/Viewer'
import { TimelineView } from './components/Timeline'
import { ReviewPanel } from './components/ReviewPanel'
import { SettingsModal } from './components/Settings'
import { TerminalPanel } from './components/TerminalPanel'
import { Inspector } from './components/Inspector'
import { ToolTabs } from './components/ToolTabs'


type EditorState = {
  project: Project | null
  projectPath: string | null
  canUndo: boolean
  canRedo: boolean
  settings: AppSettings
}

export default function App() {
  const [state, setState] = useState<EditorState | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null)
  const [selectedClip, setSelectedClip] = useState<string | null>(null)
  const [selectedCue, setSelectedCue] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [welcomeName, setWelcomeName] = useState('未命名项目')
  const [terminalOpen, setTerminalOpen] = useState(true)
  const [dark, setDark] = useState(
    () => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
  )
  const playRef = useRef({ playing: false, originWall: 0, originMs: 0 })
  const stateRef = useRef(state)
  stateRef.current = state
  const playheadRef = useRef(playhead)
  playheadRef.current = playhead
  const selectedClipRef = useRef(selectedClip)
  selectedClipRef.current = selectedClip

  const newProject = useCallback(async (preset?: string) => {
    try {
      const next = await window.cut.createProject(preset || welcomeName || '未命名项目')
      if (next) setState(next as EditorState)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    }
  }, [welcomeName])

  useEffect(() => {
    void window.cut.getState().then(setState)
    return window.cut.onState((s) => setState(s as EditorState))
  }, [])

  useEffect(() => {
    const apply = (isDark: boolean) => {
      document.documentElement.dataset.theme = isDark ? 'dark' : 'light'
      setDark(isDark)
    }
    void window.cut.getTheme().then((t) => apply(t.dark))
    return window.cut.onTheme((t) => apply(t.dark))
  }, [])

  useEffect(() => {
    return window.cut.onMenu((ev) => {
      if (ev === 'menu:new') void newProject()
      if (ev === 'menu:open') {
        void window.cut.openProject().then((next) => {
          if (next) setState(next as EditorState)
        })
      }
      if (ev === 'menu:import') void window.cut.importMedia()
      if (ev === 'menu:terminal') setTerminalOpen((v) => !v)
      if (ev === 'menu:undo') void window.cut.undo()
      if (ev === 'menu:redo') void window.cut.redo()
    })
  }, [newProject])

  useEffect(() => {
    const assets = state?.project?.assets ?? []
    for (const asset of assets) {
      if (asset.kind !== 'video' && asset.kind !== 'audio') continue
      if (asset.durationMs > 0 && (asset.kind === 'audio' || asset.thumbPath)) continue
      void probeAsset(asset)
    }
  }, [state?.project?.assets])

  useEffect(() => {
    if (!playing) return
    playRef.current = { playing: true, originWall: performance.now(), originMs: playhead }
    let raf = 0
    let lastUi = 0
    const tick = () => {
      const next = playRef.current.originMs + (performance.now() - playRef.current.originWall)
      const proj = stateRef.current?.project
      const dur = proj ? timelineDurationMs(proj.timeline) : 0
      if (dur <= 0 || next >= dur) {
        setPlaying(false)
        setPlayhead(0)
        return
      }
      if (lastUi === 0 || next - lastUi >= 50) {
        lastUi = next
        setPlayhead(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as HTMLElement
      const tag = el?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el?.closest('.xterm')) return
      if (e.code === 'Space') {
        e.preventDefault()
        setPlaying((p) => !p)
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z') {
        e.preventDefault()
        if (e.shiftKey) void window.cut.redo()
        else void window.cut.undo()
      }
      if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault()
        if (selectedClip) {
          void window.cut.applyOps([{ op: 'remove_clip', clipId: selectedClip }], '删除片段')
          setSelectedClip(null)
          return
        }
        if (selectedCue) {
          void window.cut.applyOps([{ op: 'remove_subtitle', id: selectedCue }], '删除字幕')
          setSelectedCue(null)
          return
        }
        if (selectedAsset) {
          void deleteMedia(selectedAsset)
        }
      }
      if (e.key === 's' && selectedClip) {
        void window.cut.applyOps([{ op: 'split_clip', clipId: selectedClip, atMs: playhead }], '分割')
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const proj = stateRef.current?.project
        const clipId = selectedClipRef.current
        const clip = proj?.timeline.storyline.find((c) => c.id === clipId)
        if (!proj || !clip) return
        e.preventDefault()
        const dur = timelineDurationMs(proj.timeline)
        const next = Math.min(
          dur,
          Math.max(0, playheadRef.current + (e.key === 'ArrowLeft' ? -3000 : 3000))
        )
        playheadRef.current = next
        setPlaying(false)
        setPlayhead(next)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selectedClip, selectedCue, selectedAsset, playhead])

  async function applyOps(ops: TimelineOp[], summary?: string) {
    await window.cut.applyOps(ops, summary)
  }

  async function deleteMedia(id: string) {
    setSelectedAsset((cur) => (cur === id ? null : cur))
    try {
      await window.cut.applyOps([{ op: 'delete_asset', assetId: id }], '删除素材')
      const next = await window.cut.getState()
      if (next) setState(next as EditorState)
      setStatus('已删除素材')
    } catch (e) {
      setStatus('删除失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  async function deleteClip(clipId: string) {
    await window.cut.applyOps([{ op: 'remove_clip', clipId }], '删除片段')
    setSelectedClip((cur) => (cur === clipId ? null : cur))
    setStatus('已删除片段')
  }

  async function runTool(name: string, args: Record<string, unknown> = {}) {
    setBusy(true)
    setStatus('正在：' + name)
    try {
      const r = await window.cut.runAction(name, args)
      setStatus(r.summary)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function exportOut() {
    setStatus('正在导出…')
    try {
      const path = await window.cut.exportTimeline(state?.project?.settings.aspect === '9:16' ? 'shorts' : '1080p')
      setStatus('已导出 ' + path)
      await window.cut.showInFolder(path)
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e))
    }
  }

  if (!state) return <div className="welcome">加载中…</div>
  const project = state.project

  if (!project) {
    return (
      <div className="welcome">
        <div className="mark" />
        <h1>剪辑台</h1>
        <p>本地剪辑台。AI 通过底部终端的 cutstudio 命令，或 MCP（设置里）接入。</p>
        <input
          className="welcome-name"
          value={welcomeName}
          onChange={(e) => setWelcomeName(e.target.value)}
          placeholder="项目名称"
        />
        {status ? <p style={{ color: 'var(--danger)' }}>{status}</p> : null}
        <div className="row">
          <button className="btn primary" onClick={() => void newProject()}>
            新建项目
          </button>
          <button
            className="btn"
            onClick={() => {
              void window.cut.openProject().then((next) => {
                if (next) setState(next as EditorState)
              })
            }}
          >
            打开项目
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      className="app"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const paths = [...e.dataTransfer.files].map((f) => window.cut.getPathForFile(f)).filter(Boolean)
        if (paths.length) void window.cut.importPaths(paths)
      }}
    >
      <ToolTabs
        busy={busy}
        clipId={selectedClip}
        assetId={selectedAsset}
        assets={project.assets}
        playheadMs={playhead}
        onRun={(name, args) => void runTool(name, args ?? {})}
        extra={
          <>
            <input
              className="project-name"
              value={project.name}
              onChange={(e) => void window.cut.renameProject(e.target.value)}
            />
            <button className="btn" onClick={() => void window.cut.importMedia()}>
              导入
            </button>
            <button className="btn" onClick={() => void exportOut()}>
              导出
            </button>
            <button className={'btn' + (terminalOpen ? ' primary' : ' ghost')} onClick={() => setTerminalOpen((v) => !v)}>
              终端
            </button>
            <button className="btn ghost" onClick={() => setSettingsOpen(true)}>
              MCP
            </button>
          </>
        }
      />
      <div className="workspace">
        <Library
          assets={project.assets}
          selectedId={selectedAsset}
          onSelect={setSelectedAsset}
          onImport={() => void window.cut.importMedia()}
          onAddToTimeline={(id) => void applyOps([{ op: 'add_clip', assetId: id }], '加入故事线')}
          onDelete={(id) => void deleteMedia(id)}
        />
        <Viewer
          assets={project.assets}
          timeline={project.timeline}
          playheadMs={playhead}
          playing={playing}
          onToggle={() => setPlaying((p) => !p)}
          onSeek={(ms) => {
            setPlaying(false)
            setPlayhead(ms)
          }}
          subtitleStyle={project.subtitleStyle}
          settings={project.settings}
          selectedClip={
            project.timeline.storyline.find((c) => c.id === selectedClip) ??
            project.timeline.overlays.find((c) => c.id === selectedClip) ??
            null
          }
          onAction={(name, args) => void runTool(name, args ?? {})}
          onSelectClip={setSelectedClip}
        />
        <ReviewPanel
          project={project}
          onUndo={() => void window.cut.undo()}
          onRestore={(id) => void window.cut.restore(id)}
        />
      </div>
      <Inspector
        project={project}
        clip={
          project.timeline.storyline.find((c) => c.id === selectedClip) ??
          project.timeline.overlays.find((c) => c.id === selectedClip) ??
          project.timeline.audio.find((c) => c.id === selectedClip) ??
          null
        }
        playheadMs={playhead}
        onAction={(name, args) => void runTool(name, args ?? {})}
        onDeleteClip={(id) => void deleteClip(id)}
      />
      <TimelineView
        assets={project.assets}
        timeline={project.timeline}
        playheadMs={playhead}
        selectedClipId={selectedClip}
        selectedCueId={selectedCue}
        onSeek={(ms) => {
          setPlaying(false)
          setPlayhead(ms)
        }}
        onSelectClip={setSelectedClip}
        onSelectCue={setSelectedCue}
        onOps={(ops, summary) => void applyOps(ops, summary)}
        onDeleteClip={(id) => void deleteClip(id)}
      />
      <div className={'term-dock' + (terminalOpen ? '' : ' collapsed')}>
        <TerminalPanel dark={dark} onClose={() => setTerminalOpen(false)} />
      </div>
      {status ? <div className="status">{status}</div> : null}
      {settingsOpen ? (
        <SettingsModal
          settings={state.settings}
          onClose={() => setSettingsOpen(false)}
          onSave={(patch) => void window.cut.updateSettings(patch)}
        />
      ) : null}
      {!state.settings.firstRunComplete ? (
        <div className="perm-banner">
          <span>终端里的 AI 需要完整磁盘权限，否则系统隐私设置会拦住改工程。</span>
          <button
            className="btn primary"
            onClick={() => {
              if (typeof window.cut.requestPermissions !== 'function') return
              void window.cut.requestPermissions().then((s) => {
                if (s) setState(s as EditorState)
              })
            }}
          >
            立即授权
          </button>
        </div>
      ) : null}
    </div>
  )
}

const probing = new Set<string>()

async function probeAsset(asset: MediaAsset) {
  if (probing.has(asset.id)) return
  probing.add(asset.id)
  try {
    if (asset.durationMs <= 0 || (asset.kind === 'video' && !asset.thumbPath)) {
      await window.cut.probeAsset(asset.id)
    }
  } catch {
    /* ffprobe / decode may fail for some codecs */
  } finally {
    probing.delete(asset.id)
  }
}
