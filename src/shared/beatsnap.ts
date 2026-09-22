/**
 * 切点对齐音乐节拍（snap_cuts_to_beats）：用「滚动剪辑」挪切点——前一段出点和后一段入点同时挪同样的时间，
 * 总时长和其他片段位置都不变。只在被露出 / 被盖掉的那一小段源素材都是静音或停顿、且没有转写词时才挪，
 * 免得切到字中间。
 */
import { assetWords } from './transcript'
import { type Project, type TimeRange, type TimelineClip, clipFx, clipKind } from './types'

export interface BeatMove {
  /** 原切点（时间线毫秒） */
  atMs: number
  toMs: number
  deltaMs: number
  prevClipId: string
  nextClipId: string
}

export interface BeatSnapPlan {
  storyline: TimelineClip[]
  moves: BeatMove[]
  skipped: { atMs: number; reason: string }[]
  /** 已经在拍子上（|差| < 15ms）的切点数 */
  onBeat: number
}

/** 音乐片段上的拍子 → 时间线毫秒（只取片段可见范围内的）。 */
export function beatsOnTimeline(clip: TimelineClip, beats: number[]): number[] {
  const speed = Math.max(0.25, clipFx(clip).speed || 1)
  return beats
    .filter((b) => b >= clip.inMs && b <= clip.outMs)
    .map((b) => clip.startMs + (b - clip.inMs) / speed)
    .filter((t) => t <= clip.startMs + clip.durationMs)
}

function coveredBy(ranges: TimeRange[], a: number, b: number, tol = 10): boolean {
  if (b - a <= 0) return true
  // 合并后看 [a, b] 是否被完整覆盖
  const sorted = ranges.filter((r) => r.endMs > a - tol && r.startMs < b + tol).sort((x, y) => x.startMs - y.startMs)
  let t = a
  for (const r of sorted) {
    if (r.startMs > t + tol) return false
    t = Math.max(t, r.endMs)
    if (t >= b - tol) return true
  }
  return t >= b - tol
}

export function planBeatSnap(
  project: Pick<Project, 'timeline' | 'transcript' | 'assets'>,
  beatTimes: number[],
  toleranceMs = 150,
  minClipMs = 300
): BeatSnapPlan {
  const story = [...project.timeline.storyline].sort((a, b) => a.startMs - b.startMs).map((c) => ({ ...c }))
  const words = assetWords(project)
  const beats = [...beatTimes].sort((a, b) => a - b)
  const moves: BeatMove[] = []
  const skipped: BeatSnapPlan['skipped'] = []
  let onBeat = 0
  const quiet = (assetId: string, a: number, b: number): boolean => {
    const asset = project.assets.find((x) => x.id === assetId)
    const index = asset?.index
    if (!index) return false
    if ((words.get(assetId) ?? []).some((w) => w.endMs > a + 5 && w.startMs < b - 5)) return false
    return coveredBy([...index.silence, ...(index.pauses ?? [])], a, b)
  }
  for (let i = 0; i < story.length - 1; i++) {
    const A = story[i]!
    const B = story[i + 1]!
    const cut = A.startMs + A.durationMs
    const fa = clipFx(A)
    const fb = clipFx(B)
    if (clipKind(A) !== 'footage' || clipKind(B) !== 'footage') continue
    if (A.assetId === B.assetId && Math.abs(B.inMs - A.outMs) < 2 && !fa.reverse && !fb.reverse) continue // 连续素材的分割点，看不出切点
    const near = beats.reduce<number | null>((best, t) => (Math.abs(t - cut) <= toleranceMs && (best == null || Math.abs(t - cut) < Math.abs(best - cut)) ? t : best), null)
    if (near == null) {
      skipped.push({ atMs: Math.round(cut), reason: `${toleranceMs}ms 内没有拍子` })
      continue
    }
    const d = near - cut
    if (Math.abs(d) < 15) {
      onBeat++
      continue
    }
    if (fa.transitionOut.type !== 'none' && fa.transitionOut.durationMs > 0) {
      skipped.push({ atMs: Math.round(cut), reason: `切点有 ${fa.transitionOut.type} 转场` })
      continue
    }
    if (fa.reverse || fb.reverse || fa.freeze || fb.freeze) {
      skipped.push({ atMs: Math.round(cut), reason: '倒放 / 冻结帧片段' })
      continue
    }
    if (A.durationMs + d < minClipMs || B.durationMs - d < minClipMs) {
      skipped.push({ atMs: Math.round(cut), reason: `挪完片段会短于 ${minClipMs}ms` })
      continue
    }
    const sa = Math.max(0.25, fa.speed || 1)
    const sb = Math.max(0.25, fb.speed || 1)
    const assetA = project.assets.find((x) => x.id === A.assetId)
    // d > 0：A 多露出源 [out, out+d·sa]，B 盖掉源 [in, in+d·sb]；d < 0：A 盖掉 [out−|d|·sa, out]，B 露出 [in−|d|·sb, in]
    const aRange: [number, number] = d > 0 ? [A.outMs, A.outMs + d * sa] : [A.outMs + d * sa, A.outMs]
    const bRange: [number, number] = d > 0 ? [B.inMs, B.inMs + d * sb] : [B.inMs + d * sb, B.inMs]
    if (d > 0 && assetA?.kind === 'video' && assetA.durationMs && aRange[1] > assetA.durationMs) {
      skipped.push({ atMs: Math.round(cut), reason: '前一段素材后面没有余量' })
      continue
    }
    if (d < 0 && bRange[0] < 0) {
      skipped.push({ atMs: Math.round(cut), reason: '后一段素材前面没有余量' })
      continue
    }
    if (!quiet(A.assetId, aRange[0], aRange[1]) || !quiet(B.assetId, bRange[0], bRange[1])) {
      skipped.push({ atMs: Math.round(cut), reason: '切点两侧不是静音 / 停顿（挪了会切到字）' })
      continue
    }
    A.outMs = Math.round(A.outMs + d * sa)
    A.durationMs = A.durationMs + d
    B.inMs = Math.round(B.inMs + d * sb)
    B.durationMs = B.durationMs - d
    B.startMs = B.startMs + d
    moves.push({ atMs: Math.round(cut), toMs: Math.round(near), deltaMs: Math.round(d), prevClipId: A.id, nextClipId: B.id })
  }
  return { storyline: story, moves, skipped, onBeat }
}
