import { writeFile } from 'node:fs/promises'
import { textScale } from '../../shared/text'
import { join } from 'node:path'
import { ffmpegInterp, hasAnim } from '../../shared/anim'
import { even, dissolveOverlapMs, ffmpegBlendMode } from '../../shared/compose'
import { glowSigma, hasGlow, simpleEffectFfmpeg, xfadeName } from '../../shared/effects'
import { audioGlowFfmpeg, denoiseFfmpeg, volumeFilter } from '../../shared/audio'
import { voiceFfmpeg } from '../../shared/voice'
import { videoFilterFfmpeg } from '../../shared/fx'
import { keyFfmpeg, stabilizeFfmpeg } from '../../shared/key'
import { axisScale, maskFfmpeg } from '../../shared/mask'
import { DEFAULT_BOX_COLOR, DEFAULT_BOX_OPACITY, DEFAULT_HIGHLIGHT, assAlpha, karaokeLines, keywordRuns, subtitlePreset, wrapSubtitleText } from '../../shared/subtitle'
import {
  type MediaAsset,
  type Project,
  type ProjectSettings,
  type SubtitleCue,
  type SubtitleStyle,
  type TimelineClip,
  clipBlend,
  clipFx,
  clipKind,
  timelineDurationMs
} from '../../shared/types'

export type { ExportPreset } from '../../shared/types'

export type GraphInput = {
  args: string[]
  path: string
}

export type FilterGraph = {
  inputs: GraphInput[]
  filter: string
  videoMap: string
  audioMap: string | null
  durationMs: number
  width: number
  height: number
  fps: number
  alpha: boolean
  assPath?: string
}

export function canvasSize(
  settings: ProjectSettings,
  preset: string
): { width: number; height: number; fps: number; alpha: boolean } {
  const aspect = settings.aspect ?? '16:9'
  const alpha = preset === 'alpha'
  const fps = settings.fps || 30
  if (preset === '4k') {
    if (aspect === '9:16') return { width: 2160, height: 3840, fps, alpha }
    if (aspect === '1:1') return { width: 2160, height: 2160, fps, alpha }
    return { width: 3840, height: 2160, fps, alpha }
  }
  if (preset === 'shorts' || (preset !== 'alpha' && aspect === '9:16')) {
    return { width: 1080, height: 1920, fps, alpha }
  }
  if (preset !== 'alpha' && aspect === '1:1') return { width: 1080, height: 1080, fps, alpha }
  return {
    width: even(settings.width || 1920),
    height: even(settings.height || 1080),
    fps,
    alpha
  }
}

function sec(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(3)
}

function chain(parts: Array<string | false | null | undefined>): string {
  return parts.filter((p): p is string => Boolean(p)).join(',')
}

function ffColor(hex: string): string {
  const h = (hex || '#000000').replace('#', '')
  if (/^[0-9a-fA-F]{6}$/.test(h)) return `0x${h.toUpperCase()}`
  return '0x000000'
}

function atempoChain(speed: number): string {
  const filters: number[] = []
  let rest = speed
  while (rest > 2.0001) {
    filters.push(2)
    rest /= 2
  }
  while (rest < 0.4999) {
    filters.push(0.5)
    rest *= 2
  }
  filters.push(Math.round(rest * 10000) / 10000)
  return filters.map((s) => `atempo=${s}`).join(',')
}

function rotateFlip(fx: ReturnType<typeof clipFx>): string[] {
  const bits: string[] = []
  if (fx.rotate === 90) bits.push('transpose=clock')
  else if (fx.rotate === 180) bits.push('transpose=clock', 'transpose=clock')
  else if (fx.rotate === 270) bits.push('transpose=cclock')
  if (fx.flipX) bits.push('hflip')
  if (fx.flipY) bits.push('vflip')
  return bits
}

function cropFilter(fx: ReturnType<typeof clipFx>): string | null {
  const c = fx.crop
  if (!c) return null
  const w = Math.min(1, Math.max(0.02, c.w))
  const h = Math.min(1, Math.max(0.02, c.h))
  const x = Math.min(1 - w, Math.max(0, c.x))
  const y = Math.min(1 - h, Math.max(0, c.y))
  return `crop=iw*${w.toFixed(4)}:ih*${h.toFixed(4)}:iw*${x.toFixed(4)}:ih*${y.toFixed(4)}`
}

function placeOnCanvas(
  fx: ReturnType<typeof clipFx>,
  width: number,
  height: number,
  durationS: string,
  fps: number,
  alpha: boolean,
  srcLabel: string,
  outLabel: string,
  anim?: { scale?: string; posX?: string; posY?: string; opacity?: string }
): string {
  const bg = alpha ? '0x00000000' : 'black'
  const mask = maskFfmpeg(fx)
  const dest = anim?.opacity ? `pl_${outLabel}` : outLabel
  const canvas = `color=c=${bg}:s=${width}x${height}:d=${durationS}:r=${fps},format=rgba[bg_${outLabel}]`
  const ax = axisScale(fx)
  const scX = anim?.scale || ax.x.toFixed(4)
  const scY = anim?.scale || ax.y.toFixed(4)
  const px = anim?.posX || (fx.posX ?? 0.5).toFixed(4)
  const py = anim?.posY || (fx.posY ?? 0.5).toFixed(4)
  const scaled = `${srcLabel}scale=w='iw*min(${width}/iw\\,${height}/ih)*(${scX})':h='ih*min(${width}/iw\\,${height}/ih)*(${scY})':eval=frame,setsar=1${
    mask ? `,${mask}` : ''
  }[fg_${outLabel}]`
  const over = `[bg_${outLabel}][fg_${outLabel}]overlay=x='${width}*(${px})-overlay_w/2':y='${height}*(${py})-overlay_h/2':eval=frame:shortest=1:format=auto[${dest}]`
  const body = `${scaled};${canvas};${over}`
  if (!anim?.opacity) return body
  const op = anim.opacity
  return `${body};[${dest}]format=rgba,geq=r='r(X\\,Y)*(${op})':g='g(X\\,Y)*(${op})':b='b(X\\,Y)*(${op})':a='alpha(X\\,Y)*(${op})'[${outLabel}]`
}

function clipAnim(fx: ReturnType<typeof clipFx>, durationS: number) {
  const dur = Number(durationS)
  return {
    scale: hasAnim(fx, 'scale') ? ffmpegInterp(fx.keys?.scale, dur, fx.scale, 't') : undefined,
    posX: hasAnim(fx, 'posX') ? ffmpegInterp(fx.keys?.posX, dur, fx.posX, 't') : undefined,
    posY: hasAnim(fx, 'posY') ? ffmpegInterp(fx.keys?.posY, dur, fx.posY, 't') : undefined,
    opacity: hasAnim(fx, 'opacity') ? ffmpegInterp(fx.keys?.opacity, dur, fx.opacity, 'T') : undefined
  }
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\n/g, '\\N')
}

function assColor(hex: string, alpha = '00'): string {
  const h = hex.replace('#', '')
  const r = h.slice(0, 2)
  const g = h.slice(2, 4)
  const b = h.slice(4, 6)
  return `&H${alpha}${b}${g}${r}`.toUpperCase()
}

function assTime(ms: number): string {
  const t = Math.max(0, ms)
  const h = Math.floor(t / 3600000)
  const m = Math.floor((t % 3600000) / 60000)
  const s = Math.floor((t % 60000) / 1000)
  const cs = Math.floor((t % 1000) / 10)
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

export async function writeAss(project: Project, dir: string, width: number, height: number): Promise<string | null> {
  if (!project.timeline.subtitles.length) return null
  const path = join(dir, 'subs.ass')
  await writeFile(path, assDocument(project, width, height), 'utf8')
  return path
}

/** 生成 ASS 文本；按 subtitleStyle.preset 输出描边 / 底框 / 卡拉 OK / 关键词高亮。 */
export function assDocument(project: Project, width: number, height: number): string {
  const style = project.subtitleStyle
  const preset = subtitlePreset(style)
  const align = style.position === 'top' ? 8 : style.position === 'center' ? 5 : 2
  const marginV = style.position === 'center' ? 0 : Math.round(height * 0.08)
  const fontSize = Math.round((style.fontSize || 42) * textScale(width, height))
  const color = style.color || '#ffffff'
  const highlight = style.highlightColor || DEFAULT_HIGHLIGHT
  let primary = assColor(color)
  let secondary = '&H000000FF'
  let outline = assColor(style.stroke || '#000000')
  let back = '&H80000000'
  let borderStyle = 1
  let outlineW = 2.2
  if (preset === 'boxed') {
    // BorderStyle 3：libass 用 OutlineColour 画底框，Outline 为内边距
    borderStyle = 3
    outline = assColor(style.boxColor || DEFAULT_BOX_COLOR, assAlpha(style.boxOpacity ?? DEFAULT_BOX_OPACITY))
    back = outline
    outlineW = Math.max(4, Math.round(fontSize * 0.22))
  } else if (preset === 'karaoke') {
    // \kf 从 Secondary 填充到 Primary：已读 = 高亮色
    primary = assColor(highlight)
    secondary = assColor(color)
  }
  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,PingFang SC,${fontSize},${primary},${secondary},${outline},${back},0,0,0,0,100,100,0,0,${borderStyle},${outlineW},0,${align},40,40,${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]
  for (const raw of project.timeline.subtitles) {
    // 超宽的行按估算宽度折行（和抽帧预览、应用内预览一致），不依赖 libass 自动换行
    const cue = { ...raw, text: wrapSubtitleText(raw.text, style, width, height) }
    lines.push(`Dialogue: 0,${assTime(cue.startMs)},${assTime(cue.endMs)},Default,,0,0,0,,${assCueText(cue, style)}`)
  }
  return lines.join('\n')
}

function assCueText(cue: SubtitleCue, style: SubtitleStyle): string {
  const preset = subtitlePreset(style)
  if (preset === 'karaoke') {
    const kl = karaokeLines(cue)
    if (kl) {
      let t = cue.startMs
      const parts: string[] = []
      kl.forEach((runs, li) => {
        if (li > 0) parts.push('\\N')
        runs.forEach((r, ri) => {
          if (r.startMs == null) {
            parts.push(escapeAss(r.text))
            return
          }
          if (r.startMs > t + 10) parts.push(`{\\k${Math.round((r.startMs - t) / 10)}}`)
          const nextStart = runs[ri + 1]?.startMs ?? kl[li + 1]?.[0]?.startMs
          const end = Math.max(r.endMs ?? r.startMs, Math.min(nextStart ?? r.endMs ?? r.startMs, cue.endMs))
          const cs = Math.max(1, Math.round((end - Math.max(t, r.startMs)) / 10))
          parts.push(`{\\kf${cs}}${escapeAss(r.text)}`)
          t = Math.max(t, r.startMs) + cs * 10
        })
      })
      return parts.join('')
    }
  }
  if (preset === 'keyword' && style.keywords?.length) {
    const hl = assColor(style.highlightColor || DEFAULT_HIGHLIGHT)
    return cue.text
      .split('\n')
      .map((line) =>
        keywordRuns(line, style.keywords)
          .map((r) => (r.hit ? `{\\c&H${hl.slice(-6)}&\\fscx115\\fscy115}${escapeAss(r.text)}{\\r}` : escapeAss(r.text)))
          .join('')
      )
      .join('\\N')
  }
  return escapeAss(cue.text)
}

function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
}

type PreparedClip = {
  clip: TimelineClip
  asset: MediaAsset
  videoIndex: number | null
  audioIndex: number | null
  hasAudio: boolean
  hasVideo: boolean
  asSprite?: boolean
}

export type StreamInfo = { hasVideo: boolean; hasAudio: boolean }

export function buildGraph(
  project: Project,
  opts: {
    width: number
    height: number
    fps: number
    alpha: boolean
    streams: Map<string, StreamInfo>
    assPath?: string | null
    bakedText?: Map<string, { path: string }>
    /** 本机 ffmpeg 有的滤镜；给了就跳过人声增强里没有的滤镜 */
    filters?: Set<string>
  }
): FilterGraph {
  const { width, height, fps, alpha, streams } = opts
  const hasFilter = (f: string) => !opts.filters || opts.filters.has(f)
  const durationMs = Math.max(1, timelineDurationMs(project.timeline))
  const inputs: GraphInput[] = []
  const filters: string[] = []

  const pushInput = (asset: MediaAsset, clip: TimelineClip): number => {
    const durS = sec(clip.durationMs)
    if (asset.kind === 'image') {
      inputs.push({
        args: ['-loop', '1', '-framerate', String(fps), '-t', durS],
        path: asset.path
      })
    } else {
      inputs.push({ args: [], path: asset.path })
    }
    return inputs.length - 1
  }

  const story: PreparedClip[] = []
  for (const clip of project.timeline.storyline) {
    const asset = project.assets.find((a) => a.id === clip.assetId)
    if (!asset) continue
    const info = streams.get(asset.path) ?? { hasVideo: asset.kind !== 'audio', hasAudio: asset.kind !== 'image' }
    const idx = pushInput(asset, clip)
    story.push({
      clip,
      asset,
      videoIndex: info.hasVideo || asset.kind === 'image' ? idx : null,
      audioIndex: info.hasAudio && asset.kind !== 'image' ? idx : null,
      hasAudio: info.hasAudio && asset.kind !== 'image',
      hasVideo: info.hasVideo || asset.kind === 'image'
    })
  }
  if (!story.length) {
    if (!project.timeline.overlays.length) throw new Error('时间线是空的')
    const durS = sec(durationMs)
    const bg = alpha ? '0x00000000' : 'black'
    filters.push(`color=c=${bg}:s=${width}x${height}:d=${durS}:r=${fps},format=rgba[v0]`)
    filters.push(
      `anullsrc=r=${project.settings.sampleRate || 48000}:cl=stereo,atrim=0:${durS},aformat=sample_fmts=fltp:sample_rates=${project.settings.sampleRate || 48000}:channel_layouts=stereo[a0]`
    )
  }

  const overlays: Array<PreparedClip | { clip: TimelineClip; generated: true }> = []
  for (const clip of project.timeline.overlays) {
    const kind = clipKind(clip)
    if (kind === 'text') {
      const baked = opts.bakedText?.get(clip.id)
      if (!baked) continue
      const image = baked.path.toLowerCase().endsWith('.png')
      const asset: MediaAsset = {
        id: clip.id,
        name: 'text',
        path: baked.path,
        kind: image ? 'image' : 'video',
        durationMs: clip.durationMs,
        width,
        height,
        fps,
        importedAt: ''
      }
      const idx = pushInput(asset, clip)
      overlays.push({
        clip,
        asset,
        videoIndex: idx,
        audioIndex: null,
        hasAudio: false,
        hasVideo: true,
        asSprite: true
      })
    } else if (kind === 'footage') {
      const asset = project.assets.find((a) => a.id === clip.assetId)
      if (!asset) continue
      const info = streams.get(asset.path) ?? { hasVideo: asset.kind !== 'audio', hasAudio: false }
      const idx = pushInput(asset, clip)
      overlays.push({
        clip,
        asset,
        videoIndex: info.hasVideo || asset.kind === 'image' ? idx : null,
        audioIndex: null,
        hasAudio: false,
        hasVideo: info.hasVideo || asset.kind === 'image'
      })
    } else {
      overlays.push({ clip, generated: true })
    }
  }

  const music: PreparedClip[] = []
  for (const clip of project.timeline.audio) {
    const asset = project.assets.find((a) => a.id === clip.assetId)
    if (!asset) continue
    const info = streams.get(asset.path) ?? { hasVideo: false, hasAudio: true }
    const idx = pushInput(asset, clip)
    music.push({
      clip,
      asset,
      videoIndex: null,
      audioIndex: info.hasAudio ? idx : null,
      hasAudio: info.hasAudio,
      hasVideo: false
    })
  }

  function videoPrep(item: PreparedClip, label: string, fadeInBlackMs: number, transparentBg = false, skipOpacity = false): string {
    const fx = clipFx(item.clip)
    const durS = sec(item.clip.durationMs)
    const inS = sec(item.clip.inMs)
    const outS = sec(item.clip.outMs)
    const speed = Math.max(0.25, fx.speed || 1)
    const src = item.videoIndex == null ? null : `[${item.videoIndex}:v]`
    const anim = clipAnim(fx, Number(durS))
    let trim: string
    if (item.asset.kind === 'image') {
      trim = `trim=duration=${durS},setpts=PTS-STARTPTS`
    } else if (fx.freeze) {
      const f = Math.max(0, (fx.freezeAtMs ?? item.clip.inMs) / 1000)
      trim = `trim=start=${f.toFixed(3)}:end=${(f + 0.05).toFixed(3)},setpts=PTS-STARTPTS,loop=-1:size=1,fps=${fps},trim=duration=${durS},setpts=PTS-STARTPTS`
    } else if (fx.reverse) {
      trim = chain([
        `trim=start=${inS}:end=${outS}`,
        'setpts=PTS-STARTPTS',
        'reverse',
        'setpts=PTS-STARTPTS',
        speed !== 1 ? `setpts=PTS/${speed}` : null
      ])
    } else {
      trim = `trim=start=${inS}:end=${outS},setpts=PTS-STARTPTS,setpts=PTS/${speed}`
    }
    const fadeOutBlack =
      fx.transitionOut.type === 'fade_black' ? Math.max(fx.transitionOut.durationMs, fx.fadeOutMs) : 0
    const alphaFadeIn = fadeInBlackMs ? 0 : fx.fadeInMs
    const alphaFadeOut = fadeOutBlack ? 0 : fx.fadeOutMs
    const raw = src
      ? `${src}${chain([
          trim,
          `fps=${fps}`,
          ...(item.asset.kind === 'image' ? [] : stabilizeFfmpeg(fx)),
          cropFilter(fx),
          ...rotateFlip(fx),
          ...videoFilterFfmpeg(fx),
          ...simpleEffectFfmpeg(fx),
          ...keyFfmpeg(fx),
          'format=rgba',
          audioGlowFfmpeg(fx, Number(durS)),
          !skipOpacity && !anim.opacity && fx.opacity < 0.999 ? `colorchannelmixer=aa=${fx.opacity.toFixed(3)}` : null,
          alphaFadeIn > 0 ? `fade=t=in:st=0:d=${sec(alphaFadeIn)}:alpha=1` : null,
          alphaFadeOut > 0
            ? `fade=t=out:st=${sec(item.clip.durationMs - alphaFadeOut)}:d=${sec(alphaFadeOut)}:alpha=1`
            : null,
          fadeInBlackMs > 0 ? `fade=t=in:st=0:d=${sec(fadeInBlackMs)}:c=black` : null,
          fadeOutBlack > 0
            ? `fade=t=out:st=${sec(item.clip.durationMs - fadeOutBlack)}:d=${sec(fadeOutBlack)}:c=black`
            : null
        ])}[${hasGlow(fx) ? `pre_${label}` : `raw_${label}`}]`
      : `color=c=black:s=${width}x${height}:d=${durS}:r=${fps},format=rgba[${hasGlow(fx) ? `pre_${label}` : `raw_${label}`}]`
    const glow = hasGlow(fx)
      ? `[pre_${label}]split[ga_${label}][gb_${label}];[gb_${label}]gblur=sigma=${glowSigma(fx).toFixed(2)}[gc_${label}];[ga_${label}][gc_${label}]blend=all_mode=screen:repeatlast=0[raw_${label}]`
      : ''
    const placed = placeOnCanvas(fx, width, height, durS, fps, alpha || transparentBg, `[raw_${label}]`, label, anim)
    return glow ? `${raw};${glow};${placed}` : `${raw};${placed}`
  }

  function audioPrep(item: PreparedClip, label: string): string {
    const fx = clipFx(item.clip)
    const speed = Math.max(0.25, fx.speed || 1)
    const inS = sec(item.clip.inMs)
    const outS = sec(item.clip.outMs)
    const durS = sec(item.clip.durationMs)
    const src =
      item.audioIndex == null
        ? `anullsrc=r=${project.settings.sampleRate || 48000}:cl=stereo,atrim=0:${durS},asetpts=PTS-STARTPTS`
        : `[${item.audioIndex}:a]atrim=start=${inS}:end=${outS},asetpts=PTS-STARTPTS`
    const speedFilters = item.audioIndex == null || Math.abs(speed - 1) < 0.001
      ? []
      : fx.pitchPreserve
        ? [atempoChain(speed)]
        : [`asetrate=${(project.settings.sampleRate || 48000) * speed}`, `aresample=${project.settings.sampleRate || 48000}`]
    const fadeIn = fx.fadeInMs
    const fadeOut = fx.transitionOut.type === 'fade_black' ? Math.max(fx.transitionOut.durationMs, fx.fadeOutMs) : fx.fadeOutMs
    const extra = chain([
      fx.reverse && item.audioIndex != null ? 'areverse' : null,
      ...speedFilters,
      `aformat=sample_fmts=fltp:sample_rates=${project.settings.sampleRate || 48000}:channel_layouts=stereo`,
      ...denoiseFfmpeg(fx),
      ...voiceFfmpeg(fx, hasFilter),
      volumeFilter(item.clip),
      fadeIn > 0 ? `afade=t=in:st=0:d=${sec(fadeIn)}` : null,
      fadeOut > 0 ? `afade=t=out:st=${sec(item.clip.durationMs - fadeOut)}:d=${sec(fadeOut)}` : null
    ])
    return extra ? `${src},${extra}[${label}]` : `${src}[${label}]`
  }

  story.forEach((item, i) => {
    const prev = i > 0 ? clipFx(story[i - 1].clip) : null
    const fadeInBlack = prev?.transitionOut.type === 'fade_black' ? prev.transitionOut.durationMs : 0
    filters.push(videoPrep(item, `v${i}`, fadeInBlack))
    filters.push(audioPrep(item, `a${i}`))
  })

  let vLast = 'v0'
  let aLast = 'a0'
  let accS = story[0] ? story[0].clip.durationMs / 1000 : durationMs / 1000
  for (let i = 1; i < story.length; i++) {
    const prev = story[i - 1].clip
    const fx = clipFx(prev)
    const overlap =
      Math.min(dissolveOverlapMs(prev), prev.durationMs - 1, story[i].clip.durationMs - 1) / 1000
    const vOut = `vx${i}`
    const aOut = `ax${i}`
    if (overlap > 0.001) {
      const offset = accS - overlap
      const xf = xfadeName(fx.transitionOut.type) || 'fadeslow'
      filters.push(
        `[${vLast}][v${i}]xfade=transition=${xf}:duration=${overlap.toFixed(3)}:offset=${offset.toFixed(3)}[${vOut}]`
      )
      filters.push(`[${aLast}][a${i}]acrossfade=d=${overlap.toFixed(3)}:c1=cub:c2=cub[${aOut}]`)
      accS = accS + story[i].clip.durationMs / 1000 - overlap
    } else {
      filters.push(`[${vLast}][v${i}]concat=n=2:v=1:a=0[${vOut}]`)
      filters.push(`[${aLast}][a${i}]concat=n=2:v=0:a=1[${aOut}]`)
      accS += story[i].clip.durationMs / 1000
    }
    vLast = vOut
    aLast = aOut
  }

  overlays.forEach((item, i) => {
    const kind = clipKind(item.clip)
    const start = sec(item.clip.startMs)
    const end = sec(item.clip.startMs + item.clip.durationMs)
    const vOut = `vo${i}`
    if (kind === 'adjustment') {
      const fx = clipFx(item.clip)
      const filt = chain([
        ...videoFilterFfmpeg(fx),
        ...simpleEffectFfmpeg(fx),
        fx.opacity < 0.999 ? `colorchannelmixer=aa=${fx.opacity.toFixed(3)}` : null
      ])
      if (!filt && !hasGlow(fx)) return
      filters.push(`[${vLast}]split=2[ak${i}][as${i}]`)
      if (hasGlow(fx)) {
        const mid = filt ? `asx${i}` : `as${i}`
        if (filt) filters.push(`[as${i}]${filt}[${mid}]`)
        filters.push(`[${mid}]split[ga${i}][gb${i}]`)
        filters.push(`[gb${i}]gblur=sigma=${glowSigma(fx).toFixed(2)}[gc${i}]`)
        filters.push(`[ga${i}][gc${i}]blend=all_mode=screen:repeatlast=0[af${i}]`)
      } else {
        filters.push(`[as${i}]${filt}[af${i}]`)
      }
      filters.push(`[ak${i}][af${i}]overlay=0:0:enable='between(t,${start},${end})'[${vOut}]`)
      vLast = vOut
      return
    }
    const label = `ov${i}`
    const blend = ffmpegBlendMode(clipBlend(item.clip))
    const fx = clipFx(item.clip)
    const durS = sec(item.clip.durationMs)
    const anim = clipAnim(fx, Number(durS))
    if (!('generated' in item) && item.asSprite && item.videoIndex != null) {
      const src = `[${item.videoIndex}:v]format=rgba[raw_${label}]`
      filters.push(src)
      const dest = anim.opacity ? `pl_${label}` : label
      filters.push(
        `color=c=0x00000000:s=${width}x${height}:d=${durS}:r=${fps},format=rgba[bg_${label}]`
      )
      filters.push(`[bg_${label}][raw_${label}]overlay=0:0:shortest=1:format=auto[${dest}]`)
      if (anim.opacity) {
        const op = anim.opacity
        filters.push(
          `[${dest}]format=rgba,geq=r='r(X\\,Y)*(${op})':g='g(X\\,Y)*(${op})':b='b(X\\,Y)*(${op})':a='alpha(X\\,Y)*(${op})'[${label}]`
        )
      }
    } else if ('generated' in item && kind === 'shape') {
      const sh = item.clip.shape ?? { shape: 'rect' as const, fill: '#e0a93a', width: 0.42, height: 0.22 }
      const boxW = even(width * (sh.width || 0.42) * (fx.scale || 1))
      const boxH = even(height * (sh.height || 0.22) * (fx.scale || 1))
      const color = ffColor(sh.fill || '#e0a93a')
      const ellipse =
        sh.shape === 'ellipse'
          ? `,geq=r='r(X\\,Y)':g='g(X\\,Y)':b='b(X\\,Y)':a='if(lte(hypot((X-W/2)/(max(W/2\\,1))\\,(Y-H/2)/(max(H/2\\,1)))\\,1)\\,255\\,0)'`
          : ''
      filters.push(`color=c=${color}:s=${boxW}x${boxH}:d=${durS}:r=${fps},format=rgba${ellipse}[raw_${label}]`)
      const dest = anim.opacity ? `pl_${label}` : label
      const ox = Math.round(fx.posX * width - boxW / 2)
      const oy = Math.round(fx.posY * height - boxH / 2)
      filters.push(
        `color=c=0x00000000:s=${width}x${height}:d=${durS}:r=${fps},format=rgba[bg_${label}]`
      )
      filters.push(`[bg_${label}][raw_${label}]overlay=${ox}:${oy}:shortest=1:format=auto[${dest}]`)
      if (anim.opacity) {
        const op = anim.opacity
        filters.push(
          `[${dest}]format=rgba,geq=r='r(X\\,Y)*(${op})':g='g(X\\,Y)*(${op})':b='b(X\\,Y)*(${op})':a='alpha(X\\,Y)*(${op})'[${label}]`
        )
      }
    } else if ('generated' in item) {
      const color = ffColor(item.clip.solidColor || '#000000')
      const bakeOp = !blend && !anim.opacity && fx.opacity < 0.999
      filters.push(
        `color=c=${color}:s=${width}x${height}:d=${durS}:r=${fps},format=rgba${
          bakeOp ? `,colorchannelmixer=aa=${fx.opacity.toFixed(3)}` : ''
        }[raw_${label}]`
      )
      filters.push(placeOnCanvas(fx, width, height, durS, fps, true, `[raw_${label}]`, label, anim))
    } else {
      filters.push(videoPrep(item, label, 0, true, Boolean(blend) || Boolean(anim.opacity)))
    }
    const delayed = Number(start) > 0.0005 ? `ovd${i}` : label
    if (delayed !== label) filters.push(`[${label}]setpts=PTS+${start}/TB[${delayed}]`)
    if (blend) {
      filters.push(
        `[${vLast}][${delayed}]blend=all_mode=${blend}:all_opacity=${fx.opacity.toFixed(3)}:repeatlast=0:enable='between(t,${start},${end})'[${vOut}]`
      )
    } else {
      filters.push(`[${vLast}][${delayed}]overlay=0:0:eof_action=pass:format=auto[${vOut}]`)
    }
    vLast = vOut
  })

  if (opts.assPath) {
    const vOut = 'vsub'
    filters.push(`[${vLast}]ass='${escapeFilterPath(opts.assPath)}'[${vOut}]`)
    vLast = vOut
  }

  const vFinal = alpha ? 'vout' : 'vout'
  filters.push(`[${vLast}]format=${alpha ? 'rgba' : 'yuv420p'}[${vFinal}]`)

  let aFinal: string | null = aLast
  if (music.length) {
    const duckOn = Boolean(project.timeline.duck?.enabled)
    const musicLabels: string[] = []
    const dialogLabels: string[] = []
    music.forEach((item, i) => {
      if (item.audioIndex == null) return
      const dialog = item.clip.role === 'dialog'
      const label = dialog ? `d${i}` : `m${i}`
      const delay = Math.max(0, Math.round(item.clip.startMs))
      const fx = clipFx(item.clip)
      const extra = chain([
        `aformat=sample_fmts=fltp:sample_rates=${project.settings.sampleRate || 48000}:channel_layouts=stereo`,
        ...denoiseFfmpeg(fx),
        ...(dialog ? voiceFfmpeg(fx, hasFilter) : []),
        volumeFilter(item.clip),
        `adelay=${delay}|${delay}`
      ])
      filters.push(
        `[${item.audioIndex}:a]atrim=start=${sec(item.clip.inMs)}:end=${sec(item.clip.outMs)},asetpts=PTS-STARTPTS,${extra}[${label}]`
      )
      ;(dialog ? dialogLabels : musicLabels).push(label)
    })
    const voiceIns = [aLast, ...dialogLabels]
    let musicBus: string | null = null
    if (musicLabels.length) {
      musicBus = 'mbus'
      filters.push(
        musicLabels.length > 1
          ? `${musicLabels.map((l) => `[${l}]`).join('')}amix=inputs=${musicLabels.length}:duration=longest:dropout_transition=0:normalize=0[${musicBus}]`
          : `[${musicLabels[0]}]anull[${musicBus}]`
      )
    }
    if (musicBus && duckOn) {
      // 真正的闪避：只在人声出现时压低音乐（人声做侧链），而不是整首歌一直小声。
      const ratio = Math.min(20, Math.max(2, 1 / Math.max(0.05, project.timeline.duck?.ratio ?? 0.28)))
      const voice = voiceIns.length > 1 ? 'vbus' : aLast
      if (voiceIns.length > 1) {
        filters.push(`${voiceIns.map((l) => `[${l}]`).join('')}amix=inputs=${voiceIns.length}:duration=first:dropout_transition=0:normalize=0[vbus]`)
      }
      filters.push(`[${voice}]asplit=2[vmain][vkey]`)
      filters.push(`[${musicBus}][vkey]sidechaincompress=threshold=0.015:ratio=${ratio.toFixed(2)}:attack=30:release=450:makeup=1[mduck]`)
      filters.push(`[vmain][mduck]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`)
      aFinal = 'aout'
    } else if (musicBus || dialogLabels.length) {
      const mixIns = [...voiceIns, ...(musicBus ? [musicBus] : [])].map((l) => `[${l}]`).join('')
      filters.push(
        `${mixIns}amix=inputs=${voiceIns.length + (musicBus ? 1 : 0)}:duration=first:dropout_transition=0:normalize=0[aout]`
      )
      aFinal = 'aout'
    }
  }

  if (aFinal) {
    // 母线限幅到 -1 dBTP：响度统一后提高的音量不会削波。
    filters.push(`[${aFinal}]alimiter=limit=0.891:attack=5:release=60:level=disabled[amaster]`)
    aFinal = 'amaster'
  }

  return {
    inputs,
    filter: filters.join(';'),
    videoMap: `[${vFinal}]`,
    audioMap: aFinal ? `[${aFinal}]` : null,
    durationMs,
    width,
    height,
    fps,
    alpha,
    assPath: opts.assPath ?? undefined
  }
}
