/**
 * 评测素材：用 macOS `say` 合成一段「带问题」的中文口播（口头禅、说错重来、长停顿），
 * 并记录真值（每句的源时间、是否应被删掉），用于给 AI 剪辑结果打分。
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TranscriptCue } from '../../shared/types'
import { findFfmpeg, findFfprobe, runFfmpeg } from '../render/ffmpeg'

const run = promisify(execFile)

export type Segment = {
  text: string
  /** 这句后面的停顿（毫秒） */
  pauseMs: number
  /** 真值：成片里不应出现 */
  shouldCut?: 'retake' | 'filler'
}

/** 口播知识讲解：包含开头口头禅、一次说错重来、句中「那个」、两处过长停顿。 */
export const TALK_SCRIPT: Segment[] = [
  { text: '嗯', pauseMs: 450, shouldCut: 'filler' },
  { text: '大家好，今天聊聊怎么剪口播视频。', pauseMs: 1600 },
  { text: '剪口播最重要的第一步，是去掉', pauseMs: 700, shouldCut: 'retake' },
  { text: '剪口播最重要的第一步，是去掉没用的停顿。', pauseMs: 900 },
  { text: '那个', pauseMs: 400, shouldCut: 'filler' },
  { text: '第二步，把说错的句子整句删掉。', pauseMs: 2600 },
  { text: '第三步，加上字幕，再配一段轻一点的背景音乐。', pauseMs: 800 },
  { text: '好了，这期就到这里，谢谢大家。', pauseMs: 600 }
]

/**
 * 困难版：更像真人口播。短语间停顿只有 80–250ms、句中口头禅只隔 120ms、
 * 说错后几乎不停就重说、语速更快，并且全程有房间底噪（粉噪约 -45 dBFS）。
 */
export const HARD_SCRIPT: Segment[] = [
  { text: '那个', pauseMs: 180, shouldCut: 'filler' },
  { text: '今天分享三个让口播更好看的剪辑技巧。', pauseMs: 420 },
  { text: '第一个技巧是把停', pauseMs: 150, shouldCut: 'retake' },
  { text: '第一个技巧，是把没用的停顿全部剪掉。', pauseMs: 220 },
  { text: '就是说', pauseMs: 120, shouldCut: 'filler' },
  { text: '观众的耐心很有限，', pauseMs: 90 },
  { text: '停顿一长就会划走。', pauseMs: 900 },
  { text: '第二个技巧是加上大字幕。', pauseMs: 160 },
  { text: '嗯', pauseMs: 140, shouldCut: 'filler' },
  { text: '很多人是静音刷视频的。', pauseMs: 250 },
  { text: '第三个，配一段节奏轻快的背景音乐。', pauseMs: 80 },
  { text: '好，就这三个，我们下期见。', pauseMs: 500 }
]

/** 产品介绍：讲到具体部件时应插入对应特写 B-roll（素材名里带部件名）。 */
export const PRODUCT_SCRIPT: Segment[] = [
  { text: '这款无线耳机我已经用了一个月。', pauseMs: 700 },
  { text: '嗯', pauseMs: 400, shouldCut: 'filler' },
  { text: '先说充电盒，它很小，可以直接放进口袋。', pauseMs: 1200 },
  { text: '降噪效果也很明显，地铁上基本听不到噪音。', pauseMs: 600 },
  { text: '续航大概是六个小时，', pauseMs: 300 },
  { text: '戴久了耳朵也不疼。', pauseMs: 900 },
  { text: '总的来说，我很推荐。', pauseMs: 500 }
]

export const PRODUCT_BROLL = [
  { name: '耳机特写.mp4', keyword: '无线耳机', color: 'red' },
  { name: '充电盒特写.mp4', keyword: '充电盒', color: 'green' }
]

export type FixtureVariant = 'basic' | 'hard' | 'product'

export type Fixture = {
  variant?: FixtureVariant
  dir: string
  talkPath: string
  brollPath: string
  /** product 素材：带部件名的特写 */
  extraBroll?: { path: string; name: string; keyword: string }[]
  musicPath: string
  /** 每句在 talk 素材里的源时间 */
  timings: { segment: Segment; startMs: number; endMs: number }[]
  durationMs: number
}

async function zhVoice(): Promise<string | null> {
  try {
    const { stdout } = await run('say', ['-v', '?'])
    const lines = stdout.split('\n').filter((l) => /zh_CN/.test(l))
    const pick = lines.find((l) => /^Tingting|^Ting-Ting/i.test(l)) ?? lines[0]
    return pick ? pick.split(/\s{2,}|\s\(/)[0]!.trim() : null
  } catch {
    return null
  }
}

async function durationMs(ffprobe: string, path: string): Promise<number> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path])
  return Math.round(Number(stdout.trim()) * 1000)
}

export async function buildFixture(dir: string, variant: FixtureVariant = 'basic'): Promise<Fixture> {
  const script = variant === 'hard' ? HARD_SCRIPT : variant === 'product' ? PRODUCT_SCRIPT : TALK_SCRIPT
  await mkdir(dir, { recursive: true })
  const cached = join(dir, 'fixture.json')
  try {
    return JSON.parse(await readFile(cached, 'utf8')) as Fixture
  } catch {
    /* 重新生成 */
  }
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) throw new Error('评测需要 ffmpeg')
  const ffprobe = await findFfprobe(ffmpeg)
  const voice = await zhVoice()
  if (!voice) throw new Error('评测需要 macOS 中文语音（say -v ? 里的 zh_CN）')

  const parts: string[] = []
  const timings: Fixture['timings'] = []
  let t = 300
  parts.push(join(dir, 'lead.wav'))
  await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', '0.3', parts[0]!])
  for (let i = 0; i < script.length; i++) {
    const seg = script[i]!
    const aiff = join(dir, `seg${i}.aiff`)
    const wav = join(dir, `seg${i}.wav`)
    await run('say', ['-v', voice, ...(variant === 'hard' ? ['-r', '230'] : []), '-o', aiff, seg.text])
    // 去掉 say 自带的首尾静音，时间真值才准
    const trim = 'silenceremove=start_periods=1:start_threshold=-45dB:stop_periods=-1:stop_threshold=-45dB:stop_duration=0.15'
    const r = await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-i', aiff, '-af', trim, '-ar', '48000', '-ac', '1', wav])
    if (r.code !== 0) throw new Error(r.stderr)
    const d = await durationMs(ffprobe, wav)
    timings.push({ segment: seg, startMs: t, endMs: t + d })
    parts.push(wav)
    const pause = join(dir, `pause${i}.wav`)
    await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-t', (seg.pauseMs / 1000).toFixed(3), pause])
    parts.push(pause)
    t += d + seg.pauseMs
  }
  const list = join(dir, 'list.txt')
  await writeFile(list, parts.map((p) => `file '${p}'`).join('\n'))
  const total = t
  const voiceWav = join(dir, 'voice.wav')
  if (variant === 'hard') {
    const dry = join(dir, 'voice-dry.wav')
    await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'pcm_s16le', dry])
    const mixed = await runFfmpeg(ffmpeg, [
      '-y', '-loglevel', 'error', '-i', dry,
      '-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.012:sample_rate=48000:duration=${(total / 1000).toFixed(3)}`,
      '-filter_complex', '[1:a]aformat=channel_layouts=mono[n];[0:a][n]amix=inputs=2:duration=first:normalize=0',
      '-c:a', 'pcm_s16le', voiceWav
    ])
    if (mixed.code !== 0) throw new Error(mixed.stderr)
  } else {
    await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'pcm_s16le', voiceWav])
  }
  const talkPath = join(dir, 'talk.mp4')
  const vr = await runFfmpeg(ffmpeg, [
    '-y', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `testsrc2=s=1920x1080:r=30:d=${(total / 1000).toFixed(3)}`,
    '-i', voiceWav,
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', talkPath
  ])
  if (vr.code !== 0) throw new Error(vr.stderr)
  const brollPath = join(dir, 'broll.mp4')
  await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'smptehdbars=s=1920x1080:r=30:d=8', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', brollPath])
  const musicPath = join(dir, 'music.m4a')
  await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=f=220:d=60,volume=0.5', '-f', 'lavfi', '-i', 'sine=f=330:d=60,volume=0.3', '-filter_complex', 'amix=inputs=2', '-c:a', 'aac', musicPath])

  let extraBroll: Fixture['extraBroll']
  if (variant === 'product') {
    extraBroll = []
    for (const b of PRODUCT_BROLL) {
      const path = join(dir, b.name)
      const r = await runFfmpeg(ffmpeg, ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', `color=c=${b.color}:s=1920x1080:r=30:d=6`, '-f', 'lavfi', '-i', 'testsrc2=s=480x270:r=30:d=6', '-filter_complex', '[0][1]overlay=720:405', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', path])
      if (r.code !== 0) throw new Error(r.stderr)
      extraBroll.push({ path, name: b.name, keyword: b.keyword })
    }
  }
  const fixture: Fixture = { variant, extraBroll, dir, talkPath, brollPath, musicPath, timings, durationMs: total }
  await writeFile(cached, JSON.stringify(fixture, null, 2))
  return fixture
}

/** 没有真实转写器时用的「完美转写」：按句子真值时间，字均分成词。 */
export function syntheticTranscript(fx: Fixture, assetId: string): TranscriptCue[] {
  return fx.timings.map(({ segment, startMs, endMs }) => {
    const units = [...segment.text].reduce<string[]>((acc, ch) => {
      if (/[，。！？、]/.test(ch) && acc.length) acc[acc.length - 1] += ch
      else acc.push(ch)
      return acc
    }, [])
    // 口头禅「那个」是一个词
    const tokens = segment.shouldCut === 'filler' ? [segment.text] : units
    const span = (endMs - startMs) / tokens.length
    return {
      assetId,
      startMs,
      endMs,
      text: segment.text,
      words: tokens.map((text, i) => ({ text, startMs: Math.round(startMs + i * span), endMs: Math.round(startMs + (i + 1) * span) }))
    }
  })
}
