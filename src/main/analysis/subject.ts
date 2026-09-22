import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { join } from 'node:path'
import type { SubjectSample } from '../../shared/reframe'
import { userDataDir } from '../paths'

export type { SubjectSample } from '../../shared/reframe'

/**
 * macOS Vision 主体检测的小工具源码。内嵌在 TS 里，避免打包后找不到 .swift 文件；
 * 首次使用时 swiftc 编译到 userDataDir()/bin/cs-subject-<hash>，源码变了会自动重编。
 * 用法：cs-subject <video> <intervalMs> <startMs> <endMs|-1>
 * 输出：JSON [{t, x, y, w, h, kind, confidence}]，t 为源时间毫秒，坐标 0–1、原点左上。
 */
export const SWIFT_SOURCE = String.raw`
import AVFoundation
import Foundation
import Vision

struct Sample: Codable {
  let t: Int
  let x: Double
  let y: Double
  let w: Double
  let h: Double
  let kind: String
  let confidence: Double
}

func fail(_ msg: String) -> Never {
  FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
  exit(2)
}

let args = CommandLine.arguments
if args.count < 5 { fail("usage: cs-subject <video> <intervalMs> <startMs> <endMs|-1>") }
let url = URL(fileURLWithPath: args[1])
let interval = max(40, Int(args[2]) ?? 500)
let startMs = max(0, Int(args[3]) ?? 0)
let asset = AVURLAsset(url: url)
let durationMs = Int(CMTimeGetSeconds(asset.duration) * 1000)
if durationMs <= 0 { fail("no duration") }
var endMs = Int(args[4]) ?? -1
if endMs < 0 || endMs > durationMs { endMs = durationMs }

let gen = AVAssetImageGenerator(asset: asset)
gen.appliesPreferredTrackTransform = true
gen.maximumSize = CGSize(width: 640, height: 640)
let tol = CMTime(value: CMTimeValue(min(interval / 2, 100)), timescale: 1000)
gen.requestedTimeToleranceBefore = tol
gen.requestedTimeToleranceAfter = tol

var out: [Sample] = []
var t = startMs
while t < endMs {
  let time = CMTime(value: CMTimeValue(t), timescale: 1000)
  if let image = try? gen.copyCGImage(at: time, actualTime: nil) {
    let faces = VNDetectFaceRectanglesRequest()
    let bodies = VNDetectHumanRectanglesRequest()
    bodies.upperBodyOnly = false
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try? handler.perform([faces, bodies])
    for f in faces.results ?? [] {
      let b = f.boundingBox
      out.append(Sample(t: t, x: b.minX, y: 1 - b.maxY, w: b.width, h: b.height, kind: "face", confidence: Double(f.confidence)))
    }
    for p in bodies.results ?? [] {
      let b = p.boundingBox
      out.append(Sample(t: t, x: b.minX, y: 1 - b.maxY, w: b.width, h: b.height, kind: "body", confidence: Double(p.confidence)))
    }
  }
  t += interval
}
let data = try JSONEncoder().encode(out)
FileHandle.standardOutput.write(data)
`

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()))
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 64_000) stderr = stderr.slice(-16_000)
    })
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 1, stdout, stderr: String(e) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, stdout, stderr })
    })
  })
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

let building: Promise<string | null> | null = null
let lastBuildError = ''

/** 最近一次编译失败的 swiftc 输出（诊断用）。 */
export function subjectBuildError(): string {
  return lastBuildError
}

/** 确保检测工具已编译；没有 swiftc 或编译失败返回 null。 */
export function ensureSubjectTool(): Promise<string | null> {
  if (process.platform !== 'darwin') return Promise.resolve(null)
  building ??= (async () => {
    const hash = createHash('sha1').update(SWIFT_SOURCE).digest('hex').slice(0, 10)
    const dir = join(userDataDir(), 'bin')
    const bin = join(dir, `cs-subject-${hash}`)
    if (await exists(bin)) return bin
    await mkdir(dir, { recursive: true })
    const src = join(dir, `vision-subject-${hash}.swift`)
    await writeFile(src, SWIFT_SOURCE, 'utf8')
    const r = await run('xcrun', ['swiftc', '-O', src, '-o', bin], 300_000)
    if (r.code !== 0 || !(await exists(bin))) {
      lastBuildError = r.stderr.slice(-4000)
      return null
    }
    return bin
  })()
  const p = building
  // 失败时允许下次重试（比如用户刚装好 Command Line Tools）
  void p.then((bin) => {
    if (!bin && building === p) building = null
  })
  return p
}

/**
 * 用 Vision 检测视频里的人脸 / 人体。返回 null 表示工具不可用或检测失败（不抛错）。
 */
export async function detectSubjects(
  path: string,
  opts: { intervalMs?: number; startMs?: number; endMs?: number } = {}
): Promise<SubjectSample[] | null> {
  try {
    const bin = await ensureSubjectTool()
    if (!bin) return null
    const interval = Math.max(40, Math.round(opts.intervalMs ?? 500))
    const start = Math.max(0, Math.round(opts.startMs ?? 0))
    const end = opts.endMs != null ? Math.round(opts.endMs) : -1
    const span = end > 0 ? end - start : 3_600_000
    const timeout = Math.max(60_000, Math.min(3_600_000, (span / interval) * 2000))
    const r = await run(bin, [path, String(interval), String(start), String(end)], timeout)
    if (r.code !== 0) return null
    const parsed = JSON.parse(r.stdout) as SubjectSample[]
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}
