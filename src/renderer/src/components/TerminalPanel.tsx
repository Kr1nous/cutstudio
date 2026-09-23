import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

function xtermTheme(dark: boolean) {
  return dark
    ? {
        background: '#1c1c1e',
        foreground: '#f5f5f7',
        cursor: '#8181ff',
        selectionBackground: '#5b5bd655'
      }
    : {
        background: '#f6f7f9',
        foreground: '#1d1d1f',
        cursor: '#5b5bd6',
        selectionBackground: '#5b5bd633'
      }
}

const AGENTS = ['claude', 'codex', 'grok', 'gemini'] as const

type Status = { running: boolean; foreground: string | null; busy: boolean; agents: Record<string, boolean> }

/** 往终端里输入一条命令：先清掉当前行，cd 回工程目录再启动。 */
export function launchAgent(agent: string, projectPath: string | null): void {
  const cd = projectPath ? `cd '${projectPath.replace(/'/g, `'\\''`)}' && ` : ''
  window.cut.terminalWrite(`\x15${cd}${agent}\r`)
}

export function TerminalPanel({ dark, projectPath, onClose }: { dark: boolean; projectPath: string | null; onClose: () => void }) {
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      fontSize: 12,
      cursorBlink: true,
      theme: xtermTheme(dark),
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const offData = window.cut.onTerminalData((data) => term.write(data))
    const offExit = window.cut.onTerminalExit((code) => {
      term.write(`\r\n[shell 已退出 ${code}] 点「重启」再开一局\r\n`)
    })

    const start = () => {
      const dims = fit.proposeDimensions()
      void window.cut.terminalStart(dims?.cols ?? 80, dims?.rows ?? 24)
    }
    start()

    const onData = term.onData((data) => window.cut.terminalWrite(data))
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
        window.cut.terminalResize(term.cols, term.rows)
      } catch {
        /* layout not ready */
      }
    })
    ro.observe(host)

    return () => {
      offData()
      offExit()
      onData.dispose()
      ro.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(dark)
  }, [dark])

  // 前台是不是已经在跑 agent / 各 agent 是否安装：决定启动按钮能不能点
  useEffect(() => {
    let alive = true
    const poll = () =>
      void window.cut
        .terminalStatus()
        .then((s) => alive && setStatus(s))
        .catch(() => undefined)
    poll()
    const t = window.setInterval(poll, 2500)
    return () => {
      alive = false
      window.clearInterval(t)
    }
  }, [])

  return (
    <div className="term-wrap">
      <div className="term-h">
        <span className="term-title">
          终端
          {status?.busy && status.foreground ? <em>· 正在运行 {status.foreground}</em> : <em>· 启动 AI 接管剪辑</em>}
        </span>
        <span className="term-agents">
          {AGENTS.map((a) => {
            const installed = status ? status.agents[a] !== false : true
            return (
              <button
                key={a}
                type="button"
                className="agent-btn"
                disabled={!installed || Boolean(status?.busy)}
                title={!installed ? `没找到 ${a} 命令，先安装它` : status?.busy ? '终端里已有程序在运行' : `在工程目录启动 ${a}（自动读到剪辑说明）`}
                onClick={() => {
                  launchAgent(a, projectPath)
                  termRef.current?.focus()
                  window.setTimeout(() => void window.cut.terminalStatus().then(setStatus).catch(() => undefined), 800)
                }}
              >
                {a}
              </button>
            )
          })}
        </span>
        <span className="term-actions">
          <button
            className="btn ghost small"
            onClick={() => {
              const term = termRef.current
              const fit = fitRef.current
              if (!term || !fit) return
              fit.fit()
              void window.cut.terminalRestart(term.cols, term.rows)
            }}
          >
            重启
          </button>
          <button className="btn ghost small" onClick={onClose}>
            收起
          </button>
        </span>
      </div>
      <div className="term-host" ref={hostRef} />
    </div>
  )
}
