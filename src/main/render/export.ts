import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { even } from '../../shared/compose'
import { VOICE_FILTERS } from '../../shared/voice'
import { id, nowIso } from '../../shared/ids'
import {
  type ExportPreset,
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

/** renderTimeline 的覆盖项：render_preview 用低清尺寸和快速编码。 */
export type RenderOverrides = { size?: { width: number; height: number }; encode?: string[] }

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
  const subs = project.timeline.subtitles
  const canBurn = await ffmpegHasFilter(ffmpeg, 'ass')
  const assPath = canBurn ? await writeAss(project, exportDir, width, height) : null
  let softSrt: string | null = null
  if (subs.length && !canBurn) {
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
  args.push('-t', (graph.durationMs / 1000).toFixed(3), outPath)

  let result = await runFfmpeg(ffmpeg, args)
  if (result.code !== 0 && (preset === 'alpha' || size.alpha)) {
    const fallback = args
      .map((a) => (a === 'prores_ks' ? 'qtrle' : a === 'yuva444p10le' ? 'argb' : a))
      .filter((a) => a !== '-profile:v' && a !== '4444')
    result = await runFfmpeg(ffmpeg, fallback)
  } else if (result.code !== 0 && preset === 'prores') {
    const fallback = args.map((a) => (a === 'prores_ks' ? 'prores' : a)).filter((a) => a !== '-profile:v' && a !== '3')
    result = await runFfmpeg(ffmpeg, fallback)
  }
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

export async function exportTimeline(preset = '1080p', fileHint?: string): Promise<string> {
  const project = store.requireProject()
  if (!store.projectPath) throw new Error('项目路径丢失')
  const kind = normalizePreset(preset)
  const ext = exportExt(kind)
  const out = join(store.projectPath, 'export', `${fileHint || Date.now()}.${ext}`)
  await renderTimeline(project, out, kind)
  store.log({
    tool: 'export',
    summary: `导出 ${Math.round(timelineDurationMs(project.timeline) / 1000)} 秒成片（${kind}）`,
    risk: 'low',
    source: 'human',
    reversible: false
  })
  await store.save()
  store.broadcast()
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
