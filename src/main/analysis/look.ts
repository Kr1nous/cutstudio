import { LookAccumulator, type LookStats } from '../../shared/look'
import { findFfmpeg, runFfmpeg } from '../render/ffmpeg'

export type { LookStats } from '../../shared/look'

const W = 96
const H = 54

/**
 * 在若干源时间点取帧（缩到 96×54）统计亮度分布、饱和度、冷暖，合并成一份。
 * 没有 ffmpeg 或一帧都取不到时返回 null。
 */
export async function measureLook(path: string, atMs: number[]): Promise<LookStats | null> {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) return null
  const times = atMs.length ? atMs : [0]
  const acc = new LookAccumulator()
  for (const t of times) {
    try {
      const r = await runFfmpeg(ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-ss',
        (Math.max(0, t) / 1000).toFixed(3),
        '-i',
        path,
        '-frames:v',
        '1',
        '-vf',
        `scale=${W}:${H}:flags=area,format=rgb24`,
        '-f',
        'rawvideo',
        'pipe:1'
      ])
      if (r.code === 0 && r.stdout.length >= W * H * 3) acc.add(r.stdout.subarray(0, W * H * 3))
    } catch {
      /* 跳过这一帧 */
    }
  }
  return acc.result()
}
