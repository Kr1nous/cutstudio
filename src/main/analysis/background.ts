import type { AppSettings, MediaAsset, Project } from '../../shared/types'
import { findFfmpeg } from '../render/ffmpeg'
import { ANALYSIS_VERSION, analyzeAudioFile } from '../render/wave'
import { TRANSCRIPT_ALIGN_VERSION, filterHallucinations, refineWordTimings } from '../../shared/wordalign'
import { transcriptionPrompt } from '../../shared/transcriptfix'
import { detectScenes } from './scenes'
import { transcribeFile, transcriberAvailable } from './transcribe'

/** core.ts 的 ProjectStore 里用到的部分（避免循环依赖）。 */
export interface AnalysisStore {
  project: Project | null
  settings: AppSettings
  save(): Promise<void>
  broadcast(): void
}

const queue: { store: AnalysisStore; project: Project; assetId: string }[] = []
const queued = new Set<string>()
/** 本次运行里已尝试过转写的素材（没有转写器时不反复尝试）。 */
const transcribeTried = new Set<string>()
let running = false
/** 等某个素材的后台分析跑完（reanalyzeAsset 用）。 */
const waiters = new Map<string, (() => void)[]>()

/**
 * 导入/探测后在后台补齐较慢的分析：旧版索引升级、镜头检测、语音转写。
 * 串行执行，每完成一步 save + broadcast。所有失败都静默跳过。
 */
export function queueAssetAnalysis(store: AnalysisStore, assetIds: string[]): void {
  const project = store.project
  if (!project) return
  let marked = false
  for (const assetId of assetIds) {
    if (queued.has(assetId)) continue
    queued.add(assetId)
    queue.push({ store, project, assetId })
    const asset = project.assets.find((a) => a.id === assetId)
    const index = asset?.index
    const stale = index && ((index.version ?? 0) < ANALYSIS_VERSION || (asset.kind === 'video' && !index.scenesDetected))
    if (index && stale && index.analysis !== 'pending') {
      index.analysis = 'pending'
      marked = true
    }
  }
  if (marked) store.broadcast()
  if (!running) void drain()
}

async function drain(): Promise<void> {
  running = true
  try {
    while (queue.length) {
      const job = queue.shift()!
      try {
        await analyzeOne(job.store, job.project, job.assetId)
      } catch {
        /* best-effort */
      } finally {
        queued.delete(job.assetId)
        if (!queue.some((q) => q.assetId === job.assetId)) {
          for (const done of waiters.get(job.assetId) ?? []) done()
          waiters.delete(job.assetId)
        }
      }
    }
  } finally {
    running = false
  }
}

function liveAsset(store: AnalysisStore, project: Project, assetId: string): MediaAsset | null {
  if (store.project !== project) return null
  return project.assets.find((a) => a.id === assetId) ?? null
}

async function commit(store: AnalysisStore): Promise<void> {
  await store.save()
  store.broadcast()
}

async function analyzeOne(store: AnalysisStore, project: Project, assetId: string): Promise<void> {
  let asset = liveAsset(store, project, assetId)
  if (!asset || (asset.kind !== 'video' && asset.kind !== 'audio')) return
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) {
    if (asset.index) asset.index.analysis = 'error'
    return commit(store)
  }

  const needsUpgrade = (asset.index?.version ?? 0) < ANALYSIS_VERSION
  const needsScenes = asset.kind === 'video' && !asset.index?.scenesDetected
  if (needsUpgrade || needsScenes) {
    try {
      if (needsUpgrade) {
        const fresh = await analyzeAudioFile(ffmpeg, asset.path, asset.durationMs)
        asset = liveAsset(store, project, assetId)
        if (!asset) return
        const prev = asset.index
        asset.index = { ...fresh, scenes: prev?.scenes ?? [], analysis: 'pending' }
        if (prev?.scenesDetected) asset.index.scenesDetected = true
        if (prev?.transcription) asset.index.transcription = prev.transcription
        await commit(store)
      }
      if (asset.kind === 'video' && !asset.index?.scenesDetected) {
        const scenes = await detectScenes(ffmpeg, asset.path, asset.durationMs)
        asset = liveAsset(store, project, assetId)
        if (!asset?.index) return
        asset.index.scenes = scenes
        asset.index.scenesDetected = true
      }
      if (asset.index) asset.index.analysis = 'done'
    } catch {
      asset = liveAsset(store, project, assetId)
      if (asset?.index) asset.index.analysis = 'error'
    }
    await commit(store)
    if (!asset?.index) return
  } else if (asset.index && asset.index.analysis !== 'done') {
    asset.index.analysis = 'done'
    await commit(store)
  }

  const index = asset.index
  if (!index) return
  if (project.transcript.some((c) => c.assetId === assetId)) {
    const mine = project.transcript.filter((c) => c.assetId === assetId)
    let changed = index.transcription !== 'done'
    if (mine.some((c) => (c.alignVersion ?? 0) < TRANSCRIPT_ALIGN_VERSION)) {
      // 对齐算法升级：用现有能量索引重新对齐（不重跑 whisper）
      const cues = refineWordTimings(filterHallucinations(mine, index.speech), index.speech, index.pauses)
      project.transcript = [...project.transcript.filter((c) => c.assetId !== assetId), ...cues]
      changed = true
    }
    if (changed) {
      index.transcription = project.transcript.some((c) => c.assetId === assetId) ? 'done' : 'no_speech'
      await commit(store)
    }
    return
  }
  if (transcribeTried.has(assetId)) return
  transcribeTried.add(assetId)
  // 发声总时长不足 1 秒（或几乎听不见）时不转写：whisper 会在静音 / 底噪上幻听出句子
  const speechMs = index.speech.reduce((n, r) => n + r.endMs - r.startMs, 0)
  if (!index.speech.length || speechMs < 1000 || (index.speechLevelDb != null && index.speechLevelDb < -50)) {
    index.transcription = 'no_speech'
    return commit(store)
  }
  if (!(await transcriberAvailable(store.settings))) {
    index.transcription = 'unavailable'
    return commit(store)
  }
  index.transcription = 'pending'
  await commit(store)
  const result = await transcribeFile(asset.path, {
    settings: store.settings,
    durationMs: asset.durationMs,
    assetId,
    prompt: transcriptionPrompt(project.vocabulary) || undefined
  })
  const live = liveAsset(store, project, assetId)
  if (!live?.index) return
  if (!result) {
    live.index.transcription = 'error'
  } else {
    // whisper 的词时间常有零长度词、停顿对不上：用能量语音段重新对齐
    const kept = filterHallucinations(result.cues, live.index.speech)
    const cues = refineWordTimings(kept, live.index.speech, live.index.pauses)
    project.transcript = [...project.transcript.filter((c) => c.assetId !== assetId), ...cues]
    live.index.transcription = cues.length ? 'done' : 'no_speech'
  }
  await commit(store)
}

/**
 * 重新分析一条素材：强制重跑能量分析 / 镜头检测，并重新对齐转写；retranscribe=true 时丢掉旧转写重跑 whisper。
 * 返回的 Promise 在这条素材的后台分析完成后 resolve。
 */
export function reanalyzeAsset(store: AnalysisStore, assetId: string, opts: { retranscribe?: boolean } = {}): Promise<{ assetId: string; analysis?: string; transcription?: string; cues: number }> {
  const project = store.project
  const asset = project?.assets.find((a) => a.id === assetId)
  if (!project || !asset) return Promise.reject(new Error(`素材不存在: ${assetId}`))
  if (asset.kind !== 'video' && asset.kind !== 'audio') return Promise.reject(new Error('只有视频和音频素材需要分析'))
  if (asset.index) {
    asset.index.version = 0
    asset.index.scenesDetected = false
    asset.index.analysis = 'pending'
  }
  for (const c of project.transcript) if (c.assetId === assetId) c.alignVersion = 0
  if (opts.retranscribe) {
    project.transcript = project.transcript.filter((c) => c.assetId !== assetId)
    transcribeTried.delete(assetId)
    if (asset.index) asset.index.transcription = 'pending'
  }
  const done = new Promise<void>((resolve) => waiters.set(assetId, [...(waiters.get(assetId) ?? []), resolve]))
  queueAssetAnalysis(store, [assetId])
  return done.then(() => {
    const live = store.project?.assets.find((a) => a.id === assetId)
    return {
      assetId,
      analysis: live?.index?.analysis,
      transcription: live?.index?.transcription,
      cues: (store.project?.transcript ?? []).filter((c) => c.assetId === assetId).length
    }
  })
}
