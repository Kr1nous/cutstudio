import { upsertKey } from '../shared/anim'
import { beatScaleKeys, onsetTimes } from '../shared/audio'
import { cubeFileText, defaultEffect, EFFECT_REGISTRY, effectSpec, makeLut } from '../shared/effects'
import { packStorylineClips, sourceTimeMs } from '../shared/compose'
import { resolveTransition, TRANSITIONS } from '../shared/transition'
import { defaultKey, isBlueKey, parseKeyColor } from '../shared/key'
import { clampMask, defaultMask } from '../shared/mask'
import { FADE_IN_KEYS } from '../shared/text'
import { id } from '../shared/ids'
import {
  type ActionResult,
  type AnimProp,
  type AspectPreset,
  type AudioLinkProp,
  type BlendMode,
  type ClipFx,
  type EaseKind,
  type EffectType,
  type FilterName,
  type MaskMode,
  type MaskShape,
  type ShapeKind,
  type TextPreset,
  type Project,
  type ReviewAction,
  type SubtitleCue,
  type TimeRange,
  type TimelineClip,
  type TranscriptCue,
  type TransitionType,
  clipFx,
  clipKind,
  timelineDurationMs
} from '../shared/types'
import type { ToolSpec } from './ai/providers'
import { store } from './core'
import { isTextTool, rebuildCaptionsIfAny, runTextTool } from './textedit'
import { isVisualTool, runVisual } from './visual'
import { isCraftTool, runCraft } from './craft'
import { isTitleTool, runTitleTool } from './titles'

export const ACTION_TOOLS: ToolSpec[] = [
  { name: 'get_index', description: '读素材分析结果：每条素材的说话段、静音数、镜头切点、响度，以及转写（transcriptReady）。剪辑前先调用，决定剪法。只读。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'search_media', description: '按文件名搜素材（query 为关键词，也接受 q）。', parameters: { type: 'object', properties: { query: { type: 'string' }, q: { type: 'string' } } } },
  { name: 'search_transcript', description: '按台词搜索转写。', parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
  { name: 'set_aspect', description: '改项目画幅 16:9 / 9:16 / 1:1。不裁切素材；横屏素材转竖屏请用 reframe，再用 get_frame 检查人物是否在画面内。', parameters: { type: 'object', properties: { aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'] } }, required: ['aspect'] } },
  { name: 'remove_silence', description: '口播粗剪首选：按静音分析切掉停顿，重排故事线（会改时长、会重建片段 id）。minMs=多长的静音才切（知识讲解 500，短视频 280），padMs=切口两侧保留的呼吸（50–150）。不要自己 trim 去静音。结果里的碎片警告要处理。', parameters: { type: 'object', properties: { minMs: { type: 'number' }, padMs: { type: 'number' } } } },
  { name: 'keep_speech', description: '等同 remove_silence minMs 400 padMs 120。', parameters: { type: 'object', properties: {} } },
  { name: 'fit_duration', description: '最后手段：先去静音，仍超长时整体加速（最多 1.15x）。优先删内容来控时长。', parameters: { type: 'object', properties: { targetMs: { type: 'number' } }, required: ['targetMs'] } },
  { name: 'set_subtitle_style', description: '全局字幕样式。fontSize 以短边 1080 像素计：横屏 44–52，竖屏 60–80。position: bottom|top|center（竖屏短视频常用 center 偏下）。preset: clean（描边，默认）| boxed（半透明底框，画面花时更清楚，boxColor/boxOpacity）| karaoke（逐词高亮，短视频）| keyword（keywords 里的词用 highlightColor 变色放大，强调核心概念，每句最多 1–2 个）。', parameters: { type: 'object', properties: { fontSize: { type: 'number' }, color: { type: 'string' }, stroke: { type: 'string' }, position: { type: 'string', enum: ['bottom', 'top', 'center'] }, preset: { type: 'string', enum: ['clean', 'boxed', 'karaoke', 'keyword'] }, highlightColor: { type: 'string' }, boxColor: { type: 'string' }, boxOpacity: { type: 'number' }, keywords: { type: 'array', items: { type: 'string' } } } } },
  { name: 'set_volume', description: '片段音量 0–2（1=原始）。clipId 必填；支持 clipIds 或 clipId:"all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } }, volume: { type: 'number' } }, required: ['volume'] } },
  { name: 'fade_audio', description: '片段音频淡入淡出（毫秒）。接缝爆音用 20–60，片尾音乐 1000–2000。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } }, inMs: { type: 'number' }, outMs: { type: 'number' } } } },
  { name: 'normalize_loudness', description: '按素材实测响度（LUFS）统一故事线音量。targetLufs 默认 -16（口播），短视频平台可用 -14。', parameters: { type: 'object', properties: { targetLufs: { type: 'number' } } } },
  { name: 'set_music', description: '铺背景音乐到全片（替换已有音乐，保留 J/L cut 对白）。自动裁到成片长度并淡出（fadeOutMs 默认 1500）。不传 volume 时按实测响度自动定音量：音乐（闪避前）比人声低 relativeLu（默认 -12，范围 -30 到 -6；想更轻用 -16）；手动 volume 会被照用，但返回估计响度，太小声会警告。inMs 可跳过音乐前奏。配合 duck_music。先剪完、做完 normalize_loudness 再铺音乐。', parameters: { type: 'object', properties: { assetId: { type: 'string' }, volume: { type: 'number' }, relativeLu: { type: 'number' }, inMs: { type: 'number' }, fadeOutMs: { type: 'number' } }, required: ['assetId'] } },
  { name: 'duck_music', description: '人声出现时自动压低背景音乐（导出用人声作侧链压缩，没人说话时音乐恢复）。有音乐就应开启。ratio 0.2–0.4，越小压得越狠，默认 0.28。', parameters: { type: 'object', properties: { enabled: { type: 'boolean' }, ratio: { type: 'number' } } } },
  { name: 'set_transition', description: '设置片段出点转场（该片段 → 下一片段）。规则：跳剪一律硬切，不要加转场；只在段落/场景/时间跳跃处用 cross_dissolve(600–800) / dip_black(700–1000)，Vlog 场景切换可少量用 smooth_wipe / push / zoom。必须给 clipId 或 clipIds；clipId:"all" 只允许 type=none（清除全部转场）。type: none|cross_dissolve|dissolve|dip_black|fade_white|push|slide_left|smooth_wipe|wipe_up|cover|reveal|zoom|iris|blur_mix。片尾用 fade_to_black，不要给最后一段设转场。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, type: { type: 'string' }, durationMs: { type: 'number' } }, required: ['type'] } },
  { name: 'list_transitions', description: '列出可用转场及默认时长。', parameters: { type: 'object', properties: {} } },
  { name: 'fade_to_black', description: '片尾淡出到黑（作用于最后一个片段）。durationMs 默认 800。', parameters: { type: 'object', properties: { durationMs: { type: 'number' } } } },
  { name: 'fade_from_black', description: '片头从黑淡入（作用于第一个片段）。durationMs 400–800；短视频通常不用。', parameters: { type: 'object', properties: { durationMs: { type: 'number' } } } },
  { name: 'set_speed', description: '片段变速 0.25–8（会改时长）。口播加速不要超过 1.15。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } }, rate: { type: 'number' }, pitchPreserve: { type: 'boolean' } }, required: ['rate'] } },
  { name: 'crop', description: '裁切，x/y/w/h 为 0–1 的比例。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' } } } },
  { name: 'rotate', description: '旋转 0/90/180/270，用于修正拍摄方向。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } }, degrees: { type: 'number' } }, required: ['degrees'] } },
  { name: 'apply_filter', description: '风格滤镜 none|vivid|cinema|bw|vintage。全片保持同一种风格。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } }, name: { type: 'string' } }, required: ['name'] } },
  { name: 'list_effects', description: '列出可加特效：blur/radial_blur/glow/grain/mosaic/lut。', parameters: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'add_effect', description: '加特效（同类型覆盖）。type: blur|radial_blur|glow|grain|mosaic|lut，amount 强度，remove=true 去掉。只在明确需要时用（打码、MV、强调），不要为了「精美」堆叠。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } }, type: { type: 'string' }, amount: { type: 'number' }, name: { type: 'string' }, path: { type: 'string' }, remove: { type: 'boolean' } }, required: ['type'] } },
  { name: 'apply_lut', description: '套调色 LUT：name warm|cool|contrast|green，或 path 指向 .cube。全片统一一种。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } }, name: { type: 'string' }, path: { type: 'string' } } } },
  { name: 'color_adjust', description: '小幅调色：exposure/contrast/saturation/warmth，范围 -1–1，常用 ±0.05–0.2。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } }, exposure: { type: 'number' }, contrast: { type: 'number' }, saturation: { type: 'number' }, warmth: { type: 'number' } } } },
  { name: 'overlay_broll', description: '把 B-roll 以画中画放到右下角叠加层。要铺满画面盖住跳剪请用 add_layer。', parameters: { type: 'object', properties: { assetId: { type: 'string' }, startMs: { type: 'number' }, durationMs: { type: 'number' } }, required: ['assetId'] } },
  { name: 'add_layer', description: '在故事线上方叠一层视频/图片并铺满画布（B-roll 盖在讲解上，下层声音保留）。startMs/durationMs 为时间线毫秒。', parameters: { type: 'object', properties: { assetId: { type: 'string' }, startMs: { type: 'number' }, durationMs: { type: 'number' }, blend: { type: 'string', enum: ['normal', 'add', 'screen', 'multiply'] } }, required: ['assetId'] } },
  { name: 'set_blend', description: '图层混合：normal | add | screen | multiply。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, mode: { type: 'string', enum: ['normal', 'add', 'screen', 'multiply'] } }, required: ['mode'] } },
  { name: 'add_adjustment_layer', description: '调整层：滤镜/调色作用于下方全部画面。', parameters: { type: 'object', properties: { startMs: { type: 'number' }, durationMs: { type: 'number' }, filter: { type: 'string' }, saturation: { type: 'number' } } } },
  { name: 'add_solid', description: '纯色层。color 为 #rrggbb，默认黑。', parameters: { type: 'object', properties: { color: { type: 'string' }, startMs: { type: 'number' }, durationMs: { type: 'number' }, blend: { type: 'string' } } } },
  { name: 'add_text_layer', description: '自定义文字层（不写字幕轨）。x/y 为 0–1 的中心位置，默认 3 秒居中。一般优先 animate_text。', parameters: { type: 'object', properties: { text: { type: 'string' }, startMs: { type: 'number' }, durationMs: { type: 'number' }, fontSize: { type: 'number' }, color: { type: 'string' }, stroke: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } }, required: ['text'] } },
  { name: 'animate_text', description: '标题 / 人名条 / 章节卡的首选。preset: fade（标题、章节，2–3 秒）| typewriter（强调短句）| lower_third（人名条「姓名 · 身份」，3–4 秒）。文字 ≤ 12 字。位置默认自动避开字幕（字幕居中时标题在上方，字幕在底部时人名条抬到字幕上方）；也可 position: top|center|bottom 或 y 0–1。fontSize 以短边 1080 计，竖屏大标题 90–120。', parameters: { type: 'object', properties: { text: { type: 'string' }, preset: { type: 'string', enum: ['fade', 'typewriter', 'lower_third'] }, startMs: { type: 'number' }, durationMs: { type: 'number' }, position: { type: 'string', enum: ['top', 'center', 'bottom'] }, y: { type: 'number' }, fontSize: { type: 'number' } }, required: ['text'] } },
  { name: 'add_shape', description: '矩形或椭圆色块。shape: rect|ellipse。color 为 #rrggbb。width/height 为画面比例 0–1。', parameters: { type: 'object', properties: { shape: { type: 'string' }, color: { type: 'string' }, startMs: { type: 'number' }, durationMs: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } } } },
  { name: 'set_text', description: '改文字层内容或样式。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, text: { type: 'string' }, fontSize: { type: 'number' }, color: { type: 'string' }, stroke: { type: 'string' } } } },
  { name: 'add_mask', description: '给片段加蒙版。shape: rect|ellipse，mode: add|subtract。x/y/w/h 为图层内 0–1，feather 0–0.4。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, shape: { type: 'string' }, mode: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, feather: { type: 'number' } } } },
  { name: 'set_mask', description: '改已有蒙版。要 maskId。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, maskId: { type: 'string' }, shape: { type: 'string' }, mode: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, feather: { type: 'number' } }, required: ['maskId'] } },
  { name: 'remove_mask', description: '删蒙版。不传 maskId 则清掉该片段全部蒙版。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, maskId: { type: 'string' } } } },
  { name: 'set_keyframe', description: '打关键帧。prop: opacity|scale|x|y|volume；atMs 为时间线毫秒（默认片段起点）；ease: linear|ease_in|ease_out|ease_in_out。推近用 scale 1→1.1。clipId 必填。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, prop: { type: 'string' }, atMs: { type: 'number' }, value: { type: 'number' }, ease: { type: 'string' } }, required: ['prop', 'value'] } },
  { name: 'link_to_audio', description: '画面缩放/发光跟鼓点。prop: scale|glow|both。amount 0–1。remove=true 取消。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, prop: { type: 'string' }, amount: { type: 'number' }, remove: { type: 'boolean' } } } },
  { name: 'denoise_audio', description: '人声降噪（afftdn）。amount 0.3–0.6，过高会有水声。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } }, amount: { type: 'number' }, enabled: { type: 'boolean' } } } },
  { name: 'freeze_frame', description: '冻结画面。atMs 默认片段起点对应源帧。再调一次取消。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, atMs: { type: 'number' } } } },
  { name: 'reverse_clip', description: '倒放片段。再调一次恢复正放。', parameters: { type: 'object', properties: { clipId: { type: 'string' } } } },
  { name: 'stabilize', description: '稳像（去手抖），只用于明显晃动的手持镜头。amount 0–1。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } }, amount: { type: 'number' }, enabled: { type: 'boolean' } } } },
  { name: 'key_color', description: '绿/蓝幕抠像。color: green|blue|#rrggbb。tolerance 容差、spill 溢色、edge 边缘 0–1。remove=true 去掉。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, color: { type: 'string' }, tolerance: { type: 'number' }, spill: { type: 'number' }, edge: { type: 'number' }, remove: { type: 'boolean' } } } },
  { name: 'export', description: '导出成片。只在人类要求时调用。preset: 1080p | 4k | shorts | alpha | prores。', parameters: { type: 'object', properties: { preset: { type: 'string' } } } },
  { name: 'render_queue_add', description: '加入导出队列。只在人类要求时调用。', parameters: { type: 'object', properties: { preset: { type: 'string' } } } },
  { name: 'make_proxy', description: '为素材生成半分辨率代理，预览更流畅。不传 assetId 则全部视频/图片。', parameters: { type: 'object', properties: { assetId: { type: 'string' } } } },
  { name: 'set_transform', description: '静态变换。scale 1=素材完整放入画布；跳剪处放大 1.08–1.15 制造机位变化；x/y 为中心 0–1（竖屏裁横屏时调 x 让人物居中）。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } }, scale: { type: 'number' }, scaleX: { type: 'number' }, scaleY: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' } } } },
  { name: 'duplicate_clip', description: '复制当前或指定片段并接到后面。', parameters: { type: 'object', properties: { clipId: { type: 'string' } } } },
  { name: 'detach_audio', description: '画面静音，声音单独放到音频轨。', parameters: { type: 'object', properties: { clipId: { type: 'string' } } } },
  { name: 'split_on_scenes', description: '按镜头切点切开故事线（多镜头 Vlog 素材整理用）。', parameters: { type: 'object', properties: {} } },
  { name: 'add_title', description: '同 animate_text preset=fade（文字层，不改字幕）。', parameters: { type: 'object', properties: { text: { type: 'string' }, startMs: { type: 'number' }, durationMs: { type: 'number' } }, required: ['text'] } },
  { name: 'flip', description: '水平翻转画面。', parameters: { type: 'object', properties: { clipId: { type: 'string' } } } },
  { name: 'set_opacity', description: '透明度 0–1。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } }, opacity: { type: 'number' } }, required: ['opacity'] } },
  { name: 'audio_preset', description: 'voice_boost 或 music。', parameters: { type: 'object', properties: { name: { type: 'string' }, clipId: { type: 'string' } }, required: ['name'] } },
  { name: 'add_marker', description: '在时间线上打标记。', parameters: { type: 'object', properties: { atMs: { type: 'number' }, label: { type: 'string' } }, required: ['atMs'] } },
  { name: 'slow_motion', description: '慢动作，默认 0.5x。clipId 必填。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, rate: { type: 'number' } } } },
  { name: 'mute_clip', description: '片段静音。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } } } } },
  { name: 'replace_clip', description: '用指定素材替换片段，尽量保持时长。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, assetId: { type: 'string' } }, required: ['assetId'] } },
  { name: 'keep_head_tail', description: '只留片头 headMs 和片尾 tailMs。', parameters: { type: 'object', properties: { headMs: { type: 'number' }, tailMs: { type: 'number' } } } },
  { name: 'jump_cut', description: '等同 remove_silence minMs 220 padMs 50，非常紧，只适合快节奏短视频。', parameters: { type: 'object', properties: {} } },
  { name: 'reset_fx', description: '清除片段全部效果（滤镜、裁切、变速、转场、蒙版、关键帧…）。clipId 必填；支持 clipIds / "all"。', parameters: { type: 'object', properties: { clipId: { type: 'string' }, clipIds: { type: 'array', items: { type: 'string' } } } } },
  { name: 'zoom_in', description: '把片段裁切放大约 1.3 倍。一般更推荐 set_transform scale 1.1。clipId 必填。', parameters: { type: 'object', properties: { clipId: { type: 'string' } } } },
  { name: 'lower_third', description: '同 animate_text preset=lower_third（文字层，不改字幕）。', parameters: { type: 'object', properties: { text: { type: 'string' }, startMs: { type: 'number' } }, required: ['text'] } },
  { name: 'shift_subtitles', description: '整轨字幕平移毫秒，可负。', parameters: { type: 'object', properties: { deltaMs: { type: 'number' } }, required: ['deltaMs'] } },
  { name: 'export_srt', description: '把字幕轨导出为 SRT 文本。', parameters: { type: 'object', properties: {} } },
  { name: 'delete_asset', description: '从媒体库删除素材，并撤掉时间线上引用它的片段。', parameters: { type: 'object', properties: { assetId: { type: 'string' } }, required: ['assetId'] } },
  { name: 'remove_clip', description: '从时间线删除片段。clipId 必填。', parameters: { type: 'object', properties: { clipId: { type: 'string' } } } }
]

export function result(tool: string, summary: string, changedIds: string[] = []): ActionResult {
  const p = store.requireProject()
  return { ok: true, tool, summary, changedIds, durationMs: timelineDurationMs(p.timeline) }
}

export function num(v: unknown, fallback: number): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** 自动排故事线时选哪些素材：只放「有人说话的主素材」，B-roll（没有人声的视频）和音乐不进故事线。 */
function autoStorylineAssets(p: Project) {
  const hasSpeech = (a: (typeof p.assets)[number]) =>
    p.transcript.some((t) => t.assetId === a.id && t.text.trim()) || (a.index?.speech ?? []).some((r) => r.endMs - r.startMs > 800)
  const videos = p.assets.filter((a) => a.kind === 'video')
  const talking = videos.filter(hasSpeech)
  const picked = talking.length ? talking : videos.length ? videos : p.assets.filter((a) => a.kind === 'audio' && hasSpeech(a))
  if (!picked.length) throw new Error('没有可剪的视频或有人声的音频，请先导入')
  return { picked, partial: talking.length > 0 && talking.length < videos.length }
}

export async function ensureStoryline(source: ReviewAction['source']): Promise<void> {
  const p = store.requireProject()
  if (p.timeline.storyline.length) return
  const { picked, partial } = autoStorylineAssets(p)
  const ops = picked.map((a) => ({ op: 'add_clip' as const, assetId: a.id }))
  await store.applyOps(ops, source, partial ? '把有人声的素材排上故事线（其余视频当 B-roll）' : '把素材排上故事线')
}

/** 只读工具用：故事线为空时，返回「假设自动排好故事线」的工程副本，不修改真实工程。 */
export function withVirtualStoryline(p: Project): { project: Project; virtual: boolean } {
  if (p.timeline.storyline.length) return { project: p, virtual: false }
  const { picked } = autoStorylineAssets(p)
  let t = 0
  const storyline: TimelineClip[] = picked.map((a) => {
    const clip: TimelineClip = { id: `virtual_${a.id}`, assetId: a.id, startMs: t, durationMs: a.durationMs, inMs: 0, outMs: a.durationMs, volume: 1, source: 'ai' }
    t += a.durationMs
    return clip
  })
  return { project: { ...p, timeline: { ...p.timeline, storyline } }, virtual: true }
}

export async function runAction(
  name: string,
  args: Record<string, unknown>,
  source: ReviewAction['source']
): Promise<ActionResult> {
  const p = store.requireProject()

  if (isTextTool(name)) return runTextTool(name, args, source)
  if (isVisualTool(name)) return runVisual(name, args, source)
  if (isCraftTool(name)) return runCraft(name, args, source)
  if (isTitleTool(name)) return runTitleTool(name, args, source)

  const ids = BATCH_TOOLS.has(name) ? batchIds(p, args) : null
  if (ids) {
    if (!ids.length) throw new Error('时间线是空的')
    const results: ActionResult[] = []
    await store.batch(`${name} ×${ids.length}`, async () => {
      for (const clipId of ids) {
        results.push(await runAction(name, { ...args, clipId, clipIds: undefined }, source))
      }
    })
    const warnings = [...new Set(results.flatMap((r) => r.warnings ?? []))]
    return withWarnings(result(name, `${results[0]?.summary ?? name}（${ids.length} 个片段）`, ids), warnings)
  }

  switch (name) {
    case 'get_index': {
      const transcriptReady = p.transcript.some((t) => t.text.trim())
      const warnings: string[] = []
      if (!transcriptReady) {
        const states = new Set(p.assets.filter((a) => a.kind !== 'image').map((a) => a.index?.transcription ?? 'pending'))
        if (states.has('pending')) warnings.push('语音转写还在后台进行，稍后再调用 get_index；先做不依赖台词的剪辑。')
        else if (states.has('unavailable')) warnings.push('本机没有可用的转写器：字幕、去口头禅、按台词搜索不可用。请提醒人类安装 whisper-cpp 和模型（或在设置里配置云端转写）。')
        else warnings.push('没有识别到语音转写：字幕、去口头禅、按台词搜索不可用。')
      }
      return {
        ...result(name, '素材索引'),
        warnings,
        transcriptReady,
        ...(transcriptReady ? { hint: '台词用 get_transcript 读（带句子 id，可直接用于剪辑）。' } : {}),
        assets: p.assets.map((a) => {
          const idx = a.index
          return {
            id: a.id,
            name: a.name,
            kind: a.kind,
            durationMs: a.durationMs,
            analysis: idx?.analysis ?? (idx ? 'done' : 'pending'),
            transcription: idx?.transcription ?? 'pending',
            bpm: idx?.bpm,
            speechMs: (idx?.speech ?? []).reduce((n, r) => n + r.endMs - r.startMs, 0),
            speechSegments: idx?.speech.length ?? 0,
            silenceCount: idx?.silence.length ?? 0,
            longPauses: (idx?.silence ?? []).filter((r) => r.endMs - r.startMs >= 700).length,
            transcriptCues: p.transcript.filter((t) => t.assetId === a.id && t.text.trim()).length,
            scenes: (idx?.scenes ?? []).slice(0, 20),
            lufs: idx?.lufs,
            beats: idx?.beats?.length
          }
        })
      } as ActionResult
    }
    case 'search_media': {
      const q = String(args.query ?? args.q ?? '').toLowerCase()
      const hits = p.assets.filter((a) => a.name.toLowerCase().includes(q)).map((a) => ({ id: a.id, name: a.name, kind: a.kind, durationMs: a.durationMs }))
      return { ...result(name, `${hits.length} 条素材`), hits } as ActionResult
    }
    case 'search_transcript': {
      const q = String(args.q ?? '')
      const hits = p.transcript.filter((t) => t.text.includes(q))
      return { ...result(name, `${hits.length} 句`), hits } as ActionResult
    }
    case 'set_aspect': {
      store.pushUndo()
      const aspect = String(args.aspect) as AspectPreset
      p.settings.aspect = aspect
      p.settings.manualFrame = true
      if (aspect === '16:9') {
        p.settings.width = 1920
        p.settings.height = 1080
      } else if (aspect === '9:16') {
        p.settings.width = 1080
        p.settings.height = 1920
      } else {
        p.settings.width = 1080
        p.settings.height = 1080
      }
      store.log({ tool: name, summary: `画幅 ${aspect}`, risk: 'low', source })
      await store.save()
      store.broadcast()
      return result(name, `画幅 ${aspect}`)
    }
    case 'remove_silence':
      return punchSilence(source, num(args.minMs, 400), num(args.padMs, 120))
    case 'keep_speech':
      return punchSilence(source, 400, 120)
    case 'fit_duration':
      return fitDuration(source, num(args.targetMs, 60000))
    case 'set_subtitle_style': {
      store.pushUndo()
      if (args.fontSize != null) p.subtitleStyle.fontSize = num(args.fontSize, p.subtitleStyle.fontSize)
      if (typeof args.color === 'string') p.subtitleStyle.color = args.color
      if (typeof args.stroke === 'string') p.subtitleStyle.stroke = args.stroke
      if (args.position === 'top' || args.position === 'bottom' || args.position === 'center') {
        p.subtitleStyle.position = args.position
      }
      if (['clean', 'boxed', 'karaoke', 'keyword'].includes(String(args.preset))) {
        p.subtitleStyle.preset = args.preset as 'clean' | 'boxed' | 'karaoke' | 'keyword'
      }
      if (typeof args.highlightColor === 'string') p.subtitleStyle.highlightColor = args.highlightColor
      if (typeof args.boxColor === 'string') p.subtitleStyle.boxColor = args.boxColor
      if (args.boxOpacity != null) p.subtitleStyle.boxOpacity = Math.min(1, Math.max(0, num(args.boxOpacity, 0.6)))
      if (Array.isArray(args.keywords)) p.subtitleStyle.keywords = args.keywords.map(String).filter(Boolean).slice(0, 60)
      store.log({ tool: name, summary: '改字幕样式', risk: 'low', source })
      await store.save()
      store.broadcast()
      return result(name, '已改字幕样式')
    }
    case 'set_volume':
    {
      const clipId = clipIdArg(p, args, source)
      await store.applyOps([{ op: 'set_volume', clipId, volume: Math.min(2, Math.max(0, num(args.volume, 1))) }], source, '调音量')
      return result(name, '已调音量', [clipId])
    }
    case 'fade_audio': {
      const clipId = clipIdArg(p, args, source)
      await store.applyOps(
        [{ op: 'patch_clip', clipId, fx: { fadeInMs: num(args.inMs, 400), fadeOutMs: num(args.outMs, 400) } }],
        source,
        '音频淡化'
      )
      return result(name, '已设淡入淡出', [clipId])
    }
    case 'normalize_loudness': {
      const target = num(args.targetLufs, -16)
      const warnings: string[] = []
      let measured = 0
      let peakLimited = 0
      store.pushUndo()
      for (const c of p.timeline.storyline) {
        const idx = p.assets.find((a) => a.id === c.assetId)?.index
        const lufs = idx?.lufs
        if (typeof lufs === 'number' && Number.isFinite(lufs) && lufs > -70) {
          let gainDb = target - lufs
          // 导出母线有 -1 dBTP 限幅器，允许峰值超出 4 dB 由它压住；再多会听出压缩感。
          if (typeof idx?.truePeak === 'number' && Number.isFinite(idx.truePeak) && gainDb > 3 - idx.truePeak) {
            gainDb = 3 - idx.truePeak
            peakLimited++
          }
          c.volume = Math.min(2, Math.max(0.1, 10 ** (gainDb / 20)))
          measured++
        } else {
          c.volume = 1
        }
      }
      if (measured < p.timeline.storyline.length) {
        warnings.push(`${p.timeline.storyline.length - measured} 个片段的素材还没有响度分析，音量先设为 1。`)
      }
      if (peakLimited) warnings.push(`${peakLimited} 个片段受峰值限制（峰值过高，再提会明显压缩）达不到 ${target} LUFS。`)
      store.log({ tool: name, summary: `统一响度 ${target} LUFS`, risk: 'low', source })
      await store.save()
      store.broadcast()
      return withWarnings(result(name, `故事线按 ${target} LUFS 统一音量（已测 ${measured} 段）`), warnings)
    }
    case 'set_music': {
      const warnings: string[] = []
      let levelInfo: { musicLufs?: number; speechLufs?: number; estimatedLufs?: number; relativeLu?: number } = {}
      await store.batch('铺背景音乐', async () => {
        store.pushUndo()
        p.timeline.audio = p.timeline.audio.filter((c) => c.role === 'dialog')
        const asset = p.assets.find((a) => a.id === String(args.assetId))
        if (!asset) throw new Error(`素材不存在: ${args.assetId}`)
        // 按实测响度定音量：音乐（闪避前）比人声低 relativeLu（默认 12 LU）。手动给 volume 时照用，但报出估计响度。
        const speechLufs = storyLoudness(p)
        const musicLufs = typeof asset.index?.lufs === 'number' ? asset.index.lufs : undefined
        const relative = Math.min(-6, Math.max(-30, num(args.relativeLu, -12)))
        let volume: number
        if (args.volume == null && speechLufs != null && musicLufs != null) {
          // 最多 +6dB（volume 2）：导出母线有限幅器
          const want = 10 ** ((speechLufs + relative - musicLufs) / 20)
          volume = Math.min(2, Math.max(0.02, want))
          if (want > 2) {
            warnings.push(`音乐素材本身太小声（${musicLufs} LUFS），音量已开到 2（+6dB）仍比目标低 ${Math.round(20 * Math.log10(want / 2))} LU；换一首更响的音乐。`)
          }
        } else {
          volume = Math.min(2, Math.max(0, num(args.volume, 0.22)))
        }
        if (musicLufs != null) {
          const est = musicLufs + 20 * Math.log10(Math.max(1e-4, volume))
          levelInfo = { musicLufs, speechLufs, estimatedLufs: Math.round(est * 10) / 10, ...(speechLufs != null ? { relativeLu: Math.round((est - speechLufs) * 10) / 10 } : {}) }
          if (speechLufs != null && est < speechLufs - 20) {
            warnings.push(`音乐估计 ${levelInfo.estimatedLufs} LUFS，比人声（${speechLufs} LUFS）低 ${Math.round(speechLufs - est)} LU，开闪避后基本听不见；不传 volume 让它按响度自动定，或调大 volume。`)
          }
        }
        const storyEnd = p.timeline.storyline.reduce((m, c) => Math.max(m, c.startMs + c.durationMs), 0)
        const inMs = Math.max(0, num(args.inMs, 0))
        // 音乐不应把成片拉长：裁到故事线结尾，结尾淡出。
        const outMs = storyEnd > 0 ? Math.min(asset.durationMs || Infinity, inMs + storyEnd) : asset.durationMs
        const dur = Math.max(1, outMs - inMs)
        const fadeMs = Math.min(dur / 3, Math.max(0, num(args.fadeOutMs, 1500)))
        const keys = fadeMs > 0 ? [
          { t: 0, value: volume, ease: 'linear' as const },
          { t: 1 - fadeMs / dur, value: volume, ease: 'ease_in' as const },
          { t: 1, value: 0, ease: 'linear' as const }
        ] : undefined
        if (storyEnd > 0 && asset.durationMs && asset.durationMs - inMs < storyEnd) {
          warnings.push(`音乐比成片短 ${Math.round((storyEnd - (asset.durationMs - inMs)) / 1000)} 秒，结尾会没有音乐。`)
        }
        await store.applyOps(
          [{ op: 'add_audio', assetId: asset.id, volume, inMs, outMs, role: 'music', ...(keys ? { fx: { keys: { volume: keys } } } : {}) }],
          source,
          '铺背景音乐'
        )
      })
      const lvl = levelInfo.relativeLu != null ? `，比人声低 ${Math.abs(levelInfo.relativeLu)} LU` : ''
      return withWarnings({ ...result(name, `已铺背景音乐（已裁到成片长度并淡出${lvl}）`), ...levelInfo } as ActionResult, warnings)
    }
    case 'duck_music': {
      store.pushUndo()
      p.timeline.duck = {
        enabled: args.enabled === undefined ? true : Boolean(args.enabled),
        ratio: num(args.ratio, 0.28)
      }
      store.log({ tool: name, summary: p.timeline.duck.enabled ? '开启音乐闪避' : '关闭音乐闪避', risk: 'low', source })
      await store.save()
      store.broadcast()
      return result(name, p.timeline.duck.enabled ? '口播时压低音乐' : '已关闭闪避')
    }
    case 'list_transitions':
      return {
        ...result(name, `${TRANSITIONS.length} 种转场`),
        transitions: TRANSITIONS.map((t) => ({
          type: t.type,
          label: t.label,
          durationMs: t.durationMs,
          overlap: t.overlap
        }))
      } as ActionResult
    case 'set_transition': {
      const spec = resolveTransition(args.type)
      const type = spec.type as TransitionType
      const durationMs = Math.max(0, num(args.durationMs, spec.durationMs))
      const story = p.timeline.storyline
      let clips: TimelineClip[]
      if (Array.isArray(args.clipIds) && args.clipIds.length) {
        const want = new Set(args.clipIds.map(String))
        clips = story.filter((c) => want.has(c.id))
      } else if (args.clipId === 'all') {
        if (source !== 'human' && type !== 'none') {
          throw new Error('不要给全部片段加同一种转场：跳剪应硬切。请用 clipIds 只列出段落切换处的片段，或 type=none 清除全部转场。')
        }
        clips = story
      } else if (typeof args.clipId === 'string' && args.clipId) {
        clips = story.filter((c) => c.id === args.clipId)
        if (!clips.length) throw new Error(`故事线上没有片段 ${args.clipId}。${clipChoices(p)}`)
      } else if (source === 'human') {
        clips = story
      } else {
        throw new Error(`需要 clipId（转场加在该片段出点）或 clipIds。${clipChoices(p)}`)
      }
      const warnings: string[] = []
      if (type !== 'none' && spec.overlap) {
        for (const c of clips) {
          const i = story.indexOf(c)
          const next = story[i + 1]
          if (!next) {
            warnings.push(`${c.id} 是最后一个片段，出点转场无效；片尾请用 fade_to_black。`)
            continue
          }
          if (next.assetId === c.assetId && Math.abs(next.inMs - c.outMs) < 5000) {
            warnings.push(`${c.id}→${next.id} 是同一素材的跳剪，溶解会叠影叠音，建议硬切。`)
          }
          if (Math.min(c.durationMs, next.durationMs) < durationMs * 1.5) {
            warnings.push(`${c.id} 或下一段太短（<${Math.round(durationMs * 1.5)}ms），转场会吃掉内容。`)
          }
        }
      }
      store.pushUndo()
      for (const c of clips) c.fx = { ...c.fx, transitionOut: { type, durationMs: type === 'none' ? 0 : durationMs } }
      packStorylineClips(p.timeline.storyline)
      store.log({ tool: name, summary: `转场 ${spec.label}`, risk: 'low', source })
      await store.save()
      store.broadcast()
      return withWarnings(result(name, `转场 ${spec.label} ${durationMs}ms（${clips.length} 处）`, clips.map((c) => c.id)), warnings.slice(0, 12))
    }
    case 'fade_to_black': {
      const last = p.timeline.storyline.at(-1)
      if (!last) throw new Error('时间线是空的')
      await store.applyOps(
        [{ op: 'patch_clip', clipId: last.id, fx: { fadeOutMs: num(args.durationMs, 800), transitionOut: { type: 'fade_black', durationMs: num(args.durationMs, 800) } } }],
        source,
        '片尾淡出黑'
      )
      return result(name, '片尾淡出黑', [last.id])
    }
    case 'fade_from_black': {
      const first = p.timeline.storyline[0]
      if (!first) throw new Error('时间线是空的')
      await store.applyOps(
        [{ op: 'patch_clip', clipId: first.id, fx: { fadeInMs: num(args.durationMs, 800) } }],
        source,
        '片头淡入'
      )
      return result(name, '片头淡入', [first.id])
    }
    case 'set_speed': {
      const clipId = clipIdArg(p, args, source)
      const rate = Math.min(8, Math.max(0.25, num(args.rate, 1)))
      await store.applyOps(
        [{ op: 'patch_clip', clipId, fx: { speed: rate, pitchPreserve: args.pitchPreserve !== false } }],
        source,
        `变速 ${rate}x`
      )
      return result(name, `变速 ${rate}x`, [clipId])
    }
    case 'crop': {
      const clipId = clipIdArg(p, args, source)
      await store.applyOps(
        [
          {
            op: 'patch_clip',
            clipId,
            fx: { crop: { x: num(args.x, 0), y: num(args.y, 0), w: num(args.w, 1), h: num(args.h, 1) } }
          }
        ],
        source,
        '裁切'
      )
      return result(name, '已裁切', [clipId])
    }
    case 'rotate': {
      const clipId = clipIdArg(p, args, source)
      const degrees = num(args.degrees, 90) as 0 | 90 | 180 | 270
      await store.applyOps([{ op: 'patch_clip', clipId, fx: { rotate: degrees } }], source, `旋转 ${degrees}°`)
      return result(name, `旋转 ${degrees}°`, [clipId])
    }
    case 'apply_filter': {
      const clipId = clipIdArg(p, args, source)
      const filter = String(args.name || 'none') as FilterName
      await store.applyOps([{ op: 'patch_clip', clipId, fx: { filter } }], source, `滤镜 ${filter}`)
      return result(name, `滤镜 ${filter}`, [clipId])
    }
    case 'list_effects':
      return {
        ...result(name, `${EFFECT_REGISTRY.length} 个特效`),
        effects: EFFECT_REGISTRY.map((e) => ({ type: e.type, label: e.label, params: e.params }))
      } as ActionResult
    case 'add_effect': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      if (!clip) throw new Error('找不到片段')
      const type = String(args.type) as EffectType
      const spec = effectSpec(type)
      if (!spec) throw new Error('未知特效')
      const fx = clipFx(clip)
      if (args.remove === true) {
        const effects = fx.effects.filter((e) => e.type !== type)
        await store.applyOps([{ op: 'patch_clip', clipId, fx: { effects } }], source, `去掉${spec.label}`)
        return result(name, `已去掉${spec.label}`, [clipId])
      }
      const cur = defaultEffect(type, id('fx'))
      if (args.amount != null) cur.params.amount = num(args.amount, Number(cur.params.amount))
      if (typeof args.name === 'string') cur.params.name = args.name
      if (typeof args.path === 'string') cur.params.path = args.path
      const existing = fx.effects.find((e) => e.type === type)
      const effects = existing
        ? fx.effects.map((e) => (e.type === type ? { ...e, params: { ...e.params, ...cur.params } } : e))
        : [...fx.effects, cur]
      await store.applyOps([{ op: 'patch_clip', clipId, fx: { effects } }], source, spec.label)
      return result(name, `已加${spec.label}`, [clipId])
    }
    case 'apply_lut': {
      const clipId = clipIdArg(p, args, source)
      let path = typeof args.path === 'string' ? args.path : ''
      const lutName = String(args.name || (path ? 'custom' : 'warm'))
      if (!path && (lutName === 'warm' || lutName === 'cool' || lutName === 'contrast' || lutName === 'green')) {
        const { mkdir, writeFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        const { userDataDir } = await import('./paths')
        const dir = join(userDataDir(), 'luts')
        await mkdir(dir, { recursive: true })
        path = join(dir, `${lutName}.cube`)
        await writeFile(path, cubeFileText(makeLut(lutName)), 'utf8')
      }
      if (!path) throw new Error('需要 LUT 文件或 name=warm|cool|contrast|green')
      return runAction('add_effect', { clipId, type: 'lut', name: lutName, path }, source)
    }
    case 'color_adjust': {
      const clipId = clipIdArg(p, args, source)
      const cur = clipFx(findAny(p, clipId) ?? p.timeline.storyline[0] ?? p.timeline.overlays[0] ?? emptyClip())
      await store.applyOps(
        [
          {
            op: 'patch_clip',
            clipId,
            fx: {
              color: {
                exposure: num(args.exposure, cur.color.exposure),
                contrast: num(args.contrast, cur.color.contrast),
                saturation: num(args.saturation, cur.color.saturation),
                warmth: num(args.warmth, cur.color.warmth)
              }
            }
          }
        ],
        source,
        '调色'
      )
      return result(name, '已调色', [clipId])
    }
    case 'overlay_broll': {
      await store.applyOps(
        [
          {
            op: 'add_overlay',
            assetId: String(args.assetId),
            startMs: num(args.startMs, 0),
            outMs: num(args.durationMs, 3000)
          }
        ],
        source,
        '叠加 B-roll'
      )
      return result(name, '已加 B-roll')
    }
    case 'add_layer': {
      const assetId = String(args.assetId)
      const blend = String(args.blend || 'normal') as BlendMode
      await store.applyOps(
        [
          {
            op: 'add_layer',
            assetId,
            startMs: num(args.startMs, 0),
            durationMs: args.durationMs != null ? num(args.durationMs, 5000) : undefined,
            kind: 'footage',
            blend: ['normal', 'add', 'screen', 'multiply'].includes(blend) ? blend : 'normal'
          }
        ],
        source,
        '叠加图层'
      )
      return result(name, '已叠加图层')
    }
    case 'set_blend': {
      const clipId = clipIdArg(p, args, source)
      const mode = String(args.mode || 'normal') as BlendMode
      if (!['normal', 'add', 'screen', 'multiply'].includes(mode)) throw new Error('混合模式无效')
      await store.applyOps([{ op: 'patch_clip', clipId, blend: mode }], source, `混合 ${mode}`)
      return result(name, `混合 ${mode}`, [clipId])
    }
    case 'add_adjustment_layer': {
      const startMs = num(args.startMs, 0)
      const fx: Partial<ClipFx> = { opacity: 1 }
      if (typeof args.filter === 'string') fx.filter = args.filter as FilterName
      if (args.saturation != null) fx.color = { exposure: 0, contrast: 0, saturation: num(args.saturation, 0), warmth: 0 }
      await store.applyOps(
        [
          {
            op: 'add_layer',
            startMs,
            durationMs: args.durationMs != null ? num(args.durationMs, 5000) : undefined,
            kind: 'adjustment',
            fx
          }
        ],
        source,
        '加调整层'
      )
      return result(name, '已加调整层')
    }
    case 'add_solid': {
      const color = String(args.color || '#000000')
      const blend = String(args.blend || 'normal') as BlendMode
      await store.applyOps(
        [
          {
            op: 'add_layer',
            startMs: num(args.startMs, 0),
            durationMs: num(args.durationMs, 5000),
            kind: 'solid',
            solidColor: color.startsWith('#') ? color : `#${color}`,
            blend: ['normal', 'add', 'screen', 'multiply'].includes(blend) ? blend : 'normal'
          }
        ],
        source,
        '加纯色层'
      )
      return result(name, '已加纯色层')
    }
    case 'add_text_layer': {
      const text = String(args.text || '').trim()
      if (!text) throw new Error('需要 text')
      await store.applyOps(
        [
          {
            op: 'add_layer',
            startMs: num(args.startMs, 0),
            durationMs: num(args.durationMs, 3000),
            kind: 'text',
            text: {
              text,
              font: 'PingFang SC',
              fontSize: num(args.fontSize, 72),
              color: String(args.color || '#ffffff'),
              stroke: String(args.stroke || '#000000'),
              strokeWidth: 3,
              align: 'center'
            },
            fx: {
              posX: args.x != null ? num(args.x, 0.5) : 0.5,
              posY: args.y != null ? num(args.y, 0.45) : 0.45
            }
          }
        ],
        source,
        `文字：${text.slice(0, 16)}`
      )
      return result(name, '已加文字层')
    }
    case 'animate_text': {
      const text = String(args.text || '').trim()
      if (!text) throw new Error('需要 text')
      const preset = (['typewriter', 'fade', 'lower_third'].includes(String(args.preset)) ? String(args.preset) : 'fade') as TextPreset
      const startMs = num(args.startMs, 0)
      const durationMs = num(args.durationMs, 3000)
      // 自动避开字幕：字幕在中间时标题放上方，字幕在底部时人名条抬到字幕上面。
      const subPos = p.subtitleStyle.position
      const hasSubs = p.timeline.subtitles.length > 0 || subPos !== 'bottom'
      const posArg = String(args.position ?? '')
      const titleY =
        args.y != null ? Math.min(0.95, Math.max(0.05, num(args.y, 0.45)))
          : posArg === 'top' ? 0.2 : posArg === 'bottom' ? 0.78 : posArg === 'center' ? 0.45
            : subPos === 'center' ? 0.2 : subPos === 'top' ? 0.6 : 0.42
      const barY = args.y != null ? titleY : posArg === 'top' ? 0.14 : hasSubs && subPos === 'bottom' ? 0.72 : 0.88
      const titleSize = args.fontSize != null ? Math.min(160, Math.max(24, num(args.fontSize, 72))) : undefined
      if (preset === 'lower_third') {
        await store.applyOps(
          [
            {
              op: 'add_layer',
              startMs,
              durationMs,
              kind: 'shape',
              shape: { shape: 'rect', fill: '#1c1c1e', width: 0.94, height: 0.16 },
              fx: { posX: 0.5, posY: barY, keys: { opacity: FADE_IN_KEYS } }
            },
            {
              op: 'add_layer',
              startMs,
              durationMs,
              kind: 'text',
              textAnim: 'lower_third',
              text: {
                text,
                font: 'PingFang SC',
                fontSize: 44,
                color: '#ffffff',
                stroke: '#000000',
                strokeWidth: 2,
                align: 'left'
              },
              fx: { posX: 0.1, posY: barY, keys: { opacity: FADE_IN_KEYS } }
            }
          ],
          source,
          `下三分之一：${text.slice(0, 16)}`
        )
      } else if (preset === 'typewriter') {
        await store.applyOps(
          [
            {
              op: 'add_layer',
              startMs,
              durationMs,
              kind: 'text',
              textAnim: 'typewriter',
              text: {
                text,
                font: 'PingFang SC',
                fontSize: titleSize ?? 64,
                color: '#ffffff',
                stroke: '#000000',
                strokeWidth: 3,
                align: 'center'
              },
              fx: { posX: 0.5, posY: titleY }
            }
          ],
          source,
          `打字机：${text.slice(0, 16)}`
        )
      } else {
        await store.applyOps(
          [
            {
              op: 'add_layer',
              startMs,
              durationMs,
              kind: 'text',
              textAnim: 'fade',
              text: {
                text,
                font: 'PingFang SC',
                fontSize: titleSize ?? 72,
                color: '#ffffff',
                stroke: '#000000',
                strokeWidth: 3,
                align: 'center'
              },
              fx: { posX: 0.5, posY: titleY, keys: { opacity: FADE_IN_KEYS } }
            }
          ],
          source,
          `标题：${text.slice(0, 16)}`
        )
      }
      return result(name, `已加${preset === 'typewriter' ? '打字机' : preset === 'lower_third' ? '下三分之一' : '淡入'}标题`)
    }
    case 'add_shape': {
      const shape = (String(args.shape || 'rect') === 'ellipse' ? 'ellipse' : 'rect') as ShapeKind
      const color = String(args.color || '#e0a93a')
      await store.applyOps(
        [
          {
            op: 'add_layer',
            startMs: num(args.startMs, 0),
            durationMs: num(args.durationMs, 3000),
            kind: 'shape',
            shape: {
              shape,
              fill: color.startsWith('#') ? color : `#${color}`,
              width: num(args.width, shape === 'ellipse' ? 0.36 : 0.42),
              height: num(args.height, shape === 'ellipse' ? 0.36 : 0.22)
            },
            fx: {
              posX: args.x != null ? num(args.x, 0.5) : 0.5,
              posY: args.y != null ? num(args.y, 0.5) : 0.5
            }
          }
        ],
        source,
        shape === 'ellipse' ? '椭圆' : '矩形'
      )
      return result(name, '已加形状')
    }
    case 'set_text': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      if (!clip || clipKind(clip) !== 'text') throw new Error('请选中文字层')
      const text = {
        ...(clip.text ?? { text: '', font: 'PingFang SC', fontSize: 72, color: '#ffffff', stroke: '#000000', strokeWidth: 3, align: 'center' as const })
      }
      if (args.text != null) text.text = String(args.text)
      if (args.fontSize != null) text.fontSize = num(args.fontSize, text.fontSize)
      if (typeof args.color === 'string') text.color = args.color
      if (typeof args.stroke === 'string') text.stroke = args.stroke
      await store.applyOps([{ op: 'patch_clip', clipId, text }], source, '改文字')
      return result(name, '已改文字', [clipId])
    }
    case 'export': {
      const { exportTimeline } = await import('./media')
      const { lastRenderWarnings } = await import('./render/export')
      const path = await exportTimeline(String(args.preset || '1080p'))
      return withWarnings(result(name, '已导出 ' + path), lastRenderWarnings)
    }
    case 'render_queue_add': {
      const { addRenderJob } = await import('./render/export')
      const job = await addRenderJob(String(args.preset || '1080p'))
      const p2 = store.requireProject()
      const done = (p2.renderQueue ?? []).filter((j) => j.status === 'done').length
      const failed = (p2.renderQueue ?? []).filter((j) => j.status === 'error').length
      return result(
        name,
        job.status === 'done'
          ? `队列已导出 ${job.preset} → ${job.path}`
          : job.status === 'error'
            ? `队列失败：${job.error}`
            : `已加入队列（完成 ${done}，失败 ${failed}）`
      )
    }
    case 'make_proxy': {
      const { makeProxy } = await import('./render/export')
      const list = await makeProxy(args.assetId ? String(args.assetId) : undefined)
      return result(name, `已生成 ${list.length} 个半分辨率代理`)
    }
    case 'duplicate_clip': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      if (!clip) throw new Error('找不到片段')
      const copy: TimelineClip = { ...clip, id: id('clip'), fx: { ...clip.fx }, startMs: clip.startMs + clip.durationMs }
      store.pushUndo()
      const list = listOf(p, clipId)
      const idx = list.findIndex((c) => c.id === clipId)
      list.splice(idx + 1, 0, copy)
      if (list === p.timeline.storyline) packStorylineClips(list)
      store.log({ tool: name, summary: '复制片段', risk: 'low', source })
      await store.save()
      store.broadcast()
      return result(name, '已复制片段', [copy.id])
    }
    case 'detach_audio': {
      const clipId = clipIdArg(p, args, source)
      const clip = p.timeline.storyline.find((c) => c.id === clipId)
      if (!clip) throw new Error('请先选中视频片段')
      await store.applyOps(
        [
          { op: 'set_volume', clipId, volume: 0 },
          { op: 'add_audio', assetId: clip.assetId, startMs: clip.startMs, volume: 1 }
        ],
        source,
        '分离音频'
      )
      return result(name, '画面已静音，声音在音频轨', [clipId])
    }
    case 'split_on_scenes': {
      await ensureStoryline(source)
      const proj = store.requireProject()
      const next: TimelineClip[] = []
      for (const clip of proj.timeline.storyline) {
        const asset = proj.assets.find((a) => a.id === clip.assetId)
        const cuts = (asset?.index?.scenes ?? []).filter((t) => t > clip.inMs + 200 && t < clip.outMs - 200)
        if (!cuts.length) {
          next.push(clip)
          continue
        }
        let inMs = clip.inMs
        for (const cut of cuts) {
          next.push({ ...clip, id: id('clip'), inMs, outMs: cut, durationMs: cut - inMs, fx: { ...clip.fx } })
          inMs = cut
        }
        next.push({ ...clip, id: id('clip'), inMs, outMs: clip.outMs, durationMs: clip.outMs - inMs, fx: { ...clip.fx } })
      }
      await store.applyOps([{ op: 'replace_storyline', clips: next }], source, '按镜头切开')
      return result(name, `按镜头切成 ${next.length} 段`)
    }
    case 'add_title':
      return runAction('animate_text', { text: args.text, preset: 'fade', startMs: args.startMs, durationMs: num(args.durationMs, 2500) }, source)
    case 'flip': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      const flipX = !clipFx(clip ?? emptyClip()).flipX
      await store.applyOps([{ op: 'patch_clip', clipId, fx: { flipX } }], source, '水平翻转')
      return result(name, '已翻转', [clipId])
    }
    case 'set_opacity': {
      const clipId = clipIdArg(p, args, source)
      await store.applyOps([{ op: 'patch_clip', clipId, fx: { opacity: Math.min(1, Math.max(0, num(args.opacity, 1))) } }], source, '透明度')
      return result(name, '已改透明度', [clipId])
    }
    case 'set_transform': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      const cur = clipFx(clip ?? emptyClip())
      const clampS = (n: number) => Math.min(8, Math.max(0.05, n))
      const clampP = (n: number) => Math.min(2, Math.max(-1, n))
      const fx: Partial<ClipFx> = {}
      if (args.scale != null) {
        fx.scale = clampS(num(args.scale, cur.scale))
        if (args.scaleX == null && args.scaleY == null) {
          fx.scaleX = fx.scale
          fx.scaleY = fx.scale
        }
      }
      if (args.scaleX != null) fx.scaleX = clampS(num(args.scaleX, cur.scaleX ?? cur.scale))
      if (args.scaleY != null) fx.scaleY = clampS(num(args.scaleY, cur.scaleY ?? cur.scale))
      if (args.x != null) fx.posX = clampP(num(args.x, cur.posX))
      if (args.y != null) fx.posY = clampP(num(args.y, cur.posY))
      await store.applyOps([{ op: 'patch_clip', clipId, fx }], source, '变换')
      return result(name, '已改变换', [clipId])
    }
    case 'audio_preset': {
      const clipId = clipIdArg(p, args, source)
      const preset = String(args.name)
      const volume = preset === 'voice_boost' ? 1.2 : preset === 'music' ? 0.32 : 1
      await store.applyOps([{ op: 'set_volume', clipId, volume }], source, `音频预设 ${preset}`)
      return result(name, `音频预设 ${preset}`, [clipId])
    }
    case 'add_marker': {
      store.pushUndo()
      p.markers = p.markers ?? []
      p.markers.push({ id: id('mk'), atMs: num(args.atMs, 0), label: String(args.label || '标记') })
      store.log({ tool: name, summary: `标记：${args.label || '标记'}`, risk: 'low', source })
      await store.save()
      store.broadcast()
      return result(name, '已打标记')
    }
    case 'slow_motion': {
      return runAction('set_speed', { clipId: args.clipId, rate: num(args.rate, 0.5) }, source)
    }
    case 'mute_clip': {
      const clipId = clipIdArg(p, args, source)
      await store.applyOps([{ op: 'set_volume', clipId, volume: 0 }], source, '静音')
      return result(name, '已静音', [clipId])
    }
    case 'replace_clip': {
      const clipId = clipIdArg(p, args, source)
      const assetId = String(args.assetId)
      const clip = findAny(p, clipId)
      const asset = p.assets.find((a) => a.id === assetId)
      if (!clip || !asset) throw new Error('找不到片段或素材')
      const dur = Math.min(clip.outMs - clip.inMs, asset.durationMs || clip.durationMs)
      store.pushUndo()
      clip.assetId = assetId
      clip.inMs = 0
      clip.outMs = dur
      clip.durationMs = dur / Math.max(0.25, clipFx(clip).speed)
      store.log({ tool: name, summary: `替换为 ${asset.name}`, risk: 'medium', source })
      await store.save()
      store.broadcast()
      return result(name, `已替换为 ${asset.name}`, [clipId])
    }
    case 'keep_head_tail': {
      await ensureStoryline(source)
      const proj = store.requireProject()
      const headMs = num(args.headMs, 3000)
      const tailMs = num(args.tailMs, 3000)
      const total = timelineDurationMs(proj.timeline)
      if (total <= headMs + tailMs) return result(name, '成片不够长，未裁')
      const keepEnd = total - tailMs
      const next = proj.timeline.storyline
        .map((c) => {
          const s = c.startMs
          const e = c.startMs + c.durationMs
          if (e <= headMs || s >= keepEnd) return [c]
          const parts: TimelineClip[] = []
          if (s < headMs) {
            const local = headMs - s
            parts.push({ ...c, id: id('clip'), durationMs: local, outMs: c.inMs + local * clipFx(c).speed })
          }
          if (e > keepEnd) {
            const cut = Math.max(0, keepEnd - s)
            const inMs = c.inMs + cut * clipFx(c).speed
            parts.push({ ...c, id: id('clip'), inMs, durationMs: e - keepEnd })
          }
          return parts
        })
        .flat()
      await store.applyOps([{ op: 'replace_storyline', clips: next }], source, '只留片头片尾')
      return result(name, `保留片头 ${headMs / 1000}s 和片尾 ${tailMs / 1000}s`)
    }
    case 'jump_cut':
      return runAction('remove_silence', { minMs: 220, padMs: 50 }, source)
    case 'add_mask': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      if (!clip) throw new Error('找不到片段')
      const shape: MaskShape = args.shape === 'rect' ? 'rect' : 'ellipse'
      const mode: MaskMode = args.mode === 'subtract' ? 'subtract' : 'add'
      const base = defaultMask(shape, mode, id('mask'))
      const mask = clampMask({
        ...base,
        x: args.x != null ? num(args.x, base.x) : base.x,
        y: args.y != null ? num(args.y, base.y) : base.y,
        w: args.w != null ? num(args.w, base.w) : base.w,
        h: args.h != null ? num(args.h, base.h) : base.h,
        feather: args.feather != null ? num(args.feather, base.feather) : base.feather
      })
      await store.applyOps([{ op: 'patch_clip', clipId, fx: { masks: [...clipFx(clip).masks, mask] } }], source, '加蒙版')
      return result(name, `${shape === 'ellipse' ? '椭圆' : '矩形'}蒙版`, [clipId])
    }
    case 'set_mask': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      if (!clip) throw new Error('找不到片段')
      const maskId = String(args.maskId)
      const masks = clipFx(clip).masks.map((m) => {
        if (m.id !== maskId) return m
        return clampMask({
          ...m,
          shape: args.shape === 'rect' || args.shape === 'ellipse' ? args.shape : m.shape,
          mode: args.mode === 'add' || args.mode === 'subtract' ? args.mode : m.mode,
          x: args.x != null ? num(args.x, m.x) : m.x,
          y: args.y != null ? num(args.y, m.y) : m.y,
          w: args.w != null ? num(args.w, m.w) : m.w,
          h: args.h != null ? num(args.h, m.h) : m.h,
          feather: args.feather != null ? num(args.feather, m.feather) : m.feather
        })
      })
      if (!masks.some((m) => m.id === maskId)) throw new Error('找不到蒙版')
      await store.applyOps([{ op: 'patch_clip', clipId, fx: { masks } }], source, '改蒙版')
      return result(name, '已改蒙版', [clipId])
    }
    case 'remove_mask': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      if (!clip) throw new Error('找不到片段')
      const maskId = args.maskId != null ? String(args.maskId) : ''
      const masks = maskId ? clipFx(clip).masks.filter((m) => m.id !== maskId) : []
      await store.applyOps([{ op: 'patch_clip', clipId, fx: { masks } }], source, '删蒙版')
      return result(name, maskId ? '已删蒙版' : '已清除蒙版', [clipId])
    }
    case 'set_keyframe': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      if (!clip) throw new Error('找不到片段')
      const rawProp = String(args.prop || 'opacity')
      const prop: AnimProp = rawProp === 'x' ? 'posX' : rawProp === 'y' ? 'posY' : (rawProp as AnimProp)
      if (!['opacity', 'scale', 'posX', 'posY', 'volume'].includes(prop)) throw new Error('prop 必须是 opacity|scale|x|y|volume')
      const fx = clipFx(clip)
      const at = args.atMs != null ? num(args.atMs, clip.startMs) : clip.startMs
      const t = clip.durationMs > 0 ? (at - clip.startMs) / clip.durationMs : 0
      const ease = (['linear', 'ease_in', 'ease_out', 'ease_in_out'].includes(String(args.ease))
        ? String(args.ease)
        : 'ease_in_out') as EaseKind
      const seed =
        prop === 'volume' ? clip.volume : prop === 'opacity' ? fx.opacity : prop === 'scale' ? fx.scale : prop === 'posX' ? fx.posX : fx.posY
      let value = num(args.value, seed)
      if (prop === 'opacity') value = Math.min(1, Math.max(0, value))
      if (prop === 'scale') value = Math.min(4, Math.max(0.05, value))
      if (prop === 'posX' || prop === 'posY') value = Math.min(1, Math.max(0, value))
      if (prop === 'volume') value = Math.min(2, Math.max(0, value))
      const track = upsertKey(fx.keys?.[prop], t, value, ease, seed)
      await store.applyOps([{ op: 'patch_clip', clipId, fx: { keys: { ...fx.keys, [prop]: track } } }], source, '关键帧')
      return result(name, `${prop} 关键帧`, [clipId])
    }
    case 'freeze_frame': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      if (!clip) throw new Error('找不到片段')
      const fx = clipFx(clip)
      if (fx.freeze) {
        await store.applyOps([{ op: 'patch_clip', clipId, fx: { freeze: false } }], source, '取消冻结')
        return result(name, '已取消冻结', [clipId])
      }
      const at = args.atMs != null ? num(args.atMs, clip.startMs) : clip.startMs
      await store.applyOps(
        [{ op: 'patch_clip', clipId, fx: { freeze: true, freezeAtMs: sourceTimeMs(clip, at), reverse: false } }],
        source,
        '冻结帧'
      )
      return result(name, '已冻结画面', [clipId])
    }
    case 'reverse_clip': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      if (!clip) throw new Error('找不到片段')
      const on = !clipFx(clip).reverse
      await store.applyOps([{ op: 'patch_clip', clipId, fx: { reverse: on, freeze: on ? false : clipFx(clip).freeze } }], source, on ? '倒放' : '正放')
      return result(name, on ? '已倒放' : '已正放', [clipId])
    }
    case 'stabilize': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      if (!clip) throw new Error('找不到片段')
      const cur = clipFx(clip).stabilize
      const enabled = args.enabled != null ? Boolean(args.enabled) : !cur?.enabled
      const amount = Math.min(1, Math.max(0, args.amount != null ? num(args.amount, 0.5) : (cur?.amount ?? 0.5)))
      await store.applyOps(
        [{ op: 'patch_clip', clipId, fx: { stabilize: { enabled, amount } } }],
        source,
        enabled ? '稳像' : '取消稳像'
      )
      return result(name, enabled ? `已稳像 ${Math.round(amount * 100)}%` : '已取消稳像', [clipId])
    }
    case 'key_color': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      if (!clip) throw new Error('找不到片段')
      if (args.remove === true || String(args.color || '') === 'none') {
        await store.applyOps([{ op: 'patch_clip', clipId, fx: { key: null } }], source, '去掉抠像')
        return result(name, '已去掉抠像', [clipId])
      }
      const prev = clipFx(clip).key ?? defaultKey(String(args.color || 'green'))
      const key = {
        color: parseKeyColor(String(args.color || prev.color || 'green')),
        tolerance: Math.min(1, Math.max(0.01, args.tolerance != null ? num(args.tolerance, prev.tolerance) : prev.tolerance)),
        spill: Math.min(1, Math.max(0, args.spill != null ? num(args.spill, prev.spill) : prev.spill)),
        edge: Math.min(1, Math.max(0, args.edge != null ? num(args.edge, prev.edge) : prev.edge))
      }
      await store.applyOps([{ op: 'patch_clip', clipId, fx: { key } }], source, '抠像')
      return result(name, `已抠${isBlueKey(key.color) ? '蓝' : '绿'}幕`, [clipId])
    }
    case 'link_to_audio': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      if (!clip) throw new Error('找不到片段')
      if (args.remove === true) {
        await store.applyOps([{ op: 'patch_clip', clipId, fx: { audioLink: null } }], source, '取消跟鼓点')
        return result(name, '已取消跟鼓点', [clipId])
      }
      const audioClip = p.timeline.audio[0] ?? p.timeline.storyline[0]
      if (!audioClip) throw new Error('没有可跟随的音频')
      const asset = p.assets.find((a) => a.id === audioClip.assetId)
      if (!asset?.path) throw new Error('找不到音频素材')
      let peaks = asset.index?.waveform
      if (!peaks?.length) {
        const { findFfmpeg } = await import('./render/ffmpeg')
        const { readWaveform } = await import('./render/wave')
        const ffmpeg = await findFfmpeg()
        if (!ffmpeg) throw new Error('没有 ffmpeg，无法分析鼓点')
        peaks = await readWaveform(ffmpeg, asset.path)
        asset.index = {
          silence: asset.index?.silence ?? [],
          speech: asset.index?.speech ?? [],
          scenes: asset.index?.scenes ?? [],
          peakRms: asset.index?.peakRms ?? 0,
          waveform: peaks
        }
      }
      const onsets = onsetTimes(peaks, asset.durationMs || audioClip.durationMs, undefined, asset.index?.beats)
      if (!onsets.length) throw new Error('没检测到鼓点，换一段节奏更明显的音频')
      const fx = clipFx(clip)
      const prop = (['scale', 'glow', 'both'].includes(String(args.prop)) ? String(args.prop) : 'both') as AudioLinkProp
      const amount = Math.min(1, Math.max(0.08, num(args.amount, 0.45)))
      const scaleKeys = beatScaleKeys(onsets, audioClip, clip, amount, fx.scale || 1)
      const effects =
        prop === 'glow' || prop === 'both'
          ? fx.effects.some((e) => e.type === 'glow')
            ? fx.effects
            : [...fx.effects, defaultEffect('glow', id('fx'))]
          : fx.effects
      await store.applyOps(
        [
          {
            op: 'patch_clip',
            clipId,
            fx: {
              audioLink: { prop, amount },
              keys: { ...fx.keys, scale: scaleKeys },
              effects
            }
          }
        ],
        source,
        '跟鼓点'
      )
      return result(name, `已跟鼓点（${onsets.length} 下）`, [clipId])
    }
    case 'denoise_audio': {
      const clipId = clipIdArg(p, args, source)
      const clip = findAny(p, clipId)
      if (!clip) throw new Error('找不到片段')
      const cur = clipFx(clip).denoise
      const enabled = args.enabled != null ? Boolean(args.enabled) : !cur?.enabled
      const amount = Math.min(1, Math.max(0, args.amount != null ? num(args.amount, 0.5) : (cur?.amount ?? 0.5)))
      await store.applyOps(
        [{ op: 'patch_clip', clipId, fx: { denoise: { enabled, amount } } }],
        source,
        enabled ? '降噪' : '取消降噪'
      )
      return result(name, enabled ? '已降噪' : '已取消降噪', [clipId])
    }
    case 'reset_fx': {
      const clipId = clipIdArg(p, args, source)
      await store.applyOps(
        [{ op: 'patch_clip', clipId, fx: { speed: 1, filter: 'none', crop: null, rotate: 0, flipX: false, flipY: false, opacity: 1, scale: 1, scaleX: 1, scaleY: 1, posX: 0.5, posY: 0.5, fadeInMs: 0, fadeOutMs: 0, color: { exposure: 0, contrast: 0, saturation: 0, warmth: 0 }, transitionOut: { type: 'none', durationMs: 0 }, masks: [], effects: [], keys: {}, reverse: false, freeze: false, stabilize: { enabled: false, amount: 0.5 }, key: null, audioLink: null, denoise: null } }],
        source,
        '重置效果'
      )
      return result(name, '已重置效果', [clipId])
    }
    case 'zoom_in': {
      const clipId = clipIdArg(p, args, source)
      await store.applyOps([{ op: 'patch_clip', clipId, fx: { crop: { x: 0.12, y: 0.12, w: 0.76, h: 0.76 } } }], source, '放大')
      return result(name, '已放大构图', [clipId])
    }
    case 'lower_third':
      return runAction('animate_text', { text: args.text, preset: 'lower_third', startMs: args.startMs, durationMs: num(args.durationMs, 3500) }, source)
    case 'shift_subtitles': {
      const delta = num(args.deltaMs, 0)
      store.pushUndo()
      for (const c of p.timeline.subtitles) {
        c.startMs = Math.max(0, c.startMs + delta)
        c.endMs = Math.max(c.startMs + 200, c.endMs + delta)
      }
      store.log({ tool: name, summary: `字幕平移 ${delta}ms`, risk: 'low', source })
      await store.save()
      store.broadcast()
      return result(name, `字幕平移 ${delta}ms`)
    }
    case 'export_srt': {
      const lines = p.timeline.subtitles.map((c, i) => {
        const fmt = (ms: number) => {
          const h = Math.floor(ms / 3600000)
          const m = Math.floor((ms % 3600000) / 60000)
          const s = Math.floor((ms % 60000) / 1000)
          const f = ms % 1000
          return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(f).padStart(3, '0')}`
        }
        return `${i + 1}\n${fmt(c.startMs)} --> ${fmt(c.endMs)}\n${c.text}\n`
      })
      return { ...result(name, `${p.timeline.subtitles.length} 条字幕`), srt: lines.join('\n') } as ActionResult
    }
    case 'delete_asset':
    case 'delete': {
      if (args.assetId) {
        await store.deleteAsset(String(args.assetId))
        return result('delete_asset', '已删除素材')
      }
      const clipId = clipIdArg(p, args, source)
      await store.applyOps([{ op: 'remove_clip', clipId }], source, '删除片段')
      return result('remove_clip', '已删除片段', [clipId])
    }
    case 'remove_clip':
    case 'delete_clip': {
      const clipId = clipIdArg(p, args, source)
      await store.applyOps([{ op: 'remove_clip', clipId }], source, '删除片段')
      return result('remove_clip', '已删除片段', [clipId])
    }
    default:
      throw new Error(`未知动作: ${name}`)
  }
}

export function findAny(p: Project, clipId: string): TimelineClip | undefined {
  return (
    p.timeline.storyline.find((c) => c.id === clipId) ??
    p.timeline.overlays.find((c) => c.id === clipId) ??
    p.timeline.audio.find((c) => c.id === clipId)
  )
}

function listOf(p: Project, clipId: string): TimelineClip[] {
  if (p.timeline.storyline.some((c) => c.id === clipId)) return p.timeline.storyline
  if (p.timeline.overlays.some((c) => c.id === clipId)) return p.timeline.overlays
  return p.timeline.audio
}

function emptyClip(): TimelineClip {
  return { id: '', assetId: '', startMs: 0, durationMs: 1, inMs: 0, outMs: 1, volume: 1, source: 'human' }
}

/** 故事线人声的估计响度（LUFS）：各片段素材实测响度 + 片段音量增益，按时长加权。没有测量时返回 undefined。 */
function storyLoudness(p: Project): number | undefined {
  let wsum = 0
  let acc = 0
  for (const c of p.timeline.storyline) {
    const lufs = p.assets.find((a) => a.id === c.assetId)?.index?.lufs
    if (typeof lufs !== 'number' || c.volume <= 0) continue
    const eff = lufs + 20 * Math.log10(c.volume)
    acc += eff * c.durationMs
    wsum += c.durationMs
  }
  return wsum ? Math.round((acc / wsum) * 10) / 10 : undefined
}

function selectedOrFirst(p: Project): string {
  const c = p.timeline.storyline[0] ?? p.timeline.overlays[0]
  if (!c) throw new Error('时间线是空的')
  return c.id
}

/**
 * 人在界面里点按钮时没选片段就用第一段；AI / MCP 必须明确给 clipId，
 * 否则会悄悄改错片段。
 */
export function clipIdArg(p: Project, args: Record<string, unknown>, source: ReviewAction['source']): string {
  const raw = typeof args.clipId === 'string' ? args.clipId.trim() : ''
  if (raw && raw !== 'all') {
    if (!findAny(p, raw)) throw new Error(`片段不存在: ${raw}。${clipChoices(p)}`)
    return raw
  }
  if (source === 'human') return selectedOrFirst(p)
  if (raw === 'all') throw new Error('这个工具不支持 clipId: "all"，请逐个片段传 clipId。')
  throw new Error(`需要 clipId。${clipChoices(p)}`)
}

export function clipChoices(p: Project): string {
  const rows = [
    ...p.timeline.storyline.map((c) => `${c.id}@${c.startMs}ms`),
    ...p.timeline.overlays.map((c) => `${c.id}(${c.kind ?? 'footage'})@${c.startMs}ms`)
  ]
  if (!rows.length) return '时间线是空的。'
  const shown = rows.slice(0, 30).join(', ')
  return `可选片段：${shown}${rows.length > 30 ? ` …共 ${rows.length} 个，用 get_project 查看` : ''}`
}

/** 支持 clipId: "all" 或 clipIds 数组的工具。 */
const BATCH_TOOLS = new Set([
  'apply_filter',
  'color_adjust',
  'add_effect',
  'apply_lut',
  'set_speed',
  'fade_audio',
  'set_opacity',
  'set_volume',
  'mute_clip',
  'reset_fx',
  'stabilize',
  'denoise_audio',
  'rotate',
  'crop',
  'set_transform'
])

function batchIds(p: Project, args: Record<string, unknown>): string[] | null {
  if (Array.isArray(args.clipIds) && args.clipIds.length) return args.clipIds.map(String)
  if (args.clipId === 'all') return p.timeline.storyline.map((c) => c.id)
  return null
}

export function withWarnings(r: ActionResult, warnings: string[]): ActionResult {
  return warnings.length ? { ...r, warnings: [...(r.warnings ?? []), ...warnings] } : r
}

async function punchSilence(source: ReviewAction['source'], minMs: number, padMs: number): Promise<ActionResult> {
  await ensureStoryline(source)
  const p = store.requireProject()
  const next: TimelineClip[] = []
  let holes = 0
  for (const clip of p.timeline.storyline) {
    const asset = p.assets.find((a) => a.id === clip.assetId)
    const silence = (asset?.index?.silence ?? []).filter((s) => s.endMs - s.startMs >= minMs)
    if (!silence.length) {
      next.push(clip)
      continue
    }
    const pieces = subtractRanges(clip.inMs, clip.outMs, silence, padMs)
    if (!pieces.length) {
      holes++
      continue
    }
    for (const [inMs, outMs] of pieces) {
      holes++
      next.push({
        ...clip,
        id: id('clip'),
        inMs,
        outMs,
        durationMs: outMs - inMs
      })
    }
  }
  if (!next.length) throw new Error('去静音后没有剩下的画面，请降低阈值或先分析素材')
  const warnings: string[] = []
  await store.batch(`去掉静音（${holes} 处）`, async () => {
    await store.applyOps([{ op: 'replace_storyline', clips: next }], source, `去掉静音（${holes} 处）`)
    warnings.push(...(await rebuildCaptionsIfAny(source)))
  })
  const unanalyzed = p.timeline.storyline.filter((c) => !p.assets.find((a) => a.id === c.assetId)?.index).length
  if (unanalyzed) warnings.push(`${unanalyzed} 个片段的素材还没有静音分析，未处理。`)
  const tiny = next.filter((c) => c.durationMs < 300).map((c) => c.id)
  if (tiny.length) warnings.push(`有 ${tiny.length} 个短于 300ms 的碎片（${tiny.slice(0, 8).join(', ')}），检查后删除。`)
  return withWarnings(result('remove_silence', `去掉静音，现 ${next.length} 段`), warnings)
}

function subtractRanges(inMs: number, outMs: number, silence: TimeRange[], padMs: number): [number, number][] {
  const cuts = silence
    .map((s) => [Math.max(inMs, s.startMs - padMs), Math.min(outMs, s.endMs + padMs)] as [number, number])
    .filter(([a, b]) => b - a > 80)
  const kept: [number, number][] = []
  let cursor = inMs
  for (const [a, b] of cuts.sort((x, y) => x[0] - y[0])) {
    if (a > cursor + 80) kept.push([cursor, a])
    cursor = Math.max(cursor, b)
  }
  if (outMs > cursor + 80) kept.push([cursor, outMs])
  return kept
}

async function fitDuration(source: ReviewAction['source'], targetMs: number): Promise<ActionResult> {
  await punchSilence(source, 350, 100)
  const p = store.requireProject()
  let dur = timelineDurationMs(p.timeline)
  if (dur <= targetMs) return result('fit_duration', `已是 ${Math.round(dur / 1000)} 秒，未再压缩`)
  const rate = Math.min(1.15, dur / targetMs)
  store.pushUndo()
  for (const c of p.timeline.storyline) {
    const fx = clipFx(c)
    c.fx = { ...c.fx, speed: fx.speed * rate }
    c.durationMs = Math.max(1, (c.outMs - c.inMs) / (c.fx.speed ?? 1))
  }
  packStorylineClips(p.timeline.storyline)
  store.log({ tool: 'fit_duration', summary: `压到约 ${Math.round(targetMs / 1000)} 秒`, risk: 'medium', source })
  await store.save()
  store.broadcast()
  const after = timelineDurationMs(p.timeline)
  const warnings = [`已整体加速 ${rate.toFixed(2)}x。`]
  if (after > targetMs * 1.03) warnings.push(`仍比目标长 ${Math.round((after - targetMs) / 1000)} 秒：请删掉次要内容（remove_clip / apply_ops trim_clip），不要继续加速。`)
  return withWarnings(result('fit_duration', `目标 ${Math.round(targetMs / 1000)} 秒，现 ${Math.round(after / 1000)} 秒`), warnings)
}
