import type { MediaAsset, MediaKind } from '@shared/types'

/** 命令面板（⌘K）里的一条命令：调用一个剪辑工具，或交给 App 处理的界面动作（app）。 */
export type Command = {
  id: string
  label: string
  group: string
  keywords?: string
  tool?: string
  args?: Record<string, unknown>
  /** clip = 必须选中片段；clipOrAll = 选中时作用于它，否则作用于全部故事线片段。 */
  scope?: 'clip' | 'clipOrAll'
  /** 片段 id 用什么参数名传（默认 clipId）。 */
  clipKey?: string
  /** 需要素材：优先用素材库里选中的；autoPick 时没选就取第一个合适的。 */
  asset?: { kinds: MediaKind[]; autoPick?: boolean; key?: string }
  /** 用播放头位置填的参数。 */
  at?: 'startMs' | 'atMs'
  /** 执行前要用户填的一个值（行内输入，代替 window.prompt）。 */
  ask?: { key: string; label: string; default?: string; number?: boolean; scale?: number }
  app?: string
  hint?: string
}

export type CommandCtx = {
  clipId: string | null
  assetId: string | null
  assets: MediaAsset[]
  playheadMs: number
}

export type Resolved = { ok: true; args: Record<string, unknown>; note?: string } | { ok: false; reason: string }

const T = (
  group: string,
  label: string,
  tool: string,
  extra: Partial<Command> = {}
): Command => ({ id: `${tool}:${label}`, group, label, tool, ...extra })

const TRANSITIONS: [string, string, number][] = [
  ['硬切（清除转场）', 'none', 0],
  ['柔和溶解', 'cross_dissolve', 700],
  ['长溶解', 'cross_dissolve', 1100],
  ['暗场', 'dip_black', 800],
  ['闪白', 'fade_white', 700],
  ['柔擦', 'smooth_wipe', 700],
  ['上擦', 'wipe_up', 700],
  ['左滑', 'slide_left', 650],
  ['右推', 'push', 650],
  ['推近', 'zoom', 750],
  ['圆形', 'iris', 700],
  ['模糊过渡', 'blur_mix', 700]
]

export const COMMANDS: Command[] = [
  // 智能粗剪
  T('智能粗剪', '去掉静音', 'remove_silence', { keywords: 'silence 静音 空白' }),
  T('智能粗剪', '压缩停顿', 'tighten_pauses', { args: { maxPauseMs: 400 }, keywords: 'pause 停顿 节奏' }),
  T('智能粗剪', '去掉口头禅', 'remove_filler', { keywords: 'filler 嗯 啊 那个' }),
  T('智能粗剪', '去掉重录（保留最后一遍）', 'detect_retakes', { args: { apply: true }, keywords: 'retake NG 重说' }),
  T('智能粗剪', '按镜头切开', 'split_on_scenes', { keywords: 'scene 场景' }),
  T('智能粗剪', '跳剪处推近', 'punch_in', { keywords: 'punch zoom 跳剪' }),
  T('智能粗剪', '压缩到指定时长', 'fit_duration', { ask: { key: 'targetMs', label: '目标时长（秒）', default: '60', number: true, scale: 1000 } }),
  T('智能粗剪', '切点对齐鼓点', 'snap_cuts_to_beats', { keywords: 'beat 节拍 音乐' }),

  // 剪辑
  T('剪辑', '复制片段', 'duplicate_clip', { scope: 'clip', keywords: 'duplicate copy' }),
  T('剪辑', '分离音频', 'detach_audio', { scope: 'clip', keywords: 'detach' }),
  T('剪辑', '替换为选中素材', 'replace_clip', { scope: 'clip', asset: { kinds: ['video', 'image'] } }),
  T('剪辑', '冻结帧', 'freeze_frame', { scope: 'clip', at: 'atMs', keywords: 'freeze' }),
  T('剪辑', '倒放', 'reverse_clip', { scope: 'clip', keywords: 'reverse' }),
  T('剪辑', '变速…', 'set_speed', { scope: 'clipOrAll', ask: { key: 'rate', label: '倍速（0.25–4）', default: '1.5', number: true }, keywords: 'speed 速度' }),
  T('剪辑', '慢动作 0.5×', 'set_speed', { scope: 'clip', args: { rate: 0.5 }, keywords: 'slow' }),
  T('剪辑', '缓推（Ken Burns）', 'ken_burns', { scope: 'clip', args: { to: { scale: 1.15 } }, keywords: 'ken burns 推' }),
  T('剪辑', '重置效果', 'reset_fx', { scope: 'clip', keywords: 'reset' }),
  T('剪辑', '在播放头加标记…', 'add_marker', { at: 'atMs', ask: { key: 'label', label: '标记名', default: '标记' }, keywords: 'marker' }),

  // 转场
  ...TRANSITIONS.map(([label, type, durationMs]) =>
    T('转场', label, 'set_transition', { scope: 'clipOrAll', args: { type, durationMs }, keywords: `transition ${type}` })
  ),
  T('转场', '片尾淡出黑', 'fade_to_black', { args: { durationMs: 800 }, keywords: 'fade' }),
  T('转场', '片头淡入', 'fade_from_black', { args: { durationMs: 800 }, keywords: 'fade' }),

  // 字幕
  T('字幕', '按语音生成字幕', 'captions_from_transcript', { keywords: 'caption subtitle 字幕' }),
  T('字幕', '字幕样式：简洁描边', 'set_subtitle_style', { args: { preset: 'clean', color: '#ffffff', stroke: '#000000' } }),
  T('字幕', '字幕样式：底框', 'set_subtitle_style', { args: { preset: 'boxed', boxColor: '#000000', boxOpacity: 0.6 } }),
  T('字幕', '字幕样式：卡拉 OK', 'set_subtitle_style', { args: { preset: 'karaoke', highlightColor: '#ffd60a' } }),
  T('字幕', '字幕样式：关键词高亮', 'set_subtitle_style', { args: { preset: 'keyword', highlightColor: '#ff9f0a' } }),
  T('字幕', '字幕靠下', 'set_subtitle_style', { args: { position: 'bottom' } }),
  T('字幕', '字幕靠上', 'set_subtitle_style', { args: { position: 'top' } }),
  T('字幕', '字幕居中', 'set_subtitle_style', { args: { position: 'center' } }),
  T('字幕', '字幕整体后移 0.2 秒', 'shift_subtitles', { args: { deltaMs: 200 } }),
  T('字幕', '字幕整体前移 0.2 秒', 'shift_subtitles', { args: { deltaMs: -200 } }),
  T('字幕', '导出 SRT', 'export_srt', { keywords: 'srt' }),

  // 文字与标题
  T('文字', '片头标题…', 'title_card', { args: { kind: 'intro' }, ask: { key: 'title', label: '标题', default: '' }, keywords: 'title intro 片头' }),
  T('文字', '章节卡…', 'title_card', { args: { kind: 'chapter' }, at: 'atMs', ask: { key: 'title', label: '章节标题', default: '' }, keywords: 'chapter' }),
  T('文字', '片尾卡…', 'title_card', { args: { kind: 'end' }, ask: { key: 'title', label: '片尾文字', default: '感谢观看' }, keywords: 'end outro' }),
  T('文字', '文字层…', 'add_text_layer', { at: 'startMs', ask: { key: 'text', label: '文字', default: '' }, keywords: 'text' }),
  T('文字', '标题淡入…', 'animate_text', { args: { preset: 'fade' }, at: 'startMs', ask: { key: 'text', label: '标题文字', default: '' } }),
  T('文字', '打字机标题…', 'animate_text', { args: { preset: 'typewriter' }, at: 'startMs', ask: { key: 'text', label: '标题文字', default: '' } }),
  T('文字', '人名条（下三分之一）…', 'animate_text', { args: { preset: 'lower_third' }, at: 'startMs', ask: { key: 'text', label: '人名 / 说明', default: '' }, keywords: 'lower third 人名' }),
  T('文字', '矩形', 'add_shape', { args: { shape: 'rect' }, at: 'startMs' }),
  T('文字', '椭圆', 'add_shape', { args: { shape: 'ellipse' }, at: 'startMs' }),

  // 音频
  T('音频', '铺背景音乐', 'set_music', { asset: { kinds: ['audio'], autoPick: true }, keywords: 'music bgm 配乐' }),
  T('音频', '音乐闪避（人声时压低）', 'duck_music', { args: { enabled: true }, keywords: 'duck' }),
  T('音频', '统一响度', 'normalize_loudness', { keywords: 'loudness lufs' }),
  T('音频', '人声增强', 'voice_enhance', { scope: 'clipOrAll', keywords: 'voice 人声' }),
  T('音频', '降噪', 'denoise_audio', { scope: 'clip', args: { enabled: true, amount: 0.5 }, keywords: 'denoise noise' }),
  T('音频', '淡入淡出', 'fade_audio', { scope: 'clipOrAll', args: { inMs: 400, outMs: 400 } }),
  T('音频', '静音片段', 'mute_clip', { scope: 'clip', keywords: 'mute' }),
  T('音频', '画面跟鼓点', 'link_to_audio', { scope: 'clip', args: { prop: 'both', amount: 0.45 }, keywords: 'beat' }),

  // 画面
  T('画面', '画幅 16:9', 'set_aspect', { args: { aspect: '16:9' }, keywords: 'aspect 横屏' }),
  T('画面', '画幅 9:16（竖屏重构图）', 'reframe', { args: { aspect: '9:16' }, keywords: 'aspect 竖屏 shorts' }),
  T('画面', '画幅 1:1', 'set_aspect', { args: { aspect: '1:1' }, keywords: 'aspect 方形' }),
  T('画面', '自动增强', 'auto_enhance', { keywords: 'enhance 调色' }),
  T('画面', '以选中片段统一色调', 'color_match', { scope: 'clip', clipKey: 'refClipId', keywords: 'color match 色调' }),
  T('画面', '旋转 90°', 'rotate', { scope: 'clip', args: { degrees: 90 } }),
  T('画面', '水平翻转', 'flip', { scope: 'clip' }),
  T('画面', '稳像', 'stabilize', { scope: 'clip', args: { enabled: true }, keywords: 'stabilize' }),
  T('画面', '抠绿幕', 'key_color', { scope: 'clip', args: { color: 'green' }, keywords: 'key chroma' }),
  T('画面', '抠蓝幕', 'key_color', { scope: 'clip', args: { color: 'blue' }, keywords: 'key chroma' }),
  T('画面', '在播放头叠加 B-roll', 'insert_broll', { asset: { kinds: ['video', 'image'] }, at: 'atMs', keywords: 'broll 空镜' }),
  T('画面', '叠加图层', 'add_layer', { asset: { kinds: ['video', 'image'], autoPick: true }, at: 'startMs', keywords: 'layer overlay' }),
  T('画面', '纯色层', 'add_solid', { at: 'startMs' }),
  T('画面', '调整层', 'add_adjustment_layer', { at: 'startMs' }),

  // 滤镜与特效
  T('滤镜', '滤镜：鲜艳', 'apply_filter', { scope: 'clipOrAll', args: { name: 'vivid' } }),
  T('滤镜', '滤镜：电影', 'apply_filter', { scope: 'clipOrAll', args: { name: 'cinema' } }),
  T('滤镜', '滤镜：黑白', 'apply_filter', { scope: 'clipOrAll', args: { name: 'bw' } }),
  T('滤镜', '滤镜：复古', 'apply_filter', { scope: 'clipOrAll', args: { name: 'vintage' } }),
  T('滤镜', '去掉滤镜', 'apply_filter', { scope: 'clipOrAll', args: { name: 'none' } }),
  T('滤镜', '暖色 LUT', 'apply_lut', { scope: 'clipOrAll', args: { name: 'warm' } }),
  T('滤镜', '冷色 LUT', 'apply_lut', { scope: 'clipOrAll', args: { name: 'cool' } }),
  T('滤镜', '高斯模糊', 'add_effect', { scope: 'clip', args: { type: 'blur' } }),
  T('滤镜', '径向模糊', 'add_effect', { scope: 'clip', args: { type: 'radial_blur' } }),
  T('滤镜', '发光', 'add_effect', { scope: 'clip', args: { type: 'glow' } }),
  T('滤镜', '颗粒', 'add_effect', { scope: 'clip', args: { type: 'grain' } }),
  T('滤镜', '马赛克', 'add_effect', { scope: 'clip', args: { type: 'mosaic' } }),

  // 蒙版
  T('蒙版', '椭圆蒙版', 'add_mask', { scope: 'clip', args: { shape: 'ellipse', mode: 'add' }, keywords: 'mask' }),
  T('蒙版', '矩形蒙版', 'add_mask', { scope: 'clip', args: { shape: 'rect', mode: 'add' }, keywords: 'mask' }),
  T('蒙版', '减去椭圆', 'add_mask', { scope: 'clip', args: { shape: 'ellipse', mode: 'subtract' }, keywords: 'mask' }),
  T('蒙版', '减去矩形', 'add_mask', { scope: 'clip', args: { shape: 'rect', mode: 'subtract' }, keywords: 'mask' }),
  T('蒙版', '清除蒙版', 'remove_mask', { scope: 'clip', keywords: 'mask' }),

  // 交付
  T('导出', '加入渲染队列（1080p）', 'render_queue_add', { args: { preset: '1080p' }, keywords: 'queue' }),
  T('导出', '为选中素材生成代理', 'make_proxy', { asset: { kinds: ['video'] }, keywords: 'proxy' }),

  // 界面
  { id: 'app:export', group: '应用', label: '导出…', app: 'export', hint: '⌘E', keywords: 'export render' },
  { id: 'app:qa', group: '应用', label: '质检时间线', app: 'qa', keywords: 'review check 检查' },
  { id: 'app:undo', group: '应用', label: '撤销', app: 'undo', hint: '⌘Z' },
  { id: 'app:redo', group: '应用', label: '重做', app: 'redo', hint: '⇧⌘Z' },
  { id: 'app:import', group: '应用', label: '导入素材…', app: 'import', hint: '⌘I' },
  { id: 'app:split', group: '应用', label: '在播放头分割', app: 'split', hint: '⌘B', keywords: 'split blade' },
  { id: 'app:fit', group: '应用', label: '时间线适配窗口', app: 'fit', hint: '⇧Z', keywords: 'zoom' },
  { id: 'app:snap', group: '应用', label: '开关吸附', app: 'snap', hint: 'N', keywords: 'snap magnet' },
  { id: 'app:terminal', group: '应用', label: '显示 / 隐藏终端', app: 'terminal', hint: '⌘`' },
  ...['claude', 'codex', 'grok', 'gemini'].map((a) => ({ id: `app:agent:${a}`, group: 'AI', label: `在终端启动 ${a}`, app: `agent:${a}`, keywords: `ai agent ${a}` })),
  { id: 'app:settings', group: '应用', label: '设置', app: 'settings', keywords: 'mcp settings' },
  { id: 'app:close', group: '应用', label: '关闭项目', app: 'close', keywords: 'close' }
]

function pickAsset(cmd: Command, ctx: CommandCtx): MediaAsset | null {
  const need = cmd.asset
  if (!need) return null
  const sel = ctx.assets.find((a) => a.id === ctx.assetId)
  if (sel && need.kinds.includes(sel.kind)) return sel
  if (need.autoPick) return ctx.assets.find((a) => need.kinds.includes(a.kind)) ?? null
  return null
}

/** 用当前选择补全参数；缺东西时返回原因（面板里把命令置灰）。 */
export function resolveCommand(cmd: Command, ctx: CommandCtx): Resolved {
  const args: Record<string, unknown> = { ...(cmd.args ?? {}) }
  let note: string | undefined
  if (cmd.scope === 'clip') {
    if (!ctx.clipId) return { ok: false, reason: '先选中片段' }
    args[cmd.clipKey ?? 'clipId'] = ctx.clipId
  } else if (cmd.scope === 'clipOrAll') {
    args.clipId = ctx.clipId ?? 'all'
    note = ctx.clipId ? '选中片段' : '全部片段'
  }
  if (cmd.asset) {
    const asset = pickAsset(cmd, ctx)
    if (!asset) {
      const kind = cmd.asset.kinds.includes('audio') ? '音频' : '视频或图片'
      return { ok: false, reason: `先在素材库选中${kind}素材` }
    }
    args[cmd.asset.key ?? 'assetId'] = asset.id
  }
  if (cmd.at) args[cmd.at] = Math.round(ctx.playheadMs)
  return { ok: true, args, note }
}

/** 搜索：标签、分组、关键词都参与；每个字依次出现即算匹配（支持拼音首字母以外的简写）。 */
export function matchCommand(cmd: Command, q: string): number {
  const query = q.trim().toLowerCase()
  if (!query) return 1
  const hay = `${cmd.label} ${cmd.group} ${cmd.keywords ?? ''} ${cmd.tool ?? ''}`.toLowerCase()
  const idx = hay.indexOf(query)
  if (idx >= 0) return idx === 0 ? 100 : cmd.label.toLowerCase().includes(query) ? 80 : 50
  let i = 0
  for (const ch of hay) if (ch === query[i]) i++
  return i === query.length ? 10 : 0
}
