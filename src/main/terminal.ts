import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentGuide, writeAgentDocs } from './agentdocs'
import { store } from './core'
import { cliBinDir, extraBinPath, userDataDir } from './paths'

interface Session {
  write: (data: string) => void
  resize: (cols: number, rows: number) => void
  kill: () => void
  /** 前台进程名（node-pty 提供；script 兜底时拿不到）。 */
  foreground?: () => string
}

export const AGENTS = ['claude', 'codex', 'grok', 'gemini'] as const

export type TerminalSink = { send: (channel: string, payload: unknown) => void }

let session: Session | null = null
let sink: TerminalSink | null = null

export function setTerminalSink(next: TerminalSink | null): void {
  sink = next
}

export function zdotDir(): string {
  const dir = join(userDataDir(), 'terminal-zdot')
  mkdirSync(dir, { recursive: true })
  const bin = cliBinDir()
  // 剪辑说明另存一份：包装函数直接读文件，不依赖剪辑台 MCP 在不在线
  const guide = join(dir, 'cutstudio-guide.md')
  writeFileSync(guide, agentGuide(), 'utf8')
  writeFileSync(
    join(dir, '.zshrc'),
    `# 剪辑台内置终端
[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"
export PATH="${bin}:$PATH"
export CUT_STUDIO_MCP_URL="\${CUT_STUDIO_MCP_URL:-http://127.0.0.1:4877/mcp}"
alias cs=cutstudio

# 启动 AI agent 时自动带上剪辑说明（cutstudio prompt）：
# 工程目录里有剪辑台自动生成的 CLAUDE.md / AGENTS.md 时 agent 会自己读；没有（比如 cd 到别处）就用启动参数注入。
__cs_auto_doc() { [[ -f "$1" ]] && grep -q 'cutstudio:auto' "$1" 2>/dev/null }
__cs_prompt() { if [[ -f "${guide}" ]]; then cat "${guide}"; else cutstudio prompt 2>/dev/null; fi }
claude() {
  if __cs_auto_doc CLAUDE.md; then command claude "$@"; return; fi
  local p; p="$(__cs_prompt)"
  if [[ -n "$p" ]]; then command claude --append-system-prompt "$p" "$@"; else command claude "$@"; fi
}
grok() {
  if __cs_auto_doc AGENTS.md; then command grok "$@"; return; fi
  local p; p="$(__cs_prompt)"
  if [[ -n "$p" ]]; then command grok --rules "$p" "$@"; else command grok "$@"; fi
}
codex() {
  __cs_auto_doc AGENTS.md || echo "（提示：当前目录没有剪辑台说明，codex 读不到剪辑规则；cd 回工程目录，或先运行 cutstudio prompt 贴给它）"
  command codex "$@"
}
gemini() {
  __cs_auto_doc GEMINI.md || echo "（提示：当前目录没有剪辑台说明，gemini 读不到剪辑规则；cd 回工程目录，或先运行 cutstudio prompt 贴给它）"
  command gemini "$@"
}

echo ""
echo "剪辑台终端 · 在这里启动 AI 接管剪辑：claude / codex / grok / gemini"
echo "  启动后会自动读到剪辑说明（工程目录的 CLAUDE.md / AGENTS.md / GEMINI.md），直接告诉它要剪成什么样即可"
echo "  cutstudio help     命令列表"
echo ""
`,
    'utf8'
  )
  return dir
}

function shellEnv(): NodeJS.ProcessEnv {
  const bin = cliBinDir()
  return {
    ...process.env,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    PATH: `${bin}:${extraBinPath()}:${process.env.PATH ?? '/usr/bin:/bin'}`,
    CUT_STUDIO_MCP_URL: `http://127.0.0.1:${store.settings.mcpPort || 4877}/mcp`,
    CUT_STUDIO_PROJECT: store.projectPath ?? '',
    ZDOTDIR: zdotDir(),
    LANG: process.env.LANG || 'zh_CN.UTF-8'
  }
}

function send(channel: string, payload: unknown): void {
  sink?.send(channel, payload)
}

async function spawnPty(cols: number, rows: number, cwd: string): Promise<Session> {
  try {
    const ptyMod = await import('node-pty')
    const pty = (ptyMod as { default?: typeof ptyMod }).default ?? ptyMod
    const p = pty.spawn(process.env.SHELL || '/bin/zsh', ['-il'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: shellEnv() as Record<string, string>
    })
    p.onData((data) => send('terminal:data', data))
    p.onExit(({ exitCode }) => {
      send('terminal:exit', exitCode)
      session = null
    })
    return {
      write: (data) => p.write(data),
      resize: (c, r) => p.resize(c, r),
      kill: () => p.kill(),
      foreground: () => p.process
    }
  } catch (err) {
    console.warn('node-pty 不可用，改用 script', err)
    return spawnScript(cols, rows, cwd)
  }
}

function spawnScript(_cols: number, _rows: number, cwd: string): Session {
  const child: ChildProcessWithoutNullStreams = spawn(
    '/usr/bin/script',
    ['-q', '/dev/null', process.env.SHELL || '/bin/zsh', '-il'],
    {
      cwd,
      env: shellEnv(),
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  child.stdout.on('data', (buf: Buffer) => send('terminal:data', buf.toString('utf8')))
  child.stderr.on('data', (buf: Buffer) => send('terminal:data', buf.toString('utf8')))
  child.on('exit', (code) => {
    send('terminal:exit', code ?? 0)
    session = null
  })
  return {
    write: (data) => child.stdin.write(data),
    resize: () => undefined,
    kill: () => child.kill()
  }
}

export async function startTerminal(cols: number, rows: number): Promise<{ ok: boolean; reused: boolean; cwd: string; cli: string }> {
  if (session) return { ok: true, reused: true, cwd: store.projectPath || homedir(), cli: cliBinDir() }
  const cwd = store.projectPath || homedir()
  // 每次开终端都刷新一遍说明文件（剪辑规则改了也能同步）
  if (store.projectPath) {
    try {
      writeAgentDocs(store.projectPath)
    } catch {
      /* 写不了（权限等）就靠 shell 包装函数注入 */
    }
  }
  session = await spawnPty(Math.max(40, cols || 80), Math.max(10, rows || 24), cwd)
  return { ok: true, reused: false, cwd, cli: cliBinDir() }
}

export function writeTerminal(data: string): void {
  session?.write(data)
}

export function resizeTerminal(cols: number, rows: number): void {
  session?.resize(Math.max(20, cols), Math.max(8, rows))
}

export async function restartTerminal(cols: number, rows: number): Promise<{ ok: boolean; cwd: string }> {
  session?.kill()
  session = null
  const cwd = store.projectPath || homedir()
  session = await spawnPty(Math.max(40, cols || 80), Math.max(10, rows || 24), cwd)
  return { ok: true, cwd }
}

function onPath(name: string, env: NodeJS.ProcessEnv): boolean {
  const home = homedir()
  const dirs = [
    ...(env.PATH ?? '').split(':'),
    join(home, '.local/bin'),
    join(home, '.claude/local'),
    join(home, '.npm-global/bin'),
    join(home, '.bun/bin'),
    join(home, '.volta/bin')
  ]
  return dirs.some((d) => d && existsSync(join(d, name)))
}

let agentCache: { at: number; installed: Record<string, boolean> } | null = null

/** 终端状态：是否在跑、前台进程（shell 以外说明 agent 等程序正在运行）、各 agent 是否装了。 */
export function terminalStatus(): { running: boolean; foreground: string | null; busy: boolean; agents: Record<string, boolean> } {
  if (!agentCache || Date.now() - agentCache.at > 30_000) {
    const env = shellEnv()
    agentCache = { at: Date.now(), installed: Object.fromEntries(AGENTS.map((a) => [a, onPath(a, env)])) }
  }
  const raw = session?.foreground?.() ?? null
  const fg = raw ? raw.split('/').pop()! : null
  const shell = (process.env.SHELL || '/bin/zsh').split('/').pop() ?? 'zsh'
  const busy = fg != null && !['zsh', 'bash', 'sh', 'fish', shell, 'login'].includes(fg.replace(/^-/, ''))
  return { running: session != null, foreground: fg, busy, agents: agentCache.installed }
}

export function stopTerminal(): void {
  session?.kill()
  session = null
}
