import { useState, type ReactNode } from 'react'
import type { Project, ReviewIssue } from '@shared/types'
import { HistoryList } from './HistoryList'
import { QAPanel, type QaResult } from './QAPanel'
import { Group } from './inspector/controls'

type Tab = 'inspect' | 'review'

/** 右侧面板：检查器（随选中对象变化）| 审查（质检、AI 改动、历史、版本）。 */
export function SidePanel({
  project,
  inspector,
  history,
  qa,
  qaRunning,
  qaStale,
  tab,
  onTab,
  onRunQa,
  onJump,
  onUndo,
  onRedo,
  onRestore
}: {
  project: Project
  inspector: ReactNode
  history: { undo: string[]; redo: string[] }
  qa: QaResult | null
  qaRunning: boolean
  qaStale: boolean
  tab: Tab
  onTab: (t: Tab) => void
  onRunQa: (visual: boolean) => void
  onJump: (issue: ReviewIssue) => void
  onUndo: (steps: number) => void
  onRedo: (steps: number) => void
  onRestore: (id: string) => void
}) {
  const errors = qa && !qaStale ? qa.issues.filter((i) => i.severity === 'error').length : 0
  const aiReview = project.review.filter((a) => a.source === 'ai' || a.source === 'mcp')
  const [showAllAi, setShowAllAi] = useState(false)
  return (
    <section className="panel side">
      <div className="side-tabs">
        <button type="button" className={tab === 'inspect' ? 'on' : ''} onClick={() => onTab('inspect')}>
          检查器
        </button>
        <button type="button" className={tab === 'review' ? 'on' : ''} onClick={() => onTab('review')}>
          审查{errors ? <span className="badge danger">{errors}</span> : null}
        </button>
      </div>
      <div className="side-body">
        {tab === 'inspect' ? (
          inspector
        ) : (
          <div className="insp">
            <Group id="rv-qa" title="质检">
              <QAPanel qa={qa} running={qaRunning} stale={qaStale} onRun={onRunQa} onJump={onJump} />
            </Group>
            <Group id="rv-ai" title="AI 改动" aside={aiReview.length ? <span className="badge">{aiReview.length}</span> : null}>
              {aiReview.length === 0 ? (
                <p className="insp-hint">终端里的 AI（cutstudio / MCP）每做一步都会记在这里，方便检查和撤销。</p>
              ) : (
                <>
                  {(showAllAi ? aiReview : aiReview.slice(0, 12)).map((a) => (
                    <div key={a.id} className={'ai-act ' + a.risk}>
                      <span>{a.summary}</span>
                      <time>{new Date(a.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                    </div>
                  ))}
                  {aiReview.length > 12 && !showAllAi ? (
                    <button type="button" className="link" onClick={() => setShowAllAi(true)}>
                      显示全部 {aiReview.length} 条
                    </button>
                  ) : null}
                </>
              )}
            </Group>
            <Group id="rv-hist" title="历史">
              <HistoryList history={history} onUndo={onUndo} onRedo={onRedo} />
            </Group>
            {project.snapshots.length ? (
              <Group id="rv-snap" title="版本" defaultOpen={false} aside={<span className="badge">{project.snapshots.length}</span>}>
                <p className="insp-hint">AI 每做完一步自动存一个版本，可以回到那一步的结果。恢复本身也能撤销。</p>
                {project.snapshots
                  .slice()
                  .reverse()
                  .slice(0, 12)
                  .map((s) => (
                    <button key={s.id} type="button" className="hist-row" onClick={() => onRestore(s.id)}>
                      {s.label}
                      <time>{new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
                    </button>
                  ))}
              </Group>
            ) : null}
          </div>
        )}
      </div>
    </section>
  )
}
