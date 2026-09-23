import { execSync } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
import http from 'node:http'
import { extname, join } from 'node:path'
import { runAction } from './actions'
import { runAgent } from './ai/agent'
import { store } from './core'
import { exportTimeline, probeAssetFile, renderFrame, saveThumbDataUrl } from './media'
import { startMcpHttp, mcpStatus } from './mcp/http'
import { mcpConfigSnippet } from './mcp/protocol'
import { API_PORT, extraBinPath, userDataDir } from './paths'
import {
  resizeTerminal,
  restartTerminal,
  setTerminalSink,
  startTerminal,
  stopTerminal,
  terminalStatus,
  writeTerminal
} from './terminal'
import type { AppSettings, ExportOptions, TimelineOp } from '../shared/types'
import { cancelExport, lastRenderWarnings } from './render/export'

const clients = new Set<http.ServerResponse>()

function emit(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  for (const res of clients) {
    try {
      res.write(payload)
    } catch {
      clients.delete(res)
    }
  }
}

function cors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Range')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length')
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function json(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readBody(req)
  if (!raw) return {}
  return JSON.parse(raw) as Record<string, unknown>
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

function mimeFor(path: string): string {
  return (
    {
      '.mp4': 'video/mp4',
      '.mov': 'video/quicktime',
      '.m4v': 'video/x-m4v',
      '.mkv': 'video/x-matroska',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.aac': 'audio/aac',
      '.m4a': 'audio/mp4',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
      '.gif': 'image/gif'
    }[extname(path).toLowerCase()] ?? 'application/octet-stream'
  )
}

function serveFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string): void {
  if (!filePath || filePath.includes('\0') || !existsSync(filePath)) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const st = statSync(filePath)
  if (!st.isFile()) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const mime = mimeFor(filePath)
  const range = req.headers.range
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    const start = m?.[1] ? Number(m[1]) : 0
    const end = m?.[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= st.size || start > end) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` })
      res.end()
      return
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': mime,
      'Cache-Control': 'no-cache'
    })
    createReadStream(filePath, { start, end }).pipe(res)
    return
  }
  res.writeHead(200, {
    'Content-Length': st.size,
    'Accept-Ranges': 'bytes',
    'Content-Type': mime,
    'Cache-Control': 'no-cache'
  })
  createReadStream(filePath).pipe(res)
}

function freePort(port: number): void {
  try {
    const pids = execSync(`lsof -ti tcp:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim()
    for (const pid of pids.split('\n')) {
      if (pid && pid !== String(process.pid)) {
        try {
          process.kill(Number(pid), 'SIGTERM')
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* nothing listening */
  }
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  cors(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${API_PORT}`)
  const path = url.pathname
  const method = req.method ?? 'GET'

  if (path === '/health') {
    sendJson(res, 200, { ok: true, app: '剪辑台', port: API_PORT })
    return
  }
  if (path === '/file' && method === 'GET') {
    serveFile(req, res, url.searchParams.get('path') ?? '')
    return
  }
  if (path === '/events' && method === 'GET') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    })
    res.write('event: hello\ndata: {}\n\n')
    res.write(`event: state\ndata: ${JSON.stringify(store.getState())}\n\n`)
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  if (path === '/state' && method === 'GET') {
    sendJson(res, 200, store.getState())
    return
  }
  if (path === '/project/create' && method === 'POST') {
    const body = await json(req)
    const dest = String(body.path ?? '')
    if (!dest) {
      sendJson(res, 400, { error: '缺少路径' })
      return
    }
    const { basename, dirname } = await import('node:path')
    let folder = dest
    if (!folder.endsWith('.cutproj')) folder += '.cutproj'
    await store.createProject(dirname(folder), basename(folder, '.cutproj'))
    sendJson(res, 200, store.getState())
    return
  }
  if (path === '/project/open' && method === 'POST') {
    const body = await json(req)
    await store.openProject(String(body.path ?? ''))
    sendJson(res, 200, store.getState())
    return
  }
  if (path === '/project/close' && method === 'POST') {
    await store.closeProject()
    sendJson(res, 200, store.getState())
    return
  }
  if (path === '/projects/recent' && method === 'GET') {
    const recent = (store.settings.recentProjects ?? []).map((r) => ({ ...r, exists: existsSync(join(r.path, 'project.json')) }))
    sendJson(res, 200, recent)
    return
  }
  if (path === '/projects/forget' && method === 'POST') {
    const body = await json(req)
    await store.forgetRecent(String(body.path ?? ''))
    sendJson(res, 200, { ok: true })
    return
  }
  if (path === '/project/rename' && method === 'POST') {
    const body = await json(req)
    const p = store.requireProject()
    p.name = String(body.name ?? p.name)
    if (store.projectPath) {
      store.rememberProject(store.projectPath, p.name)
      await store.saveSettings()
    }
    await store.save()
    store.broadcast()
    sendJson(res, 200, store.getState())
    return
  }
  if (path === '/media/import' && method === 'POST') {
    const body = await json(req)
    const paths = Array.isArray(body.paths) ? body.paths.map(String) : []
    sendJson(res, 200, await store.importFiles(paths))
    return
  }
  if (path === '/media/delete' && method === 'POST') {
    const body = await json(req)
    sendJson(res, 200, await store.deleteAsset(String(body.assetId ?? '')))
    return
  }
  if (path === '/media/probe' && method === 'POST') {
    const body = await json(req)
    sendJson(res, 200, await probeAssetFile(String(body.assetId ?? '')))
    return
  }
  if (path === '/media/updateMeta' && method === 'POST') {
    const body = await json(req)
    await store.updateAssetMeta(String(body.assetId ?? ''), (body.meta ?? {}) as object)
    sendJson(res, 200, store.getState())
    return
  }
  if (path === '/media/thumb' && method === 'POST') {
    const body = await json(req)
    sendJson(res, 200, { path: await saveThumbDataUrl(String(body.assetId ?? ''), String(body.dataUrl ?? '')) })
    return
  }
  if (path === '/media/export' && method === 'POST') {
    const body = await json(req)
    const opts = body as ExportOptions
    const out = await exportTimeline(String(body.preset ?? '1080p'), undefined, {
      rangeMs: opts.rangeMs,
      subtitles: opts.subtitles,
      outPath: opts.outPath
    })
    sendJson(res, 200, { path: out, warnings: lastRenderWarnings })
    return
  }
  if (path === '/media/export/cancel' && method === 'POST') {
    sendJson(res, 200, { cancelled: cancelExport() })
    return
  }
  if (path === '/compose/frame' && method === 'GET') {
    const project = store.requireProject()
    const t = Number(url.searchParams.get('t') || 0)
    const buf = await renderFrame(project, Number.isFinite(t) ? t : 0)
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' })
    res.end(buf)
    return
  }
  if (path === '/action/run' && method === 'POST') {
    const body = await json(req)
    sendJson(res, 200, await runAction(String(body.name ?? ''), (body.args as Record<string, unknown>) ?? {}, 'human'))
    return
  }
  if (path === '/timeline/ops' && method === 'POST') {
    const body = await json(req)
    sendJson(res, 200, await store.applyOps((body.ops as TimelineOp[]) ?? [], 'human', body.summary as string | undefined))
    return
  }
  if (path === '/timeline/undo' && method === 'POST') {
    const body = await json(req)
    await store.undoSteps(Number(body.steps) || 1)
    sendJson(res, 200, store.getState())
    return
  }
  if (path === '/timeline/redo' && method === 'POST') {
    const body = await json(req)
    await store.redoSteps(Number(body.steps) || 1)
    sendJson(res, 200, store.getState())
    return
  }
  if (path === '/timeline/restore' && method === 'POST') {
    const body = await json(req)
    await store.restoreSnapshot(String(body.id ?? ''))
    sendJson(res, 200, store.getState())
    return
  }
  if (path === '/ai/run' && method === 'POST') {
    const body = await json(req)
    sendJson(res, 200, await runAgent(String(body.prompt ?? ''), (body.frames as { mime: string; data: string }[]) ?? []))
    return
  }
  if (path === '/settings/update' && method === 'POST') {
    const body = await json(req)
    await store.updateSettings((body.patch ?? body) as Partial<AppSettings>)
    sendJson(res, 200, store.getState())
    return
  }
  if (path === '/mcp/status' && method === 'GET') {
    sendJson(res, 200, { ...mcpStatus(), snippet: mcpConfigSnippet(mcpStatus().port) })
    return
  }
  if (path === '/permissions/complete' && method === 'POST') {
    store.settings.firstRunComplete = true
    await store.saveSettings()
    store.broadcast()
    sendJson(res, 200, store.getState())
    return
  }
  if (path === '/terminal/start' && method === 'POST') {
    const body = await json(req)
    sendJson(res, 200, await startTerminal(Number(body.cols) || 80, Number(body.rows) || 24))
    return
  }
  if (path === '/terminal/restart' && method === 'POST') {
    const body = await json(req)
    sendJson(res, 200, await restartTerminal(Number(body.cols) || 80, Number(body.rows) || 24))
    return
  }
  if (path === '/terminal/status' && method === 'GET') {
    sendJson(res, 200, terminalStatus())
    return
  }
  if (path === '/terminal/write' && method === 'POST') {
    const body = await json(req)
    writeTerminal(String(body.data ?? ''))
    sendJson(res, 200, { ok: true })
    return
  }
  if (path === '/terminal/resize' && method === 'POST') {
    const body = await json(req)
    resizeTerminal(Number(body.cols) || 80, Number(body.rows) || 24)
    sendJson(res, 200, { ok: true })
    return
  }

  sendJson(res, 404, { error: 'not found' })
}

async function main(): Promise<void> {
  process.env.PATH = `${extraBinPath()}:${process.env.PATH ?? '/usr/bin:/bin'}`
  mkdirSync(userDataDir(), { recursive: true })
  await store.loadSettings(userDataDir())
  const last = store.settings.lastProjectPath
  if (last && existsSync(join(last, 'project.json'))) {
    try {
      await store.openProject(last)
      console.log('[sidecar] reopened', last)
    } catch (e) {
      console.warn('[sidecar] 无法打开上次项目', e)
    }
  }
  store.onChange((state) => emit('state', state))
  store.onEvent((name, data) => emit(name, data))
  setTerminalSink({
    send(channel, payload) {
      if (channel === 'terminal:data') emit('terminal-data', payload)
      if (channel === 'terminal:exit') emit('terminal-exit', payload)
    }
  })
  try {
    await startMcpHttp(store.settings.mcpPort || 4877)
    console.log(`[sidecar] MCP http://127.0.0.1:${store.settings.mcpPort || 4877}/mcp`)
  } catch (e) {
    console.warn('[sidecar] MCP 端口占用，沿用已有服务', e)
  }

  freePort(API_PORT)
  await new Promise<void>((r) => setTimeout(r, 150))

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
    })
  })
  server.listen(API_PORT, '127.0.0.1', () => {
    console.log(`[sidecar] API http://127.0.0.1:${API_PORT}`)
  })

  const shutdown = () => {
    stopTerminal()
    server.close()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
