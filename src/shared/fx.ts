import { effectCss } from './effects'
import type { ClipFx, FilterName } from './types'

export type FilterLook = {
  css: string
  ffmpeg: string[]
}

export const FILTER_LOOK: Record<FilterName, FilterLook> = {
  none: { css: '', ffmpeg: [] },
  vivid: { css: 'saturate(1.35) contrast(1.08)', ffmpeg: ['eq=saturation=1.35:contrast=1.08'] },
  cinema: {
    css: 'contrast(1.12) saturate(0.86) brightness(0.96)',
    ffmpeg: ['eq=contrast=1.12:saturation=0.86:brightness=-0.04']
  },
  bw: { css: 'grayscale(1)', ffmpeg: ['hue=s=0'] },
  vintage: {
    css: 'sepia(0.4) contrast(1.05) saturate(0.82)',
    ffmpeg: ['eq=contrast=1.05:saturation=0.82', 'colorbalance=rs=0.12:gs=0.04:bs=-0.08']
  }
}

export function colorCss(fx: ClipFx): string {
  const c = fx.color
  const bits: string[] = []
  if (Math.abs(c.exposure) > 0.001) bits.push(`brightness(${1 + c.exposure * 0.4})`)
  if (Math.abs(c.contrast) > 0.001) bits.push(`contrast(${1 + c.contrast * 0.4})`)
  if (Math.abs(c.saturation) > 0.001) bits.push(`saturate(${1 + c.saturation * 0.5})`)
  // 冷暖本身靠 applyWarmthCanvas 的逐通道增益；CSS 里只补偿 colortemperature pl=1 的亮度保持。
  if (Math.abs(c.warmth) > 0.001) bits.push(`brightness(${warmthGains(c.warmth).lightness.toFixed(4)})`)
  return bits.join(' ')
}

/** warmth（约 −0.3…0.3）→ 色温 K：以 6600K 为中性（ffmpeg colortemperature 在 6600K 时增益全为 1），±0.3 ≈ ∓1000K。 */
export function warmthKelvin(warmth: number): number {
  return Math.round(6600 - warmth * (1000 / 0.3))
}

/**
 * 复刻 ffmpeg vf_colortemperature 的通道增益（Tanner Helland 近似），预览和分析用它和导出保持一致。
 * lightness：中灰在 pl=1（保持 HSL 亮度）下需要的整体补偿倍数。
 */
export function warmthGains(warmth: number): { r: number; g: number; b: number; lightness: number } {
  const t = warmthKelvin(warmth) / 100
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
  let r: number
  let g: number
  if (t <= 66) {
    r = 1
    g = 0.39008157876901960784 * Math.log(t) - 0.63184144378862745098
  } else {
    r = 1.29293618606274509804 * Math.pow(t - 60, -0.1332047592)
    g = 1.12989086089529411765 * Math.pow(t - 60, -0.0755148492)
  }
  const b = t >= 66 ? 1 : t <= 19 ? 0 : 0.54320678911019607843 * Math.log(t - 10) - 1.19625408914
  const R = clamp01(r)
  const G = clamp01(g)
  const B = clamp01(b)
  return { r: R, g: G, b: B, lightness: 2 / Math.max(1e-3, Math.max(R, G, B) + Math.min(R, G, B)) }
}

/** 预览：在已套过 videoFilterCss 的画布上乘以冷暖增益（只作用于已有像素，保留透明区域）。 */
export function applyWarmthCanvas(ctx: CanvasRenderingContext2D, w: number, h: number, fx: ClipFx): void {
  const warmth = fx.color?.warmth ?? 0
  if (Math.abs(warmth) <= 0.001) return
  const g = warmthGains(warmth)
  const alpha = document.createElement('canvas')
  alpha.width = w
  alpha.height = h
  alpha.getContext('2d')?.drawImage(ctx.canvas, 0, 0)
  ctx.save()
  ctx.globalCompositeOperation = 'multiply'
  ctx.fillStyle = `rgb(${Math.round(g.r * 255)}, ${Math.round(g.g * 255)}, ${Math.round(g.b * 255)})`
  ctx.fillRect(0, 0, w, h)
  ctx.globalCompositeOperation = 'destination-in'
  ctx.drawImage(alpha, 0, 0)
  ctx.restore()
}

export function colorFfmpeg(fx: ClipFx): string[] {
  const c = fx.color
  const bits: string[] = []
  const brightness = c.exposure * 0.4
  const contrast = 1 + c.contrast * 0.4
  const saturation = 1 + c.saturation * 0.5
  if (Math.abs(brightness) > 0.001 || Math.abs(contrast - 1) > 0.001 || Math.abs(saturation - 1) > 0.001) {
    bits.push(
      `eq=brightness=${brightness.toFixed(3)}:contrast=${contrast.toFixed(3)}:saturation=${saturation.toFixed(3)}`
    )
  }
  if (Math.abs(c.warmth) > 0.001) bits.push(`colortemperature=temperature=${warmthKelvin(c.warmth)}:pl=1`)
  return bits
}

export function videoFilterCss(fx: ClipFx): string {
  return [FILTER_LOOK[fx.filter]?.css, colorCss(fx), effectCss(fx)].filter(Boolean).join(' ')
}

export function videoFilterFfmpeg(fx: ClipFx): string[] {
  return [...(FILTER_LOOK[fx.filter]?.ffmpeg ?? []), ...colorFfmpeg(fx)]
}

export function videoTransformCss(fx: ClipFx): string {
  const bits: string[] = []
  if (fx.rotate) bits.push(`rotate(${fx.rotate}deg)`)
  if (fx.flipX) bits.push('scaleX(-1)')
  if (fx.flipY) bits.push('scaleY(-1)')
  if (fx.scale && fx.scale !== 1) bits.push(`scale(${fx.scale})`)
  return bits.join(' ')
}
