/**
 * 1.3 界面相关的后端单测：故事线重排、多步撤销 / 历史、字幕样式可撤销、导出进度解析、区间导出和 SRT、时间线吸附。由 verify.ts 调用。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapBlock, snapCandidates, snapMs, storylineOrderAfterDrag, tickStepMs } from '../../shared/tlsnap'
import { type Project, type TimelineClip, DEFAULT_PROJECT_SETTINGS, DEFAULT_SUBTITLE_STYLE, emptyTimeline } from '../../shared/types'
import { findFfprobe, runFfmpeg } from './ffmpeg'
import { parseProgress, renderTimeline } from './export'

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`[ui] ${msg}`)
}

const near = (a: number, b: number, tol = 1) => Math.abs(a - b) <= tol

function clip(partial: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'assetId'>): TimelineClip {
  return { startMs: 0, durationMs: 2000, inMs: 0, outMs: 2000, volume: 1, source: 'human', ...partial }
}

function baseProject(): Project {
  return {
    version: 1,
    name: 'ui',
    createdAt: '',
    updatedAt: '',
    settings: { ...DEFAULT_PROJECT_SETTINGS },
    subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
    assets: [{ id: 'A', name: 'a.mp4', path: '/a', kind: 'video', durationMs: 20000, width: 1920, height: 1080, fps: 30, importedAt: '' }],
    timeline: emptyTimeline(),
    transcript: [],
    markers: [],
    snapshots: [],
    review: []
  }
}

function snapTests(): void {
  const p = baseProject()
  p.timeline.storyline = [
    clip({ id: 'a', assetId: 'A', startMs: 0, durationMs: 3000 }),
    clip({ id: 'b', assetId: 'A', startMs: 3000, durationMs: 2000 }),
    clip({ id: 'c', assetId: 'A', startMs: 5000, durationMs: 4000 })
  ]
  p.timeline.subtitles = [{ id: 's', startMs: 1200, endMs: 2500, text: '字', source: 'human' }]
  const cands = snapCandidates(p.timeline, { playheadMs: 7777, markers: [{ id: 'm', atMs: 6400, label: '章' }], excludeIds: ['b'] })
  assert(cands.includes(7777) && cands.includes(6400) && cands.includes(1200) && cands.includes(9000), `候选点 ${cands}`)
  assert(cands.includes(3000) && cands.includes(5000), '排除 b 后仍有相邻片段的边')
  assert(snapMs(6420, cands, 50).ms === 6400 && snapMs(6500, cands, 50).snapped === null, 'snapMs 阈值')
  const blk = snapBlock(7700, 1000, cands, 100)
  assert(blk.startMs === 7777 && blk.guide === 7777, `块首吸附 ${JSON.stringify(blk)}`)
  const blk2 = snapBlock(8030, 1000, [9000], 50)
  assert(blk2.startMs === 8000 && blk2.guide === 9000, `块尾吸附 ${JSON.stringify(blk2)}`)
  assert(tickStepMs(64) === 2000 && tickStepMs(400) === 250 && tickStepMs(8) === 10000, `刻度 ${tickStepMs(64)} ${tickStepMs(400)} ${tickStepMs(8)}`)
  assert(storylineOrderAfterDrag(p.timeline.storyline, 'a', 8000).join() === 'b,c,a', '拖到末尾')
  assert(storylineOrderAfterDrag(p.timeline.storyline, 'c', 100).join() === 'c,a,b', '拖到开头')
  assert(storylineOrderAfterDrag(p.timeline.storyline, 'a', 3500).join() === 'a,b,c', '原位不动')
}

function progressTests(): void {
  assert(parseProgress('frame=10\nout_time_us=1500000\nout_time_ms=1500000\nprogress=continue\n') === 1500, 'out_time_us 转毫秒')
  assert(parseProgress('frame=10\nout_time_us=2000000\nprogress=end\n') === Infinity, 'progress=end')
  assert(parseProgress('bitrate=100kbits/s\n') === null, '没有进度字段')
  assert(parseProgress('out_time_us=N/A\n') === null, 'N/A 忽略')
}

/** 内存工程上的 store：reorder_storyline、undoSteps / redoSteps、history、字幕样式和标记可撤销。 */
async function storeTests(): Promise<void> {
  const { store } = await import('../core')
  const { runAction } = await import('../actions')
  const saved = { project: store.project, path: store.projectPath }
  try {
    const p = baseProject()
    store.project = p
    store.projectPath = null
    await store.applyOps(
      [
        { op: 'add_clip', assetId: 'A', inMs: 0, outMs: 3000 },
        { op: 'add_clip', assetId: 'A', inMs: 3000, outMs: 5000 },
        { op: 'add_clip', assetId: 'A', inMs: 5000, outMs: 9000 }
      ],
      'human',
      '加三段'
    )
    const [a, b, c] = p.timeline.storyline.map((x) => x.id)
    await store.applyOps([{ op: 'reorder_storyline', clipIds: [c!, a!, b!] }], 'human', '重排')
    const order = store.requireProject().timeline.storyline
    assert(order.map((x) => x.id).join() === [c, a, b].join(), `重排生效 ${order.map((x) => x.id)}`)
    assert(order[0]!.startMs === 0 && order[1]!.startMs === 4000 && order[2]!.startMs === 7000, `重排后重新打包 ${order.map((x) => x.startMs)}`)

    await runAction('set_subtitle_style', { fontSize: 80 }, 'human')
    await runAction('add_marker', { atMs: 1000, label: '标记' }, 'human')
    const h = store.history()
    assert(h.undo[0] && h.undo.length >= 4 && h.undo.includes('重排') && h.undo.includes('加三段'), `history ${JSON.stringify(h)}`)
    assert(store.requireProject().subtitleStyle.fontSize === 80 && store.requireProject().markers.length === 1, '样式和标记已改')

    const undone = await store.undoSteps(3)
    assert(undone.length === 3 && undone[2] === '重排', `一次撤三步 ${undone}`)
    const q = store.requireProject()
    assert(q.subtitleStyle.fontSize === DEFAULT_SUBTITLE_STYLE.fontSize && q.markers.length === 0, '字幕样式、标记跟着撤销')
    assert(q.timeline.storyline.map((x) => x.id).join() === [a, b, c].join(), '时间线回到重排前')
    assert(store.history().redo.length === 3, `redo 三步 ${JSON.stringify(store.history())}`)
    const redone = await store.redoSteps(1)
    assert(redone[0] === '重排' && store.requireProject().timeline.storyline[0]!.id === c, `重做一步 ${redone}`)
    assert(store.history().redo.length === 2, 'redo 剩两步')
  } finally {
    store.project = saved.project
    store.projectPath = saved.path
  }
}

/** 真实 ffmpeg：区间导出时长、进度回调、SRT 另存并平移。 */
async function exportTests(ffmpeg: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'cs-ui-export-'))
  try {
    const src = join(dir, 'src.mp4')
    const r = await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:d=6:r=25', '-f', 'lavfi', '-i', 'sine=f=300:d=6', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', src])
    assert(r.code === 0, `生成素材失败 ${r.stderr}`)
    const p = baseProject()
    p.settings = { ...p.settings, width: 320, height: 180 }
    p.assets[0] = { ...p.assets[0]!, path: src, durationMs: 6000, width: 320, height: 180, fps: 25 }
    p.timeline.storyline = [clip({ id: 'x', assetId: 'A', startMs: 0, durationMs: 6000, inMs: 0, outMs: 6000 })]
    p.timeline.subtitles = [
      { id: 's1', startMs: 500, endMs: 1500, text: '范围外', source: 'human' },
      { id: 's2', startMs: 2500, endMs: 3500, text: '范围内', source: 'human' },
      { id: 's3', startMs: 4800, endMs: 5600, text: '跨出点', source: 'human' }
    ]
    const out = join(dir, 'range.mp4')
    const ratios: number[] = []
    await renderTimeline(p, out, '1080p', {
      size: { width: 320, height: 180 },
      encode: ['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p'],
      rangeMs: { startMs: 2000, endMs: 5000 },
      subtitles: 'srt',
      onProgress: (x) => ratios.push(x)
    })
    const probe = await findFfprobe(ffmpeg)
    const pr = await runFfmpeg(probe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out])
    assert(near(Number(pr.stdout.toString().trim()), 3, 0.15), `区间时长 ${pr.stdout.toString().trim()}`)
    assert(ratios.length > 0 && ratios.at(-1)! > 0.95 && ratios.every((x) => x >= 0 && x <= 1), `进度 ${ratios.slice(-3)}`)
    const srt = await readFile(join(dir, 'range.srt'), 'utf8')
    assert(!srt.includes('范围外') && srt.includes('00:00:00,500 --> 00:00:01,500\n范围内') && srt.includes('00:00:02,800 --> 00:00:03,000\n跨出点'), `SRT 平移 ${srt}`)

    const ctrl = new AbortController()
    const pending = renderTimeline(p, join(dir, 'cancel.mp4'), '1080p', { signal: ctrl.signal, onProgress: () => ctrl.abort() })
    let msg = ''
    try {
      await pending
    } catch (e) {
      msg = String(e)
    }
    assert(/取消/.test(msg), `取消导出 ${msg}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export async function uiTests(ffmpeg: string | null): Promise<void> {
  snapTests()
  progressTests()
  await storeTests()
  if (ffmpeg) await exportTests(ffmpeg)
  console.log('ui backend tests ok')
}
