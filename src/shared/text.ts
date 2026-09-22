import { localT01 } from './anim'
import { DEFAULT_TEXT_STYLE, type TextStyle, type TimelineClip } from './types'

/**
 * 字号换算：fontSize 表示「短边 1080 像素的画面上」的像素数。
 * 以前按 宽/1920 算，竖屏（1080 宽）下字号只剩 56%，字幕和标题都偏小。
 */
export function textScale(width: number, height: number): number {
  return Math.min(width, height) / 1080
}

export function clipText(clip: TimelineClip): TextStyle {
  return { ...DEFAULT_TEXT_STYLE, ...clip.text }
}

export function visibleText(clip: TimelineClip, timeMs: number): string {
  const text = clipText(clip).text
  if (clip.textAnim !== 'typewriter') return text
  const chars = Array.from(text)
  if (!chars.length) return ''
  const reveal = Math.min(1, localT01(clip, timeMs) / 0.7)
  const n = Math.max(0, Math.floor(chars.length * reveal + 1e-6))
  return chars.slice(0, n).join('')
}

export const FADE_IN_KEYS = [
  { t: 0, value: 0, ease: 'ease_out' as const },
  { t: 0.16, value: 1, ease: 'linear' as const },
  { t: 1, value: 1, ease: 'linear' as const }
]
