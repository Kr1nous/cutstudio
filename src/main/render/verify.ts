import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fxAt, sampleKeys } from '../../shared/anim'
import { beatScaleKeys, denoiseFfmpeg, downsamplePeaks, envelopeAt, onsetTimes, volumeAt } from '../../shared/audio'
import { packStorylineClips, dissolveOverlapMs, layersAt, opacityAt, overlayLanes, aspectFromSize, applySourceFrame, sourceRangeToTimeline, sourceTimeMs, timelineTimeMs } from '../../shared/compose'
import { cubeFileText, makeLut, simpleEffectFfmpeg, xfadeName } from '../../shared/effects'
import { keyFfmpeg, stabilizeFfmpeg } from '../../shared/key'
import {
  type MediaAsset,
  type Project,
  type TimelineClip,
  DEFAULT_CLIP_FX,
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_SUBTITLE_STYLE,
  DEFAULT_TEXT_STYLE,
  emptyTimeline
} from '../../shared/types'
import { findFfmpeg, findFfprobe, runFfmpeg } from './ffmpeg'
import { analyzeMediaFile } from './wave'
import { detectBeats, detectPauses, parseEbur128, readAudioFrames, segmentSpeech } from '../analysis/audio'
import { cleanScenes, detectScenes, parseShowinfoTime } from '../analysis/scenes'
import { cuesFromVerboseJson, parseWhisperJson, tokensToWords } from '../analysis/transcribe'
import { buildCaptions } from '../../shared/captions'
import { reviewTimeline } from '../review/check'
import { coverScale, posForSubject, reframeTrack } from '../../shared/reframe'
import { LookAccumulator, enhanceFromLook, matchLook, type LookStats } from '../../shared/look'
import { colorFfmpeg, warmthGains, warmthKelvin } from '../../shared/fx'
import { applySourceCuts, detectRetakes, resolveSpans, fillerWordRanges, planCutSentences, textSimilarity, tightenPauses, transcriptDoc } from '../../shared/textcut'
import { layerBox, maskFfmpeg } from '../../shared/mask'
import { filterHallucinations, refineWordTimings } from '../../shared/wordalign'
import { fixTranscript, transcriptionPrompt } from '../../shared/transcriptfix'
import { lookMismatch } from '../review/visualcheck'
import { estimateTextWidthEm, maxCharsForStyle, subtitleAvailablePx, subtitleLineWidthPx, wrapSubtitleText } from '../../shared/subtitle'
import { FADE_IN_KEYS } from '../../shared/text'
import { assDocument, buildGraph } from './graph'
import { evenHalf, exportExt, normalizePreset, renderTimeline, videoEncodeArgs, writeProxyFile } from './export'
import { renderFrame } from './frame'
import { brollTests } from './verify-broll'
import { toolsTests } from './verify-tools'
import { uiTests } from './verify-ui'

function clip(partial: Partial<TimelineClip> & Pick<TimelineClip, 'id' | 'assetId'>): TimelineClip {
  return {
    startMs: 0,
    durationMs: 2000,
    inMs: 0,
    outMs: 2000,
    volume: 1,
    source: 'human',
    ...partial
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg)
}

function unitTests(): void {
  const a = clip({
    id: 'a',
    assetId: 'red',
    durationMs: 2000,
    fx: { transitionOut: { type: 'cross_dissolve', durationMs: 400 } }
  })
  const b = clip({ id: 'b', assetId: 'blue', durationMs: 2000 })
  const clips = [a, b]
  packStorylineClips(clips)
  assert(a.startMs === 0, 'a starts at 0')
  assert(b.startMs === 1600, `dissolve overlap packs b at 1600, got ${b.startMs}`)

  const faded = clip({ id: 'f', assetId: 'red', durationMs: 1000, fx: { opacity: 1, fadeOutMs: 1000 } })
  assert(Math.abs(opacityAt(faded, 0) - 1) < 0.01, 'fade start')
  assert(Math.abs(opacityAt(faded, 500) - 0.5) < 0.02, 'fade mid')
  assert(opacityAt(faded, 999) < 0.05, 'fade end')

  const tl = emptyTimeline()
  tl.storyline = clips
  const mid = layersAt(tl, 1800)
  assert(mid.length === 2, `dissolve should expose two layers, got ${mid.length}`)
  assert(mid[0].opacity > 0 && mid[0].opacity < 1, 'outgoing dissolve opacity')
  assert(mid[1].opacity > 0 && mid[1].opacity < 1, 'incoming dissolve opacity')

  const ov = [
    clip({ id: 'o1', assetId: 'a', startMs: 0, durationMs: 2000 }),
    clip({ id: 'o2', assetId: 'b', startMs: 500, durationMs: 2000 }),
    clip({ id: 'o3', assetId: 'c', startMs: 3000, durationMs: 500 })
  ]
  const lanes = overlayLanes(ov)
  assert(lanes[0] === 0 && lanes[1] === 1 && lanes[2] === 0, `lanes ${lanes.join(',')}`)
  const stacked = emptyTimeline()
  stacked.storyline = [clip({ id: 'base', assetId: 'red', durationMs: 2000 })]
  stacked.overlays = [
    clip({ id: 'top', assetId: 'blue', durationMs: 2000, blend: 'screen' }),
    clip({ id: 'adj', assetId: '', durationMs: 2000, kind: 'adjustment', fx: { filter: 'bw' } })
  ]
  const at = layersAt(stacked, 400)
  assert(at.length === 3, `stack should be base+layer+adj, got ${at.length}`)
  assert(at[1].blend === 'screen' && at[2].kind === 'adjustment', 'blend/adjustment in compose')
  const mf = maskFfmpeg({
    ...DEFAULT_CLIP_FX,
    masks: [{ id: 'mask1', shape: 'ellipse', mode: 'add', x: 0.2, y: 0.1, w: 0.6, h: 0.8, feather: 0.04 }]
  })
  assert(mf && mf.includes('geq'), 'mask ffmpeg geq')
  const fadeKeys = [
    { t: 0, value: 0, ease: 'linear' as const },
    { t: 0.5, value: 1, ease: 'linear' as const },
    { t: 1, value: 0, ease: 'linear' as const }
  ]
  assert(Math.abs(sampleKeys(fadeKeys, 0, 1) - 0) < 0.001, 'key 0')
  assert(Math.abs(sampleKeys(fadeKeys, 0.5, 1) - 1) < 0.001, 'key mid')
  assert(Math.abs(sampleKeys(fadeKeys, 1, 1) - 0) < 0.001, 'key end')
  assert(Math.abs(sampleKeys(fadeKeys, 0.25, 1) - 0.5) < 0.02, 'key quarter')
  const fw = clip({
    id: 'fw',
    assetId: 'red',
    durationMs: 2000,
    fx: { transitionOut: { type: 'fade_white', durationMs: 400 } }
  })
  const fw2 = clip({ id: 'fw2', assetId: 'blue', durationMs: 2000 })
  const packedWhite = [fw, fw2]
  packStorylineClips(packedWhite)
  assert(dissolveOverlapMs(fw) === 400, 'fade_white overlap ms')
  assert(fw2.startMs === 1600, `fade_white packs at 1600, got ${fw2.startMs}`)
  assert(xfadeName('fade_white') === 'fadewhite' && xfadeName('push') === 'slideright', 'xfade names')
  assert(xfadeName('cross_dissolve') === 'fadeslow', 'soft dissolve uses fadeslow')
  const blurFx = {
    ...DEFAULT_CLIP_FX,
    effects: [{ id: 'e', type: 'blur' as const, enabled: true, params: { amount: 6 } }]
  }
  assert(simpleEffectFfmpeg(blurFx).some((s) => s.includes('gblur')), 'blur ffmpeg gblur')
  const stabFx = { ...DEFAULT_CLIP_FX, stabilize: { enabled: true, amount: 0.6 } }
  assert(stabilizeFfmpeg(stabFx).some((s) => s.includes('deshake')), 'stabilize deshake')
  const keyedFx = {
    ...DEFAULT_CLIP_FX,
    key: { color: '#00ff00', tolerance: 0.3, spill: 0, edge: 0.08 }
  }
  assert(keyFfmpeg(keyedFx).some((s) => s.includes('colorkey')), 'key colorkey')
  assert(Math.abs(envelopeAt([0, 1, 0], 1000, 500) - 1) < 0.01, 'envelope mid')
  assert(downsamplePeaks([0, 2, 0, 2], 2).length === 2, 'downsample bins')
  const volClip = clip({
    id: 'vol',
    assetId: 'red',
    durationMs: 1000,
    volume: 1,
    fx: {
      keys: {
        volume: [
          { t: 0, value: 0.2, ease: 'linear' },
          { t: 1, value: 1, ease: 'linear' }
        ]
      }
    }
  })
  assert(Math.abs(volumeAt(volClip, 0) - 0.2) < 0.02, 'volume key start')
  assert(Math.abs(volumeAt(volClip, 1000) - 1) < 0.02, 'volume key end')
  const denFx = { ...DEFAULT_CLIP_FX, denoise: { enabled: true, amount: 0.5 } }
  assert(denoiseFfmpeg(denFx).some((s) => s.includes('afftdn')), 'denoise afftdn')
  const beats = beatScaleKeys([0, 500], clip({ id: 'a', assetId: 'red', durationMs: 1000 }), clip({ id: 'v', assetId: 'red', durationMs: 1000, fx: { scale: 0.4 } }), 0.5, 0.4)
  assert(beats.some((k) => k.value > 0.5), 'beat scale pulses')
  assert(normalizePreset('nope') === '1080p' && normalizePreset('alpha') === 'alpha', 'export preset')
  assert(exportExt('alpha') === 'mov' && exportExt('1080p') === 'mp4', 'export ext')
  assert(evenHalf(640) === 320 && evenHalf(360) === 180, 'proxy half size')
  assert(videoEncodeArgs('1080p').includes('libx264'), 'h264 args')
  assert(videoEncodeArgs('alpha').some((s) => s.includes('yuva') || s === '4444'), 'alpha args')
  assert(videoEncodeArgs('prores').includes('yuv422p10le'), 'prores args')
  assert(aspectFromSize(1080, 1920) === '9:16' && aspectFromSize(1920, 1080) === '16:9', 'aspect from size')
  const st = { ...DEFAULT_PROJECT_SETTINGS }
  assert(applySourceFrame(st, 1080, 1920) && st.width === 1080 && st.height === 1920, 'adopt source frame')
  console.log('unit: pack / opacity / dissolve / overlay lanes / mask / keys / effects / key-stab / audio / export ok')
}

function dummyProject(red: string, blue: string): Project {
  const assets: MediaAsset[] = [
    {
      id: 'red',
      name: 'red.mp4',
      path: red,
      kind: 'video',
      durationMs: 3000,
      width: 640,
      height: 360,
      fps: 30,
      importedAt: new Date().toISOString()
    },
    {
      id: 'blue',
      name: 'blue.mp4',
      path: blue,
      kind: 'video',
      durationMs: 2000,
      width: 640,
      height: 360,
      fps: 30,
      importedAt: new Date().toISOString()
    }
  ]
  const storyline: TimelineClip[] = [
    clip({
      id: 'c1',
      assetId: 'red',
      inMs: 0,
      outMs: 3000,
      durationMs: 2000,
      fx: {
        opacity: 0.5,
        filter: 'vivid',
        speed: 1.5,
        transitionOut: { type: 'cross_dissolve', durationMs: 400 }
      }
    }),
    clip({
      id: 'c2',
      assetId: 'blue',
      inMs: 0,
      outMs: 2000,
      durationMs: 2000,
      fx: { fadeOutMs: 800, transitionOut: { type: 'fade_black', durationMs: 800 } }
    })
  ]
  packStorylineClips(storyline)
  return {
    version: 1,
    name: 'verify',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    settings: { ...DEFAULT_PROJECT_SETTINGS, width: 640, height: 360, fps: 30 },
    subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
    assets,
    timeline: { ...emptyTimeline(), storyline },
    transcript: [],
    markers: [],
    snapshots: [],
    review: []
  }
}

async function ffmpegTests(): Promise<void> {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) throw new Error('没有 ffmpeg，无法做导出对照')
  const ffprobe = await findFfprobe(ffmpeg)
  const dir = await mkdtemp(join(tmpdir(), 'cut-compose-'))
  try {
    const red = join(dir, 'red.mp4')
    const blue = join(dir, 'blue.mp4')
    const mk = async (path: string, color: string, d: number) => {
      const r = await runFfmpeg(ffmpeg, [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${color}:s=640x360:d=${d}:r=30`,
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=${color === 'red' ? 440 : 220}:duration=${d}`,
        '-shortest',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        path
      ])
      if (r.code !== 0) throw new Error(r.stderr.slice(-400))
    }
    await mk(red, 'red', 3)
    await mk(blue, 'blue', 2)
    const project = dummyProject(red, blue)
    const streams = new Map([
      [red, { hasVideo: true, hasAudio: true }],
      [blue, { hasVideo: true, hasAudio: true }]
    ])
    const graph = buildGraph(project, {
      width: 640,
      height: 360,
      fps: 30,
      alpha: false,
      streams
    })
    assert(graph.filter.includes('eq=saturation=1.35'), 'vivid eq in graph')
    assert(graph.filter.includes('setpts=PTS/1.5'), 'speed in graph')
    assert(graph.filter.includes('colorchannelmixer=aa=0.5'), 'opacity in graph')
    assert(graph.filter.includes('xfade=transition=fadeslow'), 'dissolve in graph')
    assert(graph.filter.includes('fade=t=out') || graph.filter.includes('c=black'), 'fade black in graph')
    console.log('unit: filter graph contains opacity / vivid / speed / dissolve / fade-black')

    const out = join(dir, 'out.mp4')
    await renderTimeline(project, out, '1080p')
    const probe = await runFfmpeg(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=nw=1:nk=1',
      out
    ])
    const dur = Number(probe.stdout.toString().trim())
    // 2.0 + 2.0 - 0.4 dissolve = 3.6s
    assert(dur > 3.3 && dur < 3.9, `expected ~3.6s export, got ${dur}`)

    const sizeProbe = await runFfmpeg(ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0',
      out
    ])
    const [ow, oh] = sizeProbe.stdout.toString().trim().split(',').map(Number)
    const cx = Math.max(0, Math.floor(ow / 2))
    const cy = Math.max(0, Math.floor(oh / 2))
    async function sample(t: number): Promise<[number, number, number]> {
      const r = await runFfmpeg(ffmpeg, [
        '-i',
        out,
        '-ss',
        t.toFixed(2),
        '-vf',
        `format=rgb24,crop=1:1:${cx}:${cy}`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1'
      ])
      if (r.stdout.length < 3) throw new Error(`no pixel at ${t}s (${ow}x${oh}): ${r.stderr.slice(-300)}`)
      return [r.stdout[0], r.stdout[1], r.stdout[2]]
    }
    const [r0, g0, b0] = await sample(0.4)
    assert(r0 > 40 && r0 < 220, `opacity 0.5 red should be mid red, got rgb(${r0},${g0},${b0})`)
    assert(g0 < 80 && b0 < 80, `vivid red should not be gray, got rgb(${r0},${g0},${b0})`)
    const [r1, g1, b1] = await sample(3.5)
    const lum = (r1 + g1 + b1) / 3
    assert(lum < 40, `fade-to-black end should be dark, got rgb(${r1},${g1},${b1}) lum=${lum}`)
    console.log(`ffmpeg: exported ${dur.toFixed(2)}s; mid-red ${r0},${g0},${b0}; fade-black ${r1},${g1},${b1}`)

    const png = await renderFrame(project, 400)
    assert(png[0] === 0x89 && png[1] === 0x50, 'compose frame should be PNG')
    assert(png.length > 200, 'compose frame too small')
    console.log(`ffmpeg: compose frame ${png.length} bytes`)

    // 抽帧叠加字幕（get_frame subtitles）：有字幕时底部区域应出现白字像素，不传选项时没有
    const subProject: Project = {
      ...project,
      subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE, fontSize: 80, position: 'bottom' },
      timeline: { ...project.timeline, subtitles: [{ id: 'sub1', startMs: 0, endMs: 2000, text: '字幕测试一二三', source: 'ai' }] }
    }
    const bottomWhite = async (buf: Buffer) => {
      const tmpDir = await mkdtemp(join(tmpdir(), 'cut-subframe-'))
      try {
        const f = join(tmpDir, 'f.png')
        await writeFile(f, buf)
        const r = await runFfmpeg(ffmpeg, ['-loglevel', 'error', '-i', f, '-vf', 'crop=iw:ih*0.25:0:ih*0.75,format=rgb24', '-f', 'rawvideo', 'pipe:1'])
        let n = 0
        for (let i = 0; i + 2 < r.stdout.length; i += 3) if (r.stdout[i]! > 230 && r.stdout[i + 1]! > 230 && r.stdout[i + 2]! > 230) n++
        return n
      } finally {
        await rm(tmpDir, { recursive: true, force: true })
      }
    }
    const withSubs = await bottomWhite(await renderFrame(subProject, 400, '1080p', { subtitles: true }))
    const noSubs = await bottomWhite(await renderFrame(subProject, 400))
    assert(withSubs > noSubs + 200, `frame subtitles drawn: ${withSubs} vs ${noSubs}`)
    console.log(`ffmpeg: frame subtitles overlay ${withSubs} white px`)

    const layered: Project = {
      ...project,
      timeline: {
        ...emptyTimeline(),
        storyline: [
          clip({
            id: 'base',
            assetId: 'red',
            inMs: 0,
            outMs: 2000,
            durationMs: 2000
          })
        ],
        overlays: [
          clip({
            id: 'top',
            assetId: 'blue',
            inMs: 0,
            outMs: 2000,
            durationMs: 2000,
            blend: 'screen',
            fx: { scale: 1, posX: 0.5, posY: 0.5, opacity: 1 }
          }),
          clip({
            id: 'adj',
            assetId: '',
            inMs: 0,
            outMs: 2000,
            durationMs: 2000,
            kind: 'adjustment',
            fx: { filter: 'bw', opacity: 1 }
          })
        ]
      }
    }
    const g2 = buildGraph(layered, { width: 640, height: 360, fps: 30, alpha: false, streams })
    assert(g2.filter.includes('all_mode=screen'), 'screen blend in graph')
    assert(g2.filter.includes('hue=s=0') || g2.filter.includes('split=2'), 'adjustment in graph')
    const out2 = join(dir, 'layers.mp4')
    await renderTimeline(layered, out2, '1080p')
    const pix = await runFfmpeg(ffmpeg, [
      '-i',
      out2,
      '-ss',
      '0.40',
      '-vf',
      'format=rgb24,crop=1:1:320:180',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ])
    assert(pix.stdout.length >= 3, `layer pixel missing: ${pix.stderr.slice(-300)}`)
    const [lr, lg, lb] = [pix.stdout[0], pix.stdout[1], pix.stdout[2]]
    const spread = Math.max(lr, lg, lb) - Math.min(lr, lg, lb)
    assert(spread < 40, `adjustment desaturate should be gray, got rgb(${lr},${lg},${lb})`)
    console.log(`ffmpeg: screen + adj-bw rgb ${lr},${lg},${lb}`)

    const masked: Project = {
      ...project,
      timeline: {
        ...emptyTimeline(),
        storyline: [clip({ id: 'base', assetId: 'red', inMs: 0, outMs: 2000, durationMs: 2000 })],
        overlays: [
          clip({
            id: 'top',
            assetId: 'blue',
            inMs: 0,
            outMs: 2000,
            durationMs: 2000,
            fx: {
              scale: 1,
              posX: 0.5,
              posY: 0.5,
              opacity: 1,
              masks: [{ id: 'mask1', shape: 'ellipse', mode: 'add', x: 0.2, y: 0.1, w: 0.6, h: 0.8, feather: 0.05 }]
            }
          })
        ]
      }
    }
    const g3 = buildGraph(masked, { width: 640, height: 360, fps: 30, alpha: false, streams })
    assert(g3.filter.includes('geq'), 'ellipse mask in graph')
    const out3 = join(dir, 'mask.mp4')
    await renderTimeline(masked, out3, '1080p')
    async function sampleAt(file: string, px: number, py: number): Promise<[number, number, number]> {
      const r = await runFfmpeg(ffmpeg, [
        '-i',
        file,
        '-ss',
        '0.40',
        '-vf',
        `format=rgb24,crop=1:1:${px}:${py}`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1'
      ])
      if (r.stdout.length < 3) throw new Error(`mask pixel ${px},${py}: ${r.stderr.slice(-300)}`)
      return [r.stdout[0], r.stdout[1], r.stdout[2]]
    }
    const [cr, cg, cb] = await sampleAt(out3, 320, 180)
    const [er, eg, eb] = await sampleAt(out3, 8, 8)
    assert(cb > 80 && cb > cr, `ellipse center should be blue overlay, got rgb(${cr},${cg},${cb})`)
    assert(er > 80 && eb < 80, `ellipse outside should show red below, got rgb(${er},${eg},${eb})`)
    console.log(`ffmpeg: mask center rgb ${cr},${cg},${cb}; corner ${er},${eg},${eb}`)

    const keyed: Project = {
      ...project,
      timeline: {
        ...emptyTimeline(),
        storyline: [
          clip({
            id: 'fade',
            assetId: 'red',
            inMs: 0,
            outMs: 2000,
            durationMs: 2000,
            fx: {
              keys: {
                opacity: [
                  { t: 0, value: 0, ease: 'linear' },
                  { t: 0.5, value: 1, ease: 'linear' },
                  { t: 1, value: 0, ease: 'linear' }
                ]
              }
            }
          })
        ]
      }
    }
    const g4 = buildGraph(keyed, { width: 640, height: 360, fps: 30, alpha: false, streams })
    assert(g4.filter.includes('geq') || g4.filter.includes('alpha'), 'opacity keys in graph')
    const live0 = fxAt(keyed.timeline.storyline[0], 0).opacity
    const liveM = fxAt(keyed.timeline.storyline[0], 1000).opacity
    const live1 = fxAt(keyed.timeline.storyline[0], 2000 - 1).opacity
    assert(live0 < 0.05 && liveM > 0.95 && live1 < 0.05, `fxAt opacity 0-1-0 got ${live0},${liveM},${live1}`)
    const out4 = join(dir, 'keys.mp4')
    await renderTimeline(keyed, out4, '1080p')
    const start = await runFfmpeg(ffmpeg, [
      '-i',
      out4,
      '-ss',
      '0.20',
      '-vf',
      'format=rgb24,crop=1:1:320:180',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ])
    const k0 = start.stdout[0]
    const mid = await runFfmpeg(ffmpeg, [
      '-i',
      out4,
      '-ss',
      '1.00',
      '-vf',
      'format=rgb24,crop=1:1:320:180',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ])
    const end = await runFfmpeg(ffmpeg, [
      '-i',
      out4,
      '-ss',
      '1.90',
      '-vf',
      'format=rgb24,crop=1:1:320:180',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ])
    const rMid = mid.stdout[0]
    const rEnd = end.stdout[0]
    assert(k0 < 80, `opacity rise at 0.4s should be dim, got R=${k0}`)
    assert(rMid > 200, `opacity peak at 1s should be bright red, got R=${rMid}`)
    assert(rEnd < 80, `opacity fall at 1.9s should be dim, got R=${rEnd}`)
    console.log(`ffmpeg: opacity 0→1→0 R ${k0} → ${rMid} → ${rEnd}`)

    const title: Project = {
      ...project,
      timeline: {
        ...emptyTimeline(),
        overlays: [
          clip({
            id: 'title',
            assetId: '',
            inMs: 0,
            outMs: 3000,
            durationMs: 3000,
            kind: 'text',
            textAnim: 'fade',
            text: {
              text: '标题',
              font: 'PingFang SC',
              fontSize: 72,
              color: '#ffffff',
              stroke: '#000000',
              strokeWidth: 3,
              align: 'center'
            },
            fx: { posX: 0.5, posY: 0.45, keys: { opacity: FADE_IN_KEYS } }
          })
        ]
      }
    }
    const out5 = join(dir, 'title.mp4')
    await renderTimeline(title, out5, '1080p')
    const tprobe = await runFfmpeg(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=nw=1:nk=1',
      out5
    ])
    const tdur = Number(tprobe.stdout.toString().trim())
    assert(tdur > 2.7 && tdur < 3.4, `title should be ~3s, got ${tdur}`)
    const tmid = await runFfmpeg(ffmpeg, [
      '-i',
      out5,
      '-ss',
      '1.50',
      '-vf',
      'format=rgb24,crop=80:40:280:160',
      '-frames:v',
      '1',
      '-f',
      'rawvideo',
      '-pix_fmt',
      'rgb24',
      'pipe:1'
    ])
    let sum = 0
    for (let i = 0; i < tmid.stdout.length; i++) sum += tmid.stdout[i]
    const avg = tmid.stdout.length ? sum / tmid.stdout.length : 0
    assert(avg > 10, `fade title at 1.5s should be visible, avg=${avg}`)
    console.log(`ffmpeg: animate_text fade ${tdur.toFixed(2)}s, center avg ${avg.toFixed(0)}`)

    const split = join(dir, 'split.mp4')
    const hs = await runFfmpeg(ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=320x360:d=2:r=30',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x360:d=2:r=30',
      '-filter_complex',
      '[0:v][1:v]hstack=inputs=2,format=yuv420p',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-an',
      split
    ])
    if (hs.code !== 0) throw new Error(`split source: ${hs.stderr.slice(-400)}`)
    const splitProject: Project = {
      ...project,
      assets: [
        ...project.assets,
        {
          id: 'split',
          name: 'split.mp4',
          path: split,
          kind: 'video',
          durationMs: 2000,
          width: 640,
          height: 360,
          fps: 30,
          importedAt: new Date().toISOString()
        }
      ],
      timeline: {
        ...emptyTimeline(),
        storyline: [
          clip({
            id: 'blur',
            assetId: 'split',
            inMs: 0,
            outMs: 2000,
            durationMs: 2000,
            fx: {
              effects: [{ id: 'fx1', type: 'blur', enabled: true, params: { amount: 16 } }]
            }
          })
        ]
      }
    }
    const gBlur = buildGraph(splitProject, { width: 640, height: 360, fps: 30, alpha: false, streams: new Map([[split, { hasVideo: true, hasAudio: false }]]) })
    assert(gBlur.filter.includes('gblur'), 'blur in graph')
    const outBlur = join(dir, 'blur.mp4')
    await renderTimeline(splitProject, outBlur, '1080p')
    async function sampleFile(file: string, px: number, py: number, t = 0.4): Promise<[number, number, number]> {
      const r = await runFfmpeg(ffmpeg, [
        '-i',
        file,
        '-ss',
        t.toFixed(2),
        '-vf',
        `format=rgb24,crop=1:1:${px}:${py}`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1'
      ])
      if (r.stdout.length < 3) throw new Error(`pixel ${file} ${px},${py}: ${r.stderr.slice(-300)}`)
      return [r.stdout[0], r.stdout[1], r.stdout[2]]
    }
    async function samplePng(buf: Buffer, px: number, py: number): Promise<[number, number, number]> {
      const tmp = join(dir, `frame-${px}-${py}.png`)
      await writeFile(tmp, buf)
      const r = await runFfmpeg(ffmpeg, [
        '-i',
        tmp,
        '-vf',
        `format=rgb24,crop=1:1:${px}:${py}`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1'
      ])
      if (r.stdout.length < 3) throw new Error(`png pixel ${px},${py}: ${r.stderr.slice(-300)}`)
      return [r.stdout[0], r.stdout[1], r.stdout[2]]
    }
    const [br] = await sampleFile(outBlur, 320, 180)
    const [leftR] = await sampleFile(outBlur, 8, 180)
    const [rightR] = await sampleFile(outBlur, 632, 180)
    assert(br > 40 && br < 220, `blur seam should mix, got R=${br}`)
    assert(leftR > 160, `blur far-left should stay red, got R=${leftR}`)
    assert(rightR < 80, `blur far-right should stay dark, got R=${rightR}`)
    const blurFrame = await renderFrame(splitProject, 400)
    const [pr] = await samplePng(blurFrame, 320, 180)
    assert(Math.abs(pr - br) < 40, `blur preview vs export seam R ${pr} vs ${br}`)
    console.log(`ffmpeg: blur seam R ${br} (preview ${pr}); left ${leftR} right ${rightR}`)

    const cube = join(dir, 'green.cube')
    await writeFile(cube, cubeFileText(makeLut('green')), 'utf8')
    const lutProject: Project = {
      ...project,
      timeline: {
        ...emptyTimeline(),
        storyline: [
          clip({
            id: 'lut',
            assetId: 'red',
            inMs: 0,
            outMs: 2000,
            durationMs: 2000,
            fx: {
              effects: [{ id: 'lut1', type: 'lut', enabled: true, params: { name: 'green', path: cube } }]
            }
          })
        ]
      }
    }
    const gLut = buildGraph(lutProject, { width: 640, height: 360, fps: 30, alpha: false, streams })
    assert(gLut.filter.includes('lut3d'), 'lut3d in graph')
    const outLut = join(dir, 'lut.mp4')
    await renderTimeline(lutProject, outLut, '1080p')
    const [lutR, lutG, lutB] = await sampleFile(outLut, 320, 180)
    assert(lutG > 150 && lutG > lutR, `green LUT should swap red→green, got rgb(${lutR},${lutG},${lutB})`)
    assert(lutR < 80, `green LUT red channel should drop, got rgb(${lutR},${lutG},${lutB})`)
    const lutFrame = await renderFrame(lutProject, 400)
    const [preR, preG, preB] = await samplePng(lutFrame, 320, 180)
    assert(
      Math.abs(preR - lutR) < 35 && Math.abs(preG - lutG) < 35 && Math.abs(preB - lutB) < 35,
      `lut preview vs export rgb(${preR},${preG},${preB}) vs rgb(${lutR},${lutG},${lutB})`
    )
    console.log(`ffmpeg: green LUT rgb ${lutR},${lutG},${lutB}; preview ${preR},${preG},${preB}`)

    const gs = join(dir, 'gs.mp4')
    const gsMk = await runFfmpeg(ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=0x00FF00:s=640x360:d=2:r=30',
      '-f',
      'lavfi',
      '-i',
      'color=c=red:s=220x140:d=2:r=30',
      '-filter_complex',
      '[0:v][1:v]overlay=210:110,format=yuv420p',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-an',
      gs
    ])
    if (gsMk.code !== 0) throw new Error(`gs source: ${gsMk.stderr.slice(-400)}`)
    const keyProject: Project = {
      ...project,
      assets: [
        ...project.assets,
        {
          id: 'gs',
          name: 'gs.mp4',
          path: gs,
          kind: 'video',
          durationMs: 2000,
          width: 640,
          height: 360,
          fps: 30,
          importedAt: new Date().toISOString()
        }
      ],
      timeline: {
        ...emptyTimeline(),
        storyline: [
          clip({
            id: 'base',
            assetId: 'blue',
            inMs: 0,
            outMs: 2000,
            durationMs: 2000
          })
        ],
        overlays: [
          clip({
            id: 'fg',
            assetId: 'gs',
            inMs: 0,
            outMs: 2000,
            durationMs: 2000,
            fx: {
              scale: 1,
              posX: 0.5,
              posY: 0.5,
              opacity: 1,
              key: { color: '#00ff00', tolerance: 0.35, spill: 0, edge: 0.08 }
            }
          })
        ]
      }
    }
    const keyStreams = new Map([...streams, [gs, { hasVideo: true, hasAudio: false }]])
    const gKey = buildGraph(keyProject, { width: 640, height: 360, fps: 30, alpha: false, streams: keyStreams })
    assert(gKey.filter.includes('colorkey'), 'colorkey in graph')
    const outKey = join(dir, 'key.mp4')
    await renderTimeline(keyProject, outKey, '1080p')
    const [kcR, kcG, kcB] = await sampleFile(outKey, 320, 180)
    const [koR, koG, koB] = await sampleFile(outKey, 8, 8)
    assert(kcR > 150 && kcR > kcB, `keyed center should stay red subject, got rgb(${kcR},${kcG},${kcB})`)
    assert(koB > 80 && koB > koR, `keyed corner should show blue below, got rgb(${koR},${koG},${koB})`)
    const keyFrame = await renderFrame(keyProject, 400)
    const [pkR, pkG, pkB] = await samplePng(keyFrame, 320, 180)
    assert(
      Math.abs(pkR - kcR) < 40 && Math.abs(pkG - kcG) < 40 && Math.abs(pkB - kcB) < 40,
      `key preview vs export center rgb(${pkR},${pkG},${pkB}) vs rgb(${kcR},${kcG},${kcB})`
    )
    console.log(`ffmpeg: key center rgb ${kcR},${kcG},${kcB} (preview ${pkR},${pkG},${pkB}); corner ${koR},${koG},${koB}`)

    const shake = join(dir, 'shake.mp4')
    const shMk = await runFfmpeg(ffmpeg, [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=800x450:d=2:r=30',
      '-vf',
      `drawbox=x=200:y=120:w=120:h=80:c=red:t=fill,drawbox=x=500:y=200:w=80:h=120:c=blue:t=fill,drawbox=x=350:y=80:w=40:h=40:c=yellow:t=fill,crop=640:360:x='80+24*sin(2*PI*n/30)':y=45,format=yuv420p`,
      '-c:v',
      'libx264',
      '-crf',
      '0',
      '-g',
      '1',
      '-pix_fmt',
      'yuv420p',
      '-an',
      shake
    ])
    if (shMk.code !== 0) throw new Error(`shake source: ${shMk.stderr.slice(-400)}`)
    const shakeAsset = {
      id: 'shake',
      name: 'shake.mp4',
      path: shake,
      kind: 'video' as const,
      durationMs: 2000,
      width: 640,
      height: 360,
      fps: 30,
      importedAt: new Date().toISOString()
    }
    function shakeProject(on: boolean): Project {
      return {
        ...project,
        assets: [...project.assets, shakeAsset],
        timeline: {
          ...emptyTimeline(),
          storyline: [
            clip({
              id: 'sh',
              assetId: 'shake',
              inMs: 0,
              outMs: 2000,
              durationMs: 2000,
              fx: { stabilize: { enabled: on, amount: 0.5 } }
            })
          ]
        }
      }
    }
    const rawShake = shakeProject(false)
    const stabShake = shakeProject(true)
    const gStab = buildGraph(stabShake, {
      width: 640,
      height: 360,
      fps: 30,
      alpha: false,
      streams: new Map([[shake, { hasVideo: true, hasAudio: false }]])
    })
    assert(gStab.filter.includes('deshake'), 'deshake in graph')
    const outRaw = join(dir, 'shake-raw.mp4')
    const outStab = join(dir, 'shake-stab.mp4')
    await renderTimeline(rawShake, outRaw, '1080p')
    await renderTimeline(stabShake, outStab, '1080p')
    async function redCentroidX(file: string, n: number): Promise<number> {
      const r = await runFfmpeg(ffmpeg, [
        '-i',
        file,
        '-vf',
        `select=eq(n\\,${n}),format=rgb24`,
        '-frames:v',
        '1',
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        'pipe:1'
      ])
      const buf = r.stdout
      const w = 640
      const h = 360
      if (buf.length < w * h * 3) throw new Error(`stab frame ${file} n=${n} len=${buf.length}: ${r.stderr.slice(-300)}`)
      let sx = 0
      let c = 0
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 3
          if (buf[i] > 180 && buf[i + 1] < 80 && buf[i + 2] < 80) {
            sx += x
            c++
          }
        }
      }
      if (!c) throw new Error(`no red blob in ${file} n=${n}`)
      return sx / c
    }
    const ns = [1, 8, 15, 22]
    const rawXs = []
    const stXs = []
    for (const n of ns) {
      rawXs.push(await redCentroidX(outRaw, n))
      stXs.push(await redCentroidX(outStab, n))
    }
    const rawSpan = Math.max(...rawXs) - Math.min(...rawXs)
    const stSpan = Math.max(...stXs) - Math.min(...stXs)
    assert(rawSpan > 24, `unsteady clip should swing, span=${rawSpan.toFixed(1)}`)
    assert(stSpan < rawSpan * 0.8, `stabilize should reduce motion ${rawSpan.toFixed(1)} → ${stSpan.toFixed(1)}`)
    console.log(`ffmpeg: stabilize x-span ${rawSpan.toFixed(1)} → ${stSpan.toFixed(1)}`)

    const volP: Project = {
      ...project,
      timeline: {
        ...emptyTimeline(),
        storyline: [
          clip({
            id: 'vol',
            assetId: 'red',
            inMs: 0,
            outMs: 2000,
            durationMs: 2000,
            volume: 1,
            fx: {
              keys: {
                volume: [
                  { t: 0, value: 0.12, ease: 'linear' },
                  { t: 1, value: 1, ease: 'linear' }
                ]
              }
            }
          })
        ]
      }
    }
    const gVol = buildGraph(volP, { width: 640, height: 360, fps: 30, alpha: false, streams })
    assert(gVol.filter.includes('eval=frame'), 'volume keys in graph')
    const outVol = join(dir, 'vol.mp4')
    await renderTimeline(volP, outVol, '1080p')
    async function meanDb(file: string, ss: number, len: number): Promise<number> {
      const r = await runFfmpeg(ffmpeg, [
        '-i',
        file,
        '-ss',
        ss.toFixed(2),
        '-t',
        len.toFixed(2),
        '-af',
        'volumedetect',
        '-f',
        'null',
        '-'
      ])
      const m = /mean_volume:\s*([-0-9.]+)/.exec(r.stderr)
      if (!m) throw new Error(`volumedetect failed: ${r.stderr.slice(-300)}`)
      return Number(m[1])
    }
    const quiet = await meanDb(outVol, 0.12, 0.3)
    const loud = await meanDb(outVol, 1.55, 0.3)
    assert(loud > quiet + 6, `volume keys should rise, ${quiet.toFixed(1)}dB → ${loud.toFixed(1)}dB`)
    console.log(`ffmpeg: volume keys ${quiet.toFixed(1)}dB → ${loud.toFixed(1)}dB`)

    const audioClip = clip({ id: 'aud', assetId: 'red', inMs: 0, outMs: 2000, durationMs: 2000, startMs: 0 })
    const vis = clip({
      id: 'pulse',
      assetId: 'red',
      inMs: 0,
      outMs: 2000,
      durationMs: 2000,
      startMs: 0,
      fx: {
        scale: 0.35,
        posX: 0.5,
        posY: 0.5,
        audioLink: { prop: 'scale', amount: 0.7 },
        keys: { scale: beatScaleKeys([0, 500, 1000, 1500], audioClip, clip({ id: 'pulse', assetId: 'red', durationMs: 2000, startMs: 0 }), 0.7, 0.35) }
      }
    })
    const beatP: Project = {
      ...project,
      timeline: {
        ...emptyTimeline(),
        storyline: [clip({ id: 'base', assetId: 'blue', inMs: 0, outMs: 2000, durationMs: 2000 })],
        overlays: [vis]
      }
    }
    const liveBeat = fxAt(vis, 40).scale
    const liveOff = fxAt(vis, 280).scale
    assert(liveBeat > liveOff + 0.08, `beat scale preview ${liveBeat.toFixed(2)} vs ${liveOff.toFixed(2)}`)
    const outBeat = join(dir, 'beat.mp4')
    await renderTimeline(beatP, outBeat, '1080p')
    const onPx = await sampleFile(outBeat, 180, 180, 0.04)
    const offPx = await sampleFile(outBeat, 180, 180, 0.28)
    assert(onPx[0] > 120 && onPx[0] > onPx[2], `beat-on pixel should be red, got ${onPx}`)
    assert(offPx[2] > 80 && offPx[2] > offPx[0], `beat-off pixel should be blue, got ${offPx}`)
    console.log(`ffmpeg: beat-follow on ${onPx} off ${offPx}; preview scale ${liveBeat.toFixed(2)}→${liveOff.toFixed(2)}`)

    const denP: Project = {
      ...project,
      timeline: {
        ...emptyTimeline(),
        storyline: [
          clip({
            id: 'dn',
            assetId: 'red',
            inMs: 0,
            outMs: 2000,
            durationMs: 2000,
            fx: { denoise: { enabled: true, amount: 0.6 } }
          })
        ]
      }
    }
    const gDen = buildGraph(denP, { width: 640, height: 360, fps: 30, alpha: false, streams })
    assert(gDen.filter.includes('afftdn'), 'afftdn in graph')
    const outDen = join(dir, 'denoise.mp4')
    await renderTimeline(denP, outDen, '1080p')
    const denDur = await runFfmpeg(ffprobe, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=nw=1:nk=1',
      outDen
    ])
    const ddur = Number(denDur.stdout.toString().trim())
    assert(ddur > 1.5 && ddur < 2.4, `denoise export duration ${ddur}`)
    console.log(`ffmpeg: denoise afftdn ${ddur.toFixed(2)}s`)

    async function probeStream(file: string, entries: string): Promise<string> {
      const r = await runFfmpeg(ffprobe, [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        entries,
        '-of',
        'default=nw=1:nk=1',
        file
      ])
      return r.stdout.toString().trim()
    }
    const outH264 = join(dir, 'h264.mp4')
    await renderTimeline(project, outH264, '1080p')
    const codec = await probeStream(outH264, 'stream=codec_name')
    const h264Pix = await probeStream(outH264, 'stream=pix_fmt')
    assert(codec === 'h264', `1080p should be h264, got ${codec}`)
    assert(h264Pix === 'yuv420p', `h264 pix_fmt ${h264Pix}`)
    console.log(`ffmpeg: h264 ${codec} ${h264Pix}`)

    const outAlpha = join(dir, 'alpha.mov')
    await renderTimeline(project, outAlpha, 'alpha')
    const apix = await probeStream(outAlpha, 'stream=pix_fmt')
    assert(/yuva|argb|rgba|gbrap/i.test(apix), `alpha should keep transparency, pix_fmt=${apix}`)
    console.log(`ffmpeg: alpha pix_fmt ${apix}`)

    const outPro = join(dir, 'prores.mov')
    await renderTimeline(project, outPro, 'prores')
    const pcodec = await probeStream(outPro, 'stream=codec_name')
    assert(pcodec === 'prores', `prores codec ${pcodec}`)
    console.log(`ffmpeg: prores ${pcodec}`)

    const proxy = join(dir, 'proxy.mp4')
    const pz = await writeProxyFile(ffmpeg, red, proxy, 640, 360)
    assert(pz.width === 320 && pz.height === 180, `proxy size ${pz.width}x${pz.height}`)
    const pw = await probeStream(proxy, 'stream=width')
    const ph = await probeStream(proxy, 'stream=height')
    assert(Number(pw) === 320 && Number(ph) === 180, `proxy probe ${pw}x${ph}`)
    console.log(`ffmpeg: proxy ${pw}x${ph}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function analysisUnitTests(): void {
  // 10ms 帧：1s 响 / 0.5s 噪底 / 0.08s 字间停顿 / 1s 响
  const frames = [
    ...Array(100).fill(0.1),
    ...Array(50).fill(0.001),
    ...Array(8).fill(0.001),
    ...Array(100).fill(0.1)
  ]
  const seg = segmentSpeech(frames, frames.length * 10)
  assert(seg.silence.length === 1, `one silence, got ${JSON.stringify(seg.silence)}`)
  assert(seg.silence[0]!.startMs === 1000 && seg.silence[0]!.endMs === 1580, `silence bounds ${JSON.stringify(seg.silence)}`)
  const quiet = segmentSpeech(frames.map((v) => v * 0.05), frames.length * 10)
  assert(
    quiet.silence.length === 1 && Math.abs(quiet.silence[0]!.startMs - 1000) <= 10,
    `adaptive threshold on quiet source ${JSON.stringify(quiet.silence)}`
  )
  const gap = [...Array(100).fill(0.1), ...Array(8).fill(0.001), ...Array(100).fill(0.1)]
  assert(segmentSpeech(gap, 2080).silence.length === 0, 'short pause merged into speech')

  const beatFrames = Array.from({ length: 400 }, (_, i) => (i % 50 < 5 ? 0.3 : 0.01))
  const { beats, bpm } = detectBeats(beatFrames, beatFrames)
  assert(beats.length >= 7 && beats.every((t) => t % 500 <= 20), `beats ${beats}`)
  assert(bpm == null || Math.abs(bpm - 120) < 3, `bpm ${bpm}`)
  assert(onsetTimes([0, 1, 0], 1000, 0.55, [100, 400]).join() === '100,400', 'onsetTimes prefers beats')

  const e = parseEbur128('Summary:\n  Integrated loudness:\n    I:  -16.4 LUFS\n  Loudness range:\n    LRA:  5.2 LU\n  True peak:\n    Peak:  -1.3 dBFS')
  assert(e.lufs === -16.4 && e.truePeak === -1.3 && e.lra === 5.2, `ebur128 ${JSON.stringify(e)}`)
  assert(cleanScenes([100, 2000, 2100, 5000, 9950], 10000).join() === '2000,5000', 'scene cleanup')
  assert(parseShowinfoTime('[Parsed_showinfo_3 @ 0x1] n:0 pts:50 pts_time:2.002 duration') === 2002, 'showinfo pts')

  const tc = clip({ id: 't', assetId: 'x', startMs: 1000, durationMs: 1000, inMs: 4000, outMs: 6000, fx: { speed: 2 } })
  assert(timelineTimeMs(tc, 5000) === 1500, 'timelineTimeMs speed')
  assert(Math.abs(sourceTimeMs(tc, timelineTimeMs(tc, 5321)) - 5321) < 1e-6, 'timelineTimeMs inverse')
  const rc = clip({ id: 'r', assetId: 'x', startMs: 0, durationMs: 2000, inMs: 0, outMs: 2000, fx: { reverse: true } })
  assert(timelineTimeMs(rc, 1500) === 500, 'timelineTimeMs reverse')
  const mapped = sourceRangeToTimeline(tc, 3000, 4500)
  assert(mapped?.startMs === 1000 && mapped.endMs === 1250, `sourceRangeToTimeline ${JSON.stringify(mapped)}`)

  // whisper.cpp -ojf：“你好” 的 “你” 被拆成两个 token（半个 UTF-8 字符）
  const ni = Buffer.from('你', 'utf8')
  const raw = (t: string) => Buffer.from(t, 'utf8').toString('latin1')
  const tok = (b: Buffer | string, from: number, to: number) =>
    `{"text":"${typeof b === 'string' ? raw(b) : b.toString('latin1')}","offsets":{"from":${from},"to":${to}}}`
  const json = Buffer.from(
    `{"result":{"language":"zh"},"transcription":[{"offsets":{"from":0,"to":900},"text":"${raw('你好。')}","tokens":[` +
      [tok('[_BEG_]', 0, 0), tok(ni.subarray(0, 2), 0, 200), tok(ni.subarray(2), 200, 400), tok('好', 400, 800), tok('。', 800, 900)].join(',') +
      `]}]}`,
    'latin1'
  )
  const wj = parseWhisperJson(json, 'a1')
  assert(wj.language === 'zh' && wj.cues[0]?.text === '你好。' && wj.cues[0]?.assetId === 'a1', `whisper cue ${JSON.stringify(wj)}`)
  const words = wj.cues[0]?.words ?? []
  assert(words.length === 2 && words[0]!.text === '你' && words[0]!.startMs === 0 && words[1]!.text === '好。', `whisper words ${JSON.stringify(words)}`)
  // 置信度：半个字符的两个 token 取较小的 p；标点并入的词取最小值
  const tokP = (b: Buffer | string, from: number, to: number, p: number) => tok(b, from, to).replace(/}$/, `,"p":${p}}`)
  const jsonP = Buffer.from(
    `{"transcription":[{"offsets":{"from":0,"to":900},"text":"${raw('你好。')}","tokens":[` +
      [tokP(ni.subarray(0, 2), 0, 200, 0.9), tokP(ni.subarray(2), 200, 400, 0.4), tokP('好', 400, 800, 0.95), tokP('。', 800, 900, 0.99)].join(',') +
      `]}]}`,
    'latin1'
  )
  const wp = parseWhisperJson(jsonP).cues[0]!.words!
  assert(wp[0]!.p === 0.4 && wp[1]!.p === 0.95, `whisper word confidence ${JSON.stringify(wp)}`)
  const aligned = refineWordTimings([{ assetId: 'a1', startMs: 0, endMs: 900, text: '你好。', words: wp }], [{ startMs: 0, endMs: 900 }])
  assert(aligned[0]!.words![0]!.p === 0.4, 'confidence survives alignment')
  const en = tokensToWords([
    { text: ' Hel', startMs: 0, endMs: 100 },
    { text: 'lo', startMs: 100, endMs: 200 },
    { text: ',', startMs: 200, endMs: 210 },
    { text: ' world', startMs: 300, endMs: 600 }
  ])
  assert(en.map((w) => w.text).join('|') === 'Hello,|world' && en[0]!.endMs === 200, `latin words ${JSON.stringify(en)}`)
  const vj = cuesFromVerboseJson(
    { segments: [{ start: 0, end: 1, text: ' hi there' }], words: [{ word: 'hi', start: 0.1, end: 0.3 }, { word: 'there', start: 0.4, end: 0.9 }] },
    600_000,
    60_000,
    'a2'
  )
  assert(vj[0]?.startMs === 600_000 && vj[0]?.words?.[1]?.startMs === 600_400, `verbose_json offset ${JSON.stringify(vj)}`)
}

function textcutUnitTests(): void {
  // 每个字 180ms、字间 20ms；标点并在前一个字上
  const cueOf = (text: string, start: number, extraGap: Record<number, number> = {}) => {
    const words: { text: string; startMs: number; endMs: number }[] = []
    let t = start
    for (const ch of text) {
      if (/[，。！？]/.test(ch)) {
        words[words.length - 1]!.text += ch
        continue
      }
      words.push({ text: ch, startMs: t, endMs: t + 180 })
      t += 200 + (extraGap[words.length - 1] ?? 0)
    }
    return { assetId: 'A', text, startMs: start, endMs: words[words.length - 1]!.endMs, words }
  }
  const tl = emptyTimeline()
  tl.storyline = [clip({ id: 'c1', assetId: 'A', durationMs: 20000, inMs: 0, outMs: 20000 })]
  const proj: Pick<Project, 'timeline' | 'transcript' | 'assets'> = {
    timeline: tl,
    transcript: [
      cueOf('大家好，今天我们来讲', 0),
      cueOf('今天我们来讲剪辑的基本原则。', 3000),
      cueOf('嗯', 6000),
      cueOf('第一条是节奏要快，第二条是字幕要跟着语音走。', 7000, { 3: 800 })
    ],
    assets: [
      {
        id: 'A',
        name: 'a.mp4',
        path: '/a.mp4',
        kind: 'video' as const,
        durationMs: 20000,
        importedAt: '',
        fps: 30,
        width: 1920,
        height: 1080,
        index: { silence: [{ startMs: 2100, endMs: 2950 }], speech: [], scenes: [], peakRms: 0 }
      }
    ]
  }
  const doc = transcriptDoc(proj).sentences
  assert(doc.length === 4 && doc[1]!.id === 'A#1' && doc[1]!.timelineStartMs === 3000, `doc ${JSON.stringify(doc)}`)
  const retakes = detectRetakes(proj)
  assert(retakes.length === 1 && retakes[0]!.keep === 'A#1' && retakes[0]!.drop.join() === 'A#0', `retakes ${JSON.stringify(retakes)}`)
  const fill = fillerWordRanges(proj).A ?? []
  assert(fill.length === 1 && fill[0]!.startMs < 6000 && fill[0]!.endMs > 6180 && fill[0]!.endMs < 7000, `filler ${JSON.stringify(fill)}`)
  const tight = tightenPauses(proj, 300).A ?? []
  assert(tight.some((r) => r.startMs === 2100 && r.endMs === 2850), `tighten snaps into silence ${JSON.stringify(tight)}`)
  // 删掉“嗯”后，跨剪辑点拼起来的停顿也要被压缩，且不留碎片
  const noFiller = { ...proj, timeline: { ...tl, storyline: applySourceCuts(tl.storyline, fillerWordRanges(proj)) } }
  const tight2 = tightenPauses(noFiller, 300).A ?? []
  const sl2 = applySourceCuts(noFiller.timeline.storyline, { A: tight2 })
  assert(sl2.every((c) => c.durationMs >= 150), `no residue after filler+tighten ${JSON.stringify(sl2.map((c) => [c.inMs, c.outMs]))}`)
  // 片头 / 片尾静音：“嗯”删掉后 0–260 的静音不能成为碎片，结尾静音也要压到 ≤ 150ms
  const headProj = {
    ...proj,
    transcript: [
      { assetId: 'A', text: '嗯', startMs: 300, endMs: 552, words: [{ text: '嗯', startMs: 300, endMs: 552 }] },
      cueOf('大家好今天讲剪辑。', 1002)
    ],
    // 能量分析的静音（tightenPauses 只删静音段内的部分）
    assets: [{ ...proj.assets[0]!, index: { silence: [{ startMs: 0, endMs: 300 }, { startMs: 552, endMs: 1002 }, { startMs: 2782, endMs: 20000 }], speech: [], scenes: [], peakRms: 0 } }]
  }
  const headCut = { ...headProj, timeline: { ...tl, storyline: applySourceCuts(tl.storyline, fillerWordRanges(headProj)) } }
  assert(headCut.timeline.storyline[0]!.durationMs < 300, 'fixture: head fragment exists before tighten')
  const headSl = applySourceCuts(headCut.timeline.storyline, tightenPauses(headCut, 300))
  const firstHeard = buildCaptions({ ...headProj, timeline: { ...tl, storyline: headSl } }, { maxChars: 40 })[0]!
  assert(headSl.every((c) => c.durationMs >= 300), `no head fragment ${JSON.stringify(headSl.map((c) => [c.inMs, c.outMs]))}`)
  assert(firstHeard.startMs <= 150, `head silence ≤ 150ms, first word at ${firstHeard.startMs}`)
  const lastEnd = headSl[headSl.length - 1]!.startMs + headSl[headSl.length - 1]!.durationMs
  const lastWordEnd = 1002 + 8 * 200 + 180
  assert(lastEnd - (firstHeard.startMs + (lastWordEnd - 1002)) <= 160, `tail silence trimmed, story ends ${lastEnd}`)
  const heardGaps = buildCaptions({ ...proj, timeline: { ...tl, storyline: sl2 } }, { maxChars: 40 })
  assert(heardGaps.length > 0, 'captions after tighten')
  // 两个口头禅之间隔着正文：不能合并成一整段
  const twoFillers = {
    ...proj,
    transcript: [
      { assetId: 'A', text: '嗯', startMs: 300, endMs: 552, words: [{ text: '嗯', startMs: 300, endMs: 552 }] },
      cueOf('大家好今天讲剪辑。', 1002),
      { assetId: 'A', text: '那个', startMs: 14763, endMs: 15144, words: [{ text: '那个', startMs: 14763, endMs: 15144 }] },
      cueOf('我们开始。', 16000)
    ]
  }
  const tf = fillerWordRanges(twoFillers).A ?? []
  assert(tf.length === 2 && tf[0]!.endMs < 1002 && tf[1]!.startMs > 2700, `two fillers stay separate ${JSON.stringify(tf)}`)
  const cuts = planCutSentences(proj, ['A#1'])
  const c0 = cuts.A?.[0]
  assert(cuts.A?.length === 1 && c0!.startMs >= 2100 && c0!.startMs <= 3000 && c0!.endMs >= 5580 && c0!.endMs <= 6000, `plan cut ${JSON.stringify(cuts)}`)
  const sl = applySourceCuts(tl.storyline, cuts)
  assert(sl.length === 2 && sl[0]!.outMs === c0!.startMs && sl[1]!.inMs === c0!.endMs && sl[1]!.startMs === sl[0]!.durationMs, `apply cuts ${JSON.stringify(sl)}`)
  assert(tl.storyline[0]!.outMs === 20000, 'applySourceCuts must not mutate input')
  const after = { ...proj, timeline: { ...tl, storyline: sl } }
  assert(transcriptDoc(after).sentences.find((x) => x.id === 'A#1')?.inTimeline === false, 'cut sentence out of timeline')
  const caps = buildCaptions(proj, { maxChars: 12 })
  // 严格不超宽（maxChars 12），也不留 ≤2 字的孤字尾巴
  assert(caps.every((c) => [...c.text.replace(/\s/g, '')].length <= 12), `caption length ${caps.map((c) => c.text)}`)
  assert(!caps.some((c) => /[，。]$/.test(c.text)), 'caption trailing punctuation stripped')
  // 1–2 字的字幕只允许是本来就独立的一句（如「嗯」），不能是切剩的尾巴（如「则」）
  const whole = new Set(proj.transcript.map((t) => t.text.replace(/[\s\p{P}]/gu, '')))
  assert(caps.every((c) => { const t = c.text.replace(/[\s\p{P}]/gu, ''); return [...t].length >= 3 || whole.has(t) }), `no orphan char ${caps.map((c) => c.text)}`)
  // whisper 的半角逗号在中文字幕里转全角
  const half = buildCaptions({ ...proj, transcript: [cueOf('第三个,配一段节奏轻快的背景音乐。', 0)] }, { maxChars: 14 })
  assert(half.every((c) => !/[,;:?!]/.test(c.text) && [...c.text].length <= 14), `half-width punct ${half.map((c) => c.text)}`)
  assert(caps.every((c, i) => i === 0 || c.startMs >= caps[i - 1]!.endMs), 'captions do not overlap')
  const capsCut = buildCaptions(after, { maxChars: 10, maxLines: 2 })
  assert(!capsCut.some((c) => c.text.includes('原则')), 'captions drop cut words')
  assert(capsCut.some((c) => c.text.includes('\n')), 'two-line captions')
  assert(capsCut.every((c) => c.words?.length && c.words[0]!.startMs === c.startMs), 'caption words in timeline time')
  assert(textSimilarity('今天我们讲剪辑。', '今天我们讲剪辑') === 1, 'similarity ignores punctuation')
}

function reviewUnitTests(): void {
  const base = (): Project => ({
    version: 1,
    name: 'r',
    createdAt: '',
    updatedAt: '',
    settings: { ...DEFAULT_PROJECT_SETTINGS, width: 1080, height: 1920 },
    subtitleStyle: { ...DEFAULT_SUBTITLE_STYLE },
    assets: [
      { id: 'A', name: 'a', path: '/a', kind: 'video', durationMs: 60000, width: 1080, height: 1920, fps: 30, importedAt: '', index: { silence: [], speech: [{ startMs: 0, endMs: 60000 }], scenes: [], peakRms: 0.3, version: 2, truePeak: -0.5 } },
      { id: 'M', name: 'm', path: '/m', kind: 'audio', durationMs: 60000, width: 0, height: 0, fps: 0, importedAt: '' }
    ],
    timeline: emptyTimeline(),
    transcript: [],
    markers: [],
    snapshots: [],
    review: []
  })
  const clean = base()
  clean.assets[0]!.index!.truePeak = -3
  clean.timeline.storyline = [
    clip({ id: 'k1', assetId: 'A', startMs: 0, durationMs: 4000, inMs: 0, outMs: 4000 }),
    clip({ id: 'k2', assetId: 'A', startMs: 4000, durationMs: 3000, inMs: 5000, outMs: 8000 })
  ]
  clean.timeline.subtitles = [{ id: 's1', startMs: 0, endMs: 2000, text: '大家好', source: 'ai' }]
  const cleanIssues = reviewTimeline(clean).filter((i) => i.severity !== 'info')
  assert(cleanIssues.length === 0, `clean timeline has issues ${JSON.stringify(cleanIssues)}`)

  const bad = base()
  bad.assets[0]!.index!.truePeak = 4 // 超出导出限幅器余量（+3 dBTP）
  bad.timeline.storyline = [
    clip({ id: 'b1', assetId: 'A', startMs: 0, durationMs: 1000, inMs: 0, outMs: 1000, fx: { transitionOut: { type: 'cross_dissolve', durationMs: 700 } } }),
    clip({ id: 'b2', assetId: 'A', startMs: 300, durationMs: 200, inMs: 2000, outMs: 2200 }),
    clip({ id: 'b3', assetId: 'A', startMs: 1500, durationMs: 2000, inMs: 3000, outMs: 5000, fx: { transitionOut: { type: 'dissolve', durationMs: 500 } } })
  ]
  bad.timeline.overlays = [clip({ id: 't1', assetId: '', kind: 'text', startMs: 0, durationMs: 5000, fx: { posY: 0.85 }, text: { ...DEFAULT_TEXT_STYLE, text: '标题' } })]
  bad.timeline.audio = [clip({ id: 'm1', assetId: 'M', startMs: 0, durationMs: 9000, inMs: 0, outMs: 9000, volume: 0.8 })]
  bad.timeline.subtitles = [
    { id: 's1', startMs: 0, endMs: 1000, text: '这是一条特别特别特别长的字幕，远远超过竖屏每行十六个字的限制还要再长一点', source: 'ai' },
    { id: 's2', startMs: 900, endMs: 1200, text: '重叠', source: 'ai' }
  ]
  const codes = new Set(reviewTimeline(bad).map((i) => i.code))
  for (const code of [
    'fragment',
    'storyline_gap',
    'dissolve_on_jump_cut',
    'transition_too_long',
    'transition_on_last',
    'subtitle_overlap',
    'subtitle_too_long',
    'subtitle_too_short',
    'text_covers_subtitle',
    'music_too_loud',
    'duck_off',
    'clipping_risk',
    'overlay_past_end',
    'audio_past_end'
  ]) {
    assert(codes.has(code), `review should report ${code}; got ${[...codes].join(',')}`)
  }
  const quietOpen = base()
  quietOpen.assets[0]!.index!.speech = [{ startMs: 5000, endMs: 9000 }]
  quietOpen.timeline.storyline = [clip({ id: 'q', assetId: 'A', startMs: 0, durationMs: 9000, inMs: 0, outMs: 9000 })]
  assert(reviewTimeline(quietOpen).some((i) => i.code === 'slow_open'), 'slow open detected')
}

function visualUnitTests(): void {
  // —— reframe：16:9 放进 9:16 ——
  const cover = coverScale(1920, 1080, 9 / 16)
  assert(Math.abs(cover - 16 / 9 / (9 / 16)) < 0.01, `cover scale ${cover}`)
  // 与 layerBox 语义一致：铺满画布且不露边
  const fxFill = { ...DEFAULT_CLIP_FX, scale: cover, posX: 0.5, posY: 0.5 }
  const box = layerBox(fxFill, 1080, 1920, 1920, 1080)
  assert(Math.abs(box.h - 1920) < 2 && box.x <= 0 && box.x + box.w >= 1080, `cover box ${JSON.stringify(box)}`)
  // 主体在源画面 x=0.3：图层中心应让它落在画布中间
  const pos = posForSubject(0.3, 0.5, cover, 1, 0.5, 0.5)
  const subjectOnCanvas = pos.posX + (0.3 - 0.5) * cover
  assert(Math.abs(subjectOnCanvas - 0.5) < 0.001, `subject centered ${subjectOnCanvas}`)
  // 主体贴边时夹住，不露黑边
  const edge = posForSubject(0.99, 0.5, cover, 1)
  assert(edge.posX - cover / 2 <= 0.0001 && edge.posX + cover / 2 >= 0.9999, `clamped ${edge.posX}`)

  const face = (t: number, x: number) => ({ t, x: x - 0.05, y: 0.2, w: 0.1, h: 0.15, kind: 'face' as const, confidence: 0.9 })
  // 死区：±0.02 的抖动不产生镜头移动
  const jitter = Array.from({ length: 21 }, (_, i) => face(i * 500, 0.4 + (i % 2 ? 0.02 : -0.02)))
  const still = reframeTrack(jitter, 1920, 1080, 9 / 16)
  const xs = still.map((k) => k.posX)
  assert(Math.max(...xs) - Math.min(...xs) < 1e-6, `dead zone keeps camera still ${JSON.stringify(still)}`)
  // 平滑：主体从 0.3 跳到 0.7，镜头逐步过去，单步移动远小于总位移
  const jump = Array.from({ length: 21 }, (_, i) => face(i * 500, i < 10 ? 0.3 : 0.7))
  const moved = reframeTrack(jump, 1920, 1080, 9 / 16, { smoothMs: 800 })
  const total = Math.abs(moved[moved.length - 1]!.posX - moved[0]!.posX)
  let maxStep = 0
  for (let i = 1; i < moved.length; i++) {
    const dt = moved[i]!.t - moved[i - 1]!.t
    maxStep = Math.max(maxStep, Math.abs(moved[i]!.posX - moved[i - 1]!.posX) / Math.max(1, dt / 100))
  }
  assert(total > 1 && maxStep < total * 0.3, `smooth move total ${total} step ${maxStep}`)
  assert(moved.every((k) => k.posX - k.scale / 2 <= 0.0001 && k.posX + k.scale / 2 >= 0.9999), 'reframe never shows bars')
  // 切点：切点处直接跳，不做滑动
  const cutTrack = reframeTrack(jump, 1920, 1080, 9 / 16, { cuts: [5000] })
  const before = cutTrack.filter((k) => k.t < 5000)
  const after = cutTrack.find((k) => k.t >= 5000)
  assert(before[before.length - 1]!.t === 4999 && before[before.length - 1]!.posX === cutTrack[0]!.posX, `hold until cut ${JSON.stringify(cutTrack)}`)
  assert(after?.t === 5000 && after.posX === cutTrack[cutTrack.length - 1]!.posX, `jump at cut ${JSON.stringify(cutTrack)}`)
  assert(reframeTrack([], 1920, 1080, 9 / 16)[0]!.posX === 0.5, 'no subject stays centered')

  // —— look ——
  const normal: LookStats = { lumaMean: 0.46, lumaP5: 0.06, lumaP95: 0.88, satMean: 0.18, warmth: 0.03 }
  const dark: LookStats = { lumaMean: 0.16, lumaP5: 0.02, lumaP95: 0.34, satMean: 0.06, warmth: 0.0 }
  const en = enhanceFromLook(normal)
  assert(Object.values(en).every((v) => Math.abs(v) < 0.05), `normal footage ~0 ${JSON.stringify(en)}`)
  const ed = enhanceFromLook(dark)
  assert(ed.exposure > 0.15 && ed.contrast > 0.1 && ed.saturation > 0, `dark footage brightened ${JSON.stringify(ed)}`)
  assert(Object.values(ed).every((v) => Math.abs(v) <= 0.3), 'enhance clamped')
  const same = matchLook(normal, normal)
  assert(Object.values(same).every((v) => v === 0), `match identical ${JSON.stringify(same)}`)
  const cold: LookStats = { ...normal, lumaMean: 0.36, satMean: 0.12, warmth: -0.05 }
  const m = matchLook(normal, cold)
  assert(m.exposure > 0 && m.saturation > 0 && m.warmth > 0, `match direction ${JSON.stringify(m)}`)
  const m2 = matchLook(cold, normal)
  assert(m2.exposure < 0 && m2.saturation < 0 && m2.warmth < 0, `match reverse ${JSON.stringify(m2)}`)
  const acc = new LookAccumulator()
  acc.add(Buffer.from([255, 0, 0, 0, 0, 255, 128, 128, 128]))
  const st = acc.result()!
  assert(Math.abs(st.warmth) < 0.001 && st.satMean > 0.6 && st.lumaP95 >= st.lumaP5, `accumulator ${JSON.stringify(st)}`)
}

/** 转写纠错：替换错字并保住词级时间；热词提示词。 */
function transcriptFixUnitTests(): void {
  const W = (arr: [string, number, number][]) => arr.map(([text, startMs, endMs]) => ({ text, startMs, endMs }))
  const cues = [
    { assetId: 'T', startMs: 0, endMs: 1500, text: '停顿衣裳就会化走。', words: W([['停', 0, 150], ['顿', 150, 300], ['衣', 300, 450], ['裳', 450, 600], ['就', 600, 750], ['会', 750, 900], ['化', 900, 1050], ['走。', 1050, 1500]]) },
    { assetId: 'U', startMs: 0, endMs: 900, text: '衣裳好看', words: W([['衣裳', 0, 400], ['好看', 400, 900]]) }
  ]
  const r = fixTranscript(cues, '衣裳', '一长', 'T')
  assert(r.count === 1 && r.cues[0]!.text === '停顿一长就会化走。' && r.cues[1]!.text === '衣裳好看', `fix text ${JSON.stringify(r.cues.map((c) => c.text))}`)
  const w = r.cues[0]!.words!
  assert(w.map((x) => x.text).join('') === '停顿一长就会化走。' && w.find((x) => x.text === '一长')?.startMs === 300 && w.find((x) => x.text === '一长')?.endMs === 600, `fix words ${JSON.stringify(w)}`)
  // 跨词、跨标点的替换：合并成一个词，占原来的时间范围
  const r2 = fixTranscript(r.cues, '化走', '划走')
  const w2 = r2.cues[0]!.words!
  assert(r2.count === 1 && w2.at(-1)!.text === '划走。' && w2.at(-1)!.startMs === 900 && w2.at(-1)!.endMs === 1500, `cross-word fix ${JSON.stringify(w2)}`)
  assert(fixTranscript(cues, '不存在', 'x').count === 0, 'no match')
  assert(fixTranscript(cues, '衣裳', '衣裳衣裳').count === 2, 'replace containing find does not loop')
  assert(transcriptionPrompt(['剪辑台', '降噪']).includes('剪辑台、降噪') && transcriptionPrompt([]) === '', 'prompt only with vocabulary')
  const base = { lumaMean: 0.45, lumaP5: 0.1, lumaP95: 0.85, satMean: 0.15, warmth: 0.02 }
  assert(lookMismatch(base, { ...base, lumaMean: 0.47, warmth: 0.04 }).length === 0, 'similar looks match')
  const mm = lookMismatch(base, { ...base, lumaMean: 0.25, satMean: 0.35, warmth: 0.15 })
  assert(mm.length === 3 && mm[0]!.includes('偏暗'), `look mismatch ${JSON.stringify(mm)}`)
  console.log('transcript fix: 纠错保留词时间，热词提示词')
}

/** 字幕 / 文字超宽：按像素估算，导出和预览自动折行，质检报 subtitle_overflow / text_overflow。 */
function overflowUnitTests(): void {
  const portrait = { ...DEFAULT_SUBTITLE_STYLE, fontSize: 72, position: 'center' as const, preset: 'karaoke' as const }
  assert(maxCharsForStyle(portrait, 1080, 1920) === 13, `portrait 72 → ${maxCharsForStyle(portrait, 1080, 1920)}`)
  const landscape = { ...DEFAULT_SUBTITLE_STYLE, fontSize: 46 }
  assert(maxCharsForStyle(landscape, 1920, 1080) >= 30, `landscape 46 → ${maxCharsForStyle(landscape, 1920, 1080)}`)
  const boxed = { ...portrait, preset: 'boxed' as const }
  assert(subtitleAvailablePx(boxed, 1080, 1920) < subtitleAvailablePx(portrait, 1080, 1920) && maxCharsForStyle(boxed, 1080, 1920) <= 13, 'boxed padding reduces available width')
  const kw = { ...portrait, preset: 'keyword' as const, keywords: ['停顿'] }
  assert(maxCharsForStyle(kw, 1080, 1920) <= 12, 'keyword scale reduces capacity')
  assert(Math.abs(estimateTextWidthEm('剪辑abc,') - (2 + 0.56 * 3 + 0.32)) < 1e-6, 'width estimator')

  const long = '第一个技巧,是把没用的停顿全部剪掉'
  const wrapped = wrapSubtitleText(long, portrait, 1080, 1920).split('\n')
  assert(wrapped.length === 2 && wrapped[0] === '第一个技巧,' && wrapped.every((l) => subtitleLineWidthPx(l, portrait, 1080, 1920) <= subtitleAvailablePx(portrait, 1080, 1920)), `wrap ${JSON.stringify(wrapped)}`)
  assert(wrapSubtitleText('很多人是静音刷视频的', portrait, 1080, 1920) === '很多人是静音刷视频的', 'short line untouched')
  const latin = wrapSubtitleText('Subscribe to CutStudio for more editing tips today', portrait, 1080, 1920).split('\n')
  const whole = ['Subscribe', 'to', 'CutStudio', 'for', 'more', 'editing', 'tips', 'today']
  assert(latin.length >= 2 && latin.every((l) => l.split(/\s+/).every((w) => whole.includes(w))), `latin words kept whole: ${JSON.stringify(latin)}`)

  const tl = emptyTimeline()
  tl.storyline = [clip({ id: 's', assetId: 'X', startMs: 0, durationMs: 6000, inMs: 0, outMs: 6000 })]
  tl.subtitles = [
    { id: 'a', startMs: 0, endMs: 2000, text: long, source: 'ai' },
    { id: 'b', startMs: 2000, endMs: 4000, text: '很多人是静音刷视频的', source: 'ai' }
  ]
  tl.overlays = [
    clip({ id: 't1', assetId: '', kind: 'text', startMs: 0, durationMs: 2000, fx: { posX: 0.5, posY: 0.2 }, text: { ...DEFAULT_TEXT_STYLE, text: '三个让口播更好看的剪辑技巧', fontSize: 150 } }),
    clip({ id: 't2', assetId: '', kind: 'text', startMs: 0, durationMs: 2000, fx: { posX: 0.5, posY: 0.3 }, text: { ...DEFAULT_TEXT_STYLE, text: '3个技巧', fontSize: 100 } })
  ]
  const proj = {
    version: 1, name: 'ov', createdAt: '', updatedAt: '',
    settings: { ...DEFAULT_PROJECT_SETTINGS, width: 1080, height: 1920, aspect: '9:16' as const },
    subtitleStyle: portrait, assets: [], timeline: tl, transcript: [], markers: [], snapshots: [], review: []
  } as Project
  const issues = reviewTimeline(proj)
  const so = issues.filter((i) => i.code === 'subtitle_overflow')
  assert(so.length === 1 && so[0]!.atMs === 0 && /fontSize ≤ \d+/.test(so[0]!.message), `subtitle_overflow ${JSON.stringify(so)}`)
  const to = issues.filter((i) => i.code === 'text_overflow')
  assert(to.length === 1 && to[0]!.clipId === 't1', `text_overflow ${JSON.stringify(to)}`)
  const ass = assDocument(proj, 1080, 1920)
  assert(ass.includes('第一个技巧,\\N') || /第一个技巧,\{[^}]*\}?\\N/.test(ass) || ass.split('\n').some((l) => l.includes('\\N') && l.includes('剪掉')), `ASS wraps overflow line: ${ass.split('\n').filter((l) => l.startsWith('Dialogue')).join(' | ')}`)
  console.log('overflow: 字幕 / 文字层超宽检查，导出与预览按像素折行')
}

/** 黑边检查：竖屏画布里横屏素材没铺满时报 letterbox。 */
function letterboxUnitTests(): void {
  const asset = { id: 'L', name: 'l.mp4', path: '/l.mp4', kind: 'video' as const, durationMs: 10000, importedAt: '', fps: 30, width: 1920, height: 1080 }
  const mk = (storyFx: Record<string, unknown>, overlays: TimelineClip[] = []) => {
    const t = emptyTimeline()
    t.storyline = [clip({ id: 's', assetId: 'L', startMs: 0, durationMs: 4000, inMs: 0, outMs: 4000, fx: storyFx })]
    t.overlays = overlays
    return {
      version: 1, name: 'lb', createdAt: '', updatedAt: '',
      settings: { ...DEFAULT_PROJECT_SETTINGS, width: 1080, height: 1920, aspect: '9:16' as const },
      subtitleStyle: DEFAULT_SUBTITLE_STYLE, assets: [asset], timeline: t, transcript: [], markers: [], snapshots: [], review: []
    } as Project
  }
  const lb = (p: ReturnType<typeof mk>) => reviewTimeline(p).filter((i) => i.code === 'letterbox')
  const cover = coverScale(1920, 1080, 9 / 16)
  assert(lb(mk({ scale: 1 })).length === 1, 'unscaled landscape in portrait → letterbox')
  assert(lb(mk({ scale: cover, scaleX: cover, scaleY: cover })).length === 0, 'cover scale → no letterbox')
  assert(lb(mk({ scale: 1.15, scaleX: 1.15, scaleY: 1.15 })).length === 1, 'punch-in overwrite → letterbox')
  const zoomOut = mk({ scale: cover, scaleX: cover, scaleY: cover, keys: { scale: [{ t: 0, value: cover, ease: 'linear' }, { t: 1, value: 1, ease: 'linear' }] } })
  const z = lb(zoomOut)
  assert(z.length === 1 && z[0]!.atMs! > 0, `animated zoom-out letterbox later ${JSON.stringify(z)}`)
  const pip = clip({ id: 'o', assetId: 'L', startMs: 0, durationMs: 2000, inMs: 0, outMs: 2000, fx: { scale: 0.4, scaleX: 0.4, scaleY: 0.4 } })
  assert(lb(mk({ scale: cover, scaleX: cover, scaleY: cover }, [pip])).length === 0, 'picture-in-picture overlay not reported')
  console.log('letterbox: 竖屏黑边检查（含缩放动画、画中画除外）')
}

/** whisper.cpp 真实输出（评测 fixture：say 合成口播）：零长度词、停顿错位，用能量语音段重新对齐。 */
function wordAlignUnitTests(): void {
  const W = (arr: [string, number, number][]) => arr.map(([text, startMs, endMs]) => ({ text, startMs, endMs }))
  const cues = [
    { assetId: 'T', startMs: 0, endMs: 4440, text: '嗯!大家好,今天聊聊怎么剪口播视频。', words: W([['嗯!', 200, 200], ['大家好,', 1000, 1400], ['今天', 1950, 2100], ['聊', 2200, 2400], ['聊', 2400, 2600], ['怎么', 2600, 3000], ['剪', 3000, 3600], ['口', 3600, 3800], ['播', 3800, 4000], ['视', 4000, 4200], ['频。', 4200, 4440]]) },
    { assetId: 'T', startMs: 9600, endMs: 13760, text: '剪口播最重要的第一步,是去掉没用的停顿。', words: W([['剪', 9600, 9600], ['口', 9600, 9760], ['播', 9900, 9930], ['最', 9930, 10100], ['重要', 10100, 10110], ['的', 10600, 10610], ['第一', 10610, 10950], ['步,', 10950, 11120], ['是', 11550, 11630], ['去', 11630, 11700], ['掉', 11800, 11970], ['没', 11970, 12140], ['用', 12140, 12310], ['的', 12310, 12450], ['停', 12520, 12650], ['顿。', 12650, 13160]]) },
    { assetId: 'T', startMs: 14760, endMs: 18440, text: '那个!第二步,把说错的句子整句删掉。', words: W([['那个!', 14760, 14760], ['第二', 15060, 15260], ['步,', 15510, 15510], ['把', 15850, 16020], ['说', 16020, 16160], ['错', 16260, 16360], ['的', 16360, 16480], ['句', 16700, 16700], ['子', 16710, 16860], ['整', 16960, 17040], ['句', 17040, 17210], ['删', 17210, 17720], ['掉。', 17720, 17890]]) },
    { assetId: 'T', startMs: 26160, endMs: 29320, text: '好了,这期就到这里,谢谢大家。', words: W([['好了,', 26160, 26160], ['这', 26460, 26520], ['期', 26520, 26660], ['就到', 27120, 27120], ['这里,', 27160, 27520], ['谢谢', 28110, 28260], ['大家。', 28360, 28720]]) }
  ]
  const speech = [[300, 530], [1000, 4510], [9870, 13850], [14760, 15120], [15540, 18520], [26370, 29400]].map(([startMs, endMs]) => ({ startMs: startMs!, endMs: endMs! }))
  const silence = [[0, 300], [530, 1000], [4510, 9870], [13850, 14760], [15120, 15540], [18520, 26370], [29400, 30000]].map(([startMs, endMs]) => ({ startMs: startMs!, endMs: endMs! }))
  const refined = refineWordTimings(cues, speech)
  const word = (text: string, from = 0) => refined.flatMap((c) => c.words!).filter((w) => w.startMs >= from).find((w) => w.text.startsWith(text))!
  const all = refined.flatMap((c) => c.words!)
  assert(all.every((w) => w.endMs - w.startMs >= 10), `no zero-length words ${JSON.stringify(all.filter((w) => w.endMs - w.startMs < 10))}`)
  for (const w of all) {
    const inside = speech.some((s) => w.startMs >= s.startMs && w.endMs <= s.endMs)
    assert(inside, `word inside one speech segment ${JSON.stringify(w)}`)
  }
  const um = word('嗯')
  assert(Math.abs(um.startMs - 300) <= 20 && Math.abs(um.endMs - 530) <= 20, `嗯 aligned ${JSON.stringify(um)}`)
  const nage = word('那个')
  assert(Math.abs(nage.startMs - 14760) <= 30 && Math.abs(nage.endMs - 15120) <= 30, `那个 aligned ${JSON.stringify(nage)}`)
  assert(word('第二').startMs >= 15540, `第二 after pause ${JSON.stringify(word('第二'))}`)
  assert(word('好了').startMs >= 26370 && refined.at(-1)!.endMs <= 29400, `last cue in speech ${JSON.stringify(refined.at(-1))}`)
  for (let i = 1; i < all.length; i++) assert(all[i]!.startMs >= all[i - 1]!.endMs, `monotonic words ${i}`)

  // 口头禅独占语音段：整段删除并吸附到段边界；停顿压缩只删静音
  const tl = emptyTimeline()
  tl.storyline = [clip({ id: 'c', assetId: 'T', startMs: 0, durationMs: 30000, inMs: 0, outMs: 30000 })]
  const proj = {
    timeline: tl,
    transcript: refined,
    assets: [{ id: 'T', name: 't.mp4', path: '/t.mp4', kind: 'video' as const, durationMs: 30000, importedAt: '', fps: 30, width: 1920, height: 1080, index: { silence, speech, scenes: [], peakRms: 0 } }]
  }
  const fill = fillerWordRanges(proj).T ?? []
  assert(fill.length === 2, `two fillers ${JSON.stringify(fill)}`)
  assert(fill[1]!.startMs <= 14760 && fill[1]!.startMs >= 14700 && fill[1]!.endMs >= 15120 && fill[1]!.endMs <= 15540, `那个 cut covers its segment ${JSON.stringify(fill[1])}`)
  const tight = tightenPauses(proj, 300).T ?? []
  for (const r of tight) {
    assert(silence.some((s) => r.startMs >= s.startMs && r.endMs <= s.endMs), `tighten only removes silence ${JSON.stringify(r)}`)
  }
  // 空隙里没有静音段时不删
  const noSilence = { ...proj, assets: [{ ...proj.assets[0]!, index: { ...proj.assets[0]!.index, silence: [] } }] }
  assert(!(tightenPauses(noSilence, 300).T ?? []).length, 'no silence → nothing removed')
  // 幻听过滤：纯音乐被转成「Thank you.」（音乐能量也算语音段）
  const music = [
    { assetId: 'M', startMs: 0, endMs: 29980, text: 'Thank you.' },
    { assetId: 'M', startMs: 30000, endMs: 60000, text: 'Thank you.' }
  ]
  assert(filterHallucinations(music, [{ startMs: 0, endMs: 60000 }]).length === 0, 'music hallucinations dropped')
  assert(filterHallucinations(cues, speech).length === cues.length, 'real speech cues kept')
  const outside = [{ assetId: 'T', startMs: 20000, endMs: 21500, text: '谢谢观看' }]
  assert(filterHallucinations(outside, speech).length === 0, 'known phrase outside speech dropped')
  const said = [{ assetId: 'T', startMs: 1000, endMs: 2000, text: '谢谢观看。' }]
  assert(filterHallucinations(said, speech).length === 1, 'really spoken 谢谢观看 kept')
  const silentCue = [{ assetId: 'T', startMs: 5000, endMs: 8000, text: '今天天气很好我们出发吧' }]
  assert(filterHallucinations(silentCue, speech).length === 0, 'cue over silence dropped')
  // 句内重录：whisper 把「第一个技巧是把停」和重说合成一个 cue
  const hardText = '第一个技巧是把停,第一个技巧,是把没用的停顿全部剪掉,就是说,观众的耐心很有限。'
  const perChar = [...hardText].reduce<{ text: string; startMs: number; endMs: number }[]>((acc, ch) => {
    if (/[,。]/.test(ch)) acc[acc.length - 1]!.text += ch
    else acc.push({ text: ch, startMs: 4500 + acc.length * 200, endMs: 4500 + acc.length * 200 + 180 })
    return acc
  }, [])
  const tlH = emptyTimeline()
  tlH.storyline = [clip({ id: 'h', assetId: 'H', startMs: 0, durationMs: 20000, inMs: 0, outMs: 20000 })]
  const hardProj = {
    timeline: tlH,
    transcript: [{ assetId: 'H', startMs: 4500, endMs: perChar.at(-1)!.endMs, text: hardText, words: perChar }],
    assets: [{ id: 'H', name: 'h.mp4', path: '/h.mp4', kind: 'video' as const, durationMs: 20000, importedAt: '', fps: 30, width: 1920, height: 1080, index: { silence: [], speech: [], scenes: [], peakRms: 0 } }]
  }
  const rt = detectRetakes(hardProj).filter((g) => g.kind === 'clause')
  assert(rt.length === 1 && rt[0]!.dropText.join('') === '第一个技巧是把停,' && rt[0]!.drop[0] === 'H#0.0', `clause retake ${JSON.stringify(rt)}`)
  assert(resolveSpans(hardProj, rt[0]!.drop)[0]!.words.length === 8, 'clause span resolves to its words')
  const rtCut = planCutSentences(hardProj, rt[0]!.drop).H ?? []
  assert(rtCut.length === 1 && rtCut[0]!.startMs <= 4500 && rtCut[0]!.endMs >= 4500 + 7 * 200 + 180 && rtCut[0]!.endMs <= 4500 + 8 * 200, `clause cut ${JSON.stringify(rtCut)}`)
  // 排比不是重录
  const parallel = { ...hardProj, transcript: [{ assetId: 'H', startMs: 0, endMs: 3000, text: '第一步要剪掉停顿,第二步要加上字幕。' }] }
  assert(detectRetakes(parallel).length === 0, `parallel clauses are not retakes ${JSON.stringify(detectRetakes(parallel))}`)
  console.log('word align: whisper 词时间对齐到能量语音段，口头禅整段删除，停顿只删静音')
}

/** 底噪稳健性：say 合成语音（约 -20dBFS）+ 粉噪 -45dBFS，短语间停顿 80 / 150 / 300ms；另测片头数字静音。 */
async function noiseRobustnessTests(ffmpeg: string): Promise<void> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  try {
    await run('say', ['-v', '?'])
  } catch {
    console.log('noise: 没有 say，跳过底噪测试')
    return
  }
  const dir = await mkdtemp(join(tmpdir(), 'cut-noise-'))
  try {
    const { stdout } = await run('say', ['-v', '?'])
    // 列表里的中文语音不一定已下载（未下载的会输出静音），优先用系统自带的 Tingting
    const zh = stdout.split('\n').filter((l) => /zh_CN/.test(l))
    const voice = (zh.find((l) => /^Tingting/i.test(l)) ?? zh[0])?.split(/\s{2,}|\s\(/)[0]?.trim()
    const phrases = ['今天我们聊剪辑', '先说第一点', '再说第二点', '最后总结一下']
    const gaps = [80, 150, 300]
    const parts: string[] = []
    const truth: { startMs: number; endMs: number }[] = []
    let t = 0
    for (let i = 0; i < phrases.length; i++) {
      const aiff = join(dir, `p${i}.aiff`)
      const wav = join(dir, `p${i}.wav`)
      await run('say', [...(voice ? ['-v', voice] : []), '-o', aiff, phrases[i]!])
      const r = await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-i', aiff, '-af', 'silenceremove=start_periods=1:start_threshold=-50dB:stop_periods=-1:stop_threshold=-50dB:stop_duration=0.05,aresample=16000', '-ac', '1', '-c:a', 'pcm_s16le', wav])
      assert(r.code === 0, `noise say ${r.stderr}`)
      // 解码成 16k 单声道 PCM 数字节数，比 ffprobe 可靠（PATH 上的 ffprobe 可能读不出 duration）
      const pcm = await runFfmpeg(ffmpeg, ['-loglevel', 'error', '-i', wav, '-f', 's16le', '-ac', '1', '-ar', '16000', 'pipe:1'])
      const dur = Math.round(pcm.stdout.length / 32)
      assert(dur > 300, `phrase duration ${dur}`)
      parts.push(wav)
      t += dur
      if (i < gaps.length) {
        const g = join(dir, `g${i}.wav`)
        await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', (gaps[i]! / 1000).toFixed(3), '-c:a', 'pcm_s16le', g])
        parts.push(g)
        truth.push({ startMs: t, endMs: t + gaps[i]! })
        t += gaps[i]!
      }
    }
    const list = join(dir, 'l.txt')
    await writeFile(list, parts.map((p) => `file '${p}'`).join('\n'))
    const clean = join(dir, 'voice.wav')
    await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'pcm_s16le', clean])
    const mix = join(dir, 'mix.wav')
    const mr = await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-i', clean, '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.0289:r=16000:seed=7:d=${(t / 1000 + 1).toFixed(2)}`, '-filter_complex', '[0]volume=-1.8dB,apad[v];[v][1]amix=inputs=2:duration=shortest:normalize=0', '-t', (t / 1000 + 0.3).toFixed(2), mix])
    assert(mr.code === 0, `noise mix ${mr.stderr}`)
    const zlead = join(dir, 'zlead.wav')
    await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono:d=1.5', '-i', mix, '-filter_complex', '[0][1]concat=n=2:v=0:a=1', zlead])

    const check = async (path: string, offset: number, label: string) => {
      const frames = await readAudioFrames(ffmpeg, path)
      assert(frames?.rms.length, `${label} frames`)
      const seg = segmentSpeech(frames!.rms, frames!.rms.length * 10)
      const pauses = detectPauses(frames!.rms, seg.speech).filter((p) => !p.valley)
      const hit = (list: { startMs: number; endMs: number }[], g: { startMs: number; endMs: number }) =>
        list.find((r) => Math.min(r.endMs, g.endMs + offset) - Math.max(r.startMs, g.startMs + offset) >= (g.endMs - g.startMs) * 0.6)
      assert(!hit(seg.silence, truth[0]!), `${label}: 80ms 停顿不应进 silence ${JSON.stringify(seg.silence)}`)
      assert(hit(pauses, truth[0]!), `${label}: 80ms 停顿应进 pauses ${JSON.stringify(pauses)}`)
      for (const g of truth.slice(1)) {
        assert(hit(seg.silence, g), `${label}: ${g.endMs - g.startMs}ms 停顿应进 silence ${JSON.stringify(seg.silence)} truth ${JSON.stringify(g)}`)
        assert(hit(pauses, g), `${label}: ${g.endMs - g.startMs}ms 停顿也应在 pauses 里`)
      }
      const inSpeech = seg.speech.reduce((n, r) => n + r.endMs - r.startMs, 0)
      assert(inSpeech > t * 0.7 && inSpeech < t * 1.1, `${label}: speech total ${inSpeech} vs ${t}`)
      return seg.noiseFloorDb
    }
    const floor = await check(mix, 0, '粉噪')
    assert(floor > -50 && floor < -40, `noise floor ${floor}`)
    await check(zlead, 1500, '片头数字静音 + 粉噪')
    console.log(`noise: 粉噪 -45dBFS 下 150/300ms 进 silence、80ms 进 pauses（噪底 ${floor.toFixed(1)}dB）`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** warmth 渲染标定：导出（colortemperature）、预览增益（warmthGains）、分析换算（look.ts）三者一致。 */
async function warmthFfmpegTests(ffmpeg: string): Promise<void> {
  const g0 = warmthGains(0)
  assert(g0.r === 1 && g0.g === 1 && g0.b === 1 && warmthKelvin(0) === 6600, `warmth 0 应中性 ${JSON.stringify(g0)}`)
  const w0 = warmthGains(0.3)
  const w1 = warmthGains(-0.3)
  assert(w0.r >= w0.b && w1.b >= w1.r, 'warm → R≥B，cool → B≥R')
  const gray = async (warmth: number): Promise<LookStats> => {
    const vf = [...colorFfmpeg({ ...DEFAULT_CLIP_FX, color: { exposure: 0, contrast: 0, saturation: 0, warmth } }), 'format=rgb24']
      .filter(Boolean)
      .join(',')
    const r = await runFfmpeg(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x808080:s=32x18:d=0.1', '-frames:v', '1', '-vf', vf, '-f', 'rawvideo', 'pipe:1'])
    assert(r.code === 0, `warmth ffmpeg ${r.stderr}`)
    const acc = new LookAccumulator()
    acc.add(r.stdout)
    return acc.result()!
  }
  const base = await gray(0)
  for (const w of [0.2, -0.2]) {
    const l = await gray(w)
    const dRB = l.warmth - base.warmth
    assert(Math.sign(dRB) === Math.sign(w) && Math.abs(dRB) > 0.035 && Math.abs(dRB) < 0.055, `灰卡 warmth ${w} ΔR−B ${dRB}`)
    assert(Math.abs(l.lumaMean - base.lumaMean) < 0.02, `warmth 应基本保持亮度 ${l.lumaMean}`)
    // 预览增益预测的中灰 R−B（pl=1）与导出实测一致
    const g = warmthGains(w)
    const pred = 0.502 * g.lightness * (g.r - g.b)
    assert(Math.abs(pred - dRB) < 0.012, `预览增益 ${pred} vs 导出 ${dRB}`)
    // 分析换算：把偏色画面匹配回中性，应得到约 −w
    const back = matchLook(base, l).warmth
    assert(Math.abs(back + w) < 0.05, `matchLook 回推 ${back}，期望 ${-w}`)
  }
  console.log('warmth: colortemperature 灰卡 ΔR−B ≈ 0.21 × warmth，预览增益与导出一致')
}

async function analysisFfmpegTests(): Promise<void> {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) throw new Error('没有 ffmpeg，无法做素材分析测试')
  await warmthFfmpegTests(ffmpeg)
  await noiseRobustnessTests(ffmpeg)
  const dir = await mkdtemp(join(tmpdir(), 'cut-analysis-'))
  try {
    // 1.2s 正弦 / 0.6s 近静音底噪 / 1.0s 正弦（音量较低，验证自适应阈值）
    const wav = join(dir, 'pause.wav')
    const r = await runFfmpeg(ffmpeg, [
      '-y',
      '-f', 'lavfi', '-i', 'sine=f=440:d=1.2:r=48000',
      '-f', 'lavfi', '-i', 'anoisesrc=d=0.6:a=0.001:r=48000',
      '-f', 'lavfi', '-i', 'sine=f=330:d=1.0:r=48000',
      '-filter_complex',
      '[0]aformat=channel_layouts=mono[a];[1]aformat=channel_layouts=mono[b];[2]aformat=channel_layouts=mono,volume=0.2[c];[a][b][c]concat=n=3:v=0:a=1',
      wav
    ])
    assert(r.code === 0, `make pause wav: ${r.stderr.slice(-400)}`)
    const idx = await analyzeMediaFile(wav, 2800, { scenes: false })
    assert(idx.silence.length === 1, `ffmpeg silence count ${JSON.stringify(idx.silence)}`)
    const s0 = idx.silence[0]!
    assert(Math.abs(s0.startMs - 1200) <= 20 && Math.abs(s0.endMs - 1800) <= 20, `ffmpeg silence bounds ${JSON.stringify(s0)}`)
    assert(idx.speech.length === 2, `ffmpeg speech ${JSON.stringify(idx.speech)}`)
    assert(idx.waveform?.length === 240, `waveform bins ${idx.waveform?.length}`)
    assert(idx.lufs != null && idx.lufs < -10 && idx.lufs > -40, `lufs ${idx.lufs}`)
    assert(idx.truePeak != null && idx.truePeak <= 0, `true peak ${idx.truePeak}`)
    console.log(`analysis: silence ${s0.startMs}-${s0.endMs}ms, ${idx.lufs} LUFS, TP ${idx.truePeak}`)

    const vid = join(dir, 'cut.mp4')
    const v = await runFfmpeg(ffmpeg, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc2=s=320x240:d=1.5:r=25',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x240:d=1.5:r=25',
      '-filter_complex', '[0][1]concat=n=2:v=1:a=0',
      '-pix_fmt', 'yuv420p',
      vid
    ])
    assert(v.code === 0, `make scene video: ${v.stderr.slice(-400)}`)
    const scenes = await detectScenes(ffmpeg, vid, 3000)
    assert(scenes.length === 1 && Math.abs(scenes[0]! - 1500) <= 40, `scenes ${scenes}`)
    console.log(`analysis: scene cut ${scenes[0]}ms`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  unitTests()
  analysisUnitTests()
  textcutUnitTests()
  reviewUnitTests()
  visualUnitTests()
  wordAlignUnitTests()
  letterboxUnitTests()
  overflowUnitTests()
  transcriptFixUnitTests()
  await ffmpegTests()
  await analysisFfmpegTests()
  await brollTests(await findFfmpeg())
  await toolsTests(await findFfmpeg())
  await uiTests(await findFfmpeg())
  console.log('compose verify ok (phase 1–9)')
}

void main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
