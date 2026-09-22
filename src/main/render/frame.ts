import { fxAt } from '../../shared/anim'
import { even, ffmpegBlendMode, layersAt } from '../../shared/compose'
import { glowSigma, hasGlow, simpleEffectFfmpeg } from '../../shared/effects'
import { videoFilterFfmpeg } from '../../shared/fx'
import { keyFfmpeg } from '../../shared/key'
import { layerBox, maskFfmpeg } from '../../shared/mask'
import { visibleText } from '../../shared/text'
import type { Project } from '../../shared/types'
import { findFfmpeg, findFfprobe, runFfmpeg } from './ffmpeg'
import { canvasSize } from './graph'
import { collectStreams } from './export'
import { bakeSubtitleFrame, bakeTextFrame } from './textpng'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function chain(parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(',')
}

function ffColor(hex: string): string {
  const h = (hex || '#000000').replace('#', '')
  if (/^[0-9a-fA-F]{6}$/.test(h)) return `0x${h.toUpperCase()}`
  return '0x000000'
}

export type RenderFrameOptions = {
  /** 叠加该时刻的字幕（按 subtitleStyle 绘制，近似导出的 ASS 效果）。默认 false。 */
  subtitles?: boolean
}

export async function renderFrame(project: Project, timeMs: number, preset = '1080p', opts: RenderFrameOptions = {}): Promise<Buffer> {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) throw new Error('本机没有 ffmpeg')
  const ffprobe = await findFfprobe(ffmpeg)
  const size = canvasSize(project.settings, preset === 'alpha' ? 'alpha' : preset)
  const width = even(size.width)
  const height = even(size.height)
  const fps = size.fps
  const layers = layersAt(project.timeline, timeMs)
  const streams = await collectStreams(ffprobe, project)
  const bg = size.alpha ? '0x00000000' : 'black'

  const args: string[] = ['-y', '-hide_banner']
  const filters: string[] = [`color=c=${bg}:s=${width}x${height}:d=0.04:r=${fps},format=rgba[base]`]
  let last = 'base'
  let inputIndex = 0
  let step = 0

  for (const layer of layers) {
    const fx = fxAt(layer.clip, timeMs)
    const next = `b${step++}`
    if (layer.kind === 'adjustment') {
      const filt = chain([
        ...videoFilterFfmpeg(fx),
        ...simpleEffectFfmpeg(fx),
        layer.opacity < 0.999 ? `colorchannelmixer=aa=${layer.opacity.toFixed(3)}` : null
      ])
      if (!filt) continue
      filters.push(`[${last}]split=2[ak${step}][as${step}]`)
      filters.push(`[as${step}]${filt}[af${step}]`)
      filters.push(`[ak${step}][af${step}]overlay=0:0[${next}]`)
      last = next
      continue
    }

    const srcW = project.assets.find((a) => a.id === layer.clip.assetId)?.width || 0
    const srcH = project.assets.find((a) => a.id === layer.clip.assetId)?.height || 0
    const box = layerBox(fx, width, height, srcW, srcH)
    const boxW = even(box.w)
    const boxH = even(box.h)
    const x = Math.round(box.x)
    const y = Math.round(box.y)
    const blend = layer.track === 'overlay' ? ffmpegBlendMode(layer.blend) : null
    let fg = `fg${step}`

    if (layer.kind === 'text') {
      const vis = visibleText(layer.clip, timeMs)
      if (!vis) continue
      const png = join(tmpdir(), `cut-text-${layer.clip.id}.png`)
      await bakeTextFrame(layer.clip, width, height, timeMs, png)
      args.push('-loop', '1', '-t', '0.04', '-i', png)
      const idx = inputIndex++
      filters.push(`[${idx}:v]format=rgba[${fg}]`)
    } else if (layer.kind === 'shape') {
      const sh = layer.clip.shape ?? { shape: 'rect' as const, fill: '#e0a93a', width: 0.42, height: 0.22 }
      const bw = even(width * (sh.width || 0.42) * (fx.scale || 1))
      const bh = even(height * (sh.height || 0.22) * (fx.scale || 1))
      const color = ffColor(sh.fill || '#e0a93a')
      const ellipse =
        sh.shape === 'ellipse'
          ? `,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='if(lte(hypot((X-W/2)/(max(W/2\\,1))\\,(Y-H/2)/(max(H/2\\,1)))\\,1)\\,255\\,0)'`
          : ''
      const sprite = `sp${step}`
      filters.push(`color=c=${color}:s=${bw}x${bh}:d=0.04:r=${fps},format=rgba${ellipse}[${sprite}]`)
      filters.push(`color=c=0x00000000:s=${width}x${height}:d=0.04:r=${fps},format=rgba[bg${step}]`)
      const ox = Math.round(fx.posX * width - bw / 2)
      const oy = Math.round(fx.posY * height - bh / 2)
      filters.push(`[bg${step}][${sprite}]overlay=${ox}:${oy}:format=auto[${fg}]`)
    } else if (layer.kind === 'solid') {
      const color = ffColor(layer.clip.solidColor || '#000000')
      filters.push(
        `color=c=${color}:s=${boxW}x${boxH}:d=0.04:r=${fps},format=rgba${
          !blend && layer.opacity < 0.999 ? `,colorchannelmixer=aa=${layer.opacity.toFixed(3)}` : ''
        }[${fg}]`
      )
    } else {
      const asset = project.assets.find((a) => a.id === layer.clip.assetId)
      if (!asset) continue
      const info = streams.get(asset.path)
      const hasVideo = asset.kind === 'image' || (info?.hasVideo ?? asset.kind === 'video')
      if (!hasVideo) continue
      const srcT = Math.max(0, layer.sourceTimeMs / 1000)
      if (asset.kind === 'image') args.push('-loop', '1', '-t', '0.04')
      else args.push('-ss', srcT.toFixed(3))
      args.push('-i', asset.path)
      const idx = inputIndex++
      const crop = fx.crop
        ? `crop=iw*${fx.crop.w}:ih*${fx.crop.h}:iw*${fx.crop.x}:ih*${fx.crop.y}`
        : null
      const rot =
        fx.rotate === 90
          ? 'transpose=clock'
          : fx.rotate === 180
            ? 'transpose=clock,transpose=clock'
            : fx.rotate === 270
              ? 'transpose=cclock'
              : null
      filters.push(
        `[${idx}:v]${chain([
          // -ss 之后首帧时间戳不一定是 0，和 0.04 秒底色 overlay 时会先吐出一帧纯黑。
          'setpts=PTS-STARTPTS',
          'format=rgba',
          crop,
          rot,
          fx.flipX ? 'hflip' : null,
          fx.flipY ? 'vflip' : null,
          ...videoFilterFfmpeg(fx),
          ...simpleEffectFfmpeg(fx),
          ...keyFfmpeg(fx),
          hasGlow(fx) ? `gblur=sigma=${glowSigma(fx).toFixed(2)}` : null,
          `scale=${boxW}:${boxH}`,
          !blend && layer.opacity < 0.999 ? `colorchannelmixer=aa=${layer.opacity.toFixed(3)}` : null
        ])}[${fg}]`
      )
    }

    const full = layer.kind === 'text' || layer.kind === 'shape'
    const mf = maskFfmpeg(fx)
    if (mf && !full) {
      const masked = `fm${step}`
      filters.push(`[${fg}]${mf}[${masked}]`)
      fg = masked
    }
    if (!blend && layer.opacity < 0.999 && (layer.kind === 'text' || layer.kind === 'shape')) {
      const opa = `opa${step}`
      filters.push(`[${fg}]format=rgba,colorchannelmixer=aa=${layer.opacity.toFixed(3)}[${opa}]`)
      fg = opa
    }

    const ox = full ? 0 : x
    const oy = full ? 0 : y
    if (blend) {
      const pad = `p${step}`
      filters.push(`color=c=0x00000000:s=${width}x${height}:d=0.04:r=${fps},format=rgba[bg${step}]`)
      filters.push(`[bg${step}][${fg}]overlay=${ox}:${oy}:format=auto[${pad}]`)
      filters.push(`[${last}][${pad}]blend=all_mode=${blend}:all_opacity=${layer.opacity.toFixed(3)}[${next}]`)
    } else {
      filters.push(`[${last}][${fg}]overlay=${ox}:${oy}:format=auto[${next}]`)
    }
    last = next
  }

  if (opts.subtitles) {
    const png = join(tmpdir(), `cut-sub-${process.pid}-${Math.round(timeMs)}.png`)
    if (await bakeSubtitleFrame(project, width, height, timeMs, png)) {
      args.push('-loop', '1', '-t', '0.04', '-i', png)
      const idx = inputIndex++
      filters.push(`[${idx}:v]format=rgba[subs]`)
      filters.push(`[${last}][subs]overlay=0:0:format=auto[withsubs]`)
      last = 'withsubs'
    }
  }
  filters.push(`[${last}]format=rgba[vout]`)
  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-frames:v', '1', '-f', 'image2', '-c:v', 'png', 'pipe:1')

  const result = await runFfmpeg(ffmpeg, args)
  if (result.code !== 0 || result.stdout.length < 32) {
    throw new Error(result.stderr.slice(-800) || '合成帧失败')
  }
  return result.stdout
}
