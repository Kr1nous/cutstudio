import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { timelineDurationMs, type MediaAsset } from '../../shared/types'
import { store } from '../core'
import { findFfmpeg, runFfmpeg } from '../render/ffmpeg'
import { renderFrame } from '../render/frame'
import type { ToolSpec } from './providers'

/** 工具返回图片时的约定结构：MCP 转成 image content，CLI 写成文件。 */
export type VisionResult = {
  ok: true
  tool: string
  summary: string
  times: number[]
  images: { mime: 'image/jpeg'; data: string }[]
  files?: string[]
}

export function isVisionResult(v: unknown): v is VisionResult {
  return Boolean(v && typeof v === 'object' && Array.isArray((v as VisionResult).images))
}

export const VISION_TOOLS: ToolSpec[] = [
  {
    name: 'get_frame',
    description:
      '渲染成片在某一时刻的画面（变换、调色、文字层、叠加层，默认叠加字幕），返回图片。用来看构图、人物是否在竖屏画面内、文字是否遮挡。atMs 为时间线毫秒。传 assetId 时改为看素材本身（atMs = 素材内毫秒，不经过时间线），插 B-roll 前先确认素材拍的是什么。output="file" 时写 JPEG 文件并返回路径（终端里的 AI 用 Read 看图）。',
    parameters: {
      type: 'object',
      properties: {
        atMs: { type: 'number' },
        assetId: { type: 'string', description: '看素材本身而不是成片；atMs 为素材内时间' },
        width: { type: 'number', description: '输出宽度，默认 768，最大 1280' },
        output: { type: 'string', enum: ['image', 'file'] },
        subtitles: { type: 'boolean', description: '叠加字幕，默认 true（检查字幕遮挡 / 超宽）' }
      },
      required: ['atMs']
    }
  },
  {
    name: 'contact_sheet',
    description:
      '把时间线一段范围内均匀抽 count 帧拼成一张网格图（从左到右、从上到下，对应返回的 times）。用来检查成片有无黑帧和构图问题。默认整条时间线、12 帧。传 assetId 时改为对素材本身抽帧（startMs / endMs 为素材内时间，默认整条素材，不叠字幕），用来在插 B-roll 前浏览素材内容、挑 inMs。',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: '对素材本身抽帧（不经过时间线）；startMs / endMs 为素材内时间' },
        startMs: { type: 'number' },
        endMs: { type: 'number' },
        count: { type: 'number', description: '4–24，默认 12' },
        output: { type: 'string', enum: ['image', 'file'] },
        subtitles: { type: 'boolean', description: '叠加字幕，默认 true' }
      }
    }
  }
]

async function toJpeg(ffmpeg: string, input: string[], out: string, filter: string): Promise<void> {
  const r = await runFfmpeg(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', ...input, '-vf', filter, '-frames:v', '1', '-q:v', '5', out])
  if (r.code !== 0) throw new Error(`缩略图失败：${r.stderr.slice(-300)}`)
}

async function outputDir(): Promise<string> {
  const dir = join(tmpdir(), 'cutstudio-frames')
  await mkdir(dir, { recursive: true })
  return dir
}

/** 素材内均匀取 count 个时间点（格子中心）。 */
export function assetSampleTimes(durationMs: number, count: number, startMs = 0, endMs = durationMs): number[] {
  const lo = Math.max(0, Math.min(durationMs - 1, Math.round(startMs)))
  const hi = Math.max(lo + 1, Math.min(durationMs, Math.round(endMs)))
  return Array.from({ length: count }, (_, i) => Math.min(durationMs - 1, Math.round(lo + ((hi - lo) * (i + 0.5)) / count)))
}

/** 直接从素材文件取帧（不经过时间线：没有变换、调色、字幕）。 */
async function runAssetVision(ffmpeg: string, name: string, args: Record<string, unknown>, asset: MediaAsset, work: string): Promise<{ times: number[]; jpg: string }> {
  const jpg = join(work, 'out.jpg')
  const still = asset.kind === 'image'
  const dur = still ? 1 : Math.max(1, asset.durationMs)
  const width = Math.min(1280, Math.max(160, Number(args.width) || 768))
  // 素材最后一帧之后 seek 会取不到帧：先退到最后一帧以内，还失败再往前退 500ms
  const lastFrame = Math.max(0, dur - Math.ceil(1000 / (asset.fps || 30)))
  const grab = async (t: number, out: string, scale: string): Promise<number> => {
    if (still) {
      await toJpeg(ffmpeg, ['-i', asset.path], out, scale)
      return 0
    }
    const at = Math.min(lastFrame, t)
    try {
      await toJpeg(ffmpeg, ['-ss', (at / 1000).toFixed(3), '-i', asset.path], out, scale)
      return at
    } catch (e) {
      if (at < 1) throw e
      const back = Math.max(0, at - 500)
      await toJpeg(ffmpeg, ['-ss', (back / 1000).toFixed(3), '-i', asset.path], out, scale)
      return back
    }
  }
  if (name === 'get_frame') {
    const t = still ? 0 : Math.max(0, Math.min(dur - 1, Math.round(Number(args.atMs ?? 0))))
    return { times: [await grab(t, jpg, `scale='min(${width},iw)':-2`)], jpg }
  }
  const count = Math.min(24, Math.max(4, Math.round(Number(args.count) || 12)))
  const times = still ? [0] : assetSampleTimes(dur, count, Number(args.startMs ?? 0), args.endMs != null ? Number(args.endMs) : dur)
  const vertical = asset.height > asset.width
  const cell = vertical ? 'scale=-2:320' : 'scale=320:-2'
  for (let i = 0; i < times.length; i++) times[i] = await grab(times[i]!, join(work, `f${String(i).padStart(2, '0')}.jpg`), cell)
  const cols = times.length <= 6 ? 3 : 4
  const rows = Math.ceil(times.length / cols)
  await toJpeg(ffmpeg, ['-framerate', '1', '-i', join(work, 'f%02d.jpg')], jpg, `tile=${cols}x${rows}:padding=4:color=white`)
  return { times, jpg }
}

export async function runVisionTool(name: string, args: Record<string, unknown>): Promise<VisionResult> {
  const project = store.requireProject()
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) throw new Error('本机没有 ffmpeg')
  if (name !== 'get_frame' && name !== 'contact_sheet') throw new Error(`未知视觉工具: ${name}`)
  if (typeof args.assetId === 'string' && args.assetId) {
    const asset = project.assets.find((a) => a.id === args.assetId)
    if (!asset) throw new Error(`素材不存在: ${args.assetId}。可选：${project.assets.filter((a) => a.kind !== 'audio').map((a) => `${a.id}(${a.name})`).join('、')}`)
    if (asset.kind !== 'video' && asset.kind !== 'image') throw new Error(`${asset.name} 是音频，没有画面`)
    const work = await mkdtemp(join(tmpdir(), 'cs-vision-'))
    try {
      const { times, jpg } = await runAssetVision(ffmpeg, name, args, asset, work)
      const label = asset.kind === 'image' ? `${asset.name}（图片）` : `${asset.name}（素材内 ${times.join(', ')}ms）`
      return finishVision(name, name === 'get_frame' ? `素材 ${label}` : `素材 ${times.length} 帧网格：${label}`, times, jpg, args)
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }
  const total = timelineDurationMs(project.timeline)
  if (total <= 0) throw new Error('时间线是空的（要看素材内容请传 assetId）')
  const clampT = (t: number) => Math.max(0, Math.min(total - 1, Math.round(t)))
  const work = await mkdtemp(join(tmpdir(), 'cs-vision-'))
  try {
    let times: number[]
    const jpg = join(work, 'out.jpg')
    if (name === 'get_frame') {
      const t = clampT(Number(args.atMs ?? 0))
      const width = Math.min(1280, Math.max(160, Number(args.width) || 768))
      const png = join(work, 'f.png')
      await writeFile(png, await renderFrame(project, t, '1080p', { subtitles: args.subtitles !== false }))
      await toJpeg(ffmpeg, ['-i', png], jpg, `scale='min(${width},iw)':-2`)
      times = [t]
    } else if (name === 'contact_sheet') {
      const start = clampT(Number(args.startMs ?? 0))
      const end = Math.max(start + 1, clampT(Number(args.endMs ?? total)))
      const count = Math.min(24, Math.max(4, Math.round(Number(args.count) || 12)))
      times = Array.from({ length: count }, (_, i) => clampT(start + ((end - start) * (i + 0.5)) / count))
      for (let i = 0; i < times.length; i++) {
        await writeFile(join(work, `f${String(i).padStart(2, '0')}.png`), await renderFrame(project, times[i], '1080p', { subtitles: args.subtitles !== false }))
      }
      const cols = count <= 6 ? 3 : 4
      const rows = Math.ceil(count / cols)
      const vertical = project.settings.height > project.settings.width
      const cell = vertical ? 'scale=-2:320' : 'scale=320:-2'
      await toJpeg(
        ffmpeg,
        ['-framerate', '1', '-i', join(work, 'f%02d.png')],
        jpg,
        `${cell},tile=${cols}x${rows}:padding=4:color=white`
      )
    } else {
      throw new Error(`未知视觉工具: ${name}`)
    }
    return await finishVision(name, name === 'get_frame' ? `${times[0]}ms 的画面` : `${times.length} 帧网格：${times.join(', ')}ms`, times, jpg, args)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function finishVision(name: string, summary: string, times: number[], jpg: string, args: Record<string, unknown>): Promise<VisionResult> {
  const data = (await readFile(jpg)).toString('base64')
  const result: VisionResult = { ok: true, tool: name, summary, times, images: [{ mime: 'image/jpeg', data }] }
  if (args.output === 'file') {
    const dir = await outputDir()
    const file = join(dir, `${name}-${Date.now()}.jpg`)
    await writeFile(file, Buffer.from(data, 'base64'))
    result.files = [file]
    result.images = []
  }
  return result
}
