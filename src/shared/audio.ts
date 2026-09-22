import { ffmpegInterp, localT01, sampleKeys, type EaseKind } from './anim'
import { sourceTimeMs } from './compose'
import { clipFx } from './types'
import type { AnimKey, ClipFx, MediaAsset, Timeline, TimelineClip } from './types'

export function volumeAt(clip: TimelineClip, timeMs: number): number {
  const fx = clipFx(clip)
  const v = sampleKeys(fx.keys?.volume, localT01(clip, timeMs), clip.volume)
  return Math.min(2, Math.max(0, v))
}

export function envelopeAt(peaks: number[] | undefined, durationMs: number, timeMs: number): number {
  if (!peaks?.length || durationMs <= 0) return 0
  const u = Math.min(1, Math.max(0, timeMs / durationMs))
  const x = u * (peaks.length - 1)
  const i = Math.floor(x)
  const f = x - i
  const a = peaks[i] ?? 0
  const b = peaks[Math.min(peaks.length - 1, i + 1)] ?? a
  return a + (b - a) * f
}

export function downsamplePeaks(rms: number[], bins = 240): number[] {
  if (!rms.length) return []
  const n = Math.max(1, Math.min(bins, rms.length))
  const out: number[] = []
  const step = rms.length / n
  for (let i = 0; i < n; i++) {
    const a = Math.floor(i * step)
    const b = Math.max(a + 1, Math.floor((i + 1) * step))
    let m = 0
    for (let j = a; j < b && j < rms.length; j++) m = Math.max(m, rms[j] ?? 0)
    out.push(m)
  }
  const peak = Math.max(...out, 0.0001)
  return out.map((v) => Math.min(1, v / peak))
}

export function sliceWaveform(peaks: number[] | undefined, assetDurMs: number, inMs: number, outMs: number): number[] {
  if (!peaks?.length || assetDurMs <= 0) return []
  const a = Math.min(1, Math.max(0, inMs / assetDurMs))
  const b = Math.min(1, Math.max(a + 1 / peaks.length, outMs / assetDurMs))
  const i0 = Math.floor(a * (peaks.length - 1))
  const i1 = Math.max(i0 + 1, Math.ceil(b * (peaks.length - 1)))
  return peaks.slice(i0, i1 + 1)
}

/**
 * 鼓点时间（素材源毫秒）。传入 beats（index.beats，10ms 精度 onset 检测结果）时优先使用；
 * 否则退回基于 240 桶波形的粗略峰值。
 */
export function onsetTimes(peaks: number[], durationMs: number, thresh = 0.55, beats?: number[]): number[] {
  if (beats?.length) return beats.filter((t) => t >= 0 && (durationMs <= 0 || t <= durationMs))
  if (peaks.length < 3 || durationMs <= 0) return []
  const out: number[] = []
  for (let i = 1; i < peaks.length - 1; i++) {
    const p = peaks[i] ?? 0
    if (p >= thresh && p >= (peaks[i - 1] ?? 0) && p > (peaks[i + 1] ?? 0)) {
      out.push((i / (peaks.length - 1)) * durationMs)
    }
  }
  return out.slice(0, 48)
}

export function beatScaleKeys(
  onsetsAssetMs: number[],
  audioClip: TimelineClip,
  visualClip: TimelineClip,
  amount: number,
  baseScale: number
): AnimKey[] {
  const amt = Math.min(1.5, Math.max(0.05, amount))
  const peak = baseScale * (1 + amt)
  const keys: AnimKey[] = []
  const easeOut: EaseKind = 'ease_out'
  const easeIn: EaseKind = 'ease_in'
  for (const assetMs of onsetsAssetMs) {
    const timelineMs = audioClip.startMs + (assetMs - audioClip.inMs)
    const t = visualClip.durationMs > 0 ? (timelineMs - visualClip.startMs) / visualClip.durationMs : 0
    if (t < -0.02 || t > 1.02) continue
    const tt = Math.min(1, Math.max(0, t))
    if (tt - 0.04 > 0.001) keys.push({ t: tt - 0.04, value: baseScale, ease: easeOut })
    keys.push({ t: tt, value: peak, ease: easeIn })
    keys.push({ t: Math.min(1, tt + 0.1), value: baseScale, ease: 'linear' })
  }
  if (!keys.some((k) => k.t <= 0.0001)) keys.push({ t: 0, value: baseScale, ease: 'linear' })
  if (!keys.some((k) => k.t >= 0.999)) keys.push({ t: 1, value: baseScale, ease: 'linear' })
  return keys.sort((a, b) => a.t - b.t)
}

export function denoiseFfmpeg(fx: ClipFx): string[] {
  if (!fx.denoise?.enabled) return []
  const nr = Math.max(4, Math.min(24, 6 + (fx.denoise.amount ?? 0.5) * 18))
  return [`highpass=f=80`, `afftdn=nr=${nr.toFixed(1)}:nf=-50`]
}

export function volumeFilter(clip: TimelineClip, duck = 1): string | null {
  const fx = clipFx(clip)
  if (fx.keys?.volume?.length) {
    const expr = ffmpegInterp(fx.keys.volume, clip.durationMs / 1000, clip.volume, 't')
    const body = Math.abs(duck - 1) > 0.001 ? `(${expr})*${duck.toFixed(3)}` : expr
    return `volume=eval=frame:volume=${body}`
  }
  const v = clip.volume * duck
  if (Math.abs(v - 1) < 0.001) return null
  return `volume=${v.toFixed(3)}`
}

export function audioGlowFfmpeg(fx: ClipFx, durationS: number): string | null {
  const link = fx.audioLink
  if (!link || (link.prop !== 'glow' && link.prop !== 'both')) return null
  const keys = fx.keys?.scale
  if (!keys?.length) return null
  const base = fx.scale || 1
  const peak = Math.max(...keys.map((k) => k.value), base + 0.01)
  const pulse = keys.map((k) => ({
    ...k,
    value: Math.min(1, Math.max(0, (k.value - base) / (peak - base)))
  }))
  const p = ffmpegInterp(pulse, durationS, 0, 'T')
  return `format=rgba,geq=r='r(X\\,Y)*(1+0.22*(${p}))':g='g(X\\,Y)*(1+0.22*(${p}))':b='b(X\\,Y)*(1+0.22*(${p}))':a='alpha(X\\,Y)'`
}

export function mixEnvelope(assets: MediaAsset[], timeline: Timeline, timeMs: number): number {
  let env = 0
  for (const clip of [...timeline.storyline, ...timeline.audio]) {
    if (timeMs < clip.startMs || timeMs >= clip.startMs + clip.durationMs) continue
    const asset = assets.find((a) => a.id === clip.assetId)
    const peaks = asset?.index?.waveform
    if (!peaks?.length) continue
    const src = sourceTimeMs(clip, timeMs)
    const e = envelopeAt(peaks, asset?.durationMs || 1, src) * Math.min(1, volumeAt(clip, timeMs))
    if (e > env) env = e
  }
  return Math.min(1, env)
}
