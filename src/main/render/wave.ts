import { downsamplePeaks } from '../../shared/audio'
import type { AssetIndex, TimeRange } from '../../shared/types'
import { detectBeats, detectPauses, readAudioFrames, segmentSpeech } from '../analysis/audio'
import { detectScenes } from '../analysis/scenes'
import { findFfmpeg } from './ffmpeg'

/** 当前分析版本；低于它的素材索引会在后台重新分析。 */
export const ANALYSIS_VERSION = 3

/** UI 波形：整段素材降采样到 bins 个 0–1 峰值。 */
export async function readWaveform(ffmpeg: string, path: string, bins = 240): Promise<number[]> {
  const frames = await readAudioFrames(ffmpeg, path)
  if (!frames?.rms.length) return []
  return downsamplePeaks(Array.from(frames.rms), bins)
}

/** 旧的 240 桶粗分析，仅在拿不到帧数据时兜底。 */
export function indexFromPeaks(peaks: number[], durationMs: number): AssetIndex {
  const silence: TimeRange[] = []
  const speech: TimeRange[] = []
  if (!peaks.length || durationMs <= 0) {
    return { silence, speech, scenes: [], peakRms: 0, waveform: peaks }
  }
  const thresh = 0.08
  const msAt = (i: number) => Math.round((i / Math.max(1, peaks.length)) * durationMs)
  let mode: 's' | 'v' | null = null
  let start = 0
  const flush = (end: number, silent: boolean) => {
    const range = { startMs: msAt(start), endMs: msAt(end) }
    if (range.endMs - range.startMs < 80) return
    if (silent) silence.push(range)
    else speech.push(range)
  }
  peaks.forEach((v, i) => {
    const silent = v < thresh
    const m: 's' | 'v' = silent ? 's' : 'v'
    if (mode == null) {
      mode = m
      start = i
      return
    }
    if (m !== mode) {
      flush(i, mode === 's')
      mode = m
      start = i
    }
  })
  if (mode) flush(peaks.length, mode === 's')
  return { silence, speech, scenes: [], peakRms: Math.max(...peaks, 0), waveform: peaks }
}

/** 音频部分：10ms 帧静音/语音、响度、节拍、UI 波形。 */
export async function analyzeAudioFile(ffmpeg: string, path: string, durationMs: number): Promise<AssetIndex> {
  const frames = await readAudioFrames(ffmpeg, path)
  if (!frames?.rms.length) return { silence: [], speech: [], scenes: [], peakRms: 0, version: ANALYSIS_VERSION }
  const total = durationMs > 0 ? durationMs : frames.rms.length * 10
  const seg = segmentSpeech(frames.rms, total)
  const { beats, bpm } = detectBeats(frames.rms, frames.hf)
  let peak = 0
  for (const v of frames.rms) if (v > peak) peak = v
  const index: AssetIndex = {
    silence: seg.silence,
    speech: seg.speech,
    pauses: detectPauses(frames.rms, seg.speech),
    scenes: [],
    peakRms: Math.round(peak * 10000) / 10000,
    waveform: downsamplePeaks(Array.from(frames.rms), 240),
    version: ANALYSIS_VERSION,
    beats,
    noiseFloorDb: Math.round(seg.noiseFloorDb * 10) / 10,
    speechLevelDb: Math.round(seg.speechLevelDb * 10) / 10
  }
  if (bpm != null) index.bpm = bpm
  if (frames.lufs != null) index.lufs = frames.lufs
  if (frames.truePeak != null) index.truePeak = frames.truePeak
  if (frames.lra != null) index.lra = frames.lra
  return index
}

/**
 * 素材分析。scenes=false 时跳过镜头检测（长视频解码慢，交给后台队列）。
 * 音频与画面两路 ffmpeg 并行。
 */
export async function analyzeMediaFile(
  path: string,
  durationMs: number,
  opts: { scenes?: boolean } = {}
): Promise<AssetIndex> {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) return { silence: [], speech: [], scenes: [], peakRms: 0 }
  try {
    const wantScenes = opts.scenes ?? true
    const [index, scenes] = await Promise.all([
      analyzeAudioFile(ffmpeg, path, durationMs),
      wantScenes ? detectScenes(ffmpeg, path, durationMs) : Promise.resolve(null)
    ])
    if (scenes) {
      index.scenes = scenes
      index.scenesDetected = true
    }
    return index
  } catch {
    return { silence: [], speech: [], scenes: [], peakRms: 0 }
  }
}
