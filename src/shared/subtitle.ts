import { textScale } from './text'
import { isCjkChar } from './transcript'
import type { SubtitleCue, SubtitleStyle } from './types'

/** 字幕样式预设相关的纯函数，导出（ASS）和预览（Canvas）共用。 */

export const DEFAULT_HIGHLIGHT = '#FFD400'
export const DEFAULT_BOX_COLOR = '#000000'
export const DEFAULT_BOX_OPACITY = 0.6

export function subtitlePreset(style: SubtitleStyle | undefined): NonNullable<SubtitleStyle['preset']> {
  return style?.preset ?? 'clean'
}

export interface TextRun {
  text: string
  /** keyword：关键词命中。 */
  hit?: boolean
  /** karaoke：该词的时间线时间。 */
  startMs?: number
  endMs?: number
}

const countable = (s: string) => s.replace(/[\s\p{P}\p{S}]/gu, '').length

/** 把一行按关键词切成 runs（区分大小写不敏感，长词优先）。 */
export function keywordRuns(line: string, keywords: string[] | undefined): TextRun[] {
  const kws = [...new Set((keywords ?? []).map((k) => k.trim()).filter(Boolean))].sort((a, b) => b.length - a.length)
  if (!kws.length || !line) return line ? [{ text: line }] : []
  const re = new RegExp(kws.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu')
  const runs: TextRun[] = []
  let last = 0
  for (const m of line.matchAll(re)) {
    const at = m.index ?? 0
    if (at > last) runs.push({ text: line.slice(last, at) })
    runs.push({ text: m[0], hit: true })
    last = at + m[0].length
  }
  if (last < line.length) runs.push({ text: line.slice(last) })
  return runs
}

/**
 * 卡拉 OK：把 cue.words 按 cue.text 的换行分成行，每个词一个 run（带词前空格）。
 * 文字被手工改过、与 words 对不上时返回 null（调用方退回普通字幕）。
 */
export function karaokeLines(cue: SubtitleCue): TextRun[][] | null {
  const words = cue.words
  if (!words?.length) return null
  const lines = cue.text.split('\n')
  const flat = lines.join('')
  const wordsText = words.map((w) => w.text).join('')
  if (flat.replace(/[\s\p{P}\p{S}]/gu, '') !== wordsText.replace(/[\s\p{P}\p{S}]/gu, '')) return null
  const out: TextRun[][] = []
  let wi = 0
  for (const line of lines) {
    const need = countable(line)
    const runs: TextRun[] = []
    let have = 0
    let cursor = 0
    while (wi < words.length && have < need) {
      const w = words[wi]!
      // 在行文本里定位这个词（跳过空格与被去掉的标点）
      const core = w.text.replace(/[\s\p{P}\p{S}]+$/u, '') || w.text
      let at = line.indexOf(core, cursor)
      if (at < 0) at = cursor
      const end = Math.min(line.length, at + core.length)
      // 词后紧跟的标点也归这个词
      let tail = end
      while (tail < line.length && /[\p{P}\p{S}]/u.test(line[tail]!)) tail++
      runs.push({ text: line.slice(cursor, tail), startMs: w.startMs, endMs: w.endMs })
      cursor = tail
      have += countable(w.text)
      wi++
    }
    if (cursor < line.length && runs.length) runs[runs.length - 1]!.text += line.slice(cursor)
    else if (cursor < line.length) runs.push({ text: line.slice(cursor) })
    out.push(runs)
  }
  if (wi < words.length) return null
  return out
}

/** 0–1 不透明度 → ASS alpha 两位十六进制（00 不透明，FF 透明）。 */
export function assAlpha(opacity: number): string {
  const a = Math.round((1 - Math.min(1, Math.max(0, opacity))) * 255)
  return a.toString(16).padStart(2, '0').toUpperCase()
}

/*
 * —— 字宽估算（导出 ASS、抽帧预览、质检、字幕断句共用）——
 * 系数按 macOS 中文字体（Hiragino Sans GB，PIL 实测）标定：中文 / 全角标点 1em，小写 0.55，大写 0.71，数字 0.66，半角标点 / 空格 0.32。
 */

/** 画面左右各留 5% 边距。 */
export const SIDE_MARGIN = 0.05
/** keyword 预设命中词的放大倍数（与 ASS \fscx115 一致）。 */
export const KEYWORD_SCALE = 1.15

export function charWidthEm(ch: string): number {
  if (isCjkChar(ch)) return 1
  if (/[a-z]/.test(ch)) return 0.56
  if (/[A-Z]/.test(ch)) return 0.71
  if (/[0-9]/.test(ch)) return 0.66
  if (/[\s!-/:-@[-`{-~]/.test(ch)) return 0.32
  return 0.6
}

/** 一段文字的估算宽度（em）。 */
export function estimateTextWidthEm(text: string): number {
  let w = 0
  for (const ch of text) w += charWidthEm(ch)
  return w
}

export function estimateTextWidthPx(text: string, fontPx: number): number {
  return estimateTextWidthEm(text) * fontPx
}

/** 字幕实际像素字号（与 assDocument / bakeSubtitleFrame 一致）。 */
export function subtitleFontPx(style: SubtitleStyle, width: number, height: number): number {
  return Math.round((style.fontSize || 42) * textScale(width, height))
}

/** 一行字幕可用的像素宽度：左右各留 SIDE_MARGIN，boxed 再减去两侧底框内边距。 */
export function subtitleAvailablePx(style: SubtitleStyle, width: number, height: number): number {
  const fontPx = subtitleFontPx(style, width, height)
  const pad = subtitlePreset(style) === 'boxed' ? Math.max(4, Math.round(fontPx * 0.22)) : 0
  return width * (1 - 2 * SIDE_MARGIN) - 2 * pad
}

/** 一行字幕的估算像素宽度（keyword 命中词按 1.15 放大）。 */
export function subtitleLineWidthPx(line: string, style: SubtitleStyle, width: number, height: number): number {
  const fontPx = subtitleFontPx(style, width, height)
  if (subtitlePreset(style) === 'keyword' && style.keywords?.length) {
    return keywordRuns(line, style.keywords).reduce((n, r) => n + estimateTextWidthPx(r.text, fontPx) * (r.hit ? KEYWORD_SCALE : 1), 0)
  }
  return estimateTextWidthPx(line, fontPx)
}

/**
 * 按当前字幕样式和画布宽度，一行最多放几个中文字（向下取整，至少 4）。
 * keyword 预设按每行可能有一个 4 字关键词放大估算。
 */
export function maxCharsForStyle(style: SubtitleStyle, width: number, height: number): number {
  const fontPx = subtitleFontPx(style, width, height)
  let avail = subtitleAvailablePx(style, width, height)
  if (subtitlePreset(style) === 'keyword' && style.keywords?.length) avail -= 4 * fontPx * (KEYWORD_SCALE - 1)
  return Math.max(4, Math.floor(avail / Math.max(1, fontPx)))
}

/**
 * 把超宽的一行折成宽度均衡的几行：优先在标点后断，不拆开拉丁单词和数字。
 * widthOf 用来算一段文字的像素宽度（keyword 放大等由调用方决定）。
 */
export function wrapLineByWidth(line: string, maxPx: number, widthOf: (s: string) => number): string[] {
  if (widthOf(line) <= maxPx || [...line].length < 2) return [line]
  const chars = [...line]
  const n = Math.ceil(widthOf(line) / maxPx)
  // 可断点：字符之间，但不在两个拉丁 / 数字字符之间；标点后优先
  const breaks: { at: number; punct: boolean }[] = []
  for (let i = 1; i < chars.length; i++) {
    const a = chars[i - 1]!
    const b = chars[i]!
    if (/[A-Za-z0-9]/.test(a) && /[A-Za-z0-9]/.test(b)) continue
    if (/[\p{P}]/u.test(b) && !/\s/.test(b)) continue
    breaks.push({ at: i, punct: /[\p{P}\s]/u.test(a) })
  }
  const out: string[] = []
  let start = 0
  for (let k = n; k > 1 && start < chars.length; k--) {
    const rest = chars.slice(start).join('')
    const target = widthOf(rest) / k
    // 先只看标点断点：切下来的一行放得下、剩下的还能放进 k-1 行，就在标点处断（挑最均衡的）；没有再看全部断点
    const pick = (onlyPunct: boolean) => {
      let best = -1
      let bestCost = Infinity
      for (const br of breaks) {
        if (br.at <= start || (onlyPunct && !br.punct)) continue
        const w = widthOf(chars.slice(start, br.at).join(''))
        if (w > maxPx) break
        if (widthOf(chars.slice(br.at).join('')) > (k - 1) * maxPx) continue
        const cost = Math.abs(w - target)
        if (cost < bestCost) {
          bestCost = cost
          best = br.at
        }
      }
      return best
    }
    let best = pick(true)
    if (best < 0) best = pick(false)
    if (best < 0) {
      // 均衡约束放不下：退回到放得下的最后一个合法断点（不拆词）
      for (const br of breaks) {
        if (br.at <= start) continue
        if (widthOf(chars.slice(start, br.at).join('')) > maxPx) break
        best = br.at
      }
    }
    if (best < 0) {
      // 没有合法断点：按字符硬切到 maxPx 以内
      let i = start + 1
      while (i < chars.length && widthOf(chars.slice(start, i + 1).join('')) <= maxPx) i++
      best = i
    }
    out.push(chars.slice(start, best).join('').trim())
    start = best
  }
  if (start < chars.length) out.push(chars.slice(start).join('').trim())
  return out.filter(Boolean).flatMap((l) => (widthOf(l) > maxPx && l !== line ? wrapLineByWidth(l, maxPx, widthOf) : [l]))
}

/** 字幕文字按当前样式折行（已有的 \n 保留），用于导出和预览保持一致。 */
export function wrapSubtitleText(text: string, style: SubtitleStyle, width: number, height: number): string {
  const avail = subtitleAvailablePx(style, width, height)
  return text
    .split('\n')
    .flatMap((line) => wrapLineByWidth(line, avail, (s) => subtitleLineWidthPx(s, style, width, height)))
    .join('\n')
}
