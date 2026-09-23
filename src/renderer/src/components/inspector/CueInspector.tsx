import type { SubtitleCue, SubtitleStyle, TimelineOp } from '@shared/types'
import { formatTimecode } from '../../lib/format'
import { Group, Row, TextField } from './controls'
import { SubtitleStylePanel } from './SubtitleStylePanel'

type Act = (name: string, args?: Record<string, unknown>) => void

function Nudge({ label, ms, onChange }: { label: string; ms: number; onChange: (ms: number) => void }) {
  return (
    <Row label={label}>
      <button type="button" className="btn small" onClick={() => onChange(ms - 100)}>
        −0.1s
      </button>
      <span className="insp-v tc">{formatTimecode(ms, true)}</span>
      <button type="button" className="btn small" onClick={() => onChange(ms + 100)}>
        +0.1s
      </button>
    </Row>
  )
}

export function CueInspector({
  cue,
  style,
  onOps,
  onAction,
  onDelete
}: {
  cue: SubtitleCue
  style?: SubtitleStyle
  onOps: (ops: TimelineOp[], summary?: string) => void
  onAction: Act
  onDelete: () => void
}) {
  return (
    <div className="insp">
      <div className="insp-head">
        <div>
          <b>字幕</b>
          <small>
            {formatTimecode(cue.startMs)} · {((cue.endMs - cue.startMs) / 1000).toFixed(1)}s
          </small>
        </div>
        <button type="button" className="btn ghost danger-text" onClick={onDelete}>
          删除
        </button>
      </div>
      <Group id="cue" title="这条字幕">
        <TextField
          value={cue.text}
          rows={3}
          onCommit={(text) => (text.trim() ? onOps([{ op: 'update_subtitle', id: cue.id, text }], '改字幕') : onDelete())}
        />
        <Nudge
          label="开始"
          ms={cue.startMs}
          onChange={(ms) => onOps([{ op: 'update_subtitle', id: cue.id, startMs: Math.max(0, Math.min(ms, cue.endMs - 100)) }], '调字幕时间')}
        />
        <Nudge
          label="结束"
          ms={cue.endMs}
          onChange={(ms) => onOps([{ op: 'update_subtitle', id: cue.id, endMs: Math.max(cue.startMs + 100, ms) }], '调字幕时间')}
        />
      </Group>
      <Group id="substyle" title="字幕样式（全片）">
        <SubtitleStylePanel style={style} onAction={onAction} />
      </Group>
    </div>
  )
}
