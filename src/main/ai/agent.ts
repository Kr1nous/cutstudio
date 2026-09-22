import { readFile } from 'node:fs/promises'
import { store } from '../core'
import { chatWithTools, type ChatMessage } from './providers'
import { ALL_TOOLS, executeTool } from './tools'
import { fullPrompt } from '../../shared/prompts'
import { isVisionResult } from './vision'

const SYSTEM = fullPrompt()
const MAX_STEPS = 40

export async function runAgent(userPrompt: string, frames: { mime: string; data: string }[] = []) {
  const provider = store.activeProvider()
  if (!provider) throw new Error('没有可用的 AI 提供方')
  if (!provider.apiKey && !provider.baseUrl.includes('11434')) {
    throw new Error(`请先在设置中填写 ${provider.name} 的 API Key`)
  }
  store.requireProject()

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM },
    {
      role: 'user',
      content: `当前项目摘要：\n${JSON.stringify(store.compactForAi(), null, 2)}\n\n用户指令：\n${userPrompt}`
    }
  ]

  const images = store.settings.allowMediaUpload ? frames.slice(0, 8) : []
  let lastText = ''

  for (let step = 0; step < MAX_STEPS; step++) {
    const result = await chatWithTools(provider, messages, ALL_TOOLS, step === 0 ? images : [])
    lastText = result.text
    if (!result.toolCalls.length) break
    messages.push({
      role: 'assistant',
      content: result.text || '',
      tool_calls: result.toolCalls
    })
    for (const call of result.toolCalls) {
      let parsed: Record<string, unknown> = {}
      try {
        parsed = JSON.parse(call.arguments || '{}')
      } catch {
        parsed = {}
      }
      let toolResult: unknown
      try {
        toolResult = await executeTool(call.name, parsed, 'ai')
      } catch (err) {
        toolResult = { error: err instanceof Error ? err.message : String(err) }
      }
      let toolImages: { mime: string; data: string }[] | undefined
      if (isVisionResult(toolResult)) {
        if (store.settings.allowMediaUpload) {
          toolImages = toolResult.images
          // 只保留最近两次看图的图片，旧的换成文字，避免 base64 撑爆上下文。
          const withImages = messages.filter((m) => m.role === 'tool' && m.images?.length)
          for (const old of withImages.slice(0, Math.max(0, withImages.length - 1))) {
            old.images = undefined
            old.content += '\n（图片已从上下文移除，需要时重新调用）'
          }
        }
        toolResult = {
          ...toolResult,
          images: [],
          ...(toolImages ? {} : { note: '设置里关闭了媒体上传，AI 看不到画面。' })
        }
      }
      messages.push({
        role: 'tool',
        name: call.name,
        tool_call_id: call.id,
        content: JSON.stringify(toolResult),
        ...(toolImages?.length ? { images: toolImages } : {})
      })
    }
  }

  return {
    text: lastText || '已完成剪辑，请在时间线和右侧审查记录里查看。',
    provider: provider.name,
    model: provider.model
  }
}

export async function loadFrameBase64(filePath: string): Promise<{ mime: string; data: string } | null> {
  try {
    const buf = await readFile(filePath)
    const mime = filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg'
    return { mime, data: buf.toString('base64') }
  } catch {
    return null
  }
}
