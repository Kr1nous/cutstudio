import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { store } from './core'
import { applySourceFrame, shouldAdoptSourceFrame } from '../shared/compose'
import { probeMedia, writeThumb } from './render/ffmpeg'
import { analyzeMediaFile } from './render/wave'
import { queueAssetAnalysis } from './analysis/background'

export { exportTimeline, renderTimeline, makeProxy, addRenderJob } from './render/export'
export { renderFrame } from './render/frame'
export { findFfmpeg } from './render/ffmpeg'

export async function probeAssetFile(assetId: string): Promise<ReturnType<typeof store.getState>> {
  const project = store.requireProject()
  const asset = project.assets.find((a) => a.id === assetId)
  if (!asset) throw new Error('找不到素材')
  if (asset.kind === 'image') {
    if (!asset.durationMs) await store.updateAssetMeta(assetId, { durationMs: 5000 })
    return store.getState()
  }
  const probed = await probeMedia(asset.path)
  const meta: {
    durationMs?: number
    width?: number
    height?: number
    fps?: number
    thumbPath?: string
  } = {}
  if (probed.durationMs) meta.durationMs = probed.durationMs
  if (probed.width) meta.width = probed.width
  if (probed.height) meta.height = probed.height
  if (probed.fps) meta.fps = probed.fps
  if (asset.kind === 'video' && !asset.thumbPath && store.projectPath) {
    await mkdir(join(store.projectPath, 'thumbs'), { recursive: true })
    const dest = join(store.projectPath, 'thumbs', `${asset.id}.jpg`)
    const at = Math.min(1, Math.max(0.05, (probed.durationMs || 1000) / 3000))
    if (await writeThumb(asset.path, dest, at)) meta.thumbPath = dest
  }
  const w = meta.width ?? asset.width
  const h = meta.height ?? asset.height
  if (w && h && shouldAdoptSourceFrame(project)) applySourceFrame(project.settings, w, h)
  if (!asset.index && (asset.kind === 'video' || asset.kind === 'audio')) {
    try {
      await store.updateAssetMeta(assetId, {
        ...meta,
        index: await analyzeMediaFile(asset.path, meta.durationMs ?? asset.durationMs, {
          scenes: (meta.durationMs ?? asset.durationMs) <= 120_000
        })
      })
      queueAssetAnalysis(store, [assetId])
      return store.getState()
    } catch {
      /* continue with duration/thumb only */
    }
  }
  if (asset.kind === 'video' || asset.kind === 'audio') queueAssetAnalysis(store, [assetId])
  if (Object.keys(meta).length) await store.updateAssetMeta(assetId, meta)
  else if (w && h) {
    await store.save()
    store.broadcast()
  }
  return store.getState()
}

export async function saveThumbDataUrl(assetId: string, dataUrl: string): Promise<string | null> {
  if (!store.projectPath) return null
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(dataUrl)
  if (!m) return null
  const ext = m[1].includes('png') ? 'png' : 'jpg'
  const dest = join(store.projectPath, 'thumbs', `${assetId}.${ext}`)
  await writeFile(dest, Buffer.from(m[2], 'base64'))
  await store.updateAssetMeta(assetId, { thumbPath: dest })
  return dest
}
