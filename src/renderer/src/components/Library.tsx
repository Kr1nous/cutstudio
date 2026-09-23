import type { MediaAsset } from '@shared/types'
import { formatTimecode, mediaUrl } from '../lib/format'
import { useContextMenu, type MenuItem } from './ContextMenu'
import { Icon } from './Icon'

function analysisNote(a: MediaAsset): string | null {
  if (a.kind === 'image') return null
  const t = a.index?.transcription
  if (t === 'pending') return '转写中'
  if (t === 'error') return '转写失败'
  return null
}

export function Library({
  assets,
  selectedId,
  onSelect,
  onImport,
  onAddToTimeline,
  onAction,
  onDelete
}: {
  assets: MediaAsset[]
  selectedId: string | null
  onSelect: (id: string | null) => void
  onImport: () => void
  onAddToTimeline: (id: string) => void
  onAction: (name: string, args?: Record<string, unknown>) => void
  onDelete: (id: string) => void
}) {
  const menu = useContextMenu()

  function assetMenu(e: React.MouseEvent, a: MediaAsset) {
    onSelect(a.id)
    const items: MenuItem[] = []
    if (a.kind === 'audio') {
      items.push({ label: '设为背景音乐', onClick: () => onAction('set_music', { assetId: a.id }) })
    } else {
      items.push({ label: '加到主线末尾', hint: '双击', onClick: () => onAddToTimeline(a.id) })
      items.push({ label: '在播放头叠加 B-roll', onClick: () => onAction('insert_broll', { assetId: a.id }) })
    }
    if (a.kind === 'video') items.push({ label: a.proxyPath ? '重新生成代理' : '生成代理（预览更流畅）', onClick: () => onAction('make_proxy', { assetId: a.id }) })
    if (a.kind !== 'image') items.push({ label: '重新分析（转写 / 静音 / 镜头）', onClick: () => onAction('reanalyze_asset', { assetId: a.id }) })
    items.push('sep', { label: '删除素材', danger: true, onClick: () => onDelete(a.id) })
    menu.open(e, items)
  }

  return (
    <section className="panel library">
      <div className="panel-h">
        <span>素材 {assets.length ? <em>{assets.length}</em> : null}</span>
        <button type="button" className="icon-btn" title="导入素材 ⌘I" onClick={onImport}>
          <Icon name="plus" size={15} />
        </button>
      </div>
      {assets.length === 0 ? (
        <button type="button" className="drop-hint" onClick={onImport}>
          <b>拖入或点击导入</b>
          <span>视频、音频、图片都可以</span>
        </button>
      ) : (
        <div
          className="library-grid"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) onSelect(null)
          }}
        >
          {assets.map((a) => {
            const note = analysisNote(a)
            return (
              <div
                key={a.id}
                className={'asset' + (selectedId === a.id ? ' selected' : '')}
                onClick={() => onSelect(a.id)}
                onDoubleClick={() => (a.kind === 'audio' ? onAction('set_music', { assetId: a.id }) : onAddToTimeline(a.id))}
                onContextMenu={(e) => assetMenu(e, a)}
                title={`${a.name}\n双击${a.kind === 'audio' ? '设为背景音乐' : '加到主线'}，右键更多`}
              >
                <div className="thumb">
                  {a.thumbPath ? (
                    <img src={mediaUrl(a.thumbPath)} alt="" draggable={false} />
                  ) : a.kind === 'image' ? (
                    <img src={mediaUrl(a.path)} alt="" draggable={false} />
                  ) : (
                    <span className="thumb-kind">{a.kind === 'audio' ? '♪' : '视频'}</span>
                  )}
                  {a.durationMs ? <span className="thumb-dur">{formatTimecode(a.durationMs)}</span> : null}
                  {note ? <span className="thumb-note">{note}</span> : null}
                </div>
                <div className="meta">
                  <b>{a.name}</b>
                  {!a.durationMs && a.kind !== 'image' ? <small>读取中…</small> : null}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {menu.node}
    </section>
  )
}
