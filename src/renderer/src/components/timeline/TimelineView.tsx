import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as RME, type MutableRefObject } from 'react'
import type { MediaAsset, SubtitleCue, Timeline, TimelineClip, TimelineMarker, TimelineOp } from '@shared/types'
import { clipFx, clipKind, timelineDurationMs } from '@shared/types'
import { sliceWaveform } from '@shared/audio'
import { overlayLanes } from '@shared/compose'
import { snapBlock, snapCandidates, snapMs, storylineInsertMs, storylineOrderAfterDrag, tickStepMs } from '@shared/tlsnap'
import { formatTimecode, mediaUrl } from '../../lib/format'
import { useContextMenu, type MenuItem } from '../ContextMenu'
import { Icon } from '../Icon'
import { fxTags, transitionLabel } from './tags'

export type TimelineApi = { zoomIn: () => void; zoomOut: () => void; fit: () => void }

type Track = 'story' | 'overlay' | 'audio' | 'sub'
type TrackKey = 'video' | 'fx' | 'audio' | 'sub'
type Act = (name: string, args?: Record<string, unknown>) => void

type Drag = {
  id: string
  track: Track
  mode: 'move' | 'trimL' | 'trimR'
  startX: number
  moved: boolean
  origStart: number
  origDur: number
  origIn: number
  origOut: number
  speed: number
  maxOut: number
  start: number
  dur: number
  guide: number | null
  insertMs?: number
}

type Edit = { id: string | null; startMs: number; endMs: number; text: string }

const LABEL = 76
const PPS_KEY = 'cut-studio-tl-pps'
const HEIGHT_KEY = 'cut-studio-track-heights'
const MIN_PPS = 4
const MAX_PPS = 400
const MIN_DUR = 100

function loadHeights(): Record<TrackKey, number> {
  try {
    const raw = JSON.parse(localStorage.getItem(HEIGHT_KEY) || '{}') as Partial<Record<TrackKey, number>>
    return { video: raw.video ?? 72, fx: raw.fx ?? 40, audio: raw.audio ?? 48, sub: raw.sub ?? 34 }
  } catch {
    return { video: 72, fx: 40, audio: 48, sub: 34 }
  }
}

function loadPps(): number {
  const v = Number(localStorage.getItem(PPS_KEY))
  return Number.isFinite(v) && v >= MIN_PPS && v <= MAX_PPS ? v : 64
}

const end = (c: { startMs: number; durationMs: number }) => c.startMs + c.durationMs

export function TimelineView({
  assets,
  timeline,
  markers,
  playheadMs,
  playing,
  selectedClipId,
  selectedCueId,
  selectedAssetId,
  range,
  snapping,
  apiRef,
  onSeek,
  onSelectClip,
  onSelectCue,
  onOps,
  onAction,
  onDeleteClip,
  onSetRange,
  onAddMarker,
  onToggleSnap
}: {
  assets: MediaAsset[]
  timeline: Timeline
  markers: TimelineMarker[]
  playheadMs: number
  playing: boolean
  selectedClipId: string | null
  selectedCueId: string | null
  selectedAssetId: string | null
  range: { inMs: number | null; outMs: number | null }
  snapping: boolean
  apiRef: MutableRefObject<TimelineApi | null>
  onSeek: (ms: number) => void
  onSelectClip: (id: string | null) => void
  onSelectCue: (id: string | null) => void
  onOps: (ops: TimelineOp[], summary?: string) => void
  onAction: Act
  onDeleteClip: (clipId: string) => void
  onSetRange: (patch: { inMs?: number | null; outMs?: number | null }) => void
  onAddMarker: (atMs: number) => void
  onToggleSnap: () => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pps, setPpsState] = useState(loadPps)
  const ppsRef = useRef(pps)
  ppsRef.current = pps
  const anchorRef = useRef<{ ms: number; x: number } | null>(null)
  const [viewW, setViewW] = useState(800)
  const [heights, setHeights] = useState(loadHeights)
  const [hoverMs, setHoverMs] = useState<number | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [edit, setEdit] = useState<Edit | null>(null)
  const editRef = useRef<Edit | null>(null)
  editRef.current = edit
  const menu = useContextMenu()

  const assetOf = (id: string) => assets.find((a) => a.id === id)
  const contentMs = Math.max(
    timelineDurationMs(timeline),
    ...timeline.audio.map(end),
    ...timeline.subtitles.map((c) => c.endMs),
    ...markers.map((m) => m.atMs),
    0
  )
  const width = Math.max(viewW - LABEL, ((contentMs + 5000) / 1000) * pps)
  const x = (ms: number) => (ms / 1000) * pps
  const layerLanes = useMemo(() => overlayLanes(timeline.overlays), [timeline.overlays])
  const laneCount = Math.max(1, ...layerLanes.map((n) => n + 1))

  function setPps(next: number, anchorClientX?: number) {
    const clamped = Math.max(MIN_PPS, Math.min(MAX_PPS, next))
    const el = scrollRef.current
    if (el) {
      const rect = el.getBoundingClientRect()
      const cx = anchorClientX ?? rect.left + LABEL + (el.clientWidth - LABEL) / 2
      const ms = ((cx - rect.left + el.scrollLeft - LABEL) / ppsRef.current) * 1000
      anchorRef.current = { ms: Math.max(0, ms), x: cx - rect.left }
    }
    setPpsState(clamped)
    try {
      localStorage.setItem(PPS_KEY, String(clamped))
    } catch {
      /* ignore */
    }
  }

  // 缩放后保持锚点（光标或视窗中心）下的时间不动
  useLayoutEffect(() => {
    const el = scrollRef.current
    const a = anchorRef.current
    if (!el || !a) return
    anchorRef.current = null
    el.scrollLeft = Math.max(0, (a.ms / 1000) * pps + LABEL - a.x)
  }, [pps])

  const fit = () => {
    const el = scrollRef.current
    const avail = (el?.clientWidth ?? viewW) - LABEL - 24
    const next = avail / Math.max(1, (contentMs || 10_000) / 1000)
    anchorRef.current = { ms: 0, x: LABEL }
    setPps(next)
    anchorRef.current = { ms: 0, x: LABEL }
  }
  apiRef.current = { zoomIn: () => setPps(pps * 1.25), zoomOut: () => setPps(pps / 1.25), fit }

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewW(el.clientWidth))
    ro.observe(el)
    // ctrl/⌘ + 滚轮、触控板双指捏合：以光标为中心缩放
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      setPps(ppsRef.current * Math.exp(-e.deltaY * 0.01), e.clientX)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => {
      ro.disconnect()
      el.removeEventListener('wheel', wheel)
    }
  }, [])

  // 播放时让播放头保持在视野里
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !playing) return
    const px = x(playheadMs) + LABEL
    if (px > el.scrollLeft + el.clientWidth - 40 || px < el.scrollLeft + LABEL) el.scrollLeft = Math.max(0, px - LABEL - 40)
  }, [playheadMs, playing])

  function msAt(clientX: number): number {
    const el = scrollRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return Math.max(0, ((clientX - rect.left + el.scrollLeft - LABEL) / ppsRef.current) * 1000)
  }

  function dragHeight(key: TrackKey, startY: number, startH: number) {
    function move(ev: MouseEvent) {
      const next = Math.max(26, Math.min(220, startH + ev.clientY - startY))
      setHeights((s) => {
        const n = { ...s, [key]: next }
        try {
          localStorage.setItem(HEIGHT_KEY, JSON.stringify(n))
        } catch {
          /* ignore */
        }
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

  /** 按住拖动标尺：连续定位。 */
  function scrub(e: RME) {
    if (e.button !== 0) return
    onSeek(msAt(e.clientX))
    const move = (ev: MouseEvent) => onSeek(msAt(ev.clientX))
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  function beginDrag(e: RME, track: Track, item: TimelineClip | SubtitleCue, mode: Drag['mode']) {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    if (edit) return
    const isCue = track === 'sub'
    const clip = isCue ? null : (item as TimelineClip)
    const cue = isCue ? (item as SubtitleCue) : null
    if (cue) {
      onSelectCue(cue.id)
      onSelectClip(null)
    } else {
      onSelectClip(item.id)
      onSelectCue(null)
    }
    const origStart = item.startMs
    const origDur = cue ? cue.endMs - cue.startMs : clip!.durationMs
    const asset = clip ? assetOf(clip.assetId) : undefined
    const d: Drag = {
      id: item.id,
      track,
      mode,
      startX: e.clientX,
      moved: false,
      origStart,
      origDur,
      origIn: clip?.inMs ?? 0,
      origOut: clip?.outMs ?? 0,
      speed: clip ? Math.max(0.05, clipFx(clip).speed || 1) : 1,
      maxOut: clip && asset && (asset.kind === 'video' || asset.kind === 'audio') && asset.durationMs > 0 ? asset.durationMs : Infinity,
      start: origStart,
      dur: origDur,
      guide: null
    }
    const cands = snapping
      ? snapCandidates(timeline, { markers, playheadMs, extra: [range.inMs, range.outMs], excludeIds: [item.id] })
      : []
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - d.startX
      if (!d.moved && Math.abs(dx) < 3) return
      d.moved = true
      const dms = (dx / ppsRef.current) * 1000
      const thr = snapping && !ev.metaKey ? (8 / ppsRef.current) * 1000 : -1
      if (mode === 'move') {
        if (track === 'story') {
          d.start = Math.max(0, origStart + dms)
          d.insertMs = storylineInsertMs(timeline.storyline, d.id, msAt(ev.clientX))
          d.guide = null
        } else {
          const r = snapBlock(origStart + dms, origDur, cands, thr)
          d.start = r.startMs
          d.guide = r.guide
        }
      } else if (mode === 'trimR') {
        const s = snapMs(origStart + origDur + dms, cands, thr)
        const maxDur = (d.maxOut - d.origIn) / d.speed
        d.dur = Math.max(MIN_DUR, Math.min(maxDur, s.ms - origStart))
        d.start = origStart
        d.guide = s.snapped
      } else {
        const s = snapMs(origStart + dms, cands, thr)
        const lo = cue ? -origStart : -d.origIn / d.speed
        const delta = Math.max(lo, Math.min(origDur - MIN_DUR, s.ms - origStart))
        d.start = origStart + delta
        d.dur = origDur - delta
        d.guide = s.snapped
      }
      setDrag({ ...d })
    }
    const up = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      setDrag(null)
      if (!d.moved) {
        onSeek(msAt(ev.clientX))
        return
      }
      commitDrag(d, ev)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  function commitDrag(d: Drag, ev: MouseEvent) {
    if (d.track === 'sub') {
      onOps([{ op: 'update_subtitle', id: d.id, startMs: Math.round(d.start), endMs: Math.round(d.start + d.dur) }], d.mode === 'move' ? '移动字幕' : '调字幕时间')
      return
    }
    if (d.mode === 'move') {
      if (d.track === 'story') {
        const order = storylineOrderAfterDrag(timeline.storyline, d.id, msAt(ev.clientX))
        if (order.join() !== timeline.storyline.map((c) => c.id).join()) onOps([{ op: 'reorder_storyline', clipIds: order }], '拖动重排')
        return
      }
      if (Math.round(d.start) !== d.origStart) onOps([{ op: 'move_clip', clipId: d.id, startMs: Math.round(d.start) }], '移动片段')
      return
    }
    if (d.mode === 'trimR') {
      const outMs = Math.min(d.maxOut, d.origIn + d.dur * d.speed)
      onOps([{ op: 'trim_clip', clipId: d.id, inMs: d.origIn, outMs: Math.round(outMs) }], '修剪出点')
      return
    }
    const delta = d.start - d.origStart
    const inMs = Math.max(0, d.origIn + delta * d.speed)
    const ops: TimelineOp[] = [{ op: 'trim_clip', clipId: d.id, inMs: Math.round(inMs), outMs: d.origOut }]
    // 图层 / 音频修剪入点时保持画面内容不动（起点跟着后移）；主线会自动吸紧
    if (d.track !== 'story') ops.push({ op: 'move_clip', clipId: d.id, startMs: Math.round(d.start) })
    onOps(ops, '修剪入点')
  }

  function clipMenu(e: RME, clip: TimelineClip, track: Track) {
    onSelectClip(clip.id)
    onSelectCue(null)
    const kind = clipKind(clip)
    const asset = assetOf(clip.assetId)
    const inside = playheadMs > clip.startMs + 30 && playheadMs < end(clip) - 30
    const items: MenuItem[] = [
      { label: '在播放头分割', hint: '⌘B', disabled: !inside, onClick: () => onOps([{ op: 'split_clip', clipId: clip.id, atMs: playheadMs }], '分割') },
      { label: '复制', onClick: () => onAction('duplicate_clip', { clipId: clip.id }) }
    ]
    if (track === 'story' && asset?.kind === 'video') items.push({ label: '分离音频', onClick: () => onAction('detach_audio', { clipId: clip.id }) })
    if (kind === 'footage' && asset?.kind !== 'image')
      items.push({
        label: clip.volume === 0 ? '取消静音' : '静音',
        onClick: () => onAction('set_volume', { clipId: clip.id, volume: clip.volume === 0 ? 1 : 0 })
      })
    if (kind === 'footage' && asset?.kind === 'video') {
      items.push({ label: '冻结帧（在播放头）', disabled: !inside, onClick: () => onAction('freeze_frame', { clipId: clip.id, atMs: playheadMs }) })
      items.push({ label: clipFx(clip).reverse ? '正放' : '倒放', onClick: () => onAction('reverse_clip', { clipId: clip.id }) })
    }
    const sel = selectedAssetId ? assetOf(selectedAssetId) : undefined
    if (track !== 'audio' && kind === 'footage')
      items.push({
        label: sel ? `替换为「${sel.name.slice(0, 16)}」` : '替换为选中素材',
        disabled: !sel || sel.kind === 'audio' || sel.id === clip.assetId,
        onClick: () => onAction('replace_clip', { clipId: clip.id, assetId: sel!.id })
      })
    items.push('sep', { label: '删除', hint: '⌫', danger: true, onClick: () => onDeleteClip(clip.id) })
    menu.open(e, items)
  }

  function cueMenu(e: RME, cue: SubtitleCue) {
    onSelectCue(cue.id)
    onSelectClip(null)
    menu.open(e, [
      { label: '编辑文字', onClick: () => setEdit({ id: cue.id, startMs: cue.startMs, endMs: cue.endMs, text: cue.text }) },
      'sep',
      { label: '删除', danger: true, onClick: () => onOps([{ op: 'remove_subtitle', id: cue.id }], '删字幕') }
    ])
  }

  function blankMenu(e: RME) {
    const ms = msAt(e.clientX)
    menu.open(e, [
      { label: `在 ${formatTimecode(ms)} 加标记`, onClick: () => onAddMarker(ms) },
      'sep',
      { label: '设为入点', hint: 'I', onClick: () => onSetRange({ inMs: ms }) },
      { label: '设为出点', hint: 'O', onClick: () => onSetRange({ outMs: ms }) },
      { label: '清除入出点', hint: '⌥X', disabled: range.inMs == null && range.outMs == null, onClick: () => onSetRange({ inMs: null, outMs: null }) }
    ])
  }

  function commitEdit(e: Edit) {
    // Enter 提交后输入框卸载还可能触发一次 blur：只认当前这次编辑
    if (editRef.current !== e) return
    editRef.current = null
    setEdit(null)
    const text = e.text.trim()
    if (e.id) {
      const cue = timeline.subtitles.find((c) => c.id === e.id)
      if (!cue) return
      if (!text) onOps([{ op: 'remove_subtitle', id: e.id }], '删字幕')
      else if (text !== cue.text) onOps([{ op: 'update_subtitle', id: e.id, text }], '改字幕')
    } else if (text) {
      onOps([{ op: 'add_subtitle', startMs: Math.round(e.startMs), endMs: Math.round(e.endMs), text }], '手写字幕')
    }
  }

  /** 拖动中的预览位置。 */
  const view = (id: string, startMs: number, durationMs: number) =>
    drag && drag.id === id && drag.moved ? { startMs: drag.start, durationMs: drag.dur, dragging: true } : { startMs, durationMs, dragging: false }

  function clipBlock(clip: TimelineClip, track: Track, lane = 0, lanes = 1) {
    const v = view(clip.id, clip.startMs, clip.durationMs)
    const asset = assetOf(clip.assetId)
    const kind = clipKind(clip)
    const fx = clipFx(clip)
    const tags = fxTags(clip)
    const h = 100 / lanes
    const name =
      kind === 'adjustment'
        ? '调整层'
        : kind === 'solid'
          ? '纯色'
          : kind === 'text'
            ? clip.text?.text?.slice(0, 24) || '文字'
            : kind === 'shape'
              ? clip.shape?.shape === 'ellipse'
                ? '椭圆'
                : '矩形'
              : asset?.name ?? '片段'
    const peaks =
      track !== 'overlay' && asset && asset.kind !== 'image'
        ? sliceWaveform(asset.index?.waveform, asset.durationMs || clip.durationMs, clip.inMs, clip.outMs)
        : undefined
    const thumb = track === 'story' && asset?.thumbPath ? mediaUrl(asset.thumbPath) : null
    const w = Math.max(6, x(v.durationMs))
    return (
      <div
        key={clip.id}
        className={
          'clip k-' +
          (track === 'audio' ? (clip.role === 'dialog' ? 'dialog' : 'music') : kind) +
          (clip.source !== 'human' ? ' ai' : '') +
          (selectedClipId === clip.id ? ' selected' : '') +
          (v.dragging ? ' dragging' : '') +
          (w < 40 ? ' narrow' : '')
        }
        style={{
          left: x(v.startMs),
          width: w,
          top: `calc(${lane * h}% + 3px)`,
          height: `calc(${h}% - 6px)`,
          backgroundImage: thumb ? `linear-gradient(rgba(20,20,40,.35), rgba(20,20,40,.55)), url("${thumb}")` : undefined
        }}
        title={`${name}\n${formatTimecode(clip.startMs, true)} · ${(clip.durationMs / 1000).toFixed(2)}s${tags.length ? '\n' + tags.join(' · ') : ''}`}
        onMouseDown={(e) => beginDrag(e, track, clip, 'move')}
        onContextMenu={(e) => clipMenu(e, clip, track)}
      >
        <span className="handle l" onMouseDown={(e) => beginDrag(e, track, clip, 'trimL')} />
        {peaks?.length ? <Waveform peaks={peaks} /> : null}
        <span className="clip-text">
          <span className="clip-name">{name}</span>
          {tags.length ? <span className="clip-tags">{tags.join(' · ')}</span> : null}
        </span>
        {track === 'story' && fx.transitionOut.type !== 'none' ? (
          <span className="clip-trans" title={`出点转场：${transitionLabel(fx.transitionOut.type)} ${fx.transitionOut.durationMs}ms`} />
        ) : null}
        <span className="handle r" onMouseDown={(e) => beginDrag(e, track, clip, 'trimR')} />
      </div>
    )
  }

  const step = tickStepMs(pps)
  const ticks: number[] = []
  const tickEnd = (width / pps) * 1000
  for (let t = 0; t <= tickEnd; t += step) ticks.push(t)
  const rIn = range.inMs
  const rOut = range.outMs
  const hasRange = rIn != null || rOut != null
  const shadeFrom = rIn ?? 0
  const shadeTo = rOut ?? contentMs
  const selectedCue = timeline.subtitles.find((c) => c.id === selectedCueId)

  const label = (key: TrackKey, text: string) => (
    <div className="track-label">
      {text}
      <span
        className="track-resize"
        onMouseDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          dragHeight(key, e.clientY, heights[key])
        }}
      />
    </div>
  )

  return (
    <div className="tl">
      <div className="tl-bar">
        <button type="button" className="icon-btn" title="缩小 ⌘−" onClick={() => setPps(pps / 1.25)}>
          <Icon name="minus" size={14} />
        </button>
        <input
          type="range"
          className="tl-zoom"
          min={Math.log(MIN_PPS)}
          max={Math.log(MAX_PPS)}
          step={0.01}
          value={Math.log(pps)}
          onChange={(e) => setPps(Math.exp(Number(e.target.value)))}
          title="缩放时间线"
        />
        <button type="button" className="icon-btn" title="放大 ⌘=" onClick={() => setPps(pps * 1.25)}>
          <Icon name="plus" size={14} />
        </button>
        <button type="button" className="icon-btn" title="适配窗口 ⇧Z" onClick={fit}>
          <Icon name="fit" size={14} />
        </button>
        <span className="tb-sep" />
        <button type="button" className={'icon-btn' + (snapping ? ' on' : '')} title={`吸附 N（${snapping ? '开' : '关'}，拖动时按住 ⌘ 暂时关闭）`} onClick={onToggleSnap}>
          <Icon name="magnet" size={14} />
        </button>
        {hasRange ? (
          <span className="tl-range">
            入 {rIn != null ? formatTimecode(rIn, true) : '—'} · 出 {rOut != null ? formatTimecode(rOut, true) : '—'}
            {rIn != null && rOut != null && rOut > rIn ? ` · ${((rOut - rIn) / 1000).toFixed(1)}s` : ''}
            <button type="button" className="link" onClick={() => onSetRange({ inMs: null, outMs: null })}>
              清除
            </button>
          </span>
        ) : null}
        <span className="spacer" />
        <span className="tl-hint">
          {selectedCue ? '双击字幕改文字 · 拖边缘调时间' : '拖动片段排序 · 拖边缘修剪 · 右键更多'}
        </span>
      </div>
      <div className="tl-scroll" ref={scrollRef} onMouseLeave={() => setHoverMs(null)}>
        <div className="tl-inner" style={{ width: width + LABEL }} onMouseMove={(e) => setHoverMs(msAt(e.clientX))}>
          <div className="tl-ruler-row">
            <div className="tl-corner">{formatTimecode(playheadMs, true)}</div>
            <div className="ruler" style={{ width }} onMouseDown={scrub} onContextMenu={blankMenu}>
              {hasRange ? <div className="ruler-range" style={{ left: x(shadeFrom), width: Math.max(0, x(shadeTo - shadeFrom)) }} /> : null}
              {ticks.map((t) => (
                <span key={t} className="tick" style={{ left: x(t) }}>
                  {formatTimecode(t, step < 1000)}
                </span>
              ))}
              {markers.map((m) => (
                <span
                  key={m.id}
                  className={'marker' + (m.kind === 'chapter' ? ' chapter' : '')}
                  style={{ left: x(m.atMs) }}
                  title={`${m.label} · ${formatTimecode(m.atMs)}`}
                  onMouseDown={(e) => {
                    e.stopPropagation()
                    onSeek(m.atMs)
                  }}
                >
                  {m.kind === 'chapter' ? m.label : ''}
                </span>
              ))}
            </div>
          </div>

          <div className="track t-video" style={{ height: heights.video }}>
            {label('video', '主线')}
            <div
              className="lane"
              style={{ width }}
              onMouseDown={(e) => {
                if (e.target !== e.currentTarget || e.button !== 0) return
                onSelectClip(null)
                onSelectCue(null)
                onSeek(msAt(e.clientX))
              }}
              onContextMenu={blankMenu}
            >
              {timeline.storyline.length === 0 ? <span className="lane-empty">双击素材库里的素材，或让终端里的 AI 粗剪</span> : null}
              {timeline.storyline.map((c) => clipBlock(c, 'story'))}
              {drag?.moved && drag.track === 'story' && drag.mode === 'move' && drag.insertMs != null ? (
                <div className="insert-caret" style={{ left: x(drag.insertMs) }} />
              ) : null}
            </div>
          </div>
          <div className="track t-layer" style={{ height: Math.max(heights.fx, laneCount * 22) }}>
            {label('fx', '图层')}
            <div
              className="lane"
              style={{ width }}
              onMouseDown={(e) => {
                if (e.target !== e.currentTarget || e.button !== 0) return
                onSelectClip(null)
                onSeek(msAt(e.clientX))
              }}
              onContextMenu={blankMenu}
            >
              {timeline.overlays.map((c, i) => clipBlock(c, 'overlay', layerLanes[i] ?? 0, laneCount))}
            </div>
          </div>
          <div className="track t-audio" style={{ height: heights.audio }}>
            {label('audio', '音频')}
            <div
              className="lane"
              style={{ width }}
              onMouseDown={(e) => {
                if (e.target !== e.currentTarget || e.button !== 0) return
                onSelectClip(null)
                onSeek(msAt(e.clientX))
              }}
              onContextMenu={blankMenu}
            >
              {timeline.audio.map((c) => clipBlock(c, 'audio'))}
            </div>
          </div>
          <div className="track t-sub" style={{ height: heights.sub }}>
            {label('sub', '字幕')}
            <div
              className="lane"
              style={{ width }}
              onMouseDown={(e) => {
                if (e.target !== e.currentTarget || e.button !== 0) return
                onSelectCue(null)
                onSeek(msAt(e.clientX))
              }}
              onDoubleClick={(e) => {
                if (e.target !== e.currentTarget) return
                const start = msAt(e.clientX)
                setEdit({ id: null, startMs: start, endMs: start + 2000, text: '' })
              }}
              onContextMenu={blankMenu}
            >
              {timeline.subtitles.map((cue) => {
                if (edit?.id === cue.id) return null
                const v = view(cue.id, cue.startMs, cue.endMs - cue.startMs)
                return (
                  <div
                    key={cue.id}
                    className={'cue' + (selectedCueId === cue.id ? ' selected' : '') + (v.dragging ? ' dragging' : '')}
                    style={{ left: x(v.startMs), width: Math.max(6, x(v.durationMs)) }}
                    title={cue.text}
                    onMouseDown={(e) => beginDrag(e, 'sub', cue, 'move')}
                    onDoubleClick={(e) => {
                      e.stopPropagation()
                      setEdit({ id: cue.id, startMs: cue.startMs, endMs: cue.endMs, text: cue.text })
                    }}
                    onContextMenu={(e) => cueMenu(e, cue)}
                  >
                    <span className="handle l" onMouseDown={(e) => beginDrag(e, 'sub', cue, 'trimL')} />
                    <span className="cue-text">{cue.text}</span>
                    <span className="handle r" onMouseDown={(e) => beginDrag(e, 'sub', cue, 'trimR')} />
                  </div>
                )
              })}
              {edit ? (
                <input
                  autoFocus
                  className="cue-edit"
                  style={{ left: x(edit.startMs), width: Math.max(180, x(edit.endMs - edit.startMs)) }}
                  value={edit.text}
                  placeholder="输入字幕，Enter 确定"
                  onChange={(e) => setEdit({ ...edit, text: e.target.value })}
                  onMouseDown={(e) => e.stopPropagation()}
                  onBlur={() => commitEdit(edit)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') commitEdit(edit)
                    if (e.key === 'Escape') {
                      editRef.current = null
                      setEdit(null)
                    }
                  }}
                />
              ) : null}
            </div>
          </div>

          <div className="playhead" style={{ left: LABEL + x(playheadMs) }} />
          {hoverMs != null && !drag ? <div className="hoverline" style={{ left: LABEL + x(hoverMs) }} /> : null}
          {drag?.moved && drag.guide != null ? <div className="snapline" style={{ left: LABEL + x(drag.guide) }} /> : null}
        </div>
      </div>
      {menu.node}
    </div>
  )
}

function Waveform({ peaks }: { peaks: number[] }) {
  if (peaks.length < 2) return null
  const w = Math.max(2, peaks.length)
  const h = 32
  let d = `M 0 ${h}`
  for (let i = 0; i < peaks.length; i++) {
    const px = (i / (peaks.length - 1)) * w
    const py = h - Math.min(1, Math.max(0, peaks[i] ?? 0)) * h
    d += ` L ${px.toFixed(1)} ${py.toFixed(1)}`
  }
  d += ` L ${w} ${h} Z`
  return (
    <svg className="clip-wave" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden>
      <path d={d} />
    </svg>
  )
}
