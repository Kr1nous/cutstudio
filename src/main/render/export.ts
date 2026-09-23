import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { even } from '../../shared/compose'
import { VOICE_FILTERS } from '../../shared/voice'
import { id, nowIso } from '../../shared/ids'
import {
  type ExportOptions,
  type ExportPreset,
  type ExportProgress,
  type MediaAsset,
  type Project,
  type RenderJob,
  timelineDurationMs
} from '../../shared/types'
import { store } from '../core'
import { ffmpegHasFilter, findFfmpeg, findFfprobe, probeHasAudio, probeHasVideo, runFfmpeg } from './ffmpeg'
import { buildGraph, canvasSize, writeAss, type StreamInfo } from './graph'
import { bakeTextLayers } from './textpng'

export const EXPORT_PRESETS: ExportPreset[] = ['1080p', '4k', 'shorts', 'alpha', 'prores']

export function normalizePreset(raw: string): ExportPreset {
  return EXPORT_PRESETS.includes(raw as ExportPreset) ? (raw as ExportPreset) : '1080p'
}

export function exportExt(preset: string): 'mp4' | 'mov' {
  return preset === 'alpha' || preset === 'prores' ? 'mov' : 'mp4'
}

export function videoEncodeArgs(preset: string): string[] {
  if (preset === 'alpha') return ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le']
  if (preset === 'prores') return ['-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le']
  return ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']
}

export function evenHalf(n: number): number {
  const h = Math.round((n || 2) / 2)
  return h % 2 === 0 ? Math.max(2, h) : Math.max(2, h + 1)
}

export async function collectStreams(
  ffprobe: string,
  project: Project
): Promise<Map<string, StreamInfo>> {
  const map = new Map<string, StreamInfo>()
  const paths = new Set<string>()
  for (const clip of [...project.timeline.storyline, ...project.timeline.overlays, ...project.timeline.audio]) {
    const asset = project.assets.find((a) => a.id === clip.assetId)
    if (asset?.path) paths.add(asset.path)
  }
  for (const path of paths) {
    const [hasVideo, hasAudio] = await Promise.all([probeHasVideo(ffprobe, path), probeHasAudio(ffprobe, path)])
    map.set(path, { hasVideo, hasAudio })
  }
  return map
}

/** renderTimeline 的覆盖项：render_preview 用低清尺寸和快速编码；导出对话框用区间、字幕方式、进度和取消。 */
export type RenderOverrides = {
  size?: { width: number; height: number }
  encode?: string[]
  rangeMs?: { startMs: number; endMs: number }
  subtitles?: 'burn' | 'srt' | 'none'
  onProgress?: (ratio: number) => void
  signal?: AbortSignal
}

/** 解析 ffmpeg -progress 输出，返回已编码到的毫秒（结束时返回 Infinity）；这一段没有进度信息返回 null。 */
export function parseProgress(chunk: string): number | null {
  if (/^progress=end\s*$/m.test(chunk)) return Infinity
  let ms: number | null = null
  for (const m of chunk.matchAll(/^out_time_(?:us|ms)=(\d+)\s*$/gm)) ms = Number(m[1]) / 1000
  return ms
}

/** 工程里有片段开了人声增强时，查一下本机 ffmpeg 有哪些相关滤镜（没有的跳过）。 */
async function voiceFilterSet(ffmpeg: string, project: Project): Promise<Set<string> | undefined> {
  const clips = [...project.timeline.storyline, ...project.timeline.audio]
  if (!clips.some((c) => c.fx?.voice?.preset)) return undefined
  const have = new Set<string>()
  for (const f of VOICE_FILTERS) if (await ffmpegHasFilter(ffmpeg, f)) have.add(f)
  const missing = VOICE_FILTERS.filter((f) => !have.has(f))
  if (missing.length) lastRenderWarnings.push(`本机 ffmpeg 缺少 ${missing.join(' / ')}，人声增强跳过了这些滤镜。`)
  return have
}

export async function renderTimeline(project: Project, outPath: string, preset = '1080p', overrides: RenderOverrides = {}): Promise<void> {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) throw new Error('本机没有 ffmpeg。安装后再导出，或先用预览窗审查成片。')
  if (project.timeline.storyline.length === 0 && project.timeline.overlays.length === 0) {
    throw new Error('时间线是空的')
  }
  const ffprobe = await findFfprobe(ffmpeg)
  const size = canvasSize(project.settings, preset)
  const width = even(overrides.size?.width ?? size.width)
  const height = even(overrides.size?.height ?? size.height)
  const exportDir = join(outPath, '..')
  await mkdir(exportDir, { recursive: true })
  lastRenderWarnings = []
  const range = overrides.rangeMs && overrides.rangeMs.endMs > overrides.rangeMs.startMs ? overrides.rangeMs : null
  const subMode = overrides.subtitles ?? 'burn'
  const subs = project.timeline.subtitles
  const canBurn = await ffmpegHasFilter(ffmpeg, 'ass')
  const assPath = canBurn && subMode === 'burn' ? await writeAss(project, exportDir, width, height) : null
  let softSrt: string | null = null
  if (subMode === 'srt' && subs.length) {
    const srtPath = outPath.replace(/\.[^.]+$/, '') + '.srt'
    const shift = range?.startMs ?? 0
    const cues = subs
      .filter((c) => !range || (c.endMs > range.startMs && c.startMs < range.endMs))
      .map((c) => ({
        text: c.text,
        startMs: Math.max(0, c.startMs - shift),
        endMs: Math.min(range ? range.endMs - shift : Infinity, c.endMs - shift)
      }))
    await writeFile(srtPath, srtText(cues), 'utf8')
    lastRenderWarnings.push(`字幕另存为 ${srtPath}`)
  }
  if (subMode === 'burn' && subs.length && !canBurn) {
    // 本机 ffmpeg 没有 libass：字幕改为软字幕轨 + 同名 .srt，而不是整个导出失败。
    softSrt = outPath.replace(/\.[^.]+$/, '') + '.srt'
    await writeFile(softSrt, srtText(subs), 'utf8')
    lastRenderWarnings.push(
      `本机 ffmpeg 不支持烧录字幕（缺 libass），字幕以软字幕轨写入并另存 ${softSrt}。要把字幕烧进画面，请安装带 libass 的 ffmpeg。`
    )
  }
  const bakedText = await bakeTextLayers(project.timeline.overlays, exportDir, width, height, size.fps)
  const streams = await collectStreams(ffprobe, project)
  const graph = buildGraph(project, {
    width,
    height,
    fps: size.fps,
    alpha: size.alpha,
    streams,
    assPath,
    bakedText,
    filters: await voiceFilterSet(ffmpeg, project)
  })

  const args: string[] = ['-y', '-hide_banner']
  for (const input of graph.inputs) {
    args.push(...input.args, '-i', input.path)
  }
  if (softSrt) args.push('-i', softSrt)
  args.push('-filter_complex', graph.filter, '-map', graph.videoMap)
  if (graph.audioMap) args.push('-map', graph.audioMap)
  else args.push('-an')
  if (softSrt) args.push('-map', `${graph.inputs.length}:s`)

  args.push(...(overrides.encode ?? videoEncodeArgs(preset)))
  if (graph.audioMap) args.push('-c:a', 'aac', '-b:a', '192k')
  if (softSrt) args.push('-c:s', 'mov_text')
  // 区间在输出端裁（滤镜图之后），字幕 / 转场的时间仍按整条时间线算
  const startMs = range ? Math.max(0, range.startMs) : 0
  const endMs = range ? Math.min(graph.durationMs, range.endMs) : graph.durationMs
  if (endMs <= startMs) throw new Error('导出区间是空的')
  if (startMs > 0) args.push('-ss', (startMs / 1000).toFixed(3))
  args.push('-t', ((endMs - startMs) / 1000).toFixed(3))
  if (overrides.onProgress) args.push('-progress', 'pipe:1', '-nostats')
  args.push(outPath)

  const total = endMs - startMs
  const run = (a: string[]) =>
    runFfmpeg(ffmpeg, a, {
      signal: overrides.signal,
      onStdout: overrides.onProgress
        ? (text) => {
            const ms = parseProgress(text)
            if (ms == null) return
            // 输出端 -ss 时 out_time 从 0 开始；个别版本从区间起点算，统一折算
            const done = ms === Infinity ? total : ms > total + 500 ? ms - startMs : ms
            overrides.onProgress!(Math.max(0, Math.min(1, done / total)))
          }
        : undefined
    }).catch((e: unknown) => {
      if (overrides.signal?.aborted) throw new Error('已取消导出')
      throw e
    })
  let result = await run(args)
  if (overrides.signal?.aborted) throw new Error('已取消导出')
  if (result.code !== 0 && (preset === 'alpha' || size.alpha)) {
    const fallback = args
      .map((a) => (a === 'prores_ks' ? 'qtrle' : a === 'yuva444p10le' ? 'argb' : a))
      .filter((a) => a !== '-profile:v' && a !== '4444')
    result = await run(fallback)
  } else if (result.code !== 0 && preset === 'prores') {
    const fallback = args.map((a) => (a === 'prores_ks' ? 'prores' : a)).filter((a) => a !== '-profile:v' && a !== '3')
    result = await run(fallback)
  }
  if (overrides.signal?.aborted) throw new Error('已取消导出')
  if (result.code !== 0) throw new Error(result.stderr.slice(-1200) || '导出失败')
}

/** 最近一次 renderTimeline 的提醒（导出工具会转给 AI / 界面）。 */
export let lastRenderWarnings: string[] = []

export function srtText(subs: { startMs: number; endMs: number; text: string }[]): string {
  const fmt = (ms: number) => {
    const t = Math.max(0, Math.round(ms))
    const h = Math.floor(t / 3600000)
    const m = Math.floor((t % 3600000) / 60000)
    const s = Math.floor((t % 60000) / 1000)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(t % 1000).padStart(3, '0')}`
  }
  return subs.map((c, i) => `${i + 1}\n${fmt(c.startMs)} --> ${fmt(c.endMs)}\n${c.text}\n`).join('\n')
}

let currentExport: AbortController | null = null

/** 取消正在进行的导出；没有导出时返回 false。 */
export function cancelExport(): boolean {
  if (!currentExport) return false
  currentExport.abort()
  return true
}

/** 导出成片。进度经 export-progress 事件推给界面（CLI / MCP / 渲染队列发起的导出也一样）。 */
export async function exportTimeline(preset = '1080p', fileHint?: string, opts: ExportOptions = {}): Promise<string> {
  const project = store.requireProject()
  if (!store.projectPath) throw new Error('项目路径丢失')
  if (currentExport) throw new Error('已有导出在进行，等它完成或先取消')
  const kind = normalizePreset(opts.preset ?? preset)
  const ext = exportExt(kind)
  const out = opts.outPath
    ? opts.outPath.replace(/\.(mp4|mov|m4v)$/i, '') + '.' + ext
    : join(store.projectPath, 'export', `${fileHint || Date.now()}.${ext}`)
  const ctrl = new AbortController()
  currentExport = ctrl
  const jobId = id('exp')
  let last = 0
  const report = (p: Omit<ExportProgress, 'id' | 'preset'>) => store.emitEvent('export-progress', { id: jobId, preset: kind, ...p })
  report({ status: 'running', ratio: 0 })
  try {
    await renderTimeline(project, out, kind, {
      rangeMs: opts.rangeMs,
      subtitles: opts.subtitles,
      signal: ctrl.signal,
      onProgress: (ratio) => {
        const now = Date.now()
        if (now - last < 200 && ratio < 1) return
        last = now
        report({ status: 'running', ratio })
      }
    })
  } catch (e) {
    const cancelled = ctrl.signal.aborted
    report({ status: cancelled ? 'cancelled' : 'error', ratio: 0, error: cancelled ? '已取消导出' : e instanceof Error ? e.message : String(e) })
    throw cancelled ? new Error('已取消导出') : e
  } finally {
    currentExport = null
  }
  const seconds = Math.round(((opts.rangeMs ? opts.rangeMs.endMs - opts.rangeMs.startMs : timelineDurationMs(project.timeline))) / 1000)
  store.log({
    tool: 'export',
    summary: `导出 ${seconds} 秒${opts.rangeMs ? '片段' : '成片'}（${kind}）`,
    risk: 'low',
    source: 'human',
    reversible: false
  })
  await store.save()
  store.broadcast()
  report({ status: 'done', ratio: 1, path: out, warnings: [...lastRenderWarnings] })
  return out
}

export async function writeProxyFile(
  ffmpeg: string,
  src: string,
  dest: string,
  srcW: number,
  srcH: number,
  image = false
): Promise<{ width: number; height: number }> {
  const width = evenHalf(srcW || 640)
  const height = evenHalf(srcH || 360)
  const scale = `scale=${width}:${height}:flags=fast_bilinear`
  const r = image
    ? await runFfmpeg(ffmpeg, ['-y', '-i', src, '-vf', scale, '-q:v', '6', dest])
    : await runFfmpeg(ffmpeg, [
        '-y',
        '-i',
        src,
        '-vf',
        scale,
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
        '-an',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        dest
      ])
  if (r.code !== 0) throw new Error(r.stderr.slice(-400) || '代理失败')
  return { width, height }
}

export async function makeProxy(assetId?: string): Promise<MediaAsset[]> {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) throw new Error('本机没有 ffmpeg')
  const ffprobe = await findFfprobe(ffmpeg)
  const project = store.requireProject()
  if (!store.projectPath) throw new Error('项目路径丢失')
  const dir = join(store.projectPath, 'proxies')
  await mkdir(dir, { recursive: true })
  const targets = project.assets.filter((a) => {
    if (a.kind === 'audio') return false
    return assetId ? a.id === assetId : true
  })
  if (!targets.length) throw new Error('没有可做代理的视频或图片')
  for (const asset of targets) {
    let w = asset.width
    let h = asset.height
    if (!w || !h) {
      const probe = await runFfmpeg(ffprobe, [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=p=0',
        asset.path
      ])
      const [pw, ph] = probe.stdout.toString().trim().split(',').map(Number)
      w = pw || 640
      h = ph || 360
    }
    const image = asset.kind === 'image'
    const dest = join(dir, image ? `${asset.id}.jpg` : `${asset.id}.mp4`)
    const size = await writeProxyFile(ffmpeg, asset.path, dest, w, h, image)
    asset.proxyPath = dest
    asset.proxyWidth = size.width
    asset.proxyHeight = size.height
  }
  store.log({
    tool: 'make_proxy',
    summary: `生成 ${targets.length} 个半分辨率代理`,
    risk: 'low',
    source: 'human',
    reversible: false
  })
  await store.save()
  store.broadcast()
  return targets
}

let drainLock: Promise<void> | null = null

export async function addRenderJob(preset = '1080p'): Promise<RenderJob> {
  const project = store.requireProject()
  project.renderQueue ??= []
  const job: RenderJob = {
    id: id('job'),
    preset: normalizePreset(preset),
    status: 'queued',
    createdAt: nowIso()
  }
  project.renderQueue.push(job)
  await store.save()
  store.broadcast()
  await drainRenderQueue()
  return job
}

export async function drainRenderQueue(): Promise<void> {
  if (drainLock) {
    await drainLock
    return
  }
  drainLock = (async () => {
    while (store.project) {
      const job = (store.project.renderQueue ?? []).find((j) => j.status === 'queued')
      if (!job) break
      job.status = 'running'
      store.broadcast()
      try {
        job.path = await exportTimeline(job.preset, job.id)
        job.status = 'done'
      } catch (e) {
        job.status = 'error'
        job.error = e instanceof Error ? e.message : String(e)
      }
      await store.save()
      store.broadcast()
    }
  })().finally(() => {
    drainLock = null
  })
  await drainLock
}
