/** Vision 主体检测结果：t 为素材源时间（毫秒），x/y/w/h 为 0–1、原点左上。 */
export interface SubjectSample {
  t: number
  x: number
  y: number
  w: number
  h: number
  kind: 'face' | 'body'
  confidence: number
}

export interface ReframeKey {
  /** 素材源时间（毫秒）。 */
  t: number
  posX: number
  posY: number
  scale: number
}

export interface ReframeOptions {
  /** 平滑窗口（毫秒），决定镜头移动的过渡时长。 */
  smoothMs?: number
  /** 死区（源画面宽/高的比例）：主体偏离当前取景中心不到这个量时镜头不动。 */
  deadZone?: number
  /** 额外放大（1 = 刚好铺满画布）。 */
  zoom?: number
  /** 镜头切点（源时间毫秒）；切点两侧分别平滑，切点处直接跳。 */
  cuts?: number[]
  /** 主体中心在画布上的目标位置，默认水平居中；人脸偏上 0.4、人体 0.5。 */
  anchorX?: number
}

/** 源画面 contain 进画布后占画布的宽高比例（与 mask.ts containBase 一致）。 */
export function containFraction(srcW: number, srcH: number, dstAspect: number): { bw: number; bh: number } {
  const srcAspect = Math.max(1, srcW) / Math.max(1, srcH)
  // 画布宽 = dstAspect，高 = 1
  const fit = Math.min(dstAspect / srcAspect, 1)
  const w = srcAspect * fit
  return { bw: w / dstAspect, bh: fit }
}

/** 刚好铺满画布（不留黑边）所需的 scale。16:9 放进 9:16 时约为 3.16。 */
export function coverScale(srcW: number, srcH: number, dstAspect: number): number {
  const { bw, bh } = containFraction(srcW, srcH, dstAspect)
  return Math.max(1 / bw, 1 / bh)
}

/**
 * 给定图层尺寸（画布比例 wn/hn）和主体在源画面中的位置，求 posX/posY，
 * 使主体落在 anchor 处，并夹住不露黑边。
 */
export function posForSubject(sx: number, sy: number, wn: number, hn: number, anchorX = 0.5, anchorY = 0.5): { posX: number; posY: number } {
  const clampAxis = (p: number, n: number) => (n >= 1 ? Math.min(n / 2, Math.max(1 - n / 2, p)) : 0.5)
  return {
    posX: clampAxis(anchorX - (sx - 0.5) * wn, wn),
    posY: clampAxis(anchorY - (sy - 0.5) * hn, hn)
  }
}

/** 每个采样时刻选一个主体：优先人脸（面积×置信度最大），没有人脸时用人体。 */
export function pickSubjects(samples: SubjectSample[]): { t: number; x: number; y: number; kind: 'face' | 'body' }[] {
  const byT = new Map<number, SubjectSample[]>()
  for (const s of samples) {
    if (!(s.w > 0 && s.h > 0)) continue
    const list = byT.get(s.t) ?? []
    list.push(s)
    byT.set(s.t, list)
  }
  const out: { t: number; x: number; y: number; kind: 'face' | 'body' }[] = []
  for (const t of [...byT.keys()].sort((a, b) => a - b)) {
    const list = byT.get(t)!
    const faces = list.filter((s) => s.kind === 'face')
    const pool = faces.length ? faces : list
    const best = pool.reduce((a, b) => (b.w * b.h * b.confidence > a.w * a.h * a.confidence ? b : a))
    out.push({ t, x: best.x + best.w / 2, y: best.y + best.h / 2, kind: best.kind })
  }
  return out
}

function median3(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c))
}

function stabilize(xs: number[], deadZone: number): number[] {
  if (!xs.length) return []
  const filtered = xs.map((x, i) => (i > 0 && i < xs.length - 1 ? median3(xs[i - 1]!, x, xs[i + 1]!) : x))
  let cam = filtered[0]!
  return filtered.map((x) => {
    if (Math.abs(x - cam) > deadZone) cam = x
    return cam
  })
}

const GRID_MS = 100

/** 线性插值到 100ms 网格，再做两遍居中滑动平均，把死区阶跃变成缓入缓出。 */
function smoothOnGrid(ts: number[], xs: number[], smoothMs: number): { ts: number[]; xs: number[] } {
  if (xs.length < 2) return { ts, xs }
  const t0 = ts[0]!
  const t1 = ts[ts.length - 1]!
  const grid: number[] = []
  const vals: number[] = []
  let j = 0
  for (let t = t0; t <= t1; t += GRID_MS) {
    while (j < ts.length - 2 && ts[j + 1]! <= t) j++
    const u = Math.min(1, Math.max(0, (t - ts[j]!) / Math.max(1, ts[j + 1]! - ts[j]!)))
    grid.push(t)
    vals.push(xs[j]! + (xs[j + 1]! - xs[j]!) * u)
  }
  if (grid[grid.length - 1] !== t1) {
    grid.push(t1)
    vals.push(xs[xs.length - 1]!)
  }
  // 两遍盒式滤波（每遍窗口 smoothMs/2）≈ 总过渡时长 smoothMs + 采样间隔，且缓入缓出
  const half = Math.max(0, Math.round(smoothMs / 4 / GRID_MS))
  const box = (v: number[]) =>
    v.map((_, i) => {
      let sum = 0
      let n = 0
      for (let k = Math.max(0, i - half); k <= Math.min(v.length - 1, i + half); k++) {
        sum += v[k]!
        n++
      }
      return sum / n
    })
  return { ts: grid, xs: half ? box(box(vals)) : vals }
}

/**
 * 横屏素材放进竖屏（或任意画幅）并跟随主体：生成平滑、带死区的 posX/posY/scale 关键帧。
 * scale 语义与 mask.ts layerBox 一致（1 = 完整放入画布），posX/posY 为图层中心在画布上的位置。
 * 没有检测结果时返回居中的单个关键帧（t=0）。关键帧已去掉共线的中间点。
 */
export function reframeTrack(
  samples: SubjectSample[],
  srcW: number,
  srcH: number,
  dstAspect: number,
  opts: ReframeOptions = {}
): ReframeKey[] {
  const smoothMs = opts.smoothMs ?? 800
  const deadZone = opts.deadZone ?? 0.08
  const zoom = Math.max(1, opts.zoom ?? 1)
  const scale = Math.round(coverScale(srcW, srcH, dstAspect) * zoom * 1000) / 1000
  const { bw, bh } = containFraction(srcW, srcH, dstAspect)
  const wn = bw * scale
  const hn = bh * scale
  const picked = pickSubjects(samples)
  if (!picked.length) return [{ t: 0, posX: 0.5, posY: 0.5, scale }]

  // 按镜头切点分段，各段独立防抖和平滑
  const cuts = [...(opts.cuts ?? [])].sort((a, b) => a - b)
  const segments: (typeof picked)[] = []
  /** 每段开始处的切点时间（第一段为 null）。 */
  const segCut: (number | null)[] = []
  let seg: typeof picked = []
  let ci = 0
  let pendingCut: number | null = null
  for (const p of picked) {
    while (ci < cuts.length && p.t >= cuts[ci]!) {
      if (seg.length) {
        segments.push(seg)
        segCut.push(segments.length === 1 ? null : pendingCut)
      }
      seg = []
      pendingCut = cuts[ci]!
      ci++
    }
    seg.push(p)
  }
  if (seg.length) {
    segments.push(seg)
    segCut.push(segments.length === 1 ? null : pendingCut)
  }

  const keys: ReframeKey[] = []
  const keep = new Set<number>()
  segments.forEach((s, si) => {
    const ts = s.map((p) => p.t)
    const face = s.filter((p) => p.kind === 'face').length * 2 >= s.length
    const sx = smoothOnGrid(ts, stabilize(s.map((p) => p.x), deadZone), smoothMs)
    const sy = smoothOnGrid(ts, stabilize(s.map((p) => p.y), deadZone), smoothMs)
    const segKeys = sx.ts.map((t, i) => {
      const pos = posForSubject(sx.xs[i]!, sy.xs[i]!, wn, hn, opts.anchorX ?? 0.5, face ? 0.4 : 0.5)
      return { t, posX: Math.round(pos.posX * 10000) / 10000, posY: Math.round(pos.posY * 10000) / 10000, scale }
    })
    const cut = segCut[si]
    const prev = keys[keys.length - 1]
    if (cut != null && prev && segKeys[0]) {
      // 切点处跳变：切点前 1ms 保持上一镜头取景，切点处直接到新取景
      const at = Math.max(prev.t + 1, Math.min(cut, segKeys[0].t))
      if (at - 1 > prev.t) keys.push({ ...prev, t: at - 1 })
      keep.add(at - 1)
      keep.add(at)
      if (segKeys[0].t > at) segKeys.unshift({ ...segKeys[0], t: at })
    }
    keys.push(...segKeys)
  })
  return simplifyKeys(keys, keep)
}

/** 去掉与前后两点共线（或不变）的中间关键帧；keep 里的时间点（切点两侧）保留。 */
function simplifyKeys(keys: ReframeKey[], keep: Set<number>): ReframeKey[] {
  if (keys.length <= 2) return keys
  const out: ReframeKey[] = [keys[0]!]
  for (let i = 1; i < keys.length - 1; i++) {
    const a = out[out.length - 1]!
    const b = keys[i]!
    const c = keys[i + 1]!
    if (keep.has(b.t)) {
      out.push(b)
      continue
    }
    const u = (b.t - a.t) / Math.max(1, c.t - a.t)
    const lin = (p: number, q: number) => p + (q - p) * u
    if (Math.abs(lin(a.posX, c.posX) - b.posX) > 0.002 || Math.abs(lin(a.posY, c.posY) - b.posY) > 0.002) out.push(b)
  }
  out.push(keys[keys.length - 1]!)
  return out
}
