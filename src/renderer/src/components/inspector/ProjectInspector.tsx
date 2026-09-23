import type { Project } from '@shared/types'
import { timelineDurationMs } from '@shared/types'
import { formatTimecode } from '../../lib/format'
import { Group, Row, Seg, Slider, Toggle } from './controls'
import { SubtitleStylePanel } from './SubtitleStylePanel'

type Act = (name: string, args?: Record<string, unknown>) => void

/** 什么都没选中时：整片的设置。 */
export function ProjectInspector({ project, onAction, onSeek }: { project: Project; onAction: Act; onSeek: (ms: number) => void }) {
  const tl = project.timeline
  const aspect = project.settings.aspect ?? '16:9'
  const duck = tl.duck ?? { enabled: false, ratio: 0.28 }
  const hasMusic = tl.audio.some((c) => c.role !== 'dialog')
  const markers = [...(project.markers ?? [])].sort((a, b) => a.atMs - b.atMs)
  return (
    <div className="insp">
      <div className="insp-head">
        <div>
          <b>整片</b>
          <small>
            {formatTimecode(timelineDurationMs(tl))} · {project.settings.width}×{project.settings.height} · {tl.storyline.length} 段 · {tl.subtitles.length} 条字幕
          </small>
        </div>
      </div>
      <Group id="proj-frame" title="画幅">
        <Row label="比例">
          <Seg
            value={aspect}
            options={[
              ['16:9', '16:9'],
              ['9:16', '9:16'],
              ['1:1', '1:1']
            ]}
            onChange={(a) => onAction(a === '9:16' ? 'reframe' : 'set_aspect', { aspect: a })}
          />
        </Row>
        <p className="insp-hint">切到 9:16 会按主体位置重构图。</p>
      </Group>
      <Group id="proj-sub" title="字幕样式">
        <SubtitleStylePanel style={project.subtitleStyle} onAction={onAction} />
      </Group>
      <Group id="proj-audio" title="声音">
        <Row label="音乐闪避">
          <Toggle on={duck.enabled} onChange={(enabled) => onAction('duck_music', { enabled, ratio: duck.ratio })} />
          {duck.enabled ? (
            <Slider
              value={duck.ratio}
              min={0.05}
              max={0.9}
              step={0.05}
              format={(v) => `${Math.round(v * 100)}%`}
              onCommit={(ratio) => onAction('duck_music', { enabled: true, ratio })}
            />
          ) : null}
        </Row>
        {!hasMusic && duck.enabled ? <p className="insp-hint">还没有背景音乐，闪避暂不生效。</p> : null}
        <Row label="响度">
          <button type="button" className="btn small" onClick={() => onAction('normalize_loudness', {})}>
            统一到 −16 LUFS
          </button>
        </Row>
      </Group>
      <Group id="proj-markers" title="章节与标记" aside={markers.length ? <span className="badge">{markers.length}</span> : null}>
        {markers.length === 0 ? (
          <p className="insp-hint">在时间线标尺上右键可以加标记；AI 用 set_chapters 生成的章节也在这里。</p>
        ) : (
          <ul className="marker-list">
            {markers.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => onSeek(m.atMs)}>
                  <span className="tc">{formatTimecode(m.atMs)}</span>
                  <span className={m.kind === 'chapter' ? 'chapter' : ''}>{m.label}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Group>
    </div>
  )
}
