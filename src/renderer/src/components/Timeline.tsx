import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { MediaAsset, SubtitleCue, Timeline, TimelineClip, TimelineOp } from '@shared/types'
import { clipBlend, clipFx, clipKind, timelineDurationMs } from '@shared/types'
import { sliceWaveform } from '@shared/audio'
import { overlayLanes } from '@shared/compose'
import { formatTimecode } from '../lib/format'

const PPS = 64
const HEIGHT_KEY = 'cut-studio-track-heights'

type TrackKey = 'video' | 'fx' | 'audio' | 'sub'

function loadHeights(): Record<TrackKey, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(HEIGHT_KEY) || '{}') as Partial<Record<TrackKey | 'overlay', number>>
    return {
      video: raw.video ?? 88,
      fx: raw.fx ?? (typeof raw.overlay === 'number' ? Math.max(40, raw.overlay) : 48),
      audio: raw.audio ?? 52,
      sub: raw.sub ?? 40
    }
  } catch {
    return { video: 88, fx: 48, audio: 52, sub: 40 }
  }
}

export function TimelineView({
  assets,
  timeline,
  playheadMs,
  selectedClipId,
  selectedCueId,
  onSeek,
  onSelectClip,
  onSelectCue,
  onOps,
  onDeleteClip
}: {
  assets: MediaAsset[]
  timeline: Timeline
  playheadMs: number
  selectedClipId: string | null
  selectedCueId: string | null
  onSeek: (ms: number) => void
  onSelectClip: (id: string | null) => void
  onSelectCue: (id: string | null) => void
  onOps: (ops: TimelineOp[], summary?: string) => void
  onDeleteClip?: (clipId: string) => void
}) {
  const duration = Math.max(10_000, timelineDurationMs(timeline) + 4000)
  const width = Math.max(800, (duration / 1000) * PPS)
  const laneRef = useRef<HTMLDivElement>(null)
  const [hoverMs, setHoverMs] = useState<number | null>(null)
  const [heights, setHeights] = useState(loadHeights)
  const wrapH = 6 + 26 + 3 + heights.video + heights.fx + heights.audio + heights.sub

  function dragHeight(key: TrackKey, startY: number, startH: number) {
    function move(ev: MouseEvent) {
      const next = Math.max(36, Math.min(240, startH + ev.clientY - startY))
      setHeights((s) => {
        const n = { ...s, [key]: next }
        localStorage.setItem(HEIGHT_KEY, JSON.stringify(n))
        return n
      })
    }
    function up() {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  const ticks = useMemo(() => {
    const out: number[] = []
    for (let t = 0; t <= duration; t += 2000) out.push(t)
    return out
  }, [duration])
  const layerLanes = useMemo(() => overlayLanes(timeline.overlays), [timeline.overlays])

  function msFromEvent(e: ReactMouseEvent) {
    const lane = laneRef.current
    if (!lane) return 0
    const x = e.clientX - lane.getBoundingClientRect().left + lane.parentElement!.scrollLeft - 76
    return Math.max(0, (x / PPS) * 1000)
  }

  return (
    <div className="timeline-wrap" style={{ height: wrapH }}>
      <div
        className="tl-grip"
        title="拖动改变视频轨道高度"
        onMouseDown={(e) => {
          e.preventDefault()
          dragHeight('video', e.clientY, heights.video)
        }}
      />
      <div className="ruler" style={{ width: width + 76 }} onMouseDown={(e) => onSeek(msFromEvent(e))}>
        {ticks.map((t) => (
          <span key={t} style={{ left: 76 + (t / 1000) * PPS }}>
            {formatTimecode(t)}
          </span>
        ))}
      </div>
      <div className="tracks" onMouseMove={(e) => setHoverMs(msFromEvent(e))}>
        <div className="playhead" style={{ left: 76 + (playheadMs / 1000) * PPS }} />
        <div className="track" style={{ height: heights.video }}>
          <div className="track-label">
            视频
            <span
              className="track-resize"
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                dragHeight('video', e.clientY, heights.video)
              }}
            />
          </div>
          <div
            className="lane"
            ref={laneRef}
            style={{ width }}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) {
                onSelectClip(null)
                onSeek(msFromEvent(e))
              }
            }}
          >
            {timeline.storyline.map((clip) => (
              <ClipBlock
                key={clip.id}
                clip={clip}
                name={assets.find((a) => a.id === clip.assetId)?.name ?? '片段'}
                peaks={sliceWaveform(
                  assets.find((a) => a.id === clip.assetId)?.index?.waveform,
                  assets.find((a) => a.id === clip.assetId)?.durationMs || clip.durationMs,
                  clip.inMs,
                  clip.outMs
                )}
                selected={selectedClipId === clip.id}
                onSelect={() => {
                  onSelectClip(clip.id)
                  onSelectCue(null)
                }}
                onSeek={onSeek}
                onTrim={(inMs, outMs) => onOps([{ op: 'trim_clip', clipId: clip.id, inMs, outMs }], '修剪片段')}
                onDelete={() => onDeleteClip?.(clip.id)}
              />
            ))}
          </div>
        </div>
        <div className="track fx-track" style={{ height: heights.fx }}>
          <div className="track-label">
            图层
            <span
              className="track-resize"
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                dragHeight('fx', e.clientY, heights.fx)
              }}
            />
          </div>
          <div className="lane fx-lane" style={{ width }}>
            {timeline.storyline.map((clip) => {
              const tags = fxTags(clip)
              if (!tags.length) return null
              return (
                <div
                  key={'fx-' + clip.id}
                  className="fx-bar"
                  style={{
                    left: (clip.startMs / 1000) * PPS,
                    width: Math.max(8, (clip.durationMs / 1000) * PPS)
                  }}
                  title={tags.join(' · ')}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    onSelectClip(clip.id)
                    onSelectCue(null)
                    onSeek(clip.startMs)
                  }}
                >
                  {tags.join(' · ')}
                </div>
              )
            })}
            {timeline.overlays.map((clip, i) => {
              const lane = layerLanes[i] ?? 0
              const laneCount = Math.max(1, ...layerLanes.map((n) => n + 1), 1)
              const kind = clipKind(clip)
              const name =
                kind === 'adjustment'
                  ? '调整层'
                  : kind === 'solid'
                    ? `纯色 ${clip.solidColor || ''}`
                    : kind === 'text'
                      ? clip.text?.text?.slice(0, 12) || '文字'
                      : kind === 'shape'
                        ? clip.shape?.shape === 'ellipse' ? '椭圆' : '矩形'
                        : assets.find((a) => a.id === clip.assetId)?.name ?? '图层'
              return (
                <ClipBlock
                  key={clip.id}
                  clip={clip}
                  name={name}
                  selected={selectedClipId === clip.id}
                  lane={lane}
                  laneCount={laneCount}
                  onSelect={() => {
                    onSelectClip(clip.id)
                    onSelectCue(null)
                  }}
                  onSeek={onSeek}
                  onTrim={(inMs, outMs) => onOps([{ op: 'trim_clip', clipId: clip.id, inMs, outMs }], '修剪图层')}
                  onDelete={() => onDeleteClip?.(clip.id)}
                />
              )
            })}
          </div>
        </div>
        <div className="track-split" />
        <div className="track sub narrow" style={{ height: heights.audio }}>
          <div className="track-label">
            音频
            <span
              className="track-resize"
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                dragHeight('audio', e.clientY, heights.audio)
              }}
            />
          </div>
          <div className="lane" style={{ width }}>
            {timeline.audio.map((clip) => (
              <ClipBlock
                key={clip.id}
                clip={clip}
                name={assets.find((a) => a.id === clip.assetId)?.name ?? '音乐'}
                peaks={sliceWaveform(
                  assets.find((a) => a.id === clip.assetId)?.index?.waveform,
                  assets.find((a) => a.id === clip.assetId)?.durationMs || clip.durationMs,
                  clip.inMs,
                  clip.outMs
                )}
                selected={selectedClipId === clip.id}
                onSelect={() => {
                  onSelectClip(clip.id)
                  onSelectCue(null)
                }}
                onSeek={onSeek}
                onTrim={(inMs, outMs) => onOps([{ op: 'trim_clip', clipId: clip.id, inMs, outMs }], '修剪音频')}
                onDelete={() => onDeleteClip?.(clip.id)}
              />
            ))}
          </div>
        </div>
        <div className="track sub narrow" style={{ height: heights.sub }}>
          <div className="track-label">
            字幕
            <span
              className="track-resize"
              onMouseDown={(e) => {
                e.preventDefault()
                e.stopPropagation()
                dragHeight('sub', e.clientY, heights.sub)
              }}
            />
          </div>
          <div
            className="lane"
            style={{ width }}
            onDoubleClick={(e) => {
              const start = msFromEvent(e)
              const text = window.prompt('字幕内容', '')
              if (!text) return
              onOps([{ op: 'add_subtitle', startMs: start, endMs: start + 2000, text }], '手写字幕')
            }}
          >
            {timeline.subtitles.map((cue) => (
              <CueBlock
                key={cue.id}
                cue={cue}
                selected={selectedCueId === cue.id}
                onSelect={() => {
                  onSelectCue(cue.id)
                  onSelectClip(null)
                }}
                onEdit={(text) => onOps([{ op: 'update_subtitle', id: cue.id, text }], '改字幕')}
                onRemove={() => onOps([{ op: 'remove_subtitle', id: cue.id }], '删字幕')}
              />
            ))}
          </div>
        </div>
        {hoverMs != null ? (
          <div className="playhead" style={{ left: 76 + (hoverMs / 1000) * PPS, opacity: 0.25 }} />
        ) : null}
      </div>
    </div>
  )
}

function Waveform({ peaks }: { peaks: number[] }) {
  if (peaks.length < 2) return null
  const w = Math.max(2, peaks.length)
  const h = 32
  let d = `M 0 ${h}`
  for (let i = 0; i < peaks.length; i++) {
    const x = (i / (peaks.length - 1)) * w
    const y = h - Math.min(1, Math.max(0, peaks[i] ?? 0)) * h
    d += ` L ${x.toFixed(1)} ${y.toFixed(1)}`
  }
  d += ` L ${w} ${h} Z`
  return (
    <svg className="clip-wave" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <path d={d} />
    </svg>
  )
}

function ClipBlock({
  clip,
  name,
  selected,
  onSelect,
  onSeek,
  onTrim,
  onDelete,
  lane = 0,
  laneCount = 1,
  peaks
}: {
  clip: TimelineClip
  name: string
  selected: boolean
  onSelect: () => void
  onSeek: (ms: number) => void
  onTrim: (inMs: number, outMs: number) => void
  onDelete?: () => void
  lane?: number
  laneCount?: number
  peaks?: number[]
}) {
  const left = (clip.startMs / 1000) * PPS
  const width = Math.max(8, (clip.durationMs / 1000) * PPS)
  const kind = clipKind(clip)
  const h = 100 / laneCount
  return (
    <div
      className={
        'clip' +
        (clip.source !== 'human' ? ' ai' : '') +
        (selected ? ' selected' : '') +
        (kind === 'solid' ? ' solid' : '') +
        (kind === 'adjustment' ? ' adjust' : '') +
        (kind === 'text' ? ' text' : '') +
        (kind === 'shape' ? ' shape' : '')
      }
      style={{
        left,
        width,
        top: `calc(${lane * h}% + 4px)`,
        height: `calc(${h}% - 8px)`
      }}
      onMouseDown={(e) => {
        e.stopPropagation()
        onSelect()
        onSeek(clip.startMs)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        onSelect()
        onDelete?.()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault()
          e.stopPropagation()
          onDelete?.()
        }
      }}
    >
      <span className="handle l" onMouseDown={(e) => startTrim(e, clip, 'l', onTrim)} />
      {peaks?.length ? <Waveform peaks={peaks} /> : null}
      <span className="clip-name">{name}</span>
      {selected ? (
        <button
          type="button"
          className="clip-del"
          title="删除"
          onMouseDown={(e) => {
            e.stopPropagation()
            e.preventDefault()
          }}
          onClick={(e) => {
            e.stopPropagation()
            onDelete?.()
          }}
        >
          ×
        </button>
      ) : null}
      <span className="handle r" onMouseDown={(e) => startTrim(e, clip, 'r', onTrim)} />
    </div>
  )
}

function fxTags(clip: TimelineClip): string[] {
  const fx = clipFx(clip)
  const tags: string[] = []
  if (fx.filter === 'vivid') tags.push('鲜艳')
  if (fx.filter === 'cinema') tags.push('电影')
  if (fx.filter === 'bw') tags.push('黑白')
  if (fx.filter === 'vintage') tags.push('复古')
  if (Math.abs(fx.speed - 1) > 0.01) tags.push(`${fx.speed.toFixed(2)}x`)
  if (fx.transitionOut.type === 'cross_dissolve') tags.push('柔和溶解')
  if (fx.transitionOut.type === 'dissolve') tags.push('颗粒溶解')
  if (fx.transitionOut.type === 'fade_black') tags.push('淡出黑')
  if (fx.transitionOut.type === 'fade_white') tags.push('淡出白')
  if (fx.transitionOut.type === 'dip_black') tags.push('暗场')
  if (fx.transitionOut.type === 'push') tags.push('右推')
  if (fx.transitionOut.type === 'slide_left') tags.push('左滑')
  if (fx.transitionOut.type === 'smooth_wipe') tags.push('柔擦')
  if (fx.transitionOut.type === 'wipe_up') tags.push('上擦')
  if (fx.transitionOut.type === 'cover') tags.push('盖入')
  if (fx.transitionOut.type === 'reveal') tags.push('揭开')
  if (fx.transitionOut.type === 'zoom') tags.push('推近')
  if (fx.transitionOut.type === 'iris') tags.push('圆形')
  if (fx.transitionOut.type === 'blur_mix') tags.push('模糊过渡')
  if (fx.rotate) tags.push(`${fx.rotate}°`)
  if (fx.flipX) tags.push('翻转')
  if (fx.crop) tags.push('裁切')
  if (fx.fadeInMs || fx.fadeOutMs) tags.push('淡化')
  const blend = clipBlend(clip)
  if (blend === 'add') tags.push('相加')
  if (blend === 'screen') tags.push('滤色')
  if (blend === 'multiply') tags.push('正片')
  if (clipKind(clip) === 'adjustment') tags.push('调整')
  if (clipKind(clip) === 'solid') tags.push('纯色')
  if (clipKind(clip) === 'text') tags.push(clip.textAnim === 'typewriter' ? '打字机' : '文字')
  if (clipKind(clip) === 'shape') tags.push('形状')
  if (fx.masks.length) tags.push('蒙版')
  if (fx.keys?.opacity?.length || fx.keys?.scale?.length || fx.keys?.posX?.length || fx.keys?.posY?.length || fx.keys?.volume?.length)
    tags.push('关键帧')
  if (fx.audioLink) tags.push('鼓点')
  if (fx.denoise?.enabled) tags.push('降噪')
  if (fx.freeze) tags.push('冻结')
  if (fx.reverse) tags.push('倒放')
  if (fx.stabilize?.enabled) tags.push('稳像')
  if (fx.key) tags.push(fx.key.color === '#0000ff' ? '蓝幕' : '抠像')
  for (const e of fx.effects) {
    if (e.enabled === false) continue
    if (e.type === 'blur') tags.push('模糊')
    else if (e.type === 'radial_blur') tags.push('径向')
    else if (e.type === 'glow') tags.push('发光')
    else if (e.type === 'grain') tags.push('颗粒')
    else if (e.type === 'mosaic') tags.push('马赛克')
    else if (e.type === 'lut') tags.push('LUT')
  }
  const c = fx.color
  if (c.exposure || c.contrast || c.saturation || c.warmth) tags.push('调色')
  return tags
}

function CueBlock({
  cue,
  selected,
  onSelect,
  onEdit,
  onRemove
}: {
  cue: SubtitleCue
  selected: boolean
  onSelect: () => void
  onEdit: (text: string) => void
  onRemove: () => void
}) {
  const left = (cue.startMs / 1000) * PPS
  const width = Math.max(8, ((cue.endMs - cue.startMs) / 1000) * PPS)
  return (
    <div
      className={'cue' + (selected ? ' selected' : '')}
      style={{ left, width }}
      onMouseDown={(e) => {
        e.stopPropagation()
        onSelect()
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        const next = window.prompt('编辑字幕', cue.text)
        if (next == null) return
        if (!next.trim()) onRemove()
        else onEdit(next)
      }}
    >
      {cue.text}
    </div>
  )
}

function startTrim(
  e: ReactMouseEvent,
  clip: TimelineClip,
  edge: 'l' | 'r',
  onTrim: (inMs: number, outMs: number) => void
) {
  e.stopPropagation()
  e.preventDefault()
  const startX = e.clientX
  const origIn = clip.inMs
  const origOut = clip.outMs
  let lastIn = origIn
  let lastOut = origOut
  function move(ev: MouseEvent) {
    const deltaMs = ((ev.clientX - startX) / PPS) * 1000
    if (edge === 'l') {
      lastIn = Math.max(0, origIn + deltaMs)
      lastOut = origOut
    } else {
      lastIn = origIn
      lastOut = Math.max(origIn + 200, origOut + deltaMs)
    }
  }
  function up() {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    if (lastIn !== origIn || lastOut !== origOut) onTrim(lastIn, lastOut)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}
