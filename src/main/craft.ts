/**
 * 剪辑手法类工具：跳剪放大、B-roll 盖跳剪、J/L cut。
 * 和 actions.ts 一样，人点按钮与 AI 调用走同一套实现。
 */
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { upsertKey } from '../shared/anim'
import { beatsOnTimeline, planBeatSnap } from '../shared/beatsnap'
import { sliceAllKeys, sliceProject } from '../shared/cliptime'
import { id as makeId } from '../shared/ids'
import { type KenBurnsFrame, planKenBurns } from '../shared/kenburns'
import { type RampPoint, type RampSegment, planSpeedRamp } from '../shared/ramp'
import { VOICE_FILTERS, VOICE_PRESETS, type VoicePreset, missingVoiceFilters } from '../shared/voice'
import {
  BROLL_SNAP_MS,
  findTextHit,
  overlappingBroll,
  snapBrollStart,
  spillsIntoNext,
  timelineSentences,
  type TextHit
} from '../shared/broll'
import { type ActionResult, type EaseKind, type Project, type ReviewAction, type TimelineClip, type TimelineOp, clipFx, clipKind, timelineDurationMs } from '../shared/types'
import type { ToolSpec } from './ai/providers'
import { clipChoices, clipIdArg, num, result, withWarnings } from './actions'
import { store } from './core'
import { ffmpegHasFilter, findFfmpeg } from './render/ffmpeg'

export const CRAFT_TOOLS: ToolSpec[] = [
  {
    name: 'punch_in',
    description:
      '跳剪处做「机位变化」：给片段放大构图，掩盖同一机位跳剪的画面跳动（口播标准手法）。不传 clipIds 时自动找出故事线上所有同素材连续跳剪，隔一段放大一段。scale 是在片段当前缩放上再乘的倍率 1.08–1.2（默认 1.12），reframe 竖屏铺满之后再用也不会露黑边；x/y 为放大后的画面中心 0–1（人物偏一侧时调整）；mode=cut 静态放大，ease=片段内缓慢推近到 scale。',
    parameters: {
      type: 'object',
      properties: {
        clipIds: { type: 'array', items: { type: 'string' } },
        scale: { type: 'number' },
        x: { type: 'number' },
        y: { type: 'number' },
        mode: { type: 'string', enum: ['cut', 'ease'] }
      }
    }
  },
  {
    name: 'insert_broll',
    description:
      '在讲解画面上盖一段 B-roll（铺满画面，保留下层人声），用于配合台词内容或盖住跳剪。位置用 atText（台词里的一段文字，需要转写）或 atMs（时间线毫秒）。atText 默认 align=sentence：从命中那句在时间线上的开头盖到句尾（不传 durationMs 时正好盖满这句）；align=clause 只盖命中文字所在的逗号分句（一句话里讲了好几件事、只想配其中一段时用）；align=word 从命中的词开始。起点前 500ms 内有片段开头 / 时间线开头 / 上一段 B-roll 结尾时自动吸附过去，避免闪一下讲解画面。inMs 为 B-roll 素材的起点。durationMs 建议 2000–5000。audio=mute（默认，B-roll 静音）| mix（B-roll 声音以 volume 混入）。返回 startMs / endMs，atText 时另有 matchedText / sentenceStartMs / sentenceEndMs；盖进下一句、和已有 B-roll 重叠时给 warnings。插入前可用 contact_sheet assetId 先看素材内容；插入后用 adjust_broll 调位置和长度。',
    parameters: {
      type: 'object',
      properties: {
        assetId: { type: 'string' },
        atMs: { type: 'number' },
        atText: { type: 'string' },
        align: { type: 'string', enum: ['sentence', 'clause', 'word'], description: 'atText 的对齐方式：sentence 整句（默认）| clause 命中文字所在的逗号分句（一句话里讲了好几件事时用）| word 从命中的词开始' },
        durationMs: { type: 'number', description: '不传：atText 时盖到句尾，atMs 时 3000' },
        inMs: { type: 'number' },
        audio: { type: 'string', enum: ['mute', 'mix'] },
        volume: { type: 'number' }
      },
      required: ['assetId']
    }
  },
  {
    name: 'adjust_broll',
    description:
      '调整已插入的 B-roll / 叠加素材的位置和长度，全部用时间线毫秒（内部换算成素材源时间）。startMs 移动起点（不传 endMs / durationMs 时长度不变）；endMs 改结尾；durationMs 改长度；inMs 改素材从哪一刻开始播。常用：把 B-roll 收到句尾（endMs = get_transcript 里该句的 endMs）、和前一段 B-roll 首尾相接。返回 startMs / endMs，和其他 B-roll 重叠、盖进下一句时给 warnings。',
    parameters: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        startMs: { type: 'number' },
        endMs: { type: 'number' },
        durationMs: { type: 'number' },
        inMs: { type: 'number' }
      },
      required: ['clipId']
    }
  },
  {
    name: 'audio_lead',
    description:
      'J cut / L cut：让声音和画面错开切换，让对话、场景过渡更自然。clipId 是切点前的片段（切点 = 它和下一片段之间）。type=j：下一段的声音提前 leadMs 进入（画面还在上一段）；type=l：上一段的声音延续 leadMs（画面已切到下一段）。leadMs 300–1000。只用于不同镜头/素材之间，同一机位跳剪不要用。',
    parameters: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        type: { type: 'string', enum: ['j', 'l'] },
        leadMs: { type: 'number' }
      },
      required: ['clipId', 'type']
    }
  },
  {
    name: 'speed_ramp',
    description:
      '片段内变速曲线（快进 / 慢动作过渡，比如 1→2→1）。points 为 [{atMs, rate}]：atMs 是变速前的时间线毫秒（落在该片段内），rate 0.25–4；第一个点之前按第一个 rate，点之间按 ease（默认 ease_in_out）过渡。导出只支持恒定速度，所以实际是把片段切成 ≤ 8 段恒速子片段来近似（每段速度取保持时长不变的平均值），会改变成片时长，后面的叠加层跟着平移、字幕自动重建。声音跟着变速：pitchPreserve 时保持音调（atempo，> 2x 会发虚），否则变调；口播里快进段通常应静音或盖音乐。只作用于故事线片段，不支持倒放 / 冻结帧。',
    parameters: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        points: {
          type: 'array',
          items: { type: 'object', properties: { atMs: { type: 'number' }, rate: { type: 'number' } }, required: ['atMs', 'rate'] }
        },
        ease: { type: 'string', enum: ['linear', 'ease_in', 'ease_out', 'ease_in_out'] }
      },
      required: ['clipId', 'points']
    }
  },
  {
    name: 'ken_burns',
    description:
      '镜头缓推 / 缓拉 / 平移（Ken Burns），用于静态画面、照片、产品特写，让画面有运动感。from / to 为 {scale, x, y}：scale 是在片段当前缩放上再乘的倍率（默认 from 1 → to 1.12 居中缓推；缓拉就 from 1.12 → to 1），x/y 为画面中心 0–1。会自动夹在不露黑边的范围内（竖屏 reframe 铺满后再推也不会露边）。片段已有人物跟随的位置关键帧且没给 x/y 时只做缩放。ease 默认 ease_in_out。会覆盖片段已有的缩放关键帧（punch_in ease）。故事线片段和叠加层（B-roll）都可以。',
    parameters: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        from: { type: 'object', properties: { scale: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } } },
        to: { type: 'object', properties: { scale: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } } },
        ease: { type: 'string', enum: ['linear', 'ease_in', 'ease_out', 'ease_in_out'] }
      },
      required: ['clipId']
    }
  },
  {
    name: 'voice_enhance',
    description:
      '人声增强：高通去低频嗡声 → 轻压缩稳音量 → 去齿音 → 3kHz 临场感 EQ（podcast 另加轻降噪）。preset: podcast（默认，稳、干净）| clear（更亮更清楚）| warm（保留低频，更厚）| off（关闭）。clipId 指定片段，clipIds 批量，clipId:"all" = 故事线全部有声片段 + J/L cut 对白音频。预览听不出，导出生效。背景音乐不要用。底噪明显时先 denoise_audio。',
    parameters: {
      type: 'object',
      properties: {
        clipId: { type: 'string' },
        clipIds: { type: 'array', items: { type: 'string' } },
        preset: { type: 'string', enum: ['podcast', 'clear', 'warm', 'off'] }
      }
    }
  },
  {
    name: 'snap_cuts_to_beats',
    description:
      '把故事线上的切点对齐到背景音乐的节拍（Vlog、混剪、卡点）。每个切点在 toleranceMs（默认 150）内找最近的拍子，用滚动剪辑挪：前一段出点和后一段入点同时挪，成片时长和其他片段位置不变，不增删内容。只在被露出 / 盖掉的那一小段是静音或停顿时才挪（不会切到字），有转场、倒放的切点跳过。需要先 set_music，且音乐已分析出节拍（get_index 的 beats）。musicAssetId 不传时用时间线上的背景音乐。返回挪了哪些切点、各挪多少毫秒，以及没挪的原因。',
    parameters: {
      type: 'object',
      properties: {
        musicAssetId: { type: 'string' },
        toleranceMs: { type: 'number' }
      }
    }
  },
  {
    name: 'render_preview',
    description:
      '把时间线的一小段（最长 20 秒）渲染成低清 mp4（和导出同一套渲染：转场、调色、叠加层、字幕、混音、人声增强都在），返回文件路径，给人或终端里的 AI 看 / 听效果。写到临时目录，不进导出目录、不进渲染队列、不改工程。width 默认 640（最大 1280）。看静态构图用 get_frame 更快。',
    parameters: {
      type: 'object',
      properties: {
        startMs: { type: 'number' },
        endMs: { type: 'number' },
        width: { type: 'number' }
      },
      required: ['startMs', 'endMs']
    }
  }
]

export function isCraftTool(name: string): boolean {
  return CRAFT_TOOLS.some((t) => t.name === name)
}

/** 故事线里同一素材、源时间相接或跳过一小段的连续片段 = 跳剪。 */
export function jumpCutRuns(storyline: TimelineClip[], maxGapMs = 8000): TimelineClip[][] {
  const runs: TimelineClip[][] = []
  let cur: TimelineClip[] = []
  for (const c of storyline) {
    const prev = cur.at(-1)
    if (prev && prev.assetId === c.assetId && c.inMs >= prev.outMs - 50 && c.inMs - prev.outMs <= maxGapMs) {
      cur.push(c)
    } else {
      if (cur.length > 1) runs.push(cur)
      cur = [c]
    }
  }
  if (cur.length > 1) runs.push(cur)
  return runs
}

export async function runCraft(name: string, args: Record<string, unknown>, source: ReviewAction['source']): Promise<ActionResult> {
  const p = store.requireProject()
  switch (name) {
    case 'punch_in': {
      const scale = Math.min(1.35, Math.max(1.02, num(args.scale, 1.12)))
      const mode = args.mode === 'ease' ? 'ease' : 'cut'
      const warnings: string[] = []
      let targets: TimelineClip[]
      if (Array.isArray(args.clipIds) && args.clipIds.length) {
        targets = args.clipIds.map((id) => {
          const c = p.timeline.storyline.find((x) => x.id === String(id))
          if (!c) throw new Error(`故事线上没有片段 ${id}。${clipChoices(p)}`)
          return c
        })
      } else {
        const runs = jumpCutRuns(p.timeline.storyline)
        targets = runs.flatMap((run) => run.filter((_, i) => i % 2 === 1))
        if (!targets.length) throw new Error('故事线上没有同一素材的连续跳剪；需要放大的片段请用 clipIds 指定。')
      }
      if (scale > 1.2) warnings.push('放大超过 1.2 倍，低分辨率素材会发糊，用 get_frame 检查。')
      const ops: TimelineOp[] = targets.map((c) => {
        const fx = clipFx(c)
        // 倍率乘在当前缩放上：竖屏 reframe 后 scale≈3.16，直接写 1.12 会缩回去露大黑边。
        const base = fx.scale || 1
        const target = Math.round(base * scale * 1000) / 1000
        const posX = args.x != null ? Math.min(1, Math.max(0, num(args.x, 0.5))) : fx.posX
        const posY = args.y != null ? Math.min(1, Math.max(0, num(args.y, 0.5))) : fx.posY
        if (mode === 'ease') {
          const keys = upsertKey(upsertKey(undefined, 0, base, 'ease_in_out', base), 1, target, 'linear', base)
          return { op: 'patch_clip', clipId: c.id, fx: { posX, posY, keys: { ...fx.keys, scale: keys } } }
        }
        return { op: 'patch_clip', clipId: c.id, fx: { scale: target, scaleX: target, scaleY: target, posX, posY } }
      })
      await store.applyOps(ops, source, `跳剪放大 ${scale}x（${targets.length} 段）`)
      return withWarnings(result(name, `${targets.length} 个片段在原缩放上放大 ${scale}x（${mode}）`, targets.map((c) => c.id)), warnings)
    }

    case 'insert_broll': {
      const assetId = String(args.assetId ?? '')
      const asset = p.assets.find((a) => a.id === assetId)
      if (!asset) throw new Error(`素材不存在: ${assetId}`)
      if (asset.kind === 'audio') throw new Error('B-roll 需要视频或图片素材')
      const warnings: string[] = []
      const align = args.align === 'word' ? 'word' : args.align === 'clause' ? 'clause' : 'sentence'
      let hit: TextHit | null = null
      let atMs: number
      if (typeof args.atText === 'string' && args.atText.trim()) {
        hit = findTextHit(p, args.atText.trim())
        if (!hit) throw new Error(`时间线上找不到台词「${args.atText}」（可能没有转写，或这句已被剪掉）。get_transcript 看现有台词，或改用 atMs。`)
        atMs = align === 'sentence' ? hit.sentenceStartMs : align === 'clause' ? hit.clauseStartMs : hit.wordStartMs
      } else if (args.atMs != null) {
        atMs = Math.max(0, num(args.atMs, 0))
      } else {
        throw new Error('需要 atMs 或 atText')
      }
      const total = timelineDurationMs(p.timeline)
      if (atMs >= total - 100) throw new Error(`起点 ${Math.round(atMs)}ms 已在成片结尾（${total}ms）`)
      const requestedStart = atMs
      atMs = snapBrollStart(p.timeline, atMs)
      const snapNote = atMs !== requestedStart ? `；起点从 ${Math.round(requestedStart)}ms 吸附到 ${Math.round(atMs)}ms，避免闪 ${Math.round(requestedStart - atMs)}ms 讲解画面` : ''
      const inMs = Math.max(0, num(args.inMs, 0))
      // 不传时长：atText 盖到句尾（从吸附后的起点算），atMs 默认 3 秒
      const hitEnd = hit ? (align === 'clause' ? hit.clauseEndMs : hit.sentenceEndMs) : 0
      let durationMs = args.durationMs != null ? Math.max(500, num(args.durationMs, 3000)) : hit ? Math.max(500, hitEnd - atMs) : 3000
      if (asset.kind === 'video' && asset.durationMs) {
        const avail = asset.durationMs - inMs
        if (avail <= 0) throw new Error(`inMs ${inMs} 超出素材长度 ${asset.durationMs}ms`)
        if (avail < durationMs) {
          durationMs = Math.max(500, avail)
          warnings.push(`B-roll 素材从 ${inMs}ms 起只剩 ${avail}ms，时长已缩短到 ${Math.round(durationMs)}ms。`)
        }
      }
      if (atMs + durationMs > total) {
        durationMs = Math.max(500, total - atMs)
        warnings.push('B-roll 超出成片结尾，已截短。')
      }
      // 结尾离成片结尾不到 500ms：直接盖到结尾，免得最后闪回讲解画面
      if (total - (atMs + durationMs) > 0 && total - (atMs + durationMs) < BROLL_SNAP_MS && args.durationMs == null) durationMs = total - atMs
      const endMs = atMs + durationMs
      warnings.push(...brollWarnings(p, atMs, endMs, undefined, hit?.sentenceId))
      const mix = args.audio === 'mix' && asset.kind === 'video'
      const ops: TimelineOp[] = [
        {
          op: 'add_layer',
          assetId,
          startMs: atMs,
          kind: 'footage',
          ...(asset.kind === 'video' ? { inMs, outMs: inMs + durationMs } : { durationMs })
        }
      ]
      if (mix) {
        ops.push({
          op: 'add_audio',
          assetId,
          startMs: atMs,
          inMs,
          outMs: inMs + durationMs,
          volume: Math.min(1, Math.max(0, num(args.volume, 0.3)))
        })
      }
      await store.applyOps(ops, source, `B-roll ${asset.name} @${Math.round(atMs)}ms`)
      const layer = p.timeline.overlays.at(-1)
      const where = hit ? `「${hit.matchedText}」那句（${align === 'sentence' ? '整句' : align === 'clause' ? '所在分句' : '从命中的词起'}）` : ''
      const out: ActionResult & BrollPlacement = {
        ...withWarnings(
          result(name, `已在 ${Math.round(atMs)}–${Math.round(endMs)}ms 盖 ${asset.name}（${Math.round(durationMs)}ms）${where}${snapNote}`, layer ? [layer.id] : []),
          warnings
        ),
        clipId: layer?.id,
        startMs: Math.round(atMs),
        endMs: Math.round(endMs),
        ...(hit
          ? { matchedText: hit.matchedText, sentenceText: hit.sentenceText, sentenceStartMs: Math.round(hit.sentenceStartMs), sentenceEndMs: Math.round(hit.sentenceEndMs), clauseStartMs: Math.round(hit.clauseStartMs), clauseEndMs: Math.round(hit.clauseEndMs) }
          : {})
      }
      return out
    }

    case 'adjust_broll': {
      const clipId = String(args.clipId ?? '')
      const clip = p.timeline.overlays.find((c) => c.id === clipId)
      if (!clip) {
        const story = p.timeline.storyline.some((c) => c.id === clipId)
        const choices = p.timeline.overlays
          .filter((c) => clipKind(c) === 'footage')
          .map((c) => `${c.id}(${p.assets.find((a) => a.id === c.assetId)?.name ?? '?'} ${Math.round(c.startMs)}–${Math.round(c.startMs + c.durationMs)}ms)`)
        throw new Error(
          `${story ? `${clipId} 是故事线片段，不是 B-roll。` : `叠加层不存在: ${clipId}。`}${choices.length ? `可选 B-roll：${choices.join('、')}` : '时间线上还没有 B-roll。'}`
        )
      }
      if (clipKind(clip) !== 'footage') throw new Error(`${clipId} 是${clipKind(clip)}层，adjust_broll 只调整素材叠加层；文字层用 set_text / apply_ops move_clip。`)
      const asset = p.assets.find((a) => a.id === clip.assetId)
      const fx = clipFx(clip)
      const speed = Math.max(0.25, fx.speed || 1)
      const oldStart = clip.startMs
      const oldEnd = clip.startMs + clip.durationMs
      const warnings: string[] = []
      const total = timelineDurationMs(p.timeline)
      let startMs = args.startMs != null ? Math.max(0, num(args.startMs, oldStart)) : oldStart
      let endMs: number
      if (args.endMs != null) endMs = num(args.endMs, oldEnd)
      else if (args.durationMs != null) endMs = startMs + Math.max(1, num(args.durationMs, clip.durationMs))
      else endMs = startMs + clip.durationMs
      if (args.endMs != null && args.durationMs != null) warnings.push('同时给了 endMs 和 durationMs，按 endMs。')
      if (endMs > total) {
        endMs = total
        warnings.push(`结尾超出成片（${total}ms），已截到成片结尾。`)
      }
      if (endMs - startMs < 300) throw new Error(`调整后只剩 ${Math.round(endMs - startMs)}ms（< 300ms），要删掉这段请用 remove_clip。`)
      const inMs = args.inMs != null ? Math.max(0, num(args.inMs, clip.inMs)) : clip.inMs
      let outMs = inMs + (endMs - startMs) * speed
      if (asset?.kind === 'video' && asset.durationMs && outMs > asset.durationMs) {
        outMs = asset.durationMs
        const fitEnd = startMs + (outMs - inMs) / speed
        if (fitEnd - startMs < 300) throw new Error(`素材 ${asset.name} 从 ${inMs}ms 起只剩 ${asset.durationMs - inMs}ms`)
        warnings.push(`素材 ${asset.name} 从 ${Math.round(inMs)}ms 起只剩 ${Math.round(asset.durationMs - inMs)}ms，结尾缩到 ${Math.round(fitEnd)}ms。`)
        endMs = fitEnd
      }
      startMs = Math.round(startMs)
      endMs = Math.round(endMs)
      warnings.push(...brollWarnings(p, startMs, endMs, clip.id))
      const ops: TimelineOp[] = []
      if (startMs !== oldStart) ops.push({ op: 'move_clip', clipId: clip.id, startMs })
      if (Math.round(inMs) !== Math.round(clip.inMs) || Math.round(outMs) !== Math.round(clip.outMs)) {
        ops.push({ op: 'trim_clip', clipId: clip.id, inMs: Math.round(inMs), outMs: Math.round(outMs) })
      }
      const name2 = asset?.name ?? clip.id
      if (!ops.length) {
        const same: ActionResult & BrollPlacement = { ...withWarnings(result(name, `${name2} 没有变化（${oldStart}–${Math.round(oldEnd)}ms）`), warnings), clipId: clip.id, startMs: oldStart, endMs: Math.round(oldEnd) }
        return same
      }
      await store.applyOps(ops, source, `调整 B-roll ${name2}`)
      const out: ActionResult & BrollPlacement = {
        ...withWarnings(
          result(name, `${name2}：${Math.round(oldStart)}–${Math.round(oldEnd)}ms → ${startMs}–${endMs}ms（素材 ${Math.round(inMs)}–${Math.round(outMs)}ms）`, [clip.id]),
          warnings
        ),
        clipId: clip.id,
        startMs,
        endMs
      }
      return out
    }

    case 'speed_ramp': {
      const clipId = clipIdArg(p, args, source)
      const idx = p.timeline.storyline.findIndex((c) => c.id === clipId)
      if (idx < 0) throw new Error(`speed_ramp 只作用于故事线片段。${clipChoices(p)}`)
      const clip = p.timeline.storyline[idx]!
      const points = parseJsonArg(args.points) as RampPoint[] | undefined
      if (!Array.isArray(points) || !points.length) throw new Error('points 需要 [{atMs, rate}]，例如 [{"atMs":1000,"rate":1},{"atMs":2000,"rate":2},{"atMs":3000,"rate":1}]')
      for (const pt of points) {
        if (!Number.isFinite(Number(pt?.atMs)) || !Number.isFinite(Number(pt?.rate)) || Number(pt.rate) <= 0) throw new Error(`point 不合法：${JSON.stringify(pt)}（需要 atMs 毫秒、rate > 0）`)
      }
      const plan = planSpeedRamp(clip, points.map((pt) => ({ atMs: Number(pt.atMs), rate: Number(pt.rate) })), { ease: easeArg(args.ease) })
      const fx = clipFx(clip)
      const span = Math.max(1, clip.outMs - clip.inMs)
      const segs: TimelineClip[] = plan.segments.map((seg, i) => {
        const first = i === 0
        const last = i === plan.segments.length - 1
        return {
          ...clip,
          id: first ? clip.id : makeId('clip'),
          inMs: seg.inMs,
          outMs: seg.outMs,
          durationMs: seg.durationMs,
          fx: {
            ...clip.fx,
            speed: seg.rate,
            fadeInMs: first ? fx.fadeInMs : 0,
            fadeOutMs: last ? fx.fadeOutMs : 0,
            transitionOut: last ? fx.transitionOut : { type: 'none', durationMs: 0 },
            keys: sliceAllKeys(clip.fx?.keys, (seg.inMs - clip.inMs) / span, (seg.outMs - clip.inMs) / span)
          }
        }
      })
      const oldEnd = clip.startMs + clip.durationMs
      const delta = plan.durationMs - clip.durationMs
      const story = [...p.timeline.storyline.slice(0, idx), ...segs, ...p.timeline.storyline.slice(idx + 1)]
      const ops: TimelineOp[] = [{ op: 'replace_storyline', clips: story }]
      const moved = p.timeline.overlays.filter((o) => o.startMs >= oldEnd - 1)
      for (const o of moved) ops.push({ op: 'move_clip', clipId: o.id, startMs: Math.max(0, o.startMs + delta) })
      const warnings = [
        `导出只支持恒定速度：已切成 ${segs.length} 段恒速子片段近似变速曲线（${plan.segments.map((sg) => `${sg.rate}x`).join(' → ')}）。`,
        fx.pitchPreserve
          ? '声音会跟着变速（保持音调，> 2x 会发虚）；快进段一般应静音（set_volume 0）或只留音乐。'
          : '声音会跟着变速并变调（pitchPreserve 关闭）；快进段一般应静音或只留音乐。',
        ...plan.warnings
      ]
      if (Math.abs(delta) > 50 && p.timeline.audio.some((a) => a.role === 'music')) warnings.push(`成片时长变了 ${Math.round(delta)}ms，背景音乐没有跟着裁：重新 set_music 让它对齐结尾。`)
      if (Math.abs(delta) > 50 && p.timeline.audio.some((a) => a.role === 'dialog' && a.startMs >= oldEnd - 1)) warnings.push('后面的 J/L cut 对白音频没有跟着平移，请检查。')
      if (moved.length && Math.abs(delta) > 1) warnings.push(`片段后面的 ${moved.length} 个叠加层已平移 ${Math.round(delta)}ms。`)
      await store.batch(`变速曲线 ${clip.id}`, async () => {
        await store.applyOps(ops, source, `变速曲线 ${clip.id}（${segs.length} 段）`)
        const { rebuildCaptionsIfAny } = await import('./textedit')
        warnings.push(...(await rebuildCaptionsIfAny(source)))
      })
      const out: ActionResult & { segments: RampSegment[] } = {
        ...withWarnings(
          result(name, `${clip.id} 变速：${Math.round(clip.durationMs)}ms → ${Math.round(plan.durationMs)}ms，${segs.length} 段`, segs.map((c) => c.id)),
          warnings
        ),
        segments: plan.segments.map((sg) => ({ ...sg, durationMs: Math.round(sg.durationMs) }))
      }
      return out
    }

    case 'ken_burns': {
      const clipId = clipIdArg(p, args, source)
      const clip = p.timeline.storyline.find((c) => c.id === clipId) ?? p.timeline.overlays.find((c) => c.id === clipId)
      if (!clip) throw new Error(`片段不存在: ${clipId}。${clipChoices(p)}`)
      if (clipKind(clip) !== 'footage') throw new Error(`${clipId} 不是素材片段（${clipKind(clip)}），ken_burns 只用于画面素材。`)
      const asset = p.assets.find((a) => a.id === clip.assetId)
      if (!asset || (asset.kind !== 'video' && asset.kind !== 'image') || !asset.width || !asset.height) throw new Error('片段素材没有画面尺寸')
      const fx = clipFx(clip)
      let srcW = asset.width * (fx.crop?.w ?? 1)
      let srcH = asset.height * (fx.crop?.h ?? 1)
      if (fx.rotate === 90 || fx.rotate === 270) [srcW, srcH] = [srcH, srcW]
      const from = frameArg(parseJsonArg(args.from))
      const to = frameArg(parseJsonArg(args.to))
      const hasPosKeys = Boolean(fx.keys?.posX?.length || fx.keys?.posY?.length)
      const keepPos = hasPosKeys && from.x == null && from.y == null && to.x == null && to.y == null
      const plan = planKenBurns(fx, p.settings.width, p.settings.height, srcW, srcH, from, to, { ease: easeArg(args.ease), keepPos })
      const warnings = [...plan.warnings]
      if (fx.keys?.scale?.length) warnings.push('片段原有的缩放关键帧（punch_in ease 等）已被替换。')
      if (clip.durationMs < 1500) warnings.push(`片段只有 ${clip.durationMs}ms，缓推太短会像跳一下；ken_burns 适合 ≥ 2 秒的镜头。`)
      const keys = { ...fx.keys, scale: plan.keys.scale, ...(plan.keys.posX ? { posX: plan.keys.posX, posY: plan.keys.posY } : {}) }
      await store.applyOps([{ op: 'patch_clip', clipId: clip.id, fx: { keys } }], source, `Ken Burns ${clip.id}`)
      const kind = plan.to.scale > plan.from.scale + 0.001 ? '缓推' : plan.to.scale < plan.from.scale - 0.001 ? '缓拉' : '平移'
      return withWarnings(
        result(name, `${clip.id} ${kind}：缩放 ${plan.from.scale} → ${plan.to.scale}，中心 (${plan.from.x}, ${plan.from.y}) → (${plan.to.x}, ${plan.to.y})${keepPos ? '（保留人物跟随位置）' : ''}`, [clip.id]),
        warnings
      )
    }

    case 'voice_enhance': {
      const preset = args.preset == null ? 'podcast' : String(args.preset)
      if (preset !== 'off' && !(VOICE_PRESETS as string[]).includes(preset)) throw new Error(`preset 只能是 ${VOICE_PRESETS.join(' / ')} / off`)
      const all = [...p.timeline.storyline, ...p.timeline.audio]
      let targets: TimelineClip[]
      if (args.clipId === 'all' || (Array.isArray(args.clipIds) && args.clipIds.includes('all'))) {
        targets = [
          ...p.timeline.storyline.filter((c) => clipKind(c) === 'footage' && c.volume > 0 && p.assets.some((a) => a.id === c.assetId && (a.kind === 'video' || a.kind === 'audio'))),
          ...p.timeline.audio.filter((c) => c.role === 'dialog')
        ]
      } else if (Array.isArray(args.clipIds) && args.clipIds.length) {
        targets = args.clipIds.map((cid) => {
          const c = all.find((x) => x.id === String(cid))
          if (!c) throw new Error(`片段不存在: ${cid}。${clipChoices(p)}`)
          return c
        })
      } else {
        const cid = clipIdArg(p, args, source)
        const c = all.find((x) => x.id === cid)
        if (!c) throw new Error(`voice_enhance 只作用于故事线片段或音频轨对白。${clipChoices(p)}`)
        targets = [c]
      }
      if (!targets.length) throw new Error('没有可以增强的人声片段')
      const warnings: string[] = []
      const music = targets.filter((c) => c.role === 'music')
      if (music.length) warnings.push(`${music.map((c) => c.id).join('、')} 是背景音乐，人声增强会让音乐发薄，已跳过。`)
      targets = targets.filter((c) => c.role !== 'music')
      if (!targets.length) throw new Error('只选中了背景音乐，没有人声片段')
      const voice = preset === 'off' ? null : { preset: preset as VoicePreset }
      if (voice) {
        warnings.push('预览听不出人声增强，导出时生效（可用 render_preview 渲染一小段听效果）。')
        const ffmpeg = await findFfmpeg()
        if (ffmpeg) {
          const have = new Set<string>()
          for (const f of VOICE_FILTERS) if (await ffmpegHasFilter(ffmpeg, f)) have.add(f)
          const missing = missingVoiceFilters(voice.preset, (f) => have.has(f))
          if (missing.length) warnings.push(`本机 ffmpeg 没有 ${missing.join(' / ')}，导出时会跳过这些步骤。`)
        } else warnings.push('本机没有 ffmpeg，导出不可用。')
      }
      await store.applyOps(targets.map((c) => ({ op: 'patch_clip', clipId: c.id, fx: { voice } })), source, voice ? `人声增强 ${preset}` : '关闭人声增强')
      return withWarnings(result(name, voice ? `${targets.length} 个片段开启人声增强（${preset}）` : `${targets.length} 个片段关闭人声增强`, targets.map((c) => c.id)), warnings)
    }

    case 'snap_cuts_to_beats': {
      const musicClips = p.timeline.audio.filter((c) => c.role !== 'dialog')
      const want = typeof args.musicAssetId === 'string' && args.musicAssetId ? args.musicAssetId : null
      const mclip = want ? musicClips.find((c) => c.assetId === want) : musicClips.find((c) => c.role === 'music') ?? musicClips[0]
      if (!mclip) {
        throw new Error(want ? `时间线上没有用素材 ${want} 的音乐片段，先 set_music。` : '时间线上没有背景音乐：先 set_music，再对齐节拍。')
      }
      const masset = p.assets.find((a) => a.id === mclip.assetId)
      const beats = masset?.index?.beats ?? []
      if (!beats.length) {
        const why = masset?.index?.analysis === 'pending' ? '素材还在分析' : '分析没找到清晰的节拍（音乐节奏不明显，或分析版本过旧）'
        throw new Error(`音乐 ${masset?.name ?? mclip.assetId} 没有节拍数据：${why}。可以 reanalyze_asset 后再试。`)
      }
      const tol = Math.min(500, Math.max(20, num(args.toleranceMs, 150)))
      const onTl = beatsOnTimeline(mclip, beats)
      const plan = planBeatSnap(p, onTl, tol)
      const cuts = plan.moves.length + plan.skipped.length + plan.onBeat
      const detail = { moves: plan.moves, skipped: plan.skipped, onBeat: plan.onBeat, bpm: masset?.index?.bpm }
      if (!plan.moves.length) {
        const why = [...new Set(plan.skipped.map((x) => x.reason))].join('；')
        const out: ActionResult & typeof detail = { ...result(name, `没有挪动切点（${cuts} 个切点，${plan.onBeat} 个已在拍上${why ? `；其余：${why}` : ''}）`), ...detail }
        return out
      }
      await store.applyOps([{ op: 'replace_storyline', clips: plan.storyline }], source, `切点对齐节拍（${plan.moves.length} 处）`)
      const warnings: string[] = []
      if (plan.skipped.length) warnings.push(`${plan.skipped.length} 个切点没挪：${plan.skipped.slice(0, 5).map((x) => `${x.atMs}ms ${x.reason}`).join('；')}${plan.skipped.length > 5 ? ' …' : ''}`)
      const out: ActionResult & typeof detail = {
        ...withWarnings(
          result(
            name,
            `${plan.moves.length}/${cuts} 个切点对齐到节拍：${plan.moves.slice(0, 6).map((m) => `${m.atMs}→${m.toMs}ms(${m.deltaMs > 0 ? '+' : ''}${m.deltaMs})`).join('，')}${plan.moves.length > 6 ? ' …' : ''}`,
            plan.moves.flatMap((m) => [m.prevClipId, m.nextClipId])
          ),
          warnings
        ),
        ...detail
      }
      return out
    }

    case 'render_preview': {
      const total = timelineDurationMs(p.timeline)
      if (total <= 0) throw new Error('时间线是空的')
      const warnings: string[] = []
      let a = Math.max(0, Math.round(num(args.startMs, 0)))
      let b = Math.round(num(args.endMs, a + 5000))
      if (a >= total) throw new Error(`startMs ${a} 超出成片长度 ${total}ms`)
      if (b > total) b = total
      if (b - a < 200) throw new Error('预览区间太短（< 200ms）')
      if (b - a > PREVIEW_MAX_MS) {
        b = a + PREVIEW_MAX_MS
        warnings.push(`预览最长 ${PREVIEW_MAX_MS / 1000} 秒，已截到 ${a}–${b}ms。`)
      }
      const width = Math.min(1280, Math.max(160, Math.round(num(args.width, 640))))
      const W = p.settings.width || 1920
      const H = p.settings.height || 1080
      const size = { width: evenInt(width), height: evenInt((width * H) / W) }
      const dir = join(tmpdir(), 'cutstudio-preview', `preview-${Date.now()}`)
      await mkdir(dir, { recursive: true })
      const file = join(dir, `preview-${a}-${b}.mp4`)
      const exp = await import('./render/export')
      await exp.renderTimeline(sliceProject(p, a, b), file, '1080p', { size, encode: PREVIEW_ENCODE })
      warnings.push(...exp.lastRenderWarnings)
      const out: ActionResult & { file: string; startMs: number; endMs: number; width: number; height: number } = {
        ...withWarnings(result(name, `已渲染 ${a}–${b}ms（${((b - a) / 1000).toFixed(1)}s，${size.width}×${size.height}）：${file}`), warnings),
        file,
        startMs: a,
        endMs: b,
        ...size
      }
      return out
    }

    case 'audio_lead': {
      const clipId = clipIdArg(p, args, source)
      const story = p.timeline.storyline
      const i = story.findIndex((c) => c.id === clipId)
      if (i < 0) throw new Error(`audio_lead 只作用于故事线片段。${clipChoices(p)}`)
      const a = story[i]
      const b = story[i + 1]
      if (!b) throw new Error('这是最后一个片段，后面没有切点')
      const type = args.type === 'l' ? 'l' : 'j'
      const leadMs = Math.min(3000, Math.max(100, num(args.leadMs, 600)))
      const warnings: string[] = []
      if (a.assetId === b.assetId && Math.abs(b.inMs - a.outMs) < 8000) {
        warnings.push('这是同一素材的跳剪，J/L cut 会让同一个人的两句话重叠，通常应改用 punch_in。')
      }
      if (clipFx(a).speed !== 1 || clipFx(b).speed !== 1 || clipFx(a).reverse || clipFx(b).reverse) {
        warnings.push('变速/倒放片段的 J/L cut 按原速计算，声音可能对不上。')
      }
      const fadeMs = 40
      const ops: TimelineOp[] = []
      if (type === 'j') {
        const srcIn = b.inMs - leadMs
        if (srcIn < 0) throw new Error(`下一段素材在入点前只有 ${b.inMs}ms，不够提前 ${leadMs}ms`)
        ops.push({ op: 'add_audio', assetId: b.assetId, startMs: b.startMs - leadMs, inMs: srcIn, outMs: b.inMs, volume: b.volume, role: 'dialog' })
        ops.push({ op: 'patch_clip', clipId: a.id, fx: { keys: { ...clipFx(a).keys, volume: fadeTail(a, leadMs, fadeMs) } } })
      } else {
        const asset = p.assets.find((x) => x.id === a.assetId)
        const srcOut = a.outMs + leadMs
        if (asset?.durationMs && srcOut > asset.durationMs) {
          throw new Error(`上一段素材在出点后只有 ${asset.durationMs - a.outMs}ms，不够延续 ${leadMs}ms`)
        }
        ops.push({ op: 'add_audio', assetId: a.assetId, startMs: a.startMs + a.durationMs, inMs: a.outMs, outMs: srcOut, volume: a.volume, role: 'dialog' })
        ops.push({ op: 'patch_clip', clipId: b.id, fx: { keys: { ...clipFx(b).keys, volume: fadeHead(b, leadMs, fadeMs) } } })
      }
      await store.applyOps(ops, source, `${type.toUpperCase()} cut ${leadMs}ms`)
      return withWarnings(result(name, `${type.toUpperCase()} cut：${a.id}→${b.id} 声音错开 ${leadMs}ms`, [a.id, b.id]), warnings)
    }
  }
  throw new Error(`未知工具: ${name}`)
}

/** 片段最后 leadMs 静音（前面 fadeMs 淡出）。 */
function fadeTail(clip: TimelineClip, leadMs: number, fadeMs: number) {
  const d = Math.max(1, clip.durationMs)
  const v = clip.volume
  const t1 = Math.max(0, 1 - leadMs / d)
  const t0 = Math.max(0, t1 - fadeMs / d)
  let keys = upsertKey(undefined, 0, v, 'linear', v)
  keys = upsertKey(keys, t0, v, 'linear', v)
  keys = upsertKey(keys, t1, 0, 'linear', v)
  return upsertKey(keys, 1, 0, 'linear', v)
}

/** 片段开头 leadMs 静音，之后 fadeMs 淡入。 */
function fadeHead(clip: TimelineClip, leadMs: number, fadeMs: number) {
  const d = Math.max(1, clip.durationMs)
  const v = clip.volume
  const t0 = Math.min(1, leadMs / d)
  const t1 = Math.min(1, t0 + fadeMs / d)
  let keys = upsertKey(undefined, 0, 0, 'linear', v)
  keys = upsertKey(keys, t0, 0, 'linear', v)
  keys = upsertKey(keys, t1, v, 'linear', v)
  return upsertKey(keys, 1, v, 'linear', v)
}

type BrollPlacement = {
  clipId?: string
  startMs: number
  endMs: number
  matchedText?: string
  sentenceText?: string
  sentenceStartMs?: number
  sentenceEndMs?: number
}

/** B-roll 落到 [startMs, endMs) 后的提醒：和其他 B-roll 重叠、盖进下一句 / 从句子中间切走。 */
function brollWarnings(p: Project, startMs: number, endMs: number, excludeId?: string, sentenceId?: string): string[] {
  const warnings: string[] = []
  const name = (c: TimelineClip) => p.assets.find((a) => a.id === c.assetId)?.name ?? c.id
  for (const o of overlappingBroll(p.timeline.overlays, startMs, endMs, excludeId)) {
    const a = Math.max(startMs, o.startMs)
    const b = Math.min(endMs, o.startMs + o.durationMs)
    warnings.push(
      `和已有 B-roll ${o.id}（${name(o)} ${Math.round(o.startMs)}–${Math.round(o.startMs + o.durationMs)}ms）重叠 ${Math.round(b - a)}ms（${Math.round(a)}–${Math.round(b)}ms），上层会盖住下层；用 adjust_broll 让两段首尾相接。`
    )
  }
  const sentences = timelineSentences(p)
  const own = sentenceId ?? sentences.find((s) => startMs >= s.startMs - BROLL_SNAP_MS && startMs < s.endMs)?.id
  const next = own ? spillsIntoNext(sentences, own, endMs) : null
  if (next) {
    const prevEnd = sentences[sentences.indexOf(next) - 1]?.endMs
    warnings.push(
      `B-roll 结尾 ${Math.round(endMs)}ms 盖进了下一句「${next.text.slice(0, 16)}」（${Math.round(next.startMs)}ms 开始）${endMs < next.endMs ? '，画面会在这句中间切回' : ''}；要只盖本句，adjust_broll endMs ${Math.round(prevEnd ?? next.startMs)}。`
    )
  }
  return warnings
}

/** 预览最长时长和编码参数（低清、快） */
const PREVIEW_MAX_MS = 20_000
const PREVIEW_ENCODE = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '28', '-pix_fmt', 'yuv420p', '-movflags', '+faststart']

function evenInt(n: number): number {
  const r = Math.max(2, Math.round(n))
  return r % 2 ? r + 1 : r
}

/** CLI 传进来的数组 / 对象参数可能是 JSON 字符串。 */
function parseJsonArg(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    throw new Error(`参数不是合法 JSON：${v.slice(0, 80)}`)
  }
}

function easeArg(v: unknown): EaseKind | undefined {
  return v === 'linear' || v === 'ease_in' || v === 'ease_out' || v === 'ease_in_out' ? v : undefined
}

function frameArg(v: unknown): KenBurnsFrame {
  if (!v || typeof v !== 'object') return {}
  const o = v as Record<string, unknown>
  const pick = (k: string) => (o[k] != null && Number.isFinite(Number(o[k])) ? Number(o[k]) : undefined)
  return { scale: pick('scale'), x: pick('x'), y: pick('y') }
}
