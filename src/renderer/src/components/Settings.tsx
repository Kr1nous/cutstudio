import { useEffect, useState } from 'react'
import type { AppSettings } from '@shared/types'

export function SettingsModal({
  settings,
  onClose,
  onSave
}: {
  settings: AppSettings
  onClose: () => void
  onSave: (patch: Partial<AppSettings>) => void
}) {
  const [mcp, setMcp] = useState<{ url: string; snippet: unknown } | null>(null)

  useEffect(() => {
    void window.cut.mcpStatus().then(setMcp)
  }, [])

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>MCP / 终端</h2>
        <p style={{ color: 'var(--muted)', marginTop: 0 }}>
          AI 只通过本机 MCP 或底部终端接入。把下面配置放到 Cursor / Claude Desktop 等客户端；或在终端里运行 grok / claude / codex，用 cutstudio 命令改当前工程。
        </p>
        <div className="code">
          {JSON.stringify(mcp?.snippet ?? { mcpServers: { 'cut-studio': { url: mcp?.url ?? 'http://127.0.0.1:4877/mcp' } } }, null, 2)}
        </div>
        <p style={{ color: 'var(--muted)', fontSize: 12 }}>
          终端里先执行 <code>cutstudio prompt</code>，再用 <code>cutstudio help</code> 查看可直接调用的工具。
        </p>
        <h2 style={{ marginTop: 20 }}>语音转写</h2>
        <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input
            type="checkbox"
            checked={settings.allowCloudTranscription === true}
            onChange={(e) => onSave({ allowCloudTranscription: e.target.checked })}
          />
          <span>
            本机没有 whisper.cpp 时，允许把素材音频上传到当前 AI 提供方做云端转写
            <br />
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>默认关闭。优先使用本机 whisper.cpp，音频不离开电脑。</span>
          </span>
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
