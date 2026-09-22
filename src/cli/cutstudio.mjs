#!/usr/bin/env node
/**
 * 剪辑台 CLI：给带终端的 AI（grok / claude / codex 等）接管当前打开的工程。
 * 通过本机 MCP 改时间线，不需要再走聊天框。
 */
const MCP = process.env.CUT_STUDIO_MCP_URL || 'http://127.0.0.1:4877/mcp'

const HELP = `剪辑台 CLI — 在软件终端里运行，直接接管当前项目

用法:
  cutstudio prompt [配方]       打印给 AI 的完整剪辑说明（先跑这个）；配方: talking_head|shorts|vlog|interview|product
  cutstudio install-skill [目录] 给 Claude Code 写入剪辑技能（<目录>/.claude/skills/cutstudio/SKILL.md，默认当前目录）
  cutstudio index               素材分析：说话段、镜头、响度、转写是否就绪
  cutstudio review-timeline     自动质检成片（交付前必跑）
  cutstudio get-transcript      可剪辑文稿（句子 id + 时间线位置）
  cutstudio detect-retakes [--apply]            找重录；--apply 删掉前几遍
  cutstudio cut-sentences --sentence-ids id1,id2   按文稿删句
  cutstudio tighten-pauses --max-pause-ms 300
  cutstudio punch-in [--clip-ids a,b] [--scale 1.12]
  cutstudio insert-broll --asset-id <id> (--at-ms 毫秒 | --at-text "台词") [--duration-ms 3000]
  cutstudio audio-lead --clip-id <id> --type j|l --lead-ms 500
  任意工具：cutstudio <工具名用连字符> --参数名 值（参数名用连字符，数组用逗号分隔）
  cutstudio tools [工具名]      全部工具（或单个工具）的说明和参数
  cutstudio frame --at 毫秒     渲染该时刻画面，输出 JPEG 路径（用读图工具查看）
  cutstudio contact-sheet [--start 毫秒] [--end 毫秒] [--count 12]   抽帧网格图，输出 JPEG 路径
  cutstudio status              项目是否打开、时长、片段数
  cutstudio project             当前工程 JSON（素材 + 故事线 + 字幕轨）
  cutstudio timeline            只看时间线和字幕
  cutstudio media               素材列表
  cutstudio import <文件...>    导入已录制的影片
  cutstudio add-clip --asset <id> [--in 毫秒] [--out 毫秒]
  cutstudio add-subtitle --start 毫秒 --end 毫秒 --text "字幕"
  cutstudio apply --summary "说明" --ops '<json数组>'
  cutstudio undo
  cutstudio remove-silence [--min 400] [--pad 120]
  cutstudio keep-speech
  cutstudio fit-duration --ms 60000
  cutstudio captions-from-transcript
  cutstudio set-aspect 16:9|9:16|1:1
  cutstudio set-transition <类型> [时长毫秒] --clip <id> | --clips id1,id2   跳剪不要加转场；类型: none|cross_dissolve|dip_black|smooth_wipe|push|zoom…
  cutstudio list-transitions
  cutstudio fade-to-black
  cutstudio normalize-loudness [--lufs -16]
  cutstudio duck-music
  cutstudio apply-filter vivid|cinema|bw|vintage|none
  cutstudio add-effect blur|radial_blur|glow|grain|mosaic [--amount 6] [--clip id]
  cutstudio apply-lut warm|cool|contrast|green [--clip id] [--path file.cube]
  cutstudio list-effects
  cutstudio set-speed --rate 1.25 [--clip id]
  cutstudio set-opacity --value 0.5 [--clip id]
  cutstudio set-transform [--scale 1] [--x 0.5] [--y 0.5] [--clip id]
  cutstudio add-layer --asset <id> [--start 毫秒] [--blend normal|add|screen|multiply]
  cutstudio set-blend normal|add|screen|multiply [--clip id]
  cutstudio add-solid [--color #000000] [--start 毫秒] [--ms 5000]
  cutstudio add-adjustment [--start 毫秒] [--ms 5000] [--filter bw]
  cutstudio add-mask ellipse|rect [--mode add|subtract] [--clip id]
  cutstudio remove-mask [--clip id]
  cutstudio set-keyframe opacity|scale|x|y|volume --value 0.5 [--at 毫秒] [--ease linear|ease_in|ease_out|ease_in_out] [--clip id]
  cutstudio freeze-frame [--clip id]
  cutstudio reverse-clip [--clip id]
  cutstudio stabilize [--amount 0.5] [--clip id]
  cutstudio key-color green|blue [--tolerance 0.3] [--spill 0.35] [--edge 0.08] [--clip id]
  cutstudio link-to-audio [--prop scale|glow|both] [--amount 0.45] [--clip id]
  cutstudio denoise-audio [--amount 0.5] [--clip id]
  cutstudio animate-text --text "标题" [--preset fade|typewriter|lower_third]
  cutstudio add-shape rect|ellipse [--color #e0a93a]
  cutstudio export [1080p|4k|shorts|alpha|prores]
  cutstudio render-queue-add [1080p|4k|shorts|alpha|prores]
  cutstudio make-proxy [--asset id]
  cutstudio split-on-scenes
  cutstudio remove-filler
  cutstudio duplicate-clip [--clip id]
  cutstudio detach-audio [--clip id]
  cutstudio auto-enhance
  cutstudio reframe
  cutstudio add-title --text "标题" [--start 毫秒]
  cutstudio flip
  cutstudio slow-motion [--rate 0.5]
  cutstudio mcp
  cutstudio help

针对片段的命令必须带 --clip <id>；支持批量的命令可用 --clip all 或 --clips id1,id2。

apply 示例:
  cutstudio apply --summary "去片头" --ops '[{"op":"trim_clip","clipId":"clip_xxx","inMs":1200,"outMs":8000}]'
`

const PROMPT_FALLBACK = `你在「剪辑台」的内置终端里，用 cutstudio 命令接管当前工程的剪辑。
剪辑台没有在运行，拿不到完整剪辑说明。请先打开剪辑台，再运行 cutstudio prompt。
`

async function mcp(method, params) {
  let res
  try {
    res = await fetch(MCP, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
    })
  } catch (e) {
    throw new Error(`连不上剪辑台 MCP（${MCP}）。请先打开剪辑台软件。${e instanceof Error ? e.message : e}`)
  }
  if (res.status === 202) return null
  const json = await res.json()
  if (json.error) throw new Error(json.error.message || JSON.stringify(json.error))
  return json.result
}

/** 专用命令自己解析的简写参数（--clip、--ms 等）。 */
const PARAM_ALIASES = {
  at: ['atMs'],
  start: ['startMs'],
  end: ['endMs'],
  ms: ['durationMs'],
  duration: ['durationMs'],
  in: ['inMs'],
  out: ['outMs'],
  clip: ['clipId'],
  clips: ['clipIds'],
  asset: ['assetId'],
  query: ['q'],
  q: ['query'],
  text: ['atText'],
  size: ['fontSize']
}

const ALIAS_FLAGS = new Set(['amount', 'asset', 'at', 'blend', 'clip', 'clips', 'color', 'count', 'ease', 'edge', 'end', 'filter', 'goal', 'in', 'lufs', 'min', 'mode', 'ms', 'ops', 'out', 'pad', 'path', 'preset', 'prop', 'rate', 'scale', 'spill', 'start', 'summary', 'text', 'tolerance', 'value', 'width', 'x', 'y', 'verbose'])

let toolListCache = null
async function toolSpecs() {
  toolListCache ??= (await mcp('tools/list', {}))?.tools ?? []
  return toolListCache
}

function paramLine(key, schema) {
  const type = schema.enum ? schema.enum.join('|') : schema.type === 'array' ? `${schema.items?.type ?? 'any'}[]（逗号分隔）` : schema.type
  return `--${key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())} <${type}>${schema.description ? '  ' + schema.description : ''}`
}

async function tool(name, args = {}) {
  // 命令行里写的、工具 schema 认识的参数一律带上（专用命令没解析的也不会被悄悄丢掉）；
  // 既不是 schema 参数也不是简写的 --flag 直接报错。
  if (process.argv[2] !== 'call') {
    const spec = (await toolSpecs()).find((t) => t.name === name)
    const props = spec?.inputSchema?.properties ?? {}
    const generic = flagsToArgs(props)
    const unknown = Object.keys(generic).filter((k) => !(k in props) && !ALIAS_FLAGS.has(k))
    if (spec && unknown.length) {
      const lines = Object.entries(props).map(([k, v]) => '  ' + paramLine(k, v))
      throw new Error(`${name} 不认识参数：${unknown.map((k) => '--' + k.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase())).join(' ')}\n可用参数：\n${lines.join('\n') || '  （无）'}`)
    }
    for (const [k, v] of Object.entries(generic)) if (k in props && !(k in args)) args[k] = v
  }
  const result = await mcp('tools/call', { name, arguments: args })
  if (result?.isError) throw new Error(result.content?.map((c) => c.text).join('\n') || `${name} 失败`)
  if (result?.structuredContent != null) return result.structuredContent
  const text = result?.content?.[0]?.text
  if (!text) return result
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function print(data) {
  if (typeof data === 'string') process.stdout.write(data.endsWith('\n') ? data : data + '\n')
  else process.stdout.write(JSON.stringify(data, null, 2) + '\n')
}

function arg(flag) {
  const i = process.argv.indexOf(flag)
  if (i < 0) return undefined
  return process.argv[i + 1]
}

/** --clip id | --clip all | --clips a,b → 工具参数 */
function clipArgs() {
  const clips = arg('--clips')
  if (clips) return { clipIds: clips.split(',').map((x) => x.trim()).filter(Boolean) }
  const clip = arg('--clip')
  return clip ? { clipId: clip } : {}
}

function flagsToArgs(props) {
  const out = {}
  const argv = process.argv.slice(3)
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    let key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    // 常用简写：schema 里没有这个名字、但有对应的全名时自动换过去（--at → atMs，--query ↔ --q 等）
    if (!(key in props)) {
      const full = (PARAM_ALIASES[key] ?? []).find((k) => k in props)
      if (full) key = full
    }
    const next = argv[i + 1]
    const raw = next == null || next.startsWith('--') ? 'true' : (i++, next)
    const type = props[key]?.type
    if (type === 'number') out[key] = Number(raw)
    else if (type === 'boolean') out[key] = raw !== 'false'
    else if (type === 'array') out[key] = raw.trim().startsWith('[') ? JSON.parse(raw) : raw.split(',').map((x) => x.trim()).filter(Boolean)
    else if (type === 'object') out[key] = JSON.parse(raw)
    else out[key] = raw
  }
  return out
}

function restFiles(after) {
  const i = process.argv.indexOf(after)
  return i < 0 ? [] : process.argv.slice(i + 1)
}

const cmd = process.argv[2] || 'help'

try {
  switch (cmd) {
    case 'help':
    case '-h':
    case '--help':
      print(HELP)
      break
    case 'prompt': {
      const name = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'editing_guide'
      try {
        const r = await mcp('prompts/get', { name, arguments: arg('--goal') ? { goal: arg('--goal') } : {} })
        const text = r?.messages?.map((m) => m.content?.text).join('\n\n')
        print(`${text}\n\n—— 终端用法 ——\n工具名里的下划线换成连字符就是命令，例如 remove_silence → cutstudio remove-silence。\n看画面：cutstudio frame --at 毫秒 / cutstudio contact-sheet，输出 JPEG 路径，用读图工具查看。\n没有专用命令的工具：cutstudio call <工具名> '<json参数>'。\n`)
      } catch (e) {
        print(PROMPT_FALLBACK)
        throw e
      }
      break
    }
    case 'skill':
    case 'install-skill': {
      const r = await mcp('prompts/get', { name: 'editing_guide', arguments: {} })
      const guide = r?.messages?.map((m) => m.content?.text).join('\n\n') ?? ''
      const body = `---
name: cutstudio
description: 用「剪辑台」剪辑视频：当用户要剪辑、粗剪、去口误、加字幕、配乐、做短视频，或提到剪辑台 / cutstudio / 当前工程时使用。通过 cutstudio 命令读写正在打开的剪辑台工程。
---

# 剪辑台剪辑指南

所有操作通过终端命令 \`cutstudio\` 完成（剪辑台 App 必须开着）。工具名的下划线换成连字符就是命令，参数写成 \`--参数名 值\`（参数名用连字符，数组用逗号分隔）；也可以 \`cutstudio call <工具名> '<json>'\`。\`cutstudio tools\` 列出全部工具和说明。
看画面：\`cutstudio frame --at 毫秒\` / \`cutstudio contact-sheet\` 输出 JPEG 路径，用 Read 工具查看图片。
配方全文：\`cutstudio prompt <talking_head|shorts|vlog|interview|product>\`。

${guide}
`
      if (cmd === 'skill') {
        print(body)
        break
      }
      const { mkdirSync, writeFileSync } = await import('node:fs')
      const { join, resolve } = await import('node:path')
      const root = resolve(process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : process.cwd())
      const dir = join(root, '.claude', 'skills', 'cutstudio')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'SKILL.md'), body)
      print(`已写入 ${join(dir, 'SKILL.md')}\n在该目录下启动 claude 即可自动加载剪辑指南。改了剪辑台的提示词后重新运行本命令。`)
      break
    }
    case 'call': {
      const name = process.argv[3]
      if (!name) throw new Error("用法: cutstudio call <工具名> '<json参数>'")
      print(await tool(name, process.argv[4] ? JSON.parse(process.argv[4]) : {}))
      break
    }
    case 'tools': {
      const specs = await toolSpecs()
      const only = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3].replace(/-/g, '_') : null
      const list = only ? specs.filter((t) => t.name === only) : specs
      if (!list.length) throw new Error(`没有工具 ${only}`)
      print(
        list
          .map((t) => {
            const props = Object.entries(t.inputSchema?.properties ?? {})
            const req = new Set(t.inputSchema?.required ?? [])
            const params = props.map(([k, v]) => `    ${paramLine(k, v)}${req.has(k) ? '  （必填）' : ''}`).join('\n')
            return `cutstudio ${t.name.replace(/_/g, '-')}\n  ${t.description}${params ? '\n' + params : ''}`
          })
          .join('\n\n')
      )
      break
    }
    case 'index':
      print(await tool('get_index'))
      break
    case 'frame': {
      const at = arg('--at') ?? process.argv[3]
      if (at == null || Number.isNaN(Number(at))) throw new Error('用法: cutstudio frame --at 毫秒')
      print(await tool('get_frame', { atMs: Number(at), output: 'file', ...(arg('--width') ? { width: Number(arg('--width')) } : {}) }))
      break
    }
    case 'contact-sheet':
      print(await tool('contact_sheet', {
        output: 'file',
        ...(arg('--start') ? { startMs: Number(arg('--start')) } : {}),
        ...(arg('--end') ? { endMs: Number(arg('--end')) } : {}),
        ...(arg('--count') ? { count: Number(arg('--count')) } : {})
      }))
      break
    case 'mcp':
      print({ url: MCP })
      break
    case 'status': {
      const p = await tool('get_project')
      print({
        name: p.name,
        durationMs: p.durationMs,
        assets: p.assets?.length ?? 0,
        clips: p.storyline?.length ?? 0,
        subtitles: p.subtitles?.length ?? 0,
        mcp: MCP
      })
      break
    }
    case 'project':
      print(await tool('get_project'))
      break
    case 'timeline':
      print(await tool('get_timeline'))
      break
    case 'media':
      print(await tool('list_media'))
      break
    case 'import': {
      const paths = restFiles('import')
      if (!paths.length) throw new Error('用法: cutstudio import <文件...>')
      print(await tool('import_media', { paths }))
      break
    }
    case 'add-clip': {
      const assetId = arg('--asset')
      if (!assetId) throw new Error('用法: cutstudio add-clip --asset <id> [--in 毫秒] [--out 毫秒]')
      const inMs = arg('--in')
      const outMs = arg('--out')
      const op = { op: 'add_clip', assetId }
      if (inMs) op.inMs = Number(inMs)
      if (outMs) op.outMs = Number(outMs)
      print(await tool('apply_ops', { summary: '加入故事线', ops: [op] }))
      break
    }
    case 'add-subtitle': {
      const startMs = Number(arg('--start'))
      const endMs = Number(arg('--end'))
      const text = arg('--text')
      if (!text || Number.isNaN(startMs) || Number.isNaN(endMs)) {
        throw new Error('用法: cutstudio add-subtitle --start 毫秒 --end 毫秒 --text "内容"')
      }
      print(await tool('apply_ops', { summary: `加字幕：${text}`, ops: [{ op: 'add_subtitle', startMs, endMs, text }] }))
      break
    }
    case 'apply': {
      const summary = arg('--summary') || 'CLI 剪辑'
      const raw = arg('--ops')
      if (!raw) throw new Error('用法: cutstudio apply --summary "说明" --ops \'<json数组>\'')
      const ops = JSON.parse(raw)
      print(await tool('apply_ops', { summary, ops }))
      break
    }
    case 'undo':
      print(await tool('undo'))
      break
    case 'remove-silence':
      print(await tool('remove_silence', { minMs: Number(arg('--min') || 400), padMs: Number(arg('--pad') || 120) }))
      break
    case 'keep-speech':
      print(await tool('keep_speech'))
      break
    case 'fit-duration':
      print(await tool('fit_duration', { targetMs: Number(arg('--ms') || 60000) }))
      break
    case 'captions-from-transcript':
      print(await tool('captions_from_transcript'))
      break
    case 'set-aspect':
      print(await tool('set_aspect', { aspect: process.argv[3] || '16:9' }))
      break
    case 'set-transition':
      print(
        await tool('set_transition', {
          type: process.argv[3] || 'none',
          ...(process.argv[4] && !process.argv[4].startsWith('--') ? { durationMs: Number(process.argv[4]) } : {}),
          ...clipArgs()
        })
      )
      break
    case 'list-transitions':
      print(await tool('list_transitions'))
      break
    case 'fade-to-black':
      print(await tool('fade_to_black'))
      break
    case 'normalize-loudness':
      print(await tool('normalize_loudness', arg('--lufs') ? { targetLufs: Number(arg('--lufs')) } : {}))
      break
    case 'duck-music':
      print(await tool('duck_music', { enabled: true }))
      break
    case 'apply-filter':
      print(await tool('apply_filter', { name: process.argv[3] || 'vivid', ...clipArgs() }))
      break
    case 'add-effect':
      print(await tool('add_effect', {
        type: process.argv[3] || 'blur',
        ...(arg('--amount') ? { amount: Number(arg('--amount')) } : {}),
        ...clipArgs()
      }))
      break
    case 'apply-lut':
      print(await tool('apply_lut', {
        name: process.argv[3] || 'warm',
        ...(arg('--path') ? { path: arg('--path') } : {}),
        ...clipArgs()
      }))
      break
    case 'list-effects':
      print(await tool('list_effects'))
      break
    case 'set-speed':
      print(await tool('set_speed', { rate: Number(arg('--rate') || 1), ...clipArgs() }))
      break
    case 'set-opacity':
      print(await tool('set_opacity', { opacity: Number(arg('--value') || 1), ...clipArgs() }))
      break
    case 'set-transform':
      print(await tool('set_transform', {
        ...(arg('--scale') ? { scale: Number(arg('--scale')) } : {}),
        ...(arg('--x') ? { x: Number(arg('--x')) } : {}),
        ...(arg('--y') ? { y: Number(arg('--y')) } : {}),
        ...clipArgs()
      }))
      break
    case 'add-layer':
      print(await tool('add_layer', {
        assetId: arg('--asset'),
        startMs: Number(arg('--start') || 0),
        ...(arg('--ms') ? { durationMs: Number(arg('--ms')) } : {}),
        blend: arg('--blend') || 'normal'
      }))
      break
    case 'set-blend':
      print(await tool('set_blend', { mode: process.argv[3] || 'normal', ...clipArgs() }))
      break
    case 'add-solid':
      print(await tool('add_solid', {
        color: arg('--color') || '#000000',
        startMs: Number(arg('--start') || 0),
        durationMs: Number(arg('--ms') || 5000)
      }))
      break
    case 'add-adjustment':
      print(await tool('add_adjustment_layer', {
        startMs: Number(arg('--start') || 0),
        ...(arg('--ms') ? { durationMs: Number(arg('--ms')) } : {}),
        ...(process.argv[3] && !process.argv[3].startsWith('--') ? { filter: process.argv[3] } : {}),
        ...(arg('--filter') ? { filter: arg('--filter') } : {})
      }))
      break
    case 'add-mask':
      print(await tool('add_mask', {
        shape: process.argv[3] || 'ellipse',
        mode: arg('--mode') || 'add',
        ...clipArgs()
      }))
      break
    case 'remove-mask':
      print(await tool('remove_mask', clipArgs()))
      break
    case 'set-keyframe':
      print(await tool('set_keyframe', {
        prop: process.argv[3] || 'opacity',
        value: Number(arg('--value') ?? 1),
        ...(arg('--at') ? { atMs: Number(arg('--at')) } : {}),
        ease: arg('--ease') || 'ease_in_out',
        ...clipArgs()
      }))
      break
    case 'freeze-frame':
      print(await tool('freeze_frame', clipArgs()))
      break
    case 'reverse-clip':
      print(await tool('reverse_clip', clipArgs()))
      break
    case 'stabilize':
      print(await tool('stabilize', {
        enabled: true,
        ...(arg('--amount') ? { amount: Number(arg('--amount')) } : {}),
        ...clipArgs()
      }))
      break
    case 'key-color':
      print(await tool('key_color', {
        color: process.argv[3] || 'green',
        ...(arg('--tolerance') ? { tolerance: Number(arg('--tolerance')) } : {}),
        ...(arg('--spill') ? { spill: Number(arg('--spill')) } : {}),
        ...(arg('--edge') ? { edge: Number(arg('--edge')) } : {}),
        ...clipArgs()
      }))
      break
    case 'link-to-audio':
      print(await tool('link_to_audio', {
        prop: arg('--prop') || 'both',
        ...(arg('--amount') ? { amount: Number(arg('--amount')) } : {}),
        ...clipArgs()
      }))
      break
    case 'denoise-audio':
      print(await tool('denoise_audio', {
        enabled: true,
        ...(arg('--amount') ? { amount: Number(arg('--amount')) } : {}),
        ...clipArgs()
      }))
      break
    case 'animate-text':
      print(await tool('animate_text', {
        text: arg('--text') || process.argv[3] || '标题',
        preset: arg('--preset') || 'fade',
        ...(arg('--start') ? { startMs: Number(arg('--start')) } : {}),
        ...(arg('--ms') ? { durationMs: Number(arg('--ms')) } : {})
      }))
      break
    case 'add-shape':
      print(await tool('add_shape', { shape: process.argv[3] || 'rect', color: arg('--color') || '#e0a93a' }))
      break
    case 'export':
      print(await tool('export', { preset: process.argv[3] || '1080p' }))
      break
    case 'render-queue-add':
      print(await tool('render_queue_add', { preset: process.argv[3] || '1080p' }))
      break
    case 'make-proxy':
      print(await tool('make_proxy', arg('--asset') ? { assetId: arg('--asset') } : {}))
      break
    case 'split-on-scenes':
      print(await tool('split_on_scenes'))
      break
    case 'remove-filler':
      print(await tool('remove_filler'))
      break
    case 'duplicate-clip':
      print(await tool('duplicate_clip', clipArgs()))
      break
    case 'detach-audio':
      print(await tool('detach_audio', clipArgs()))
      break
    case 'auto-enhance':
      print(await tool('auto_enhance'))
      break
    case 'reframe':
      print(await tool('reframe', { aspect: process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '9:16' }))
      break
    case 'add-title':
      print(await tool('add_title', { text: arg('--text') || '标题', startMs: Number(arg('--start') || 0) }))
      break
    case 'flip':
      print(await tool('flip', clipArgs()))
      break
    case 'slow-motion':
      print(await tool('slow_motion', { rate: Number(arg('--rate') || 0.5), ...clipArgs() }))
      break
    case 'jump-cut':
      print(await tool('jump_cut'))
      break
    case 'mute':
      print(await tool('mute_clip', clipArgs()))
      break
    case 'delete-media': {
      const id = process.argv[3]
      if (!id) throw new Error('用法: cutstudio delete-media <assetId>')
      print(await tool('delete_asset', { assetId: id }))
      break
    }
    default: {
      // 通用映射：cutstudio cut-sentences --sentence-ids a,b --pad-ms 60 → cut_sentences {sentenceIds:[a,b], padMs:60}
      const name = cmd.replace(/-/g, '_')
      const list = await mcp('tools/list', {})
      const spec = list?.tools?.find((t) => t.name === name)
      if (!spec) throw new Error(`未知命令: ${cmd}\n运行 cutstudio help，或 cutstudio tools 查看全部工具`)
      print(await tool(name, flagsToArgs(spec.inputSchema?.properties ?? {})))
    }
  }
} catch (e) {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n')
  process.exit(1)
}
