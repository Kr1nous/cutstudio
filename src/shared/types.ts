export type MediaKind = 'video' | 'audio' | 'image'
export type ClipSource = 'human' | 'ai' | 'ai-accepted'
export type ActionRisk = 'low' | 'medium' | 'high'

export interface MediaAsset {
  id: string
  name: string
  path: string
  kind: MediaKind
  durationMs: number
  width: number
  height: number
  fps: number
  thumbPath?: string
  importedAt: string
  index?: AssetIndex
  proxyPath?: string
  proxyWidth?: number
  proxyHeight?: number
}

export function playbackPath(asset: MediaAsset): string {
  return asset.proxyPath || asset.path
}

export type FilterName = 'none' | 'vivid' | 'cinema' | 'bw' | 'vintage'
export type TransitionType =
  | 'none'
  | 'cross_dissolve'
  | 'dissolve'
  | 'fade_black'
  | 'fade_white'
  | 'dip_black'
  | 'push'
  | 'slide_left'
  | 'smooth_wipe'
  | 'wipe_up'
  | 'cover'
  | 'reveal'
  | 'zoom'
  | 'iris'
  | 'blur_mix'
export type EffectType = 'blur' | 'radial_blur' | 'glow' | 'grain' | 'mosaic' | 'lut'

export interface ClipEffect {
  id: string
  type: EffectType
  enabled?: boolean
  params: Record<string, number | string>
}
export type AspectPreset = '16:9' | '9:16' | '1:1'
export type BlendMode = 'normal' | 'add' | 'screen' | 'multiply'
export type LayerKind = 'footage' | 'solid' | 'adjustment' | 'text' | 'shape'
export type ShapeKind = 'rect' | 'ellipse'
export type TextPreset = 'typewriter' | 'fade' | 'lower_third'
export type TextAlign = 'left' | 'center' | 'right'

export interface TextStyle {
  text: string
  font: string
  fontSize: number
  color: string
  stroke: string
  strokeWidth: number
  align: TextAlign
}

export interface ShapeStyle {
  shape: ShapeKind
  fill: string
  width: number
  height: number
}

export const DEFAULT_TEXT_STYLE: TextStyle = {
  text: '标题',
  font: 'PingFang SC',
  fontSize: 72,
  color: '#ffffff',
  stroke: '#000000',
  strokeWidth: 3,
  align: 'center'
}

export const DEFAULT_SHAPE_STYLE: ShapeStyle = {
  shape: 'rect',
  fill: '#e0a93a',
  width: 0.42,
  height: 0.22
}
export type MaskShape = 'rect' | 'ellipse'
export type MaskMode = 'add' | 'subtract'
export type AnimProp = 'opacity' | 'scale' | 'posX' | 'posY' | 'volume'
export type AudioLinkProp = 'scale' | 'glow' | 'both'

export interface ClipAudioLink {
  prop: AudioLinkProp
  amount: number
}

export interface ClipDenoise {
  enabled: boolean
  amount: number
}
export type EaseKind = 'linear' | 'ease_in' | 'ease_out' | 'ease_in_out'

export interface AnimKey {
  /** 片段内 0–1。 */
  t: number
  value: number
  ease: EaseKind
}

export interface ClipMask {
  id: string
  shape: MaskShape
  mode: MaskMode
  /** 图层框内归一化，左上角 + 宽高。 */
  x: number
  y: number
  w: number
  h: number
  /** 0–0.4，相对图层短边。 */
  feather: number
}

export interface ClipKey {
  /** #rrggbb，绿幕默认 #00ff00。 */
  color: string
  /** 0–1，colorkey similarity。 */
  tolerance: number
  /** 0–1，溢色。 */
  spill: number
  /** 0–1，边缘过渡（colorkey blend）。 */
  edge: number
}

export interface ClipStabilize {
  enabled: boolean
  /** 0–1，对应 deshake 搜索半径。 */
  amount: number
}

export interface ClipFx {
  speed: number
  pitchPreserve: boolean
  fadeInMs: number
  fadeOutMs: number
  opacity: number
  rotate: 0 | 90 | 180 | 270
  flipX: boolean
  flipY: boolean
  /** 1 = 原素材完整放入画布（contain）。可与 scaleX/scaleY 分开。 */
  scale: number
  /** 相对「完整放入」后的宽度，缺省用 scale。 */
  scaleX?: number
  /** 相对「完整放入」后的高度，缺省用 scale。 */
  scaleY?: number
  /** 图层中心，0–1，0.5 为画面中心。 */
  posX: number
  posY: number
  crop: { x: number; y: number; w: number; h: number } | null
  filter: FilterName
  color: { exposure: number; contrast: number; saturation: number; warmth: number }
  transitionOut: { type: TransitionType; durationMs: number }
  masks: ClipMask[]
  effects: ClipEffect[]
  keys?: Partial<Record<AnimProp, AnimKey[]>>
  reverse?: boolean
  freeze?: boolean
  freezeAtMs?: number
  stabilize?: ClipStabilize
  key?: ClipKey | null
  audioLink?: ClipAudioLink | null
  denoise?: ClipDenoise | null
  /** 人声增强预设（voice_enhance，只在导出链路生效）。 */
  voice?: { preset: 'podcast' | 'clear' | 'warm' } | null
}

export const DEFAULT_CLIP_FX: ClipFx = {
  speed: 1,
  pitchPreserve: true,
  fadeInMs: 0,
  fadeOutMs: 0,
  opacity: 1,
  rotate: 0,
  flipX: false,
  flipY: false,
  scale: 1,
  posX: 0.5,
  posY: 0.5,
  crop: null,
  filter: 'none',
  color: { exposure: 0, contrast: 0, saturation: 0, warmth: 0 },
  transitionOut: { type: 'none', durationMs: 0 },
  masks: [],
  effects: [],
  stabilize: { enabled: false, amount: 0.5 },
  key: null,
  audioLink: null,
  denoise: null
}

export interface TimelineClip {
  id: string
  assetId: string
  startMs: number
  durationMs: number
  inMs: number
  outMs: number
  volume: number
  source: ClipSource
  fx?: Partial<ClipFx>
  kind?: LayerKind
  blend?: BlendMode
  solidColor?: string
  text?: TextStyle
  shape?: ShapeStyle
  textAnim?: TextPreset
  /** 音频轨片段的用途：music 会被闪避；dialog（J/L cut 的对白）不闪避、不会被 set_music 清掉。 */
  role?: 'music' | 'dialog'
}

export interface SubtitleStyle {
  /** 上次 captions_from_transcript 用的每行字数 / 行数；删改内容后自动重建字幕时沿用。 */
  maxChars?: number
  maxLines?: 1 | 2
  fontSize: number
  color: string
  stroke: string
  position: 'bottom' | 'top' | 'center'
  /** clean = 描边；boxed = 半透明底框；karaoke = 逐词高亮；keyword = 关键词变色放大。 */
  preset?: 'clean' | 'boxed' | 'karaoke' | 'keyword'
  /** karaoke 已读词 / keyword 关键词颜色。 */
  highlightColor?: string
  /** boxed 底框颜色。 */
  boxColor?: string
  /** boxed 底框不透明度 0–1。 */
  boxOpacity?: number
  /** keyword 预设要高亮的词。 */
  keywords?: string[]
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontSize: 42,
  color: '#ffffff',
  stroke: '#000000',
  position: 'bottom'
}

export interface SubtitleCue {
  id: string
  startMs: number
  endMs: number
  text: string
  source: ClipSource
  /** 词级时间（时间线时间），用于卡拉 OK 逐词高亮。 */
  words?: { text: string; startMs: number; endMs: number }[]
}

export interface TimeRange {
  startMs: number
  endMs: number
}

export interface TranscriptCue {
  startMs: number
  endMs: number
  text: string
  /** 来源素材；有它时 startMs/endMs/words 均为该素材的源时间。 */
  assetId?: string
  /** 词级时间戳（素材源时间）。中文按字/词粒度。 */
  /** p：语音识别置信度 0–1（whisper token 概率的最小值），低的可能是错别字。 */
  words?: { text: string; startMs: number; endMs: number; p?: number }[]
  /** 词时间对齐算法版本（shared/wordalign TRANSCRIPT_ALIGN_VERSION）；低于当前版本时后台用能量索引重新对齐。 */
  alignVersion?: number
}

/** 细粒度停顿（给词对齐 / 字幕断句用，不用于剪辑删除）。 */
export interface PauseRange extends TimeRange {
  /** 相对局部语音电平下降的 dB。 */
  depthDb: number
  /** true = 短能量谷（< 60ms 或下降不够深），只作为弱边界候选。 */
  valley?: boolean
}

export interface AssetIndex {
  silence: TimeRange[]
  speech: TimeRange[]
  scenes: number[]
  peakRms: number
  /** 0–1 峰值，整段素材。 */
  waveform?: number[]
  /** 细粒度停顿：≥60ms 且比局部语音低 ≥12dB 的下陷，以及更短的能量谷（valley）。 */
  pauses?: PauseRange[]
  /** 分析版本；2 = 10ms 帧自适应静音检测；3 = 细粒度停顿 + 数字静音不参与噪底估计。 */
  version?: number
  /** 镜头检测是否已跑过（scenes 为空时区分“没切点”和“没分析”）。 */
  scenesDetected?: boolean
  /** Onset/节拍位置（毫秒，素材源时间）。 */
  beats?: number[]
  bpm?: number
  /** EBU R128 integrated loudness。 */
  lufs?: number
  /** True peak，dBTP。 */
  truePeak?: number
  /** Loudness range，LU。 */
  lra?: number
  /** 后台分析（旧索引升级 + 镜头检测）状态。 */
  analysis?: 'pending' | 'done' | 'error'
  /** 语音转写状态：unavailable = 本机无 whisper 且未允许/无法云端转写；no_speech = 没检测到人声。 */
  transcription?: 'pending' | 'done' | 'unavailable' | 'no_speech' | 'error'
  /** 自适应阈值所用噪底 / 语音电平（dBFS）。 */
  noiseFloorDb?: number
  speechLevelDb?: number
}

export interface Timeline {
  storyline: TimelineClip[]
  overlays: TimelineClip[]
  audio: TimelineClip[]
  subtitles: SubtitleCue[]
  duck?: { enabled: boolean; ratio: number }
}

export interface ProjectSettings {
  width: number
  height: number
  fps: number
  sampleRate: number
  aspect?: AspectPreset
  /** 用户点过画幅按钮后，不再跟导入素材改画布。 */
  manualFrame?: boolean
}

export type ExportPreset = '1080p' | '4k' | 'shorts' | 'alpha' | 'prores'
export type RenderJobStatus = 'queued' | 'running' | 'done' | 'error'

export interface RenderJob {
  id: string
  preset: ExportPreset
  status: RenderJobStatus
  path?: string
  error?: string
  createdAt: string
}

export interface ProjectSnapshot {
  id: string
  createdAt: string
  label: string
  timeline: Timeline
}

export interface ReviewAction {
  id: string
  at: string
  tool: string
  summary: string
  risk: ActionRisk
  source: 'ai' | 'human' | 'mcp'
  reversible: boolean
}

export interface TimelineMarker {
  id: string
  atMs: number
  label: string
  /** chapter = 章节（set_chapters / title_card chapter）；不填为普通标记。 */
  kind?: 'chapter'
}

export interface Project {
  version: 1
  name: string
  createdAt: string
  updatedAt: string
  settings: ProjectSettings
  subtitleStyle: SubtitleStyle
  assets: MediaAsset[]
  timeline: Timeline
  transcript: TranscriptCue[]
  /** 工程热词（人名、产品名、术语）：转写时作为 whisper 提示词，减少错字。 */
  vocabulary?: string[]
  markers: TimelineMarker[]
  snapshots: ProjectSnapshot[]
  review: ReviewAction[]
  renderQueue?: RenderJob[]
}

export type ProviderKind = 'openai-compatible' | 'anthropic'

export interface AiProvider {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  model: string
  enabled: boolean
}

export interface AppSettings {
  activeProviderId: string
  allowMediaUpload: boolean
  /** 本机没有 whisper.cpp 时，是否把素材音频上传到 AI 提供方做云端转写。默认关闭。 */
  allowCloudTranscription?: boolean
  mcpPort: number
  firstRunComplete: boolean
  lastProjectPath?: string
  providers: AiProvider[]
}

export type TimelineOp =
  | { op: 'add_clip'; assetId: string; startMs?: number; inMs?: number; outMs?: number }
  | { op: 'remove_clip'; clipId: string }
  | { op: 'trim_clip'; clipId: string; inMs: number; outMs: number }
  | { op: 'split_clip'; clipId: string; atMs: number }
  | { op: 'move_clip'; clipId: string; startMs: number }
  | { op: 'reorder_storyline'; clipIds: string[] }
  | { op: 'set_volume'; clipId: string; volume: number }
  | { op: 'replace_storyline'; clips: TimelineClip[] }
  | { op: 'add_subtitle'; startMs: number; endMs: number; text: string }
  | { op: 'update_subtitle'; id: string; startMs?: number; endMs?: number; text?: string }
  | { op: 'remove_subtitle'; id: string }
  | { op: 'replace_subtitles'; cues: SubtitleCue[] }
  | { op: 'clear_timeline' }
  | { op: 'patch_clip'; clipId: string; volume?: number; fx?: Partial<ClipFx>; blend?: BlendMode; text?: Partial<TextStyle> }
  | { op: 'add_overlay'; assetId: string; startMs: number; inMs?: number; outMs?: number }
  | {
      op: 'add_layer'
      startMs: number
      durationMs?: number
      assetId?: string
      kind?: LayerKind
      blend?: BlendMode
      solidColor?: string
      inMs?: number
      outMs?: number
      fx?: Partial<ClipFx>
      text?: TextStyle
      shape?: ShapeStyle
      textAnim?: TextPreset
    }
  | { op: 'add_audio'; assetId: string; startMs?: number; volume?: number; inMs?: number; outMs?: number; fx?: Partial<ClipFx>; role?: 'music' | 'dialog' }
  | { op: 'delete_asset'; assetId: string }

export interface McpStatus {
  running: boolean
  port: number
  url: string
}

export const DEFAULT_SETTINGS: AppSettings = {
  activeProviderId: 'spacexai',
  allowMediaUpload: true,
  allowCloudTranscription: false,
  mcpPort: 4877,
  firstRunComplete: false,
  providers: [
    {
      id: 'spacexai',
      name: 'SpaceXAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.x.ai/v1',
      apiKey: '',
      model: 'grok-4.6',
      enabled: true
    },
    {
      id: 'openai',
      name: 'OpenAI',
      kind: 'openai-compatible',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
      model: 'gpt-4.1',
      enabled: true
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: '',
      model: 'claude-sonnet-5',
      enabled: true
    },
    {
      id: 'openrouter',
      name: 'OpenRouter',
      kind: 'openai-compatible',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: '',
      model: 'x-ai/grok-4.6',
      enabled: true
    },
    {
      id: 'ollama',
      name: 'Ollama（本地）',
      kind: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'ollama',
      model: 'llama3.2',
      enabled: true
    }
  ]
}

export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  width: 1920,
  height: 1080,
  fps: 30,
  sampleRate: 48000,
  aspect: '16:9'
}

export interface ActionResult {
  ok: boolean
  tool: string
  summary: string
  changedIds: string[]
  durationMs: number
  /** 给 AI 的提醒：可能剪坏的地方、被忽略的参数等。 */
  warnings?: string[]
}

export function emptyTimeline(): Timeline {
  return { storyline: [], overlays: [], audio: [], subtitles: [], duck: { enabled: false, ratio: 0.28 } }
}

export function clipFx(clip: TimelineClip): ClipFx {
  return {
    ...DEFAULT_CLIP_FX,
    ...clip.fx,
    color: { ...DEFAULT_CLIP_FX.color, ...clip.fx?.color },
    transitionOut: { ...DEFAULT_CLIP_FX.transitionOut, ...clip.fx?.transitionOut },
    masks: clip.fx?.masks ? clip.fx.masks.map((m) => ({ ...m })) : [],
    effects: clip.fx?.effects
      ? clip.fx.effects.map((e) => ({ ...e, params: { ...e.params } }))
      : [],
    keys: clip.fx?.keys
      ? {
          opacity: clip.fx.keys.opacity?.map((k) => ({ ...k })),
          scale: clip.fx.keys.scale?.map((k) => ({ ...k })),
          posX: clip.fx.keys.posX?.map((k) => ({ ...k })),
          posY: clip.fx.keys.posY?.map((k) => ({ ...k })),
          volume: clip.fx.keys.volume?.map((k) => ({ ...k }))
        }
      : undefined,
    reverse: Boolean(clip.fx?.reverse),
    freeze: Boolean(clip.fx?.freeze),
    freezeAtMs: clip.fx?.freezeAtMs,
    stabilize: {
      enabled: Boolean(clip.fx?.stabilize?.enabled),
      amount: clip.fx?.stabilize?.amount ?? 0.5
    },
    key: clip.fx?.key
      ? {
          color: clip.fx.key.color,
          tolerance: clip.fx.key.tolerance,
          spill: clip.fx.key.spill,
          edge: clip.fx.key.edge
        }
      : null,
    audioLink: clip.fx?.audioLink ? { prop: clip.fx.audioLink.prop, amount: clip.fx.audioLink.amount } : null,
    denoise: clip.fx?.denoise
      ? { enabled: Boolean(clip.fx.denoise.enabled), amount: clip.fx.denoise.amount ?? 0.5 }
      : null
  }
}

export function clipKind(clip: TimelineClip): LayerKind {
  return clip.kind ?? 'footage'
}

export function clipBlend(clip: TimelineClip): BlendMode {
  return clip.blend ?? 'normal'
}

export function timelineDurationMs(timeline: Timeline): number {
  let max = 0
  for (const clip of [...timeline.storyline, ...timeline.overlays, ...timeline.audio]) {
    max = Math.max(max, clip.startMs + clip.durationMs)
  }
  for (const cue of timeline.subtitles) {
    max = Math.max(max, cue.endMs)
  }
  return max
}

export function clipAtTime(clips: TimelineClip[], timeMs: number): TimelineClip | null {
  return clips.find((c) => timeMs >= c.startMs && timeMs < c.startMs + c.durationMs) ?? null
}

export function subtitleAtTime(cues: SubtitleCue[], timeMs: number): SubtitleCue | null {
  return cues.find((c) => timeMs >= c.startMs && timeMs < c.endMs) ?? null
}
