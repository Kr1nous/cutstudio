/** 撤销历史：上面是可重做的（淡），中间是当前，下面是可撤销的；点一行直接跳到那一步之后的状态。 */
export function HistoryList({
  history,
  onUndo,
  onRedo
}: {
  history: { undo: string[]; redo: string[] }
  onUndo: (steps: number) => void
  onRedo: (steps: number) => void
}) {
  const { undo, redo } = history
  if (!undo.length && !redo.length) return <p className="insp-hint">还没有改动。</p>
  // redo 最近的在前：离「当前」最近的应排在最下面
  const redoRows = redo.map((label, i) => ({ label, steps: i + 1 })).reverse()
  return (
    <ol className="hist">
      {redoRows.map((r) => (
        <li key={'r' + r.steps}>
          <button type="button" className="hist-row redo" title="重做到这一步" onClick={() => onRedo(r.steps)}>
            {r.label}
          </button>
        </li>
      ))}
      <li className="hist-now">当前</li>
      {undo.map((label, i) => (
        <li key={'u' + i}>
          <button type="button" className="hist-row" title={`撤销到这一步之前（${i + 1} 步）`} onClick={() => onUndo(i + 1)}>
            {label}
          </button>
        </li>
      ))}
    </ol>
  )
}
