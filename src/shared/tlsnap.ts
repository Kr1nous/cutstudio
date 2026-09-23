/**
 * 时间线交互的纯函数：吸附点、吸附、刻度间隔、故事线拖动插入位置。界面和 verify 共用。
 */
import type { Timeline, TimelineClip, TimelineMarker } from './types'

const end = (c: { startMs: number; durationMs: number }) => c.startMs + c.durationMs

/** 可吸附的时间点：0、播放头、各轨片段首尾、字幕首尾、标记、入出点（去掉正在拖动的对象自己）。 */
export function snapCandidates(
  timeline: Timeline,
  opts: { markers?: TimelineMarker[]; playheadMs?: number; extra?: (number | null | undefined)[]; excludeIds?: string[] } = {}
): number[] {
  const skip = new Set(opts.excludeIds ?? [])
  const out = new Set<number>([0])
  if (opts.playheadMs != null) out.add(Math.round(opts.playheadMs))
  const clips: TimelineClip[] = [...timeline.storyline, ...timeline.overlays, ...timeline.audio]
  for (const c of clips) {
    if (skip.has(c.id)) continue
    out.add(c.startMs)
    out.add(end(c))
  }
  for (const cue of timeline.subtitles) {
    if (skip.has(cue.id)) continue
    out.add(cue.startMs)
    out.add(cue.endMs)
  }
  for (const m of opts.markers ?? []) out.add(m.atMs)
  for (const x of opts.extra ?? []) if (x != null && Number.isFinite(x)) out.add(x)
  return [...out].sort((a, b) => a - b)
}

/** 把 ms 吸到阈值内最近的候选点；没有就原样返回，snapped 为 null。 */
export function snapMs(ms: number, candidates: number[], thresholdMs: number): { ms: number; snapped: number | null } {
  let best: number | null = null
  let bestD = thresholdMs
  for (const c of candidates) {
    const d = Math.abs(c - ms)
    if (d <= bestD) {
      best = c
      bestD = d
    }
  }
  return best == null ? { ms, snapped: null } : { ms: best, snapped: best }
}

/** 移动一个块：首或尾哪边离吸附点近就吸哪边，返回新的起点和参考线位置。 */
export function snapBlock(
  startMs: number,
  durationMs: number,
  candidates: number[],
  thresholdMs: number
): { startMs: number; guide: number | null } {
  const a = snapMs(startMs, candidates, thresholdMs)
  const b = snapMs(startMs + durationMs, candidates, thresholdMs)
  const da = a.snapped == null ? Infinity : Math.abs(a.snapped - startMs)
  const db = b.snapped == null ? Infinity : Math.abs(b.snapped - (startMs + durationMs))
  if (da === Infinity && db === Infinity) return { startMs: Math.max(0, startMs), guide: null }
  if (da <= db) return { startMs: Math.max(0, a.ms), guide: a.snapped }
  return { startMs: Math.max(0, b.ms - durationMs), guide: b.snapped }
}

/** 刻度间隔：保证相邻刻度至少 minPx 像素。pps = 每秒像素。 */
export function tickStepMs(pps: number, minPx = 70): number {
  const steps = [100, 250, 500, 1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000]
  for (const s of steps) if ((s / 1000) * pps >= minPx) return s
  return steps.at(-1)!
}

/** 故事线拖动：按各片段中点算出 dragged 应插入的位置，返回新的 id 顺序。 */
export function storylineOrderAfterDrag(storyline: TimelineClip[], draggedId: string, atMs: number): string[] {
  const rest = storyline.filter((c) => c.id !== draggedId)
  let index = rest.length
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i]!
    if (atMs < c.startMs + c.durationMs / 2) {
      index = i
      break
    }
  }
  const ids = rest.map((c) => c.id)
  ids.splice(index, 0, draggedId)
  return ids
}

/** 插入位置在时间线上的横坐标（ms），用于画插入指示线。 */
export function storylineInsertMs(storyline: TimelineClip[], draggedId: string, atMs: number): number {
  const order = storylineOrderAfterDrag(storyline, draggedId, atMs)
  const i = order.indexOf(draggedId)
  const rest = storyline.filter((c) => c.id !== draggedId)
  if (i >= rest.length) return rest.length ? end(rest.at(-1)!) : 0
  return rest[i]!.startMs
}
