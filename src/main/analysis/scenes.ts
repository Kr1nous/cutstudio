import { spawn } from 'node:child_process'

/**
 * 镜头切换检测：ffmpeg scene score + showinfo，返回切点（毫秒，素材源时间）。
 * 缩到 160px 宽再算分；长素材先降帧率，控制耗时。
 */
export function detectScenes(ffmpeg: string, path: string, durationMs: number, threshold = 0.3): Promise<number[]> {
  const filters: string[] = []
  if (durationMs > 20 * 60_000) filters.push('fps=8')
  else if (durationMs > 5 * 60_000) filters.push('fps=15')
  filters.push('scale=160:-2:flags=fast_bilinear', `select='gt(scene,${threshold})'`, 'showinfo')
  return new Promise((resolve) => {
    const child = spawn(
      ffmpeg,
      [
        '-hide_banner',
        '-nostats',
        '-hwaccel',
        'videotoolbox',
        '-i',
        path,
        '-an',
        '-sn',
        '-dn',
        '-map',
        '0:v:0',
        '-vf',
        filters.join(','),
        '-f',
        'null',
        '-'
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    )
    const times: number[] = []
    let pending = ''
    child.stderr.on('data', (d: Buffer) => {
      pending += d.toString()
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const t = parseShowinfoTime(line)
        if (t != null) times.push(t)
      }
    })
    child.on('error', () => resolve([]))
    child.on('close', () => {
      const t = parseShowinfoTime(pending)
      if (t != null) times.push(t)
      resolve(cleanScenes(times, durationMs))
    })
  })
}

export function parseShowinfoTime(line: string): number | null {
  if (!line.includes('Parsed_showinfo')) return null
  const m = /pts_time:\s*(-?[\d.]+)/.exec(line)
  if (!m) return null
  const s = Number(m[1])
  return Number.isFinite(s) ? Math.round(s * 1000) : null
}

/** 去掉开头/结尾附近的伪切点，合并 300ms 内的连续触发（闪光、快速摇镜）。 */
export function cleanScenes(times: number[], durationMs: number): number[] {
  const out: number[] = []
  for (const t of [...times].sort((a, b) => a - b)) {
    if (t < 200) continue
    if (durationMs > 0 && t > durationMs - 200) continue
    if (out.length && t - out[out.length - 1]! < 300) continue
    out.push(t)
  }
  return out
}
