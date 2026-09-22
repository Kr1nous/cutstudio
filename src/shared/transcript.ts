import { sourceRangeToTimeline } from './compose'
import type { Project, TimelineClip, TranscriptCue } from './types'

/** 词（素材源时间）。 */
export interface SrcWord {
  text: string
  startMs: number
  endMs: number
  assetId: string
  cueIndex: number
  /** 所在 cue 的最后一个词。 */
  cueEnd: boolean
  /** cue 没有词级时间戳，按字数均分出来的。 */
  synthetic?: boolean
  /** 识别置信度 0–1（有的话）。 */
  p?: number
}

export interface Sentence {
  /** `${assetId}#${序号}`，转写不变时稳定。 */
  id: string
  assetId: string
  text: string
  startMs: number
  endMs: number
  words: SrcWord[]
}

/** 映射到时间线的词。 */
export interface TimelineWord {
  text: string
  startMs: number
  endMs: number
  assetId: string
  srcStartMs: number
  srcEndMs: number
  clipId: string
  cueEnd: boolean
}

export const SENTENCE_END = /[。！？!?…．.]["”’』」)）]*$/
export const CLAUSE_END = /[，、；：,;:—]+["”’)）]*$/
const PUNCT_ONLY = /^[\s\p{P}\p{S}]+$/u

export function isCjkChar(ch: string): boolean {
  return /[぀-ヿ㐀-鿿豈-﫿가-힯＀-￯　-〿]/.test(ch)
}

/** 显示宽度：中日韩字符 1，其它 0.5；用于字幕每行字数。 */
export function textUnits(s: string): number {
  let n = 0
  for (const ch of s) n += isCjkChar(ch) ? 1 : 0.5
  return n
}

/** 拼接词：拉丁词之间加空格，中文直接相连。 */
export function joinWords(parts: string[]): string {
  let out = ''
  for (const p of parts) {
    if (!p) continue
    if (out && /[A-Za-z0-9%'")\].,!?;:]$/.test(out) && /^[A-Za-z0-9("'[]/.test(p)) out += ' '
    out += p
  }
  return out
}

/** 去掉行尾逗号句号类标点（保留问号叹号省略号）。 */
export function stripTrailingPunct(s: string): string {
  return s.replace(/[，,。.、；;：:\s]+$/u, '')
}

export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function splitSynthetic(text: string): string[] {
  const units: string[] = []
  for (const tok of text.trim().split(/\s+/)) {
    if (!tok) continue
    if (![...tok].some(isCjkChar)) {
      units.push(tok)
      continue
    }
    let latin = ''
    for (const ch of tok) {
      if (PUNCT_ONLY.test(ch) && units.length && !latin) {
        units[units.length - 1] += ch
      } else if (isCjkChar(ch)) {
        if (latin) units.push(latin)
        latin = ''
        units.push(ch)
      } else latin += ch
    }
    if (latin) units.push(latin)
  }
  return units
}

function cueWords(cue: TranscriptCue, assetId: string, cueIndex: number): SrcWord[] {
  if (cue.words?.length) {
    return cue.words
      .filter((w) => w.text.trim())
      .map((w, i, arr) => ({
        text: w.text.trim(),
        startMs: w.startMs,
        endMs: Math.max(w.startMs, w.endMs),
        assetId,
        cueIndex,
        cueEnd: i === arr.length - 1,
        ...(w.p != null ? { p: w.p } : {})
      }))
  }
  const units = splitSynthetic(cue.text)
  if (!units.length) return []
  const total = units.reduce((n, u) => n + Math.max(0.5, textUnits(u.replace(/[\p{P}\p{S}]/gu, ''))), 0)
  const span = Math.max(0, cue.endMs - cue.startMs)
  let acc = 0
  return units.map((u, i) => {
    const w = Math.max(0.5, textUnits(u.replace(/[\p{P}\p{S}]/gu, '')))
    const a = cue.startMs + (span * acc) / total
    acc += w
    const b = cue.startMs + (span * acc) / total
    return { text: u, startMs: Math.round(a), endMs: Math.round(b), assetId, cueIndex, cueEnd: i === units.length - 1, synthetic: true }
  })
}

/** 每个素材的全部词，按源时间排序。没有 assetId 的旧转写被忽略。 */
export function assetWords(project: Pick<Project, 'transcript'>): Map<string, SrcWord[]> {
  const map = new Map<string, SrcWord[]>()
  project.transcript.forEach((cue, i) => {
    if (!cue.assetId) return
    const list = map.get(cue.assetId) ?? []
    list.push(...cueWords(cue, cue.assetId, i))
    map.set(cue.assetId, list)
  })
  for (const list of map.values()) list.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
  return map
}

/**
 * 断句：句末标点处断；cue 结尾处也断，除非该转写本身带标点、cue 没以标点结尾且下一段紧接着（< 300ms）；
 * 词间停顿 > 1200ms 也断。
 */
export function splitSentences(project: Pick<Project, 'transcript'>, byAsset = assetWords(project)): Sentence[] {
  const out: Sentence[] = []
  const punctuated = project.transcript.some((c) => /[。！？!?.，,]/.test(c.text))
  for (const [assetId, words] of byAsset) {
    let buf: SrcWord[] = []
    let n = 0
    const flush = () => {
      if (!buf.length) return
      const text = joinWords(buf.map((w) => w.text))
      if (normalizeForMatch(text)) {
        out.push({
          id: `${assetId}#${n++}`,
          assetId,
          text,
          startMs: buf[0]!.startMs,
          endMs: Math.max(...buf.map((w) => w.endMs)),
          words: buf
        })
      }
      buf = []
    }
    words.forEach((w, i) => {
      buf.push(w)
      const next = words[i + 1]
      const gap = next ? next.startMs - w.endMs : Infinity
      if (SENTENCE_END.test(w.text) || gap > 1200) return flush()
      if (w.cueEnd) {
        const continues = punctuated && !CLAUSE_END.test(w.text) && gap < 300
        if (!continues) flush()
      }
    })
    flush()
  }
  return out
}

/** 参与语音的片段：故事线 + 音频轨上的素材片段，静音片段除外。 */
export function speechClips(project: Pick<Project, 'timeline'>): TimelineClip[] {
  return [...project.timeline.storyline, ...project.timeline.audio]
    .filter((c) => (!c.kind || c.kind === 'footage') && c.assetId && c.volume > 0)
    .sort((a, b) => a.startMs - b.startMs)
}

/** 词在片段中可见（源区间至少一半在 in/out 内）时映射到时间线。 */
export function mapWord(clip: TimelineClip, w: { startMs: number; endMs: number }): { startMs: number; endMs: number } | null {
  const len = w.endMs - w.startMs
  if (len <= 0) {
    if (w.startMs < clip.inMs || w.startMs >= clip.outMs) return null
    const r = sourceRangeToTimeline(clip, w.startMs, w.startMs + 1)
    return r ? { startMs: r.startMs, endMs: r.startMs } : null
  }
  const visible = Math.min(w.endMs, clip.outMs) - Math.max(w.startMs, clip.inMs)
  if (visible < len * 0.5) return null
  return sourceRangeToTimeline(clip, w.startMs, w.endMs)
}

/** 时间线上实际能听到的词，按时间线时间排序；溶解重叠导致的重复词只保留一次。 */
export function timelineWords(project: Pick<Project, 'timeline' | 'transcript'>): TimelineWord[] {
  const byAsset = assetWords(project)
  const out: TimelineWord[] = []
  const lastSeen = new Map<string, number>()
  for (const clip of speechClips(project)) {
    const words = byAsset.get(clip.assetId)
    if (!words) continue
    for (const w of words) {
      if (w.endMs <= clip.inMs || w.startMs >= clip.outMs) continue
      const r = mapWord(clip, w)
      if (!r) continue
      const key = `${w.assetId}:${w.startMs}:${w.endMs}:${w.text}`
      const prevEnd = lastSeen.get(key)
      if (prevEnd != null && r.startMs < prevEnd + 100) continue
      lastSeen.set(key, r.endMs)
      out.push({
        text: w.text,
        startMs: Math.round(r.startMs),
        endMs: Math.round(r.endMs),
        assetId: w.assetId,
        srcStartMs: w.startMs,
        srcEndMs: w.endMs,
        clipId: clip.id,
        cueEnd: w.cueEnd
      })
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)
}
