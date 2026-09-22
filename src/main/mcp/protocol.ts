import { store } from '../core'
import { ALL_TOOLS, executeTool } from '../ai/tools'
import { timelineDurationMs } from '../../shared/types'
import { mcpInstructions, RECIPES, recipeText, fullPrompt } from '../../shared/prompts'
import { isVisionResult } from '../ai/vision'

interface JsonRpcReq {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

function ok(id: JsonRpcReq['id'], result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result }
}

function err(id: JsonRpcReq['id'], code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }
}

const SERVER_INFO = { name: 'cut-studio', title: '剪辑台', version: '1.2.0' }

function toolList() {
  return {
    tools: ALL_TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.parameters
    })).concat([
      {
        name: 'list_media',
        description: '列出项目里已导入的素材。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        name: 'get_timeline',
        description: '只读取原始时间线 JSON（含全部效果默认值，较长）。一般用 get_project。',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        name: 'import_media',
        description: '把本机已录制的影片/音频/图片导入当前项目。paths 为绝对路径。导入后会在后台分析静音、镜头、响度和转写，稍后用 get_index 查看。',
        inputSchema: {
          type: 'object',
          properties: { paths: { type: 'array', items: { type: 'string' } } },
          required: ['paths']
        }
      }
    ])
  }
}

async function callTool(name: string, args: Record<string, unknown>) {
  if (name === 'list_media') {
    const project = store.requireProject()
    return project.assets
  }
  if (name === 'get_timeline') {
    const project = store.requireProject()
    return { timeline: project.timeline, durationMs: timelineDurationMs(project.timeline) }
  }
  if (name === 'import_media') {
    const paths = (args.paths as string[]) ?? []
    return store.importFiles(paths)
  }
  return executeTool(name, args, 'mcp')
}

export async function handleMcp(body: JsonRpcReq): Promise<unknown> {
  const { id, method, params } = body
  try {
    switch (method) {
      case 'initialize':
        return ok(id, {
          protocolVersion: '2025-03-26',
          capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
          serverInfo: SERVER_INFO,
          instructions: mcpInstructions()
        })
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return null
      case 'ping':
        return ok(id, {})
      case 'tools/list':
        return ok(id, toolList())
      case 'tools/call': {
        const name = String(params?.name ?? '')
        const args = (params?.arguments as Record<string, unknown>) ?? {}
        let result: unknown
        try {
          result = await callTool(name, args)
        } catch (e) {
          // 工具错误作为结果返回（isError），模型才能看到原因并自己修正参数。
          return ok(id, {
            content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }],
            isError: true
          })
        }
        if (isVisionResult(result)) {
          const { images, ...meta } = result
          return ok(id, {
            content: [
              { type: 'text', text: JSON.stringify(meta) },
              ...images.map((img) => ({ type: 'image', data: img.data, mimeType: img.mime }))
            ],
            structuredContent: meta
          })
        }
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result
        })
      }
      case 'resources/list':
        return ok(id, {
          resources: store.project
            ? [
                {
                  uri: 'cut://project',
                  name: store.project.name,
                  mimeType: 'application/json',
                  description: '当前剪辑工程（含独立字幕轨）'
                }
              ]
            : []
        })
      case 'resources/read': {
        const uri = String(params?.uri ?? '')
        if (uri !== 'cut://project') throw new Error('未知资源')
        return ok(id, {
          contents: [
            {
              uri,
              mimeType: 'application/json',
              text: JSON.stringify(store.compactForAi(), null, 2)
            }
          ]
        })
      }
      case 'prompts/list':
        return ok(id, {
          prompts: [
            { name: 'editing_guide', description: '剪辑台完整剪辑说明：流程、剪辑语法、配方列表' },
            ...Object.entries(RECIPES).map(([name, r]) => ({
              name,
              description: `${r.title}：${r.description}`,
              arguments: [{ name: 'goal', description: '补充要求，例如目标时长、平台', required: false }]
            }))
          ]
        })
      case 'prompts/get': {
        const name = String(params?.name ?? '')
        const goal = String((params?.arguments as Record<string, unknown> | undefined)?.goal ?? '').trim()
        const body = name === 'editing_guide' ? fullPrompt() : recipeText(name)
        if (!body) return err(id, -32602, `未知 prompt: ${name}`)
        const text = name === 'editing_guide' ? body : `按下面的配方剪辑当前项目。${goal ? `\n补充要求：${goal}` : ''}\n\n${body}`
        return ok(id, {
          description: name,
          messages: [{ role: 'user', content: { type: 'text', text } }]
        })
      }
      default:
        if (method?.startsWith('notifications/')) return null
        return err(id, -32601, `Method not found: ${method}`)
    }
  } catch (e) {
    return err(id, -32000, e instanceof Error ? e.message : String(e))
  }
}

export function mcpConfigSnippet(port: number) {
  return {
    mcpServers: {
      'cut-studio': {
        url: `http://127.0.0.1:${port}/mcp`
      }
    }
  }
}
