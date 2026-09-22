import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { clipFx } from '../../shared/types'
import { clipText, textScale, visibleText } from '../../shared/text'
import type { Project, TimelineClip } from '../../shared/types'
import { DEFAULT_BOX_COLOR, DEFAULT_BOX_OPACITY, DEFAULT_HIGHLIGHT, karaokeLines, keywordRuns, subtitlePreset, wrapSubtitleText } from '../../shared/subtitle'
import { findFfmpeg, runFfmpeg } from './ffmpeg'

const PY = `#!/usr/bin/env python3
import json, sys, os
from PIL import Image, ImageDraw, ImageFont

def rgba(h):
    h = (h or "#ffffff").lstrip("#")
    if len(h) == 3:
        h = "".join(c*2 for c in h)
    if len(h) < 6:
        h = "ffffff"
    return (int(h[0:2],16), int(h[2:4],16), int(h[4:6],16), 255)

def font(size):
    cands = [
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/STHeiti Light.ttc",
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ]
    for p in cands:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size, index=0)
            except Exception:
                continue
    return ImageFont.load_default()

def draw_frame(job, text, dest):
    W, H = int(job["width"]), int(job["height"])
    img = Image.new("RGBA", (W, H), (0,0,0,0))
    d = ImageDraw.Draw(img)
    size = max(12, int(job["fontSize"]))
    f = font(size)
    fill = rgba(job.get("color") or "#ffffff")
    stroke = rgba(job.get("stroke") or "#000000")
    sw = int(job.get("strokeWidth") or 3)
    x = float(job.get("posX") or 0.5) * W
    y = float(job.get("posY") or 0.45) * H
    align = job.get("align") or "center"
    anchor = "lm" if align == "left" else "rm" if align == "right" else "mm"
    d.text((x, y), text, font=f, fill=fill, stroke_width=sw, stroke_fill=stroke, anchor=anchor)
    img.save(dest)

def draw_subtitle(job):
    # 与导出的 ASS 保持一致：字号、描边 / 底框、位置（底部 / 顶部边距 8%，居中），keyword 放大 1.15
    W, H = int(job["width"]), int(job["height"])
    img = Image.new("RGBA", (W, H), (0,0,0,0))
    d = ImageDraw.Draw(img)
    size = max(12, int(job["fontSize"]))
    stroke = rgba(job.get("stroke") or "#000000")
    sw = int(round(float(job.get("strokeWidth") or 0)))
    box = job.get("box")
    lines = job.get("lines") or []
    measured = []
    for runs in lines:
        items = []
        lw = 0
        lh = 0
        for r in runs:
            f = font(max(12, int(size * float(r.get("scale") or 1))))
            bb = d.textbbox((0, 0), r["text"], font=f, anchor="ls", stroke_width=sw)
            w = d.textlength(r["text"], font=f)
            items.append((r, f, w))
            lw += w
            lh = max(lh, bb[3] - bb[1])
        measured.append((items, lw, max(lh, size)))
    gap = int(size * 0.2)
    pad = int(job.get("boxPad") or 0)
    block = sum(m[2] for m in measured) + gap * max(0, len(measured) - 1)
    pos = job.get("position") or "bottom"
    margin = int(H * 0.08)
    top = (H - block) // 2 if pos == "center" else margin if pos == "top" else H - margin - block
    y = top
    for items, lw, lh in measured:
        x = (W - lw) / 2
        base = y + lh * 0.82
        if box:
            c = rgba(box["color"])
            a = int(255 * float(box["opacity"]))
            d.rectangle([x - pad, y - pad, x + lw + pad, y + lh + pad], fill=(c[0], c[1], c[2], a))
        for r, f, w in items:
            d.text((x, base), r["text"], font=f, fill=rgba(r.get("color") or "#ffffff"), stroke_width=sw, stroke_fill=stroke, anchor="ls")
            x += w
        y += lh + gap
    img.save(job["out"])

job = json.loads(sys.argv[1])
mode = job.get("mode") or "png"
if mode == "subtitle":
    draw_subtitle(job)
elif mode == "png":
    draw_frame(job, job.get("text") or "", job["out"])
elif mode == "typewriter":
    os.makedirs(job["outDir"], exist_ok=True)
    chars = list(job.get("text") or "")
    fps = max(1, int(job.get("fps") or 30))
    dur = max(0.1, float(job.get("durationS") or 3))
    n = max(1, int(round(dur * fps)))
    for i in range(n):
        t01 = i / max(1, n - 1)
        reveal = min(1.0, t01 / 0.7)
        k = int(len(chars) * reveal + 1e-6)
        vis = "".join(chars[:k])
        draw_frame(job, vis, os.path.join(job["outDir"], f"{i:04d}.png"))
`

function runPython(job: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', ['-c', PY, JSON.stringify(job)], { stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    child.stderr.on('data', (d) => {
      err += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(err.slice(-600) || '文字渲染失败'))
    })
  })
}

export type BakedText = { path: string; seq?: boolean }

export async function bakeTextLayers(
  clips: TimelineClip[],
  dir: string,
  width: number,
  height: number,
  fps: number
): Promise<Map<string, BakedText>> {
  const map = new Map<string, BakedText>()
  for (const clip of clips) {
    if ((clip.kind ?? 'footage') !== 'text' || !clip.text?.text) continue
    const t = clipText(clip)
    const fx = clipFx(clip)
    const size = Math.round((t.fontSize || 72) * textScale(width, height) * (fx.scale || 1))
    const base = {
      width,
      height,
      fontSize: size,
      color: t.color,
      stroke: t.stroke,
      strokeWidth: t.strokeWidth,
      posX: fx.posX,
      posY: fx.posY,
      align: t.align,
      text: t.text
    }
    if (clip.textAnim === 'typewriter') {
      const outDir = join(dir, `text_${clip.id}`)
      await mkdir(outDir, { recursive: true })
      await runPython({
        ...base,
        mode: 'typewriter',
        outDir,
        fps,
        durationS: clip.durationMs / 1000
      })
      const ffmpeg = await findFfmpeg()
      if (!ffmpeg) throw new Error('没有 ffmpeg')
      const mov = join(dir, `text_${clip.id}.mov`)
      const r = await runFfmpeg(ffmpeg, [
        '-y',
        '-framerate',
        String(fps),
        '-i',
        join(outDir, '%04d.png'),
        '-c:v',
        'png',
        '-pix_fmt',
        'rgba',
        mov
      ])
      if (r.code !== 0) throw new Error(r.stderr.slice(-500) || '打字机序列失败')
      map.set(clip.id, { path: mov })
    } else {
      const png = join(dir, `text_${clip.id}.png`)
      await runPython({ ...base, mode: 'png', out: png })
      map.set(clip.id, { path: png })
    }
  }
  return map
}

export async function bakeTextFrame(clip: TimelineClip, width: number, height: number, timeMs: number, dest: string): Promise<void> {
  const t = clipText(clip)
  const fx = clipFx(clip)
  const size = Math.round((t.fontSize || 72) * textScale(width, height) * (fx.scale || 1))
  await runPython({
    mode: 'png',
    out: dest,
    width,
    height,
    fontSize: size,
    color: t.color,
    stroke: t.stroke,
    strokeWidth: t.strokeWidth,
    posX: fx.posX,
    posY: fx.posY,
    align: t.align,
    text: visibleText(clip, timeMs)
  })
}

/**
 * 把 timeMs 时刻的字幕画成整幅透明 PNG（给 get_frame / contact_sheet 看字幕遮挡用）。没有字幕时返回 false。
 * 参数与 graph.ts assDocument 对应：clean 描边、boxed 底框、keyword 关键词变色放大、karaoke 已读词变色。
 */
export async function bakeSubtitleFrame(project: Project, width: number, height: number, timeMs: number, dest: string): Promise<boolean> {
  const raw = project.timeline.subtitles.find((c) => timeMs >= c.startMs && timeMs < c.endMs)
  if (!raw || !raw.text.trim()) return false
  const style = project.subtitleStyle
  const cue = { ...raw, text: wrapSubtitleText(raw.text, style, width, height) }
  const preset = subtitlePreset(style)
  const fontSize = Math.round((style.fontSize || 42) * textScale(width, height))
  const color = style.color || '#ffffff'
  const highlight = style.highlightColor || DEFAULT_HIGHLIGHT
  type Run = { text: string; color: string; scale?: number }
  let lines: Run[][] = cue.text.split('\n').map((line) => [{ text: line, color }])
  if (preset === 'keyword' && style.keywords?.length) {
    lines = cue.text.split('\n').map((line) => keywordRuns(line, style.keywords).map((r) => ({ text: r.text, color: r.hit ? highlight : color, scale: r.hit ? 1.15 : 1 })))
  } else if (preset === 'karaoke') {
    const kl = karaokeLines(cue)
    if (kl) lines = kl.map((runs) => runs.map((r) => ({ text: r.text, color: r.startMs != null && r.startMs <= timeMs ? highlight : color })))
  }
  const boxed = preset === 'boxed'
  await runPython({
    mode: 'subtitle',
    out: dest,
    width,
    height,
    fontSize,
    lines,
    position: style.position,
    stroke: style.stroke || '#000000',
    strokeWidth: boxed ? 0 : Math.max(1, Math.round(fontSize / 24)),
    box: boxed ? { color: style.boxColor || DEFAULT_BOX_COLOR, opacity: style.boxOpacity ?? DEFAULT_BOX_OPACITY } : null,
    boxPad: boxed ? Math.max(4, Math.round(fontSize * 0.22)) : 0
  })
  return true
}
