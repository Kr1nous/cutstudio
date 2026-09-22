/**
 * 词时间对齐：whisper.cpp 的词级时间戳常见零长度词、词间空隙和真实停顿对不上。
 * 这里用能量分析得到的语音段（AssetIndex.speech）重新分配每个词的时间：
 * 按标点把 cue 切成短语 → 单调 DP 把短语组对齐到语音段组（字数比例 ≈ 发声时长比例）
 * → 短语内按字数均分发声时间。结果仍是素材源时间，词不跨静音、没有零长度。
 */
import { isCjkChar } from './transcript'
import type { PauseRange, TimeRange, TranscriptCue } from './types'

type Word = NonNullable<TranscriptCue['words']>[number]

const PHRASE_END = /[，,。．.！!？?、；;：:…—]["”’』」)）]*$/u
/** 语音段两端允许越过 cue 边界的量（whisper 的 cue 边界本身也不准）。 */
const EDGE_SLACK_MS = 300

/** 对齐算法版本：改了 refineWordTimings / filterHallucinations 的行为就加一，已有工程会在后台重新对齐（不重跑 whisper）。 */
export const TRANSCRIPT_ALIGN_VERSION = 3

function units(text: string): number {
  let n = 0
  for (const ch of text.replace(/[\s\p{P}\p{S}]/gu, '')) n += isCjkChar(ch) ? 1 : 0.5
  return Math.max(0.5, n)
}

/** cue 可用的语音区间：只取和 cue 相交的语音段；段超出 cue 边界太多时裁到边界（多半属于相邻 cue）。 */
function cueSpeech(cue: TranscriptCue, speech: TimeRange[], floorMs: number): TimeRange[] {
  const out: TimeRange[] = []
  for (const s of speech) {
    if (s.endMs <= cue.startMs - EDGE_SLACK_MS || s.startMs >= cue.endMs + EDGE_SLACK_MS) continue
    let a = s.startMs >= cue.startMs - EDGE_SLACK_MS ? s.startMs : cue.startMs
    let b = s.endMs <= cue.endMs + EDGE_SLACK_MS ? s.endMs : cue.endMs
    a = Math.max(a, floorMs)
    if (b - a >= 20) out.push({ startMs: a, endMs: b })
  }
  return out
}

type Group = { seg: [number, number]; phrase: [number, number] }

/** 单调对齐：连续短语组 ↔ 连续语音段组；语音段也可以跳过（呼吸、杂音）。 */
function alignGroups(segDur: number[], phraseUnits: number[]): Group[] | null {
  const m = segDur.length
  const n = phraseUnits.length
  if (!m || !n) return null
  const T = segDur.reduce((a, b) => a + b, 0)
  const U = phraseUnits.reduce((a, b) => a + b, 0)
  const segPre = [0]
  for (const d of segDur) segPre.push(segPre.at(-1)! + d)
  const phPre = [0]
  for (const u of phraseUnits) phPre.push(phPre.at(-1)! + u)
  const INF = Number.POSITIVE_INFINITY
  const dp = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(INF))
  const back = Array.from({ length: m + 1 }, () => new Array<[number, number] | null>(n + 1).fill(null))
  dp[0]![0] = 0
  for (let i = 0; i <= m; i++) {
    for (let j = 0; j <= n; j++) {
      const cur = dp[i]![j]!
      if (cur === INF) continue
      if (i < m) {
        const skip = cur + 2 * (segDur[i]! / T) ** 2 + 0.002
        if (skip < dp[i + 1]![j]!) {
          dp[i + 1]![j] = skip
          back[i + 1]![j] = [i, j]
        }
      }
      if (j === n) continue
      for (let i2 = i + 1; i2 <= m; i2++) {
        const dur = segPre[i2]! - segPre[i]!
        for (let j2 = j + 1; j2 <= n; j2++) {
          const expected = ((phPre[j2]! - phPre[j]!) / U) * T
          const cost = cur + ((dur - expected) / T) ** 2
          if (cost < dp[i2]![j2]!) {
            dp[i2]![j2] = cost
            back[i2]![j2] = [i, j]
          }
        }
      }
    }
  }
  if (dp[m]![n] === INF) return null
  const groups: Group[] = []
  let i = m
  let j = n
  while (i > 0 || j > 0) {
    const prev = back[i]![j]
    if (!prev) return null
    if (prev[1] !== j) groups.unshift({ seg: [prev[0], i], phrase: [prev[1], j] })
    ;[i, j] = prev
  }
  return groups
}

/** 用细粒度停顿（非 valley）把语音段切细：段内的短停顿也能成为短语边界。 */
function splitByPauses(speech: TimeRange[], pauses: PauseRange[]): TimeRange[] {
  const hard = pauses.filter((p) => !p.valley)
  const out: TimeRange[] = []
  for (const s of speech) {
    let cursor = s.startMs
    for (const p of hard) {
      if (p.startMs < s.startMs + 30 || p.endMs > s.endMs - 30) continue
      if (p.startMs - cursor >= 30) out.push({ startMs: cursor, endMs: p.startMs })
      cursor = Math.max(cursor, p.endMs)
    }
    if (s.endMs - cursor >= 20) out.push({ startMs: cursor, endMs: s.endMs })
  }
  return out
}

/** 真实时间 → 发声时间轴上的偏移（落在段间停顿里时取段尾）。 */
function timeToVoiced(iv: TimeRange[], t: number): number | null {
  let acc = 0
  for (const s of iv) {
    if (t < s.startMs) return null
    if (t <= s.endMs) return acc + (t - s.startMs)
    acc += s.endMs - s.startMs
  }
  return null
}

/** 发声时间轴上的偏移 → 真实时间。atEnd 时落在段尾（不跳到下一段开头）。 */
function voicedToTime(iv: TimeRange[], offset: number, atEnd: boolean): number {
  let acc = 0
  for (let k = 0; k < iv.length; k++) {
    const d = iv[k]!.endMs - iv[k]!.startMs
    const last = k === iv.length - 1
    if (offset < acc + d || (atEnd && offset <= acc + d) || last) return iv[k]!.startMs + Math.min(d, Math.max(0, offset - acc))
    acc += d
  }
  return iv.at(-1)?.endMs ?? 0
}

/** 按权重把 [lo, hi]（发声偏移）切给若干项。 */
function splitByWeight(lo: number, hi: number, weights: number[]): [number, number][] {
  const total = weights.reduce((a, b) => a + b, 0) || 1
  let acc = 0
  return weights.map((w) => {
    const a = lo + ((hi - lo) * acc) / total
    acc += w
    return [a, lo + ((hi - lo) * acc) / total]
  })
}

/** 均匀分配（没有可用语音段时的兜底）：至少消除零长度词。 */
function spreadEvenly(cue: TranscriptCue, words: Word[]): Word[] {
  const span = Math.max(words.length * 20, cue.endMs - cue.startMs)
  const parts = splitByWeight(cue.startMs, cue.startMs + span, words.map((w) => units(w.text)))
  return words.map((w, i) => ({ text: w.text, startMs: Math.round(parts[i]![0]), endMs: Math.round(parts[i]![1]), ...(w.p != null ? { p: w.p } : {}) }))
}

function refineCue(cue: TranscriptCue, speech: TimeRange[], valleys: PauseRange[], floorMs: number): TranscriptCue {
  const words = (cue.words ?? []).filter((w) => w.text.trim())
  if (!words.length) return cue
  // 短语：标点结尾处断开
  const phrases: Word[][] = []
  let cur: Word[] = []
  for (const w of words) {
    cur.push(w)
    if (PHRASE_END.test(w.text.trim())) {
      phrases.push(cur)
      cur = []
    }
  }
  if (cur.length) phrases.push(cur)

  const iv = cueSpeech(cue, speech, floorMs)
  const groups = alignGroups(
    iv.map((s) => s.endMs - s.startMs),
    phrases.map((ph) => ph.reduce((n, w) => n + units(w.text), 0))
  )
  if (!groups) {
    const spread = spreadEvenly(cue, words)
    return { ...cue, startMs: spread[0]!.startMs, endMs: spread.at(-1)!.endMs, words: spread }
  }

  const out: Word[] = []
  for (const g of groups) {
    const segs = iv.slice(g.seg[0], g.seg[1])
    const voiced = segs.reduce((n, s) => n + s.endMs - s.startMs, 0)
    const gPhrases = phrases.slice(g.phrase[0], g.phrase[1])
    const phraseSpans = splitByWeight(0, voiced, gPhrases.map((ph) => ph.reduce((n, w) => n + units(w.text), 0)))
    // 短语边界离段间停顿很近时吸附过去，让停顿落在短语之间
    const gapOffsets: number[] = []
    let acc = 0
    for (const s of segs.slice(0, -1)) gapOffsets.push((acc += s.endMs - s.startMs))
    // 能量谷是弱边界：段间停顿之外再作为候选
    const valleyOffsets = valleys
      .map((v) => timeToVoiced(segs, (v.startMs + v.endMs) / 2))
      .filter((o): o is number => o != null && o > 0 && o < voiced)
    for (let k = 0; k < phraseSpans.length - 1; k++) {
      const b = phraseSpans[k]![1]
      const span = Math.min(b - phraseSpans[k]![0], phraseSpans[k + 1]![1] - b)
      const nearest = (list: number[], room: number) =>
        list.filter((o) => Math.abs(o - b) <= room).sort((x, y) => Math.abs(x - b) - Math.abs(y - b))[0]
      // 段间硬停顿可信度高（语速变化时按字数估的边界可能差得较远），吸附范围放宽到 50%；能量谷只放 25%
      const near = nearest(gapOffsets, 0.5 * span) ?? nearest(valleyOffsets, 0.25 * span)
      if (near != null) {
        phraseSpans[k]![1] = near
        phraseSpans[k + 1]![0] = near
      }
    }
    gPhrases.forEach((ph, k) => {
      const [lo, hi] = phraseSpans[k]!
      const wordSpans = splitByWeight(lo, hi, ph.map((w) => units(w.text)))
      ph.forEach((w, wi) => {
        let a = voicedToTime(segs, wordSpans[wi]![0], false)
        let b = voicedToTime(segs, wordSpans[wi]![1], true)
        // 词跨过停顿时只保留重叠更多的那一段
        let best: TimeRange | null = null
        for (const s of segs) {
          const x = Math.max(a, s.startMs)
          const y = Math.min(b, s.endMs)
          if (y > x && (!best || y - x > best.endMs - best.startMs)) best = { startMs: x, endMs: y }
        }
        if (best) {
          a = best.startMs
          b = best.endMs
        }
        if (b - a < 10) b = a + 10
        out.push({ text: w.text, startMs: Math.round(a), endMs: Math.round(b), ...(w.p != null ? { p: w.p } : {}) })
      })
    })
  }
  return { ...cue, startMs: out[0]!.startMs, endMs: out.at(-1)!.endMs, words: out }
}

/**
 * 用能量语音段（再按细粒度停顿 pauses 切细）校正一条素材的转写词时间。cues 按时间顺序处理，后一个 cue 不会占用前一个 cue 已分到的时间。
 * speech 为空（没有能量分析）时只修零长度词。
 */
export function refineWordTimings(cues: TranscriptCue[], speech: TimeRange[], pauses: PauseRange[] = []): TranscriptCue[] {
  const byStart = (a: TimeRange, b: TimeRange) => a.startMs - b.startMs
  const sortedPauses = [...pauses].sort(byStart)
  const sorted = splitByPauses([...speech].sort(byStart), sortedPauses)
  const valleys = sortedPauses.filter((p) => p.valley)
  let floor = 0
  return [...cues]
    .sort((a, b) => a.startMs - b.startMs)
    .map((cue) => {
      const refined = refineCue(cue, sorted, valleys, floor)
      floor = Math.max(floor, refined.endMs)
      return { ...refined, alignVersion: TRANSCRIPT_ALIGN_VERSION }
    })
}

/** whisper 在音乐 / 静音上常见的幻听短语（规范化后比较）。 */
const HALLUCINATIONS = [
  'thankyou',
  'thankyouforwatching',
  'thanksforwatching',
  'pleasesubscribe',
  'amaraorg',
  'subtitlesbytheamaraorgcommunity',
  'you',
  '谢谢观看',
  '谢谢大家观看',
  '感谢观看',
  '请不吝点赞订阅转发打赏支持明镜与点点栏目',
  '字幕由amaraorg社区提供',
  '字幕by索兰娅',
  '中文字幕',
  '优优独播剧场youyoushowcase'
]

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function overlapMs(a: TimeRange, list: TimeRange[]): number {
  let n = 0
  for (const r of list) n += Math.max(0, Math.min(a.endMs, r.endMs) - Math.max(a.startMs, r.startMs))
  return n
}

/**
 * 去掉 whisper 幻听的 cue：
 * - 和能量语音段重叠 < 30%（说话的地方没有声音）；
 * - 字速过低：每秒不到 0.6 个字（中文 1 字 = 1，拉丁字母 0.5），且 cue ≥ 3 秒——长段音乐 / 底噪被转成一两句话；
 * - 已知幻听短语（Thank you. / 谢谢观看 / 字幕由… 等），且重叠 < 60% 或字速过低。
 */
export function filterHallucinations(cues: TranscriptCue[], speech: TimeRange[]): TranscriptCue[] {
  return cues.filter((cue) => {
    const text = normalizeText(cue.text)
    if (!text) return false
    const dur = Math.max(1, cue.endMs - cue.startMs)
    const overlap = speech.length ? overlapMs(cue, speech) / dur : 1
    const rate = units(cue.text) / (dur / 1000)
    const slow = dur >= 3000 && rate < 0.6
    const known = HALLUCINATIONS.some((h) => text === h || (h.length >= 6 && text.includes(h)))
    if (overlap < 0.3) return false
    if (slow) return false
    if (known && overlap < 0.6) return false
    return true
  })
}
