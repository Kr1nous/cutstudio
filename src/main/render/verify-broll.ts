/**
 * B-roll 相关单测（insert_broll 定位 / 吸附、adjust_broll 的前置逻辑、review 的 broll_* / music_inaudible、
 * 素材抽帧）。由 verify.ts 调用。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  brollSentenceCrossing,
  findTextHit,
  isFullFrameBroll,
  overlappingBroll,
  snapBrollStart,
  spillsIntoNext,
  timelineSentences
} from '../../shared/broll'
import { type Project, type TimelineClip, DEFAULT_PROJECT_SETTINGS, DEFAULT_SUBTITLE_STYLE, emptyTimeline } from '../../shared/types'
import { dialogLoudness, reviewTimeline } from '../review/check'
import { runFfmpeg } from './ffmpeg'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[broll] ${msg}`)
}

function clip(partial: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'assetId'>): TimelineClip {
  return { startMs: 0, durationMs: 2000, inMs: 0, outMs: 2000, volume: 1, source: 'ai', ...partial }
}

/** 每个字一个词，逐字 200ms；句间留 gapMs 停顿。返回 cue 列表（素材源时间）。 */
function cues(assetId: string, sentences: string[], startMs = 100, gapMs = 600) {
  let t = startMs
  return sentences.map((text) => {
    const chars = [...text]
    const words = chars.map((ch, i) => ({ text: ch, startMs: t + i * 200, endMs: t + i * 200 + 180 }))
    const cue = { assetId, text, startMs: t, endMs: t + chars.length * 200, words }
    t = cue.endMs + gapMs
    return cue
  })
}

/**
 * 仿照试剪的产品口播：素材 A 四句话。
 *   #0 这款无线耳机很好用。 源 100–2080（每字一个词，200ms 一个）
 *   #1 先说充电盒，很小。   源 2700–4480（句号那个词被 s1 出点切掉，时间线上到 4280）
 *   #2 降噪也不错。         源 5100–6280 → 时间线 5000–6180
 *   #3 总之推荐。           源 6900–7880 → 时间线 6800–7780
 */
function productProject(): Project {
  const transcript = cues('A', ['这款无线耳机很好用。', '先说充电盒，很小。', '降噪也不错。', '总之推荐。'])
  const p: Project = {
    version: 1,
    name: 'broll',
    createdAt: '',
    updatedAt: '',
    settings: { ...DEFAULT_PROJECT_SETTINGS, width: 1920, height: 1080 },
    subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
    assets: [
      { id: 'A', name: 'talk.mp4', path: '/a', kind: 'video', durationMs: 9000, width: 1920, height: 1080, fps: 30, importedAt: '', index: { silence: [], speech: [{ startMs: 100, endMs: 7700 }], scenes: [], peakRms: 0.3, version: 3, lufs: -16, truePeak: -3 } },
      { id: 'E', name: '耳机特写.mp4', path: '/e', kind: 'video', durationMs: 6000, width: 1920, height: 1080, fps: 30, importedAt: '' },
      { id: 'C', name: '充电盒特写.mp4', path: '/c', kind: 'video', durationMs: 6000, width: 1920, height: 1080, fps: 30, importedAt: '' },
      { id: 'M', name: 'music.m4a', path: '/m', kind: 'audio', durationMs: 60000, width: 0, height: 0, fps: 0, importedAt: '', index: { silence: [], speech: [], scenes: [], peakRms: 0.1, version: 3, lufs: -20 } }
    ],
    timeline: emptyTimeline(),
    transcript,
    markers: [],
    snapshots: [],
    review: []
  }
  // 两段故事线：0–4300 源 0–4300；源 4300–4400 剪掉，时间线 4300 起接源 4400
  p.timeline.storyline = [
    clip({ id: 's1', assetId: 'A', startMs: 0, durationMs: 4300, inMs: 0, outMs: 4300 }),
    clip({ id: 's2', assetId: 'A', startMs: 4300, durationMs: 3500, inMs: 4400, outMs: 7900 })
  ]
  return p
}

function locateTests(): void {
  const p = productProject()
  const sentences = timelineSentences(p)
  assert(sentences.length === 4, `4 句都在时间线上，实际 ${sentences.length}`)
  assert(sentences[0]!.startMs === 100 && sentences[0]!.endMs === 2080, `#0 时间线位置 ${sentences[0]!.startMs}–${sentences[0]!.endMs}`)
  // #2 源 5100 开始，片段 s2 源 4400 → 时间线 4300 + 700 = 5000
  assert(sentences[2]!.startMs === 5000, `#2 经过剪辑点映射到 5000，实际 ${sentences[2]!.startMs}`)
  assert(sentences[1]!.endMs === 4280, `#1 句号被出点切掉，时间线句尾 4280，实际 ${sentences[1]!.endMs}`)

  const hit = findTextHit(p, '无线耳机')!
  assert(hit, '找得到「无线耳机」')
  assert(hit.sentenceStartMs === 100 && hit.sentenceEndMs === 2080, `整句范围 ${hit.sentenceStartMs}–${hit.sentenceEndMs}`)
  assert(hit.wordStartMs === 500, `词起点 = 第 3 个字 500ms，实际 ${hit.wordStartMs}`)
  assert(hit.matchedText === '无线耳机', `matchedText ${hit.matchedText}`)
  // 忽略标点 / 空白
  const h2 = findTextHit(p, '充电盒 很小')!
  assert(h2 && h2.sentenceId === 'A#1' && h2.matchedText === '充电盒，很小', `跨标点匹配 ${JSON.stringify(h2)}`)
  assert(findTextHit(p, '不存在的台词') == null, '找不到时返回 null')
  // 分句范围（align=clause）：逗号把「先说充电盒，很小。」分成两段
  const hc = findTextHit(p, '充电盒')!
  assert(hc.clauseStartMs === hc.sentenceStartMs && hc.clauseEndMs < hc.sentenceEndMs, `「充电盒」分句在逗号前结束 ${JSON.stringify(hc)}`)
  const hs = findTextHit(p, '很小')!
  assert(hs.clauseStartMs === hs.wordStartMs && hs.clauseStartMs > hs.sentenceStartMs && hs.clauseEndMs === hs.sentenceEndMs, `「很小」分句从逗号后开始 ${JSON.stringify(hs)}`)

  // 被剪掉的句子不再命中
  const cut = productProject()
  cut.timeline.storyline = [clip({ id: 's1', assetId: 'A', startMs: 0, durationMs: 2500, inMs: 0, outMs: 2500 })]
  assert(findTextHit(cut, '充电盒') == null, '已剪掉的句子不命中')
}

function snapTests(): void {
  const p = productProject()
  // 离时间线开头 100ms → 吸到 0
  assert(snapBrollStart(p.timeline, 100) === 0, '开头 100ms 吸附到 0')
  // 离片段 s2 开头（4300）350ms → 吸到 4300
  assert(snapBrollStart(p.timeline, 4650) === 4300, `片段开头吸附，实际 ${snapBrollStart(p.timeline, 4650)}`)
  // 超过 500ms 不吸
  assert(snapBrollStart(p.timeline, 2700) === 2700, '离锚点 > 500ms 不动')
  // 上一段 B-roll 结尾在 2500，新起点 2700 → 吸到 2500
  p.timeline.overlays = [clip({ id: 'b1', assetId: 'E', kind: 'footage', startMs: 0, durationMs: 2500, inMs: 0, outMs: 2500, fx: { opacity: 1, scale: 1, posX: 0.5, posY: 0.5 } })]
  assert(snapBrollStart(p.timeline, 2700) === 2500, `吸到上一段 B-roll 结尾，实际 ${snapBrollStart(p.timeline, 2700)}`)
  // 调整自己时不吸到自己的结尾
  assert(snapBrollStart(p.timeline, 2700, 'b1') === 2700, '排除自己')
  // 只往前吸
  assert(snapBrollStart(p.timeline, 4200) === 4200, '不往后吸到 4300')
}

function overlapTests(): void {
  const full = clip({ id: 'b1', assetId: 'E', kind: 'footage', startMs: 600, durationMs: 2800, fx: { opacity: 1, scale: 1, posX: 0.5, posY: 0.5 } })
  const other = clip({ id: 'b2', assetId: 'C', kind: 'footage', startMs: 3185, durationMs: 3500, fx: { opacity: 1, scale: 1, posX: 0.5, posY: 0.5 } })
  const pip = clip({ id: 'pip', assetId: 'C', kind: 'footage', startMs: 0, durationMs: 9000, fx: { scale: 0.3 } })
  const text = clip({ id: 't', assetId: '', kind: 'text', startMs: 0, durationMs: 9000 })
  assert(isFullFrameBroll(full) && !isFullFrameBroll(pip) && !isFullFrameBroll(text), 'isFullFrameBroll 只认铺满画面的素材层')
  const hits = overlappingBroll([full, other, pip, text], 3185, 6685, 'b2')
  assert(hits.length === 1 && hits[0]!.id === 'b1', `试剪里 599+2800 盖进 3185 的重叠要报出来：${hits.map((h) => h.id)}`)
  assert(overlappingBroll([full], 3399, 5000).length === 0, '首尾相接不算重叠')
  assert(overlappingBroll([full], 3380, 5000).length === 0, '≤ 40ms 容差')
}

function crossingTests(): void {
  const p = productProject()
  const sentences = timelineSentences(p)
  // 从 #0 句首盖到句尾：不算
  assert(brollSentenceCrossing(sentences, 0, 2000) == null, '整句不算跨句')
  // 连盖两整句（#0 + #1）：不算
  assert(brollSentenceCrossing(sentences, 0, sentences[1]!.endMs) == null, '连盖整句不算跨句')
  // 试剪里的情况：从 #1 开头盖进 #2 中间
  const x = brollSentenceCrossing(sentences, 2700, 5400)
  assert(x && x.edge === 'end' && x.next.id === 'A#2', `结尾落在下一句中间要报：${JSON.stringify(x)}`)
  // 从 #0 中间开始、盖住 #1 开头、到 #1 句尾结束
  const y = brollSentenceCrossing(sentences, 900, sentences[1]!.endMs)
  assert(y && y.edge === 'start' && y.midSentence.id === 'A#0' && y.next.id === 'A#1', `从句中开始并盖住下一句开头要报：${JSON.stringify(y)}`)
  // 在一句内部开始和结束、没盖住别的句子开头：不算（盖一个词组很正常）
  assert(brollSentenceCrossing(sentences, 900, 1700) == null, '句内短 B-roll 不算')
  // 盖进下一句的容差：只多 100ms 不算
  assert(spillsIntoNext(sentences, 'A#1', sentences[2]!.startMs + 100) == null, '容差内不算盖进下一句')
  assert(spillsIntoNext(sentences, 'A#1', sentences[2]!.startMs + 600)?.id === 'A#2', '盖进下一句 600ms 要报')
}

function reviewTests(): void {
  const clean = productProject()
  const full = { opacity: 1, scale: 1, posX: 0.5, posY: 0.5 }
  clean.timeline.overlays = [
    clip({ id: 'b1', assetId: 'E', kind: 'footage', startMs: 0, durationMs: 2500, inMs: 0, outMs: 2500, fx: full }),
    clip({ id: 'b2', assetId: 'C', kind: 'footage', startMs: 2500, durationMs: 1800, inMs: 0, outMs: 1800, fx: full })
  ]
  clean.timeline.audio = [clip({ id: 'm', assetId: 'M', role: 'music', startMs: 0, durationMs: 7800, inMs: 0, outMs: 7800, volume: 0.25 })]
  clean.timeline.duck = { enabled: true, ratio: 0.28 }
  const codes = (p: Project) => reviewTimeline(p).map((i) => i.code)
  const c0 = codes(clean)
  assert(!c0.includes('broll_overlap') && !c0.includes('broll_crosses_sentence') && !c0.includes('music_inaudible'), `干净的 B-roll 时间线不报：${c0}`)

  const bad = productProject()
  bad.timeline.overlays = [
    clip({ id: 'b1', assetId: 'E', kind: 'footage', startMs: 600, durationMs: 2800, inMs: 0, outMs: 2800, fx: full }),
    clip({ id: 'b2', assetId: 'C', kind: 'footage', startMs: 2700, durationMs: 2700, inMs: 0, outMs: 2700, fx: full })
  ]
  const issues = reviewTimeline(bad)
  const ov = issues.filter((i) => i.code === 'broll_overlap')
  assert(ov.length === 1 && ov[0]!.severity === 'warn' && ov[0]!.clipId === 'b2', `broll_overlap：${JSON.stringify(ov)}`)
  const cr = issues.filter((i) => i.code === 'broll_crosses_sentence')
  assert(cr.some((i) => i.clipId === 'b2' && /adjust_broll endMs/.test(i.message)), `broll_crosses_sentence（b2 盖进「降噪」中间）：${JSON.stringify(cr)}`)
  assert(cr.some((i) => i.clipId === 'b1'), `b1 从 #0 中间开始、盖住 #1 开头：${JSON.stringify(cr)}`)

  // 音乐：人声 -16，音乐素材 -32.7 × 0.25（≈ -44.7）→ 低 28 LU，听不见
  const quiet = productProject()
  quiet.assets.find((a) => a.id === 'M')!.index!.lufs = -32.7
  quiet.timeline.audio = [clip({ id: 'm', assetId: 'M', role: 'music', startMs: 0, durationMs: 7800, inMs: 0, outMs: 7800, volume: 0.25 })]
  quiet.timeline.duck = { enabled: true, ratio: 0.28 }
  const speech = dialogLoudness(quiet)!
  assert(Math.abs(speech - -16) < 0.01, `人声估计 -16，实际 ${speech}`)
  const mi = reviewTimeline(quiet).filter((i) => i.code === 'music_inaudible')
  assert(mi.length === 1 && mi[0]!.severity === 'warn' && /-44\.7/.test(mi[0]!.message), `music_inaudible：${JSON.stringify(mi)}`)
  // 片段音量增益计入人声：normalize 把人声压低 6dB 后差距变小
  quiet.timeline.storyline.forEach((c) => (c.volume = 0.5))
  assert(Math.abs(dialogLoudness(quiet)! - (-16 - 6.02)) < 0.05, '人声响度计入片段音量')
  // set_music 自动定音量：素材 -32.7 × 1.72（+4.7dB）≈ -28 LUFS，比人声低 12 LU → 既不太响也不是听不见
  quiet.timeline.storyline.forEach((c) => (c.volume = 1))
  quiet.timeline.audio[0]!.volume = 1.72
  const auto = codes(quiet)
  assert(!auto.includes('music_too_loud') && !auto.includes('music_inaudible'), `按响度判断，音量 1.72 不算太响：${auto}`)
  // 只比人声低 3 LU → 太响
  quiet.assets.find((a) => a.id === 'M')!.index!.lufs = -19
  quiet.timeline.audio[0]!.volume = 1
  const loud = reviewTimeline(quiet).filter((i) => i.code === 'music_too_loud')
  assert(loud.length === 1 && /低 3 LU/.test(loud[0]!.message), `music_too_loud 按 LU：${JSON.stringify(loud)}`)
  quiet.assets.find((a) => a.id === 'M')!.index!.lufs = -13
  assert(reviewTimeline(quiet).some((i) => i.code === 'music_too_loud' && /还响 3 LU/.test(i.message)), '比人声还响')
  // 没有响度数据时不报 inaudible，太响退回音量阈值
  delete quiet.assets.find((a) => a.id === 'M')!.index!.lufs
  quiet.timeline.audio[0]!.volume = 0.8
  const noLu = codes(quiet)
  assert(!noLu.includes('music_inaudible') && noLu.includes('music_too_loud'), `没有响度数据：${noLu}`)
}

/** 素材抽帧：直接对素材文件取帧（不经过时间线），contact_sheet 网格。 */
async function assetVisionTests(ffmpeg: string): Promise<void> {
  const { assetSampleTimes, runVisionTool } = await import('../ai/vision')
  const t = assetSampleTimes(6000, 4)
  assert(t.join(',') === '750,2250,3750,5250', `素材抽帧时间 ${t}`)
  assert(assetSampleTimes(6000, 4, 2000, 4000).join(',') === '2250,2750,3250,3750', '区间抽帧')
  assert(Math.max(...assetSampleTimes(100, 24)) <= 99, '不超出素材长度')

  const { store } = await import('../core')
  const dir = await mkdtemp(join(tmpdir(), 'cs-broll-vision-'))
  const saved = store.project
  try {
    const src = join(dir, 'e.mp4')
    const r = await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=2:r=10', '-pix_fmt', 'yuv420p', src])
    assert(r.code === 0, `生成测试素材失败 ${r.stderr}`)
    const p = productProject()
    p.assets[1] = { ...p.assets[1]!, path: src, durationMs: 2000, width: 320, height: 180 }
    p.timeline = emptyTimeline() // 时间线空也能看素材
    store.project = p
    const sheet = await runVisionTool('contact_sheet', { assetId: 'E', count: 4, output: 'file' })
    assert(sheet.times.join(',') === '250,750,1250,1750' && sheet.files?.length === 1, `素材网格 ${JSON.stringify({ ...sheet, images: undefined })}`)
    const jpg = await readFile(sheet.files![0]!)
    assert(jpg[0] === 0xff && jpg[1] === 0xd8 && jpg.length > 1000, '输出是 JPEG')
    const frame = await runVisionTool('get_frame', { assetId: 'E', atMs: 99999 })
    assert(frame.times[0]! >= 1400 && frame.times[0]! < 2000 && frame.images.length === 1, `get_frame assetId 截到素材结尾 ${frame.times}`)
    let threw = ''
    try {
      await runVisionTool('contact_sheet', { assetId: 'M' })
    } catch (e) {
      threw = String(e)
    }
    assert(/音频/.test(threw), `音频素材要报错：${threw}`)
    let empty = ''
    try {
      await runVisionTool('contact_sheet', {})
    } catch (e) {
      empty = String(e)
    }
    assert(/assetId/.test(empty), `空时间线的报错提示 assetId：${empty}`)
  } finally {
    store.project = saved
    await rm(dir, { recursive: true, force: true })
  }
}

/** insert_broll / adjust_broll 工具层（内存工程，projectPath 为空时 store.save 不落盘）。 */
async function brollToolTests(): Promise<void> {
  const { store } = await import('../core')
  const { runCraft } = await import('../craft')
  const saved = { project: store.project, path: store.projectPath }
  type R = Record<string, unknown> & { warnings?: string[]; startMs: number; endMs: number; clipId: string }
  const call = async (name: string, args: Record<string, unknown>) => (await runCraft(name, args, 'ai')) as unknown as R
  const fails = async (name: string, args: Record<string, unknown>) => {
    try {
      await runCraft(name, args, 'ai')
    } catch (e) {
      return String(e)
    }
    return ''
  }
  try {
    store.project = productProject()
    store.projectPath = null
    const p = store.project

    // B1：atText 默认整句，不传时长盖到句尾；句首 100ms 吸附到 0
    const a = await call('insert_broll', { assetId: 'E', atText: '无线耳机' })
    assert(a.startMs === 0 && a.endMs === 2080, `整句 + 吸附：${a.startMs}–${a.endMs}`)
    assert(a.matchedText === '无线耳机' && a.sentenceStartMs === 100 && a.sentenceEndMs === 2080, `B3 返回字段 ${JSON.stringify(a)}`)
    assert(!a.warnings?.length, `干净插入没有 warnings：${a.warnings}`)
    assert(typeof a.clipId === 'string' && p.timeline.overlays.some((o) => o.id === a.clipId), '返回 clipId')

    // B3：给了太长的时长，盖进下一句要报，并给出收回到句尾的 endMs
    const c = await call('insert_broll', { assetId: 'C', atText: '充电盒', durationMs: 3000 })
    assert(c.startMs === 2700 && c.endMs === 5700, `充电盒 ${c.startMs}–${c.endMs}`)
    assert(c.warnings?.some((w) => /盖进了下一句「降噪也不错/.test(w) && /adjust_broll endMs 4280/.test(w)), `盖进下一句：${c.warnings}`)

    // align=word 从命中的词开始；B2：和上一段 B-roll 重叠要报
    const w = await call('insert_broll', { assetId: 'E', atText: '很小', align: 'word', durationMs: 1000, inMs: 3000 })
    assert(w.startMs === 3900 && w.endMs === 4900, `align word：${w.startMs}–${w.endMs}`)
    assert(w.warnings?.some((x) => /重叠 1000ms/.test(x) && x.includes(c.clipId)), `重叠 warning：${w.warnings}`)

    // B4：adjust_broll 用时间线毫秒收到句尾，内部换算成素材源时间
    const adj = await call('adjust_broll', { clipId: c.clipId, endMs: 4280 })
    const cl = p.timeline.overlays.find((o) => o.id === c.clipId)!
    assert(adj.startMs === 2700 && adj.endMs === 4280 && cl.inMs === 0 && cl.outMs === 1580 && cl.durationMs === 1580, `adjust endMs：${JSON.stringify(cl)}`)
    assert(adj.warnings?.some((x) => /重叠/.test(x)), 'adjust 后仍和 align=word 那段重叠，要报')
    assert(!adj.warnings?.some((x) => /盖进了下一句/.test(x)), `收回后不再盖进下一句：${adj.warnings}`)
    // 移动起点保持长度；改 inMs 换素材起点
    const mv = await call('adjust_broll', { clipId: w.clipId, startMs: 4300, inMs: 1000 })
    const wl = p.timeline.overlays.find((o) => o.id === w.clipId)!
    assert(mv.startMs === 4300 && mv.endMs === 5300 && wl.inMs === 1000 && wl.outMs === 2000, `移动 + inMs：${JSON.stringify(wl)}`)
    assert(!mv.warnings?.some((x) => /重叠/.test(x)), `挪开后不重叠：${mv.warnings}`)
    // 结尾超出素材可用长度：缩短并提醒
    const long = await call('adjust_broll', { clipId: w.clipId, inMs: 5000, durationMs: 3000 })
    assert(long.endMs === 5300 && long.warnings?.some((x) => /只剩 1000ms/.test(x)), `超出素材：${long.endMs} ${long.warnings}`)
    // 报错：故事线片段、不存在的 id、太短
    assert(/故事线片段/.test(await fails('adjust_broll', { clipId: 's1', endMs: 1000 })), '故事线 id 要说明不是 B-roll')
    assert(/可选 B-roll/.test(await fails('adjust_broll', { clipId: 'nope' })), '不存在时列出可选 B-roll')
    assert(/< 300ms/.test(await fails('adjust_broll', { clipId: a.clipId, endMs: 100 })), '太短要报错')
    assert(/找不到台词/.test(await fails('insert_broll', { assetId: 'E', atText: '不存在' })), '找不到台词要报错')
  } finally {
    store.project = saved.project
    store.projectPath = saved.path
  }
}

export async function brollTests(ffmpeg: string | null): Promise<void> {
  locateTests()
  snapTests()
  overlapTests()
  crossingTests()
  reviewTests()
  await brollToolTests()
  const { enhanceSummary } = await import('../visual')
  const sum = enhanceSummary(9, ['a(饱和-0.3)', 'b', 'c', 'd', 'e', 'f', 'g'])
  assert(/检查 9 个片段，校正 7 个/.test(sum) && /另有 1 个/.test(sum) && /2 个无需调整/.test(sum), `auto_enhance 计数：${sum}`)
  if (ffmpeg) await assetVisionTests(ffmpeg)
  console.log('broll tests ok')
}
