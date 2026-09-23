import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSettings, ExportProgress, MediaAsset, Project, ReviewIssue, TimelineOp } from '@shared/types'
import { clipAtTime, timelineDurationMs } from '@shared/types'
import { Library } from './components/Library'
import { Viewer } from './components/Viewer'
import { TimelineView, type TimelineApi } from './components/timeline/TimelineView'
import { SettingsModal } from './components/Settings'
import { TerminalPanel, launchAgent } from './components/TerminalPanel'
import { TopBar } from './components/TopBar'
import { Welcome } from './components/Welcome'
import { SidePanel } from './components/SidePanel'
import { CommandPalette } from './components/CommandPalette'
import { ExportDialog } from './components/ExportDialog'
import type { QaResult } from './components/QAPanel'
import { ClipInspector } from './components/inspector/ClipInspector'
import { CueInspector } from './components/inspector/CueInspector'
import { ProjectInspector } from './components/inspector/ProjectInspector'
import { dismissToast, toast, toastError, useToasts } from './lib/toast'

type EditorState = {
  project: Project | null
  projectPath: string | null
  canUndo: boolean
  canRedo: boolean
  history?: { undo: string[]; redo: string[] }
  settings: AppSettings
}

type ActionResult = { summary: string; warnings?: string[]; issues?: ReviewIssue[] }

const SNAP_KEY = 'cut-studio-snap'
const TERM_KEY = 'cut-studio-term-h'

function isTyping(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null
  if (!t) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable || Boolean(t.closest?.('.xterm'))
}

export default function App() {
  const [state, setState] = useState<EditorState | null>(null)
  const [welcomeError, setWelcomeError] = useState('')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [sideTab, setSideTab] = useState<'inspect' | 'review'>('inspect')
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null)
  const [selectedClip, setSelectedClip] = useState<string | null>(null)
  const [selectedCue, setSelectedCue] = useState<string | null>(null)
  const [playhead, setPlayhead] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [range, setRange] = useState<{ inMs: number | null; outMs: number | null }>({ inMs: null, outMs: null })
  const [snapping, setSnapping] = useState(() => localStorage.getItem(SNAP_KEY) !== '0')
  const [terminalOpen, setTerminalOpen] = useState(true)
  const [termHeight, setTermHeight] = useState(() => Number(localStorage.getItem(TERM_KEY)) || 200)
  const [qa, setQa] = useState<(QaResult & { updatedAt: string }) | null>(null)
  const [qaRunning, setQaRunning] = useState(false)
  const [exporting, setExporting] = useState<ExportProgress | null>(null)
  const [dark, setDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  const toasts = useToasts()
  const timelineApi = useRef<TimelineApi | null>(null)
  const reverseRef = useRef(0)
  const stateRef = useRef(state)
  stateRef.current = state
  const playheadRef = useRef(playhead)
  playheadRef.current = playhead
  const exportOpenRef = useRef(exportOpen)
  exportOpenRef.current = exportOpen

  const project = state?.project ?? null
  const durationMs = project ? timelineDurationMs(project.timeline) : 0

  const newProject = useCallback(async (name?: string) => {
    try {
      const next = await window.cut.createProject(name || '未命名项目')
      if (next) setState(next as EditorState)
    } catch (e) {
      setWelcomeError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const openProject = useCallback(async () => {
    try {
      const next = await window.cut.openProject()
      if (next) setState(next as EditorState)
    } catch (e) {
      toastError(e)
    }
  }, [])

  const openProjectPath = useCallback(async (path: string) => {
    try {
      setState((await window.cut.openProjectPath(path)) as EditorState)
    } catch (e) {
      setWelcomeError(e instanceof Error ? e.message : String(e))
      toastError(e)
    }
  }, [])

  // 换工程时清掉选择、入出点、质检结果
  useEffect(() => {
    setSelectedAsset(null)
    setSelectedClip(null)
    setSelectedCue(null)
    setPlayhead(0)
    setPlaying(false)
    setRange({ inMs: null, outMs: null })
    setQa(null)
  }, [state?.projectPath])

  useEffect(() => {
    void window.cut.getState().then((s) => setState(s as EditorState))
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

  useEffect(
    () =>
      window.cut.onExportProgress((p) => {
        setExporting(p)
        if (p.status === 'done' && !exportOpenRef.current) toast(`导出完成：${p.path?.split('/').pop() ?? ''}`, 'ok', p.warnings)
        if (p.status === 'error' && !exportOpenRef.current) toast(`导出失败：${p.error ?? ''}`, 'error')
      }),
    []
  )

  useEffect(() => {
    return window.cut.onMenu((ev) => {
      if (ev === 'menu:new') void newProject()
      if (ev === 'menu:open') void openProject()
      if (ev === 'menu:import') void window.cut.importMedia()
      if (ev === 'menu:terminal') setTerminalOpen((v) => !v)
      if (ev === 'menu:undo') void window.cut.undo()
      if (ev === 'menu:redo') void window.cut.redo()
    })
  }, [openProject, newProject])

  useEffect(() => {
    for (const asset of project?.assets ?? []) {
      if (asset.kind !== 'video' && asset.kind !== 'audio') continue
      if (asset.durationMs > 0 && (asset.kind === 'audio' || asset.thumbPath)) continue
      void probeAsset(asset)
    }
  }, [project?.assets])

  // 选中的东西被删掉（撤销、AI 改动）后清掉选择
  useEffect(() => {
    if (!project) return
    const tl = project.timeline
    if (selectedClip && ![...tl.storyline, ...tl.overlays, ...tl.audio].some((c) => c.id === selectedClip)) setSelectedClip(null)
    if (selectedCue && !tl.subtitles.some((c) => c.id === selectedCue)) setSelectedCue(null)
    if (selectedAsset && !project.assets.some((a) => a.id === selectedAsset)) setSelectedAsset(null)
  }, [project, selectedClip, selectedCue, selectedAsset])

  // 播放时钟（rate = J/K/L 倍速）
  useEffect(() => {
    if (!playing) return
    const originWall = performance.now()
    const originMs = playheadRef.current
    let raf = 0
    let lastUi = 0
    const tick = () => {
      const next = originMs + (performance.now() - originWall) * rate
      const dur = stateRef.current?.project ? timelineDurationMs(stateRef.current.project.timeline) : 0
      if (dur <= 0 || next >= dur) {
        setPlaying(false)
        setRate(1)
        setPlayhead(dur > 0 ? dur : 0)
        return
      }
      if (lastUi === 0 || next - lastUi >= 50 * rate) {
        lastUi = next
        setPlayhead(next)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, rate])

  const stopReverse = () => {
    cancelAnimationFrame(reverseRef.current)
    reverseRef.current = 0
  }

  const seek = useCallback((ms: number) => {
    stopReverse()
    setPlaying(false)
    setRate(1)
    const dur = stateRef.current?.project ? timelineDurationMs(stateRef.current.project.timeline) : 0
    setPlayhead(Math.max(0, Math.min(Math.max(dur, 0), ms)))
  }, [])

  const togglePlay = useCallback(() => {
    stopReverse()
    setRate(1)
    setPlaying((p) => {
      if (!p) {
        const dur = stateRef.current?.project ? timelineDurationMs(stateRef.current.project.timeline) : 0
        if (playheadRef.current >= dur - 50) setPlayhead(0)
      }
      return !p
    })
  }, [])

  /** 倒放拖动（J）：暂停时按步往回退，预览逐帧刷新。 */
  function startReverse() {
    setPlaying(false)
    setRate(1)
    if (reverseRef.current) return
    let last = performance.now()
    const step = () => {
      const now = performance.now()
      const next = playheadRef.current - (now - last)
      last = now
      if (next <= 0) {
        setPlayhead(0)
        reverseRef.current = 0
        return
      }
      playheadRef.current = next
      setPlayhead(next)
      reverseRef.current = requestAnimationFrame(step)
    }
    reverseRef.current = requestAnimationFrame(step)
  }

  async function applyOps(ops: TimelineOp[], summary?: string) {
    try {
      await window.cut.applyOps(ops, summary)
    } catch (e) {
      toastError(e)
    }
  }

  /** 工具按钮 / 命令：成功时提示摘要和提醒。 */
  async function runTool(name: string, args: Record<string, unknown> = {}) {
    try {
      const r = (await window.cut.runAction(name, args)) as ActionResult
      toast(r.summary, 'ok', r.warnings)
      return r
    } catch (e) {
      toastError(e)
      return null
    }
  }

  /** 检查器里的调整：只在出错或有提醒时提示。 */
  async function runQuiet(name: string, args: Record<string, unknown> = {}) {
    try {
      const r = (await window.cut.runAction(name, args)) as ActionResult
      if (r.warnings?.length) toast(r.summary, 'info', r.warnings)
    } catch (e) {
      toastError(e)
    }
  }

  async function deleteMedia(id: string) {
    setSelectedAsset((cur) => (cur === id ? null : cur))
    await applyOps([{ op: 'delete_asset', assetId: id }], '删除素材')
  }

  async function deleteClip(clipId: string) {
    setSelectedClip((cur) => (cur === clipId ? null : cur))
    await applyOps([{ op: 'remove_clip', clipId }], '删除片段')
  }

  function splitAtPlayhead() {
    const tl = stateRef.current?.project?.timeline
    if (!tl) return
    const at = playheadRef.current
    const inside = (c: { startMs: number; durationMs: number }) => at > c.startMs + 30 && at < c.startMs + c.durationMs - 30
    const sel = [...tl.storyline, ...tl.overlays, ...tl.audio].find((c) => c.id === selectedClip)
    const target = sel && inside(sel) ? sel : clipAtTime(tl.storyline, at)
    if (!target || !inside(target)) {
      toast('播放头不在可分割的片段上')
      return
    }
    void applyOps([{ op: 'split_clip', clipId: target.id, atMs: at }], '分割')
  }

  async function runQa(visual = false) {
    if (!project) return
    setQaRunning(true)
    try {
      const r = (await window.cut.runAction('review_timeline', { visual })) as ActionResult
      const at = stateRef.current?.project?.updatedAt ?? project.updatedAt
      setQa({ issues: r.issues ?? [], summary: r.summary, at: new Date().toISOString(), visual, updatedAt: at })
    } catch (e) {
      toastError(e)
    } finally {
      setQaRunning(false)
    }
  }

  function jumpToIssue(issue: ReviewIssue) {
    const tl = project?.timeline
    const clip = issue.clipId && tl ? [...tl.storyline, ...tl.overlays, ...tl.audio].find((c) => c.id === issue.clipId) : null
    if (clip) {
      setSelectedClip(clip.id)
      setSelectedCue(null)
    }
    seek(issue.atMs ?? clip?.startMs ?? playheadRef.current)
  }

  function startAgent(agent: string) {
    setTerminalOpen(true)
    window.setTimeout(() => launchAgent(agent, stateRef.current?.projectPath ?? null), 60)
  }

  function appAction(action: string) {
    if (action === 'export') setExportOpen(true)
    else if (action === 'qa') {
      setSideTab('review')
      void runQa(false)
    } else if (action === 'undo') void window.cut.undo()
    else if (action === 'redo') void window.cut.redo()
    else if (action === 'import') void window.cut.importMedia()
    else if (action === 'split') splitAtPlayhead()
    else if (action === 'fit') timelineApi.current?.fit()
    else if (action === 'snap') toggleSnap()
    else if (action === 'terminal') setTerminalOpen((v) => !v)
    else if (action === 'settings') setSettingsOpen(true)
    else if (action === 'close') void window.cut.closeProject()
    else if (action.startsWith('agent:')) startAgent(action.slice(6))
  }

  function toggleSnap() {
    setSnapping((v) => {
      try {
        localStorage.setItem(SNAP_KEY, v ? '0' : '1')
      } catch {
        /* ignore */
      }
      toast(v ? '吸附已关闭' : '吸附已打开')
      return !v
    })
  }

  function setRangePatch(patch: { inMs?: number | null; outMs?: number | null }) {
    setRange((r) => {
      const next = { ...r, ...patch }
      if (next.inMs != null && next.outMs != null && next.outMs <= next.inMs) {
        if (patch.inMs != null) next.outMs = null
        else next.inMs = null
      }
      return next
    })
  }

  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {})
  keyRef.current = (e: KeyboardEvent) => {
    if (!stateRef.current?.project || paletteOpen || exportOpen || settingsOpen) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      setPaletteOpen(true)
      return
    }
    if (isTyping(e.target)) return
    const fps = stateRef.current.project.settings.fps || 30
    const key = e.key
    if (mod) {
      if (key === 'e' || key === 'E') {
        e.preventDefault()
        setExportOpen(true)
      } else if (key === 'b' || key === 'B') {
        e.preventDefault()
        splitAtPlayhead()
      } else if (key === '=' || key === '+') {
        e.preventDefault()
        timelineApi.current?.zoomIn()
      } else if (key === '-' || key === '_') {
        e.preventDefault()
        timelineApi.current?.zoomOut()
      } else if (key === 'z' || key === 'Z') {
        // 浏览器里没有原生菜单时自己处理撤销（App 里由菜单快捷键接管）
        e.preventDefault()
        if (e.shiftKey) void window.cut.redo()
        else void window.cut.undo()
      }
      return
    }
    if (e.altKey && e.code === 'KeyX') {
      e.preventDefault()
      setRange({ inMs: null, outMs: null })
      return
    }
    switch (e.code) {
      case 'Space':
        e.preventDefault()
        togglePlay()
        return
      case 'KeyK':
        stopReverse()
        setPlaying(false)
        setRate(1)
        return
      case 'KeyL':
        stopReverse()
        if (playing) setRate((r) => Math.min(4, r * 2))
        else {
          setRate(1)
          setPlaying(true)
        }
        return
      case 'KeyJ':
        startReverse()
        return
      case 'ArrowLeft':
      case 'ArrowRight': {
        e.preventDefault()
        const step = e.shiftKey ? 1000 : 1000 / fps
        seek(playheadRef.current + (e.code === 'ArrowLeft' ? -step : step))
        return
      }
      case 'Home':
        e.preventDefault()
        seek(0)
        return
      case 'End':
        e.preventDefault()
        seek(timelineDurationMs(stateRef.current.project.timeline))
        return
      case 'KeyI':
        setRangePatch({ inMs: playheadRef.current })
        return
      case 'KeyO':
        setRangePatch({ outMs: playheadRef.current })
        return
      case 'KeyN':
        toggleSnap()
        return
      case 'KeyS':
        splitAtPlayhead()
        return
      case 'KeyZ':
        if (e.shiftKey) timelineApi.current?.fit()
        return
      case 'Escape':
        setSelectedClip(null)
        setSelectedCue(null)
        return
      case 'Backspace':
      case 'Delete':
        e.preventDefault()
        if (selectedClip) void deleteClip(selectedClip)
        else if (selectedCue) {
          void applyOps([{ op: 'remove_subtitle', id: selectedCue }], '删除字幕')
          setSelectedCue(null)
        } else if (selectedAsset) void deleteMedia(selectedAsset)
        return
    }
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyRef.current(e)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const toastLayer = (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={'toast ' + t.kind} onClick={() => dismissToast(t.id)}>
          <div>{t.text}</div>
          {t.details?.map((d) => (
            <small key={d}>{d}</small>
          ))}
        </div>
      ))}
    </div>
  )

  if (!state) return <div className="welcome">加载中…</div>

  if (!project) {
    return (
      <>
        <Welcome error={welcomeError} onNew={(name) => void newProject(name)} onOpen={() => void openProject()} onOpenPath={(p) => void openProjectPath(p)} />
        {toastLayer}
      </>
    )
  }

  const tl = project.timeline
  const clipTrack = (id: string | null) => {
    if (!id) return null
    const s = tl.storyline.find((c) => c.id === id)
    if (s) return { clip: s, track: 'storyline' as const }
    const o = tl.overlays.find((c) => c.id === id)
    if (o) return { clip: o, track: 'overlay' as const }
    const a = tl.audio.find((c) => c.id === id)
    if (a) return { clip: a, track: 'audio' as const }
    return null
  }
  const sel = clipTrack(selectedClip)
  const cue = selectedCue ? tl.subtitles.find((c) => c.id === selectedCue) : undefined
  const history = state.history ?? { undo: [], redo: [] }
  const qaStale = Boolean(qa && qa.updatedAt !== project.updatedAt)
  const selectFromTimeline = (id: string | null) => {
    setSelectedClip(id)
    if (id) setSideTab('inspect')
  }
  const selectCueFromTimeline = (id: string | null) => {
    setSelectedCue(id)
    if (id) setSideTab('inspect')
  }

  const inspector = cue ? (
    <CueInspector
      cue={cue}
      style={project.subtitleStyle}
      onOps={(ops, s) => void applyOps(ops, s)}
      onAction={(n, a) => void runQuiet(n, a ?? {})}
      onDelete={() => {
        void applyOps([{ op: 'remove_subtitle', id: cue.id }], '删除字幕')
        setSelectedCue(null)
      }}
    />
  ) : sel ? (
    <ClipInspector
      key={sel.clip.id}
      clip={sel.clip}
      track={sel.track}
      asset={project.assets.find((a) => a.id === sel.clip.assetId)}
      playheadMs={playhead}
      onAction={(n, a) => void runQuiet(n, a ?? {})}
      onDelete={() => void deleteClip(sel.clip.id)}
    />
  ) : (
    <ProjectInspector project={project} onAction={(n, a) => void runQuiet(n, a ?? {})} onSeek={seek} />
  )

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
      <TopBar
        name={project.name}
        projectPath={state.projectPath}
        canUndo={state.canUndo}
        canRedo={state.canRedo}
        undoLabel={history.undo[0]}
        redoLabel={history.redo[0]}
        terminalOpen={terminalOpen}
        exporting={exporting}
        onRename={(name) => void window.cut.renameProject(name)}
        onPalette={() => setPaletteOpen(true)}
        onUndo={() => void window.cut.undo()}
        onRedo={() => void window.cut.redo()}
        onImport={() => void window.cut.importMedia()}
        onExport={() => setExportOpen(true)}
        onTerminal={() => setTerminalOpen((v) => !v)}
        onSettings={() => setSettingsOpen(true)}
        onNew={() => void newProject()}
        onOpen={() => void openProject()}
        onOpenPath={(p) => void openProjectPath(p)}
        onClose={() => void window.cut.closeProject()}
        loadRecent={() => window.cut.recentProjects()}
      />
      <div className="workspace">
        <Library
          assets={project.assets}
          selectedId={selectedAsset}
          onSelect={setSelectedAsset}
          onImport={() => void window.cut.importMedia()}
          onAddToTimeline={(id) => void applyOps([{ op: 'add_clip', assetId: id }], '加入主线')}
          onAction={(n, a) => void runTool(n, n === 'insert_broll' ? { atMs: Math.round(playhead), ...a } : a ?? {})}
          onDelete={(id) => void deleteMedia(id)}
        />
        <Viewer
          assets={project.assets}
          timeline={tl}
          playheadMs={playhead}
          playing={playing}
          rate={rate}
          durationMs={durationMs}
          onToggle={togglePlay}
          onSeek={seek}
          subtitleStyle={project.subtitleStyle}
          settings={project.settings}
          selectedClip={tl.storyline.find((c) => c.id === selectedClip) ?? tl.overlays.find((c) => c.id === selectedClip) ?? null}
          onAction={(n, a) => void runQuiet(n, a ?? {})}
          onSelectClip={selectFromTimeline}
        />
        <SidePanel
          project={project}
          inspector={inspector}
          history={history}
          qa={qa}
          qaRunning={qaRunning}
          qaStale={qaStale}
          tab={sideTab}
          onTab={setSideTab}
          onRunQa={(visual) => void runQa(visual)}
          onJump={jumpToIssue}
          onUndo={(steps) => void window.cut.undo(steps)}
          onRedo={(steps) => void window.cut.redo(steps)}
          onRestore={(id) => void window.cut.restore(id)}
        />
      </div>
      <TimelineView
        assets={project.assets}
        timeline={tl}
        markers={project.markers ?? []}
        playheadMs={playhead}
        playing={playing}
        selectedClipId={selectedClip}
        selectedCueId={selectedCue}
        selectedAssetId={selectedAsset}
        range={range}
        snapping={snapping}
        apiRef={timelineApi}
        onSeek={seek}
        onSelectClip={selectFromTimeline}
        onSelectCue={selectCueFromTimeline}
        onOps={(ops, s) => void applyOps(ops, s)}
        onAction={(n, a) => void runTool(n, a ?? {})}
        onDeleteClip={(id) => void deleteClip(id)}
        onSetRange={setRangePatch}
        onAddMarker={(atMs) => void runTool('add_marker', { atMs: Math.round(atMs), label: '标记' })}
        onToggleSnap={toggleSnap}
      />
      {terminalOpen ? (
        <div
          className="term-grip"
          title="拖动调整终端高度"
          onMouseDown={(e) => {
            e.preventDefault()
            const startY = e.clientY
            const startH = termHeight
            const move = (ev: MouseEvent) => setTermHeight(Math.max(90, Math.min(window.innerHeight * 0.6, startH - (ev.clientY - startY))))
            const up = (ev: MouseEvent) => {
              window.removeEventListener('mousemove', move)
              window.removeEventListener('mouseup', up)
              try {
                localStorage.setItem(TERM_KEY, String(Math.round(Math.max(90, startH - (ev.clientY - startY)))))
              } catch {
                /* ignore */
              }
            }
            window.addEventListener('mousemove', move)
            window.addEventListener('mouseup', up)
          }}
        />
      ) : null}
      <div className={'term-dock' + (terminalOpen ? '' : ' collapsed')} style={{ height: termHeight }}>
        <TerminalPanel dark={dark} projectPath={state.projectPath} onClose={() => setTerminalOpen(false)} />
      </div>
      {paletteOpen ? (
        <CommandPalette
          ctx={{ clipId: selectedClip, assetId: selectedAsset, assets: project.assets, playheadMs: playhead }}
          onRun={(name, args) => void runTool(name, args)}
          onApp={appAction}
          onClose={() => setPaletteOpen(false)}
        />
      ) : null}
      {exportOpen ? (
        <ExportDialog
          project={project}
          range={range.inMs != null && range.outMs != null && range.outMs > range.inMs ? { inMs: range.inMs, outMs: range.outMs } : null}
          progress={exporting}
          qaErrors={qa && !qaStale ? qa.issues.filter((i) => i.severity === 'error').length : null}
          qaStale={qaStale}
          onRunQa={() => {
            setSideTab('review')
            void runQa(false)
          }}
          onClose={() => setExportOpen(false)}
        />
      ) : null}
      {settingsOpen ? (
        <SettingsModal settings={state.settings} onClose={() => setSettingsOpen(false)} onSave={(patch) => void window.cut.updateSettings(patch)} />
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
      {toastLayer}
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
