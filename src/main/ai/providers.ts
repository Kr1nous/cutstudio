import OpenAI from 'openai'
import type { AiProvider } from '../../shared/types'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  name?: string
  tool_call_id?: string
  tool_calls?: ToolCall[]
  /** user 消息附带的图片，或 tool 结果里的图片（get_frame / contact_sheet）。 */
  images?: { mime: string; data: string }[]
}

export interface ToolSpec {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface ChatResult {
  text: string
  toolCalls: ToolCall[]
}

export async function chatWithTools(
  provider: AiProvider,
  messages: ChatMessage[],
  tools: ToolSpec[],
  images: { mime: string; data: string }[] = []
): Promise<ChatResult> {
  if (!provider.apiKey && provider.kind !== 'openai-compatible') {
    throw new Error(`请先在设置里填写 ${provider.name} 的 API Key`)
  }
  if (provider.kind === 'anthropic') {
    return chatAnthropic(provider, messages, tools, images)
  }
  return chatOpenAiCompatible(provider, messages, tools, images)
}

async function chatOpenAiCompatible(
  provider: AiProvider,
  messages: ChatMessage[],
  tools: ToolSpec[],
  images: { mime: string; data: string }[]
): Promise<ChatResult> {
  const client = new OpenAI({
    apiKey: provider.apiKey || 'no-key',
    baseURL: provider.baseUrl
  })

  const imageParts = (list: { mime: string; data: string }[]) =>
    list.map((img) => ({ type: 'image_url' as const, image_url: { url: `data:${img.mime};base64,${img.data}` } }))
  // OpenAI 的 tool 消息不能带图：同一轮 tool 结果之后补一条 user 消息放图片。
  const withToolImages: ChatMessage[] = []
  let pending: { mime: string; data: string }[] = []
  messages.forEach((m, i) => {
    withToolImages.push(m.role === 'tool' ? { ...m, images: undefined } : m)
    if (m.role === 'tool' && m.images?.length) pending.push(...m.images)
    if (pending.length && messages[i + 1]?.role !== 'tool') {
      withToolImages.push({ role: 'user', content: '上面工具返回的画面：', images: pending })
      pending = []
    }
  })

  const oaMessages = withToolImages.map((m, idx) => {
    const attach = [...(m.images ?? []), ...(m.role === 'user' && idx === lastUserIndex(withToolImages) ? images : [])]
    if (m.role === 'user' && attach.length > 0) {
      return {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: m.content }, ...imageParts(attach)]
      }
    }
    if (m.role === 'tool') {
      return {
        role: 'tool' as const,
        tool_call_id: m.tool_call_id ?? '',
        content: m.content
      }
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      return {
        role: 'assistant' as const,
        content: m.content || null,
        tool_calls: m.tool_calls.map((c) => ({
          id: c.id,
          type: 'function' as const,
          function: { name: c.name, arguments: c.arguments }
        }))
      }
    }
    return { role: m.role, content: m.content }
  })

  const response = await client.chat.completions.create({
    model: provider.model,
    messages: oaMessages as OpenAI.Chat.ChatCompletionMessageParam[],
    tools: tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters }
    })),
    tool_choice: 'auto'
  })

  const msg = response.choices[0]?.message
  const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).flatMap((c) =>
    c.type === 'function' ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments }] : []
  )

  return { text: msg?.content ?? '', toolCalls }
}

async function chatAnthropic(
  provider: AiProvider,
  messages: ChatMessage[],
  tools: ToolSpec[],
  images: { mime: string; data: string }[]
): Promise<ChatResult> {
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n')
  const rest = messages.filter((m) => m.role !== 'system')
  type Block = Record<string, unknown>
  const anthMessages: { role: 'user' | 'assistant'; content: Block[] }[] = []
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    const prev = anthMessages.at(-1)
    // Anthropic 要求 user / assistant 交替：同一方向的连续消息合并（多个 tool_result 必须在同一条 user 消息里）。
    if (prev?.role === role) prev.content.push(...blocks)
    else anthMessages.push({ role, content: blocks })
  }
  const lastUser = rest.map((m) => m.role).lastIndexOf('user')
  rest.forEach((m, idx) => {
    if (m.role === 'tool') {
      const content = m.images?.length
        ? [
            { type: 'text', text: m.content },
            ...m.images.map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } }))
          ]
        : m.content
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content }])
    } else if (m.role === 'assistant') {
      const blocks: Block[] = []
      if (m.content) blocks.push({ type: 'text', text: m.content })
      for (const c of m.tool_calls ?? []) {
        let input: unknown = {}
        try {
          input = JSON.parse(c.arguments || '{}')
        } catch {
          input = {}
        }
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input })
      }
      if (blocks.length) push('assistant', blocks)
    } else {
      const content: Block[] = [{ type: 'text', text: m.content }]
      for (const img of [...(m.images ?? []), ...(idx === lastUser ? images : [])]) {
        content.push({ type: 'image', source: { type: 'base64', media_type: img.mime, data: img.data } })
      }
      push('user', content)
    }
  })

  const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': provider.apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 16000,
      system,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters
      })),
      messages: anthMessages
    })
  })
  if (!res.ok) {
    throw new Error(`Anthropic 错误 ${res.status}: ${await res.text()}`)
  }
  const data = (await res.json()) as {
    content: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>
  }
  const toolCalls: ToolCall[] = []
  const texts: string[] = []
  for (const block of data.content ?? []) {
    if (block.type === 'text' && block.text) texts.push(block.text)
    if (block.type === 'tool_use' && block.name && block.id) {
      toolCalls.push({ id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) })
    }
  }
  return { text: texts.join('\n'), toolCalls }
}

function lastUserIndex(messages: ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return i
  }
  return -1
}
