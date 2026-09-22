import { spawn } from 'node:child_process'

export function runFfmpeg(cmd: string, args: string[]): Promise<{ code: number; stderr: string; stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => stdout.push(d))
    child.stderr.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code: code ?? 1, stderr, stdout: Buffer.concat(stdout) }))
  })
}

const filterCache = new Map<string, Set<string>>()

/** ffmpeg 是否编译了某个滤镜（比如 ass 需要 libass，Homebrew 精简版没有）。 */
export async function ffmpegHasFilter(ffmpeg: string, name: string): Promise<boolean> {
  let set = filterCache.get(ffmpeg)
  if (!set) {
    const r = await runFfmpeg(ffmpeg, ['-hide_banner', '-filters'])
    set = new Set(
      r.stdout
        .toString()
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[1])
        .filter((x): x is string => Boolean(x))
    )
    filterCache.set(ffmpeg, set)
  }
  return set.has(name)
}

export async function findFfmpeg(): Promise<string | null> {
  const home = process.env.HOME || ''
  const candidates = [
    'ffmpeg',
    `${home}/homebrew/bin/ffmpeg`,
    '/opt/homebrew/bin/ffmpeg',
    '/opt/local/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
  ]
  for (const c of candidates) {
    try {
      const r = await runFfmpeg(c, ['-version'])
      if (r.code === 0) return c
    } catch {
      /* next */
    }
  }
  return null
}

export async function findFfprobe(ffmpeg: string): Promise<string> {
  const probe = ffmpeg.replace(/ffmpeg$/, 'ffprobe')
  try {
    const r = await runFfmpeg(probe, ['-version'])
    if (r.code === 0) return probe
  } catch {
    /* fall through */
  }
  return probe
}

export async function probeHasAudio(ffprobe: string, path: string): Promise<boolean> {
  try {
    const r = await runFfmpeg(ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      path
    ])
    return r.stdout.toString().includes('audio')
  } catch {
    return false
  }
}

export type MediaProbe = { durationMs: number; width: number; height: number; fps: number }

function parseRate(raw?: string): number {
  if (!raw || raw === '0/0') return 0
  const [a, b] = raw.split('/').map(Number)
  if (!b) return Number.isFinite(a) ? a : 0
  const n = a / b
  return Number.isFinite(n) ? n : 0
}

export async function probeMedia(path: string): Promise<MediaProbe> {
  const empty: MediaProbe = { durationMs: 0, width: 0, height: 0, fps: 0 }
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) return empty
  const ffprobe = await findFfprobe(ffmpeg)
  const r = await runFfmpeg(ffprobe, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_entries',
    'format=duration:stream=width,height,avg_frame_rate,codec_type',
    path
  ])
  if (r.code !== 0 || r.stdout.length < 2) return empty
  try {
    const json = JSON.parse(r.stdout.toString()) as {
      format?: { duration?: string }
      streams?: Array<{ codec_type?: string; width?: number; height?: number; avg_frame_rate?: string }>
    }
    const durationMs = Math.round(Number(json.format?.duration || 0) * 1000)
    const video = json.streams?.find((s) => s.codec_type === 'video' && (s.width || 0) > 0)
    return {
      durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
      width: video?.width || 0,
      height: video?.height || 0,
      fps: parseRate(video?.avg_frame_rate)
    }
  } catch {
    return empty
  }
}

export async function writeThumb(src: string, dest: string, atSec = 0.4): Promise<boolean> {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) return false
  const r = await runFfmpeg(ffmpeg, [
    '-y',
    '-ss',
    Math.max(0, atSec).toFixed(3),
    '-i',
    src,
    '-frames:v',
    '1',
    '-vf',
    'scale=320:-2',
    '-q:v',
    '4',
    dest
  ])
  return r.code === 0
}

export async function probeHasVideo(ffprobe: string, path: string): Promise<boolean> {
  try {
    const r = await runFfmpeg(ffprobe, [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_type',
      '-of',
      'csv=p=0',
      path
    ])
    return r.stdout.toString().includes('video')
  } catch {
    return false
  }
}
