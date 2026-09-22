import { id } from './ids'
import { packStorylineClips } from './compose'
import { clipFx } from './types'
import type { Project, TimeRange, TimelineClip } from './types'
import {
  CLAUSE_END,
  SENTENCE_END,
  assetWords,
  joinWords,
  textUnits,
  mapWord,
  normalizeForMatch,
  speechClips,
  splitSentences,
  timelineWords,
  type Sentence,
  type SrcWord
} from './transcript'

/** 按素材分组的待删源区间（素材源时间）。 */
export type CutsByAsset = Record<string, TimeRange[]>

export interface DocSentence {
  /** `${assetId}#${序号}` */
  id: string
  text: string
  assetId: string
  startMs: number
  endMs: number
  /** 时间线上第一次听到这句的位置；null = 已被剪掉。 */
  timelineStartMs: number | null
  timelineEndMs: number | null
  inTimeline: boolean
  /** 句子只有一部分词还在时间线上。 */
  partial?: boolean
  /** 按词时长计的可听比例 0–1。 */
  audible: number
  /** 只含仍在成片里的词。 */
  keptText: string
}

type ProjectLike = Pick<Project, 'timeline' | 'transcript' | 'assets'>

/** 可读文稿：按时间线顺序（被剪掉的句子插在同素材的相邻句子之后）。 */
export function transcriptDoc(project: ProjectLike): { sentences: DocSentence[] } {
  const clips = speechClips(project)
  const heard = heardWords(project)
  const docs: DocSentence[] = splitSentences(project).map((s) => {
    let start: number | null = null
    let end: number | null = null
    let seen = 0
    for (const w of s.words) {
      let hit = false
      for (const clip of clips) {
        if (clip.assetId !== s.assetId) continue
        const r = mapWord(clip, w)
        if (!r) continue
        hit = true
        start = start == null ? r.startMs : Math.min(start, r.startMs)
        end = end == null ? r.endMs : Math.max(end, r.endMs)
      }
      if (hit) seen++
    }
    const doc: DocSentence = {
      id: s.id,
      text: s.text,
      assetId: s.assetId,
      startMs: s.startMs,
      endMs: s.endMs,
      timelineStartMs: start == null ? null : Math.round(start),
      timelineEndMs: end == null ? null : Math.round(end),
      ...(({ audible, keptText }) => ({ audible, keptText }))(spanAudibility(s.words, heard)),
      inTimeline: start != null
    }
    if (seen > 0 && seen < s.words.length) doc.partial = true
    return doc
  })
  // 排序键：在时间线里的句子用时间线时间；被剪掉的用同素材前一句的键（稳定排在它后面）
  const keyed = docs.map((d, i) => ({ d, i, key: d.timelineStartMs }))
  let lastKey = -1
  let lastAsset = ''
  for (const k of keyed) {
    if (k.d.assetId !== lastAsset) {
      lastAsset = k.d.assetId
      lastKey = -1
    }
    if (k.key == null) k.key = lastKey + 0.001
    lastKey = k.key
  }
  keyed.sort((a, b) => a.key! - b.key! || a.i - b.i)
  return { sentences: keyed.map((k) => k.d) }
}

/** 把 x 放进 [lo, hi]；若区间内有静音段，再放进离 x 最近的静音段内部。 */
function snapInGap(x: number, lo: number, hi: number, silence: TimeRange[]): number {
  if (hi < lo) return (lo + hi) / 2
  let p = Math.min(hi, Math.max(lo, x))
  let best: number | null = null
  for (const s of silence) {
    const a = Math.max(lo, s.startMs)
    const b = Math.min(hi, s.endMs)
    if (b <= a) continue
    const inset = Math.min(10, (b - a) / 2)
    const q = Math.min(b - inset, Math.max(a + inset, p))
    if (best == null || Math.abs(q - p) < Math.abs(best - p)) best = q
  }
  if (best != null) p = best
  return Math.round(p)
}

/** [a, b] 与静音段的交集（可能多段）。只删真正安静的部分，词间空隙里有声音的地方不动。 */
function silentParts(a: number, b: number, silence: TimeRange[]): TimeRange[] {
  const out: TimeRange[] = []
  for (const sil of silence) {
    const x = Math.max(a, sil.startMs)
    const y = Math.min(b, sil.endMs)
    if (y > x) out.push({ startMs: x, endMs: y })
  }
  return out
}

function speechOf(project: ProjectLike, assetId: string): TimeRange[] {
  return project.assets.find((a) => a.id === assetId)?.index?.speech ?? []
}

function silenceOf(project: ProjectLike, assetId: string): TimeRange[] {
  return project.assets.find((a) => a.id === assetId)?.index?.silence ?? []
}

/**
 * 合并区间：重叠的一定合并；传入 kept（保留下来的词）时，两段之间没有任何保留词（只剩停顿）也合并。
 * 不传 kept 时只合并重叠区间。
 */
function mergeRanges(ranges: TimeRange[], kept?: SrcWord[]): TimeRange[] {
  const sorted = ranges.filter((r) => r.endMs > r.startMs).sort((a, b) => a.startMs - b.startMs)
  const out: TimeRange[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    const onlyPauseBetween =
      !!last && !!kept && !kept.some((w) => w.endMs > last.endMs && w.startMs < r.startMs)
    if (last && (r.startMs <= last.endMs || onlyPauseBetween)) last.endMs = Math.max(last.endMs, r.endMs)
    else out.push({ ...r })
  }
  return out
}

/** 删除一段词 [first..last]：两端在相邻词之间的空隙里留 padMs，并吸附进静音段。 */
function wordSpanCut(
  words: SrcWord[],
  first: number,
  last: number,
  padMs: number,
  silence: TimeRange[]
): TimeRange | null {
  const a = words[first]
  const b = words[last]
  if (!a || !b || first < 0 || last < first) return null
  const prevEnd = first > 0 ? words[first - 1]!.endMs : Math.max(0, a.startMs - 1000)
  const nextStart = last < words.length - 1 ? words[last + 1]!.startMs : b.endMs + 1000
  const lo = Math.min(prevEnd + padMs, (prevEnd + a.startMs) / 2)
  const hi = Math.max(nextStart - padMs, (b.endMs + nextStart) / 2)
  const start = snapInGap(a.startMs - padMs, lo, a.startMs, silence)
  const end = snapInGap(b.endMs + padMs, b.endMs, hi, silence)
  return end > start ? { startMs: Math.max(0, start), endMs: end } : null
}

/**
 * 句子 id → 待删源区间（按素材分组）。边界吸附到词边界，再吸附到最近的静音段内部；
 * 相邻被删句子会合并成一段。
 */
export function planCutSentences(project: ProjectLike, sentenceIds: string[], padMs = 60): CutsByAsset {
  const all = assetWords(project)
  const spans = resolveSpans(project, sentenceIds, all).filter((x) => x.words.length)
  const out: CutsByAsset = {}
  for (const s of spans) {
    const words = all.get(s.assetId) ?? []
    const first = words.indexOf(s.words[0]!)
    const last = words.indexOf(s.words[s.words.length - 1]!)
    const r = wordSpanCut(words, first, last, padMs, silenceOf(project, s.assetId))
    if (r) (out[s.assetId] ??= []).push(r)
  }
  for (const assetId of Object.keys(out)) {
    const cutWords = new Set(spans.filter((s) => s.assetId === assetId).flatMap((s) => s.words))
    const kept = (all.get(assetId) ?? []).filter((w) => !cutWords.has(w))
    out[assetId] = mergeRanges(out[assetId]!, kept)
  }
  return out
}

export interface TextSpan {
  /** 句子 `${assetId}#n` 或分句 `${assetId}#n.k` */
  id: string
  assetId: string
  text: string
  words: SrcWord[]
  /** 传入 project 时给出：按词时长计的可听比例、是否还有词在成片里、只含仍在成片里的词。 */
  audible?: number
  inTimeline?: boolean
  keptText?: string
}

export const wordKey = (w: { assetId: string; startMs: number; endMs: number; text: string }) => `${w.assetId}:${w.startMs}:${w.endMs}:${w.text}`

/** 时间线上能听到的词（素材源时间键）。 */
export function heardWords(project: ProjectLike): Set<string> {
  return new Set(timelineWords(project).map((w) => wordKey({ assetId: w.assetId, startMs: w.srcStartMs, endMs: w.srcEndMs, text: w.text })))
}

export function spanAudibility(words: SrcWord[], heard: Set<string>): { audible: number; inTimeline: boolean; keptText: string } {
  let total = 0
  let got = 0
  const kept: string[] = []
  for (const w of words) {
    const d = Math.max(1, w.endMs - w.startMs)
    total += d
    if (heard.has(wordKey(w))) {
      got += d
      kept.push(w.text)
    }
  }
  return { audible: total ? Math.round((got / total) * 100) / 100 : 0, inTimeline: kept.length > 0, keptText: joinWords(kept) }
}

/**
 * 句子切分句，id = `${sentenceId}.${k}`。边界只落在词（whisper 原始 token）之间：
 * - 逗号类 / 句末标点、cue 结尾（ASR 常漏标点）：总是断；
 * - 传入 project 时，词间有 ≥150ms 的硬停顿（index.pauses 非 valley）且两侧都 ≥4 字：断。
 * 对齐后的词间隔不可靠（语速快时字间也会有空隙），不再单独作为边界。
 * 传入 project 时每个分句带 audible / inTimeline / keptText。显示和删除请传同一个 project，编号才一致。
 */
export function sentenceClauses(s: Sentence, project?: ProjectLike, heard?: Set<string>): TextSpan[] {
  const pauses = (project?.assets.find((a) => a.id === s.assetId)?.index?.pauses ?? []).filter((p) => !p.valley && p.endMs - p.startMs >= 150)
  const unitsOf = (ws: SrcWord[]) => textUnits(normalizeForMatch(joinWords(ws.map((x) => x.text))))
  const out: TextSpan[] = []
  let buf: SrcWord[] = []
  const flush = () => {
    if (!buf.length) return
    out.push({ id: `${s.id}.${out.length}`, assetId: s.assetId, text: joinWords(buf.map((w) => w.text)), words: buf })
    buf = []
  }
  s.words.forEach((w, i) => {
    buf.push(w)
    const next = s.words[i + 1]
    if (CLAUSE_END.test(w.text) || SENTENCE_END.test(w.text) || w.cueEnd) return flush()
    if (!next || !pauses.length) return
    const hardPause = pauses.some((p) => p.startMs >= w.endMs - 30 && p.endMs <= next.startMs + 30)
    if (!hardPause || unitsOf(buf) < 4) return
    // 右侧到下一个标点 / cue 结尾之前也要 ≥4 字
    const rest: SrcWord[] = []
    for (const r of s.words.slice(i + 1)) {
      rest.push(r)
      if (CLAUSE_END.test(r.text) || SENTENCE_END.test(r.text) || r.cueEnd) break
    }
    if (unitsOf(rest) >= 4) flush()
  })
  flush()
  if (project) {
    const h = heard ?? heardWords(project)
    for (const c of out) Object.assign(c, spanAudibility(c.words, h))
  }
  return out
}

/** 句子 / 分句 id → 词。未知 id 不出现在结果里（调用方可比对长度找出未知 id）。 */
export function resolveSpans(project: ProjectLike, ids: string[], all = assetWords(project)): TextSpan[] {
  const sentences = new Map(splitSentences(project, all).map((x) => [x.id, x]))
  const out: TextSpan[] = []
  for (const id of ids) {
    const whole = sentences.get(id)
    if (whole) {
      out.push({ id, assetId: whole.assetId, text: whole.text, words: whole.words })
      continue
    }
    const m = /^(.*)\.(\d+)$/.exec(id)
    const parent = m ? sentences.get(m[1]!) : undefined
    const clause = parent ? sentenceClauses(parent, project)[Number(m![2])] : undefined
    if (clause) out.push(clause)
  }
  return out
}

/**
 * 从故事线片段里切掉源区间，返回新的故事线（已重新排布）。
 * 被切开的片段：只有最后一段保留出点转场和淡出，只有第一段保留淡入；新片段用新 id。
 * 冻结帧片段不处理；短于 minKeepMs 的碎片丢弃。
 */
export function applySourceCuts(storyline: TimelineClip[], cutsByAsset: CutsByAsset, minKeepMs = 80): TimelineClip[] {
  const next: TimelineClip[] = []
  const sorted = [...storyline].sort((a, b) => a.startMs - b.startMs)
  for (const clip of sorted) {
    const fx = clipFx(clip)
    const cuts = (cutsByAsset[clip.assetId] ?? []).filter((c) => c.endMs > clip.inMs && c.startMs < clip.outMs)
    if (!cuts.length || fx.freeze || (clip.kind && clip.kind !== 'footage')) {
      next.push({ ...clip })
      continue
    }
    const keeps: TimeRange[] = []
    let cursor = clip.inMs
    for (const c of [...cuts].sort((a, b) => a.startMs - b.startMs)) {
      if (c.startMs > cursor) keeps.push({ startMs: cursor, endMs: Math.min(c.startMs, clip.outMs) })
      cursor = Math.max(cursor, c.endMs)
    }
    if (cursor < clip.outMs) keeps.push({ startMs: cursor, endMs: clip.outMs })
    const speed = fx.speed || 1
    const pieces = keeps.filter((k) => (k.endMs - k.startMs) / speed >= minKeepMs)
    if (fx.reverse) pieces.reverse()
    if (pieces.length === 1 && pieces[0]!.startMs === clip.inMs && pieces[0]!.endMs === clip.outMs) {
      next.push({ ...clip })
      continue
    }
    pieces.forEach((k, i) => {
      const isFirst = i === 0
      const isLast = i === pieces.length - 1
      const piece: TimelineClip = {
        ...clip,
        id: id('clip'),
        inMs: k.startMs,
        outMs: k.endMs,
        durationMs: Math.round((k.endMs - k.startMs) / speed),
        fx: { ...clip.fx }
      }
      if (!isLast) {
        piece.fx!.transitionOut = { type: 'none', durationMs: 0 }
        piece.fx!.fadeOutMs = 0
      }
      if (!isFirst) piece.fx!.fadeInMs = 0
      next.push(piece)
    })
  }
  next.forEach((c, i) => (c.startMs = i))
  packStorylineClips(next)
  return next
}

function bigrams(s: string): Map<string, number> {
  const m = new Map<string, number>()
  const chars = [...s]
  if (chars.length === 1) m.set(s, 1)
  for (let i = 0; i < chars.length - 1; i++) {
    const g = chars[i]! + chars[i + 1]!
    m.set(g, (m.get(g) ?? 0) + 1)
  }
  return m
}

/** 文本相似度 0–1：字符二元组 Dice；前一句是后一句的开头（说到一半重来）时视为 0.9。 */
export function textSimilarity(a: string, b: string): number {
  const x = normalizeForMatch(a)
  const y = normalizeForMatch(b)
  if (!x || !y) return 0
  if (x === y) return 1
  if (x.length >= 4 && y.startsWith(x) && x.length / y.length >= 0.25) return 0.9
  // 前一句的后半截就是后一句的开头（“大家好，今天我们来讲 / 今天我们来讲剪辑……”）
  for (let k = Math.min(x.length, y.length) - 1; k >= 4; k--) {
    if (x.endsWith(y.slice(0, k))) {
      if (k / x.length >= 0.5) return Math.min(0.95, 0.3 + k / x.length)
      break
    }
  }
  const A = bigrams(x)
  const B = bigrams(y)
  let inter = 0
  let total = 0
  for (const [g, n] of A) {
    inter += Math.min(n, B.get(g) ?? 0)
    total += n
  }
  for (const n of B.values()) total += n
  return total ? (2 * inter) / total : 0
}

export interface RetakeGroup {
  keep: string
  drop: string[]
  similarity: number
  /** sentence = 整句重说；clause = 句子里说到一半重来（id 为分句 `${sentenceId}.${k}`）。 */
  kind: 'sentence' | 'clause'
  keepText: string
  dropText: string[]
}

function dice(x: string, y: string): number {
  const A = bigrams(x)
  const B = bigrams(y)
  let inter = 0
  let total = 0
  for (const [g, n] of A) {
    inter += Math.min(n, B.get(g) ?? 0)
    total += n
  }
  for (const n of B.values()) total += n
  return total ? (2 * inter) / total : 0
}

/**
 * 重录检测：
 * 1. 整句：时间线里相邻 3 句内文本相似度 > threshold 的句子归为一组，默认保留最后一遍。
 * 2. 分句：whisper 常把「说到一半重来」合进同一个 cue。同一句里，若后面 1–2 个分句开始的文字
 *    与前面某分句重合（前缀相同，或同长度 Dice > 0.7，至少 4 字），前面那段分句（到重说开始之前）为 drop。
 */
export function detectRetakes(project: ProjectLike, threshold = 0.6): RetakeGroup[] {
  const docAll = transcriptDoc(project).sentences
  const doc = docAll.filter((s) => s.inTimeline && normalizeForMatch(s.text).length >= 4)
  const out: RetakeGroup[] = []
  const used = new Set<string>()
  for (let i = 0; i < doc.length; i++) {
    if (used.has(doc[i]!.id)) continue
    const chain = [i]
    let sim = 1
    // 窗口跟着链上最后一句滑动：后面 3 句内找相似句
    for (let j = i + 1; j < doc.length && j <= chain[chain.length - 1]! + 3; j++) {
      if (used.has(doc[j]!.id) || doc[j]!.assetId !== doc[i]!.assetId) continue
      const v = textSimilarity(doc[chain[chain.length - 1]!]!.text, doc[j]!.text)
      if (v > threshold) {
        chain.push(j)
        sim = Math.min(sim, v)
      }
    }
    if (chain.length < 2) continue
    for (const k of chain) used.add(doc[k]!.id)
    out.push({
      keep: doc[chain[chain.length - 1]!]!.id,
      drop: chain.slice(0, -1).map((k) => doc[k]!.id),
      similarity: Math.round(sim * 100) / 100,
      kind: 'sentence',
      keepText: doc[chain[chain.length - 1]!]!.text,
      dropText: chain.slice(0, -1).map((k) => doc[k]!.text)
    })
  }

  // 分句级：只看还在时间线里、没被整句重录吃掉的句子
  const heard = heardWords(project)
  const inDoc = new Set(doc.filter((d) => !used.has(d.id)).map((d) => d.id))
  for (const sentence of splitSentences(project)) {
    if (!inDoc.has(sentence.id)) continue
    const clauses = sentenceClauses(sentence, project, heard).filter((c) => c.inTimeline)
    const norm = clauses.map((c) => normalizeForMatch(c.text))
    for (let i = 0; i < clauses.length - 1; i++) {
      const a = norm[i]!
      if (a.length < 4) continue
      for (let j = i + 1; j <= Math.min(i + 2, clauses.length - 1); j++) {
        const rest = norm.slice(j).join('')
        if (rest.length <= a.length) continue
        const head = rest.slice(0, a.length)
        const sim = rest.startsWith(a) ? 1 : a.length >= 5 ? dice(a, head) : 0
        // 至少前 3 个字一致，避免「第一步…，第二步…」这类排比误判
        if (sim <= 0.7 || a.slice(0, 3) !== head.slice(0, 3)) continue
        const drop = clauses.slice(i, j)
        out.push({
          keep: clauses[j]!.id,
          drop: drop.map((c) => c.id),
          similarity: Math.round(sim * 100) / 100,
          kind: 'clause',
          keepText: clauses.slice(j).map((c) => c.text).join(''),
          dropText: drop.map((c) => c.text)
        })
        i = j - 1
        break
      }
    }
  }
  return out
}

/**
 * 口头禅独占一个能量语音段（前后都是静音，段内没有别的词）时，整段删掉并吸附到段边界两侧各 40ms（不越过相邻语音段）。
 */
function ownSegmentCut(seg: SrcWord[], list: SrcWord[], speech: TimeRange[]): TimeRange | null {
  const a = seg[0]!.startMs
  const b = seg[seg.length - 1]!.endMs
  const k = speech.findIndex((s) => Math.min(b, s.endMs) - Math.max(a, s.startMs) > 0.5 * Math.max(1, b - a))
  if (k < 0) return null
  const sp = speech[k]!
  const others = list.some(
    (w) => !seg.includes(w) && Math.min(w.endMs, sp.endMs) - Math.max(w.startMs, sp.startMs) > 0.3 * Math.max(1, w.endMs - w.startMs)
  )
  if (others) return null
  const prevEnd = k > 0 ? speech[k - 1]!.endMs : 0
  const nextStart = k < speech.length - 1 ? speech[k + 1]!.startMs : sp.endMs + 40
  return {
    startMs: Math.round(Math.max(prevEnd + (sp.startMs - prevEnd) / 2, sp.startMs - 40, 0)),
    endMs: Math.round(Math.min(nextStart - (nextStart - sp.endMs) / 2, sp.endMs + 40))
  }
}

export const DEFAULT_FILLERS = ['嗯', '呃', '额', '啊', '唔', '那个', '就是', '然后', '就是说', 'um', 'uh', 'erm', 'uhm', 'hmm']
/** 纯语气词：不要求前后停顿。 */
const PURE_FILLERS = new Set(['嗯', '呃', '额', '唔', 'um', 'uh', 'erm', 'uhm', 'hmm'])

/**
 * 口头禅：按词级时间戳匹配独立成词的填充词（可跨 token，如“那”+“个”）。
 * 词汇型（那个/就是/然后/啊）要求前后都有 ≥ minPauseMs 的停顿或处在句子边界。
 */
export function fillerWordRanges(project: ProjectLike, words: string[] = DEFAULT_FILLERS, minPauseMs = 120): CutsByAsset {
  const targets = words.map((w) => normalizeForMatch(w)).filter(Boolean)
  const out: CutsByAsset = {}
  for (const [assetId, list] of assetWords(project)) {
    const silence = silenceOf(project, assetId)
    const removed = new Set<SrcWord>()
    for (let i = 0; i < list.length; i++) {
      for (let span = 1; span <= 3 && i + span <= list.length; span++) {
        const seg = list.slice(i, i + span)
        const joined = normalizeForMatch(seg.map((w) => w.text).join(''))
        if (!targets.includes(joined)) continue
        const last = seg[seg.length - 1]!
        const prev = list[i - 1]
        const next = list[i + span]
        const gapBefore = prev ? seg[0]!.startMs - prev.endMs : Infinity
        const gapAfter = next ? next.startMs - last.endMs : Infinity
        const edgeBefore = !prev || /[\p{P}]$/u.test(prev.text) || prev.cueEnd
        const edgeAfter = !next || /[\p{P}]$/u.test(last.text) || last.cueEnd
        const pure = PURE_FILLERS.has(joined)
        const standalone =
          pure || ((gapBefore >= minPauseMs || edgeBefore) && (gapAfter >= minPauseMs || edgeAfter))
        if (!standalone) continue
        const r = ownSegmentCut(seg, list, speechOf(project, assetId)) ?? wordSpanCut(list, i, i + span - 1, 40, silence)
        if (r) (out[assetId] ??= []).push(r)
        seg.forEach((w) => removed.add(w))
        i += span - 1
        break
      }
    }
    if (out[assetId]) out[assetId] = mergeRanges(out[assetId]!, list.filter((w) => !removed.has(w)))
  }
  return out
}

/**
 * 压缩停顿：按时间线上实际听到的相邻两个词计算停顿（包括跨剪辑点拼起来的停顿），
 * 超过 maxPauseMs 时只保留 maxPauseMs（两侧各一半）。同一片段内的删除尽量落在静音段内；
 * 跨剪辑点时分别削掉前一片段的尾巴和后一片段的开头。没有转写的素材按 index.silence 处理。
 * 第一个词之前和最后一个词之后的静音压到 ≤ maxPauseMs/2（完全在其外的有转写片段整段删除）。
 */
export function tightenPauses(project: ProjectLike, maxPauseMs: number): CutsByAsset {
  const keep = Math.max(0, maxPauseMs)
  const ranges: Record<string, TimeRange[]> = {}
  const push = (assetId: string, a: number, b: number) => {
    // 只删能量静音：词时间不准时，词间空隙里可能其实有声音
    const index = project.assets.find((x) => x.id === assetId)?.index
    const parts = index ? silentParts(a, b, index.silence) : []
    for (const r of parts) {
      if (r.endMs - r.startMs >= 40) (ranges[assetId] ??= []).push({ startMs: Math.round(r.startMs), endMs: Math.round(r.endMs) })
    }
  }
  const clips = new Map(speechClips(project).map((c) => [c.id, c]))
  const heard = timelineWords(project)
  const byAsset = assetWords(project)
  const withWords = new Set(byAsset.keys())

  // 开头 / 结尾：第一个词之前、最后一个词之后的静音压到 ≤ maxPauseMs/2。
  // 整段落在第一个词之前（或最后一个词之后）的有转写素材片段直接删掉，避免留下碎片。
  const first = heard[0]
  const last = heard[heard.length - 1]
  if (first && last) {
    for (const c of clips.values()) {
      if (!withWords.has(c.assetId) || clipFx(c).freeze) continue
      const cEnd = c.startMs + c.durationMs
      const heardInClip = c.id === first.clipId || c.id === last.clipId
      if (!heardInClip && (cEnd <= first.startMs + 1 || c.startMs >= last.endMs - 1)) push(c.assetId, c.inMs, c.outMs)
    }
    const cf = clips.get(first.clipId)
    if (cf && !clipFx(cf).reverse && first.startMs - cf.startMs > keep / 2) {
      push(cf.assetId, cf.inMs, first.srcStartMs - (keep / 2) * (clipFx(cf).speed || 1))
    }
    const cl = clips.get(last.clipId)
    if (cl && !clipFx(cl).reverse && cl.startMs + cl.durationMs - last.endMs > keep / 2) {
      push(cl.assetId, last.srcEndMs + (keep / 2) * (clipFx(cl).speed || 1), cl.outMs)
    }
  }
  for (let i = 0; i < heard.length - 1; i++) {
    const w1 = heard[i]!
    const w2 = heard[i + 1]!
    if (w2.startMs - w1.endMs <= keep) continue
    const c1 = clips.get(w1.clipId)
    const c2 = clips.get(w2.clipId)
    if (!c1 || !c2) continue
    const s1 = clipFx(c1).speed || 1
    if (c1.id === c2.id && !clipFx(c1).reverse) {
      const a = w1.srcEndMs + (keep / 2) * s1
      const b = w2.srcStartMs - (keep / 2) * s1
      if (b <= a) continue
      push(c1.assetId, a, b)
    } else if (c1.id !== c2.id && !clipFx(c1).reverse && !clipFx(c2).reverse) {
      const s2 = clipFx(c2).speed || 1
      push(c1.assetId, w1.srcEndMs + (keep / 2) * s1, c1.outMs)
      push(c2.assetId, c2.inMs, w2.srcStartMs - (keep / 2) * s2)
    }
  }
  // 没有转写的素材：用静音段
  for (const clip of speechClips(project)) {
    if (withWords.has(clip.assetId)) continue
    const asset = project.assets.find((x) => x.id === clip.assetId)
    for (const sil of asset?.index?.silence ?? []) {
      if (sil.startMs <= clip.inMs || sil.endMs >= clip.outMs) continue
      if (sil.endMs - sil.startMs <= keep) continue
      push(clip.assetId, sil.startMs + keep / 2, sil.endMs - keep / 2)
    }
  }
  const out: CutsByAsset = {}
  for (const [assetId, list] of Object.entries(ranges)) out[assetId] = mergeRanges(list, byAsset.get(assetId) ?? [])
  return out
}

export type { Sentence }
