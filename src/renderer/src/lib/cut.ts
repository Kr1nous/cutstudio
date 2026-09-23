import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { desktopDir, documentDir, downloadDir, videoDir } from '@tauri-apps/api/path'
import { ask, message, open, save } from '@tauri-apps/plugin-dialog'
import type { AppSettings, ExportOptions, ExportProgress, RecentProject, TimelineOp } from '@shared/types'

const API: string = import.meta.env.VITE_CUT_API || 'http://127.0.0.1:4878'

type Unsub = () => void

async function waitApi(tries = 80): Promise<void> {
  let last = ''
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${API}/health`)
      if (r.ok) return
      last = await r.text()
    } catch (e) {
      last = e instanceof Error ? e.message : String(e)
    }
    await new Promise((r) => setTimeout(r, 120))
  }
  throw new Error(`剪辑台后端没有启动（${last}）`)
}

async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await r.text()
  const parsed = text ? (JSON.parse(text) as T & { error?: string }) : (null as T)
  if (!r.ok) {
    const err = parsed && typeof parsed === 'object' && 'error' in parsed ? parsed.error : text
    throw new Error(String(err || r.statusText))
  }
  return parsed
}

function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

async function defaultSaveDir(): Promise<string> {
  try {
    return await videoDir()
  } catch {
    try {
      return await documentDir()
    } catch {
      return ''
    }
  }
}

const stateListeners = new Set<(state: unknown) => void>()
const termDataListeners = new Set<(data: string) => void>()
const termExitListeners = new Set<(code: number) => void>()
const menuListeners = new Set<(action: string) => void>()
const exportListeners = new Set<(p: ExportProgress) => void>()

function connectEvents(): Unsub {
  const es = new EventSource(`${API}/events`)
  es.addEventListener('state', (e) => {
    const data = JSON.parse((e as MessageEvent).data)
    for (const cb of stateListeners) cb(data)
  })
  es.addEventListener('terminal-data', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as string
    for (const cb of termDataListeners) cb(data)
  })
  es.addEventListener('terminal-exit', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as number
    for (const cb of termExitListeners) cb(data)
  })
  es.addEventListener('export-progress', (e) => {
    const data = JSON.parse((e as MessageEvent).data) as ExportProgress
    for (const cb of exportListeners) cb(data)
  })
  es.onerror = () => {
    /* browser reconnects */
  }
  return () => es.close()
}

export const cutApi = {
  getState: () => api('GET', '/state'),
  onState: (cb: (state: unknown) => void) => {
    stateListeners.add(cb)
    return () => {
      stateListeners.delete(cb)
    }
  },
  getTheme: async () => ({ dark: window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false }),
  onTheme: (cb: (theme: { dark: boolean }) => void) => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const fn = () => cb({ dark: mq.matches })
    mq.addEventListener('change', fn)
    return () => mq.removeEventListener('change', fn)
  },
  onMenu: (cb: (action: string) => void) => {
    menuListeners.add(cb)
    return () => {
      menuListeners.delete(cb)
    }
  },
  createProject: async (name?: string) => {
    const safeName = (name || '未命名项目').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名项目'
    const dir = await defaultSaveDir()
    const picked = await save({
      title: '新建项目',
      defaultPath: dir ? `${dir}/${safeName}.cutproj` : `${safeName}.cutproj`,
      filters: [{ name: '剪辑台项目', extensions: ['cutproj'] }]
    })
    if (!picked) return null
    return api('POST', '/project/create', { path: picked })
  },
  openProject: async () => {
    const dir = await defaultSaveDir()
    const picked = await open({
      title: '打开 .cutproj 项目',
      directory: true,
      defaultPath: dir || undefined
    })
    if (!picked) return null
    return api('POST', '/project/open', { path: picked })
  },
  openProjectPath: (path: string) => api('POST', '/project/open', { path }),
  closeProject: () => api('POST', '/project/close'),
  recentProjects: () => api<(RecentProject & { exists: boolean })[]>('GET', '/projects/recent'),
  forgetRecent: (path: string) => api('POST', '/projects/forget', { path }),
  renameProject: (name: string) => api('POST', '/project/rename', { name }),
  importMedia: async () => {
    const picked = await open({
      title: '导入已录制的影片',
      multiple: true,
      filters: [
        { name: '媒体', extensions: ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'mp3', 'wav', 'aac', 'png', 'jpg', 'jpeg'] }
      ]
    })
    if (!picked) return []
    const paths = Array.isArray(picked) ? picked : [picked]
    return api('POST', '/media/import', { paths })
  },
  importPaths: (paths: string[]) => api('POST', '/media/import', { paths }),
  deleteAsset: (assetId: string) => api('POST', '/media/delete', { assetId }),
  updateAssetMeta: (assetId: string, meta: object) => api('POST', '/media/updateMeta', { assetId, meta }),
  probeAsset: (assetId: string) => api('POST', '/media/probe', { assetId }),
  saveThumb: (assetId: string, dataUrl: string) => api('POST', '/media/thumb', { assetId, dataUrl }),
  exportTimeline: (opts: ExportOptions = {}) => api<{ path: string; warnings: string[] }>('POST', '/media/export', opts),
  cancelExport: () => api('POST', '/media/export/cancel'),
  onExportProgress: (cb: (p: ExportProgress) => void) => {
    exportListeners.add(cb)
    return () => {
      exportListeners.delete(cb)
    }
  },
  pickExportPath: async (defaultName: string) => {
    const dir = await defaultSaveDir()
    const picked = await save({
      title: '导出到',
      defaultPath: dir ? `${dir}/${defaultName}` : defaultName,
      filters: [{ name: '影片', extensions: ['mp4', 'mov'] }]
    })
    return picked || null
  },
  runAction: (name: string, args: Record<string, unknown> = {}) => api('POST', '/action/run', { name, args }),
  applyOps: (ops: TimelineOp[], summary?: string) => api('POST', '/timeline/ops', { ops, summary }),
  undo: (steps = 1) => api('POST', '/timeline/undo', { steps }),
  redo: (steps = 1) => api('POST', '/timeline/redo', { steps }),
  restore: (id: string) => api('POST', '/timeline/restore', { id }),
  runAi: (prompt: string, frames: { mime: string; data: string }[] = []) => api('POST', '/ai/run', { prompt, frames }),
  updateSettings: (patch: Partial<AppSettings>) => api('POST', '/settings/update', { patch }),
  mcpStatus: () => api('GET', '/mcp/status'),
  showInFolder: async (path: string) => {
    if (isTauri()) await invoke('show_in_folder', { path })
  },
  getPathForFile: (file: File) => {
    const withPath = file as File & { path?: string }
    return withPath.path ?? ''
  },
  requestPermissions: async () => {
    const go = await ask(
      '接下来会：\n1. 打开「完全磁盘访问」设置，请把剪辑台勾选。\n2. 依次授权影片、文稿、桌面、下载文件夹。\n\n授权完成后，终端中的 grok / claude 等才能用 cutstudio 读写当前项目。',
      {
        title: '剪辑台需要完整文件权限',
        kind: 'info',
        okLabel: '开始授权',
        cancelLabel: '以后再说'
      }
    )
    if (!go) return api('GET', '/state')
    try {
      await invoke('open_privacy_settings')
    } catch {
      /* user can open 系统设置 manually */
    }
    await message('请在系统设置中勾选剪辑台的「完全磁盘访问」，然后回到本窗口点继续。', {
      title: '完全磁盘访问',
      kind: 'info',
      okLabel: '已勾选，继续'
    })
    const folders: { title: string; pick: () => Promise<string> }[] = [
      { title: '授权访问「影片」文件夹', pick: () => videoDir() },
      { title: '授权访问「文稿」文件夹', pick: () => documentDir() },
      { title: '授权访问「桌面」文件夹', pick: () => desktopDir() },
      { title: '授权访问「下载」文件夹', pick: () => downloadDir() }
    ]
    for (const folder of folders) {
      let defaultPath = ''
      try {
        defaultPath = await folder.pick()
      } catch {
        /* skip default */
      }
      await open({
        title: folder.title,
        directory: true,
        defaultPath: defaultPath || undefined
      })
    }
    return api('POST', '/permissions/complete')
  },
  terminalStart: (cols: number, rows: number) => api('POST', '/terminal/start', { cols, rows }),
  terminalRestart: (cols: number, rows: number) => api('POST', '/terminal/restart', { cols, rows }),
  terminalStatus: () =>
    api<{ running: boolean; foreground: string | null; busy: boolean; agents: Record<string, boolean> }>('GET', '/terminal/status'),
  terminalWrite: (data: string) => {
    void api('POST', '/terminal/write', { data })
  },
  terminalResize: (cols: number, rows: number) => {
    void api('POST', '/terminal/resize', { cols, rows })
  },
  onTerminalData: (cb: (data: string) => void) => {
    termDataListeners.add(cb)
    return () => {
      termDataListeners.delete(cb)
    }
  },
  onTerminalExit: (cb: (code: number) => void) => {
    termExitListeners.add(cb)
    return () => {
      termExitListeners.delete(cb)
    }
  }
}

export type CutApi = typeof cutApi

export async function installCutApi(): Promise<void> {
  await waitApi()
  window.cut = cutApi
  connectEvents()
  if (isTauri()) {
    await listen<string>('menu', (event) => {
      for (const cb of menuListeners) cb(event.payload)
    })
    try {
      const { getCurrentWebview } = await import('@tauri-apps/api/webview')
      await getCurrentWebview().onDragDropEvent((event) => {
        if (event.payload.type === 'drop' && event.payload.paths.length) {
          void cutApi.importPaths(event.payload.paths)
        }
      })
    } catch {
      /* older webview */
    }
  }
}

export function mediaSrc(filePath: string): string {
  if (!filePath) return ''
  return `${API}/file?path=${encodeURIComponent(filePath)}`
}
