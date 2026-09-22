import type { ClipEffect, ClipFx, EffectType } from './types'

export type EffectParamSpec = {
  key: string
  label: string
  min: number
  max: number
  step: number
  default: number
}

export type EffectSpec = {
  type: EffectType
  label: string
  params: EffectParamSpec[]
}

export const EFFECT_REGISTRY: EffectSpec[] = [
  { type: 'blur', label: '高斯模糊', params: [{ key: 'amount', label: '强度', min: 0, max: 32, step: 0.5, default: 6 }] },
  { type: 'radial_blur', label: '径向模糊', params: [{ key: 'amount', label: '强度', min: 0, max: 24, step: 0.5, default: 8 }] },
  { type: 'glow', label: '发光', params: [{ key: 'amount', label: '强度', min: 0, max: 24, step: 0.5, default: 8 }] },
  { type: 'grain', label: '颗粒', params: [{ key: 'amount', label: '强度', min: 0, max: 40, step: 1, default: 10 }] },
  { type: 'mosaic', label: '马赛克', params: [{ key: 'amount', label: '块', min: 2, max: 64, step: 1, default: 16 }] },
  { type: 'lut', label: 'LUT', params: [] }
]

export function effectSpec(type: EffectType): EffectSpec | undefined {
  return EFFECT_REGISTRY.find((e) => e.type === type)
}

export function defaultEffect(type: EffectType, id: string): ClipEffect {
  const spec = effectSpec(type)
  const params: Record<string, number | string> = {}
  for (const p of spec?.params ?? []) params[p.key] = p.default
  return { id, type, enabled: true, params }
}

export function numParam(e: ClipEffect, key: string, fallback: number): number {
  const v = Number(e.params[key])
  return Number.isFinite(v) ? v : fallback
}

export function clipEffects(fx: ClipFx): ClipEffect[] {
  return (fx.effects ?? []).filter((e) => e.enabled !== false)
}

export function effectCss(_fx: ClipFx): string {
  return ''
}

export function simpleEffectFfmpeg(fx: ClipFx): string[] {
  const bits: string[] = []
  for (const e of clipEffects(fx)) {
    if (e.type === 'blur') {
      const s = Math.max(0.1, numParam(e, 'amount', 6) * 0.45)
      bits.push(`gblur=sigma=${s.toFixed(2)}`)
    } else if (e.type === 'radial_blur') {
      const s = Math.max(0.1, numParam(e, 'amount', 8) * 0.55)
      bits.push(`gblur=sigma=${s.toFixed(2)}`)
    } else if (e.type === 'grain') {
      const a = Math.max(1, Math.min(80, Math.round(numParam(e, 'amount', 10))))
      bits.push(`noise=alls=${a}:allf=t+u`)
    } else if (e.type === 'mosaic') {
      const b = Math.max(2, Math.round(numParam(e, 'amount', 16)))
      bits.push(`pixelize=w=${b}:h=${b}`)
    } else if (e.type === 'lut') {
      const file = String(e.params.path || '')
      if (file) {
        const esc = file.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
        bits.push(`format=gbrp`, `lut3d=file='${esc}'`)
      }
    }
  }
  return bits
}

export function hasGlow(fx: ClipFx): boolean {
  return clipEffects(fx).some((e) => e.type === 'glow')
}

export function glowSigma(fx: ClipFx): number {
  const e = clipEffects(fx).find((x) => x.type === 'glow')
  return Math.max(0.5, (e ? numParam(e, 'amount', 8) : 8) * 0.5)
}

export type CubeLut = { size: number; data: Float32Array }

export function makeLut(kind: 'warm' | 'cool' | 'contrast' | 'green', size = 9): CubeLut {
  const data = new Float32Array(size * size * size * 3)
  let i = 0
  for (let b = 0; b < size; b++) {
    for (let g = 0; g < size; g++) {
      for (let r = 0; r < size; r++) {
        let R = r / (size - 1)
        let G = g / (size - 1)
        let B = b / (size - 1)
        if (kind === 'warm') {
          R = Math.min(1, R * 1.12 + 0.04)
          B = Math.max(0, B * 0.88)
        } else if (kind === 'cool') {
          B = Math.min(1, B * 1.12 + 0.04)
          R = Math.max(0, R * 0.88)
        } else if (kind === 'contrast') {
          R = Math.min(1, Math.max(0, (R - 0.5) * 1.35 + 0.5))
          G = Math.min(1, Math.max(0, (G - 0.5) * 1.35 + 0.5))
          B = Math.min(1, Math.max(0, (B - 0.5) * 1.35 + 0.5))
        } else if (kind === 'green') {
          const t = R
          R = G
          G = t
        }
        data[i++] = R
        data[i++] = G
        data[i++] = B
      }
    }
  }
  return { size, data }
}

export function cubeFileText(lut: CubeLut): string {
  const lines = ['LUT_3D_SIZE ' + lut.size, 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 1 1']
  for (let i = 0; i < lut.data.length; i += 3) {
    lines.push(`${lut.data[i].toFixed(6)} ${lut.data[i + 1].toFixed(6)} ${lut.data[i + 2].toFixed(6)}`)
  }
  return lines.join('\n') + '\n'
}

export function parseCube(text: string): CubeLut | null {
  const lines = text.split(/\r?\n/)
  let size = 0
  const vals: number[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith('TITLE') || line.startsWith('DOMAIN')) continue
    if (line.startsWith('LUT_3D_SIZE')) {
      size = Number(line.split(/\s+/)[1])
      continue
    }
    const p = line.split(/\s+/).map(Number)
    if (p.length >= 3 && p.every(Number.isFinite)) vals.push(p[0], p[1], p[2])
  }
  if (size < 2 || vals.length < size * size * size * 3) return null
  return { size, data: Float32Array.from(vals) }
}

function lutAt(lut: CubeLut, r: number, g: number, b: number): [number, number, number] {
  const n = lut.size - 1
  const rr = Math.min(n, Math.max(0, r * n))
  const gg = Math.min(n, Math.max(0, g * n))
  const bb = Math.min(n, Math.max(0, b * n))
  const r0 = Math.floor(rr)
  const g0 = Math.floor(gg)
  const b0 = Math.floor(bb)
  const r1 = Math.min(n, r0 + 1)
  const g1 = Math.min(n, g0 + 1)
  const b1 = Math.min(n, b0 + 1)
  const idx = (ri: number, gi: number, bi: number) => ((bi * lut.size + gi) * lut.size + ri) * 3
  const c000 = idx(r0, g0, b0)
  return [lut.data[c000], lut.data[c000 + 1], lut.data[c000 + 2]]
}

export function applyLutToImageData(data: Uint8ClampedArray, lut: CubeLut): void {
  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b] = lutAt(lut, data[i] / 255, data[i + 1] / 255, data[i + 2] / 255)
    data[i] = Math.round(r * 255)
    data[i + 1] = Math.round(g * 255)
    data[i + 2] = Math.round(b * 255)
  }
}

export function applyEffectsCanvas(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  fx: ClipFx,
  lut?: CubeLut | null
): void {
  const list = clipEffects(fx)
  if (!list.length) return
  for (const e of list) {
    if (e.type === 'blur') {
      const a = numParam(e, 'amount', 6)
      if (a <= 0) continue
      const copy = document.createElement('canvas')
      copy.width = w
      copy.height = h
      copy.getContext('2d')?.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, w, h)
      ctx.save()
      ctx.clearRect(0, 0, w, h)
      ctx.filter = `blur(${a}px)`
      ctx.drawImage(copy, 0, 0)
      ctx.restore()
    } else if (e.type === 'mosaic') {
      const block = Math.max(2, Math.round(numParam(e, 'amount', 16)))
      const sw = Math.max(1, Math.round(w / block))
      const sh = Math.max(1, Math.round(h / block))
      const tmp = document.createElement('canvas')
      tmp.width = sw
      tmp.height = sh
      const t = tmp.getContext('2d')
      if (!t) continue
      t.imageSmoothingEnabled = false
      t.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, sw, sh)
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, w, h)
      ctx.drawImage(tmp, 0, 0, sw, sh, 0, 0, w, h)
      ctx.imageSmoothingEnabled = true
    } else if (e.type === 'grain') {
      const amt = numParam(e, 'amount', 10) / 100
      let img: ImageData
      try {
        img = ctx.getImageData(0, 0, w, h)
      } catch {
        continue
      }
      const d = img.data
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() * 2 - 1) * amt * 255
        d[i] = Math.min(255, Math.max(0, d[i] + n))
        d[i + 1] = Math.min(255, Math.max(0, d[i + 1] + n))
        d[i + 2] = Math.min(255, Math.max(0, d[i + 2] + n))
      }
      ctx.putImageData(img, 0, 0)
    } else if (e.type === 'glow') {
      const a = numParam(e, 'amount', 8)
      const copy = document.createElement('canvas')
      copy.width = w
      copy.height = h
      copy.getContext('2d')?.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, w, h)
      ctx.save()
      ctx.filter = `blur(${a}px)`
      ctx.globalCompositeOperation = 'lighter'
      ctx.globalAlpha = 0.45
      ctx.drawImage(copy, 0, 0)
      ctx.restore()
    } else if (e.type === 'radial_blur') {
      const a = numParam(e, 'amount', 8)
      const copy = document.createElement('canvas')
      copy.width = w
      copy.height = h
      copy.getContext('2d')?.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, w, h)
      ctx.save()
      ctx.globalAlpha = 0.18
      ctx.filter = `blur(${a * 0.4}px)`
      for (let i = 1; i <= 4; i++) {
        const s = 1 + i * a * 0.004
        ctx.drawImage(copy, (w - w * s) / 2, (h - h * s) / 2, w * s, h * s)
      }
      ctx.restore()
    } else if (e.type === 'lut' && lut) {
      let img: ImageData
      try {
        img = ctx.getImageData(0, 0, w, h)
      } catch {
        continue
      }
      applyLutToImageData(img.data, lut)
      ctx.putImageData(img, 0, 0)
    }
  }
}

export { xfadeName } from './transition'
