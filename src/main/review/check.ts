import { brollSentenceCrossing, isFullFrameBroll, timelineSentences } from '../../shared/broll'
import { mapWord, textUnits, timelineWords } from '../../shared/transcript'
import { transitionSpec } from '../../shared/transition'
import { fxAt } from '../../shared/anim'
import { axisScale, layerBox } from '../../shared/mask'
import { SIDE_MARGIN, estimateTextWidthPx, maxCharsForStyle, subtitleAvailablePx, subtitleLineWidthPx } from '../../shared/subtitle'
import { clipText, textScale } from '../../shared/text'
import { clipFx, clipKind } from '../../shared/types'
import type { Project, TimelineClip } from '../../shared/types'

export interface ReviewIssue {
  severity: 'error' | 'warn' | 'info'
  code: string
  atMs?: number
  clipId?: string
  message: string
}

export interface ReviewOptions {
  /** 每行最大字数；默认竖屏 16、横屏 22。 */
  maxChars?: number
}

const end = (c: TimelineClip) => c.startMs + c.durationMs
const s = (ms: number) => `${(ms / 1000).toFixed(2)}s`

function maxVolume(clip: TimelineClip): number {
  const keys = clipFx(clip).keys?.volume
  return Math.max(clip.volume, ...(keys ?? []).map((k) => k.value))
}

/** 片段是否在 [a, b) 内有人声（优先转写词，其次 index.speech）。 */
function speechStartsBefore(project: Project, limitMs: number): boolean | null {
  const words = timelineWords(project)
  if (words.length) return words[0]!.startMs < limitMs
  let known = false
  for (const clip of [...project.timeline.storyline, ...project.timeline.audio]) {
    if (clip.startMs >= limitMs || clip.volume <= 0 || clip.role === 'music') continue
    const index = project.assets.find((a) => a.id === clip.assetId)?.index
    if (!index || index.version == null) continue
    known = true
    for (const r of index.speech) {
      const m = mapWord(clip, { startMs: Math.max(r.startMs, clip.inMs), endMs: Math.min(r.endMs, clip.outMs) })
      if (m && m.startMs < limitMs) return true
    }
  }
  return known ? false : null
}

/** 人声估计响度：故事线上有人声的素材片段，素材 LUFS + 片段音量增益，按时长加权（能量平均）。 */
export function dialogLoudness(project: Project): number | null {
  let energy = 0
  let total = 0
  for (const clip of [...project.timeline.storyline, ...project.timeline.audio.filter((c) => c.role === 'dialog')]) {
    if (clip.volume <= 0 || clipKind(clip) !== 'footage') continue
    const index = project.assets.find((a) => a.id === clip.assetId)?.index
    if (index?.lufs == null || !Number.isFinite(index.lufs) || !index.speech?.length) continue
    const lu = index.lufs + 20 * Math.log10(clip.volume)
    energy += clip.durationMs * 10 ** (lu / 10)
    total += clip.durationMs
  }
  return total > 0 ? 10 * Math.log10(energy / total) : null
}

/**
 * 时间线质检：返回问题列表（error 必须修，warn 建议修，info 提示）。纯函数，不改工程。
 */
export function reviewTimeline(project: Project, opts: ReviewOptions = {}): ReviewIssue[] {
  const issues: ReviewIssue[] = []
  const add = (i: ReviewIssue) => issues.push(i)
  const tl = project.timeline
  const { width, height } = project.settings
  const maxChars = opts.maxChars ?? (height > width ? 16 : 22)
  const story = [...tl.storyline].sort((a, b) => a.startMs - b.startMs)
  const storyEnd = story.length ? Math.max(...story.map(end)) : 0

  // —— 故事线 ——
  story.forEach((clip, i) => {
    const fx = clipFx(clip)
    const next = story[i + 1]
    const prev = story[i - 1]
    if (clip.durationMs < 300) {
      add({ severity: 'warn', code: 'fragment', atMs: clip.startMs, clipId: clip.id, message: `片段只有 ${clip.durationMs}ms（< 300ms），像剪漏的碎片` })
    }
    if (prev) {
      const gap = clip.startMs - end(prev)
      if (gap > 1) {
        add({ severity: 'error', code: 'storyline_gap', atMs: end(prev), clipId: clip.id, message: `故事线在 ${s(end(prev))} 有 ${Math.round(gap)}ms 空洞（黑场）` })
      }
    }
    const tr = fx.transitionOut
    const spec = transitionSpec(tr.type)
    if (tr.type === 'none' || tr.durationMs <= 0) return
    if (!next) {
      if (spec.overlap) {
        add({ severity: 'warn', code: 'transition_on_last', atMs: end(clip), clipId: clip.id, message: `最后一段设置了 ${tr.type} 出点转场，但后面没有片段；结尾请用 fade_black 或去掉` })
      }
      return
    }
    if (next.assetId === clip.assetId && clipKind(clip) === 'footage' && spec.overlap) {
      add({ severity: 'warn', code: 'dissolve_on_jump_cut', atMs: end(clip) - tr.durationMs, clipId: clip.id, message: `同一素材的跳剪用了 ${tr.type}，会糊画面、叠人声；跳剪请硬切或用 punch_in` })
    }
    const shorter = Math.min(clip.durationMs, next.durationMs)
    if (spec.overlap && tr.durationMs > shorter * 0.4) {
      add({ severity: 'warn', code: 'transition_too_long', atMs: end(clip), clipId: clip.id, message: `转场 ${tr.durationMs}ms 超过相邻片段（${shorter}ms）的 40%` })
    }
  })

  // —— 字幕 ——
  const subs = [...tl.subtitles].sort((a, b) => a.startMs - b.startMs)
  subs.forEach((cue, i) => {
    const prev = subs[i - 1]
    if (prev && cue.startMs < prev.endMs - 1) {
      add({ severity: 'error', code: 'subtitle_overlap', atMs: cue.startMs, message: `字幕重叠：“${prev.text.slice(0, 12)}”与“${cue.text.slice(0, 12)}”` })
    }
    const units = Math.max(...cue.text.split('\n').map((l) => textUnits(l)), 0)
    const totalUnits = textUnits(cue.text.replace(/\n/g, ''))
    if (totalUnits > maxChars * 2 || units > maxChars * 1.25) {
      add({ severity: 'warn', code: 'subtitle_too_long', atMs: cue.startMs, message: `字幕过长（${Math.round(totalUnits)} 字，每行建议 ≤ ${maxChars}）：“${cue.text.slice(0, 20)}”` })
    }
    const widest = Math.max(0, ...cue.text.split('\n').map((l) => subtitleLineWidthPx(l, project.subtitleStyle, width, height)))
    const avail = subtitleAvailablePx(project.subtitleStyle, width, height)
    if (widest > avail) {
      const fontSize = project.subtitleStyle.fontSize || 42
      const fit = Math.floor(fontSize * (avail / widest))
      add({
        severity: 'warn',
        code: 'subtitle_overflow',
        atMs: cue.startMs,
        message: `字幕“${cue.text.slice(0, 16)}”在 ${width}px 宽画面上超宽（约 ${Math.round(widest)}px，可用 ${Math.round(avail)}px），导出会被折成多行；建议 fontSize ≤ ${fit}，或按当前字号 captions_from_transcript maxChars ${maxCharsForStyle(project.subtitleStyle, width, height)}`
      })
    }
    if (cue.endMs - cue.startMs < 500) {
      add({ severity: 'warn', code: 'subtitle_too_short', atMs: cue.startMs, message: `字幕只显示 ${cue.endMs - cue.startMs}ms，来不及读` })
    }
    if (cue.startMs >= Math.max(storyEnd, 1)) {
      add({ severity: 'warn', code: 'subtitle_after_end', atMs: cue.startMs, message: '字幕在画面结束之后' })
    }
  })

  // 字幕与文字层抢同一块区域
  const pos = project.subtitleStyle?.position ?? 'bottom'
  const zone = (y: number) => (y >= 0.7 ? 'bottom' : y <= 0.3 ? 'top' : y > 0.4 && y < 0.6 ? 'center' : 'other')
  for (const layer of tl.overlays) {
    if (clipKind(layer) !== 'text') continue
    if (zone(clipFx(layer).posY) !== pos) continue
    const hit = subs.find((c) => c.startMs < end(layer) && c.endMs > layer.startMs)
    if (hit) {
      add({ severity: 'warn', code: 'text_covers_subtitle', atMs: Math.max(hit.startMs, layer.startMs), clipId: layer.id, message: `文字层“${(layer.text?.text ?? '').slice(0, 12)}”与字幕同在${pos === 'bottom' ? '底部' : pos === 'top' ? '顶部' : '中间'}，会互相遮挡` })
    }
  }

  // —— 文字层超出画面 ——
  for (const layer of tl.overlays) {
    if (clipKind(layer) !== 'text' || !layer.text?.text) continue
    const t = clipText(layer)
    const fx = clipFx(layer)
    const fontPx = (t.fontSize || 72) * textScale(width, height) * (fx.scale || 1)
    const widest = Math.max(0, ...t.text.split('\n').map((l) => estimateTextWidthPx(l, fontPx)))
    const x = fx.posX * width
    const lo = width * SIDE_MARGIN
    const hi = width * (1 - SIDE_MARGIN)
    const room = t.align === 'left' ? hi - x : t.align === 'right' ? x - lo : 2 * Math.min(x - lo, hi - x)
    if (widest > room) {
      const fit = Math.max(8, Math.floor((t.fontSize || 72) * (Math.max(0, room) / widest)))
      add({
        severity: 'warn',
        code: 'text_overflow',
        atMs: layer.startMs,
        clipId: layer.id,
        message: `文字层“${t.text.slice(0, 12)}”超出画面（约 ${Math.round(widest)}px，可用 ${Math.round(Math.max(0, room))}px）；建议 fontSize ≤ ${fit}，或缩短文字 / 调整 x 位置`
      })
    }
  }

  // —— 开头 ——
  if (story.length) {
    const early = speechStartsBefore(project, 3000)
    if (early === false) {
      add({ severity: 'info', code: 'slow_open', atMs: 0, message: '前 3 秒没有人声，开头可能缺少钩子' })
    }
  }

  // —— 音频 ——
  const music = tl.audio.filter((c) => c.role !== 'dialog')
  const speechLu = dialogLoudness(project)
  const musicLu = (m: TimelineClip): number | null => {
    const lufs = project.assets.find((a) => a.id === m.assetId)?.index?.lufs
    return lufs != null && Number.isFinite(lufs) && maxVolume(m) > 0 ? lufs + 20 * Math.log10(maxVolume(m)) : null
  }
  for (const m of music) {
    // 有响度数据时按「比人声低多少 LU」判断（set_music 会按素材响度把 volume 调到 1 以上）；没有时退回音量阈值
    const est = musicLu(m)
    if (speechLu != null && est != null) {
      if (speechLu - est < 6) {
        add({
          severity: 'warn',
          code: 'music_too_loud',
          atMs: m.startMs,
          clipId: m.id,
          message: `音乐估计响度 ${est.toFixed(1)} LUFS，${speechLu - est > 0 ? `只比人声（约 ${speechLu.toFixed(1)} LUFS）低 ${(speechLu - est).toFixed(0)} LU` : `比人声（约 ${speechLu.toFixed(1)} LUFS）还响 ${(est - speechLu).toFixed(0)} LU`}，会盖过人声；背景音乐一般比人声低 10–18 LU，调小 volume 或重新 set_music（不传 volume 自动定）`
        })
      }
    } else if (maxVolume(m) > 0.35) {
      add({ severity: 'warn', code: 'music_too_loud', atMs: m.startMs, clipId: m.id, message: `音乐音量 ${maxVolume(m).toFixed(2)}（建议 ≤ 0.35），可能盖过人声` })
    }
    if (end(m) > storyEnd + 50 && storyEnd > 0) {
      add({ severity: 'info', code: 'audio_past_end', atMs: storyEnd, clipId: m.id, message: `音乐比画面长 ${Math.round(end(m) - storyEnd)}ms，结尾建议裁齐并淡出` })
    }
  }
  if (speechLu != null) {
    for (const m of music) {
      const lufs = project.assets.find((a) => a.id === m.assetId)?.index?.lufs
      const est = musicLu(m)
      if (lufs == null || est == null) continue
      if (speechLu - est > 20) {
        add({
          severity: 'warn',
          code: 'music_inaudible',
          atMs: m.startMs,
          clipId: m.id,
          message: `音乐估计响度 ${est.toFixed(1)} LUFS，比人声（约 ${speechLu.toFixed(1)} LUFS）低 ${(speechLu - est).toFixed(0)} LU，基本听不见（素材本身 ${lufs.toFixed(1)} LUFS × 音量 ${maxVolume(m).toFixed(2)}）；背景音乐一般比人声低 10–18 LU，调大音量或重新 set_music`
        })
      }
    }
  }
  if (music.length && !tl.duck?.enabled) {
    add({ severity: 'warn', code: 'duck_off', message: '有背景音乐但没有开启闪避（duck），说话时音乐不会自动压低' })
  }
  for (const clip of [...tl.storyline, ...tl.audio]) {
    if (clip.volume <= 0) continue
    const tp = project.assets.find((a) => a.id === clip.assetId)?.index?.truePeak
    if (tp == null) continue
    const peak = tp + 20 * Math.log10(Math.max(1e-4, maxVolume(clip)))
    // 导出母线有 -1 dBTP 限幅器（graph.ts）：超出 4 dB 以内由它压住，再高才会听出明显压缩。
    if (peak > 3) {
      add({ severity: 'warn', code: 'clipping_risk', atMs: clip.startMs, clipId: clip.id, message: `预估峰值 ${peak.toFixed(1)} dBTP，超出限幅器余量，会有明显压缩感；降低音量或重新 normalize_loudness` })
    }
  }

  // —— 叠加层 ——
  for (const o of tl.overlays) {
    if (storyEnd > 0 && end(o) > storyEnd + 1) {
      add({ severity: 'warn', code: 'overlay_past_end', atMs: storyEnd, clipId: o.id, message: `叠加层超出画面结尾 ${Math.round(end(o) - storyEnd)}ms` })
    }
  }

  // —— B-roll：互相重叠、和台词错位 ——
  const broll = tl.overlays.filter(isFullFrameBroll).sort((a, b) => a.startMs - b.startMs)
  const nameOf = (c: TimelineClip) => project.assets.find((a) => a.id === c.assetId)?.name ?? c.id
  broll.forEach((a, i) => {
    for (const b of broll.slice(i + 1)) {
      const overlap = Math.min(end(a), end(b)) - Math.max(a.startMs, b.startMs)
      if (overlap <= 40) continue
      add({
        severity: 'warn',
        code: 'broll_overlap',
        atMs: Math.max(a.startMs, b.startMs),
        clipId: b.id,
        message: `B-roll ${nameOf(a)}（${s(a.startMs)}–${s(end(a))}）和 ${nameOf(b)}（${s(b.startMs)}–${s(end(b))}）重叠 ${Math.round(overlap)}ms，上层会盖住下层；用 adjust_broll 让它们首尾相接`
      })
    }
  })
  if (broll.length && project.transcript.length) {
    const sentences = timelineSentences(project)
    for (const o of broll) {
      const x = brollSentenceCrossing(sentences, o.startMs, end(o))
      if (!x) continue
      const cut = x.edge === 'end' ? `结尾 ${s(end(o))} 落在「${x.midSentence.text.slice(0, 14)}」中间` : `从「${x.midSentence.text.slice(0, 14)}」中间（${s(o.startMs)}）开始`
      const fix =
        x.edge === 'end'
          ? `只盖前一句用 adjust_broll endMs ${Math.round(x.next.startMs)}，要盖到这句结束用 endMs ${Math.round(x.next.endMs)}`
          : `adjust_broll startMs ${Math.round(x.midSentence.startMs)} 从句首开始`
      add({
        severity: 'warn',
        code: 'broll_crosses_sentence',
        atMs: x.edge === 'end' ? end(o) : o.startMs,
        clipId: o.id,
        message: `B-roll ${nameOf(o)} ${cut}，还盖住了「${x.next.text.slice(0, 14)}」的开头：画面切换和说话对不上；${fix}`
      })
    }
  }

  // —— 黑边：素材片段在任意时刻没铺满画布 ——
  for (const clip of [...story, ...tl.overlays]) {
    if (clipKind(clip) !== 'footage') continue
    const isOverlay = !tl.storyline.includes(clip)
    const fx0 = clipFx(clip)
    // 刻意缩小的画中画 / 带蒙版的叠加层不算
    if (isOverlay) {
      const ax = axisScale(fx0)
      if (Math.min(ax.x, ax.y) < 1 || fx0.masks.length) continue
    }
    const at = letterboxAt(project, clip)
    if (at != null) {
      add({
        severity: 'warn',
        code: 'letterbox',
        atMs: at,
        clipId: clip.id,
        message: `片段在 ${s(at)} 没有铺满 ${width}×${height} 画布，会露出黑边（竖屏请用 reframe；放大请在铺满缩放的基础上乘倍率）`
      })
    }
  }

  const rank = { error: 0, warn: 1, info: 2 }
  return issues.sort((a, b) => rank[a.severity] - rank[b.severity] || (a.atMs ?? 0) - (b.atMs ?? 0))
}

/** 片段第一次露出黑边的时间线毫秒；始终铺满返回 null。采样片段首尾和各关键帧时刻（缩放 / 位置动画）。 */
function letterboxAt(project: Project, clip: TimelineClip): number | null {
  const asset = project.assets.find((a) => a.id === clip.assetId)
  if (!asset?.width || !asset.height || (asset.kind !== 'video' && asset.kind !== 'image')) return null
  const W = project.settings.width
  const H = project.settings.height
  const fx0 = clipFx(clip)
  let srcW = asset.width * (fx0.crop?.w ?? 1)
  let srcH = asset.height * (fx0.crop?.h ?? 1)
  if (fx0.rotate === 90 || fx0.rotate === 270) [srcW, srcH] = [srcH, srcW]
  const d = Math.max(1, clip.durationMs)
  const ts = new Set<number>([0, 1])
  for (const track of [fx0.keys?.scale, fx0.keys?.posX, fx0.keys?.posY]) for (const k of track ?? []) ts.add(Math.min(1, Math.max(0, k.t)))
  for (const t01 of [...ts].sort((a, b) => a - b)) {
    const at = clip.startMs + Math.min(d - 1, t01 * d)
    const fa = fxAt(clip, at)
    // 与导出一致：有缩放关键帧时，动画 scale 同时作用于两个轴（覆盖静态 scaleX/scaleY）
    const box = layerBox(fx0.keys?.scale?.length ? { ...fa, scaleX: fa.scale, scaleY: fa.scale } : fa, W, H, srcW, srcH)
    const tol = 1
    if (box.x > tol || box.y > tol || box.x + box.w < W - tol || box.y + box.h < H - tol) return Math.round(at)
  }
  return null
}
