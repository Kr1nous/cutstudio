/**
 * 包装类工具：片头 / 章节卡 / 片尾模板，和章节标记。
 * 模板由文字层 + 形状层组成（和 animate_text 同一套图层），导出和预览都支持。
 */
import { findTextHit } from '../shared/broll'
import { estimateTextWidthPx, SIDE_MARGIN } from '../shared/subtitle'
import { textScale } from '../shared/text'
import { id } from '../shared/ids'
import type { ActionResult, AnimKey, Project, ReviewAction, TimelineOp } from '../shared/types'
import { timelineDurationMs } from '../shared/types'
import type { ToolSpec } from './ai/providers'
import { num, result, withWarnings } from './actions'
import { store } from './core'

type CardKind = 'intro' | 'chapter' | 'end'
type CardStyle = 'minimal' | 'bold' | 'box'

export const TITLE_TOOLS: ToolSpec[] = [
  {
    name: 'title_card',
    description:
      '套用设计好的标题模板（比 animate_text 更完整）：kind=intro 片头大标题 + 副标题（默认 0ms 起 2.5 秒）| chapter 章节卡「编号 + 标题」（用 atText 定位到这一章的第一句，或 atMs；默认 2 秒，同时记一个章节标记）| end 片尾卡（默认最后 3 秒，压暗画面，title 默认「谢谢观看」，subtitle 可写「关注我 · 下期见」）。style: minimal 纯文字（默认）| bold 大字 + 强调色下划线 | box 半透明底条。标题 ≤ 14 字，太长会自动缩小字号；位置自动避开字幕。',
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['intro', 'chapter', 'end'] },
        title: { type: 'string' },
        subtitle: { type: 'string' },
        atMs: { type: 'number' },
        atText: { type: 'string' },
        durationMs: { type: 'number' },
        style: { type: 'string', enum: ['minimal', 'bold', 'box'] },
        accent: { type: 'string', description: '强调色 #rrggbb，默认 #FFD400' },
        number: { type: 'number', description: '章节编号，默认按已有章节自动递增' }
      },
      required: ['kind']
    }
  },
  {
    name: 'set_chapters',
    description:
      '标出整条片子的章节（替换已有章节标记）。每章给 title 和位置（atText 用这一章第一句里的几个字定位，或 atMs 时间线毫秒）。返回可直接贴到视频简介的章节列表（00:00 标题）。cards=true 时同时给每章加章节卡（title_card chapter）。先剪完再标章节：之后再删内容，章节时间会过期，需要重新 set_chapters。',
    parameters: {
      type: 'object',
      properties: {
        chapters: {
          type: 'array',
          items: { type: 'object', properties: { title: { type: 'string' }, atText: { type: 'string' }, atMs: { type: 'number' } }, required: ['title'] }
        },
        cards: { type: 'boolean' },
        style: { type: 'string', enum: ['minimal', 'bold', 'box'] }
      },
      required: ['chapters']
    }
  }
]

export function isTitleTool(name: string): boolean {
  return TITLE_TOOLS.some((t) => t.name === name)
}

/** 淡入 → 停留 → 淡出（按片段时长的比例），峰值 peak。 */
function fadeInOut(durationMs: number, peak = 1): AnimKey[] {
  const f = Math.min(0.25, 350 / Math.max(1, durationMs))
  return [
    { t: 0, value: 0, ease: 'ease_out' },
    { t: f, value: peak, ease: 'linear' },
    { t: 1 - f, value: peak, ease: 'ease_in' },
    { t: 1, value: 0, ease: 'linear' }
  ]
}

/** 字号放不下时自动缩小：按估算宽度，左右各留 SIDE_MARGIN。 */
function fitFont(p: Project, text: string, fontSize: number): number {
  const { width, height } = p.settings
  const px = fontSize * textScale(width, height)
  const w = estimateTextWidthPx(text, px)
  const avail = width * (1 - 2 * SIDE_MARGIN)
  return w > avail ? Math.max(24, Math.floor(fontSize * (avail / w))) : fontSize
}

function fmtTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

function resolveAt(p: Project, args: Record<string, unknown>): number | null {
  if (typeof args.atText === 'string' && args.atText.trim()) {
    const hit = findTextHit(p, args.atText.trim())
    if (!hit) throw new Error(`时间线上找不到台词「${args.atText}」（可能已被剪掉）。get_transcript 看现有台词，或改用 atMs。`)
    return hit.sentenceStartMs
  }
  return args.atMs != null ? Math.max(0, num(args.atMs, 0)) : null
}

/** 生成一张标题卡的图层。 */
function cardOps(
  p: Project,
  kind: CardKind,
  opts: { title: string; subtitle?: string; startMs: number; durationMs: number; style: CardStyle; accent: string; number?: number }
): { ops: TimelineOp[]; notes: string[] } {
  const { startMs, durationMs, style, accent } = opts
  const notes: string[] = []
  const subCenter = p.subtitleStyle.position === 'center' && p.timeline.subtitles.length > 0
  // 字幕在中间时标题整体上移；字幕在底部时标题在中间偏上
  const baseY = kind === 'end' ? 0.45 : subCenter ? 0.24 : 0.4
  const bold = style === 'bold'
  const sizes = { intro: bold ? 128 : 110, chapter: bold ? 96 : 84, end: bold ? 110 : 96 }
  const ops: TimelineOp[] = []
  const layer = (o: Omit<Extract<TimelineOp, { op: 'add_layer' }>, 'op' | 'startMs' | 'durationMs'>) =>
    ops.push({ op: 'add_layer', startMs, durationMs, ...o } as TimelineOp)

  if (kind === 'end') {
    // 压暗画面，让片尾文字清楚
    layer({ kind: 'shape', shape: { shape: 'rect', fill: '#000000', width: 1, height: 1 }, fx: { posX: 0.5, posY: 0.5, keys: { opacity: fadeInOut(durationMs, 0.55) } } })
  }
  const titleText = opts.title
  const titleSize = fitFont(p, titleText, sizes[kind])
  if (titleSize < sizes[kind]) notes.push(`标题较长，字号从 ${sizes[kind]} 缩到 ${titleSize}`)
  const titleY = baseY + (kind === 'chapter' && opts.number != null ? 0.035 : 0)
  if (style === 'box') {
    const h = opts.subtitle ? 0.26 : 0.17
    layer({ kind: 'shape', shape: { shape: 'rect', fill: '#000000', width: 1, height: h }, fx: { posX: 0.5, posY: titleY + (opts.subtitle ? 0.04 : 0), keys: { opacity: fadeInOut(durationMs, 0.55) } } })
  }
  if (kind === 'chapter' && opts.number != null) {
    layer({
      kind: 'text',
      textAnim: 'fade',
      text: { text: String(opts.number).padStart(2, '0'), font: 'PingFang SC', fontSize: 52, color: accent, stroke: '#000000', strokeWidth: 2, align: 'center' },
      fx: { posX: 0.5, posY: titleY - 0.075, keys: { opacity: fadeInOut(durationMs) } }
    })
  }
  layer({
    kind: 'text',
    textAnim: 'fade',
    text: { text: titleText, font: 'PingFang SC', fontSize: titleSize, color: '#ffffff', stroke: '#000000', strokeWidth: style === 'box' ? 0 : 3, align: 'center' },
    fx: { posX: 0.5, posY: titleY, keys: { opacity: fadeInOut(durationMs) } }
  })
  if (bold) {
    const { width, height } = p.settings
    const barW = Math.min(0.8, (estimateTextWidthPx(titleText, titleSize * textScale(width, height)) / width) * 0.6)
    layer({ kind: 'shape', shape: { shape: 'rect', fill: accent, width: Math.max(0.12, barW), height: 0.008 }, fx: { posX: 0.5, posY: titleY + 0.078, keys: { opacity: fadeInOut(durationMs) } } })
  }
  if (opts.subtitle) {
    const subSize = fitFont(p, opts.subtitle, Math.round(titleSize * 0.44))
    layer({
      kind: 'text',
      textAnim: 'fade',
      text: { text: opts.subtitle, font: 'PingFang SC', fontSize: subSize, color: '#E8E8E8', stroke: '#000000', strokeWidth: style === 'box' ? 0 : 2, align: 'center' },
      fx: { posX: 0.5, posY: titleY + (bold ? 0.13 : 0.085), keys: { opacity: fadeInOut(durationMs) } }
    })
  }
  return { ops, notes }
}

export async function runTitleTool(name: string, args: Record<string, unknown>, source: ReviewAction['source']): Promise<ActionResult> {
  const p = store.requireProject()
  const total = timelineDurationMs(p.timeline)
  const style = (['minimal', 'bold', 'box'].includes(String(args.style)) ? String(args.style) : 'minimal') as CardStyle
  const accent = typeof args.accent === 'string' && /^#?[0-9a-fA-F]{6}$/.test(args.accent) ? (args.accent.startsWith('#') ? args.accent : `#${args.accent}`) : '#FFD400'

  if (name === 'title_card') {
    const kind = (['intro', 'chapter', 'end'].includes(String(args.kind)) ? String(args.kind) : 'intro') as CardKind
    if (total <= 0) throw new Error('时间线是空的，先排上素材再加标题卡')
    const title = String(args.title ?? '').trim() || (kind === 'end' ? '谢谢观看' : '')
    if (!title) throw new Error('需要 title')
    const defaultDur = kind === 'intro' ? 2500 : kind === 'chapter' ? 2000 : 3000
    let durationMs = Math.max(800, num(args.durationMs, defaultDur))
    let startMs = resolveAt(p, args) ?? (kind === 'end' ? Math.max(0, total - durationMs) : 0)
    if (startMs + durationMs > total) durationMs = Math.max(800, total - startMs)
    const warnings: string[] = []
    let number: number | undefined
    if (kind === 'chapter') {
      const chapters = (p.markers ?? []).filter((m) => m.kind === 'chapter')
      number = args.number != null ? num(args.number, 1) : chapters.filter((m) => m.atMs < startMs).length + 1
    }
    const { ops, notes } = cardOps(p, kind, { title, subtitle: typeof args.subtitle === 'string' ? args.subtitle.trim() || undefined : undefined, startMs, durationMs, style, accent, number })
    const clash = p.timeline.overlays.filter(
      (o) => (o.kind === 'text' || o.kind === 'shape') && o.startMs < startMs + durationMs && o.startMs + o.durationMs > startMs
    )
    if (clash.length) {
      warnings.push(`和已有的 ${clash.length} 个文字 / 形状层时间重叠（${clash.slice(0, 4).map((c) => c.text?.text ?? c.id).join('、')}），画面会叠在一起；换个时间，或先 remove_clip 删掉旧的。`)
    }
    const before = new Set(p.timeline.overlays.map((c) => c.id))
    await store.batch(`${kind === 'intro' ? '片头' : kind === 'chapter' ? '章节卡' : '片尾'}：${title}`, async () => {
      await store.applyOps(ops, source, `标题卡 ${title}`)
      if (kind === 'chapter') {
        p.markers = [...(p.markers ?? []).filter((m) => !(m.kind === 'chapter' && Math.abs(m.atMs - startMs) < 50)), { id: id('mk'), atMs: startMs, label: title, kind: 'chapter' as const }].sort((a, b) => a.atMs - b.atMs)
      }
    })
    const created = p.timeline.overlays.filter((c) => !before.has(c.id)).map((c) => c.id)
    warnings.push(...notes)
    return withWarnings(
      { ...result(name, `已加${kind === 'intro' ? '片头' : kind === 'chapter' ? `第 ${number} 章章节卡` : '片尾'}「${title}」${Math.round(startMs)}–${Math.round(startMs + durationMs)}ms（${style}）`, created), startMs, endMs: startMs + durationMs, createdIds: created } as ActionResult,
      warnings
    )
  }

  if (name === 'set_chapters') {
    const list = Array.isArray(args.chapters) ? (args.chapters as Record<string, unknown>[]) : []
    if (!list.length) throw new Error('需要 chapters：[{title, atText 或 atMs}]')
    const resolved = list.map((c, i) => {
      const title = String(c.title ?? '').trim()
      if (!title) throw new Error(`第 ${i + 1} 章缺少 title`)
      const at = resolveAt(p, c) ?? (i === 0 ? 0 : null)
      if (at == null) throw new Error(`第 ${i + 1} 章「${title}」需要 atText 或 atMs`)
      return { title, atMs: Math.round(at) }
    }).sort((a, b) => a.atMs - b.atMs)
    const warnings: string[] = []
    if (resolved[0]!.atMs > 1000) warnings.push('第一章不是从 0 开始：很多平台要求章节列表以 00:00 开头，已在列表里把第一章记为 00:00。')
    for (let i = 1; i < resolved.length; i++) {
      if (resolved[i]!.atMs - resolved[i - 1]!.atMs < 10000) warnings.push(`「${resolved[i - 1]!.title}」只有 ${Math.round((resolved[i]!.atMs - resolved[i - 1]!.atMs) / 1000)} 秒，章节太短（平台一般要求 ≥10 秒）。`)
    }
    await store.batch('标章节', async () => {
      store.pushUndo('标章节')
      p.markers = [...(p.markers ?? []).filter((m) => m.kind !== 'chapter'), ...resolved.map((c) => ({ id: id('mk'), atMs: c.atMs, label: c.title, kind: 'chapter' as const }))].sort((a, b) => a.atMs - b.atMs)
      store.log({ tool: name, summary: `标章节（${resolved.length} 章）`, risk: 'low', source })
      if (args.cards === true) {
        for (let i = 0; i < resolved.length; i++) {
          const c = resolved[i]!
          // 开场那一章不加卡：片头就在这里，叠在一起会互相遮挡
          if (c.atMs < 1500) {
            warnings.push(`第 1 章「${c.title}」在片头，没加章节卡（片头标题就是它；要单独的卡用 title_card chapter）。`)
            continue
          }
          const { ops } = cardOps(p, 'chapter', { title: c.title, startMs: c.atMs, durationMs: Math.min(2000, Math.max(800, total - c.atMs)), style: (['minimal', 'bold', 'box'].includes(String(args.style)) ? String(args.style) : 'minimal') as CardStyle, accent: '#FFD400', number: i + 1 })
          await store.applyOps(ops, source, `章节卡 ${c.title}`)
        }
      }
      await store.save()
      store.broadcast()
    })
    const text = resolved.map((c, i) => `${fmtTime(i === 0 ? 0 : c.atMs)} ${c.title}`).join('\n')
    return withWarnings({ ...result(name, `已标 ${resolved.length} 章${args.cards === true ? '并加了章节卡' : ''}`), chapters: resolved, description: text } as ActionResult, warnings)
  }
  throw new Error(`未知工具: ${name}`)
}
