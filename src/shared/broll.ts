/**
 * B-roll 纯逻辑：按台词定位（整句 / 词）、起点吸附、叠加层重叠和跨句检查。
 * craft.ts（insert_broll / adjust_broll）和 review/check.ts 共用，单测在 render/verify-broll.ts。
 */
import { axisScale } from './mask'
import { CLAUSE_END, SENTENCE_END, normalizeForMatch, splitSentences, stripTrailingPunct, timelineWords, type TimelineWord } from './transcript'
import { clipFx, clipKind, type Project, type TimelineClip } from './types'

type ProjectLike = Pick<Project, 'timeline' | 'transcript'>

/** 离片段 / 时间线开头、上一段 B-roll 结尾不到这么多毫秒时吸附过去，避免闪一下讲解画面。 */
export const BROLL_SNAP_MS = 500
/** 盖进下一句 / 跨句判定的容差（词时间戳误差）。 */
export const SENTENCE_TOL_MS = 150

export interface TimelineSentence {
  id: string
  text: string
  /** 时间线上第一个 / 最后一个能听到的词。 */
  startMs: number
  endMs: number
  words: TimelineWord[]
}

/** 时间线上能听到的句子（按时间线顺序；整句被剪掉的不出现）。 */
export function timelineSentences(project: ProjectLike): TimelineSentence[] {
  const heard = timelineWords(project)
  const byKey = new Map<string, TimelineWord[]>()
  for (const w of heard) {
    const k = `${w.assetId}:${w.srcStartMs}:${w.srcEndMs}`
    const list = byKey.get(k) ?? []
    list.push(w)
    byKey.set(k, list)
  }
  const out: TimelineSentence[] = []
  for (const s of splitSentences(project)) {
    const words = s.words.flatMap((w) => byKey.get(`${w.assetId}:${w.startMs}:${w.endMs}`) ?? []).sort((a, b) => a.startMs - b.startMs)
    if (!words.length) continue
    out.push({ id: s.id, text: s.text, startMs: words[0]!.startMs, endMs: Math.max(...words.map((w) => w.endMs)), words })
  }
  return out.sort((a, b) => a.startMs - b.startMs)
}

export interface TextHit {
  /** 句子里实际命中的那段文字（原文，保留中间的标点，去掉末尾标点）。 */
  matchedText: string
  sentenceId: string
  sentenceText: string
  sentenceStartMs: number
  sentenceEndMs: number
  /** 命中文字本身在时间线上的起止。 */
  wordStartMs: number
  wordEndMs: number
  /** 命中文字所在分句（逗号类 / 句末标点之间）的时间线起止。 */
  clauseStartMs: number
  clauseEndMs: number
}

/**
 * 在时间线上找一段台词（忽略空白和标点）第一次出现的位置（按时间线顺序）。
 * 只在还能听到的词里找：被剪掉的词不参与匹配。
 */
export function findTextHit(project: ProjectLike, text: string): TextHit | null {
  const needle = normalizeForMatch(text)
  if (!needle) return null
  for (const s of timelineSentences(project)) {
    // 逐词累积归一化文字，记录每个字符属于哪个词
    let flat = ''
    const owner: number[] = []
    s.words.forEach((w, i) => {
      const n = normalizeForMatch(w.text)
      flat += n
      for (let k = 0; k < n.length; k++) owner.push(i)
    })
    const idx = flat.indexOf(needle)
    if (idx < 0) continue
    const firstI = owner[idx]!
    const lastI = owner[idx + needle.length - 1]!
    const first = s.words[firstI]!
    const last = s.words[lastI]!
    // 分句：往前找到上一个以标点结尾的词之后，往后找到以标点结尾的词
    const ends = (w: { text: string }) => CLAUSE_END.test(w.text) || SENTENCE_END.test(w.text)
    let cs = firstI
    while (cs > 0 && !ends(s.words[cs - 1]!)) cs--
    let ce = lastI
    while (ce < s.words.length - 1 && !ends(s.words[ce]!)) ce++
    return {
      clauseStartMs: s.words[cs]!.startMs,
      clauseEndMs: s.words[ce]!.endMs,
      matchedText: stripTrailingPunct(
        s.words
          .slice(owner[idx]!, owner[idx + needle.length - 1]! + 1)
          .map((w) => w.text)
          .join('')
      ),
      sentenceId: s.id,
      sentenceText: s.text,
      sentenceStartMs: s.startMs,
      sentenceEndMs: s.endMs,
      wordStartMs: first.startMs,
      wordEndMs: last.endMs
    }
  }
  return null
}

/** 铺满画面、不透明、没蒙版的素材叠加层 = B-roll（画中画、文字、调整层不算）。 */
export function isFullFrameBroll(clip: TimelineClip): boolean {
  if (clipKind(clip) !== 'footage' || !clip.assetId) return false
  const fx = clipFx(clip)
  const ax = axisScale(fx)
  return Math.min(ax.x, ax.y) >= 0.999 && !fx.masks.length && (fx.opacity ?? 1) >= 0.95
}

/**
 * 起点吸附：往前 BROLL_SNAP_MS 以内有时间线开头、故事线片段开头或上一段 B-roll 的结尾时，挪过去。
 * 只往前吸，不往后吸（往后会盖不住那句话的开头）。
 */
export function snapBrollStart(timeline: Pick<Project['timeline'], 'storyline' | 'overlays'>, startMs: number, excludeId?: string): number {
  const anchors = [0, ...timeline.storyline.map((c) => c.startMs)]
  for (const o of timeline.overlays) if (o.id !== excludeId && isFullFrameBroll(o)) anchors.push(o.startMs + o.durationMs)
  let best = startMs
  for (const a of anchors) {
    const gap = startMs - a
    if (gap > 0 && gap < BROLL_SNAP_MS && a < best) best = a
  }
  // 阈值内有多个锚点时取最早的：中间剩下的讲解画面都短于 500ms，一起盖掉
  return best
}

/** 与 [startMs, endMs) 重叠的其他 B-roll 叠加层（重叠 > 40ms）。 */
export function overlappingBroll(overlays: TimelineClip[], startMs: number, endMs: number, excludeId?: string): TimelineClip[] {
  return overlays.filter(
    (o) => o.id !== excludeId && isFullFrameBroll(o) && Math.min(endMs, o.startMs + o.durationMs) - Math.max(startMs, o.startMs) > 40
  )
}

/** 区间的边界落在句子中间（离句首句尾都超过容差）时返回那句。 */
function sentenceAround(sentences: TimelineSentence[], t: number): TimelineSentence | null {
  return sentences.find((s) => t > s.startMs + SENTENCE_TOL_MS && t < s.endMs - SENTENCE_TOL_MS) ?? null
}

export interface SentenceCrossing {
  /** 被盖住开头的那句 */
  next: TimelineSentence
  /** B-roll 结尾（或开头）落在哪句中间 */
  midSentence: TimelineSentence
  edge: 'start' | 'end'
}

/**
 * B-roll 从一句中间开始或结束，并且盖住了另一句的开头 → 画面切换点和话语不同步。
 * 从句首盖到句尾、连着盖几整句都不算。
 */
export function brollSentenceCrossing(sentences: TimelineSentence[], startMs: number, endMs: number): SentenceCrossing | null {
  const covered = sentences.filter((s) => s.startMs > startMs + SENTENCE_TOL_MS && s.startMs < endMs - SENTENCE_TOL_MS)
  if (!covered.length) return null
  const endIn = sentenceAround(sentences, endMs)
  if (endIn && covered.includes(endIn)) return { next: endIn, midSentence: endIn, edge: 'end' }
  const startIn = sentenceAround(sentences, startMs)
  if (startIn) return { next: covered[0]!, midSentence: startIn, edge: 'start' }
  return null
}

/** 新 B-roll 盖进了下一句（插在某句上，结尾越过下一句开头超过容差）。 */
export function spillsIntoNext(sentences: TimelineSentence[], sentenceId: string, endMs: number): TimelineSentence | null {
  const i = sentences.findIndex((s) => s.id === sentenceId)
  const next = i >= 0 ? sentences[i + 1] : undefined
  return next && endMs > next.startMs + SENTENCE_TOL_MS ? next : null
}
