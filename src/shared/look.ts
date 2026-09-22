/** 画面观感统计（0–1 归一化）。 */
export interface LookStats {
  /** 平均亮度（BT.709 luma）。 */
  lumaMean: number
  lumaP5: number
  lumaP95: number
  /** 平均色度（max(RGB) − min(RGB)，按像素平均；普通素材约 0.1–0.25）。 */
  satMean: number
  /** 冷暖：平均 (R − B)，−1 冷 … 1 暖。 */
  warmth: number
}

/** 与 ClipFx.color 同结构；各项已限制在 −0.3–0.3。 */
export interface ColorAdjust {
  exposure: number
  contrast: number
  saturation: number
  warmth: number
}

const LIMIT = 0.3
const clamp = (v: number) => Math.round(Math.min(LIMIT, Math.max(-LIMIT, v)) * 100) / 100

/*
 * 与 shared/fx.ts 的渲染映射保持一致：
 *   brightness = exposure × 0.4（加在 0–1 亮度上）
 *   contrast   = 1 + contrast × 0.4（绕 0.5 缩放）
 *   saturation = 1 + saturation × 0.5（色度倍数）
 * warmth 渲染为 colortemperature（6600K ∓ warmth×3333K，pl=1）。实测中灰卡 ΔR−B ≈ 0.21 × warmth，
 * 饱和画面因通道截断响应更小（testsrc2 约 0.06）；按灰卡标定，真实素材上只会偏保守、不会过调。
 */
const EXPOSURE_GAIN = 0.4
const CONTRAST_GAIN = 0.4
const SAT_GAIN = 0.5
const WARMTH_GAIN = 4.7

/** 让统计值 v 回到 [lo, hi]；已在区间内返回 0。 */
function toward(v: number, lo: number, hi: number): number {
  if (v < lo) return lo - v
  if (v > hi) return hi - v
  return 0
}

/**
 * 自动增强：只修明显偏离的项（过暗/过亮、发灰/过硬、过淡/过艳、明显偏色），
 * 正常素材各项接近 0。修正量打 7 折，宁可保守。
 */
export function enhanceFromLook(look: LookStats): ColorAdjust {
  const damp = 0.7
  const spread = Math.max(0.02, look.lumaP95 - look.lumaP5)
  const exposureDelta = toward(look.lumaMean, 0.38, 0.58)
  const targetSpread = spread < 0.55 ? 0.7 : spread > 0.95 ? 0.88 : spread
  const satTarget = look.satMean < 0.07 ? 0.12 : look.satMean > 0.35 ? 0.28 : look.satMean
  // 近乎黑白的素材不硬拉饱和度
  const sat = look.satMean < 0.015 ? 0 : (satTarget / Math.max(0.01, look.satMean) - 1) / SAT_GAIN
  return {
    exposure: clamp((exposureDelta / EXPOSURE_GAIN) * damp),
    contrast: clamp(((targetSpread / spread - 1) / CONTRAST_GAIN) * damp),
    saturation: clamp(sat * damp),
    warmth: clamp(toward(look.warmth, -0.05, 0.12) * WARMTH_GAIN * damp)
  }
}

/** 让 target 的观感接近 ref（多机位统一色调）。两者本来一致时各项为 0。 */
export function matchLook(ref: LookStats, target: LookStats): ColorAdjust {
  const refSpread = Math.max(0.02, ref.lumaP95 - ref.lumaP5)
  const tgtSpread = Math.max(0.02, target.lumaP95 - target.lumaP5)
  const sat = target.satMean < 0.015 ? 0 : (ref.satMean / Math.max(0.01, target.satMean) - 1) / SAT_GAIN
  return {
    exposure: clamp((ref.lumaMean - target.lumaMean) / EXPOSURE_GAIN),
    contrast: clamp((refSpread / tgtSpread - 1) / CONTRAST_GAIN),
    saturation: clamp(sat),
    warmth: clamp((ref.warmth - target.warmth) * WARMTH_GAIN)
  }
}

/** 从 RGB24 像素累积统计（供 main 侧 measureLook 和测试使用）。 */
export class LookAccumulator {
  private hist = new Float64Array(256)
  private n = 0
  private luma = 0
  private sat = 0
  private warm = 0

  add(rgb: Uint8Array): void {
    for (let i = 0; i + 2 < rgb.length; i += 3) {
      const r = rgb[i]! / 255
      const g = rgb[i + 1]! / 255
      const b = rgb[i + 2]! / 255
      const y = 0.2126 * r + 0.7152 * g + 0.0722 * b
      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      this.luma += y
      this.sat += max - min
      this.warm += r - b
      this.hist[Math.min(255, Math.round(y * 255))]!++
      this.n++
    }
  }

  result(): LookStats | null {
    if (!this.n) return null
    const pct = (p: number) => {
      const target = p * this.n
      let acc = 0
      for (let i = 0; i < 256; i++) {
        acc += this.hist[i]!
        if (acc >= target) return i / 255
      }
      return 1
    }
    const r3 = (v: number) => Math.round(v * 1000) / 1000
    return {
      lumaMean: r3(this.luma / this.n),
      lumaP5: r3(pct(0.05)),
      lumaP95: r3(pct(0.95)),
      satMean: r3(this.sat / this.n),
      warmth: r3(this.warm / this.n)
    }
  }
}
