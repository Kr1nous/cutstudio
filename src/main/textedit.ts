/**
 * 文字驱动剪辑：像改文稿一样剪口播。纯逻辑在 shared/textcut.ts、shared/captions.ts。
 */
import { buildCaptions } from '../shared/captions'
import { maxCharsForStyle } from '../shared/subtitle'
import { id } from '../shared/ids'
import {
  type CutsByAsset,
  applySourceCuts,
  detectRetakes,
  fillerWordRanges,
  heardWords,
  planCutSentences,
  resolveSpans,
  sentenceClauses,
  tightenPauses,
  transcriptDoc,
  wordKey
} from '../shared/textcut'
import { assetWords, splitSentences, stripTrailingPunct } from '../shared/transcript'
import { sourceRangeToTimeline } from '../shared/compose'
import { type ActionResult, type Project, type ReviewAction, type TimelineClip, timelineDurationMs } from '../shared/types'
import type { ToolSpec } from './ai/providers'
import { ensureStoryline, num, result, withVirtualStoryline, withWarnings } from './actions'
import { store } from './core'
import { fixTranscript } from '../shared/transcriptfix'
import { reviewTimeline } from './review/check'
import { brollColorIssues } from './review/visualcheck'
import { reanalyzeAsset } from './analysis/background'

export const TEXT_TOOLS: ToolSpec[] = [
  {
    name: 'correct_transcript',
    description:
      '改转写里的错别字（whisper 在底噪 / 专有名词上常出错，如「停顿衣裳就会化走」应为「停顿一长就会划走」）。find → replace，全部替换（assetId 只改某条素材）；词级时间保留，已有字幕自动按新文字重建。先用 get_transcript 找错字，替换后看返回的 samples 核对。',
    parameters: {
      type: 'object',
      properties: { find: { type: 'string' }, replace: { type: 'string' }, assetId: { type: 'string' } },
      required: ['find', 'replace']
    }
  },
  {
    name: 'set_vocabulary',
    description:
      '设置本工程的热词（人名、产品名、专业术语），之后的转写会把它们作为提示词，减少错字。已转写的素材要生效需 reanalyze_asset retranscribe=true（会重跑转写，已有的文字纠正会丢失）；只错几处时直接用 correct_transcript 更快。',
    parameters: { type: 'object', properties: { words: { type: 'array', items: { type: 'string' } } }, required: ['words'] }
  },
  {
    name: 'get_transcript',
    description:
      '读可剪辑的文稿：按时间线顺序列出每一句（id、文字、时间线起止毫秒、是否还在成片里；含逗号的句子另列 clauses 分句，id 形如「句子id.序号」）。粗剪前必读：找开场、口误、重复、跑题段落。fromMs/toMs 只看时间线某一段；includeCut=true 同时列出已被剪掉的句子。',
    parameters: {
      type: 'object',
      properties: { fromMs: { type: 'number' }, toMs: { type: 'number' }, includeCut: { type: 'boolean' } }
    }
  },
  {
    name: 'cut_sentences',
    description:
      '按文稿删句子或分句（口误、说错重来、跑题、准备动作、「大家好」之类可删的开场）。sentenceIds 用 get_transcript 返回的句子 id，或分句 id（「句子id.序号」，只删句子里的一段）。切点自动对齐词边界和静音，比手工 trim 干净。会重建故事线和字幕。',
    parameters: {
      type: 'object',
      properties: { sentenceIds: { type: 'array', items: { type: 'string' } }, padMs: { type: 'number' } },
      required: ['sentenceIds']
    }
  },
  {
    name: 'detect_retakes',
    description:
      '找出重录 / NG：kind=sentence 整句说了几遍；kind=clause 同一句里说到一半重来（drop 为分句 id）。默认保留最后一遍。先不带 apply 看结果，确认后 apply=true 删掉其余几遍；也可以自己挑要删的 id 用 cut_sentences。threshold 相似度 0.5–0.9，默认 0.6。',
    parameters: { type: 'object', properties: { apply: { type: 'boolean' }, threshold: { type: 'number' } } }
  },
  {
    name: 'remove_filler',
    description:
      '按词级转写删掉口头禅：嗯、呃、啊，以及独立成词的那个、就是、然后（前后有停顿才删，不会误删正常用法）。words 可自定义列表。需要转写。',
    parameters: { type: 'object', properties: { words: { type: 'array', items: { type: 'string' } } } }
  },
  {
    name: 'captions_from_transcript',
    description:
      '按语音转写生成独立字幕轨（替换已有字幕），按标点和停顿断句，时间跟着说话走。先 set_subtitle_style 设好字号再生成：每行字数自动不超过当前字号在画面上放得下的字数。maxChars 每行最大字数（默认竖屏 14、横屏 22，会被字号上限压低）；maxLines 1 或 2。之后再删内容，字幕会自动重建。没有转写时报错，不要写占位字幕。',
    parameters: {
      type: 'object',
      properties: { maxChars: { type: 'number' }, maxLines: { type: 'number', enum: [1, 2] } }
    }
  },
  {
    name: 'reanalyze_asset',
    description:
      '重新分析一条素材：静音 / 语音段、镜头、响度，并重新对齐转写的词时间（不重跑语音识别，约几秒）。retranscribe=true 时丢弃旧转写重新识别（较慢）。用于：分析状态是 error、转写明显对不上、素材被替换。完成后如需字幕，重新 captions_from_transcript；已下的剪辑刀不会变。',
    parameters: { type: 'object', properties: { assetId: { type: 'string' }, retranscribe: { type: 'boolean' } }, required: ['assetId'] }
  },
  {
    name: 'review_timeline',
    description:
      '自动质检整条成片，返回问题清单（error/warn/info，带 atMs / clipId 和中文说明）：时间线空洞、碎片、跳剪误加溶解、转场过长、字幕重叠 / 过长 / 过短、文字层挡字幕、B-roll 和讲解画面色调差太多、音乐过响或没开闪避、削波风险、开头 3 秒没人声等。交付前必须调用，error 和 warn 要修掉或向人类说明。',
    parameters: { type: 'object', properties: { visual: { type: 'boolean', description: '默认 true：另外渲染画面检查 B-roll 和讲解画面的色调差异（每段 B-roll 约 1 秒）' } } }
  },
  {
    name: 'tighten_pauses',
    description:
      '把句间 / 词间停顿压到 maxPauseMs（只删安静部分，保留呼吸感）。比 remove_silence 更自然，有转写时优先用它。知识讲解 250–350，短视频 120–200。',
    parameters: { type: 'object', properties: { maxPauseMs: { type: 'number' } }, required: ['maxPauseMs'] }
  }
]

export function isTextTool(name: string): boolean {
  return TEXT_TOOLS.some((t) => t.name === name)
}

function hasTranscript(p: Project): boolean {
  return p.transcript.some((t) => t.text.trim())
}

function requireTranscript(p: Project): void {
  if (hasTranscript(p)) return
  const pending = p.assets.some((a) => a.kind !== 'image' && (a.index?.transcription ?? 'pending') === 'pending')
  throw new Error(
    pending
      ? '语音转写还在后台进行，稍后再试；现在可以先用 remove_silence 等不依赖台词的工具。'
      : '没有语音转写（本机没有转写器或素材里没有人声），这个工具不可用。'
  )
}

function cutCount(cuts: CutsByAsset): number {
  return Object.values(cuts).reduce((n, list) => n + list.length, 0)
}

/** 每行最多字数：竖屏 14 / 横屏 22，并且不超过当前字幕样式在画布上一行放得下的字数。 */
function defaultMaxChars(p: Project): number {
  const base = p.settings.height > p.settings.width ? 14 : 22
  return Math.max(4, Math.min(base, maxCharsForStyle(p.subtitleStyle, p.settings.width, p.settings.height)))
}

/** 切掉源区间并重排故事线；已有字幕时按新剪辑重建。 */
async function applyCuts(
  name: string,
  cuts: CutsByAsset,
  source: ReviewAction['source'],
  label: string
): Promise<ActionResult> {
  const p = store.requireProject()
  const n = cutCount(cuts)
  if (!n) return withWarnings(result(name, '没有需要删除的内容'), [])
  const before = timelineDurationMs(p.timeline)
  const prevIds = new Set(p.timeline.storyline.map((c) => c.id))
  const removed = describeCuts(p, cuts)
  // 小于 150ms 的残片基本是两刀之间剩下的静音，直接丢掉。
  const next = applySourceCuts(p.timeline.storyline, cuts, 150)
  if (!next.length) throw new Error('删完后故事线为空，已取消')
  const warnings: string[] = []
  await store.batch(label, async () => {
    await store.applyOps([{ op: 'replace_storyline', clips: next }], source, label)
    warnings.push(...(await rebuildCaptionsIfAny(source)))
  })
  const after = timelineDurationMs(p.timeline)
  const located = locateCuts(removed, p.timeline.storyline)
  const keyed = next.filter((c) => !prevIds.has(c.id) && c.fx?.keys && Object.values(c.fx.keys).some((k) => k?.length))
  if (keyed.length) warnings.push('被切开的片段带关键帧（放大/音量动画），关键帧按片段比例保留，时间可能偏移，检查一下。')
  const tiny = next.filter((c) => c.durationMs < 300)
  if (tiny.length) warnings.push(`有 ${tiny.length} 个短于 300ms 的碎片（${tiny.slice(0, 6).map((c) => c.id).join(', ')}），检查是否需要删除（后续 tighten_pauses 等剪辑可能已经把它合并或删掉，处理前先 get_project 确认 id 还在）。`)
  return withWarnings(
    {
      ...result(name, `${label}：${n} 处，成片 ${Math.round(before / 100) / 10}s → ${Math.round(after / 100) / 10}s`),
      removed: located.slice(0, 40)
    } as ActionResult,
    warnings
  )
}

type RemovedItem = {
  /** 删掉的台词（没有台词的记为「（停顿）」）。 */
  text: string
  /** 删掉了多长（毫秒）。 */
  removedMs: number
  /** 剪之前它在时间线上的位置（毫秒）。 */
  wasAtMs: number | null
  /** 剪之后这里变成的切点，在新时间线上的位置（毫秒）；整段片段被删时为 null。 */
  cutAtMs: number | null
}

/** 删掉的是什么：台词、时长、剪前位置；剪后切点位置在剪完后用 locateCuts 补上。 */
function describeCuts(p: Project, cuts: CutsByAsset): (RemovedItem & { assetId: string; srcEndMs: number; srcStartMs: number })[] {
  const words = assetWords(p)
  const out: (RemovedItem & { assetId: string; srcEndMs: number; srcStartMs: number })[] = []
  for (const [assetId, ranges] of Object.entries(cuts)) {
    for (const r of ranges) {
      const said = (words.get(assetId) ?? [])
        .filter((w) => Math.min(w.endMs, r.endMs) - Math.max(w.startMs, r.startMs) > (w.endMs - w.startMs) / 2)
        .map((w) => w.text)
        .join('')
      let wasAtMs: number | null = null
      for (const clip of p.timeline.storyline) {
        if (clip.assetId !== assetId) continue
        const hit = sourceRangeToTimeline(clip, r.startMs, r.endMs)
        if (hit) {
          wasAtMs = Math.round(hit.startMs)
          break
        }
      }
      out.push({ text: said || '（停顿）', removedMs: Math.round(r.endMs - r.startMs), wasAtMs, cutAtMs: null, assetId, srcStartMs: r.startMs, srcEndMs: r.endMs })
    }
  }
  return out.sort((a, b) => (a.wasAtMs ?? 0) - (b.wasAtMs ?? 0))
}

/** 剪完后：切点 = 删除区间后面那段（源时间从区间结尾开始）的片段起点，或前面那段的结尾。 */
function locateCuts(items: ReturnType<typeof describeCuts>, storyline: TimelineClip[]): RemovedItem[] {
  return items.map(({ assetId, srcStartMs, srcEndMs, ...item }) => {
    const after = storyline.find((c) => c.assetId === assetId && Math.abs(c.inMs - srcEndMs) <= 2)
    const before = storyline.find((c) => c.assetId === assetId && Math.abs(c.outMs - srcStartMs) <= 2)
    const at = after ? after.startMs : before ? before.startMs + before.durationMs : null
    return { ...item, cutAtMs: at == null ? null : Math.round(at) }
  })
}

const SUSPECT_P = 0.7

/** 可疑词前后各 3 个词的上下文，方便判断是不是错字。 */
function suspectContext(words: { text: string }[], w: { text: string }): string {
  const i = words.indexOf(w)
  return words
    .slice(Math.max(0, i - 3), i + 4)
    .map((x) => x.text)
    .join('')
}

/** 故事线变了以后字幕会错位：有转写且已有字幕时直接重建。返回给 AI 的提醒。 */
export async function rebuildCaptionsIfAny(source: ReviewAction['source']): Promise<string[]> {
  const p = store.requireProject()
  if (!p.timeline.subtitles.length) return []
  if (!hasTranscript(p)) return ['故事线变了，但没有转写无法重建字幕：原有字幕可能已错位。']
  const fit = maxCharsForStyle(p.subtitleStyle, p.settings.width, p.settings.height)
  const maxChars = Math.max(4, Math.min(p.subtitleStyle.maxChars ?? defaultMaxChars(p), fit))
  const cues = buildCaptions(p, { maxChars, maxLines: p.subtitleStyle.maxLines ?? 1, makeId: () => id('sub'), source: source === 'human' ? 'human' : 'ai' })
  await store.applyOps([{ op: 'replace_subtitles', cues }], source, '按新剪辑重建字幕')
  return [`字幕已按新剪辑重建（${cues.length} 条，手改过的字幕会被覆盖）。`]
}

export async function runTextTool(name: string, args: Record<string, unknown>, source: ReviewAction['source']): Promise<ActionResult> {
  const p = store.requireProject()
  switch (name) {
    case 'get_transcript': {
      requireTranscript(p)
      const { project: view, virtual } = withVirtualStoryline(p)
      const from = args.fromMs != null ? num(args.fromMs, 0) : -Infinity
      const to = args.toMs != null ? num(args.toMs, 0) : Infinity
      const heard = heardWords(view)
      // 识别置信度低的词：可能是错别字，提示 AI 核对（阈值 0.7，同音字、专有名词常在这里）
      const suspectOf = new Map(
        splitSentences(view).map((s) => [
          s.id,
          s.words
            .filter((w) => w.p != null && w.p < SUSPECT_P && heard.has(wordKey(w)))
            .map((w) => ({ word: stripTrailingPunct(w.text), p: w.p, context: suspectContext(s.words, w) }))
        ] as const)
      )
      const clausesOf = new Map(
        splitSentences(view).map((s) => [s.id, sentenceClauses(s, view, heard)] as const).filter(([, c]) => c.length > 1)
      )
      const sentences = transcriptDoc(view)
        .sentences.filter((s) => (args.includeCut === true ? true : s.inTimeline))
        .filter((s) => s.timelineStartMs == null || (s.timelineStartMs < to && (s.timelineEndMs ?? s.timelineStartMs) > from))
        .map((s) => ({
          id: s.id,
          // 部分被剪时 text 只显示成片里还听得到的内容，original 给出原句
          text: s.inTimeline && s.audible < 0.98 ? s.keptText : s.text,
          ...(s.inTimeline && s.audible < 0.98 ? { original: s.text, audible: Math.round(s.audible * 100) / 100 } : {}),
          ...(s.inTimeline ? { atMs: s.timelineStartMs, endMs: s.timelineEndMs } : { cut: true }),
          ...(suspectOf.get(s.id)?.length ? { suspect: suspectOf.get(s.id) } : {}),
          ...(clausesOf.has(s.id)
            ? {
                clauses: clausesOf.get(s.id)!.map((c) => ({
                  id: c.id,
                  text: c.text,
                  ...(c.inTimeline === false || (c.audible ?? 1) < 0.5 ? { cut: true } : (c.audible ?? 1) < 0.98 ? { audible: Math.round((c.audible ?? 1) * 100) / 100 } : {})
                }))
              }
            : {})
        }))
      const shown = sentences.slice(0, 400)
      const nSuspect = sentences.reduce((n, x) => n + ((x as { suspect?: unknown[] }).suspect?.length ?? 0), 0)
      const warnings = sentences.length > shown.length ? [`文稿太长，只列出前 ${shown.length} 句；用 fromMs/toMs 分段读取。`] : []
      if (nSuspect) warnings.push(`有 ${nSuspect} 个识别置信度低的词（见各句 suspect，context 里带前后文），可能是错别字：核对后用 correct_transcript 改掉（没错就忽略）。`)
      if (virtual) warnings.push('故事线还是空的：时间按「自动排上故事线」后计算，第一个剪辑工具会自动排上。')
      return withWarnings({ ...result(name, `${sentences.length} 句`), sentences: shown } as ActionResult, warnings)
    }
    case 'cut_sentences': {
      requireTranscript(p)
      await ensureStoryline(source)
      const ids = Array.isArray(args.sentenceIds) ? args.sentenceIds.map(String) : []
      if (!ids.length) throw new Error('需要 sentenceIds（来自 get_transcript）')
      const known = new Set(resolveSpans(p, ids).map((x) => x.id))
      const unknown = ids.filter((x) => !known.has(x))
      if (unknown.length) throw new Error(`不存在的句子 / 分句 id：${unknown.slice(0, 8).join(', ')}。先调用 get_transcript。`)
      const cuts = planCutSentences(p, ids, Math.max(0, num(args.padMs, 60)))
      const r = await applyCuts(name, cuts, source, `删掉 ${ids.length} 句`)
      return withWarnings(r, ['删句后两侧停顿会连在一起，建议接着 tighten_pauses。'])
    }
    case 'detect_retakes': {
      requireTranscript(p)
      const threshold = Math.min(0.95, Math.max(0.4, num(args.threshold, 0.6)))
      if (args.apply === true) await ensureStoryline(source)
      const groups = detectRetakes(args.apply === true ? p : withVirtualStoryline(p).project, threshold)
      if (args.apply === true) {
        const drop = groups.flatMap((g) => g.drop)
        if (!drop.length) return result(name, '没有发现重录')
        return applyCuts(name, planCutSentences(p, drop), source, `删掉 ${drop.length} 遍重录`)
      }
      return {
        ...result(name, groups.length ? `发现 ${groups.length} 组重录` : '没有发现重录'),
        groups: groups.map((g) => ({
          kind: g.kind,
          keep: { id: g.keep, text: g.keepText },
          drop: g.drop.map((d, i) => ({ id: d, text: g.dropText[i] })),
          similarity: g.similarity
        })),
        warnings: groups.some((g) => g.kind === 'sentence' && g.similarity < 0.9)
          ? ['相似度低于 0.9 的整句组可能是「前一句后半截重说」，drop 会删掉整句（含前半截的问候语等），核对 text 后再决定；必要时用 cut_sentences 只删分句。']
          : []
      } as ActionResult
    }
    case 'remove_filler': {
      requireTranscript(p)
      await ensureStoryline(source)
      const words = Array.isArray(args.words) && args.words.length ? args.words.map(String) : undefined
      return applyCuts(name, fillerWordRanges(p, words), source, '去掉口头禅')
    }
    case 'tighten_pauses': {
      await ensureStoryline(source)
      const maxPauseMs = Math.min(2000, Math.max(60, num(args.maxPauseMs, 300)))
      const r = await applyCuts(name, tightenPauses(p, maxPauseMs), source, `停顿压到 ${maxPauseMs}ms`)
      return hasTranscript(p) ? r : withWarnings(r, ['没有转写，按静音分析压缩停顿。'])
    }
    case 'correct_transcript': {
      requireTranscript(p)
      const find = String(args.find ?? '')
      const replace = String(args.replace ?? '')
      if (!find.trim()) throw new Error('需要 find（要替换的错字）')
      const assetId = typeof args.assetId === 'string' && args.assetId ? args.assetId : undefined
      const fixed = fixTranscript(p.transcript, find, replace, assetId)
      if (!fixed.count) {
        throw new Error(`转写里没有找到「${find}」。注意 get_transcript 显示的标点可能和原文不同，试试只写错字本身。`)
      }
      const warnings: string[] = []
      await store.batch(`纠正转写：${find} → ${replace}`, async () => {
        store.pushUndo(`纠正转写：${find} → ${replace}`, { transcript: true })
        p.transcript = fixed.cues
        store.log({ tool: name, summary: `纠正转写：${find} → ${replace}（${fixed.count} 处）`, risk: 'low', source })
        warnings.push(...(await rebuildCaptionsIfAny(source)))
      })
      return withWarnings({ ...result(name, `已替换 ${fixed.count} 处：${find} → ${replace}`), samples: fixed.samples } as ActionResult, warnings)
    }
    case 'set_vocabulary': {
      const words = Array.isArray(args.words) ? [...new Set(args.words.map((w) => String(w).trim()).filter(Boolean))].slice(0, 40) : []
      p.vocabulary = words
      store.log({ tool: name, summary: `热词：${words.join('、') || '（清空）'}`, risk: 'low', source })
      await store.save()
      store.broadcast()
      const transcribed = p.assets.filter((a) => p.transcript.some((c) => c.assetId === a.id))
      return withWarnings(
        { ...result(name, `已设置 ${words.length} 个热词，之后的转写生效`), vocabulary: words } as ActionResult,
        transcribed.length ? [`已有 ${transcribed.length} 条素材转写过；要用新热词重转写：reanalyze_asset assetId=… retranscribe=true。`] : []
      )
    }
    case 'reanalyze_asset': {
      const assetId = String(args.assetId ?? '')
      const asset = p.assets.find((a) => a.id === assetId)
      if (!asset) throw new Error(`素材不存在: ${assetId}`)
      if (asset.kind !== 'video' && asset.kind !== 'audio') throw new Error('只有视频和音频素材需要分析')
      const r = await reanalyzeAsset(store, assetId, { retranscribe: args.retranscribe === true })
      const warnings = p.timeline.subtitles.length ? ['字幕没有自动更新：需要的话重新 captions_from_transcript。'] : []
      return withWarnings(
        { ...result(name, `${asset.name} 已重新分析：分析 ${r.analysis ?? '?'}，转写 ${r.transcription ?? '?'}（${r.cues} 段）`), analysis: r.analysis, transcription: r.transcription } as ActionResult,
        warnings
      )
    }
    case 'review_timeline': {
      const issues = reviewTimeline(p, { maxChars: defaultMaxChars(p) + (p.settings.height > p.settings.width ? 2 : 0) })
      // 需要渲染画面的检查（B-roll 色调）：visual=false 可跳过以加快速度
      if (args.visual !== false) issues.push(...(await brollColorIssues(p)))
      const count = (s: string) => issues.filter((i) => i.severity === s).length
      const summary = issues.length
        ? `${count('error')} 个错误，${count('warn')} 个警告，${count('info')} 个提示`
        : '没有发现问题'
      return { ...result(name, summary), issues: issues.slice(0, 80) } as ActionResult
    }
    case 'captions_from_transcript': {
      await ensureStoryline(source)
      if (!hasTranscript(p)) {
        if (source === 'human') throw new Error('还没有语音转写，暂时不能生成字幕。')
        requireTranscript(p)
      }
      const capWarnings: string[] = []
      const fit = maxCharsForStyle(p.subtitleStyle, p.settings.width, p.settings.height)
      const asked = num(args.maxChars, defaultMaxChars(p))
      const maxChars = Math.max(4, Math.min(asked, fit))
      if (asked > fit) capWarnings.push(`当前字号一行只放得下 ${fit} 字，maxChars 已从 ${asked} 降到 ${fit}（先 set_subtitle_style 再生成字幕）。`)
      const maxLines = args.maxLines === 2 ? 2 : 1
      const cues = buildCaptions(p, { maxChars, maxLines, makeId: () => id('sub'), source: source === 'human' ? 'human' : 'ai' })
      if (!cues.length) throw new Error('时间线上没有能对上转写的语音')
      p.subtitleStyle.maxChars = maxChars
      p.subtitleStyle.maxLines = maxLines
      await store.applyOps([{ op: 'replace_subtitles', cues }], source, `生成 ${cues.length} 条字幕`)
      const long = cues.filter((c) => c.endMs - c.startMs > 6000).length
      return withWarnings(result(name, `字幕轨 ${cues.length} 条（每行 ≤ ${maxChars} 字）`), [...capWarnings, ...(long ? [`${long} 条字幕超过 6 秒，可调小 maxChars。`] : [])])
    }
  }
  throw new Error(`未知工具: ${name}`)
}
