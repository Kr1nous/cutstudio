/**
 * 片段按时间切块：关键帧重映射、把片段裁到时间线窗口、把整个工程裁成一段（render_preview 用）。
 * 纯函数，不改输入。
 */
import { sampleKeys } from './anim'
import { packStorylineClips } from './compose'
import { type AnimKey, type AnimProp, type Project, type TimelineClip, clipFx } from './types'

/**
 * 片段内 0–1 关键帧 → 只保留 [f0, f1] 这一段并重新归一化到 0–1。
 * 两端补上插值出来的关键帧，缓动沿用所在区间的缓动（区间被截断时缓动曲线是近似的）。
 */
export function sliceKeys(keys: AnimKey[] | undefined, f0: number, f1: number): AnimKey[] | undefined {
  if (!keys?.length) return keys
  const span = f1 - f0
  if (span <= 1e-6) return keys
  if (f0 <= 1e-6 && f1 >= 1 - 1e-6) return keys
  const sorted = [...keys].sort((a, b) => a.t - b.t)
  const fallback = sorted[0]!.value
  const easeAt = (f: number) => [...sorted].reverse().find((k) => k.t <= f + 1e-9)?.ease ?? sorted[0]!.ease ?? 'linear'
  const inner = sorted.filter((k) => k.t > f0 + 1e-6 && k.t < f1 - 1e-6).map((k) => ({ ...k, t: round4((k.t - f0) / span) }))
  return [
    { t: 0, value: round4(sampleKeys(sorted, f0, fallback)), ease: easeAt(f0) },
    ...inner,
    { t: 1, value: round4(sampleKeys(sorted, f1, fallback)), ease: easeAt(f1) }
  ]
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}

/** 所有关键帧轨道都截到 [f0, f1]。 */
export function sliceAllKeys(keys: Partial<Record<AnimProp, AnimKey[]>> | undefined, f0: number, f1: number): Partial<Record<AnimProp, AnimKey[]>> | undefined {
  if (!keys) return keys
  const out: Partial<Record<AnimProp, AnimKey[]>> = {}
  for (const [prop, track] of Object.entries(keys) as [AnimProp, AnimKey[] | undefined][]) {
    const s = sliceKeys(track, f0, f1)
    if (s) out[prop] = s
  }
  return out
}

/**
 * 片段按「片段内时间」[local0, local1)（毫秒）截取一段：源入出点按速度 / 倒放换算，关键帧重映射，
 * 被截掉的那一端去掉淡入淡出 / 出点转场。startMs 保持原位置 + local0（调用方自己决定是否平移）。
 */
export function cutClip(clip: TimelineClip, local0: number, local1: number): TimelineClip {
  const fx = clipFx(clip)
  const d = Math.max(1, clip.durationMs)
  const a = Math.max(0, Math.min(d, local0))
  const b = Math.max(a, Math.min(d, local1))
  const speed = Math.max(0.25, fx.speed || 1)
  let inMs = clip.inMs
  let outMs = clip.outMs
  if (fx.freeze) {
    // 冻结帧：源区间不变，只改时长
  } else if (fx.reverse) {
    inMs = clip.outMs - b * speed
    outMs = clip.outMs - a * speed
  } else {
    inMs = clip.inMs + a * speed
    outMs = clip.inMs + b * speed
  }
  const headCut = a > 0.5
  const tailCut = b < d - 0.5
  return {
    ...clip,
    startMs: clip.startMs + a,
    durationMs: b - a,
    inMs: Math.round(inMs * 1000) / 1000,
    outMs: Math.round(outMs * 1000) / 1000,
    fx: {
      ...clip.fx,
      ...(headCut ? { fadeInMs: 0 } : {}),
      ...(tailCut ? { fadeOutMs: 0, transitionOut: { type: 'none' as const, durationMs: 0 } } : {}),
      keys: sliceAllKeys(clip.fx?.keys, a / d, b / d)
    }
  }
}

/** 片段裁到时间线窗口 [winStart, winEnd) 并平移到从 0 开始；不相交返回 null。 */
export function clipToWindow(clip: TimelineClip, winStart: number, winEnd: number): TimelineClip | null {
  const s = clip.startMs
  const e = clip.startMs + clip.durationMs
  const a = Math.max(s, winStart)
  const b = Math.min(e, winEnd)
  if (b - a < 1) return null
  const c = cutClip(clip, a - s, b - s)
  return { ...c, startMs: a - winStart }
}

/**
 * 把工程裁成时间线 [startMs, endMs) 这一段（从 0 开始），给预览渲染用。不改输入工程。
 * 窗口边界上的转场按硬切处理（最后一段的出点转场去掉）。
 */
export function sliceProject(project: Project, startMs: number, endMs: number): Project {
  const tl = project.timeline
  const story = [...tl.storyline].sort((x, y) => x.startMs - y.startMs)
  const kept = story.map((c) => clipToWindow(c, startMs, endMs)).filter((c): c is TimelineClip => c != null)
  const last = kept.at(-1)
  if (last) last.fx = { ...last.fx, transitionOut: { type: 'none', durationMs: 0 } }
  packStorylineClips(kept)
  const layer = (list: TimelineClip[]) => list.map((c) => clipToWindow(c, startMs, endMs)).filter((c): c is TimelineClip => c != null)
  const subtitles = tl.subtitles
    .filter((c) => c.endMs > startMs && c.startMs < endMs)
    .map((c) => ({
      ...c,
      startMs: Math.max(0, c.startMs - startMs),
      endMs: Math.min(endMs, c.endMs) - startMs,
      ...(c.words
        ? { words: c.words.filter((w) => w.endMs > startMs && w.startMs < endMs).map((w) => ({ ...w, startMs: Math.max(0, w.startMs - startMs), endMs: Math.min(endMs, w.endMs) - startMs })) }
        : {})
    }))
  return {
    ...project,
    timeline: { ...tl, storyline: kept, overlays: layer(tl.overlays), audio: layer(tl.audio), subtitles }
  }
}
