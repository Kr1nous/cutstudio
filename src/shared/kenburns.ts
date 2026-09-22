/**
 * Ken Burns（缓推 / 缓拉 / 平移）：写 scale / posX / posY 关键帧。
 * 缩放按「片段当前缩放 × 倍率」算（和 punch_in 一样），位置夹在不露黑边的范围内。
 * 导出时有缩放关键帧，动画 scale 同时作用于两个轴（见 review/check.ts letterboxAt）。
 */
import { containBase } from './mask'
import { type AnimKey, type ClipFx, type EaseKind } from './types'

export interface KenBurnsFrame {
  /** 在当前缩放上再乘的倍率 */
  scale?: number
  /** 画面中心 0–1 */
  x?: number
  y?: number
}

export interface KenBurnsPlan {
  keys: { scale: AnimKey[]; posX?: AnimKey[]; posY?: AnimKey[] }
  from: { scale: number; x: number; y: number }
  to: { scale: number; x: number; y: number }
  warnings: string[]
}

/**
 * srcW / srcH 为素材考虑 crop / 旋转后的尺寸；W / H 为画布。
 * keepPos=true（片段已有位置关键帧，比如 reframe 的人物跟随，且没指定 x/y）时只做缩放动画，
 * 这时倍率必须 ≥ 1，放大不会露黑边。
 */
export function planKenBurns(
  fx: ClipFx,
  W: number,
  H: number,
  srcW: number,
  srcH: number,
  from: KenBurnsFrame = {},
  to: KenBurnsFrame = {},
  opts: { ease?: EaseKind; keepPos?: boolean } = {}
): KenBurnsPlan {
  const warnings: string[] = []
  const ease = opts.ease ?? 'ease_in_out'
  const base = fx.scale || 1
  if (fx.scaleX != null && fx.scaleY != null && Math.abs(fx.scaleX - fx.scaleY) > 0.01) {
    warnings.push('片段横纵缩放不一致，缩放动画会统一两个轴（按 scale），画面比例可能变化。')
  }
  const box = containBase(W, H, srcW, srcH)
  // 铺满画布需要的最小缩放（绝对值）
  const cover = srcW > 0 && srcH > 0 ? Math.max(W / box.w, H / box.h) : 1
  const baseCovers = base >= cover - 1e-3
  const mulFrom = from.scale ?? 1
  const mulTo = to.scale ?? 1.12
  const plan = (mul: number, x: number | undefined, y: number | undefined, label: string) => {
    let m = Math.min(1.6, Math.max(0.5, mul))
    if (m !== mul) warnings.push(`${label} 倍率 ${mul} 超出 0.5–1.6，已夹紧。`)
    let s = base * m
    // 原本铺满的片段：缩放不能小到露黑边
    if (baseCovers && s < cover - 1e-3) {
      s = cover
      m = s / base
      warnings.push(`${label} 倍率 ${mul} 会露黑边，已改为 ${round(m)}（刚好铺满）。`)
    }
    if (opts.keepPos && m < 1) {
      m = 1
      s = base
      warnings.push(`${label} 片段有位置关键帧（人物跟随），缩放倍率不能 < 1，已改为 1。`)
    }
    const w = box.w * s
    const h = box.h * s
    const clampPos = (p: number, size: number, canvas: number) => {
      if (size <= canvas + 0.5) return baseCovers ? 0.5 : p
      const lo = (canvas - size / 2) / canvas
      const hi = size / 2 / canvas
      return Math.min(hi, Math.max(lo, p))
    }
    const wantX = x ?? fx.posX
    const wantY = y ?? fx.posY
    const px = clampPos(wantX, w, W)
    const py = clampPos(wantY, h, H)
    if (Math.abs(px - wantX) > 0.002 || Math.abs(py - wantY) > 0.002) {
      warnings.push(`${label} 位置 (${round(wantX)}, ${round(wantY)}) 在 ${round(m)} 倍下会露黑边，已收到 (${round(px)}, ${round(py)})。`)
    }
    return { scale: round(s), x: round(px), y: round(py) }
  }
  const a = plan(mulFrom, from.x, from.y, '起点')
  const b = plan(mulTo, to.x, to.y, '终点')
  const track = (v0: number, v1: number): AnimKey[] => [
    { t: 0, value: v0, ease },
    { t: 1, value: v1, ease: 'linear' }
  ]
  const keys: KenBurnsPlan['keys'] = { scale: track(a.scale, b.scale) }
  if (!opts.keepPos) {
    keys.posX = track(a.x, b.x)
    keys.posY = track(a.y, b.y)
  }
  return { keys, from: a, to: b, warnings }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
