/**
 * 变速曲线（speed_ramp）：导出链路每个片段只支持恒定速度，所以把片段按曲线切成 ≤ maxSegments 段恒速子片段。
 * 每段速度取「保持该段总时长不变」的平均（源时长 / ∫ ds / rate(s)，即调和平均）。
 */
import { easeFn } from './anim'
import { type EaseKind, type TimelineClip, clipFx } from './types'

export const RAMP_MIN_RATE = 0.25
export const RAMP_MAX_RATE = 4

export interface RampPoint {
  /** 时间线毫秒（按变速前的片段位置） */
  atMs: number
  rate: number
}

export interface RampSegment {
  inMs: number
  outMs: number
  rate: number
  /** 变速后在时间线上的时长 */
  durationMs: number
}

export interface RampPlan {
  segments: RampSegment[]
  /** 变速后片段总时长 */
  durationMs: number
  warnings: string[]
}

const clampRate = (r: number) => Math.min(RAMP_MAX_RATE, Math.max(RAMP_MIN_RATE, r))

/**
 * points 的 atMs 是变速前的时间线位置，换算成源时间后在源时间上插值：
 * 第一个点之前用第一个点的 rate，最后一个点之后用最后一个点的 rate，点之间按 ease 过渡。
 */
export function planSpeedRamp(
  clip: TimelineClip,
  points: RampPoint[],
  opts: { ease?: EaseKind; maxSegments?: number; minSegmentMs?: number } = {}
): RampPlan {
  const fx = clipFx(clip)
  if (fx.reverse || fx.freeze) throw new Error('倒放 / 冻结帧片段不支持变速曲线')
  if (!points.length) throw new Error('points 至少要一个点')
  const ease = opts.ease ?? 'ease_in_out'
  const maxSeg = Math.max(1, Math.min(8, opts.maxSegments ?? 8))
  const minSeg = opts.minSegmentMs ?? 250
  const warnings: string[] = []
  const s0 = Math.max(0.25, fx.speed || 1)
  const toSrc = (t: number) => clip.inMs + (t - clip.startMs) * s0
  const pts = points
    .map((p) => ({ src: Math.min(clip.outMs, Math.max(clip.inMs, toSrc(p.atMs))), rate: clampRate(p.rate), raw: p }))
    .sort((a, b) => a.src - b.src)
  if (points.some((p) => p.atMs < clip.startMs - 1 || p.atMs > clip.startMs + clip.durationMs + 1)) {
    warnings.push(`有 point 落在片段（${Math.round(clip.startMs)}–${Math.round(clip.startMs + clip.durationMs)}ms）之外，已夹到片段边界。`)
  }
  if (points.some((p) => p.rate !== clampRate(p.rate))) warnings.push(`rate 超出 ${RAMP_MIN_RATE}–${RAMP_MAX_RATE}，已夹紧。`)
  // 同一位置的多个点只留最后一个
  const uniq = pts.filter((p, i) => !pts.slice(i + 1).some((q) => Math.abs(q.src - p.src) < 1))

  const rateAt = (s: number): number => {
    if (s <= uniq[0]!.src) return uniq[0]!.rate
    const lastP = uniq.at(-1)!
    if (s >= lastP.src) return lastP.rate
    for (let i = 0; i < uniq.length - 1; i++) {
      const a = uniq[i]!
      const b = uniq[i + 1]!
      if (s <= b.src) return a.rate + (b.rate - a.rate) * easeFn((s - a.src) / Math.max(1e-6, b.src - a.src), ease)
    }
    return lastP.rate
  }
  /** [u, v] 源区间在时间线上的时长 = ∫ ds / rate(s) */
  const tlLen = (u: number, v: number): number => {
    const n = 32
    let sum = 0
    for (let i = 0; i < n; i++) sum += 1 / rateAt(u + ((v - u) * (i + 0.5)) / n)
    return ((v - u) * sum) / n
  }

  // 区间：片段入点、各点、出点
  const bounds = [clip.inMs, ...uniq.map((p) => p.src).filter((s) => s > clip.inMs + 1 && s < clip.outMs - 1), clip.outMs]
  const intervals = bounds.slice(0, -1).map((u, i) => {
    const v = bounds[i + 1]!
    const ramp = Math.abs(rateAt(u) - rateAt(v)) > 0.01
    return { u, v, ramp, pieces: 1, weight: ramp ? Math.abs(rateAt(u) - rateAt(v)) * tlLen(u, v) : 0 }
  })
  if (intervals.length > maxSeg) throw new Error(`points 太多：切成 ${intervals.length} 段超过上限 ${maxSeg}，请减少变速点。`)
  // 剩余段数分给变速区间：按「变化幅度 × 时长 / 已分段数」贪心，每段至少 minSeg 毫秒
  let spare = maxSeg - intervals.length
  while (spare > 0) {
    const cand = intervals
      .filter((iv) => iv.ramp && tlLen(iv.u, iv.v) / (iv.pieces + 1) >= minSeg)
      .sort((a, b) => b.weight / b.pieces - a.weight / a.pieces)[0]
    if (!cand) break
    cand.pieces++
    spare--
  }
  const raw: RampSegment[] = []
  for (const iv of intervals) {
    for (let k = 0; k < iv.pieces; k++) {
      const u = iv.u + ((iv.v - iv.u) * k) / iv.pieces
      const v = iv.u + ((iv.v - iv.u) * (k + 1)) / iv.pieces
      const dur = tlLen(u, v)
      raw.push({ inMs: u, outMs: v, rate: clampRate((v - u) / dur), durationMs: dur })
    }
  }
  // 相邻同速合并
  const segments: RampSegment[] = []
  for (const seg of raw) {
    const prev = segments.at(-1)
    if (prev && Math.abs(prev.rate - seg.rate) < 0.01) {
      prev.outMs = seg.outMs
      prev.durationMs += seg.durationMs
      prev.rate = (prev.outMs - prev.inMs) / prev.durationMs
    } else segments.push({ ...seg })
  }
  for (const seg of segments) {
    seg.inMs = Math.round(seg.inMs)
    seg.outMs = Math.round(seg.outMs)
    seg.rate = Math.round(seg.rate * 1000) / 1000
    seg.durationMs = Math.max(1, (seg.outMs - seg.inMs) / seg.rate)
  }
  const tiny = segments.filter((s) => s.durationMs < 300).length
  if (tiny) warnings.push(`${tiny} 段变速子片段短于 300ms，快进段过短会像跳帧；可以减少 points 或放宽变速区间。`)
  return { segments, durationMs: segments.reduce((n, s) => n + s.durationMs, 0), warnings }
}
