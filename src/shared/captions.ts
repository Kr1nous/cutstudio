import type { ClipSource, Project, SubtitleCue } from './types'
import {
  CLAUSE_END,
  SENTENCE_END,
  joinWords,
  stripTrailingPunct,
  textUnits,
  timelineWords,
  type TimelineWord
} from './transcript'

export interface CaptionOptions {
  /** 每行最多字数（中文字符计 1，拉丁字符计 0.5）。竖屏建议 16，横屏 22。 */
  maxChars: number
  maxLines?: 1 | 2
  minMs?: number
  maxMs?: number
  /** 词间停顿超过它视为可断点。 */
  pauseMs?: number
  source?: ClipSource
  /** 生成 id；默认 sub_<序号>。main 里可传 () => id('sub')。 */
  makeId?: () => string
}

/** 断点强度：3 句末，2 逗号类 / cue 结尾，1 停顿或剪辑点，0 不宜断。 */
function breakScore(w: TimelineWord, next: TimelineWord | undefined, pauseMs: number): number {
  if (!next) return 3
  if (SENTENCE_END.test(w.text)) return 3
  if (CLAUSE_END.test(w.text)) return 2
  const gap = next.startMs - w.endMs
  const cut = next.clipId !== w.clipId || next.srcStartMs < w.srcEndMs - 1
  if (w.cueEnd && gap > 120) return 2
  if (gap > pauseMs || cut) return 1
  return 0
}

/** 字幕里的标点：中文语境下半角 , ; : ? ! 转全角（whisper 常输出半角）；行尾逗号句号仍由 stripTrailingPunct 去掉。 */
export function subtitlePunct(text: string): string {
  const cjk = /[\u3400-\u9fff\uf900-\ufaff]/
  const map: Record<string, string> = { ',': '，', ';': '；', ':': '：', '?': '？', '!': '！' }
  let out = ''
  const chars = [...text]
  chars.forEach((ch, i) => {
    const full = map[ch]
    if (!full) return void (out += ch)
    const prev = chars.slice(0, i).reverse().find((c) => c.trim())
    const next = chars.slice(i + 1).find((c) => c.trim())
    out += (prev && cjk.test(prev)) || (next && cjk.test(next)) ? full : ch
  })
  return out.replace(/\s*([，；：？！])\s*/g, '$1')
}

function lineText(words: TimelineWord[]): string {
  return stripTrailingPunct(subtitlePunct(joinWords(words.map((w) => w.text))))
}

function unitsOf(words: TimelineWord[]): number {
  return textUnits(lineText(words))
}

/** 在最接近中点的“词边界”处把一行拆成两行，优先标点后。 */
function splitTwoLines(words: TimelineWord[], maxChars: number): string {
  const text = lineText(words)
  if (textUnits(text) <= maxChars || words.length < 2) return text
  const total = textUnits(text)
  let best = -1
  let bestCost = Infinity
  for (let k = 0; k < words.length - 1; k++) {
    const left = unitsOf(words.slice(0, k + 1))
    if (left > maxChars || unitsOf(words.slice(k + 1)) > maxChars) continue
    const punct = CLAUSE_END.test(words[k]!.text) || SENTENCE_END.test(words[k]!.text)
    const cost = Math.abs(left - total / 2) - (punct ? maxChars * 0.25 : 0)
    if (cost < bestCost) {
      bestCost = cost
      best = k
    }
  }
  if (best < 0) return text
  const a = lineText(words.slice(0, best + 1))
  const b = lineText(words.slice(best + 1))
  return `${a}\n${b}`
}

/**
 * 从转写生成字幕（时间线时间）。只使用故事线/音频轨里仍然能听到的词；
 * 在句末 > 逗号/cue 结尾 > 停顿/剪辑点处断句，不在词中间断。
 */
export function buildCaptions(project: Pick<Project, 'timeline' | 'transcript'>, opts: CaptionOptions): SubtitleCue[] {
  const maxChars = Math.max(4, opts.maxChars)
  const lines = opts.maxLines ?? 1
  const capacity = maxChars * lines
  const minMs = opts.minMs ?? 700
  const maxMs = opts.maxMs ?? 4500
  const pauseMs = opts.pauseMs ?? 250
  let seq = 0
  const makeId = opts.makeId ?? (() => `sub_${++seq}`)
  const words = timelineWords(project)
  const groups: TimelineWord[][] = []
  let buf: TimelineWord[] = []

  const emit = (count: number) => {
    if (count <= 0) return
    groups.push(buf.slice(0, count))
    buf = buf.slice(count)
  }
  /**
   * 缓冲区超限时切一刀：优先标点 / 停顿断点；带到下一条的字数（加上到下一个强断点前还剩的字）至少 3 字，
   * 避免「基本原 / 则」这种孤字行；没有合适断点时按词往前挪。
   */
  const emitBest = (i: number) => {
    let k2 = i
    while (k2 < words.length - 1 && breakScore(words[k2]!, words[k2 + 1], pauseMs) < 2) k2++
    const tail = k2 > i ? unitsOf(words.slice(i + 1, k2 + 1)) : 0
    const carriedOk = (k: number) => unitsOf(buf.slice(k + 1)) + tail >= 3
    let bestK = -1
    let bestScore = 0
    for (let k = 0; k < buf.length - 1; k++) {
      const sc = breakScore(buf[k]!, buf[k + 1], pauseMs)
      if (sc === 0 || !carriedOk(k)) continue
      if (unitsOf(buf.slice(0, k + 1)) < capacity * 0.25) continue
      if (sc > bestScore || (sc === bestScore && k > bestK)) {
        bestScore = sc
        bestK = k
      }
    }
    if (bestK < 0) {
      for (let k = buf.length - 2; k >= 0; k--) {
        if (unitsOf(buf.slice(0, k + 1)) < capacity * 0.4) break
        if (carriedOk(k)) {
          bestK = k
          break
        }
      }
    }
    emit(bestK >= 0 ? bestK + 1 : buf.length - 1 > 0 ? buf.length - 1 : buf.length)
  }

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const next = words[i + 1]
    buf.push(w)
    const overflow = () => {
      if (buf.length < 2) return false
      if (buf[buf.length - 1]!.endMs - buf[0]!.startMs > maxMs) return true
      // 严格执行每行字数：宁可多一条字幕，也不超宽
      return unitsOf(buf) > capacity
    }
    while (overflow()) emitBest(i)
    const score = breakScore(w, next, pauseMs)
    const units = unitsOf(buf)
    const gap = next ? next.startMs - w.endMs : Infinity
    if (
      score === 3 ||
      gap > 700 ||
      (score === 2 && units >= maxChars * 0.4) ||
      (score === 1 && units >= maxChars * 0.35)
    ) {
      emit(buf.length)
    }
  }
  emit(buf.length)

  const cues: SubtitleCue[] = []
  for (const g of groups) {
    const text = lines === 2 ? splitTwoLines(g, maxChars) : lineText(g)
    if (!text.replace(/[\s\p{P}\p{S}]/gu, '')) continue
    const cueWords = g.map((w, i) => ({
      text: i === g.length - 1 ? stripTrailingPunct(w.text) || w.text : w.text,
      startMs: w.startMs,
      endMs: w.endMs
    }))
    cues.push({
      id: makeId(),
      startMs: g[0]!.startMs,
      endMs: Math.max(...g.map((w) => w.endMs)),
      text,
      source: opts.source ?? 'ai',
      words: cueWords
    })
  }
  // 最短时长：向后延伸，但不压到下一条；与下一条间隙 < 200ms 时直接接上，避免闪烁
  for (let i = 0; i < cues.length; i++) {
    const c = cues[i]!
    const next = cues[i + 1]
    const limit = next ? next.startMs : Infinity
    if (c.endMs - c.startMs < minMs) c.endMs = Math.min(c.startMs + minMs, limit)
    if (next && next.startMs - c.endMs > 0 && next.startMs - c.endMs < 200) c.endMs = next.startMs
    c.endMs = Math.max(c.endMs, c.startMs + 1)
  }
  return cues
}
