import { spawn } from 'node:child_process'
import type { PauseRange, TimeRange } from '../../shared/types'

/** 分析帧长：10ms。 */
export const FRAME_MS = 10
const RATE = 16000
const HOP = (RATE * FRAME_MS) / 1000

export interface AudioFrames {
  /** 每 10ms 一帧的 RMS（0–1，线性）。 */
  rms: Float32Array
  /** 一阶差分（高频加重）信号的 RMS，用于 onset。 */
  hf: Float32Array
  lufs?: number
  truePeak?: number
  lra?: number
}

/**
 * 一次 ffmpeg 解码同时拿到 10ms 帧能量和 EBU R128 响度。
 * PCM 流式处理，不在内存里保留整段采样。
 */
export function readAudioFrames(ffmpeg: string, path: string): Promise<AudioFrames | null> {
  return new Promise((resolve) => {
    const child = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-nostats',
        '-i',
        path,
        '-vn',
        '-sn',
        '-af',
        'ebur128=peak=true:framelog=quiet',
        '-ac',
        '1',
        '-ar',
        String(RATE),
        '-f',
        's16le',
        '-acodec',
        'pcm_s16le',
        'pipe:1'
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    const rms: number[] = []
    const hf: number[] = []
    let carry: Buffer | null = null
    let acc = 0
    let accHf = 0
    let n = 0
    let prev = 0
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => {
      const buf: Buffer = carry ? Buffer.concat([carry, chunk]) : chunk
      const usable = buf.length - (buf.length % 2)
      for (let o = 0; o < usable; o += 2) {
        const v = buf.readInt16LE(o) / 32768
        const d = v - prev
        prev = v
        acc += v * v
        accHf += d * d
        if (++n === HOP) {
          rms.push(Math.sqrt(acc / HOP))
          hf.push(Math.sqrt(accHf / HOP))
          acc = 0
          accHf = 0
          n = 0
        }
      }
      carry = usable < buf.length ? buf.subarray(usable) : null
    })
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 256_000) stderr = stderr.slice(-64_000)
    })
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      if (n > HOP / 4) {
        rms.push(Math.sqrt(acc / n))
        hf.push(Math.sqrt(accHf / n))
      }
      if (code !== 0 && !rms.length) return resolve(null)
      resolve({ rms: Float32Array.from(rms), hf: Float32Array.from(hf), ...parseEbur128(stderr) })
    })
  })
}

export function parseEbur128(stderr: string): { lufs?: number; truePeak?: number; lra?: number } {
  const at = stderr.lastIndexOf('Summary:')
  if (at < 0) return {}
  const s = stderr.slice(at)
  const num = (re: RegExp): number | undefined => {
    const m = re.exec(s)
    if (!m) return undefined
    const v = Number(m[1])
    return Number.isFinite(v) ? v : undefined
  }
  const out: { lufs?: number; truePeak?: number; lra?: number } = {}
  const lufs = num(/I:\s+(-?[\d.]+|-inf)\s+LUFS/)
  const truePeak = num(/Peak:\s+(-?[\d.]+|-inf)\s+dBFS/)
  const lra = num(/LRA:\s+(-?[\d.]+)\s+LU/)
  // 全静音时 ebur128 给出 -70 LUFS 附近的门限值，视为无意义
  if (lufs != null && lufs > -69) out.lufs = lufs
  if (truePeak != null) out.truePeak = truePeak
  if (lra != null) out.lra = lra
  return out
}

export function toDb(rms: number): number {
  return rms > 1e-5 ? 20 * Math.log10(rms) : -100
}

function percentile(sorted: Float32Array, p: number): number {
  if (!sorted.length) return -100
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))
  return sorted[i] ?? -100
}

export interface SpeechSegmentation {
  silence: TimeRange[]
  speech: TimeRange[]
  noiseFloorDb: number
  speechLevelDb: number
  thresholdDb: number
}

export interface SegmentOptions {
  /** 短于此的静音并入语音（字间停顿）。 */
  minSilenceMs?: number
  /** 短于此的语音视为噪声（咔哒声）。 */
  minSpeechMs?: number
}

/**
 * 按 10ms 帧做语音/静音分段。阈值相对素材自身噪底（dBFS）自适应，带迟滞，
 * 所以对整体音量高低不敏感。输出区间覆盖整段素材、互不重叠。
 */
export function segmentSpeech(rms: ArrayLike<number>, durationMs: number, opts: SegmentOptions = {}): SpeechSegmentation {
  const minSilence = opts.minSilenceMs ?? 150
  const minSpeech = opts.minSpeechMs ?? 60
  const frames = rms.length
  const total = durationMs > 0 ? durationMs : frames * FRAME_MS
  const db = new Float32Array(frames)
  for (let i = 0; i < frames; i++) db[i] = toDb(rms[i] ?? 0)
  const sorted = Float32Array.from(db).sort()
  // 数字静音（片头黑场、剪辑补零）不参与噪底估计，否则持续底噪会被当成语音
  const live = sorted.filter((v) => v > -90)
  const floor = live.length >= Math.max(10, frames * 0.2) ? percentile(live, 0.1) : percentile(sorted, 0.1)
  const loud = percentile(sorted, 0.95)
  const span = loud - floor
  const empty = { silence: [], speech: [], noiseFloorDb: floor, speechLevelDb: loud, thresholdDb: floor }
  if (!frames) return empty
  const whole = [{ startMs: 0, endMs: Math.round(total) }]
  if (loud < -55) return { ...empty, silence: whole, thresholdDb: loud }
  if (span < 8) return { ...empty, speech: whole, thresholdDb: floor }
  // 开阈值在噪底之上至少 8dB，关阈值再低 4dB；绝对下限 -60dBFS
  const on = Math.max(-60, floor + Math.max(8, span * 0.3))
  const off = Math.max(-64, on - 4)
  const voiced = new Uint8Array(frames)
  let state = db[0]! >= on ? 1 : 0
  for (let i = 0; i < frames; i++) {
    const v = db[i]!
    if (state === 0 && v >= on) state = 1
    else if (state === 1 && v < off) state = 0
    voiced[i] = state
  }
  const runs: { v: number; a: number; b: number }[] = []
  for (let i = 0; i < frames; ) {
    let j = i
    while (j < frames && voiced[j] === voiced[i]) j++
    runs.push({ v: voiced[i]!, a: i, b: j })
    i = j
  }
  // 先去掉孤立的短噪声，再合并字间短停顿
  const drop = (kind: number, minFrames: number) => {
    for (let k = 0; k < runs.length; k++) {
      const r = runs[k]!
      if (r.v !== kind || r.b - r.a >= minFrames) continue
      if (kind === 0 && (k === 0 || k === runs.length - 1)) continue
      r.v = 1 - kind
    }
    for (let k = 1; k < runs.length; ) {
      if (runs[k]!.v === runs[k - 1]!.v) {
        runs[k - 1]!.b = runs[k]!.b
        runs.splice(k, 1)
      } else k++
    }
  }
  drop(1, Math.ceil(minSpeech / FRAME_MS))
  drop(0, Math.ceil(minSilence / FRAME_MS))
  const ms = (f: number) => Math.min(Math.round(total), Math.round(f * FRAME_MS))
  const silence: TimeRange[] = []
  const speech: TimeRange[] = []
  for (const r of runs) {
    const range = { startMs: ms(r.a), endMs: r.b >= frames ? Math.round(total) : ms(r.b) }
    if (range.endMs <= range.startMs) continue
    ;(r.v ? speech : silence).push(range)
  }
  return { silence, speech, noiseFloorDb: floor, speechLevelDb: loud, thresholdDb: on }
}

/**
 * 细粒度停顿：语音里短至 60ms 的能量下陷（相对局部语音电平 ≥ 12dB），以及更浅/更短的能量谷。
 * 局部语音电平 = ±400ms 窗口内的第 80 百分位；帧能量先做 3 帧中值滤波去掉单帧毛刺。
 * speech 为 segmentSpeech 的语音段：只在语音段内部和段间找，片头片尾不算停顿。
 */
export function detectPauses(rms: ArrayLike<number>, speech: TimeRange[], opts: { minMs?: number; dropDb?: number; valleyDb?: number } = {}): PauseRange[] {
  const frames = rms.length
  if (frames < 10 || !speech.length) return []
  const minFrames = Math.ceil((opts.minMs ?? 60) / FRAME_MS)
  const dropDb = opts.dropDb ?? 12
  const valleyDb = opts.valleyDb ?? 9
  const raw = new Float32Array(frames)
  for (let i = 0; i < frames; i++) raw[i] = toDb(rms[i] ?? 0)
  const db = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    const a = raw[Math.max(0, i - 1)]!
    const b = raw[i]!
    const c = raw[Math.min(frames - 1, i + 1)]!
    db[i] = Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
  }
  const W = 40
  const local = new Float32Array(frames)
  const win: number[] = []
  for (let i = 0; i < frames; i += 5) {
    win.length = 0
    for (let k = Math.max(0, i - W); k < Math.min(frames, i + W + 1); k++) win.push(db[k]!)
    win.sort((x, y) => x - y)
    const v = win[Math.floor(win.length * 0.8)]!
    for (let k = i; k < Math.min(frames, i + 5); k++) local[k] = v
  }
  const first = Math.floor(speech[0]!.startMs / FRAME_MS)
  const last = Math.ceil(speech[speech.length - 1]!.endMs / FRAME_MS)
  const out: PauseRange[] = []
  const r1 = (v: number) => Math.round(v * 10) / 10
  let i = first
  while (i < Math.min(last, frames)) {
    if (db[i]! > local[i]! - dropDb) {
      i++
      continue
    }
    let j = i
    let sum = 0
    let lvl = 0
    while (j < Math.min(last, frames) && db[j]! <= local[j]! - dropDb) {
      sum += db[j]!
      lvl += local[j]!
      j++
    }
    const n = j - i
    if (i > first && j < last) {
      out.push({ startMs: i * FRAME_MS, endMs: j * FRAME_MS, depthDb: r1((lvl - sum) / n), ...(n < minFrames ? { valley: true } : {}) })
    }
    i = j
  }
  // 更浅的能量谷：局部极小，比两侧 ±150ms 内的峰低 ≥ valleyDb，且不落在已有停顿里
  const inPause = (k: number) => out.some((p) => k * FRAME_MS >= p.startMs - 20 && k * FRAME_MS < p.endMs + 20)
  for (let k = first + 3; k < Math.min(last, frames) - 3; k++) {
    const v = db[k]!
    if (v > db[k - 1]! || v > db[k + 1]! || v > db[k - 2]! || v > db[k + 2]!) continue
    let left = -Infinity
    let right = -Infinity
    for (let q = Math.max(0, k - 15); q < k; q++) left = Math.max(left, db[q]!)
    for (let q = k + 1; q <= Math.min(frames - 1, k + 15); q++) right = Math.max(right, db[q]!)
    const depth = Math.min(left, right) - v
    if (depth < valleyDb || inPause(k)) continue
    out.push({ startMs: (k - 1) * FRAME_MS, endMs: (k + 2) * FRAME_MS, depthDb: r1(depth), valley: true })
    k += 5
  }
  out.sort((a, b) => a.startMs - b.startMs)
  return out.length > 20000 ? out.slice(0, 20000) : out
}

export interface BeatAnalysis {
  beats: number[]
  bpm?: number
}

/**
 * Onset 检测：全频 + 高频加重两路能量的 dB 上升量（半波整流）作为 onset 强度，
 * 局部均值自适应阈值 + 峰值拾取；再用 onset 强度自相关估计 BPM。
 */
export function detectBeats(rms: ArrayLike<number>, hf: ArrayLike<number>, maxBeats = 4000): BeatAnalysis {
  const frames = Math.min(rms.length, hf.length)
  if (frames < 20) return { beats: [] }
  const strength = new Float32Array(frames)
  let pa = toDb(rms[0] ?? 0)
  let pb = toDb(hf[0] ?? 0)
  for (let i = 1; i < frames; i++) {
    const a = toDb(rms[i] ?? 0)
    const b = toDb(hf[i] ?? 0)
    // 太安静的帧不算 onset
    const gate = a > -50 ? 1 : 0
    strength[i] = gate * (Math.max(0, a - pa) + Math.max(0, b - pb))
    pa = a
    pb = b
  }
  // 局部平滑 30ms，抑制单帧抖动
  const sm = new Float32Array(frames)
  for (let i = 1; i < frames - 1; i++) sm[i] = (strength[i - 1]! + 2 * strength[i]! + strength[i + 1]!) / 4
  const W = 50 // ±500ms
  const prefix = new Float64Array(frames + 1)
  for (let i = 0; i < frames; i++) prefix[i + 1] = prefix[i]! + sm[i]!
  const globalMean = prefix[frames]! / frames
  const beats: number[] = []
  const minGap = 10 // 100ms
  let last = -minGap
  for (let i = 3; i < frames - 3; i++) {
    const v = sm[i]!
    if (v <= 0) continue
    const a = Math.max(0, i - W)
    const b = Math.min(frames, i + W + 1)
    const localMean = (prefix[b]! - prefix[a]!) / (b - a)
    if (v < Math.max(localMean * 2.2 + 1, globalMean * 1.5, 3)) continue
    let isPeak = true
    for (let k = i - 3; k <= i + 3; k++) if (k !== i && sm[k]! > v) isPeak = false
    if (!isPeak) continue
    if (i - last < minGap) {
      if (beats.length && v > sm[last]!) {
        beats[beats.length - 1] = i * FRAME_MS
        last = i
      }
      continue
    }
    beats.push(i * FRAME_MS)
    last = i
    if (beats.length >= maxBeats) break
  }
  return { beats, bpm: estimateBpm(sm) }
}

function estimateBpm(sm: Float32Array): number | undefined {
  // 最多看前 2 分钟
  const n = Math.min(sm.length, 12000)
  if (n < 400) return undefined
  let mean = 0
  for (let i = 0; i < n; i++) mean += sm[i]!
  mean /= n
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = sm[i]! - mean
  let energy = 0
  for (let i = 0; i < n; i++) energy += x[i]! * x[i]!
  if (energy <= 0) return undefined
  let bestLag = 0
  let best = 0
  // 60–200 BPM → 滞后 30–100 帧；对 120BPM 附近加一点先验权重
  for (let lag = 30; lag <= 100; lag++) {
    let s = 0
    for (let i = lag; i < n; i++) s += x[i]! * x[i - lag]!
    const bpm = 6000 / lag
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.9, 2))
    const score = (s / energy) * prior
    if (score > best) {
      best = score
      bestLag = lag
    }
  }
  if (!bestLag || best < 0.05) return undefined
  return Math.round((6000 / bestLag) * 10) / 10
}
