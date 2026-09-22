import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { id, nowIso } from '../shared/ids'
import { applySourceFrame, packStorylineClips, shouldAdoptSourceFrame } from '../shared/compose'
import { probeMedia, writeThumb } from './render/ffmpeg'
import { analyzeMediaFile } from './render/wave'
import { queueAssetAnalysis } from './analysis/background'
import { writeAgentDocs } from './agentdocs'
import {
  type AppSettings,
  type MediaAsset,
  type MediaKind,
  type Project,
  type ReviewAction,
  type SubtitleCue,
  type Timeline,
  type TimelineClip,
  type TimelineOp,
  DEFAULT_CLIP_FX,
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_SETTINGS,
  DEFAULT_SUBTITLE_STYLE,
  clipFx,
  emptyTimeline,
  timelineDurationMs
} from '../shared/types'

const UNDO_LIMIT = 80

/** transcript 只在会改转写的操作（pushUndo(label, { transcript: true })）里保存，避免撤销剪辑时连带回退后台的转写重新对齐。 */
type UndoEntry = { timeline: Timeline; transcript?: Project['transcript']; label?: string }

export type EditorState = ReturnType<ProjectStore['getState']>
type StateListener = (state: EditorState) => void

export class ProjectStore {
  project: Project | null = null
  projectPath: string | null = null
  settings: AppSettings = structuredClone(DEFAULT_SETTINGS)
  settingsPath = ''
  private undo: UndoEntry[] = []
  private redo: UndoEntry[] = []
  private listeners = new Set<StateListener>()

  onChange(fn: StateListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  broadcast(): void {
    const payload = this.getState()
    for (const fn of this.listeners) {
      try {
        fn(payload)
      } catch (err) {
        console.error(err)
      }
    }
  }

  getState() {
    return {
      project: this.project,
      projectPath: this.projectPath,
      canUndo: this.undo.length > 0,
      canRedo: this.redo.length > 0,
      settings: this.publicSettings()
    }
  }

  publicSettings(): AppSettings {
    return {
      ...this.settings,
      providers: this.settings.providers.map((p) => ({
        ...p,
        apiKey: p.apiKey ? '••••' + p.apiKey.slice(-4) : ''
      }))
    }
  }

  async loadSettings(userData: string): Promise<void> {
    this.settingsPath = join(userData, 'settings.json')
    try {
      const raw = await readFile(this.settingsPath, 'utf8')
      const parsed = JSON.parse(raw) as AppSettings
      this.settings = {
        ...DEFAULT_SETTINGS,
        ...parsed,
        providers: mergeProviders(DEFAULT_SETTINGS.providers, parsed.providers ?? [])
      }
    } catch {
      if (process.env.XAI_API_KEY) {
        const spacex = this.settings.providers.find((p) => p.id === 'spacexai')
        if (spacex) spacex.apiKey = process.env.XAI_API_KEY
      }
      await this.saveSettings()
    }
  }

  async saveSettings(): Promise<void> {
    if (!this.settingsPath) return
    await writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8')
  }

  async updateSettings(patch: Partial<AppSettings> & { providers?: AppSettings['providers'] }): Promise<void> {
    if (patch.activeProviderId) this.settings.activeProviderId = patch.activeProviderId
    if (typeof patch.allowMediaUpload === 'boolean') this.settings.allowMediaUpload = patch.allowMediaUpload
    if (typeof patch.allowCloudTranscription === 'boolean') this.settings.allowCloudTranscription = patch.allowCloudTranscription
    if (typeof patch.mcpPort === 'number') this.settings.mcpPort = patch.mcpPort
    if (typeof patch.firstRunComplete === 'boolean') this.settings.firstRunComplete = patch.firstRunComplete
    if (patch.providers) {
      for (const incoming of patch.providers) {
        const existing = this.settings.providers.find((p) => p.id === incoming.id)
        if (existing) {
          if (incoming.name) existing.name = incoming.name
          if (incoming.kind) existing.kind = incoming.kind
          if (incoming.baseUrl) existing.baseUrl = incoming.baseUrl
          if (incoming.model) existing.model = incoming.model
          if (typeof incoming.enabled === 'boolean') existing.enabled = incoming.enabled
          if (incoming.apiKey && !incoming.apiKey.includes('•')) existing.apiKey = incoming.apiKey
        } else {
          this.settings.providers.push(incoming)
        }
      }
    }
    await this.saveSettings()
    this.broadcast()
  }

  activeProvider() {
    return (
      this.settings.providers.find((p) => p.id === this.settings.activeProviderId) ??
      this.settings.providers[0]
    )
  }

  async createProject(parentDir: string, name: string): Promise<void> {
    const folder = join(parentDir, `${sanitize(name)}.cutproj`)
    await mkdir(join(folder, 'media'), { recursive: true })
    await mkdir(join(folder, 'thumbs'), { recursive: true })
    await mkdir(join(folder, 'export'), { recursive: true })
    const project: Project = {
      version: 1,
      name,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      settings: { ...DEFAULT_PROJECT_SETTINGS },
      subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
      assets: [],
      timeline: emptyTimeline(),
      transcript: [],
      markers: [],
      snapshots: [],
      review: []
    }
    this.project = project
    this.projectPath = folder
    this.undo = []
    this.redo = []
    this.settings.lastProjectPath = folder
    await this.saveSettings()
    await this.save()
    this.writeAgentDocs()
    this.broadcast()
  }

  async openProject(folder: string): Promise<void> {
    const raw = await readFile(join(folder, 'project.json'), 'utf8')
    this.project = migrateProject(JSON.parse(raw) as Project)
    this.projectPath = folder
    this.undo = []
    this.redo = []
    this.settings.lastProjectPath = folder
    await this.saveSettings()
    this.writeAgentDocs()
    this.broadcast()
    // 旧索引升级、转写重新对齐等在后台补齐
    queueAssetAnalysis(
      this,
      this.project.assets.filter((a) => a.kind === 'video' || a.kind === 'audio').map((a) => a.id)
    )
  }

  /** 工程目录里写给终端 AI agent 的说明文件（CLAUDE.md / AGENTS.md / GEMINI.md / skill）。失败不影响工程。 */
  private writeAgentDocs(): void {
    try {
      writeAgentDocs(this.projectPath)
    } catch {
      /* ignore */
    }
  }

  async save(): Promise<void> {
    if (!this.project || !this.projectPath) return
    this.project.updatedAt = nowIso()
    await writeFile(join(this.projectPath, 'project.json'), JSON.stringify(this.project, null, 2), 'utf8')
  }

  requireProject(): Project {
    if (!this.project) throw new Error('还没有打开项目')
    return this.project
  }

  pushUndo(label?: string, opts: { transcript?: boolean } = {}): void {
    if (!this.project) return
    this.undo.push(this.entry(label, opts.transcript))
    if (this.undo.length > UNDO_LIMIT) this.undo.shift()
    this.redo = []
  }

  /** 撤销点：时间线深拷贝；转写按引用保存（转写只会整体替换，不会原地改）。 */
  private entry(label?: string, withTranscript = false): UndoEntry {
    const p = this.requireProject()
    return { timeline: structuredClone(p.timeline), ...(withTranscript ? { transcript: p.transcript } : {}), label }
  }

  private restore(e: UndoEntry): void {
    const p = this.requireProject()
    p.timeline = e.timeline
    if (e.transcript) p.transcript = e.transcript
  }

  /** 把 fn 里多次改动合并成一次撤销、一条审查记录、至多一个版本快照。 */
  async batch<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const project = this.requireProject()
    const undoLen = this.undo.length
    const reviewLen = project.review.length
    const snapLen = project.snapshots.length
    const out = await fn()
    if (this.undo.length > undoLen + 1) {
      // 合并时保留最早的撤销点；中途有改转写的撤销点时，把转写一起带上
      const merged = this.undo.splice(undoLen + 1)
      const withTranscript = merged.find((x) => x.transcript)
      if (withTranscript && !this.undo[undoLen]!.transcript) this.undo[undoLen]!.transcript = withTranscript.transcript
    }
    if (this.undo.length === undoLen + 1) this.undo[undoLen]!.label = label
    const added = project.review.length - reviewLen
    if (added > 1) {
      const [first] = project.review.splice(0, added)
      project.review.unshift({ ...first, summary: label })
    }
    if (project.snapshots.length > snapLen + 1) {
      const last = project.snapshots.splice(snapLen).at(-1)!
      project.snapshots.push({ ...last, label })
    }
    await this.save()
    this.broadcast()
    return out
  }

  /** 撤销上一步，返回被撤销那一步的说明（没有可撤销的返回 null）。 */
  async undoLast(): Promise<{ label: string } | null> {
    if (!this.project || this.undo.length === 0) return null
    const e = this.undo.pop()!
    this.redo.push(this.entry(e.label, Boolean(e.transcript)))
    this.restore(e)
    await this.save()
    this.broadcast()
    return { label: e.label ?? '上一步改动' }
  }

  async redoLast(): Promise<{ label: string } | null> {
    if (!this.project || this.redo.length === 0) return null
    const e = this.redo.pop()!
    this.undo.push(this.entry(e.label, Boolean(e.transcript)))
    this.restore(e)
    await this.save()
    this.broadcast()
    return { label: e.label ?? '上一步改动' }
  }

  /** 下一次 undo 会撤掉什么。 */
  undoPreview(): string | null {
    const e = this.undo.at(-1)
    return e ? e.label ?? '上一步改动' : null
  }

  snapshot(label: string): void {
    const project = this.requireProject()
    project.snapshots.push({
      id: id('snap'),
      createdAt: nowIso(),
      label,
      timeline: structuredClone(project.timeline)
    })
    if (project.snapshots.length > 40) project.snapshots.shift()
  }

  async restoreSnapshot(snapshotId: string): Promise<void> {
    const project = this.requireProject()
    const snap = project.snapshots.find((s) => s.id === snapshotId)
    if (!snap) throw new Error('找不到该版本')
    this.pushUndo()
    project.timeline = structuredClone(snap.timeline)
    this.log({ tool: 'restore_snapshot', summary: `恢复到「${snap.label}」`, risk: 'medium', source: 'human' })
    await this.save()
    this.broadcast()
  }

  log(partial: Omit<ReviewAction, 'id' | 'at' | 'reversible'> & { reversible?: boolean }): void {
    const project = this.requireProject()
    const top = this.undo.at(-1)
    if (top && top.label == null) top.label = partial.summary
    project.review.unshift({
      id: id('act'),
      at: nowIso(),
      reversible: partial.reversible ?? true,
      ...partial
    })
    project.review = project.review.slice(0, 200)
  }

  async importFiles(filePaths: string[]): Promise<MediaAsset[]> {
    const project = this.requireProject()
    if (!this.projectPath) throw new Error('项目路径丢失')
    await mkdir(join(this.projectPath, 'media'), { recursive: true })
    await mkdir(join(this.projectPath, 'thumbs'), { recursive: true })
    const imported: MediaAsset[] = []
    for (const src of filePaths) {
      const kind = kindFromExt(extname(src))
      if (!kind) continue
      const assetId = id('asset')
      const destName = `${assetId}${extname(src).toLowerCase()}`
      const dest = join(this.projectPath, 'media', destName)
      await copyFile(src, dest)
      const probed = await probeMedia(dest)
      const asset: MediaAsset = {
        id: assetId,
        name: basename(src),
        path: dest,
        kind,
        durationMs: probed.durationMs || (kind === 'image' ? 5000 : 0),
        width: probed.width,
        height: probed.height,
        fps: probed.fps || project.settings.fps,
        importedAt: nowIso()
      }
      if (kind === 'video') {
        const thumb = join(this.projectPath, 'thumbs', `${assetId}.jpg`)
        const at = Math.min(1, Math.max(0.05, (asset.durationMs || 1000) / 3000))
        if (await writeThumb(dest, thumb, at)) asset.thumbPath = thumb
      }
      if (kind === 'video' || kind === 'audio') {
        try {
          // 短素材顺便做镜头检测；长素材的镜头检测和转写交给后台队列，不阻塞导入
          asset.index = await analyzeMediaFile(dest, asset.durationMs, { scenes: asset.durationMs <= 120_000 })
        } catch {
          /* waveform is best-effort */
        }
      }
      project.assets.push(asset)
      if ((kind === 'video' || kind === 'image') && asset.width && asset.height && shouldAdoptSourceFrame(project)) {
        applySourceFrame(project.settings, asset.width, asset.height)
      }
      imported.push(asset)
    }
    this.log({
      tool: 'import_media',
      summary: `导入 ${imported.length} 个素材`,
      risk: 'low',
      source: 'human',
      reversible: false
    })
    await this.save()
    this.broadcast()
    queueAssetAnalysis(
      this,
      imported.filter((a) => a.kind === 'video' || a.kind === 'audio').map((a) => a.id)
    )
    return imported
  }

  async deleteAsset(assetId: string): Promise<ReturnType<ProjectStore['getState']>> {
    const project = this.requireProject()
    const id = String(assetId || '')
    const asset = project.assets.find((a) => a.id === id)
    if (!asset) throw new Error('找不到要删除的素材')
    this.pushUndo()
    project.timeline.storyline = project.timeline.storyline.filter((c) => c.assetId !== id)
    project.timeline.overlays = project.timeline.overlays.filter((c) => c.assetId !== id)
    project.timeline.audio = project.timeline.audio.filter((c) => c.assetId !== id)
    packStorylineClips(project.timeline.storyline)
    project.assets = project.assets.filter((a) => a.id !== id)
    try {
      await unlink(asset.path)
    } catch {
      /* file may be in use */
    }
    if (asset.thumbPath) {
      try {
        await unlink(asset.thumbPath)
      } catch {
        /* ignore */
      }
    }
    if (asset.proxyPath) {
      try {
        await unlink(asset.proxyPath)
      } catch {
        /* ignore */
      }
    }
    this.log({
      tool: 'delete_asset',
      summary: `删除素材 ${asset.name}`,
      risk: 'medium',
      source: 'human',
      reversible: true
    })
    await this.save()
    this.broadcast()
    return this.getState()
  }

  async updateAssetMeta(
    assetId: string,
    meta: Partial<Pick<MediaAsset, 'durationMs' | 'width' | 'height' | 'fps' | 'thumbPath' | 'index' | 'proxyPath' | 'proxyWidth' | 'proxyHeight'>>
  ): Promise<void> {
    const project = this.requireProject()
    const asset = project.assets.find((a) => a.id === assetId)
    if (!asset) return
    Object.assign(asset, meta)
    await this.save()
    this.broadcast()
  }

  async applyOps(
    ops: TimelineOp[],
    source: ReviewAction['source'],
    summary?: string
  ): Promise<{ applied: number; durationMs: number }> {
    if (ops.length === 1 && ops[0].op === 'delete_asset') {
      await this.deleteAsset(ops[0].assetId)
      return { applied: 1, durationMs: timelineDurationMs(this.requireProject().timeline) }
    }
    const project = this.requireProject()
    this.pushUndo()
    const clipSource = source === 'human' ? 'human' : 'ai'
    for (const op of ops) applyOp(project, op, clipSource)
    packStoryline(project.timeline.storyline)
    const label = summary ?? summarizeOps(ops)
    this.log({
      tool: ops.length === 1 ? ops[0].op : 'batch_edit',
      summary: label,
      risk: riskForOps(ops),
      source
    })
    if (source === 'ai' || source === 'mcp') {
      this.snapshot(label)
    }
    await this.save()
    this.broadcast()
    return { applied: ops.length, durationMs: timelineDurationMs(project.timeline) }
  }

  compactForAi() {
    const project = this.requireProject()
    return {
      name: project.name,
      settings: project.settings,
      durationMs: timelineDurationMs(project.timeline),
      assets: project.assets.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        durationMs: a.durationMs,
        width: a.width,
        height: a.height,
        proxy: Boolean(a.proxyPath),
        analyzed: Boolean(a.index)
      })),
      transcriptReady: project.transcript.some((t) => t.text.trim()),
      renderQueue: (project.renderQueue ?? []).map((j) => ({
        id: j.id,
        preset: j.preset,
        status: j.status,
        path: j.path
      })),
      storyline: project.timeline.storyline.map((c) => ({
        id: c.id,
        assetId: c.assetId,
        assetName: project.assets.find((a) => a.id === c.assetId)?.name,
        startMs: c.startMs,
        durationMs: c.durationMs,
        inMs: c.inMs,
        outMs: c.outMs,
        volume: c.volume,
        fx: fxDiff(c.fx)
      })),
      layers: project.timeline.overlays.map((c) => ({
        id: c.id,
        kind: c.kind ?? 'footage',
        blend: c.blend ?? 'normal',
        assetId: c.assetId,
        assetName: project.assets.find((a) => a.id === c.assetId)?.name,
        startMs: c.startMs,
        durationMs: c.durationMs,
        solidColor: c.solidColor,
        text: c.text?.text,
        shape: c.shape?.shape,
        textAnim: c.textAnim,
        fx: fxDiff(c.fx)
      })),
      subtitles: project.timeline.subtitles
    }
  }
}

export const store = new ProjectStore()

/** 只保留和默认值不同的效果字段，给 AI 看的项目摘要不被一堆默认值淹没。 */
function fxDiff(fx: TimelineClip['fx']): Record<string, unknown> | undefined {
  if (!fx) return undefined
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fx)) {
    if (value === undefined) continue
    const def = (DEFAULT_CLIP_FX as unknown as Record<string, unknown>)[key]
    if (def !== undefined && JSON.stringify(def) === JSON.stringify(value)) continue
    if (Array.isArray(value) && !value.length) continue
    if (value && typeof value === 'object' && !Array.isArray(value) && !Object.keys(value).length) continue
    out[key] = value
  }
  return Object.keys(out).length ? out : undefined
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'untitled'
}

function kindFromExt(ext: string): MediaKind | null {
  const e = ext.toLowerCase()
  if (['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'].includes(e)) return 'video'
  if (['.mp3', '.wav', '.aac', '.m4a', '.aiff'].includes(e)) return 'audio'
  if (['.png', '.jpg', '.jpeg', '.webp', '.heic'].includes(e)) return 'image'
  return null
}

function mergeProviders(
  defaults: AppSettings['providers'],
  saved: AppSettings['providers']
): AppSettings['providers'] {
  const byId = new Map(saved.map((p) => [p.id, p]))
  const merged = defaults.map((d) => ({ ...d, ...byId.get(d.id) }))
  for (const extra of saved) {
    if (!merged.some((p) => p.id === extra.id)) merged.push(extra)
  }
  return merged
}

function packStoryline(clips: TimelineClip[]): void {
  packStorylineClips(clips)
}

function applyOp(project: Project, op: TimelineOp, clipSource: TimelineClip['source'] = 'ai'): void {
  const tl = project.timeline
  switch (op.op) {
    case 'add_clip': {
      const asset = project.assets.find((a) => a.id === op.assetId)
      if (!asset) throw new Error(`素材不存在: ${op.assetId}`)
      const inMs = op.inMs ?? 0
      const outMs = op.outMs ?? asset.durationMs
      const startMs = op.startMs ?? timelineDurationMs(tl)
      tl.storyline.push({
        id: id('clip'),
        assetId: asset.id,
        startMs,
        durationMs: Math.max(1, outMs - inMs),
        inMs,
        outMs,
        volume: 1,
        source: clipSource,
        fx: {}
      })
      break
    }
    case 'remove_clip': {
      tl.storyline = tl.storyline.filter((c) => c.id !== op.clipId)
      tl.overlays = tl.overlays.filter((c) => c.id !== op.clipId)
      tl.audio = tl.audio.filter((c) => c.id !== op.clipId)
      break
    }
    case 'trim_clip': {
      const clip = findClip(tl, op.clipId)
      if (!clip) throw new Error(`片段不存在: ${op.clipId}`)
      clip.inMs = Math.max(0, op.inMs)
      clip.outMs = Math.max(clip.inMs + 1, op.outMs)
      refreshDuration(clip)
      break
    }
    case 'split_clip': {
      const clip = findClip(tl, op.clipId)
      if (!clip) throw new Error(`片段不存在: ${op.clipId}`)
      const local = op.atMs - clip.startMs
      if (local <= 0 || local >= clip.durationMs) throw new Error('分割点不在片段内')
      const speed = Math.max(0.25, clipFx(clip).speed || 1)
      const srcDelta = local * speed
      const right: TimelineClip = {
        ...clip,
        id: id('clip'),
        startMs: clip.startMs + local,
        inMs: clip.inMs + srcDelta,
        fx: clip.fx ? { ...clip.fx } : {}
      }
      clip.outMs = clip.inMs + srcDelta
      refreshDuration(clip)
      right.outMs = right.outMs
      refreshDuration(right)
      const list = listOfClip(tl, clip.id)
      const idx = list.findIndex((c) => c.id === clip.id)
      list.splice(idx + 1, 0, right)
      break
    }
    case 'move_clip': {
      const clip = findClip(tl, op.clipId)
      if (!clip) throw new Error(`片段不存在: ${op.clipId}`)
      clip.startMs = Math.max(0, op.startMs)
      break
    }
    case 'reorder_storyline': {
      const map = new Map(tl.storyline.map((c) => [c.id, c]))
      const next: TimelineClip[] = []
      for (const cid of op.clipIds) {
        const clip = map.get(cid)
        if (clip) next.push(clip)
      }
      for (const clip of tl.storyline) {
        if (!op.clipIds.includes(clip.id)) next.push(clip)
      }
      tl.storyline = next
      break
    }
    case 'set_volume': {
      const clip = findClip(tl, op.clipId)
      if (!clip) throw new Error(`片段不存在: ${op.clipId}`)
      clip.volume = Math.min(2, Math.max(0, op.volume))
      break
    }
    case 'replace_storyline': {
      tl.storyline = op.clips
      break
    }
    case 'add_subtitle': {
      tl.subtitles.push({
        id: id('sub'),
        startMs: op.startMs,
        endMs: Math.max(op.startMs + 200, op.endMs),
        text: op.text,
        source: clipSource
      })
      tl.subtitles.sort((a, b) => a.startMs - b.startMs)
      break
    }
    case 'update_subtitle': {
      const cue = tl.subtitles.find((s) => s.id === op.id)
      if (!cue) throw new Error(`字幕不存在: ${op.id}`)
      if (op.startMs != null) cue.startMs = op.startMs
      if (op.endMs != null) cue.endMs = op.endMs
      if (op.text != null) cue.text = op.text
      break
    }
    case 'remove_subtitle': {
      tl.subtitles = tl.subtitles.filter((s) => s.id !== op.id)
      break
    }
    case 'replace_subtitles': {
      tl.subtitles = op.cues
      break
    }
    case 'clear_timeline': {
      project.timeline = emptyTimeline()
      break
    }
    case 'patch_clip': {
      const clip = findClip(tl, op.clipId)
      if (!clip) throw new Error(`片段不存在: ${op.clipId}`)
      if (op.volume != null) clip.volume = op.volume
      if (op.fx) {
        clip.fx = {
          ...clip.fx,
          ...op.fx,
          color: { ...clipFx(clip).color, ...op.fx.color },
          keys: op.fx.keys !== undefined ? op.fx.keys : clip.fx?.keys
        }
      }
      if (op.text) clip.text = { ...(clip.text ?? { text: '', font: 'PingFang SC', fontSize: 72, color: '#fff', stroke: '#000', strokeWidth: 3, align: 'center' }), ...op.text }
      if (op.blend) clip.blend = op.blend
      refreshDuration(clip)
      break
    }
    case 'add_overlay': {
      const asset = project.assets.find((a) => a.id === op.assetId)
      if (!asset) throw new Error(`素材不存在: ${op.assetId}`)
      const inMs = op.inMs ?? 0
      const outMs = op.outMs ?? Math.min(asset.durationMs, inMs + 3000)
      tl.overlays.push({
        id: id('clip'),
        assetId: asset.id,
        startMs: op.startMs,
        durationMs: Math.max(1, outMs - inMs),
        inMs,
        outMs,
        volume: 0,
        source: clipSource,
        fx: { opacity: 1, scale: 0.32, posX: 0.82, posY: 0.78 },
        kind: 'footage',
        blend: 'normal'
      })
      break
    }
    case 'add_layer': {
      const kind = op.kind ?? (op.assetId ? 'footage' : 'solid')
      const startMs = Math.max(0, op.startMs)
      const blend = op.blend ?? 'normal'
      if (kind === 'footage') {
        const asset = project.assets.find((a) => a.id === op.assetId)
        if (!asset) throw new Error(`素材不存在: ${op.assetId}`)
        const inMs = op.inMs ?? 0
        const outMs =
          op.outMs ??
          (op.durationMs != null ? inMs + op.durationMs : Math.min(asset.durationMs || inMs + 5000, inMs + 5000))
        tl.overlays.push({
          id: id('clip'),
          assetId: asset.id,
          startMs,
          durationMs: Math.max(1, outMs - inMs),
          inMs,
          outMs,
          volume: 0,
          source: clipSource,
          kind: 'footage',
          blend,
          fx: { opacity: 1, scale: 1, posX: 0.5, posY: 0.5, ...op.fx }
        })
      } else if (kind === 'adjustment') {
        const dur = Math.max(1, op.durationMs ?? Math.max(1000, timelineDurationMs(tl) - startMs || 5000))
        tl.overlays.push({
          id: id('clip'),
          assetId: '',
          startMs,
          durationMs: dur,
          inMs: 0,
          outMs: dur,
          volume: 0,
          source: clipSource,
          kind: 'adjustment',
          blend: 'normal',
          fx: { opacity: 1, ...op.fx }
        })
      } else if (kind === 'text') {
        const dur = Math.max(1, op.durationMs ?? 3000)
        tl.overlays.push({
          id: id('clip'),
          assetId: '',
          startMs,
          durationMs: dur,
          inMs: 0,
          outMs: dur,
          volume: 0,
          source: clipSource,
          kind: 'text',
          blend: 'normal',
          text: {
            text: '标题',
            font: 'PingFang SC',
            fontSize: 72,
            color: '#ffffff',
            stroke: '#000000',
            strokeWidth: 3,
            align: 'center',
            ...op.text
          },
          textAnim: op.textAnim,
          fx: { opacity: 1, scale: 1, posX: 0.5, posY: 0.5, ...op.fx }
        })
      } else if (kind === 'shape') {
        const dur = Math.max(1, op.durationMs ?? 3000)
        tl.overlays.push({
          id: id('clip'),
          assetId: '',
          startMs,
          durationMs: dur,
          inMs: 0,
          outMs: dur,
          volume: 0,
          source: clipSource,
          kind: 'shape',
          blend,
          shape: {
            shape: 'rect',
            fill: op.solidColor || '#e0a93a',
            width: 0.42,
            height: 0.22,
            ...op.shape
          },
          fx: { opacity: 1, scale: 1, posX: 0.5, posY: 0.5, ...op.fx }
        })
      } else {
        const dur = Math.max(1, op.durationMs ?? 5000)
        tl.overlays.push({
          id: id('clip'),
          assetId: '',
          startMs,
          durationMs: dur,
          inMs: 0,
          outMs: dur,
          volume: 0,
          source: clipSource,
          kind: 'solid',
          blend,
          solidColor: op.solidColor || '#000000',
          fx: { opacity: 1, scale: 1, posX: 0.5, posY: 0.5, ...op.fx }
        })
      }
      break
    }
    case 'add_audio': {
      const asset = project.assets.find((a) => a.id === op.assetId)
      if (!asset) throw new Error(`素材不存在: ${op.assetId}`)
      const ranged = op.inMs != null || op.outMs != null
      const inMs = Math.max(0, op.inMs ?? 0)
      const outMs = Math.min(asset.durationMs || Infinity, op.outMs ?? asset.durationMs)
      const dur = ranged ? Math.max(1, outMs - inMs) : Math.max(asset.durationMs, timelineDurationMs(tl) || asset.durationMs)
      tl.audio.push({
        id: id('clip'),
        assetId: asset.id,
        startMs: op.startMs ?? 0,
        durationMs: dur,
        inMs,
        outMs: ranged ? outMs : asset.durationMs,
        volume: op.volume ?? 0.35,
        source: clipSource,
        fx: { ...op.fx },
        role: op.role ?? 'music'
      })
      break
    }
  }
}

function refreshDuration(clip: TimelineClip): void {
  const speed = Math.max(0.25, clipFx(clip).speed || 1)
  clip.durationMs = Math.max(1, (clip.outMs - clip.inMs) / speed)
}

function migrateProject(p: Project): Project {
  p.subtitleStyle ??= { ...DEFAULT_SUBTITLE_STYLE }
  p.transcript ??= []
  p.markers ??= []
  p.timeline ??= emptyTimeline()
  p.timeline.overlays ??= []
  p.timeline.audio ??= []
  p.timeline.subtitles ??= []
  p.timeline.storyline ??= []
  p.timeline.duck ??= { enabled: false, ratio: 0.28 }
  p.settings ??= { ...DEFAULT_PROJECT_SETTINGS }
  p.settings.aspect ??= '16:9'
  return p
}

function findClip(tl: Timeline, clipId: string): TimelineClip | undefined {
  return (
    tl.storyline.find((c) => c.id === clipId) ??
    tl.overlays.find((c) => c.id === clipId) ??
    tl.audio.find((c) => c.id === clipId)
  )
}

function listOfClip(tl: Timeline, clipId: string): TimelineClip[] {
  if (tl.storyline.some((c) => c.id === clipId)) return tl.storyline
  if (tl.overlays.some((c) => c.id === clipId)) return tl.overlays
  return tl.audio
}

function summarizeOps(ops: TimelineOp[]): string {
  if (ops.length === 0) return '空操作'
  if (ops.length === 1) return opLabel(ops[0])
  const subs = ops.filter((o) => o.op.includes('subtitle')).length
  const clips = ops.length - subs
  const parts: string[] = []
  if (clips) parts.push(`${clips} 次画面剪辑`)
  if (subs) parts.push(`${subs} 次字幕`)
  return `AI 接管：${parts.join('，')}`
}

function opLabel(op: TimelineOp): string {
  switch (op.op) {
    case 'add_clip':
      return '加入一段素材'
    case 'remove_clip':
      return '删除一段'
    case 'trim_clip':
      return '修剪入出点'
    case 'split_clip':
      return '从中间切开'
    case 'move_clip':
      return '移动片段'
    case 'reorder_storyline':
      return '重排故事线'
    case 'set_volume':
      return '调整音量'
    case 'replace_storyline':
      return '重写故事线'
    case 'add_subtitle':
      return `加字幕：${op.text.slice(0, 24)}`
    case 'update_subtitle':
      return '改字幕'
    case 'remove_subtitle':
      return '删字幕'
    case 'replace_subtitles':
      return `重写字幕轨（${op.cues.length} 条）`
    case 'clear_timeline':
      return '清空时间线'
    case 'patch_clip':
      return '改片段属性'
    case 'add_overlay':
      return '叠加 B-roll'
    case 'add_layer':
      return op.kind === 'adjustment'
        ? '加调整层'
        : op.kind === 'solid'
          ? '加纯色层'
          : op.kind === 'text'
            ? '加文字层'
            : op.kind === 'shape'
              ? '加形状'
              : '叠加图层'
    case 'add_audio':
      return '加音频'
    case 'delete_asset':
      return '删除素材'
  }
}

function riskForOps(ops: TimelineOp[]): ReviewAction['risk'] {
  if (ops.some((o) => o.op === 'clear_timeline' || o.op === 'replace_storyline')) return 'high'
  if (ops.some((o) => o.op === 'remove_clip' || o.op === 'reorder_storyline' || o.op === 'delete_asset')) return 'medium'
  return 'low'
}
