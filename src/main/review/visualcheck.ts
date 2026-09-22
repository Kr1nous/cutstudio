/**
 * 需要实际渲染画面的质检（review_timeline 工具里调用；check.ts 保持纯函数）。
 * 目前：B-roll 与讲解画面色调差异过大。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isFullFrameBroll } from '../../shared/broll'
import { LookAccumulator, type LookStats } from '../../shared/look'
import type { Project } from '../../shared/types'
import { findFfmpeg, runFfmpeg } from '../render/ffmpeg'
import { renderFrame } from '../render/frame'
import type { ReviewIssue } from './check'

/** 渲染时间线某一刻（不叠字幕），缩到 96×54 统计观感。 */
async function lookAt(p: Project, ffmpeg: string, dir: string, t: number): Promise<LookStats | null> {
  try {
    const png = join(dir, `f${Math.round(t)}.png`)
    await writeFile(png, await renderFrame(p, t))
    const r = await runFfmpeg(ffmpeg, ['-loglevel', 'error', '-i', png, '-vf', 'scale=96:54:flags=area,format=rgb24', '-f', 'rawvideo', 'pipe:1'])
    if (r.code !== 0 || r.stdout.length < 96 * 54 * 3) return null
    const acc = new LookAccumulator()
    acc.add(r.stdout.subarray(0, 96 * 54 * 3))
    return acc.result()
  } catch {
    return null
  }
}

/** 两个观感差多少：返回超标的项（中文），空数组表示接近。 */
export function lookMismatch(a: LookStats, b: LookStats): string[] {
  const out: string[] = []
  const dl = b.lumaMean - a.lumaMean
  if (Math.abs(dl) > 0.12) out.push(`亮度${dl > 0 ? '偏亮' : '偏暗'} ${Math.round(Math.abs(dl) * 100)}%`)
  const sa = Math.max(0.01, a.satMean)
  const ratio = Math.max(0.01, b.satMean) / sa
  if (a.satMean > 0.03 && (ratio > 1.6 || ratio < 1 / 1.6)) out.push(`饱和度${ratio > 1 ? '高' : '低'} ${ratio > 1 ? ratio.toFixed(1) : (1 / ratio).toFixed(1)} 倍`)
  const dw = b.warmth - a.warmth
  if (Math.abs(dw) > 0.07) out.push(dw > 0 ? '偏暖' : '偏冷')
  return out
}

/** 每段铺满画面的 B-roll：取它中间一帧和紧挨着它的讲解画面一帧对比（最多检查 12 段）。 */
export async function brollColorIssues(p: Project): Promise<ReviewIssue[]> {
  const brolls = p.timeline.overlays.filter(isFullFrameBroll).slice(0, 12)
  if (!brolls.length) return []
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) return []
  const story = p.timeline.storyline
  const storyEnd = story.reduce((m, c) => Math.max(m, c.startMs + c.durationMs), 0)
  const covered = (t: number) => brolls.some((b) => t >= b.startMs && t < b.startMs + b.durationMs)
  const dir = await mkdtemp(join(tmpdir(), 'cut-lookcheck-'))
  const issues: ReviewIssue[] = []
  try {
    for (const b of brolls) {
      // 讲解画面：B-roll 前 400ms，被别的 B-roll 盖住或在开头时取结尾后 400ms
      const candidates = [b.startMs - 400, b.startMs + b.durationMs + 400].filter((t) => t >= 0 && t < storyEnd && !covered(t))
      if (!candidates.length) continue
      const ref = await lookAt(p, ffmpeg, dir, candidates[0]!)
      const own = await lookAt(p, ffmpeg, dir, b.startMs + b.durationMs / 2)
      if (!ref || !own) continue
      const diff = lookMismatch(ref, own)
      if (!diff.length) continue
      const talk = story.find((c) => candidates[0]! >= c.startMs && candidates[0]! < c.startMs + c.durationMs)
      issues.push({
        severity: 'warn',
        code: 'broll_color_mismatch',
        atMs: b.startMs,
        clipId: b.id,
        message: `B-roll 和旁边的讲解画面色调差得多（${diff.join('、')}），切过去会跳；可用 color_match refClipId=${talk?.id ?? '<讲解片段>'} clipIds=${b.id}`
      })
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
  return issues
}
