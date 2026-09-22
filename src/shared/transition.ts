import type { TransitionType } from './types'

export type TransPreview = 'cut' | 'fade_out' | 'mix' | 'slide' | 'wipe' | 'zoom' | 'iris' | 'blur' | 'dip'

export type TransitionSpec = {
  type: TransitionType
  label: string
  xfade: string | null
  overlap: boolean
  durationMs: number
  preview: TransPreview
  dir?: 'left' | 'right' | 'up' | 'down'
}

export const TRANSITIONS: TransitionSpec[] = [
  { type: 'none', label: '硬切', xfade: null, overlap: false, durationMs: 0, preview: 'cut' },
  { type: 'cross_dissolve', label: '柔和溶解', xfade: 'fadeslow', overlap: true, durationMs: 700, preview: 'mix' },
  { type: 'dissolve', label: '颗粒溶解', xfade: 'dissolve', overlap: true, durationMs: 700, preview: 'mix' },
  { type: 'fade_black', label: '淡出黑', xfade: null, overlap: false, durationMs: 800, preview: 'fade_out' },
  { type: 'fade_white', label: '淡出白', xfade: 'fadewhite', overlap: true, durationMs: 700, preview: 'dip' },
  { type: 'dip_black', label: '暗场', xfade: 'fadeblack', overlap: true, durationMs: 800, preview: 'dip' },
  { type: 'push', label: '右推', xfade: 'slideright', overlap: true, durationMs: 650, preview: 'slide', dir: 'right' },
  { type: 'slide_left', label: '左滑', xfade: 'slideleft', overlap: true, durationMs: 650, preview: 'slide', dir: 'left' },
  { type: 'smooth_wipe', label: '柔擦', xfade: 'smoothleft', overlap: true, durationMs: 700, preview: 'wipe', dir: 'left' },
  { type: 'wipe_up', label: '上擦', xfade: 'smoothup', overlap: true, durationMs: 700, preview: 'wipe', dir: 'up' },
  { type: 'cover', label: '盖入', xfade: 'coverleft', overlap: true, durationMs: 650, preview: 'slide', dir: 'left' },
  { type: 'reveal', label: '揭开', xfade: 'revealright', overlap: true, durationMs: 650, preview: 'wipe', dir: 'right' },
  { type: 'zoom', label: '推近', xfade: 'zoomin', overlap: true, durationMs: 750, preview: 'zoom' },
  { type: 'iris', label: '圆形', xfade: 'circleopen', overlap: true, durationMs: 700, preview: 'iris' },
  { type: 'blur_mix', label: '模糊过渡', xfade: 'hblur', overlap: true, durationMs: 700, preview: 'blur' }
]

const ALIAS: Record<string, TransitionType> = {
  none: 'none',
  cut: 'none',
  hard: 'none',
  cross_dissolve: 'cross_dissolve',
  soft_dissolve: 'cross_dissolve',
  fade: 'cross_dissolve',
  fadeslow: 'cross_dissolve',
  dissolve: 'dissolve',
  fade_black: 'fade_black',
  black: 'fade_black',
  fade_white: 'fade_white',
  white: 'fade_white',
  dip_black: 'dip_black',
  fadeblack: 'dip_black',
  dip: 'dip_black',
  push: 'push',
  slide: 'slide_left',
  slide_left: 'slide_left',
  wipe: 'smooth_wipe',
  smooth_wipe: 'smooth_wipe',
  wipe_up: 'wipe_up',
  cover: 'cover',
  reveal: 'reveal',
  zoom: 'zoom',
  zoom_in: 'zoom',
  iris: 'iris',
  circle: 'iris',
  blur: 'blur_mix',
  blur_mix: 'blur_mix',
  hblur: 'blur_mix'
}

export function transitionSpec(type: string): TransitionSpec {
  return TRANSITIONS.find((t) => t.type === type) ?? TRANSITIONS[1]
}

export function resolveTransition(raw: unknown): TransitionSpec {
  const key = String(raw || 'cross_dissolve')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
  const type = ALIAS[key] ?? (TRANSITIONS.some((t) => t.type === key) ? (key as TransitionType) : 'cross_dissolve')
  return transitionSpec(type)
}

export function xfadeName(type: string): string | null {
  return transitionSpec(type).xfade
}

export function easeInOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2
}
