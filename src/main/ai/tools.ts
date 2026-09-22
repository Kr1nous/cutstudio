import type { TimelineOp } from '../../shared/types'
import { timelineDurationMs } from '../../shared/types'
import { ACTION_TOOLS, runAction } from '../actions'
import { store } from '../core'
import type { ToolSpec } from './providers'
import { runVisionTool, VISION_TOOLS } from './vision'
import { CRAFT_TOOLS, isCraftTool, runCraft } from '../craft'
import { isTextTool, runTextTool, TEXT_TOOLS } from '../textedit'
import { isVisualTool, runVisual, VISUAL_TOOLS } from '../visual'
import { isTitleTool, runTitleTool, TITLE_TOOLS } from '../titles'

export const EDITOR_TOOLS: ToolSpec[] = [
  {
    name: 'get_project',
    description: '读取当前项目：画幅、素材、故事线片段（id、时间、只列出非默认的效果）、叠加层、字幕轨、总时长。剪辑前必须先调用；改完后再调用核对。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'apply_ops',
    description:
      '底层兜底：一次执行多条时间线操作（合并为一次撤销）。有高层工具时优先用高层工具。常用：trim_clip{clipId,inMs,outMs}（素材源时间）、remove_clip{clipId}、split_clip{clipId,atMs}、move_clip{clipId,startMs}、reorder_storyline{clipIds}、add_clip{assetId,inMs?,outMs?}、add_subtitle{startMs,endMs,text}、replace_subtitles{cues}。字幕只写字幕轨。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '给人类看的一句说明，例如：去掉片头黑场并写了口播字幕' },
        ops: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: [
                  'add_clip',
                  'remove_clip',
                  'trim_clip',
                  'split_clip',
                  'move_clip',
                  'reorder_storyline',
                  'set_volume',
                  'replace_storyline',
                  'add_subtitle',
                  'update_subtitle',
                  'remove_subtitle',
                  'replace_subtitles',
                  'clear_timeline',
                  'patch_clip',
                  'add_overlay',
                  'add_layer',
                  'add_audio',
                  'delete_asset'
                ]
              },
              assetId: { type: 'string' },
              clipId: { type: 'string' },
              id: { type: 'string' },
              startMs: { type: 'number' },
              inMs: { type: 'number' },
              outMs: { type: 'number' },
              atMs: { type: 'number' },
              volume: { type: 'number' },
              text: { type: 'string' },
              endMs: { type: 'number' },
              clipIds: { type: 'array', items: { type: 'string' } },
              clips: { type: 'array' },
              cues: { type: 'array' }
            },
            required: ['op']
          }
        }
      },
      required: ['ops', 'summary']
    }
  },
  {
    name: 'undo',
    description: '撤销上一步改动（剪辑、字幕、转写纠正等），返回撤掉的是哪一步（undone）和再撤一次会撤什么（nextUndo）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }
]

function timelineIds(): Set<string> {
  const tl = store.project?.timeline
  if (!tl) return new Set()
  return new Set([...tl.storyline, ...tl.overlays, ...tl.audio].map((c) => c.id))
}

/** 工具执行后，把新出现的片段 / 图层 id 补进 createdIds，AI 不用再去 get_project 里翻。 */
export async function executeTool(name: string, args: Record<string, unknown>, source: 'ai' | 'mcp') {
  const before = timelineIds()
  const out = await dispatchTool(name, args, source)
  if (out && typeof out === 'object' && !Array.isArray(out) && 'ok' in out) {
    const created = [...timelineIds()].filter((id) => !before.has(id))
    if (created.length && created.length <= 40) return { ...out, createdIds: created }
  }
  return out
}

async function dispatchTool(name: string, args: Record<string, unknown>, source: 'ai' | 'mcp') {
  switch (name) {
    case 'get_project':
      return store.compactForAi()
    case 'apply_ops': {
      const ops = (args.ops ?? []) as TimelineOp[]
      const summary = String(args.summary ?? 'AI 剪辑')
      return store.applyOps(ops, source, summary)
    }
    case 'undo': {
      const undone = await store.undoLast()
      const p = store.requireProject()
      if (!undone) return { ok: false, tool: 'undo', summary: '没有可撤销的操作', changedIds: [], durationMs: timelineDurationMs(p.timeline) }
      const next = store.undoPreview()
      return {
        ok: true,
        tool: 'undo',
        summary: `已撤销：${undone.label}`,
        undone: undone.label,
        nextUndo: next,
        changedIds: [],
        durationMs: timelineDurationMs(p.timeline)
      }
    }
    default:
      if (VISION_TOOLS.some((t) => t.name === name)) return runVisionTool(name, args)
      if (isCraftTool(name)) return runCraft(name, args, source)
      if (isTextTool(name)) return runTextTool(name, args, source)
      if (isVisualTool(name)) return runVisual(name, args, source)
      if (isTitleTool(name)) return runTitleTool(name, args, source)
      if (ACTION_TOOLS.some((t) => t.name === name) || name === 'delete' || name === 'delete_clip') return runAction(name, args, source)
      throw new Error(`未知工具: ${name}`)
  }
}

/**
 * 不给 AI 看的工具：界面按钮用的别名 / 预设，或效果差、容易误用的旧工具。
 * 仍可按名字调用（兼容旧脚本），只是不出现在 tools/list 里，减少 AI 选错。
 */
const HIDDEN_FROM_AI = new Set([
  'keep_speech', // = remove_silence
  'jump_cut', // = remove_silence minMs 220
  'slow_motion', // = set_speed
  'add_title', // = animate_text fade
  'lower_third', // = animate_text lower_third
  'zoom_in', // → punch_in / set_transform
  'audio_preset', // 只是改音量
  'keep_head_tail',
  'mute_clip', // = set_volume 0
  'overlay_broll' // → insert_broll
])

export const ALL_TOOLS: ToolSpec[] = [...EDITOR_TOOLS, ...VISION_TOOLS, ...TEXT_TOOLS, ...CRAFT_TOOLS, ...VISUAL_TOOLS, ...TITLE_TOOLS, ...ACTION_TOOLS].filter(
  (t) => !HIDDEN_FROM_AI.has(t.name)
)
