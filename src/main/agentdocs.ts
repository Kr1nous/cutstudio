/**
 * 让终端里启动的 AI agent 自动拿到剪辑说明：在工程目录写各家 agent 启动时会读的说明文件。
 *   claude → CLAUDE.md（另写 .claude/skills/cutstudio/SKILL.md）
 *   codex / grok → AGENTS.md
 *   gemini → GEMINI.md
 * 文件带自动生成标记；用户自己写的同名文件（没有标记）不覆盖。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fullPrompt, RECIPES } from '../shared/prompts'

export const AGENT_DOC_MARKER = '<!-- cutstudio:auto 本文件由剪辑台自动生成，改了剪辑规则会被覆盖；想自己写就删掉这一行 -->'

const CLI = `## 怎么操作

所有剪辑都通过终端命令 \`cutstudio\` 完成（剪辑台 App 必须开着，改动会立刻出现在时间线上）：
- 工具名里的下划线换成连字符就是命令，参数写成 \`--参数名 值\`（参数名用连字符，数组用逗号分隔）。例如 \`cutstudio remove-filler\`、\`cutstudio insert-broll --asset-id <id> --at-text "充电盒"\`。
- \`cutstudio tools [工具名]\` 查看工具说明和参数；\`cutstudio call <工具名> '<json>'\` 调用任意工具。
- 看画面：\`cutstudio frame --at 毫秒\` / \`cutstudio contact-sheet\`（加 \`--asset-id\` 看素材本身），输出 JPEG 路径，用读图工具查看。
- 配方全文：\`cutstudio prompt <${Object.keys(RECIPES).join('|')}>\`。
- 只用 cutstudio 操作工程，不要直接改工程目录里的 project.json 或媒体文件。`

export function agentGuide(): string {
  return `# 剪辑台 · AI 剪辑说明\n\n这里是「剪辑台」的工程目录。用户会让你剪辑这个工程里的影片。\n\n${CLI}\n\n${fullPrompt()}\n`
}

function writeIfOurs(path: string, body: string): 'written' | 'kept' | 'same' {
  if (existsSync(path)) {
    const cur = readFileSync(path, 'utf8')
    if (!cur.includes('cutstudio:auto')) return 'kept'
    if (cur === body) return 'same'
  }
  writeFileSync(path, body, 'utf8')
  return 'written'
}

/** 写（或刷新）工程目录里的 agent 说明文件。返回每个文件的处理结果；目录不存在时不做事。 */
export function writeAgentDocs(dir: string | null | undefined): Record<string, 'written' | 'kept' | 'same'> {
  const out: Record<string, 'written' | 'kept' | 'same'> = {}
  if (!dir || !existsSync(dir)) return out
  const guide = agentGuide()
  const doc = `${AGENT_DOC_MARKER}\n\n${guide}`
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md']) out[name] = writeIfOurs(join(dir, name), doc)
  const skillDir = join(dir, '.claude', 'skills', 'cutstudio')
  mkdirSync(skillDir, { recursive: true })
  const skill = `---
name: cutstudio
description: 用「剪辑台」剪辑视频：当用户要剪辑、粗剪、去口误、加字幕、配乐、做短视频，或提到剪辑台 / cutstudio / 当前工程时使用。通过 cutstudio 命令读写正在打开的剪辑台工程。
---
${AGENT_DOC_MARKER}

${guide}`
  out['.claude/skills/cutstudio/SKILL.md'] = writeIfOurs(join(skillDir, 'SKILL.md'), skill)
  return out
}

/** 目录里是否已有自动生成的说明（有就不用再用启动参数注入）。 */
export function hasAgentDoc(dir: string, file: string): boolean {
  try {
    return readFileSync(join(dir, file), 'utf8').includes('cutstudio:auto')
  } catch {
    return false
  }
}
