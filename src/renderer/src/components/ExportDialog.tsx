import { useState } from 'react'
import type { ExportProgress, Project } from '@shared/types'
import { timelineDurationMs } from '@shared/types'
import { formatTimecode } from '../lib/format'
import { toast, toastError } from '../lib/toast'
import { Seg } from './inspector/controls'

type Preset = '1080p' | '4k' | 'shorts' | 'prores' | 'alpha'

const PRESETS: [Preset, string, string][] = [
  ['1080p', '1080p', 'H.264 MP4，最通用'],
  ['4k', '4K', 'H.264 MP4，3840 宽'],
  ['shorts', '竖屏', '1080×1920，抖音 / Shorts'],
  ['prores', 'ProRes', 'MOV，交给其他剪辑软件'],
  ['alpha', '透明 MOV', '带 Alpha，做素材叠加']
]

/** 导出对话框（⌘E）：预设、范围、字幕方式、位置；导出时显示进度，可取消。 */
export function ExportDialog({
  project,
  range,
  progress,
  qaErrors,
  qaStale,
  onRunQa,
  onClose
}: {
  project: Project
  range: { inMs: number; outMs: number } | null
  progress: ExportProgress | null
  qaErrors: number | null
  qaStale: boolean
  onRunQa: () => void
  onClose: () => void
}) {
  const vertical = project.settings.height > project.settings.width
  const [preset, setPreset] = useState<Preset>(vertical ? 'shorts' : '1080p')
  const [useRange, setUseRange] = useState(Boolean(range))
  const [subs, setSubs] = useState<'burn' | 'srt' | 'none'>('burn')
  const [dest, setDest] = useState<'project' | 'pick'>('project')
  const [result, setResult] = useState<{ path: string; warnings: string[] } | null>(null)
  const hasSubs = project.timeline.subtitles.length > 0
  const running = progress?.status === 'running'
  const total = timelineDurationMs(project.timeline)
  const len = useRange && range ? range.outMs - range.inMs : total

  async function start() {
    try {
      setResult(null)
      let outPath: string | undefined
      if (dest === 'pick') {
        const ext = preset === 'prores' || preset === 'alpha' ? 'mov' : 'mp4'
        const picked = await window.cut.pickExportPath(`${project.name}.${ext}`)
        if (!picked) return
        outPath = picked
      }
      const r = await window.cut.exportTimeline({
        preset,
        rangeMs: useRange && range ? { startMs: range.inMs, endMs: range.outMs } : undefined,
        subtitles: hasSubs ? subs : 'none',
        outPath
      })
      setResult(r)
    } catch (e) {
      if (!/取消/.test(String(e))) toastError(e)
    }
  }

  async function queue() {
    try {
      const r = await window.cut.runAction('render_queue_add', { preset })
      toast(r.summary, 'ok')
      onClose()
    } catch (e) {
      toastError(e)
    }
  }

  return (
    <div className="modal-back" onMouseDown={() => !running && onClose()}>
      <div className="modal export" onMouseDown={(e) => e.stopPropagation()}>
        <h2>导出</h2>
        {qaErrors == null ? (
          <div className="export-qa">
            {qaStale ? '上次质检后时间线改动过。' : '还没质检过。'}
            <button type="button" className="link" onClick={onRunQa}>
              {qaStale ? '重新质检' : '先快速质检'}
            </button>
          </div>
        ) : qaErrors > 0 ? (
          <div className="export-qa warn">质检发现 {qaErrors} 个错误，建议先在「审查」里看一下。</div>
        ) : (
          <div className="export-qa ok">质检没有错误。</div>
        )}
        <div className="export-presets">
          {PRESETS.map(([id, label, desc]) => (
            <button key={id} type="button" className={'export-preset' + (preset === id ? ' on' : '')} disabled={running} onClick={() => setPreset(id)}>
              <b>{label}</b>
              <small>{desc}</small>
            </button>
          ))}
        </div>
        <div className="export-row">
          <span>范围</span>
          <Seg
            value={useRange && range ? 'range' : 'all'}
            options={range ? [['all', '全片'], ['range', `入点–出点 ${formatTimecode(range.inMs)}–${formatTimecode(range.outMs)}`]] : [['all', '全片']]}
            onChange={(v) => setUseRange(v === 'range')}
          />
        </div>
        {!range ? <p className="insp-hint">在时间线上按 I / O 设入点出点，就能只导出一段。</p> : null}
        <div className="export-row">
          <span>字幕</span>
          {hasSubs ? (
            <Seg
              value={subs}
              options={[
                ['burn', '烧进画面'],
                ['srt', '另存 SRT'],
                ['none', '不要']
              ]}
              onChange={setSubs}
            />
          ) : (
            <span className="muted">没有字幕</span>
          )}
        </div>
        <div className="export-row">
          <span>位置</span>
          <Seg
            value={dest}
            options={[
              ['project', '工程 export 文件夹'],
              ['pick', '另存为…']
            ]}
            onChange={setDest}
          />
        </div>
        <div className="export-row muted">
          时长 {formatTimecode(len)} · {project.settings.fps || 30} fps
        </div>

        {running || progress?.status === 'error' ? (
          <div className="export-progress">
            <div className="bar">
              <span style={{ width: `${Math.round((progress?.ratio ?? 0) * 100)}%` }} />
            </div>
            <span>{running ? `${Math.round((progress?.ratio ?? 0) * 100)}%` : '失败'}</span>
          </div>
        ) : null}
        {result ? (
          <div className="export-done">
            <div>
              已导出 <code>{result.path.split('/').pop()}</code>
            </div>
            {result.warnings.map((w) => (
              <p key={w} className="insp-hint">
                {w}
              </p>
            ))}
          </div>
        ) : null}

        <div className="modal-foot">
          {running ? (
            <button type="button" className="btn" onClick={() => void window.cut.cancelExport()}>
              取消导出
            </button>
          ) : (
            <>
              <button type="button" className="btn ghost" onClick={() => void queue()} title="加入渲染队列，后台依次导出">
                加入队列
              </button>
              <span className="spacer" />
              {result ? (
                <button type="button" className="btn" onClick={() => void window.cut.showInFolder(result.path)}>
                  在访达中显示
                </button>
              ) : null}
              <button type="button" className="btn" onClick={onClose}>
                关闭
              </button>
              <button type="button" className="btn primary" disabled={total <= 0} onClick={() => void start()}>
                {result ? '再导出一次' : '导出'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
