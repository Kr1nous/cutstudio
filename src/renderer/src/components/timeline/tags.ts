import type { TimelineClip } from '@shared/types'
import { clipBlend, clipFx, clipKind } from '@shared/types'

const TRANSITION_LABEL: Record<string, string> = {
  cross_dissolve: '溶解',
  dissolve: '颗粒溶解',
  fade_black: '淡出黑',
  fade_white: '闪白',
  dip_black: '暗场',
  push: '右推',
  slide_left: '左滑',
  smooth_wipe: '柔擦',
  wipe_up: '上擦',
  cover: '盖入',
  reveal: '揭开',
  zoom: '推近',
  iris: '圆形',
  blur_mix: '模糊过渡'
}

export function transitionLabel(type: string): string {
  return TRANSITION_LABEL[type] ?? type
}

/** 片段上用了哪些效果（显示在片段块里的一行小字）。 */
export function fxTags(clip: TimelineClip): string[] {
  const fx = clipFx(clip)
  const tags: string[] = []
  const filter = { vivid: '鲜艳', cinema: '电影', bw: '黑白', vintage: '复古' }[fx.filter as string]
  if (filter) tags.push(filter)
  if (Math.abs(fx.speed - 1) > 0.01) tags.push(`${fx.speed.toFixed(2)}×`)
  if (fx.rotate) tags.push(`${fx.rotate}°`)
  if (fx.flipX) tags.push('翻转')
  if (fx.crop) tags.push('裁切')
  const blend = { add: '相加', screen: '滤色', multiply: '正片' }[clipBlend(clip) as string]
  if (blend) tags.push(blend)
  if (fx.masks.length) tags.push('蒙版')
  if (fx.keys && Object.values(fx.keys).some((k) => k?.length)) tags.push('关键帧')
  if (fx.audioLink) tags.push('鼓点')
  if (fx.denoise?.enabled) tags.push('降噪')
  if (fx.voice?.preset) tags.push('人声')
  if (fx.freeze) tags.push('冻结')
  if (fx.reverse) tags.push('倒放')
  if (fx.stabilize?.enabled) tags.push('稳像')
  if (fx.key) tags.push('抠像')
  if (clip.volume === 0 && clipKind(clip) === 'footage') tags.push('静音')
  for (const e of fx.effects) {
    if (e.enabled === false) continue
    tags.push({ blur: '模糊', radial_blur: '径向', glow: '发光', grain: '颗粒', mosaic: '马赛克', lut: 'LUT' }[e.type as string] ?? e.type)
  }
  const c = fx.color
  if (c.exposure || c.contrast || c.saturation || c.warmth) tags.push('调色')
  return tags
}
