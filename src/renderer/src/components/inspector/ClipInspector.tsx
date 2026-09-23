import { useState } from 'react'
import type { BlendMode, EaseKind, EffectType, FilterName, MaskMode, MediaAsset, TimelineClip, TransitionType } from '@shared/types'
import { clipBlend, clipFx, clipKind } from '@shared/types'
import { fxAt, hasAnim } from '@shared/anim'
import { volumeAt } from '@shared/audio'
import { effectSpec } from '@shared/effects'
import { formatTimecode } from '../../lib/format'
import { ColorField, Group, Row, Seg, Slider, TextField, Toggle } from './controls'

type Act = (name: string, args?: Record<string, unknown>) => void

const TRANSITIONS: [TransitionType, string, number][] = [
  ['none', '硬切', 0],
  ['cross_dissolve', '溶解', 700],
  ['dip_black', '暗场', 800],
  ['fade_white', '闪白', 700],
  ['smooth_wipe', '柔擦', 700],
  ['wipe_up', '上擦', 700],
  ['slide_left', '左滑', 650],
  ['push', '右推', 650],
  ['zoom', '推近', 750],
  ['iris', '圆形', 700],
  ['blur_mix', '模糊过渡', 700],
  ['dissolve', '颗粒溶解', 700]
]

const EFFECTS: [EffectType, string][] = [
  ['blur', '高斯模糊'],
  ['radial_blur', '径向模糊'],
  ['glow', '发光'],
  ['grain', '颗粒'],
  ['mosaic', '马赛克']
]

const pct = (v: number) => `${Math.round(v * 100)}%`

export function ClipInspector({
  clip,
  track,
  asset,
  playheadMs,
  onAction,
  onDelete
}: {
  clip: TimelineClip
  track: 'storyline' | 'overlay' | 'audio'
  asset?: MediaAsset
  playheadMs: number
  onAction: Act
  onDelete: () => void
}) {
  const fx = clipFx(clip)
  const live = fxAt(clip, playheadMs)
  const kind = clipKind(clip)
  const [ease, setEase] = useState<EaseKind>('ease_in_out')
  const id = clip.id
  const visual = track !== 'audio' && (kind !== 'footage' || asset?.kind !== 'audio')
  const hasSound = kind === 'footage' && (track === 'audio' || asset?.kind === 'video' || asset?.kind === 'audio')
  const inPlay = playheadMs >= clip.startMs && playheadMs <= clip.startMs + clip.durationMs

  /** 有关键帧时，改数值就是在播放头处打关键帧。 */
  const animated = (prop: 'volume' | 'opacity' | 'scale', value: number, plain: () => void) => {
    if (hasAnim(fx, prop)) onAction('set_keyframe', { clipId: id, prop, atMs: playheadMs, value, ease })
    else plain()
  }
  const kfButton = (prop: 'volume' | 'opacity' | 'scale', value: number) => (
    <button
      type="button"
      className={'kf-btn' + (hasAnim(fx, prop) ? ' on' : '')}
      title={inPlay ? '在播放头打关键帧' : '播放头不在这个片段上'}
      disabled={!inPlay}
      onClick={() => onAction('set_keyframe', { clipId: id, prop, atMs: playheadMs, value, ease })}
    >
      ◆
    </button>
  )

  const title =
    kind === 'text'
      ? '文字层'
      : kind === 'solid'
        ? '纯色层'
        : kind === 'shape'
          ? '形状'
          : kind === 'adjustment'
            ? '调整层'
            : asset?.name ?? '片段'
  const volume = hasAnim(fx, 'volume') ? volumeAt(clip, playheadMs) : clip.volume

  return (
    <div className="insp">
      <div className="insp-head">
        <div>
          <b title={title}>{title}</b>
          <small>
            {track === 'storyline' ? '主线' : track === 'overlay' ? '图层' : clip.role === 'dialog' ? '对白' : '音乐'} ·{' '}
            {formatTimecode(clip.startMs)} · {(clip.durationMs / 1000).toFixed(1)}s
          </small>
        </div>
        <button type="button" className="btn ghost danger-text" onClick={onDelete}>
          删除
        </button>
      </div>

      {kind === 'text' && clip.text ? (
        <Group id="text" title="文字">
          <TextField value={clip.text.text} onCommit={(text) => onAction('set_text', { clipId: id, text })} rows={3} />
          <Row label="字号">
            <Slider value={clip.text.fontSize} min={24} max={160} step={1} onCommit={(v) => onAction('set_text', { clipId: id, fontSize: v })} />
          </Row>
          <Row label="颜色">
            <ColorField value={clip.text.color} onCommit={(color) => onAction('set_text', { clipId: id, color })} />
            <span className="insp-sub">描边</span>
            <ColorField value={clip.text.stroke} onCommit={(stroke) => onAction('set_text', { clipId: id, stroke })} />
          </Row>
        </Group>
      ) : null}

      <Group id="basic" title="基础">
        {hasSound ? (
          <Row label="音量" keyed={hasAnim(fx, 'volume')}>
            <Slider
              value={volume}
              min={0}
              max={2}
              step={0.05}
              format={pct}
              onCommit={(v) => animated('volume', v, () => onAction('set_volume', { clipId: id, volume: v }))}
            />
            {kfButton('volume', volume)}
          </Row>
        ) : null}
        {kind === 'footage' ? (
          <Row label="速度">
            <Slider value={fx.speed} min={0.25} max={4} step={0.05} format={(v) => `${v.toFixed(2)}×`} onCommit={(v) => onAction('set_speed', { clipId: id, rate: v })} />
          </Row>
        ) : null}
        {visual ? (
          <>
            <Row label="透明" keyed={hasAnim(fx, 'opacity')}>
              <Slider
                value={live.opacity}
                min={0}
                max={1}
                step={0.05}
                format={pct}
                onCommit={(v) => animated('opacity', v, () => onAction('set_opacity', { clipId: id, opacity: v }))}
              />
              {kfButton('opacity', live.opacity)}
            </Row>
            <Row label="缩放" keyed={hasAnim(fx, 'scale')}>
              <Slider
                value={live.scale}
                min={0.2}
                max={2}
                step={0.05}
                format={(v) => `${v.toFixed(2)}×`}
                onCommit={(v) => animated('scale', v, () => onAction('set_transform', { clipId: id, scale: v }))}
              />
              {kfButton('scale', live.scale)}
            </Row>
            {track === 'overlay' ? (
              <Row label="混合">
                <select value={clipBlend(clip)} onChange={(e) => onAction('set_blend', { clipId: id, mode: e.target.value as BlendMode })}>
                  <option value="normal">正常</option>
                  <option value="add">相加</option>
                  <option value="screen">滤色</option>
                  <option value="multiply">正片叠底</option>
                </select>
              </Row>
            ) : null}
            {fx.keys && Object.values(fx.keys).some((k) => k?.length) ? (
              <Row label="缓动">
                <select value={ease} onChange={(e) => setEase(e.target.value as EaseKind)}>
                  <option value="linear">线性</option>
                  <option value="ease_in">缓入</option>
                  <option value="ease_out">缓出</option>
                  <option value="ease_in_out">缓入缓出</option>
                </select>
              </Row>
            ) : null}
          </>
        ) : null}
      </Group>

      {track === 'storyline' ? (
        <Group id="transition" title="出点转场">
          <Row label="类型">
            <select
              value={fx.transitionOut.type}
              onChange={(e) => {
                const t = TRANSITIONS.find((x) => x[0] === e.target.value)
                if (t) onAction('set_transition', { clipId: id, type: t[0], durationMs: t[2] })
              }}
            >
              {TRANSITIONS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
              {TRANSITIONS.some((x) => x[0] === fx.transitionOut.type) ? null : <option value={fx.transitionOut.type}>{fx.transitionOut.type}</option>}
            </select>
          </Row>
          {fx.transitionOut.type !== 'none' ? (
            <Row label="时长">
              <Slider
                value={fx.transitionOut.durationMs}
                min={200}
                max={2000}
                step={50}
                format={(v) => `${(v / 1000).toFixed(2)}s`}
                onCommit={(v) => onAction('set_transition', { clipId: id, type: fx.transitionOut.type, durationMs: v })}
              />
            </Row>
          ) : null}
        </Group>
      ) : null}

      {visual ? (
        <Group id="look" title="画面">
          <Row label="滤镜">
            <select value={fx.filter} onChange={(e) => onAction('apply_filter', { clipId: id, name: e.target.value as FilterName })}>
              <option value="none">无</option>
              <option value="vivid">鲜艳</option>
              <option value="cinema">电影</option>
              <option value="bw">黑白</option>
              <option value="vintage">复古</option>
            </select>
          </Row>
          {fx.effects
            .filter((e) => e.enabled !== false)
            .map((e) => {
              const spec = effectSpec(e.type)
              if (!spec) return null
              return (
                <div key={e.id} className="insp-fx">
                  <div className="insp-fx-h">
                    <span>{spec.label}</span>
                    <button type="button" className="link" onClick={() => onAction('add_effect', { clipId: id, type: e.type, remove: true })}>
                      去掉
                    </button>
                  </div>
                  {spec.params.map((p) => (
                    <Row key={p.key} label={p.label}>
                      <Slider
                        value={Number(e.params[p.key] ?? p.default)}
                        min={p.min}
                        max={p.max}
                        step={p.step}
                        onCommit={(v) => onAction('add_effect', { clipId: id, type: e.type, [p.key]: v })}
                      />
                    </Row>
                  ))}
                  {e.type === 'lut' ? (
                    <Row label="LUT">
                      <select value={String(e.params.name || 'warm')} onChange={(ev) => onAction('apply_lut', { clipId: id, name: ev.target.value })}>
                        <option value="warm">暖色</option>
                        <option value="cool">冷色</option>
                        <option value="contrast">对比</option>
                      </select>
                    </Row>
                  ) : null}
                </div>
              )
            })}
          <Row label="特效">
            <select
              value=""
              onChange={(e) => {
                const v = e.target.value
                if (v === 'lut') onAction('apply_lut', { clipId: id, name: 'warm' })
                else if (v) onAction('add_effect', { clipId: id, type: v })
              }}
            >
              <option value="">添加…</option>
              {EFFECTS.filter(([t]) => !fx.effects.some((e) => e.type === t && e.enabled !== false)).map(([t, label]) => (
                <option key={t} value={t}>
                  {label}
                </option>
              ))}
              {fx.effects.some((e) => e.type === 'lut') ? null : <option value="lut">LUT</option>}
            </select>
          </Row>
          {kind === 'footage' ? (
            <>
              <Row label="方向">
                <button type="button" className="btn small" onClick={() => onAction('rotate', { clipId: id, degrees: (fx.rotate + 90) % 360 })}>
                  旋转 {fx.rotate ? `${fx.rotate}°` : ''}
                </button>
                <button type="button" className={'btn small' + (fx.flipX ? ' on' : '')} onClick={() => onAction('flip', { clipId: id })}>
                  翻转
                </button>
              </Row>
              <Row label="稳像">
                <Toggle on={Boolean(fx.stabilize?.enabled)} onChange={(on) => onAction('stabilize', { clipId: id, enabled: on })} />
                {fx.stabilize?.enabled ? (
                  <Slider
                    value={fx.stabilize.amount}
                    min={0}
                    max={1}
                    step={0.05}
                    format={pct}
                    onCommit={(v) => onAction('stabilize', { clipId: id, enabled: true, amount: v })}
                  />
                ) : null}
              </Row>
              <Row label="抠像">
                <Toggle on={Boolean(fx.key)} onChange={(on) => onAction('key_color', on ? { clipId: id, color: 'green' } : { clipId: id, remove: true })} />
                {fx.key ? (
                  <Seg
                    value={fx.key.color === '#0000ff' ? 'blue' : 'green'}
                    options={[
                      ['green', '绿幕'],
                      ['blue', '蓝幕']
                    ]}
                    onChange={(color) => onAction('key_color', { clipId: id, color })}
                  />
                ) : null}
              </Row>
              {fx.key ? (
                <>
                  <Row label="容差">
                    <Slider value={fx.key.tolerance} min={0.05} max={0.8} step={0.01} format={(v) => v.toFixed(2)} onCommit={(v) => onAction('key_color', { clipId: id, tolerance: v })} />
                  </Row>
                  <Row label="溢色">
                    <Slider value={fx.key.spill} min={0} max={1} step={0.05} format={pct} onCommit={(v) => onAction('key_color', { clipId: id, spill: v })} />
                  </Row>
                  <Row label="边缘">
                    <Slider value={fx.key.edge} min={0} max={0.4} step={0.01} format={(v) => v.toFixed(2)} onCommit={(v) => onAction('key_color', { clipId: id, edge: v })} />
                  </Row>
                </>
              ) : null}
            </>
          ) : null}
        </Group>
      ) : null}

      {visual ? (
        <Group id="mask" title="蒙版" defaultOpen={false} aside={fx.masks.length ? <span className="badge">{fx.masks.length}</span> : null}>
          {fx.masks.length ? (
            <>
              <Row label="模式">
                <Seg
                  value={fx.masks[0]!.mode}
                  options={[
                    ['add', '保留'],
                    ['subtract', '挖掉']
                  ]}
                  onChange={(mode: MaskMode) => onAction('set_mask', { clipId: id, maskId: fx.masks[0]!.id, mode })}
                />
              </Row>
              <Row label="羽化">
                <Slider
                  value={fx.masks[0]!.feather}
                  min={0}
                  max={0.25}
                  step={0.01}
                  format={(v) => v.toFixed(2)}
                  onCommit={(v) => onAction('set_mask', { clipId: id, maskId: fx.masks[0]!.id, feather: v })}
                />
              </Row>
              <p className="insp-hint">在预览画面里拖动蒙版的框和手柄调整位置。</p>
            </>
          ) : null}
          <Row label="添加">
            <button type="button" className="btn small" onClick={() => onAction('add_mask', { clipId: id, shape: 'ellipse', mode: 'add' })}>
              椭圆
            </button>
            <button type="button" className="btn small" onClick={() => onAction('add_mask', { clipId: id, shape: 'rect', mode: 'add' })}>
              矩形
            </button>
            {fx.masks.length ? (
              <button type="button" className="btn small" onClick={() => onAction('remove_mask', { clipId: id })}>
                清除
              </button>
            ) : null}
          </Row>
        </Group>
      ) : null}

      {hasSound ? (
        <Group id="audio" title="声音">
          <Row label="降噪">
            <Toggle on={Boolean(fx.denoise?.enabled)} onChange={(on) => onAction('denoise_audio', { clipId: id, enabled: on, amount: fx.denoise?.amount ?? 0.5 })} />
            {fx.denoise?.enabled ? (
              <Slider value={fx.denoise.amount} min={0} max={1} step={0.05} format={pct} onCommit={(v) => onAction('denoise_audio', { clipId: id, enabled: true, amount: v })} />
            ) : null}
          </Row>
          <Row label="人声增强">
            <Toggle on={Boolean(fx.voice?.preset)} onChange={(on) => onAction('voice_enhance', { clipId: id, preset: on ? 'podcast' : 'off' })} />
            {fx.voice?.preset ? (
              <select value={fx.voice.preset} onChange={(e) => onAction('voice_enhance', { clipId: id, preset: e.target.value })}>
                <option value="podcast">播客</option>
                <option value="clear">清晰</option>
                <option value="warm">温暖</option>
              </select>
            ) : null}
          </Row>
          <Row label="淡入">
            <Slider
              value={fx.fadeInMs}
              min={0}
              max={3000}
              step={50}
              format={(v) => `${(v / 1000).toFixed(1)}s`}
              onCommit={(v) => onAction('fade_audio', { clipId: id, inMs: v, outMs: fx.fadeOutMs })}
            />
          </Row>
          <Row label="淡出">
            <Slider
              value={fx.fadeOutMs}
              min={0}
              max={3000}
              step={50}
              format={(v) => `${(v / 1000).toFixed(1)}s`}
              onCommit={(v) => onAction('fade_audio', { clipId: id, inMs: fx.fadeInMs, outMs: v })}
            />
          </Row>
          {visual ? (
            <Row label="跟鼓点">
              <Toggle
                on={Boolean(fx.audioLink)}
                onChange={(on) => onAction('link_to_audio', on ? { clipId: id, prop: 'both', amount: 0.45 } : { clipId: id, remove: true })}
              />
            </Row>
          ) : null}
        </Group>
      ) : null}

      {kind === 'footage' ? (
        <Group id="time" title="时间与片段" defaultOpen={false}>
          <div className="insp-btns">
            <button type="button" className={'btn small' + (fx.freeze ? ' on' : '')} onClick={() => onAction('freeze_frame', { clipId: id, atMs: playheadMs })}>
              {fx.freeze ? '取消冻结' : '冻结帧'}
            </button>
            <button type="button" className={'btn small' + (fx.reverse ? ' on' : '')} onClick={() => onAction('reverse_clip', { clipId: id })}>
              {fx.reverse ? '正放' : '倒放'}
            </button>
            <button type="button" className="btn small" onClick={() => onAction('duplicate_clip', { clipId: id })}>
              复制
            </button>
            {track === 'storyline' && asset?.kind === 'video' ? (
              <button type="button" className="btn small" onClick={() => onAction('detach_audio', { clipId: id })}>
                分离音频
              </button>
            ) : null}
            <button type="button" className="btn small" onClick={() => onAction('reset_fx', { clipId: id })}>
              重置效果
            </button>
          </div>
        </Group>
      ) : null}
    </div>
  )
}
