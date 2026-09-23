import type { ReviewIssue } from '@shared/types'
import { formatTimecode } from '../lib/format'

export type QaResult = { issues: ReviewIssue[]; summary: string; at: string; visual: boolean }

const LABEL: Record<ReviewIssue['severity'], string> = { error: '错误', warn: '警告', info: '提示' }

/** 质检：跑 review_timeline，按严重程度列出问题，点一条跳到那里。 */
export function QAPanel({
  qa,
  running,
  stale,
  onRun,
  onJump
}: {
  qa: QaResult | null
  running: boolean
  stale: boolean
  onRun: (visual: boolean) => void
  onJump: (issue: ReviewIssue) => void
}) {
  return (
    <div className="qa">
      <div className="qa-actions">
        <button type="button" className="btn primary small" disabled={running} onClick={() => onRun(false)}>
          {running ? '检查中…' : '快速质检'}
        </button>
        <button type="button" className="btn small" disabled={running} onClick={() => onRun(true)} title="额外取帧检查 B-roll 色调，慢一些">
          含画面检查
        </button>
      </div>
      {qa ? (
        <>
          <div className={'qa-summary' + (stale ? ' stale' : '')}>
            {qa.summary}
            {stale ? <span> · 时间线已改动，结果可能过期</span> : null}
          </div>
          {(['error', 'warn', 'info'] as const).map((sev) => {
            const list = qa.issues.filter((i) => i.severity === sev)
            if (!list.length) return null
            return (
              <div key={sev} className="qa-sec">
                <div className="qa-sec-h">
                  <i className={'sev-dot ' + sev} />
                  {LABEL[sev]} {list.length}
                </div>
                {list.map((issue, i) => (
                  <button
                    key={`${issue.code}-${i}`}
                    type="button"
                    className={'qa-issue ' + sev}
                    disabled={issue.atMs == null && !issue.clipId}
                    onClick={() => onJump(issue)}
                  >
                    {issue.atMs != null ? <span className="tc">{formatTimecode(issue.atMs)}</span> : null}
                    <span>{issue.message}</span>
                  </button>
                ))}
              </div>
            )
          })}
        </>
      ) : (
        <p className="insp-hint">检查碎片、字幕超长或重叠、转场吃掉人声、音乐盖过人声、响度、开头 3 秒是否空等问题。导出前跑一次。</p>
      )}
    </div>
  )
}
