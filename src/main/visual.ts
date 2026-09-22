/**
 * 画面类工具：跟随主体的画幅重构、按素材实测自动调色、多机位色调匹配。
 * 分析在 analysis/subject.ts、analysis/look.ts，纯逻辑在 shared/reframe.ts、shared/look.ts。
 */
import { timelineTimeMs } from '../shared/compose'
import { enhanceFromLook, matchLook, type ColorAdjust } from '../shared/look'
import { isFullFrameBroll } from '../shared/broll'
import { reframeTrack, type ReframeKey } from '../shared/reframe'
import type { ActionResult, AnimKey, AspectPreset, MediaAsset, ReviewAction, TimelineClip, TimelineOp } from '../shared/types'
import type { ToolSpec } from './ai/providers'
import { clipChoices, num, result, runAction, withWarnings } from './actions'
import { measureLook, type LookStats } from './analysis/look'
import { detectSubjects } from './analysis/subject'
import { store } from './core'

export const VISUAL_TOOLS: ToolSpec[] = [
  {
    name: 'reframe',
    description:
      '改画幅并让画面跟随人物（macOS Vision 人脸/人体检测）：横屏素材转 9:16 竖屏时自动铺满画布、把人放在画面里，人移动时平滑跟随，镜头切点处直接跳。aspect 默认 9:16；zoom ≥1 在铺满基础上再放大；clipIds 只处理部分片段（默认故事线全部）。检测不到人时居中铺满并给出警告。之后用 get_frame 抽查。',
    parameters: {
      type: 'object',
      properties: {
        aspect: { type: 'string', enum: ['9:16', '1:1', '16:9'] },
        zoom: { type: 'number' },
        clipIds: { type: 'array', items: { type: 'string' } }
      }
    }
  },
  {
    name: 'auto_enhance',
    description:
      '按素材实测的亮度分布、饱和度、冷暖自动校正（过暗提亮、发灰加对比、偏色回正），正常素材几乎不改。clipId / clipIds 指定片段（故事线片段或叠加层 id 都行），默认故事线全部 + 铺满画面的 B-roll 叠加层。会覆盖这些片段已有的 color_adjust 数值。',
    parameters: {
      type: 'object',
      properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } } }
    }
  },
  {
    name: 'color_match',
    description:
      '多机位 / 多段素材统一色调：以 refClipId 的画面为基准，把其他片段的亮度、对比、饱和、冷暖往它靠。产品特写 / B-roll 和讲解机位色调不一致时，refClipId 传讲解片段即可。clipIds 可以是故事线片段 id，也可以是叠加层（B-roll）id；不传时默认 = 故事线上与参考片段不同素材的片段 + 所有铺满画面的 B-roll 叠加层（参考素材自己的片段除外）。',
    parameters: {
      type: 'object',
      properties: { refClipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } } },
      required: ['refClipId']
    }
  }
]

export function isVisualTool(name: string): boolean {
  return VISUAL_TOOLS.some((t) => t.name === name)
}

const DST_ASPECT: Record<string, number> = { '9:16': 9 / 16, '1:1': 1, '16:9': 16 / 9 }

/** 默认目标：故事线素材片段；withBroll 时再加上铺满画面的 B-roll 叠加层。 */
function pickClips(args: Record<string, unknown>, withBroll = false): TimelineClip[] {
  const p = store.requireProject()
  const story = p.timeline.storyline
  const ids = Array.isArray(args.clipIds) && args.clipIds.length
    ? args.clipIds.map(String)
    : typeof args.clipId === 'string' && args.clipId && args.clipId !== 'all'
      ? [args.clipId]
      : null
  if (!ids) return [...story.filter((c) => (c.kind ?? 'footage') === 'footage'), ...(withBroll ? p.timeline.overlays.filter(isFullFrameBroll) : [])]
  return ids.map((id) => {
    const c = story.find((x) => x.id === id) ?? p.timeline.overlays.find((x) => x.id === id)
    if (!c) throw new Error(`片段不存在: ${id}。${clipChoices(p)}`)
    return c
  })
}

function assetOf(clip: TimelineClip): MediaAsset | undefined {
  return store.requireProject().assets.find((a) => a.id === clip.assetId)
}

/** 片段源区间内均匀取 n 个时间点。 */
function sampleTimes(clip: TimelineClip, n = 5): number[] {
  const span = Math.max(1, clip.outMs - clip.inMs)
  return Array.from({ length: n }, (_, i) => Math.round(clip.inMs + (span * (i + 0.5)) / n))
}

/** 源时间关键帧 → 片段内 0–1 关键帧（缓入缓出）。 */
function toClipKeys(clip: TimelineClip, keys: ReframeKey[], prop: 'posX' | 'posY'): AnimKey[] {
  const out: AnimKey[] = []
  for (const k of keys) {
    const tl = timelineTimeMs(clip, k.t)
    const t = clip.durationMs > 0 ? (tl - clip.startMs) / clip.durationMs : 0
    if (t < -0.001 || t > 1.001) continue
    out.push({ t: Math.min(1, Math.max(0, t)), value: Math.round(k[prop] * 10000) / 10000, ease: 'ease_in_out' })
  }
  return out
}

/** 取某片段可见范围的取景：落在片段前面的最后一个关键帧作为起点。 */
function keysForClip(clip: TimelineClip, track: ReframeKey[]): ReframeKey[] {
  const inside = track.filter((k) => k.t >= clip.inMs && k.t <= clip.outMs)
  const before = [...track].reverse().find((k) => k.t < clip.inMs)
  const after = track.find((k) => k.t > clip.outMs)
  return [...(before ? [{ ...before, t: clip.inMs }] : []), ...inside, ...(after && inside.length ? [{ ...after, t: clip.outMs }] : [])]
}

export async function runVisual(name: string, args: Record<string, unknown>, source: ReviewAction['source']): Promise<ActionResult> {
  const p = store.requireProject()
  switch (name) {
    case 'reframe': {
      const aspect = (['9:16', '1:1', '16:9'].includes(String(args.aspect)) ? String(args.aspect) : '9:16') as AspectPreset
      const zoom = Math.min(2, Math.max(1, num(args.zoom, 1)))
      const clips = pickClips(args)
      if (!clips.length) throw new Error('故事线上没有视频片段')
      const warnings: string[] = []
      const ops: TimelineOp[] = []
      const tracks = new Map<string, ReframeKey[]>()
      let followed = 0
      for (const clip of clips) {
        const asset = assetOf(clip)
        if (!asset || (asset.kind !== 'video' && asset.kind !== 'image')) continue
        if (!asset.width || !asset.height) {
          warnings.push(`${asset.name} 没有尺寸信息，跳过。`)
          continue
        }
        let track = tracks.get(asset.id)
        if (!track) {
          const samples = asset.kind === 'video' ? await detectSubjects(asset.path, { intervalMs: 500 }) : null
          if (samples == null) warnings.push(`${asset.name} 无法做人物检测（Vision 工具不可用），已居中铺满。`)
          else if (!samples.length) warnings.push(`${asset.name} 没检测到人物，已居中铺满。`)
          track = reframeTrack(samples ?? [], asset.width, asset.height, DST_ASPECT[aspect]!, { zoom, cuts: asset.index?.scenes })
          tracks.set(asset.id, track)
        }
        const keys = keysForClip(clip, track)
        const first = keys[0] ?? track[0]!
        const scale = first.scale
        const moving = keys.length > 1 && keys.some((k) => Math.abs(k.posX - first.posX) > 0.002 || Math.abs(k.posY - first.posY) > 0.002)
        const fxKeys = { ...clip.fx?.keys }
        delete fxKeys.scale
        if (moving) {
          fxKeys.posX = toClipKeys(clip, keys, 'posX')
          fxKeys.posY = toClipKeys(clip, keys, 'posY')
          followed++
        } else {
          delete fxKeys.posX
          delete fxKeys.posY
        }
        ops.push({
          op: 'patch_clip',
          clipId: clip.id,
          fx: { crop: null, scale, scaleX: scale, scaleY: scale, posX: first.posX, posY: first.posY, keys: fxKeys }
        })
      }
      if (!ops.length) throw new Error('没有可以重构画幅的片段')
      await store.batch(`画幅 ${aspect} 跟随主体`, async () => {
        if (p.settings.aspect !== aspect) await runAction('set_aspect', { aspect }, source)
        await store.applyOps(ops, source, `画幅 ${aspect} 跟随主体`)
      })
      return withWarnings(
        result(name, `画幅 ${aspect}：${ops.length} 个片段铺满画布，其中 ${followed} 个跟随人物移动`, ops.map((o) => (o as { clipId: string }).clipId)),
        [...new Set(warnings)]
      )
    }

    case 'auto_enhance': {
      const clips = pickClips(args, true)
      if (!clips.length) throw new Error('时间线是空的')
      const ops: TimelineOp[] = []
      const warnings: string[] = []
      const changed: string[] = []
      for (const clip of clips) {
        const asset = assetOf(clip)
        if (!asset || (asset.kind !== 'video' && asset.kind !== 'image')) continue
        const look = await measureLook(asset.path, asset.kind === 'image' ? [0] : sampleTimes(clip))
        if (!look) {
          warnings.push(`${asset.name} 取帧失败，未调色。`)
          continue
        }
        const color = enhanceFromLook(look)
        if (isZero(color)) continue
        ops.push({ op: 'patch_clip', clipId: clip.id, fx: { color } })
        changed.push(`${clip.id}(${describe(color)})`)
      }
      if (!ops.length) return withWarnings(result(name, `${clips.length} 个片段画面正常，无需调整`), warnings)
      await store.applyOps(ops, source, '按实测自动调色')
      return withWarnings(result(name, enhanceSummary(clips.length, changed), ops.map((o) => (o as { clipId: string }).clipId)), warnings)
    }

    case 'color_match': {
      const refId = String(args.refClipId ?? '')
      const ref = p.timeline.storyline.find((c) => c.id === refId) ?? p.timeline.overlays.find((c) => c.id === refId)
      if (!ref) throw new Error(`参考片段不存在: ${refId}。${clipChoices(p)}`)
      const refAsset = assetOf(ref)
      if (!refAsset) throw new Error('参考片段没有素材')
      const refLook = await measureLook(refAsset.path, refAsset.kind === 'image' ? [0] : sampleTimes(ref))
      if (!refLook) throw new Error('参考片段取帧失败')
      const targets = Array.isArray(args.clipIds) && args.clipIds.length
        ? pickClips({ clipIds: args.clipIds })
        : pickClips({}, true).filter((c) => c.assetId !== ref.assetId)
      if (!targets.length) throw new Error('没有需要匹配的片段（故事线和 B-roll 都是参考素材）')
      const byAsset = new Map<string, LookStats | null>()
      const ops: TimelineOp[] = []
      const warnings: string[] = []
      for (const clip of targets) {
        if (clip.id === ref.id) continue
        const asset = assetOf(clip)
        if (!asset) continue
        const key = `${asset.id}:${clip.inMs}:${clip.outMs}`
        if (!byAsset.has(key)) byAsset.set(key, await measureLook(asset.path, asset.kind === 'image' ? [0] : sampleTimes(clip)))
        const look = byAsset.get(key)
        if (!look) {
          warnings.push(`${asset.name} 取帧失败，未匹配。`)
          continue
        }
        const refColor = ref.fx?.color
        const color = matchLook(refLook, look)
        // 参考片段自己也调过色时，目标在匹配结果上叠加同样的调整
        const merged: ColorAdjust = refColor
          ? {
              exposure: clamp(color.exposure + (refColor.exposure ?? 0)),
              contrast: clamp(color.contrast + (refColor.contrast ?? 0)),
              saturation: clamp(color.saturation + (refColor.saturation ?? 0)),
              warmth: clamp(color.warmth + (refColor.warmth ?? 0))
            }
          : color
        ops.push({ op: 'patch_clip', clipId: clip.id, fx: { color: merged } })
      }
      if (!ops.length) return withWarnings(result(name, '没有可匹配的片段'), warnings)
      await store.applyOps(ops, source, `色调匹配 ${ref.id}`)
      return withWarnings(result(name, `${ops.length} 个片段已向 ${ref.id} 的色调靠拢`, ops.map((o) => (o as { clipId: string }).clipId)), warnings)
    }
  }
  throw new Error(`未知工具: ${name}`)
}

/** 「检查 N 个，校正 M 个：前 6 个明细 等 K 个」——计数和明细对得上。 */
export function enhanceSummary(checked: number, changed: string[], show = 6): string {
  const more = changed.length > show ? ` 等，另有 ${changed.length - show} 个` : ''
  const unchanged = checked - changed.length
  return `检查 ${checked} 个片段，校正 ${changed.length} 个：${changed.slice(0, show).join('；')}${more}${unchanged > 0 ? `（${unchanged} 个无需调整）` : ''}`
}

function clamp(n: number): number {
  return Math.round(Math.min(0.5, Math.max(-0.5, n)) * 100) / 100
}

function isZero(c: ColorAdjust): boolean {
  return Math.abs(c.exposure) < 0.01 && Math.abs(c.contrast) < 0.01 && Math.abs(c.saturation) < 0.01 && Math.abs(c.warmth) < 0.01
}

function describe(c: ColorAdjust): string {
  const label: Record<keyof ColorAdjust, string> = { exposure: '曝光', contrast: '对比', saturation: '饱和', warmth: '冷暖' }
  return (Object.keys(label) as (keyof ColorAdjust)[])
    .filter((k) => Math.abs(c[k]) >= 0.01)
    .map((k) => `${label[k]}${c[k] > 0 ? '+' : ''}${c[k]}`)
    .join(' ')
}
