/**
 * 转写纠错：whisper 在底噪 / 专有名词上会有错字（「停顿衣裳就会化走」）。
 * 按文字查找替换，同时保住词级时间：命中的几个词合并成一个词，占用它们原来的时间范围。
 */
import type { TranscriptCue } from './types'

type Word = NonNullable<TranscriptCue['words']>[number]

export interface TranscriptFixResult {
  cues: TranscriptCue[]
  /** 替换次数 */
  count: number
  /** 每处替换的上下文（改后），给 AI 核对 */
  samples: string[]
}

function replaceWords(words: Word[], find: string, replace: string): { words: Word[]; count: number; samples: string[] } {
  const joined = words.map((w) => w.text).join('')
  const hits: number[] = []
  for (let at = joined.indexOf(find); at >= 0; at = joined.indexOf(find, at + find.length)) hits.push(at)
  if (!hits.length) return { words, count: 0, samples: [] }
  // 每个字符属于哪个词、每个词在 joined 里的起点
  const owner: number[] = []
  const offset: number[] = []
  let pos = 0
  words.forEach((w, i) => {
    offset.push(pos)
    for (let k = 0; k < w.text.length; k++) owner.push(i)
    pos += w.text.length
  })
  let out = words.map((w) => ({ ...w }))
  const merges: { first: number; last: number; word: Word }[] = []
  for (const at of hits) {
    const first = owner[at]!
    const last = owner[at + find.length - 1]!
    // 和上一处替换落在同一批词里时合并处理
    const prev = merges.at(-1)
    if (prev && first <= prev.last) {
      prev.last = Math.max(prev.last, last)
      continue
    }
    merges.push({ first, last, word: { text: '', startMs: 0, endMs: 0 } })
  }
  for (const m of merges) {
    const from = offset[m.first]!
    const to = offset[m.last]! + words[m.last]!.text.length
    m.word = {
      text: joined.slice(from, to).split(find).join(replace),
      startMs: words[m.first]!.startMs,
      endMs: Math.max(words[m.first]!.endMs, words[m.last]!.endMs)
    }
  }
  const samples: string[] = []
  for (const m of [...merges].reverse()) out = [...out.slice(0, m.first), ...(m.word.text ? [m.word] : []), ...out.slice(m.last + 1)]
  const after = out.map((w) => w.text).join('')
  for (const m of merges) {
    const i = after.indexOf(m.word.text)
    if (i >= 0) samples.push(after.slice(Math.max(0, i - 8), i + m.word.text.length + 8))
  }
  return { words: out, count: hits.length, samples }
}

/**
 * 在转写里把 find 替换成 replace（只改 assetId 对应素材时传 assetId）。find 为空或和 replace 相同时不做任何事。
 * 有词级时间的 cue：按词替换并合并时间；只有 text 的 cue：直接替换文字。
 */
export function fixTranscript(cues: TranscriptCue[], find: string, replace: string, assetId?: string): TranscriptFixResult {
  if (!find || find === replace) return { cues, count: 0, samples: [] }
  let count = 0
  const samples: string[] = []
  const next = cues.map((cue) => {
    if (assetId && cue.assetId !== assetId) return cue
    if (cue.words?.length) {
      const r = replaceWords(cue.words, find, replace)
      if (!r.count) return cue
      count += r.count
      samples.push(...r.samples)
      return { ...cue, words: r.words, text: cue.text.split(find).join(replace) }
    }
    if (!cue.text.includes(find)) return cue
    const n = cue.text.split(find).length - 1
    count += n
    samples.push(cue.text.split(find).join(replace).slice(0, 40))
    return { ...cue, text: cue.text.split(find).join(replace) }
  })
  return { cues: next, count, samples: samples.slice(0, 10) }
}

/**
 * 转写提示词（whisper --prompt / 云端 prompt），只在工程设了热词时返回，否则 ''（不传提示词）。
 * 实测：提示词能纠正部分同音错字（「化走」→「划走」），但会让 whisper 把整段合成一个 cue，所以没有热词时不加。
 */
export function transcriptionPrompt(vocabulary: string[] | undefined): string {
  const words = [...new Set((vocabulary ?? []).map((w) => w.trim()).filter(Boolean))].slice(0, 40)
  return words.length ? `以下是一段普通话口播，常见词：${words.join('、')}。` : ''
}
