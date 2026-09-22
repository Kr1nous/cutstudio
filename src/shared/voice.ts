/**
 * 人声增强（voice_enhance）：高通 → 降噪（可选）→ 压缩 → 去齿音 → 临场感 EQ。只在导出链路生效，预览听不出。
 * has(filter) 用来跳过本机 ffmpeg 没有的滤镜。
 */
import type { ClipFx } from './types'

export type VoicePreset = 'podcast' | 'clear' | 'warm'
export const VOICE_PRESETS: VoicePreset[] = ['podcast', 'clear', 'warm']
/** 预设可能用到的滤镜（导出前逐个确认本机有没有）。 */
export const VOICE_FILTERS = ['highpass', 'afftdn', 'acompressor', 'deesser', 'equalizer', 'lowshelf']

interface PresetSpec {
  highpass: number
  /** afftdn 降噪量（dB），0 = 不降噪 */
  nr: number
  comp: { threshold: number; ratio: number; attack: number; release: number; makeup: number }
  deess: number
  presence: { f: number; g: number }
  lowshelf?: { f: number; g: number }
}

const SPECS: Record<VoicePreset, PresetSpec> = {
  // 播客：降一点底噪，压缩稍重，让音量更稳
  podcast: { highpass: 80, nr: 8, comp: { threshold: -20, ratio: 3, attack: 10, release: 150, makeup: 2.5 }, deess: 0.5, presence: { f: 3000, g: 2 } },
  // 清晰：高通更高、临场感更强，压缩轻
  clear: { highpass: 100, nr: 0, comp: { threshold: -18, ratio: 2, attack: 15, release: 200, makeup: 1.5 }, deess: 0.45, presence: { f: 3200, g: 3 } },
  // 温暖：保留低频，加一点低架，临场感轻
  warm: { highpass: 70, nr: 0, comp: { threshold: -20, ratio: 2.5, attack: 15, release: 200, makeup: 2 }, deess: 0.4, presence: { f: 2800, g: 1 }, lowshelf: { f: 200, g: 2 } }
}

const dbToLin = (db: number) => Math.pow(10, db / 20)

/** 片段 fx.voice 对应的 ffmpeg 音频滤镜（逗号链的各段）；没开或 preset 未知返回 []。 */
export function voiceFfmpeg(fx: Pick<ClipFx, 'voice' | 'denoise'>, has: (filter: string) => boolean = () => true): string[] {
  const preset = fx.voice?.preset
  if (!preset || !(preset in SPECS)) return []
  const s = SPECS[preset]
  const out: string[] = []
  if (has('highpass')) out.push(`highpass=f=${s.highpass}`)
  // 已经开了 denoise_audio 的片段不再重复降噪
  if (s.nr > 0 && !fx.denoise?.enabled && has('afftdn')) out.push(`afftdn=nr=${s.nr}:nf=-50`)
  if (s.lowshelf && has('lowshelf')) out.push(`lowshelf=f=${s.lowshelf.f}:g=${s.lowshelf.g}`)
  if (has('acompressor')) {
    const c = s.comp
    out.push(`acompressor=threshold=${dbToLin(c.threshold).toFixed(4)}:ratio=${c.ratio}:attack=${c.attack}:release=${c.release}:makeup=${dbToLin(c.makeup).toFixed(3)}`)
  }
  if (has('deesser')) out.push(`deesser=i=${s.deess}:m=0.5:f=0.5:s=o`)
  if (has('equalizer')) out.push(`equalizer=f=${s.presence.f}:t=o:w=1:g=${s.presence.g}`)
  return out
}

/** 预设实际用到、但本机没有的滤镜（给 warning 用）。 */
export function missingVoiceFilters(preset: VoicePreset, has: (filter: string) => boolean): string[] {
  const all = voiceFfmpeg({ voice: { preset }, denoise: null })
  return [...new Set(all.map((f) => f.split('=')[0]!))].filter((f) => !has(f))
}
