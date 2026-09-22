/**
 * 阶段 2 剪辑工具单测：speed_ramp / ken_burns / voice_enhance / snap_cuts_to_beats / render_preview，
 * 以及它们用到的纯函数（shared/cliptime、ramp、kenburns、voice、beatsnap）。由 verify.ts 调用。
 */
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sampleKeys } from '../../shared/anim'
import { beatsOnTimeline, planBeatSnap } from '../../shared/beatsnap'
import { cutClip, sliceKeys, sliceProject } from '../../shared/cliptime'
import { planKenBurns } from '../../shared/kenburns'
import { planSpeedRamp } from '../../shared/ramp'
import { type Project, type TimelineClip, DEFAULT_CLIP_FX, DEFAULT_PROJECT_SETTINGS, DEFAULT_SUBTITLE_STYLE, emptyTimeline } from '../../shared/types'
import { VOICE_PRESETS, missingVoiceFilters, voiceFfmpeg } from '../../shared/voice'
import { reviewTimeline } from '../review/check'
import { findFfprobe, runFfmpeg } from './ffmpeg'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[tools] ${msg}`)
}

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol

function clip(partial: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'assetId'>): TimelineClip {
  return { startMs: 0, durationMs: 2000, inMs: 0, outMs: 2000, volume: 1, source: 'ai', ...partial }
}

function baseProject(w = 1920, h = 1080): Project {
  return {
    version: 1,
    name: 'tools',
    createdAt: '',
    updatedAt: '',
    settings: { ...DEFAULT_PROJECT_SETTINGS, width: w, height: h, aspect: w > h ? '16:9' : w < h ? '9:16' : '1:1' },
    subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
    assets: [
      { id: 'A', name: 'talk.mp4', path: '/a', kind: 'video', durationMs: 20000, width: 1920, height: 1080, fps: 30, importedAt: '', index: { silence: [], speech: [{ startMs: 0, endMs: 20000 }], scenes: [], peakRms: 0.3, version: 3, lufs: -16, truePeak: -3 } },
      { id: 'M', name: 'music.m4a', path: '/m', kind: 'audio', durationMs: 60000, width: 0, height: 0, fps: 0, importedAt: '', index: { silence: [], speech: [], scenes: [], peakRms: 0.1, version: 3, lufs: -28, beats: [] } }
    ],
    timeline: emptyTimeline(),
    transcript: [],
    markers: [],
    snapshots: [],
    review: []
  }
}

// —— cliptime ——
function cliptimeTests(): void {
  const keys = [
    { t: 0, value: 1, ease: 'linear' as const },
    { t: 1, value: 2, ease: 'linear' as const }
  ]
  const half = sliceKeys(keys, 0.5, 1)!
  assert(half.length === 2 && near(half[0]!.value, 1.5, 1e-3) && half[1]!.value === 2, `sliceKeys 后半段 ${JSON.stringify(half)}`)
  const mid = sliceKeys([...keys.slice(0, 1), { t: 0.5, value: 3, ease: 'linear' }, keys[1]!], 0.25, 0.75)!
  assert(mid.length === 3 && near(mid[1]!.t, 0.5, 1e-3) && mid[1]!.value === 3, `中间关键帧重映射 ${JSON.stringify(mid)}`)

  const c = clip({ id: 'c', assetId: 'A', startMs: 1000, durationMs: 2000, inMs: 4000, outMs: 8000, fx: { ...DEFAULT_CLIP_FX, speed: 2, fadeInMs: 300, fadeOutMs: 300, transitionOut: { type: 'cross_dissolve', durationMs: 500 } } })
  const head = cutClip(c, 0, 500)
  assert(head.inMs === 4000 && head.outMs === 5000 && head.durationMs === 500 && head.startMs === 1000, `2x 片段截前 500ms ${JSON.stringify(head)}`)
  assert(head.fx?.fadeInMs === 300 && head.fx?.fadeOutMs === 0 && head.fx?.transitionOut?.type === 'none', '截掉尾巴时去掉淡出 / 出点转场')
  const rev = cutClip({ ...c, fx: { ...c.fx!, reverse: true } }, 0, 500)
  assert(rev.inMs === 7000 && rev.outMs === 8000, `倒放片段从源出点往回截 ${rev.inMs}-${rev.outMs}`)

  const p = baseProject()
  p.timeline.storyline = [
    clip({ id: 's1', assetId: 'A', startMs: 0, durationMs: 3000, inMs: 0, outMs: 3000, fx: { ...DEFAULT_CLIP_FX, transitionOut: { type: 'cross_dissolve', durationMs: 500 } } }),
    clip({ id: 's2', assetId: 'A', startMs: 2500, durationMs: 3000, inMs: 5000, outMs: 8000 }),
    clip({ id: 's3', assetId: 'A', startMs: 5500, durationMs: 3000, inMs: 9000, outMs: 12000 })
  ]
  p.timeline.overlays = [clip({ id: 'o1', assetId: 'A', kind: 'footage', startMs: 4000, durationMs: 3000, inMs: 0, outMs: 3000 })]
  p.timeline.audio = [clip({ id: 'm', assetId: 'M', role: 'music', startMs: 0, durationMs: 8500, inMs: 0, outMs: 8500, volume: 0.2, fx: { ...DEFAULT_CLIP_FX, fadeOutMs: 1500 } })]
  p.timeline.subtitles = [
    { id: 'a', startMs: 1000, endMs: 3000, text: '一', source: 'ai' },
    { id: 'b', startMs: 4500, endMs: 6000, text: '二', source: 'ai' }
  ]
  const sl = sliceProject(p, 4000, 7000)
  const st = sl.timeline.storyline
  assert(st.length === 2 && st[0]!.id === 's2' && st[0]!.inMs === 6500 && st[0]!.durationMs === 1500 && st[0]!.startMs === 0, `切片故事线 ${JSON.stringify(st.map((x) => [x.id, x.startMs, x.inMs, x.durationMs]))}`)
  assert(st[1]!.id === 's3' && st[1]!.startMs === 1500 && st[1]!.durationMs === 1500, 's3 接在后面')
  assert(sl.timeline.overlays[0]!.startMs === 0 && sl.timeline.overlays[0]!.durationMs === 3000, '叠加层平移')
  assert(sl.timeline.audio[0]!.inMs === 4000 && sl.timeline.audio[0]!.fx?.fadeOutMs === 0, '音乐从 4s 开始、尾巴被截掉不淡出')
  assert(sl.timeline.subtitles.length === 1 && sl.timeline.subtitles[0]!.startMs === 500 && sl.timeline.subtitles[0]!.endMs === 2000, '字幕平移')
  assert(p.timeline.storyline[1]!.inMs === 5000, '不改原工程')
  const sl2 = sliceProject(p, 1000, 4000)
  assert(sl2.timeline.storyline[0]!.fx?.transitionOut?.type === 'cross_dissolve' && sl2.timeline.storyline.at(-1)!.fx?.transitionOut?.type === 'none', '窗口内的转场保留、最后一段的去掉')
}

// —— speed_ramp ——
function rampTests(): void {
  const c = clip({ id: 'r', assetId: 'A', startMs: 1000, durationMs: 6000, inMs: 2000, outMs: 8000 })
  const plan = planSpeedRamp(c, [
    { atMs: 2000, rate: 1 },
    { atMs: 4000, rate: 2 },
    { atMs: 6000, rate: 1 }
  ])
  const segs = plan.segments
  assert(segs.length >= 3 && segs.length <= 8, `段数 ${segs.length}`)
  assert(segs[0]!.inMs === 2000 && segs.at(-1)!.outMs === 8000, '覆盖整个源区间')
  for (let i = 1; i < segs.length; i++) assert(segs[i]!.inMs === segs[i - 1]!.outMs, '子片段首尾相接')
  assert(segs[0]!.rate === 1 && segs.at(-1)!.rate === 1, `两端 1x：${segs.map((s) => s.rate)}`)
  assert(Math.max(...segs.map((s) => s.rate)) > 1.5, `中间加速：${segs.map((s) => s.rate)}`)
  assert(plan.durationMs < 6000 && plan.durationMs > 3000, `总时长变短 ${plan.durationMs}`)
  // 调和平均：每段 (out-in)/rate 求和 = 总时长
  const sum = segs.reduce((n, s) => n + (s.outMs - s.inMs) / s.rate, 0)
  assert(near(sum, plan.durationMs, 1), '段时长和总时长一致')
  // 恒速：一个点 → 一段
  const flat = planSpeedRamp(c, [{ atMs: 3000, rate: 2 }])
  assert(flat.segments.length === 1 && flat.segments[0]!.rate === 2 && near(flat.durationMs, 3000), `恒速 ${JSON.stringify(flat.segments)}`)
  // 夹紧 + 越界提醒
  const wild = planSpeedRamp(c, [{ atMs: 0, rate: 9 }])
  assert(wild.segments[0]!.rate === 4 && wild.warnings.length >= 2, `rate 夹紧、点越界提醒 ${wild.warnings}`)
  let err = ''
  try {
    planSpeedRamp({ ...c, fx: { ...DEFAULT_CLIP_FX, reverse: true } }, [{ atMs: 2000, rate: 2 }])
  } catch (e) {
    err = String(e)
  }
  assert(/倒放/.test(err), '倒放片段报错')
  err = ''
  try {
    planSpeedRamp(c, Array.from({ length: 10 }, (_, i) => ({ atMs: 1500 + i * 500, rate: 1 + (i % 2) })))
  } catch (e) {
    err = String(e)
  }
  assert(/太多/.test(err), `点太多报错 ${err}`)
}

// —— ken_burns ——
function kenBurnsTests(): void {
  const W = 1920
  const H = 1080
  const fx = { ...DEFAULT_CLIP_FX }
  const plan = planKenBurns(fx, W, H, 1920, 1080)
  assert(plan.from.scale === 1 && plan.to.scale === 1.12 && plan.to.x === 0.5 && !plan.warnings.length, `默认缓推 ${JSON.stringify(plan)}`)
  // 拉到 < 1 会露黑边 → 夹到 1
  const out = planKenBurns(fx, W, H, 1920, 1080, { scale: 1.1 }, { scale: 0.9 })
  assert(out.to.scale === 1 && out.warnings.some((w) => /黑边/.test(w)), `缓拉不露黑边 ${JSON.stringify(out)}`)
  // 平移出界 → 收回
  const pan = planKenBurns(fx, W, H, 1920, 1080, { scale: 1.2, x: 0.2 }, { scale: 1.2, x: 0.95 })
  assert(near(pan.from.x, 0.4, 0.001) && near(pan.to.x, 0.6, 0.001), `平移夹在 0.4–0.6：${pan.from.x} ${pan.to.x}`)

  // 竖屏 reframe 铺满（scale ≈ 3.16、人偏左）后再推：按当前缩放乘倍率，review 不报黑边
  const p = baseProject(1080, 1920)
  const cover = 1920 / (1080 * (1080 / 1920))
  const base = { ...DEFAULT_CLIP_FX, scale: cover, scaleX: cover, scaleY: cover, posX: 0.8, posY: 0.5 }
  const kb = planKenBurns(base, 1080, 1920, 1920, 1080, {}, { scale: 1.15, x: 1.2 })
  assert(near(kb.from.scale, cover, 0.01) && near(kb.to.scale, cover * 1.15, 0.01), `在当前缩放上乘 ${kb.from.scale} ${kb.to.scale}`)
  p.timeline.storyline = [clip({ id: 'v', assetId: 'A', durationMs: 4000, inMs: 0, outMs: 4000, fx: { ...base, keys: kb.keys } })]
  const lb = reviewTimeline(p).filter((i) => i.code === 'letterbox')
  assert(!lb.length, `竖屏缓推不露黑边：${JSON.stringify(lb)}`)
  // 对照：直接写 1→1.12 的绝对值（不乘当前缩放）会被 letterbox 检查抓到
  p.timeline.storyline[0]!.fx = { ...base, keys: { scale: [{ t: 0, value: 1, ease: 'linear' }, { t: 1, value: 1.12, ease: 'linear' }] } }
  assert(reviewTimeline(p).some((i) => i.code === 'letterbox'), 'letterbox 检查对绝对缩放有效（对照）')
  // 有人物跟随位置关键帧、没给 x/y：只动缩放，倍率不能 < 1
  const keep = planKenBurns(base, 1080, 1920, 1920, 1080, { scale: 1 }, { scale: 0.9 }, { keepPos: true })
  assert(!keep.keys.posX && keep.to.scale >= cover - 0.001, `keepPos 只做缩放 ${JSON.stringify(keep)}`)
}

// —— voice_enhance ——
function voiceTests(): void {
  const chain = voiceFfmpeg({ voice: { preset: 'podcast' }, denoise: null })
  assert(chain[0]!.startsWith('highpass=f=80') && chain.some((f) => f.startsWith('afftdn')) && chain.some((f) => f.startsWith('deesser')) && chain.some((f) => /equalizer=f=3000/.test(f)), `podcast 链 ${chain}`)
  assert(!voiceFfmpeg({ voice: { preset: 'podcast' }, denoise: { enabled: true, amount: 0.5 } }).some((f) => f.startsWith('afftdn')), '已开 denoise 不重复降噪')
  assert(voiceFfmpeg({ voice: null, denoise: null }).length === 0, '没开返回空')
  const noDeess = voiceFfmpeg({ voice: { preset: 'clear' }, denoise: null }, (f) => f !== 'deesser')
  assert(!noDeess.some((f) => f.startsWith('deesser')) && noDeess.length > 0, '没有 deesser 时跳过')
  assert(missingVoiceFilters('warm', (f) => f !== 'lowshelf').join() === 'lowshelf', 'missingVoiceFilters')
}

async function voiceFfmpegTests(ffmpeg: string): Promise<void> {
  // 每个预设的滤镜链在本机 ffmpeg 上都能跑（语法、参数范围）
  for (const preset of VOICE_PRESETS) {
    const chain = voiceFfmpeg({ voice: { preset }, denoise: null }).join(',')
    const r = await runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-af', chain, '-f', 'null', '-'])
    assert(r.code === 0, `${preset} 滤镜链跑不通：${r.stderr.slice(-300)}`)
  }
}

// —— snap_cuts_to_beats ——
function beatSnapTests(): void {
  const p = baseProject()
  // 素材 A：0–2000 说话，2000–2600 静音，2600–5000 说话，5000–5600 停顿，5600 以后说话
  p.assets[0]!.index = { ...p.assets[0]!.index!, silence: [{ startMs: 2000, endMs: 2600 }], pauses: [{ startMs: 5000, endMs: 5600, depthDb: 20 }] }
  p.transcript = [
    { assetId: 'A', startMs: 0, endMs: 1950, text: '第一句', words: [{ text: '第一句', startMs: 0, endMs: 1950 }] },
    { assetId: 'A', startMs: 2650, endMs: 4950, text: '第二句', words: [{ text: '第二句', startMs: 2650, endMs: 4950 }] },
    { assetId: 'A', startMs: 5650, endMs: 9000, text: '第三句', words: [{ text: '第三句', startMs: 5650, endMs: 9000 }] }
  ]
  // 切点 1 在时间线 2300：c1 源出点 2300，c2 源入点 2400（中间剪掉 100ms，不是连续素材）
  p.timeline.storyline = [
    clip({ id: 'c1', assetId: 'A', startMs: 0, durationMs: 2300, inMs: 0, outMs: 2300 }),
    clip({ id: 'c2', assetId: 'A', startMs: 2300, durationMs: 2900, inMs: 2400, outMs: 5300 }),
    clip({ id: 'c3', assetId: 'A', startMs: 5200, durationMs: 3000, inMs: 5500, outMs: 8500 })
  ]
  // 拍子：2400（切点 1 后 100ms，两侧静音 → 挪），5100（切点 2 前 100ms，停顿区 → 挪），另有远处的拍
  const plan = planBeatSnap(p, [1000, 2400, 5100, 7000], 150)
  assert(plan.moves.length === 2, `挪 2 个切点：${JSON.stringify(plan)}`)
  const [m1, m2] = plan.moves
  assert(m1!.atMs === 2300 && m1!.toMs === 2400 && m1!.deltaMs === 100, `切点 1：${JSON.stringify(m1)}`)
  assert(m2!.atMs === 5200 && m2!.deltaMs === -100, `切点 2：${JSON.stringify(m2)}`)
  const st = plan.storyline
  assert(st[0]!.outMs === 2400 && st[0]!.durationMs === 2400 && st[1]!.inMs === 2500 && st[1]!.startMs === 2400, '滚动剪辑：前出点 / 后入点同时挪')
  assert(st[1]!.outMs === 5200 && st[2]!.inMs === 5400 && st[2]!.startMs === 5100, '往前挪')
  const total = (xs: TimelineClip[]) => xs.reduce((n, c) => n + c.durationMs, 0)
  assert(total(st) === total(p.timeline.storyline), '总时长不变')
  assert(p.timeline.storyline[0]!.outMs === 2300, '不改输入')
  // 往前挪 400ms 会盖掉「第一句」的尾巴：不挪
  const talk = planBeatSnap(p, [1900], 450)
  assert(!talk.moves.length && /切到字/.test(talk.skipped[0]!.reason), `会切到字时不挪：${JSON.stringify(talk.skipped)}`)
  // 有转场：不挪
  p.timeline.storyline[0]!.fx = { ...DEFAULT_CLIP_FX, transitionOut: { type: 'cross_dissolve', durationMs: 300 } }
  assert(/转场/.test(planBeatSnap(p, [2400], 150).skipped[0]!.reason), '有转场跳过')
  // 拍子映射到时间线：音乐从素材 1000ms 开始放在时间线 0
  const tl = beatsOnTimeline(clip({ id: 'm', assetId: 'M', startMs: 0, durationMs: 5000, inMs: 1000, outMs: 6000 }), [500, 1500, 3000, 7000])
  assert(tl.join(',') === '500,2000', `beatsOnTimeline ${tl}`)
}

/** 工具层（内存工程）：speed_ramp、ken_burns、voice_enhance、snap_cuts_to_beats 的接线和报错。 */
async function toolLayerTests(): Promise<void> {
  const { store } = await import('../core')
  const { runCraft } = await import('../craft')
  const saved = { project: store.project, path: store.projectPath }
  const call = async (name: string, args: Record<string, unknown>) => (await runCraft(name, args, 'ai')) as unknown as Record<string, unknown> & { warnings?: string[] }
  const fails = async (name: string, args: Record<string, unknown>) => {
    try {
      await runCraft(name, args, 'ai')
    } catch (e) {
      return String(e)
    }
    return ''
  }
  try {
    const p = baseProject()
    p.timeline.storyline = [
      clip({ id: 'k1', assetId: 'A', startMs: 0, durationMs: 4000, inMs: 0, outMs: 4000 }),
      clip({ id: 'k2', assetId: 'A', startMs: 4000, durationMs: 6000, inMs: 5000, outMs: 11000 })
    ]
    p.timeline.overlays = [clip({ id: 'late', assetId: 'A', kind: 'footage', startMs: 10000, durationMs: 1000, inMs: 0, outMs: 1000 })]
    store.project = p
    store.projectPath = null

    const r = await call('speed_ramp', { clipId: 'k2', points: JSON.stringify([{ atMs: 5000, rate: 1 }, { atMs: 7000, rate: 3 }, { atMs: 9000, rate: 1 }]) })
    const story = p.timeline.storyline
    assert(story[0]!.id === 'k1' && story[1]!.id === 'k2' && story.length >= 4 && story.length <= 9, `故事线切成恒速段：${story.map((c) => `${c.id}@${c.fx?.speed}`)}`)
    assert(r.warnings?.some((w) => /恒速子片段近似/.test(w)) && r.warnings?.some((w) => /声音会跟着变速/.test(w)), `分段近似 + 声音提醒：${r.warnings}`)
    const end = story.at(-1)!.startMs + story.at(-1)!.durationMs
    const late = p.timeline.overlays[0]!
    assert(end < 10000 && near(late.startMs, end, 2), `后面的叠加层跟着平移：结尾 ${end}，叠加层 ${late.startMs}`)
    assert(Array.isArray(r.segments), '返回 segments')
    assert(/只作用于故事线/.test(await fails('speed_ramp', { clipId: 'late', points: [{ atMs: 10000, rate: 2 }] })), 'speed_ramp 叠加层报错')
    assert(/points/.test(await fails('speed_ramp', { clipId: 'k1', points: [] })), '空 points 报错')

    const kb = await call('ken_burns', { clipId: 'k1', to: { scale: 1.2 } })
    const k1 = p.timeline.storyline[0]!
    assert(k1.fx?.keys?.scale?.length === 2 && k1.fx.keys.scale[1]!.value === 1.2 && /缓推/.test(String(kb.summary)), `ken_burns 写关键帧：${JSON.stringify(k1.fx?.keys)}`)
    assert(near(sampleKeys(k1.fx!.keys!.scale, 0.5, 1), 1.1, 0.001), 'ease_in_out 中点 1.1')

    const v = await call('voice_enhance', { clipId: 'all' })
    assert(p.timeline.storyline.every((c) => c.fx?.voice?.preset === 'podcast') && v.warnings?.some((w) => /预览听不出/.test(w)), `voice_enhance all：${v.warnings}`)
    await call('voice_enhance', { clipId: 'k1', preset: 'off' })
    assert(p.timeline.storyline[0]!.fx?.voice == null, 'preset off 关闭')
    assert(/需要 clipId/.test(await fails('voice_enhance', {})), '不传 clipId 报错')

    assert(/没有背景音乐/.test(await fails('snap_cuts_to_beats', {})), '没有音乐时报错')
    p.timeline.audio = [clip({ id: 'mus', assetId: 'M', role: 'music', startMs: 0, durationMs: 9000, inMs: 0, outMs: 9000, volume: 0.3 })]
    assert(/没有节拍数据/.test(await fails('snap_cuts_to_beats', {})), '没有节拍时报错')
    // 切点 4000 附近有拍子 4080，两侧设成静音
    p.assets[0]!.index = { ...p.assets[0]!.index!, silence: [{ startMs: 3800, endMs: 4200 }, { startMs: 4900, endMs: 5200 }], speech: [] }
    p.assets[1]!.index!.beats = [4080, 8000]
    const sn = await call('snap_cuts_to_beats', { toleranceMs: 150 })
    const moves = sn.moves as { atMs: number; toMs: number; deltaMs: number }[]
    assert(moves.length === 1 && moves[0]!.atMs === 4000 && moves[0]!.deltaMs === 80, `snap 工具：${JSON.stringify(sn)}`)
    assert(p.timeline.storyline[0]!.outMs === 4080 && p.timeline.storyline[1]!.inMs === 5080, '工程已更新')
  } finally {
    store.project = saved.project
    store.projectPath = saved.path
  }
}

/** render_preview：真实 ffmpeg 渲染一段低清预览（带人声增强），检查尺寸、时长、不进导出目录。 */
async function renderPreviewTests(ffmpeg: string): Promise<void> {
  const { store } = await import('../core')
  const { runCraft } = await import('../craft')
  const dir = await mkdtemp(join(tmpdir(), 'cs-preview-test-'))
  const saved = { project: store.project, path: store.projectPath }
  try {
    const src = join(dir, 'talk.mp4')
    const r = await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:d=8:r=25', '-f', 'lavfi', '-i', 'sine=f=300:d=8', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src])
    assert(r.code === 0, `生成测试素材失败 ${r.stderr}`)
    const p = baseProject()
    p.assets[0] = { ...p.assets[0]!, path: src, durationMs: 8000, width: 640, height: 360 }
    p.timeline.storyline = [
      clip({ id: 'p1', assetId: 'A', startMs: 0, durationMs: 4000, inMs: 0, outMs: 4000, fx: { ...DEFAULT_CLIP_FX, voice: { preset: 'podcast' } } }),
      clip({ id: 'p2', assetId: 'A', startMs: 4000, durationMs: 4000, inMs: 4000, outMs: 8000 })
    ]
    p.timeline.subtitles = []
    store.project = p
    store.projectPath = dir
    const before = JSON.stringify(p.timeline)
    const out = (await runCraft('render_preview', { startMs: 3000, endMs: 6000, width: 320 }, 'ai')) as unknown as { file: string; width: number; height: number; startMs: number; endMs: number }
    assert(out.file.startsWith(join(tmpdir(), 'cutstudio-preview')) && !out.file.includes(join(dir, 'export')), `写到临时目录：${out.file}`)
    assert(out.width === 320 && out.height === 180, `尺寸 ${out.width}×${out.height}`)
    assert((await stat(out.file)).size > 1000, '文件非空')
    const probe = await findFfprobe(ffmpeg)
    if (probe) {
      const pr = await runFfmpeg(probe, ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_type', '-of', 'json', out.file])
      const info = JSON.parse(pr.stdout.toString()) as { format: { duration: string }; streams: { codec_type: string; width?: number }[] }
      assert(near(Number(info.format.duration), 3, 0.2), `预览时长 ${info.format.duration}`)
      assert(info.streams.some((s) => s.codec_type === 'audio') && info.streams.find((s) => s.codec_type === 'video')?.width === 320, `音视频流 ${JSON.stringify(info.streams)}`)
    }
    assert(JSON.stringify(p.timeline) === before && !p.renderQueue?.length, '不改工程、不进渲染队列')
    const long = (await runCraft('render_preview', { startMs: 0, endMs: 60000, width: 160 }, 'ai')) as unknown as { endMs: number; file: string }
    assert(long.endMs === 8000, `结尾夹到成片长度 ${long.endMs}`)
    await rm(join(out.file, '..'), { recursive: true, force: true })
    await rm(join(long.file, '..'), { recursive: true, force: true })
  } finally {
    store.project = saved.project
    store.projectPath = saved.path
    await rm(dir, { recursive: true, force: true })
  }
}

export async function toolsTests(ffmpeg: string | null): Promise<void> {
  cliptimeTests()
  rampTests()
  kenBurnsTests()
  voiceTests()
  beatSnapTests()
  await toolLayerTests()
  if (ffmpeg) {
    await voiceFfmpegTests(ffmpeg)
    await renderPreviewTests(ffmpeg)
  }
  console.log('phase-2 tool tests ok')
}
