import { useState, type ReactNode } from 'react'
import type { MediaAsset } from '@shared/types'

type Item = {
  label: string
  name: string
  args?: Record<string, unknown>
  needClip?: boolean
  needAsset?: boolean
}

const CATS: { id: string; label: string; items: Item[] }[] = [
  {
    id: 'edit',
    label: '剪辑',
    items: [
      { label: '去掉静音', name: 'remove_silence' },
      { label: '跳剪', name: 'jump_cut' },
      { label: '按镜头切', name: 'split_on_scenes' },
      { label: '复制', name: 'duplicate_clip', needClip: true },
      { label: '分离音频', name: 'detach_audio', needClip: true },
      { label: '替换镜头', name: 'replace_clip', needClip: true, needAsset: true },
      { label: '慢动作', name: 'slow_motion', args: { rate: 0.5 }, needClip: true },
      { label: '快放 2x', name: 'set_speed', args: { rate: 2 }, needClip: true },
      { label: '冻结帧', name: 'freeze_frame', needClip: true },
      { label: '倒放', name: 'reverse_clip', needClip: true },
      { label: '重置效果', name: 'reset_fx', needClip: true }
    ]
  },
  {
    id: 'trans',
    label: '转场',
    items: [
      { label: '硬切', name: 'set_transition', args: { type: 'none', durationMs: 0 } },
      { label: '柔和溶解', name: 'set_transition', args: { type: 'cross_dissolve', durationMs: 700 } },
      { label: '长溶解', name: 'set_transition', args: { type: 'cross_dissolve', durationMs: 1100 } },
      { label: '颗粒溶解', name: 'set_transition', args: { type: 'dissolve', durationMs: 700 } },
      { label: '暗场', name: 'set_transition', args: { type: 'dip_black', durationMs: 800 } },
      { label: '淡出白', name: 'set_transition', args: { type: 'fade_white', durationMs: 700 } },
      { label: '柔擦', name: 'set_transition', args: { type: 'smooth_wipe', durationMs: 700 } },
      { label: '上擦', name: 'set_transition', args: { type: 'wipe_up', durationMs: 700 } },
      { label: '左滑', name: 'set_transition', args: { type: 'slide_left', durationMs: 650 } },
      { label: '右推', name: 'set_transition', args: { type: 'push', durationMs: 650 } },
      { label: '推近', name: 'set_transition', args: { type: 'zoom', durationMs: 750 } },
      { label: '圆形', name: 'set_transition', args: { type: 'iris', durationMs: 700 } },
      { label: '模糊过渡', name: 'set_transition', args: { type: 'blur_mix', durationMs: 700 } },
      { label: '淡出黑', name: 'fade_to_black', args: { durationMs: 800 } },
      { label: '淡入', name: 'fade_from_black', args: { durationMs: 800 } }
    ]
  },
  {
    id: 'text',
    label: '文字',
    items: [
      { label: '生成字幕', name: 'captions_from_transcript' },
      { label: '靠下', name: 'set_subtitle_style', args: { position: 'bottom' } },
      { label: '靠上', name: 'set_subtitle_style', args: { position: 'top' } },
      { label: '居中', name: 'set_subtitle_style', args: { position: 'center' } },
      { label: '大字', name: 'set_subtitle_style', args: { fontSize: 56 } },
      { label: '小字', name: 'set_subtitle_style', args: { fontSize: 32 } },
      { label: '后移 0.2s', name: 'shift_subtitles', args: { deltaMs: 200 } },
      { label: '前移 0.2s', name: 'shift_subtitles', args: { deltaMs: -200 } },
      { label: '导出 SRT', name: 'export_srt' },
      { label: '标题淡入', name: 'animate_text', args: { preset: 'fade' } },
      { label: '打字机', name: 'animate_text', args: { preset: 'typewriter' } },
      { label: '下三分之一', name: 'animate_text', args: { preset: 'lower_third' } },
      { label: '矩形', name: 'add_shape', args: { shape: 'rect' } },
      { label: '椭圆', name: 'add_shape', args: { shape: 'ellipse' } }
    ]
  },
  {
    id: 'audio',
    label: '音频',
    items: [
      { label: '统一响度', name: 'normalize_loudness' },
      { label: '淡入淡出', name: 'fade_audio', args: { inMs: 400, outMs: 400 } },
      { label: '静音', name: 'mute_clip', needClip: true },
      { label: '音乐闪避', name: 'duck_music', args: { enabled: true } },
      { label: '人声增强', name: 'audio_preset', args: { name: 'voice_boost' } },
      { label: '铺选中音乐', name: 'set_music', needAsset: true },
      { label: '跟鼓点', name: 'link_to_audio', args: { prop: 'both', amount: 0.45 }, needClip: true },
      { label: '降噪', name: 'denoise_audio', args: { enabled: true, amount: 0.5 }, needClip: true }
    ]
  },
  {
    id: 'look',
    label: '画面',
    items: [
      { label: '16:9', name: 'set_aspect', args: { aspect: '16:9' } },
      { label: '9:16', name: 'reframe', args: { aspect: '9:16' } },
      { label: '1:1', name: 'set_aspect', args: { aspect: '1:1' } },
      { label: '旋转', name: 'rotate', args: { degrees: 90 }, needClip: true },
      { label: '翻转', name: 'flip', needClip: true },
      { label: '放大', name: 'zoom_in', needClip: true },
      { label: '自动增强', name: 'auto_enhance' },
      { label: '叠加图层', name: 'add_layer', needAsset: true },
      { label: '叠加 B-roll', name: 'overlay_broll', needAsset: true },
      { label: '纯色层', name: 'add_solid' },
      { label: '调整层', name: 'add_adjustment_layer' },
      { label: '稳像', name: 'stabilize', args: { enabled: true }, needClip: true },
      { label: '抠绿幕', name: 'key_color', args: { color: 'green' }, needClip: true },
      { label: '抠蓝幕', name: 'key_color', args: { color: 'blue' }, needClip: true }
    ]
  },
  {
    id: 'filter',
    label: '滤镜',
    items: [
      { label: '无', name: 'apply_filter', args: { name: 'none' } },
      { label: '鲜艳', name: 'apply_filter', args: { name: 'vivid' } },
      { label: '电影', name: 'apply_filter', args: { name: 'cinema' } },
      { label: '黑白', name: 'apply_filter', args: { name: 'bw' } },
      { label: '复古', name: 'apply_filter', args: { name: 'vintage' } },
      { label: '高斯模糊', name: 'add_effect', args: { type: 'blur' }, needClip: true },
      { label: '径向模糊', name: 'add_effect', args: { type: 'radial_blur' }, needClip: true },
      { label: '发光', name: 'add_effect', args: { type: 'glow' }, needClip: true },
      { label: '颗粒', name: 'add_effect', args: { type: 'grain' }, needClip: true },
      { label: '马赛克', name: 'add_effect', args: { type: 'mosaic' }, needClip: true },
      { label: '暖色 LUT', name: 'apply_lut', args: { name: 'warm' }, needClip: true },
      { label: '冷色 LUT', name: 'apply_lut', args: { name: 'cool' }, needClip: true }
    ]
  },
  {
    id: 'mask',
    label: '蒙版',
    items: [
      { label: '椭圆', name: 'add_mask', args: { shape: 'ellipse', mode: 'add' }, needClip: true },
      { label: '矩形', name: 'add_mask', args: { shape: 'rect', mode: 'add' }, needClip: true },
      { label: '减去椭圆', name: 'add_mask', args: { shape: 'ellipse', mode: 'subtract' }, needClip: true },
      { label: '减去矩形', name: 'add_mask', args: { shape: 'rect', mode: 'subtract' }, needClip: true },
      { label: '清除蒙版', name: 'remove_mask', needClip: true }
    ]
  },
  {
    id: 'export',
    label: '导出',
    items: [
      { label: '1080p', name: 'export', args: { preset: '1080p' } },
      { label: '竖屏', name: 'export', args: { preset: 'shorts' } },
      { label: '4K', name: 'export', args: { preset: '4k' } },
      { label: '透明 MOV', name: 'export', args: { preset: 'alpha' } },
      { label: 'ProRes', name: 'export', args: { preset: 'prores' } },
      { label: '加入队列', name: 'render_queue_add', args: { preset: '1080p' } },
      { label: '队列透明', name: 'render_queue_add', args: { preset: 'alpha' } },
      { label: '生成代理', name: 'make_proxy' }
    ]
  }
]

export function ToolTabs({
  busy,
  clipId,
  assetId,
  assets,
  playheadMs,
  onRun,
  extra
}: {
  busy: boolean
  clipId: string | null
  assetId: string | null
  assets: MediaAsset[]
  playheadMs: number
  onRun: (name: string, args?: Record<string, unknown>) => void
  extra?: ReactNode
}) {
  const [tab, setTab] = useState('edit')
  const current = CATS.find((c) => c.id === tab) ?? CATS[0]

  function fire(item: Item) {
    const args = { ...(item.args ?? {}) }
    if (item.needClip && clipId) args.clipId = clipId
    if (item.name === 'overlay_broll' || item.name === 'add_layer') {
      const id = assetId ?? assets.find((a) => a.kind === 'video' || a.kind === 'image')?.id
      if (!id) return
      args.assetId = id
      args.startMs = playheadMs
    }
    if (item.name === 'add_solid' || item.name === 'add_adjustment_layer' || item.name === 'add_shape') {
      args.startMs = playheadMs
    }
    if (item.name === 'animate_text' || item.name === 'add_text_layer') {
      const text = window.prompt('标题文字', '标题')
      if (!text) return
      args.text = text
      args.startMs = playheadMs
    }
    if (item.name === 'freeze_frame' || item.name === 'set_keyframe') {
      args.atMs = playheadMs
    }
    if (item.name === 'make_proxy' && assetId) args.assetId = assetId
    if (item.name === 'set_music') {
      const id = assetId ?? assets.find((a) => a.kind === 'audio')?.id
      if (!id) return
      args.assetId = id
    }
    if (item.name === 'replace_clip') {
      if (!assetId) return
      args.assetId = assetId
      if (clipId) args.clipId = clipId
    }
    onRun(item.name, args)
  }

  return (
    <div className="ae-fxbar">
      <div className="ae-fx-cats">
        {CATS.map((c) => (
          <button key={c.id} className={'ae-fx-cat' + (c.id === tab ? ' on' : '')} onClick={() => setTab(c.id)}>
            {c.label}
          </button>
        ))}
        <span className="ae-fx-spacer" />
        {extra}
      </div>
      <div className="ae-fx-tools">
        {current.items.map((item) => (
          <button key={item.label} className="ae-fx-btn" disabled={busy} onClick={() => fire(item)}>
            {item.label}
          </button>
        ))}
      </div>
    </div>
  )
}
