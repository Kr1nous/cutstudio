import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { ClipMask, MediaAsset, ProjectSettings, SubtitleStyle, Timeline, TimelineClip } from '@shared/types'
import { fxAt } from '@shared/anim'
import { clipAtTime, clipFx, playbackPath, subtitleAtTime } from '@shared/types'
import {
  DEFAULT_BOX_COLOR,
  DEFAULT_BOX_OPACITY,
  DEFAULT_HIGHLIGHT,
  karaokeLines,
  keywordRuns,
  subtitlePreset,
  type TextRun, wrapSubtitleText } from '@shared/subtitle'
import { canvasComposite, layersAt, sourceTimeMs, type CompLayer } from '@shared/compose'
import { applyEffectsCanvas, clipEffects, makeLut, type CubeLut } from '@shared/effects'
import { applyKeyCanvas } from '@shared/key'
import { applyCanvasMask, axisScale, clampMask, containBase, layerBox, pathMask } from '@shared/mask'
import { clipText, textScale, visibleText } from '@shared/text'
import { volumeAt } from '@shared/audio'
import { applyWarmthCanvas, videoFilterCss } from '@shared/fx'
import { formatTimecode, mediaUrl } from '../lib/format'
import { Icon } from './Icon'

type VisualEl = HTMLVideoElement | HTMLImageElement

let layerScratch: HTMLCanvasElement | null = null
let filterScratch: HTMLCanvasElement | null = null
function sharp2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return ctx
}

function scratchCanvas(w: number, h: number): HTMLCanvasElement {
  if (!layerScratch) layerScratch = document.createElement('canvas')
  if (layerScratch.width !== w || layerScratch.height !== h) {
    layerScratch.width = w
    layerScratch.height = h
  }
  const ctx = sharp2d(layerScratch)
  ctx?.clearRect(0, 0, w, h)
  return layerScratch
}

function rasterCopy(src: HTMLCanvasElement): HTMLCanvasElement {
  if (!filterScratch) filterScratch = document.createElement('canvas')
  if (filterScratch.width !== src.width || filterScratch.height !== src.height) {
    filterScratch.width = src.width
    filterScratch.height = src.height
  }
  const ctx = sharp2d(filterScratch)
  if (ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, src.width, src.height)
    ctx.drawImage(src, 0, 0)
  }
  return filterScratch
}

function seekMedia(el: HTMLMediaElement, time: number, threshold: number): void {
  if (!Number.isFinite(time)) return
  const t = Math.max(0, time)
  if (el.seeking || el.readyState < 1) return
  if (Math.abs(el.currentTime - t) <= threshold) return
  try {
    el.currentTime = t
  } catch {
    /* WKWebView throws if the media pipeline is still opening */
  }
}

function sourceSize(el: VisualEl): { w: number; h: number } {
  if (el instanceof HTMLVideoElement) return { w: el.videoWidth, h: el.videoHeight }
  return { w: el.naturalWidth, h: el.naturalHeight }
}

function lutFor(fx: ReturnType<typeof fxAt>): CubeLut | null {
  const e = clipEffects(fx).find((x) => x.type === 'lut')
  if (!e) return null
  const name = String(e.params.name || '')
  if (name === 'warm' || name === 'cool' || name === 'contrast' || name === 'green') return makeLut(name)
  return null
}

function drawLayer(
  ctx: CanvasRenderingContext2D,
  el: VisualEl,
  opacity: number,
  canvasW: number,
  canvasH: number,
  clip: TimelineClip,
  blend: CompLayer['blend'],
  timeMs: number,
  motion: Pick<CompLayer, 'slide' | 'slideY' | 'zoom' | 'wipe' | 'iris' | 'blur'> = {}
) {
  const fx = fxAt(clip, timeMs)
  const { w: sw, h: sh } = sourceSize(el)
  if (!sw || !sh) return
  let sx = 0
  let sy = 0
  let cw = sw
  let ch = sh
  if (fx.crop) {
    sx = fx.crop.x * sw
    sy = fx.crop.y * sh
    cw = Math.max(1, fx.crop.w * sw)
    ch = Math.max(1, fx.crop.h * sh)
  }
  const box = layerBox(fx, canvasW, canvasH, cw, ch)
  const boxW = Math.max(2, Math.round(box.w))
  const boxH = Math.max(2, Math.round(box.h))
  const buf = scratchCanvas(boxW, boxH)
  const bctx = buf.getContext('2d')
  if (!bctx) return
  bctx.filter = 'none'
  bctx.drawImage(el, sx, sy, cw, ch, 0, 0, boxW, boxH)
  const css = videoFilterCss(fx)
  if (css) {
    const copy = rasterCopy(buf)
    bctx.filter = css
    bctx.clearRect(0, 0, boxW, boxH)
    bctx.drawImage(copy, 0, 0)
    bctx.filter = 'none'
  }
  applyWarmthCanvas(bctx, boxW, boxH, fx)
  applyEffectsCanvas(bctx, boxW, boxH, fx, lutFor(fx))
  const link = fx.audioLink
  if (link && (link.prop === 'glow' || link.prop === 'both')) {
    const base = Math.max(0.05, clipFx(clip).scale || 1)
    const pulse = Math.min(1, Math.max(0, fx.scale / base - 1) / Math.max(0.08, link.amount))
    if (pulse > 0.02) {
      const copy = document.createElement('canvas')
      copy.width = boxW
      copy.height = boxH
      copy.getContext('2d')?.drawImage(buf, 0, 0)
      bctx.save()
      bctx.filter = `blur(${6 + pulse * 10}px)`
      bctx.globalCompositeOperation = 'lighter'
      bctx.globalAlpha = 0.35 * pulse
      bctx.drawImage(copy, 0, 0)
      bctx.restore()
    }
  }
  applyKeyCanvas(bctx, boxW, boxH, fx)
  applyCanvasMask(bctx, boxW, boxH, fx.masks)
  if (motion.blur && motion.blur > 0.4) {
    const copy = rasterCopy(buf)
    bctx.filter = `blur(${motion.blur}px)`
    bctx.clearRect(0, 0, boxW, boxH)
    bctx.drawImage(copy, 0, 0)
    bctx.filter = 'none'
  }
  ctx.save()
  ctx.globalCompositeOperation = canvasComposite(blend)
  ctx.globalAlpha = opacity
  ctx.translate(fx.posX * canvasW + (motion.slide ?? 0) * canvasW, fx.posY * canvasH + (motion.slideY ?? 0) * canvasH)
  if (fx.rotate) ctx.rotate((fx.rotate * Math.PI) / 180)
  const z = motion.zoom && motion.zoom > 0 ? motion.zoom : 1
  ctx.scale((fx.flipX ? -1 : 1) * z, (fx.flipY ? -1 : 1) * z)
  if (motion.wipe) {
    const t = Math.min(1, Math.max(0, motion.wipe.t))
    ctx.beginPath()
    if (motion.wipe.dir === 'left') ctx.rect(-boxW / 2, -boxH / 2, boxW * t, boxH)
    else if (motion.wipe.dir === 'right') ctx.rect(boxW / 2 - boxW * t, -boxH / 2, boxW * t, boxH)
    else if (motion.wipe.dir === 'up') ctx.rect(-boxW / 2, boxH / 2 - boxH * t, boxW, boxH * t)
    else ctx.rect(-boxW / 2, -boxH / 2, boxW, boxH * t)
    ctx.clip()
  }
  if (motion.iris != null) {
    ctx.beginPath()
    ctx.arc(0, 0, Math.max(0, motion.iris) * Math.hypot(boxW, boxH) * 0.55, 0, Math.PI * 2)
    ctx.clip()
  }
  ctx.drawImage(buf, -boxW / 2, -boxH / 2)
  ctx.restore()
}

function drawSolid(
  ctx: CanvasRenderingContext2D,
  opacity: number,
  canvasW: number,
  canvasH: number,
  clip: TimelineClip,
  blend: CompLayer['blend'],
  timeMs: number
) {
  const fx = fxAt(clip, timeMs)
  const box = layerBox(fx, canvasW, canvasH)
  const boxW = Math.max(2, Math.round(box.w))
  const boxH = Math.max(2, Math.round(box.h))
  const buf = scratchCanvas(boxW, boxH)
  const bctx = buf.getContext('2d')
  if (!bctx) return
  bctx.fillStyle = clip.solidColor || '#000'
  bctx.fillRect(0, 0, boxW, boxH)
  const css = videoFilterCss(fx)
  if (css) {
    const tmp = document.createElement('canvas')
    tmp.width = boxW
    tmp.height = boxH
    tmp.getContext('2d')?.drawImage(buf, 0, 0)
    bctx.filter = css
    bctx.clearRect(0, 0, boxW, boxH)
    bctx.drawImage(tmp, 0, 0)
    bctx.filter = 'none'
  }
  applyWarmthCanvas(bctx, boxW, boxH, fx)
  applyEffectsCanvas(bctx, boxW, boxH, fx, lutFor(fx))
  applyKeyCanvas(bctx, boxW, boxH, fx)
  applyCanvasMask(bctx, boxW, boxH, fx.masks)
  ctx.save()
  ctx.globalCompositeOperation = canvasComposite(blend)
  ctx.globalAlpha = opacity
  ctx.translate(fx.posX * canvasW, fx.posY * canvasH)
  if (fx.rotate) ctx.rotate((fx.rotate * Math.PI) / 180)
  ctx.drawImage(buf, -boxW / 2, -boxH / 2)
  ctx.restore()
}

function drawShape(
  ctx: CanvasRenderingContext2D,
  opacity: number,
  canvasW: number,
  canvasH: number,
  clip: TimelineClip,
  blend: CompLayer['blend'],
  timeMs: number
) {
  const fx = fxAt(clip, timeMs)
  const sh = clip.shape ?? { shape: 'rect' as const, fill: '#e0a93a', width: 0.42, height: 0.22 }
  const w = Math.max(2, (sh.width || 0.42) * canvasW * (fx.scale || 1))
  const h = Math.max(2, (sh.height || 0.22) * canvasH * (fx.scale || 1))
  ctx.save()
  ctx.globalCompositeOperation = canvasComposite(blend)
  ctx.globalAlpha = opacity
  ctx.translate(fx.posX * canvasW, fx.posY * canvasH)
  if (fx.rotate) ctx.rotate((fx.rotate * Math.PI) / 180)
  ctx.fillStyle = sh.fill || '#e0a93a'
  if (sh.shape === 'ellipse') {
    ctx.beginPath()
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2)
    ctx.fill()
  } else ctx.fillRect(-w / 2, -h / 2, w, h)
  ctx.restore()
}

function drawTextLayer(
  ctx: CanvasRenderingContext2D,
  opacity: number,
  canvasW: number,
  canvasH: number,
  clip: TimelineClip,
  blend: CompLayer['blend'],
  timeMs: number
) {
  const fx = fxAt(clip, timeMs)
  const t = clipText(clip)
  const text = visibleText(clip, timeMs)
  if (!text) return
  const size = Math.round((t.fontSize || 72) * textScale(canvasW, canvasH) * (fx.scale || 1))
  ctx.save()
  ctx.globalCompositeOperation = canvasComposite(blend)
  ctx.globalAlpha = opacity
  ctx.font = `600 ${size}px "${t.font || 'PingFang SC'}", "Hiragino Sans GB", sans-serif`
  ctx.textAlign = t.align === 'left' ? 'left' : t.align === 'right' ? 'right' : 'center'
  ctx.textBaseline = 'middle'
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(1, (t.strokeWidth ?? 3) * textScale(canvasW, canvasH))
  ctx.strokeStyle = t.stroke || '#000'
  ctx.fillStyle = t.color || '#fff'
  const x = fx.posX * canvasW
  const y = fx.posY * canvasH
  if ((t.strokeWidth ?? 3) > 0) ctx.strokeText(text, x, y)
  ctx.fillText(text, x, y)
  ctx.restore()
}

type XformLive = { posX: number; posY: number; scaleX: number; scaleY: number }
type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'
type DragState =
  | { kind: 'mask'; maskId: string; mode: 'move' | 'resize'; startX: number; startY: number; orig: ClipMask }
  | {
      kind: 'xform'
      clipId: string
      handle: Handle
      startX: number
      startY: number
      orig: XformLive
      box: { x: number; y: number; w: number; h: number }
      src: { w: number; h: number }
    }

function clipSourceSize(
  clip: TimelineClip,
  nodes: Map<string, VisualEl | HTMLAudioElement>,
  assets: MediaAsset[]
): { w: number; h: number } {
  const el = nodes.get(clip.assetId)
  if (el && !(el instanceof HTMLAudioElement)) {
    const s = sourceSize(el)
    if (s.w && s.h) return s
  }
  const a = assets.find((x) => x.id === clip.assetId)
  return { w: a?.width ?? 0, h: a?.height ?? 0 }
}

function resizeBox(
  box: { x: number; y: number; w: number; h: number },
  handle: Handle,
  dx: number,
  dy: number,
  uniform: boolean
): { x: number; y: number; w: number; h: number } {
  let { x, y, w, h } = box
  const right = x + w
  const bottom = y + h
  if (handle.includes('e')) w = Math.max(8, box.w + dx)
  if (handle.includes('s')) h = Math.max(8, box.h + dy)
  if (handle.includes('w')) {
    w = Math.max(8, box.w - dx)
    x = right - w
  }
  if (handle.includes('n')) {
    h = Math.max(8, box.h - dy)
    y = bottom - h
  }
  if (uniform && handle !== 'move' && handle.length === 2) {
    const ratio = box.w / Math.max(1, box.h)
    const fromW = Math.abs(w - box.w) >= Math.abs(h - box.h)
    if (fromW) h = Math.max(8, w / ratio)
    else w = Math.max(8, h * ratio)
    if (handle.includes('w')) x = right - w
    if (handle.includes('n')) y = bottom - h
  }
  return { x, y, w, h }
}

function hitHandle(
  p: { x: number; y: number },
  box: { x: number; y: number; w: number; h: number },
  pad: number
): Handle | null {
  const { x, y, w, h } = box
  if (p.x < x - pad || p.x > x + w + pad || p.y < y - pad || p.y > y + h + pad) return null
  const left = Math.abs(p.x - x) <= pad
  const right = Math.abs(p.x - (x + w)) <= pad
  const top = Math.abs(p.y - y) <= pad
  const bottom = Math.abs(p.y - (y + h)) <= pad
  if (top && left) return 'nw'
  if (top && right) return 'ne'
  if (bottom && left) return 'sw'
  if (bottom && right) return 'se'
  if (left) return 'w'
  if (right) return 'e'
  if (top) return 'n'
  if (bottom) return 's'
  if (p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h) return 'move'
  return null
}

function cursorFor(handle: Handle | null): string {
  if (!handle) return 'default'
  if (handle === 'move') return 'move'
  if (handle === 'n' || handle === 's') return 'ns-resize'
  if (handle === 'e' || handle === 'w') return 'ew-resize'
  if (handle === 'nw' || handle === 'se') return 'nwse-resize'
  return 'nesw-resize'
}

function edgePad(box: { w: number; h: number }, canvasW: number): number {
  return Math.max(14, Math.min(36, Math.min(box.w, box.h, canvasW) * 0.08))
}

export function Viewer({
  assets,
  timeline,
  playheadMs,
  playing,
  rate = 1,
  durationMs = 0,
  onToggle,
  onSeek,
  subtitleStyle,
  settings,
  selectedClip = null,
  onAction,
  onSelectClip
}: {
  assets: MediaAsset[]
  timeline: Timeline
  playheadMs: number
  playing: boolean
  /** 播放倍速（J/K/L）。 */
  rate?: number
  durationMs?: number
  onToggle: () => void
  onSeek: (ms: number) => void
  subtitleStyle?: SubtitleStyle
  settings: ProjectSettings
  selectedClip?: TimelineClip | null
  onAction?: (name: string, args?: Record<string, unknown>) => void
  onSelectClip?: (id: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const adjRef = useRef<HTMLCanvasElement | null>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const liveRef = useRef<ClipMask[] | null>(null)
  const [liveMasks, setLiveMasks] = useState<ClipMask[] | null>(null)
  const [liveXform, setLiveXform] = useState<XformLive | null>(null)
  const liveXformRef = useRef<XformLive | null>(null)
  liveXformRef.current = liveXform
  const [activeMaskId, setActiveMaskId] = useState<string | null>(null)
  const nodesRef = useRef<Map<string, VisualEl | HTMLAudioElement>>(new Map())
  const layersRef = useRef<CompLayer[]>([])
  const width = settings.width || 1920
  const height = settings.height || 1080
  const [viewSize, setViewSize] = useState({ w: 2, h: 2 })

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const update = () => {
      const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1))
      const w = Math.max(2, Math.round(el.clientWidth * dpr))
      const h = Math.max(2, Math.round(el.clientHeight * dpr))
      setViewSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
    }
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    window.addEventListener('resize', update)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [])

  const playheadRef = useRef(playheadMs)
  playheadRef.current = playheadMs
  const timelineRef = useRef(timeline)
  timelineRef.current = timeline
  const playingRef = useRef(playing)
  playingRef.current = playing
  const selectedClipRef = useRef(selectedClip)
  selectedClipRef.current = selectedClip
  const subtitleStyleRef = useRef(subtitleStyle)
  subtitleStyleRef.current = subtitleStyle
  const liveMasksRef = useRef(liveMasks)
  liveMasksRef.current = liveMasks
  const activeMaskIdRef = useRef(activeMaskId)
  activeMaskIdRef.current = activeMaskId
  const clockRef = useRef({ originWall: 0, originMs: 0 })
  const rateRef = useRef(rate)
  rateRef.current = rate

  const layers = useMemo(() => layersAt(timeline, playheadMs), [timeline, playheadMs])
  layersRef.current = layers
  const cue = subtitleAtTime(timeline.subtitles, playheadMs)
  const story = clipAtTime(timeline.storyline, playheadMs)

  const visualAssets = useMemo(() => {
    const ids = new Set<string>()
    const list: MediaAsset[] = []
    for (const clip of [...timeline.storyline, ...timeline.overlays]) {
      const asset = assets.find((a) => a.id === clip.assetId)
      if (asset && asset.kind !== 'audio' && !ids.has(asset.id)) {
        ids.add(asset.id)
        list.push(asset)
      }
    }
    return list
  }, [timeline, assets])

  // 音频轨上的每个片段一个 <audio>：音乐和 J/L cut 的对白可以同时播放
  const audioClips = useMemo(
    () =>
      timeline.audio
        .map((clip) => ({ clip, asset: assets.find((a) => a.id === clip.assetId) }))
        .filter((x): x is { clip: TimelineClip; asset: MediaAsset } => Boolean(x.asset)),
    [timeline.audio, assets]
  )
  const audioKey = audioClips.map((x) => `${x.clip.id}:${x.asset.path}`).join('|')
  const assetsRef = useRef(assets)
  assetsRef.current = assets

  function currentTimeMs() {
    if (playingRef.current) {
      return clockRef.current.originMs + (performance.now() - clockRef.current.originWall) * rateRef.current
    }
    return playheadRef.current
  }

  function paint() {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = sharp2d(canvas)
    if (!ctx) return
    try {
      const t = currentTimeMs()
      const tl = timelineRef.current
      const nowLayers = layersAt(tl, t)
      layersRef.current = nowLayers
      const nowCue = subtitleAtTime(tl.subtitles, t)
      const selected = selectedClipRef.current
      const masksLive = liveMasksRef.current
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      for (const layer of nowLayers) {
        if (layer.kind === 'adjustment') {
          let off = adjRef.current
          if (!off || off.width !== canvas.width || off.height !== canvas.height) {
            off = document.createElement('canvas')
            off.width = canvas.width
            off.height = canvas.height
            adjRef.current = off
          }
          const octx = sharp2d(off)
          if (!octx) continue
          octx.clearRect(0, 0, off.width, off.height)
          const adjCss = videoFilterCss(clipFx(layer.clip))
          if (adjCss) {
            const copy = rasterCopy(canvas)
            octx.filter = adjCss
            octx.drawImage(copy, 0, 0)
            octx.filter = 'none'
          } else {
            octx.drawImage(canvas, 0, 0)
          }
          applyWarmthCanvas(octx, off.width, off.height, clipFx(layer.clip))
          applyEffectsCanvas(octx, off.width, off.height, clipFx(layer.clip), lutFor(clipFx(layer.clip)))
          ctx.save()
          ctx.globalAlpha = layer.opacity
          ctx.globalCompositeOperation = 'source-over'
          ctx.drawImage(off, 0, 0)
          ctx.restore()
          continue
        }
        const blend = layer.track === 'overlay' ? layer.blend : 'normal'
        const xformLive = selected && layer.clip.id === selected.id ? liveXformRef.current : null
        const clipForDraw =
          selected && layer.clip.id === selected.id && (masksLive || xformLive)
            ? {
                ...layer.clip,
                fx: {
                  ...layer.clip.fx,
                  ...(masksLive ? { masks: masksLive } : {}),
                  ...(xformLive ?? {})
                }
              }
            : layer.clip
        if (layer.kind === 'text') {
          drawTextLayer(ctx, layer.opacity, canvas.width, canvas.height, clipForDraw, blend, t)
          continue
        }
        if (layer.kind === 'shape') {
          drawShape(ctx, layer.opacity, canvas.width, canvas.height, clipForDraw, blend, t)
          continue
        }
        if (layer.kind === 'solid') {
          drawSolid(ctx, layer.opacity, canvas.width, canvas.height, clipForDraw, blend, t)
          continue
        }
        const el = nodesRef.current.get(layer.clip.assetId)
        if (!el || el instanceof HTMLAudioElement) continue
        drawLayer(ctx, el, layer.opacity, canvas.width, canvas.height, clipForDraw, blend, t, layer)
      }
      const fadeWhite = Math.max(0, ...nowLayers.map((l) => l.fadeWhite ?? 0))
      if (fadeWhite > 0) {
        ctx.save()
        ctx.fillStyle = `rgba(255,255,255,${fadeWhite})`
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.restore()
      }
      const fadeBlack = Math.max(0, ...nowLayers.map((l) => l.fadeBlack ?? 0))
      if (fadeBlack > 0) {
        ctx.save()
        ctx.fillStyle = `rgba(0,0,0,${fadeBlack})`
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.restore()
      }
      if (nowCue) {
        const style = subtitleStyleRef.current
        const size = Math.round((style?.fontSize ?? 42) * textScale(canvas.width, canvas.height))
        const preset = subtitlePreset(style)
        const color = style?.color ?? '#fff'
        const highlight = style?.highlightColor || DEFAULT_HIGHLIGHT
        const font = (px: number) => `600 ${px}px "PingFang SC", "Hiragino Sans GB", sans-serif`
        const wrapped = style ? { ...nowCue, text: wrapSubtitleText(nowCue.text, style, canvas.width, canvas.height) } : nowCue
        const lines: TextRun[][] =
          (preset === 'karaoke' ? karaokeLines(wrapped) : null) ??
          wrapped.text
            .split('\n')
            .map((line) => (preset === 'keyword' ? keywordRuns(line, style?.keywords) : line ? [{ text: line }] : []))
        const lineH = size * 1.3
        const blockH = lineH * lines.length
        const anchorY =
          style?.position === 'top'
            ? canvas.height * 0.1 + lineH / 2
            : style?.position === 'center'
              ? canvas.height / 2 - blockH / 2 + lineH / 2
              : canvas.height * 0.9 - blockH + lineH / 2
        ctx.save()
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.lineJoin = 'round'
        ctx.lineWidth = Math.max(2, size / 16)
        ctx.strokeStyle = style?.stroke ?? '#000'
        lines.forEach((runs, li) => {
          const y = anchorY + li * lineH
          const runSize = (r: TextRun) => (preset === 'keyword' && r.hit ? Math.round(size * 1.15) : size)
          const widths = runs.map((r) => {
            ctx.font = font(runSize(r))
            return ctx.measureText(r.text).width
          })
          const total = widths.reduce((n, w) => n + w, 0)
          let x = canvas.width / 2 - total / 2
          if (preset === 'boxed' && total > 0) {
            const pad = size * 0.22
            ctx.fillStyle = style?.boxColor || DEFAULT_BOX_COLOR
            ctx.globalAlpha = style?.boxOpacity ?? DEFAULT_BOX_OPACITY
            ctx.fillRect(x - pad, y - lineH / 2, total + pad * 2, lineH)
            ctx.globalAlpha = 1
          }
          runs.forEach((r, ri) => {
            ctx.font = font(runSize(r))
            const on =
              (preset === 'keyword' && r.hit) || (preset === 'karaoke' && r.startMs != null && t >= r.startMs)
            ctx.fillStyle = on ? highlight : color
            if (preset !== 'boxed') ctx.strokeText(r.text, x, y)
            ctx.fillText(r.text, x, y)
            x += widths[ri] ?? 0
          })
        })
        ctx.restore()
      }
      if (selected) {
        const fx = fxAt(
          {
            ...selected,
            fx: { ...selected.fx, ...(liveXformRef.current ?? {}), ...(masksLive ? { masks: masksLive } : {}) }
          },
          t
        )
        const src = clipSourceSize(selected, nodesRef.current, assets)
        const box = layerBox(fx, canvas.width, canvas.height, src.w, src.h)
        ctx.save()
        ctx.strokeStyle = 'rgba(90, 200, 255, 0.95)'
        ctx.lineWidth = Math.max(2, canvas.width / 700)
        ctx.strokeRect(box.x, box.y, box.w, box.h)
        const hs = Math.max(7, canvas.width / 140)
        ctx.fillStyle = '#fff'
        for (const [hx, hy] of [
          [box.x, box.y],
          [box.x + box.w / 2, box.y],
          [box.x + box.w, box.y],
          [box.x + box.w, box.y + box.h / 2],
          [box.x + box.w, box.y + box.h],
          [box.x + box.w / 2, box.y + box.h],
          [box.x, box.y + box.h],
          [box.x, box.y + box.h / 2]
        ] as const) {
          ctx.fillRect(hx - hs / 2, hy - hs / 2, hs, hs)
          ctx.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs)
        }
        ctx.restore()
        const masks = masksLive ?? fx.masks
        if (masks.length) {
          ctx.save()
          ctx.strokeStyle = 'rgba(255,220,80,0.95)'
          ctx.lineWidth = Math.max(2, canvas.width / 700)
          for (const mask of masks) {
            ctx.save()
            ctx.translate(box.x, box.y)
            pathMask(ctx, mask, box.w, box.h)
            ctx.stroke()
            const x = mask.x * box.w
            const y = mask.y * box.h
            const mw = mask.w * box.w
            const mh = mask.h * box.h
            const mhs = Math.max(6, canvas.width / 160)
            ctx.fillStyle = mask.id === activeMaskIdRef.current ? '#fff' : 'rgba(255,220,80,0.9)'
            for (const [hx, hy] of [
              [x, y],
              [x + mw, y],
              [x, y + mh],
              [x + mw, y + mh]
            ] as const) {
              ctx.fillRect(hx - mhs / 2, hy - mhs / 2, mhs, mhs)
            }
            ctx.restore()
          }
          ctx.restore()
        }
      }
    } catch {
      /* canvas/WebKit faults must not take down the window */
    }
  }

  function syncMedia(opts: { seek: boolean; play: boolean }) {
    const t = currentTimeMs()
    const tl = timelineRef.current
    const nowLayers = layersAt(tl, t)
    const nowStory = clipAtTime(tl.storyline, t)
    const playingNow = playingRef.current
    for (const layer of nowLayers) {
      const el = nodesRef.current.get(layer.clip.assetId)
      if (!(el instanceof HTMLVideoElement)) continue
      const local = Math.max(0, layer.sourceTimeMs / 1000)
      const fx = clipFx(layer.clip)
      el.muted = layer.track === 'overlay'
      if (layer.track === 'storyline') {
        try {
          el.volume = Math.min(1, Math.max(0, volumeAt(layer.clip, t)))
        } catch {
          /* ignore */
        }
      }
      if (fx.reverse || fx.freeze) {
        if (!el.paused) el.pause()
        if (opts.seek) seekMedia(el, local, 0.04)
        continue
      }
      try {
        el.playbackRate = (fx.speed || 1) * rateRef.current
      } catch {
        /* ignore */
      }
      if (playingNow) {
        if (opts.seek) seekMedia(el, local, 0.25)
        if (opts.play && el.paused) void el.play().catch(() => undefined)
      } else {
        if (!el.paused) el.pause()
        if (opts.seek) seekMedia(el, local, 0.04)
      }
    }
    // 闪避近似导出的侧链：故事线此刻有人声（按素材能量分析的语音段）才压低音乐
    const speaking = (() => {
      if (!tl.duck?.enabled || !nowStory || nowStory.volume <= 0) return false
      const speech = assetsRef.current.find((a) => a.id === nowStory.assetId)?.index?.speech
      if (!speech?.length) return true
      const src = sourceTimeMs(nowStory, t)
      return speech.some((r) => src >= r.startMs - 150 && src <= r.endMs + 300)
    })()
    for (const clip of tl.audio) {
      const el = nodesRef.current.get(`aud:${clip.id}`)
      if (!(el instanceof HTMLMediaElement)) continue
      const active = t >= clip.startMs && t < clip.startMs + clip.durationMs
      if (!active) {
        if (!el.paused) el.pause()
        continue
      }
      const fx = clipFx(clip)
      const local = ((t - clip.startMs) * (fx.speed || 1)) / 1000 + clip.inMs / 1000
      if (opts.seek) seekMedia(el, local, playingNow ? 0.25 : 0.04)
      const duck = clip.role !== 'dialog' && speaking ? tl.duck!.ratio : 1
      try {
        el.volume = Math.min(1, Math.max(0, volumeAt(clip, t) * duck))
        el.playbackRate = (fx.speed || 1) * rateRef.current
      } catch {
        /* ignore */
      }
      if (playingNow) {
        if (el.paused) {
          seekMedia(el, local, 0.04)
          if (opts.play || !opts.seek) void el.play().catch(() => undefined)
        }
      } else if (!el.paused) {
        el.pause()
      }
    }
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const nodes = nodesRef.current
    const keep = new Set<string>()
    for (const asset of visualAssets) {
      keep.add(asset.id)
      let el = nodes.get(asset.id)
      const url = mediaUrl(playbackPath(asset))
      if (asset.kind === 'image') {
        if (!(el instanceof HTMLImageElement)) {
          el?.remove()
          el = document.createElement('img')
          host.appendChild(el)
          nodes.set(asset.id, el)
        }
        if (el.src !== url) el.src = url
        el.onload = () => paint()
      } else {
        if (!(el instanceof HTMLVideoElement)) {
          el?.remove()
          const v = document.createElement('video')
          v.crossOrigin = 'anonymous'
          v.playsInline = true
          v.preload = 'auto'
          v.muted = true
          v.disablePictureInPicture = true
          v.width = Math.max(2, asset.width || 1920)
          v.height = Math.max(2, asset.height || 1080)
          v.addEventListener('loadeddata', () => paint())
          host.appendChild(v)
          el = v
          nodes.set(asset.id, el)
        }
        const v = el as HTMLVideoElement
        if (asset.width) v.width = asset.width
        if (asset.height) v.height = asset.height
        if (v.dataset.src !== url) {
          v.src = url
          v.dataset.src = url
        }
      }
    }
    for (const { clip, asset } of audioClips) {
      const key = `aud:${clip.id}`
      keep.add(key)
      let el = nodes.get(key)
      if (!(el instanceof HTMLAudioElement)) {
        el?.remove()
        const a = document.createElement('audio')
        a.preload = 'auto'
        a.crossOrigin = 'anonymous'
        host.appendChild(a)
        el = a
        nodes.set(key, el)
      }
      const url = mediaUrl(asset.path)
      if (el.dataset.src !== url) {
        el.src = url
        el.dataset.src = url
      }
    }
    for (const [id, el] of nodes) {
      if (!keep.has(id)) {
        el.remove()
        nodes.delete(id)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visualAssets, audioKey])

  useEffect(() => {
    if (playing) return
    syncMedia({ seek: true, play: false })
    paint()
  }, [playheadMs, playing, layers, audioKey, story, timeline.duck, cue, subtitleStyle, viewSize, selectedClip, liveMasks, liveXform, activeMaskId])

  useEffect(() => {
    if (!playing) {
      syncMedia({ seek: true, play: false })
      paint()
      return
    }
    clockRef.current = { originWall: performance.now(), originMs: playheadRef.current }
    syncMedia({ seek: true, play: true })
    let id = 0
    let lastCorrect = 0
    const loop = () => {
      const now = performance.now()
      if (now - lastCorrect > 400) {
        lastCorrect = now
        syncMedia({ seek: false, play: true })
      }
      paint()
      id = requestAnimationFrame(loop)
    }
    id = requestAnimationFrame(loop)
    return () => {
      cancelAnimationFrame(id)
      for (const el of nodesRef.current.values()) {
        if (el instanceof HTMLMediaElement && !el.paused) el.pause()
      }
    }
  }, [playing, rate])

  useEffect(() => {
    setLiveMasks(null)
    setLiveXform(null)
  }, [selectedClip?.id, selectedClip?.fx?.masks])

  function eventPos(e: { clientX: number; clientY: number }) {
    const canvas = canvasRef.current!
    const r = canvas.getBoundingClientRect()
    return {
      x: ((e.clientX - r.left) / Math.max(1, r.width)) * canvas.width,
      y: ((e.clientY - r.top) / Math.max(1, r.height)) * canvas.height
    }
  }

  function layerBoxAt(clip: TimelineClip, canvas: HTMLCanvasElement, t: number) {
    const fx = { ...fxAt(clip, t), ...(clip.id === selectedClip?.id ? liveXform ?? {} : {}) }
    const src = clipSourceSize(clip, nodesRef.current, assets)
    return { fx, src, box: layerBox(fx, canvas.width, canvas.height, src.w, src.h) }
  }

  function onCanvasPointerDown(e: ReactMouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas) return
    const p = eventPos(e)
    const t = playheadMs
    const layers = layersAt(timeline, t)

    if (selectedClip) {
      const { fx, src, box } = layerBoxAt(selectedClip, canvas, t)
      const hs = edgePad(box, canvas.width)
      const masks = liveMasks ?? fx.masks
      if (masks.length) {
        let maskHit: { maskId: string; mode: 'move' | 'resize' } | null = null
        for (let i = masks.length - 1; i >= 0; i--) {
          const mask = masks[i]
          const x = box.x + mask.x * box.w
          const y = box.y + mask.y * box.h
          const mw = mask.w * box.w
          const mh = mask.h * box.h
          const corners = [
            [x, y],
            [x + mw, y],
            [x, y + mh],
            [x + mw, y + mh]
          ]
          if (corners.some(([hx, hy]) => Math.abs(p.x - hx) <= hs && Math.abs(p.y - hy) <= hs)) {
            maskHit = { maskId: mask.id, mode: 'resize' }
            break
          }
          if (p.x >= x && p.x <= x + mw && p.y >= y && p.y <= y + mh) {
            maskHit = { maskId: mask.id, mode: 'move' }
            break
          }
        }
        if (maskHit) {
          e.preventDefault()
          e.stopPropagation()
          setActiveMaskId(maskHit.maskId)
          const orig = masks.find((m) => m.id === maskHit!.maskId)!
          dragRef.current = {
            kind: 'mask',
            maskId: maskHit.maskId,
            mode: maskHit.mode,
            startX: p.x,
            startY: p.y,
            orig: { ...orig }
          }
          const move = (ev: MouseEvent) => {
            const drag = dragRef.current
            if (!drag || drag.kind !== 'mask') return
            const q = eventPos(ev)
            const dx = (q.x - drag.startX) / box.w
            const dy = (q.y - drag.startY) / box.h
            let next = { ...drag.orig }
            if (drag.mode === 'move') next = { ...next, x: drag.orig.x + dx, y: drag.orig.y + dy }
            else next = { ...next, w: drag.orig.w + dx, h: drag.orig.h + dy }
            next = clampMask(next)
            const nextMasks = masks.map((m) => (m.id === drag.maskId ? next : m))
            liveRef.current = nextMasks
            setLiveMasks(nextMasks)
          }
          const up = () => {
            window.removeEventListener('mousemove', move)
            window.removeEventListener('mouseup', up)
            const drag = dragRef.current
            dragRef.current = null
            const edited = liveRef.current?.find((m) => m.id === (drag && drag.kind === 'mask' ? drag.maskId : ''))
            if (drag && drag.kind === 'mask' && edited && onAction) {
              onAction('set_mask', {
                clipId: selectedClip.id,
                maskId: drag.maskId,
                x: edited.x,
                y: edited.y,
                w: edited.w,
                h: edited.h
              })
            }
            liveRef.current = null
            setLiveMasks(null)
          }
          window.addEventListener('mousemove', move)
          window.addEventListener('mouseup', up)
          return
        }
      }
    }

    const beginXform = (clip: TimelineClip, handle: Handle, box: { x: number; y: number; w: number; h: number }, src: { w: number; h: number }, fx: ReturnType<typeof fxAt>) => {
      e.preventDefault()
      e.stopPropagation()
      onSelectClip?.(clip.id)
      const ax = axisScale(fx)
      const orig =
        clip.id === selectedClip?.id && liveXform
          ? liveXform
          : { posX: fx.posX, posY: fx.posY, scaleX: ax.x, scaleY: ax.y }
      dragRef.current = { kind: 'xform', clipId: clip.id, handle, startX: p.x, startY: p.y, orig, box, src }
      const move = (ev: MouseEvent) => {
        const drag = dragRef.current
        if (!drag || drag.kind !== 'xform') return
        const q = eventPos(ev)
        const dx = q.x - drag.startX
        const dy = q.y - drag.startY
        const next = resizeBox(drag.box, drag.handle, dx, dy, ev.shiftKey)
        const base =
          drag.src.w > 0 && drag.src.h > 0
            ? containBase(canvas.width, canvas.height, drag.src.w, drag.src.h)
            : { w: canvas.width, h: canvas.height }
        const xform: XformLive = {
          posX: (next.x + next.w / 2) / canvas.width,
          posY: (next.y + next.h / 2) / canvas.height,
          scaleX: Math.min(8, Math.max(0.05, next.w / Math.max(1, base.w))),
          scaleY: Math.min(8, Math.max(0.05, next.h / Math.max(1, base.h)))
        }
        if (drag.handle === 'move') {
          xform.posX = drag.orig.posX + dx / canvas.width
          xform.posY = drag.orig.posY + dy / canvas.height
          xform.scaleX = drag.orig.scaleX
          xform.scaleY = drag.orig.scaleY
        }
        liveXformRef.current = xform
        setLiveXform(xform)
      }
      const up = () => {
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        const drag = dragRef.current
        dragRef.current = null
        const xform = liveXformRef.current
        if (xform && onAction && drag && drag.kind === 'xform') {
          onAction('set_transform', {
            clipId: drag.clipId,
            x: xform.posX,
            y: xform.posY,
            scaleX: xform.scaleX,
            scaleY: xform.scaleY,
            scale: (xform.scaleX + xform.scaleY) / 2
          })
        }
        liveXformRef.current = null
        setLiveXform(null)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    }

    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]
      if (layer.kind === 'adjustment') continue
      const { fx, src, box } = layerBoxAt(layer.clip, canvas, t)
      const handle = hitHandle(p, box, edgePad(box, canvas.width))
      if (handle) {
        beginXform(layer.clip, handle, box, src, fx)
        return
      }
    }
    onToggle()
  }

  function onCanvasPointerMove(e: ReactMouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current
    if (!canvas || dragRef.current) return
    const p = eventPos(e)
    const t = playheadMs
    const layers = layersAt(timeline, t)
    let handle: Handle | null = null
    for (let i = layers.length - 1; i >= 0; i--) {
      const layer = layers[i]
      if (layer.kind === 'adjustment') continue
      const { box } = layerBoxAt(layer.clip, canvas, t)
      handle = hitHandle(p, box, edgePad(box, canvas.width))
      if (handle) break
    }
    canvas.style.cursor = cursorFor(handle)
  }

  return (
    <section className="panel viewer">
      <div className="viewer-stage" ref={stageRef}>
        {timeline.storyline.length || timeline.overlays.length ? (
          <canvas
            ref={canvasRef}
            width={viewSize.w}
            height={viewSize.h}
            onMouseDown={onCanvasPointerDown}
            onMouseMove={onCanvasPointerMove}
            onMouseLeave={(e) => {
              if (!dragRef.current) (e.currentTarget as HTMLCanvasElement).style.cursor = 'default'
            }}
          />
        ) : (
          <div className="viewer-empty">
            <b>还没有画面</b>
            <span>
              导入素材后双击加到主线，或在底部终端启动 claude 说「帮我粗剪」
            </span>
          </div>
        )}
        <div ref={hostRef} className="comp-media" aria-hidden />
      </div>
      <div className="transport">
        <span className="tc">{formatTimecode(playheadMs, true)}</span>
        <div className="transport-btns">
          <button type="button" className="icon-btn" title="上一帧 ←" onClick={() => onSeek(Math.max(0, playheadMs - 1000 / (settings.fps || 30)))}>
            <Icon name="prev" />
          </button>
          <button type="button" className="play-btn" title="播放 / 暂停 空格" onClick={onToggle}>
            <Icon name={playing ? 'pause' : 'play'} size={18} />
          </button>
          <button type="button" className="icon-btn" title="下一帧 →" onClick={() => onSeek(Math.min(durationMs || Infinity, playheadMs + 1000 / (settings.fps || 30)))}>
            <Icon name="next" />
          </button>
        </div>
        <span className="tc muted">
          {playing && rate !== 1 ? <b className="rate">{rate}×</b> : null}
          {formatTimecode(durationMs)}
        </span>
      </div>
    </section>
  )
}
