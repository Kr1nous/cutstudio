/**
 * 给剪辑结果打分（满分 100）：对照评测素材的真值检查内容取舍、停顿、字幕，再叠加 review_timeline 的问题。
 */
import { sourceRangeToTimeline } from '../../shared/compose'
import { type Project, clipFx, timelineDurationMs } from '../../shared/types'
import { coverScale } from '../../shared/reframe'
import { reviewTimeline } from '../review/check'
import type { Fixture } from './fixture'

export type SegmentResult = {
  text: string
  shouldCut: string | null
  /** 源区间在成片里能听到的比例 0–1 */
  audible: number
  timelineStartMs: number | null
  timelineEndMs: number | null
}

export type ScoreReport = {
  score: number
  durationMs: number
  segments: SegmentResult[]
  penalties: { reason: string; points: number }[]
  metrics: {
    unwantedKept: number
    contentLost: number
    maxPauseMs: number
    longPauses: number
    subtitleCoverage: number
    subtitleCount: number
    jumpCutTransitions: number
    reviewErrors: number
    reviewWarns: number
  }
  review: { severity: string; code: string; message: string }[]
}

function audibleSpans(project: Project, assetId: string, startMs: number, endMs: number) {
  const spans: { startMs: number; endMs: number }[] = []
  let heard = 0
  for (const clip of project.timeline.storyline) {
    if (clip.assetId !== assetId || clip.volume <= 0.01) continue
    const a = Math.max(startMs, clip.inMs)
    const b = Math.min(endMs, clip.outMs)
    if (b <= a) continue
    const tl = sourceRangeToTimeline(clip, a, b)
    if (!tl) continue
    heard += b - a
    spans.push(tl)
  }
  return { ratio: Math.min(1, heard / Math.max(1, endMs - startMs)), spans: spans.sort((x, y) => x.startMs - y.startMs) }
}

export type ScoreExpect = {
  aspect?: '16:9' | '9:16' | '1:1'
  /** 讲到 keyword 时应出现素材名为 name 的 B-roll（叠加层） */
  broll?: { name: string; keyword: string }[]
}

export function scoreProject(project: Project, fixture: Fixture, talkAssetId: string, expect: ScoreExpect = {}): ScoreReport {
  const penalties: ScoreReport['penalties'] = []
  const penalize = (reason: string, points: number) => penalties.push({ reason, points })

  if (expect.aspect) {
    if (project.settings.aspect !== expect.aspect) penalize(`画幅应为 ${expect.aspect}，实际 ${project.settings.aspect}`, 25)
    const dst = expect.aspect === '9:16' ? 9 / 16 : expect.aspect === '1:1' ? 1 : 16 / 9
    const letterboxed = project.timeline.storyline.filter((c) => {
      const a = project.assets.find((x) => x.id === c.assetId)
      if (!a?.width || !a.height || (c.kind ?? 'footage') !== 'footage') return false
      const fx = clipFx(c)
      const need = coverScale(a.width, a.height, dst)
      return Math.min(fx.scaleX ?? fx.scale, fx.scaleY ?? fx.scale) < need * 0.98
    })
    if (letterboxed.length) penalize(`${letterboxed.length} 个片段没有铺满 ${expect.aspect} 画布（有黑边）`, 15)
    const maxChars = expect.aspect === '9:16' ? 16 : 22
    const long = project.timeline.subtitles.filter((c) => c.text.split('\n').some((l) => [...l].length > maxChars * 1.25)).length
    if (long) penalize(`${long} 条字幕单行超过 ${maxChars} 字`, Math.min(10, long * 2))
  }

  if (expect.broll?.length) {
    for (const b of expect.broll) {
      const seg = fixture.timings.find((t) => t.segment.text.includes(b.keyword))
      const asset = project.assets.find((a) => a.name === b.name)
      if (!seg || !asset) continue
      const spoken = audibleSpans(project, talkAssetId, seg.startMs, seg.endMs).spans
      if (!spoken.length) continue
      const from = spoken[0]!.startMs
      const to = spoken.at(-1)!.endMs
      const layers = project.timeline.overlays.filter((c) => c.assetId === asset.id)
      if (!layers.length) {
        penalize(`讲到「${b.keyword}」时没有插入 ${b.name}`, 12)
        continue
      }
      const hit = layers.find((c) => c.startMs < to && c.startMs + c.durationMs > from && c.startMs >= from - 1500)
      if (!hit) penalize(`${b.name} 插入位置不对（应在「${b.keyword}」那句 ${Math.round(from)}–${Math.round(to)}ms）`, 8)
      else if (hit.durationMs < 1200 || hit.durationMs > 6000) penalize(`${b.name} 时长 ${Math.round(hit.durationMs)}ms 不合适（建议 2–5 秒）`, 3)
      else {
        // 特写要配着那句话出现：盖住的说话时间 < 60% 说明插偏了或太短
        const said = to - from
        const covered = Math.max(0, Math.min(to, hit.startMs + hit.durationMs) - Math.max(from, hit.startMs))
        if (said > 0 && covered / said < 0.6) penalize(`${b.name} 只盖住「${b.keyword}」那句的 ${Math.round((covered / said) * 100)}%`, 3)
      }
      const fx = hit ? clipFx(hit) : null
      if (fx && (fx.opacity ?? 1) < 0.95) penalize(`${b.name} 透明度过低，看不清`, 3)
    }
  }

  const segments: SegmentResult[] = fixture.timings.map(({ segment, startMs, endMs }) => {
    const { ratio, spans } = audibleSpans(project, talkAssetId, startMs, endMs)
    return {
      text: segment.text,
      shouldCut: segment.shouldCut ?? null,
      audible: Math.round(ratio * 100) / 100,
      timelineStartMs: spans[0]?.startMs ?? null,
      timelineEndMs: spans.at(-1)?.endMs ?? null
    }
  })

  let unwantedKept = 0
  let contentLost = 0
  for (const s of segments) {
    if (s.shouldCut && s.audible >= 0.5) {
      unwantedKept++
      penalize(`应删未删（${s.shouldCut}）：「${s.text}」`, s.shouldCut === 'retake' ? 15 : 8)
    }
    if (!s.shouldCut && s.audible < 0.5) {
      contentLost++
      penalize(`误删正文：「${s.text}」`, 20)
    } else if (!s.shouldCut && s.audible < 0.92) {
      penalize(`正文被切掉一部分（${Math.round((1 - s.audible) * 100)}%）：「${s.text}」`, 6)
    }
  }

  // 相邻保留句之间的停顿（时间线上）
  const kept = segments
    .filter((s) => s.timelineStartMs != null && s.audible >= 0.5)
    .sort((a, b) => a.timelineStartMs! - b.timelineStartMs!)
  let maxPauseMs = 0
  let longPauses = 0
  for (let i = 1; i < kept.length; i++) {
    const gap = kept[i]!.timelineStartMs! - kept[i - 1]!.timelineEndMs!
    maxPauseMs = Math.max(maxPauseMs, gap)
    if (gap > 700) {
      longPauses++
      penalize(`句间停顿过长 ${gap}ms：「${kept[i - 1]!.text}」→「${kept[i]!.text}」`, 4)
    }
  }

  // 字幕覆盖：保留句的发声时间有多少被字幕盖住
  const subs = project.timeline.subtitles
  let speechMs = 0
  let coveredMs = 0
  for (const s of kept.filter((x) => !x.shouldCut)) {
    const a = s.timelineStartMs!
    const b = s.timelineEndMs!
    speechMs += b - a
    for (const c of subs) coveredMs += Math.max(0, Math.min(b, c.endMs) - Math.max(a, c.startMs))
  }
  const subtitleCoverage = speechMs ? Math.min(1, coveredMs / speechMs) : 0
  if (subtitleCoverage < 0.85) penalize(`字幕只覆盖了 ${Math.round(subtitleCoverage * 100)}% 的说话时间`, Math.round((0.85 - subtitleCoverage) * 30) + 5)

  const review = reviewTimeline(project)
  const reviewErrors = review.filter((i) => i.severity === 'error').length
  const reviewWarns = review.filter((i) => i.severity === 'warn').length
  const jumpCutTransitions = review.filter((i) => i.code === 'dissolve_on_jump_cut').length
  for (const i of review) {
    if (i.severity === 'error') penalize(`质检错误 ${i.code}：${i.message}`, 8)
    if (i.severity === 'warn') penalize(`质检警告 ${i.code}：${i.message}`, i.code === 'dissolve_on_jump_cut' ? 5 : 3)
  }

  // 过度加速会让口播不自然
  const fast = project.timeline.storyline.filter((c) => clipFx(c).speed > 1.16).length
  if (fast) penalize(`${fast} 个片段加速超过 1.15x`, 5)

  const total = penalties.reduce((n, p) => n + p.points, 0)
  return {
    score: Math.max(0, 100 - total),
    durationMs: timelineDurationMs(project.timeline),
    segments,
    penalties,
    metrics: {
      unwantedKept,
      contentLost,
      maxPauseMs,
      longPauses,
      subtitleCoverage: Math.round(subtitleCoverage * 100) / 100,
      subtitleCount: subs.length,
      jumpCutTransitions,
      reviewErrors,
      reviewWarns
    },
    review: review.map((i) => ({ severity: i.severity, code: i.code, message: i.message }))
  }
}
