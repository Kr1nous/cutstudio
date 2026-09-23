import { useEffect, useState } from 'react'
import type { SubtitleStyle } from '@shared/types'
import { DEFAULT_SUBTITLE_STYLE } from '@shared/types'
import { ColorField, Row, Seg, Slider } from './controls'

type Act = (name: string, args?: Record<string, unknown>) => void

type Preset = { id: string; label: string; patch: Partial<SubtitleStyle> }

const PRESETS: Preset[] = [
  { id: 'white', label: '简洁白', patch: { preset: 'clean', color: '#ffffff', stroke: '#000000' } },
  { id: 'yellow', label: '醒目黄', patch: { preset: 'clean', color: '#ffd60a', stroke: '#000000' } },
  { id: 'boxed', label: '底框', patch: { preset: 'boxed', color: '#ffffff', boxColor: '#000000', boxOpacity: 0.6 } },
  { id: 'karaoke', label: '卡拉 OK', patch: { preset: 'karaoke', color: '#ffffff', stroke: '#000000', highlightColor: '#ffd60a' } },
  { id: 'keyword', label: '关键词', patch: { preset: 'keyword', color: '#ffffff', stroke: '#000000', highlightColor: '#ff9f0a' } }
]

function activePreset(s: SubtitleStyle): string | null {
  const preset = s.preset ?? 'clean'
  if (preset === 'clean') return s.color.toLowerCase() === '#ffd60a' ? 'yellow' : s.color.toLowerCase() === '#ffffff' ? 'white' : null
  return preset
}

/** 预设样张：深色底上的示例字，按预设画出描边 / 底框 / 高亮。 */
function Sample({ p }: { p: Partial<SubtitleStyle> }) {
  const color = p.color ?? '#ffffff'
  const stroke = p.stroke ?? '#000000'
  const outline = `-1px -1px 0 ${stroke}, 1px -1px 0 ${stroke}, -1px 1px 0 ${stroke}, 1px 1px 0 ${stroke}`
  const base = { color, textShadow: p.preset === 'boxed' ? 'none' : outline }
  const hi = p.highlightColor ?? '#ffd60a'
  return (
    <span className="sub-sample-text" style={p.preset === 'boxed' ? { ...base, background: `rgba(0,0,0,${p.boxOpacity ?? 0.6})` } : base}>
      {p.preset === 'karaoke' ? (
        <>
          <span style={{ color: hi }}>字幕</span>样式
        </>
      ) : p.preset === 'keyword' ? (
        <>
          字幕<span style={{ color: hi, fontSize: '1.15em' }}>样式</span>
        </>
      ) : (
        '字幕样式'
      )}
    </span>
  )
}

export function SubtitleStylePanel({ style, onAction }: { style?: SubtitleStyle; onAction: Act }) {
  const s = style ?? DEFAULT_SUBTITLE_STYLE
  const set = (patch: Partial<SubtitleStyle>) => onAction('set_subtitle_style', patch as Record<string, unknown>)
  const current = activePreset(s)
  const preset = s.preset ?? 'clean'
  const [keywords, setKeywords] = useState((s.keywords ?? []).join('，'))
  useEffect(() => setKeywords((s.keywords ?? []).join('，')), [s.keywords])

  return (
    <>
      <div className="sub-presets">
        {PRESETS.map((p) => (
          <button key={p.id} type="button" className={'sub-preset' + (current === p.id ? ' on' : '')} onClick={() => set(p.patch)}>
            <span className="sub-sample">
              <Sample p={p.patch} />
            </span>
            <span className="sub-name">{p.label}</span>
          </button>
        ))}
      </div>
      <Row label="位置">
        <Seg
          value={s.position}
          options={[
            ['top', '上'],
            ['center', '中'],
            ['bottom', '下']
          ]}
          onChange={(position) => set({ position })}
        />
      </Row>
      <Row label="字号">
        <Slider value={s.fontSize} min={24} max={120} step={1} onCommit={(fontSize) => set({ fontSize })} />
      </Row>
      <Row label="文字">
        <ColorField value={s.color} onCommit={(color) => set({ color })} />
        {preset !== 'boxed' ? (
          <>
            <span className="insp-sub">描边</span>
            <ColorField value={s.stroke} onCommit={(stroke) => set({ stroke })} />
          </>
        ) : null}
        {preset === 'karaoke' || preset === 'keyword' ? (
          <>
            <span className="insp-sub">高亮</span>
            <ColorField value={s.highlightColor ?? '#ffd60a'} onCommit={(highlightColor) => set({ highlightColor })} />
          </>
        ) : null}
      </Row>
      {preset === 'boxed' ? (
        <Row label="底框">
          <ColorField value={s.boxColor ?? '#000000'} onCommit={(boxColor) => set({ boxColor })} />
          <Slider value={s.boxOpacity ?? 0.6} min={0.1} max={1} step={0.05} format={(v) => `${Math.round(v * 100)}%`} onCommit={(boxOpacity) => set({ boxOpacity })} />
        </Row>
      ) : null}
      {preset === 'keyword' ? (
        <Row label="关键词">
          <input
            className="insp-input"
            value={keywords}
            placeholder="用逗号分隔"
            onChange={(e) => setKeywords(e.target.value)}
            onBlur={() => {
              const list = keywords.split(/[,，、\s]+/).map((w) => w.trim()).filter(Boolean)
              if (list.join() !== (s.keywords ?? []).join()) set({ keywords: list })
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </Row>
      ) : null}
    </>
  )
}
