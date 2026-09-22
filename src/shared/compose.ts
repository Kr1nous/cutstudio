import { fxAt } from './anim'
import { clipBlend, clipFx, clipKind } from './types'
import type { AspectPreset, BlendMode, ClipFx, Project, ProjectSettings, Timeline, TimelineClip } from './types'
import { easeInOutCubic, transitionSpec } from './transition'

export function evenDim(n: number): number {
  const x = Math.max(2, Math.round(n))
  return x % 2 === 0 ? x : x + 1
}

export function aspectFromSize(width: number, height: number): AspectPreset {
  const r = width / Math.max(1, height)
  if (Math.abs(r - 1) < 0.08) return '1:1'
  if (r < 0.9) return '9:16'
  return '16:9'
}

export function applySourceFrame(settings: ProjectSettings, width: number, height: number): boolean {
  if (!width || !height) return false
  const w = evenDim(width)
  const h = evenDim(height)
  if (settings.width === w && settings.height === h) return false
  settings.width = w
  settings.height = h
  settings.aspect = aspectFromSize(w, h)
  return true
}

export function shouldAdoptSourceFrame(project: Project): boolean {
  if (project.settings.manualFrame) return false
  const visuals = project.assets.filter((a) => a.kind === 'video' || a.kind === 'image')
  if (visuals.length <= 1) return true
  return !project.settings.width || (project.settings.width === 1920 && project.settings.height === 1080)
}

export function dissolveOverlapMs(clip: TimelineClip): number {
  const fx = clipFx(clip)
  const spec = transitionSpec(fx.transitionOut.type)
  if (!spec.overlap) return 0
  return Math.max(0, fx.transitionOut.durationMs)
}

export function packStorylineClips(clips: TimelineClip[]): void {
  clips.sort((a, b) => a.startMs - b.startMs)
  let t = 0
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    clip.startMs = t
    const next = clips[i + 1]
    let overlap = 0
    if (next) {
      overlap = Math.min(
        dissolveOverlapMs(clip),
        Math.max(0, clip.durationMs - 1),
        Math.max(0, next.durationMs - 1)
      )
    }
    t += clip.durationMs - overlap
  }
}

export function sourceTimeMs(clip: TimelineClip, timeMs: number): number {
  const fx = clipFx(clip)
  const speed = fx.speed || 1
  if (fx.freeze) return Math.max(clip.inMs, Math.min(clip.outMs - 1, fx.freezeAtMs ?? clip.inMs))
  const local = timeMs - clip.startMs
  if (fx.reverse) return clip.outMs - local * speed
  return clip.inMs + local * speed
}

function fadeOutMs(fx: ClipFx): number {
  if (fx.transitionOut.type === 'fade_black') return Math.max(fx.transitionOut.durationMs, fx.fadeOutMs)
  return fx.fadeOutMs
}

export function opacityAt(clip: TimelineClip, timeMs: number, prev?: TimelineClip | null): number {
  const fx = clipFx(clip)
  const local = timeMs - clip.startMs
  if (local < 0 || local >= clip.durationMs) return 0
  let a = fxAt(clip, timeMs).opacity
  let fadeIn = fx.fadeInMs
  if (prev && clipFx(prev).transitionOut.type === 'fade_black') {
    fadeIn = Math.max(fadeIn, clipFx(prev).transitionOut.durationMs)
  }
  if (fadeIn > 0 && local < fadeIn) a *= local / fadeIn
  const outMs = fadeOutMs(fx)
  if (outMs > 0) {
    const outStart = clip.durationMs - outMs
    if (local > outStart) a *= Math.max(0, (clip.durationMs - local) / outMs)
  }
  return Math.min(1, Math.max(0, a))
}

export type CompLayer = {
  clip: TimelineClip
  track: 'storyline' | 'overlay'
  opacity: number
  sourceTimeMs: number
  blend: BlendMode
  kind: ReturnType<typeof clipKind>
  slide?: number
  slideY?: number
  zoom?: number
  wipe?: { dir: 'left' | 'right' | 'up' | 'down'; t: number }
  iris?: number
  blur?: number
  fadeWhite?: number
  fadeBlack?: number
}

export function canvasComposite(mode: BlendMode): 'source-over' | 'lighter' | 'screen' | 'multiply' {
  if (mode === 'add') return 'lighter'
  if (mode === 'screen') return 'screen'
  if (mode === 'multiply') return 'multiply'
  return 'source-over'
}

export function ffmpegBlendMode(mode: BlendMode): string | null {
  if (mode === 'add') return 'addition'
  if (mode === 'screen') return 'screen'
  if (mode === 'multiply') return 'multiply'
  return null
}

export function overlayLanes(clips: TimelineClip[]): number[] {
  const lanes: number[] = []
  for (let i = 0; i < clips.length; i++) {
    const used = new Set<number>()
    const c = clips[i]
    for (let j = 0; j < i; j++) {
      const o = clips[j]
      if (c.startMs < o.startMs + o.durationMs && o.startMs < c.startMs + c.durationMs) used.add(lanes[j])
    }
    let lane = 0
    while (used.has(lane)) lane++
    lanes.push(lane)
  }
  return lanes
}

export function layersAt(timeline: Timeline, timeMs: number): CompLayer[] {
  const layers: CompLayer[] = []
  const story = timeline.storyline
    .filter((c) => timeMs >= c.startMs && timeMs < c.startMs + c.durationMs)
    .sort((a, b) => a.startMs - b.startMs)

  if (story.length >= 2) {
    const first = story[0]
    const second = story[1]
    const overlap = dissolveOverlapMs(first)
    const raw = overlap > 0 ? Math.min(1, Math.max(0, (timeMs - second.startMs) / overlap)) : 0.5
    const p = easeInOutCubic(raw)
    const firstPrev = prevClip(timeline.storyline, first)
    const spec = transitionSpec(clipFx(first).transitionOut.type)
    const a0 = opacityAt(first, timeMs, firstPrev)
    const a1 = opacityAt(second, timeMs, first)
    const out: CompLayer = {
      clip: first,
      track: 'storyline',
      opacity: a0,
      sourceTimeMs: sourceTimeMs(first, timeMs),
      blend: clipBlend(first),
      kind: clipKind(first)
    }
    const inn: CompLayer = {
      clip: second,
      track: 'storyline',
      opacity: a1,
      sourceTimeMs: sourceTimeMs(second, timeMs),
      blend: clipBlend(second),
      kind: clipKind(second)
    }
    if (spec.preview === 'slide') {
      if (spec.dir === 'left' || spec.type === 'cover') {
        if (spec.type === 'cover') {
          inn.slide = p - 1
        } else {
          out.slide = p
          inn.slide = p - 1
        }
      } else {
        out.slide = -p
        inn.slide = 1 - p
      }
      layers.push(out, inn)
    } else if (spec.preview === 'wipe') {
      const dir = spec.dir ?? 'left'
      inn.wipe = { dir, t: p }
      if (spec.type === 'reveal') {
        out.slide = dir === 'right' ? p : dir === 'left' ? -p : 0
        out.slideY = dir === 'up' ? -p : dir === 'down' ? p : 0
        layers.push(inn, out)
      } else {
        layers.push(out, inn)
      }
    } else if (spec.preview === 'zoom') {
      out.zoom = 1 + p * 0.14
      out.opacity = a0 * (1 - p)
      inn.zoom = 1.14 - p * 0.14
      inn.opacity = a1 * p
      layers.push(out, inn)
    } else if (spec.preview === 'iris') {
      inn.iris = p
      layers.push(out, inn)
    } else if (spec.preview === 'blur') {
      const bump = Math.sin(p * Math.PI) * 14
      out.blur = bump
      inn.blur = bump
      out.opacity = a0 * (1 - p)
      inn.opacity = a1 * p
      layers.push(out, inn)
    } else if (spec.preview === 'dip') {
      const black = p < 0.5 ? p * 2 : (1 - p) * 2
      out.opacity = a0 * Math.max(0, 1 - p * 2)
      inn.opacity = a1 * Math.max(0, p * 2 - 1)
      if (spec.type === 'fade_white') {
        out.fadeWhite = black
        inn.fadeWhite = black
      } else {
        out.fadeBlack = black
        inn.fadeBlack = black
      }
      layers.push(out, inn)
    } else {
      out.opacity = a0 * (1 - p)
      inn.opacity = a1 * p
      layers.push(out, inn)
    }
  } else if (story.length === 1) {
    const clip = story[0]
    layers.push({
      clip,
      track: 'storyline',
      opacity: opacityAt(clip, timeMs, prevClip(timeline.storyline, clip)),
      sourceTimeMs: sourceTimeMs(clip, timeMs),
      blend: clipBlend(clip),
      kind: clipKind(clip)
    })
  }

  for (const clip of timeline.overlays) {
    if (timeMs >= clip.startMs && timeMs < clip.startMs + clip.durationMs) {
      layers.push({
        clip,
        track: 'overlay',
        opacity: opacityAt(clip, timeMs),
        sourceTimeMs: sourceTimeMs(clip, timeMs),
        blend: clipBlend(clip),
        kind: clipKind(clip)
      })
    }
  }
  return layers
}

function prevClip(clips: TimelineClip[], clip: TimelineClip): TimelineClip | null {
  const i = clips.findIndex((c) => c.id === clip.id)
  return i > 0 ? clips[i - 1] : null
}

export function even(n: number): number {
  return evenDim(n)
}

/**
 * sourceTimeMs 的反函数：素材源时间 → 时间线时间（考虑 speed / reverse）。
 * 不做裁剪，源时间落在 [inMs, outMs] 之外时结果也会落在片段之外；冻结帧返回片段起点。
 */
export function timelineTimeMs(clip: TimelineClip, sourceMs: number): number {
  const fx = clipFx(clip)
  const speed = fx.speed || 1
  if (fx.freeze) return clip.startMs
  if (fx.reverse) return clip.startMs + (clip.outMs - sourceMs) / speed
  return clip.startMs + (sourceMs - clip.inMs) / speed
}

/** 把一段源时间区间映射到时间线，并裁到片段可见范围；完全不在片段内时返回 null。 */
export function sourceRangeToTimeline(clip: TimelineClip, startMs: number, endMs: number): { startMs: number; endMs: number } | null {
  const a = Math.max(startMs, clip.inMs)
  const b = Math.min(endMs, clip.outMs)
  if (b <= a || clipFx(clip).freeze) return null
  const t0 = timelineTimeMs(clip, a)
  const t1 = timelineTimeMs(clip, b)
  const lo = Math.max(clip.startMs, Math.min(t0, t1))
  const hi = Math.min(clip.startMs + clip.durationMs, Math.max(t0, t1))
  return hi > lo ? { startMs: lo, endMs: hi } : null
}
