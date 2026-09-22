# 剪辑台 (videocut) 1.2.0

macOS 桌面剪辑软件（Tauri 2）。面向已经录制好的影片：人在界面里剪，AI 通过 **终端 CLI** 或 **MCP** 接管同一套工具。字幕走独立字幕轨。界面靠近 iMovie / After Effects 的简洁面板，而不是 Premiere 面板墙。

仓库：https://github.com/Kr1nous/videocut  
安装包：见 [Releases](https://github.com/Kr1nous/videocut/releases) 里的 [`CutStudio_1.2.0_aarch64.dmg`](https://github.com/Kr1nous/videocut/releases/download/v1.2.0/CutStudio_1.2.0_aarch64.dmg)（Apple Silicon）。安装后应用名叫「剪辑台」。

## 运行

本机需要 **Node**、**Rust**（`rustup`）和 Xcode Command Line Tools。Homebrew 装在 `~/homebrew`（无需管理员权限）。

```bash
export PATH="$HOME/homebrew/bin:$HOME/.cargo/bin:$PATH"
cd ~/cut-studio   # 或克隆后的 videocut 目录
npm install --cache ./.npm-cache
npm run dev       # Tauri 桌面窗口
```

打包 `.app` / `.dmg`：

```bash
npm run build
# 产物在 src-tauri/target/release/bundle/macos/
```

首次启动会引导授权「完全磁盘访问」以及影片 / 文稿 / 桌面 / 下载，避免系统隐私设置拦住终端里的 AI。开发时请在系统设置里勾选 **剪辑台**。

## 界面

- **最上方**：效果分类选项卡（剪辑 / 转场 / 文字 / 音频 / 画面 / 滤镜 / 蒙版 / 导出）+ 导入 / 导出 / 终端 / MCP
- **左**：项目媒体库（卡片按真实比例显示；卡片上可删除，右键也可删）
- **中**：预览
- **右**：审查（只显示 AI / MCP / CLI 的改动）
- **预览下**：检查器（音量、速度、滤镜、透明/缩放关键帧、冻结、倒放、蒙版、旋转、删除片段）
- **底部时间线**：
  - 视频轨 + 其下方的图层轨（滤镜/变速/转场写在效果条上；叠加图层、B-roll、纯色层、调整层也在这一层）
  - 较窄的音频轨、字幕轨
  - 可拖轨道高度；播完自动回到开头等待再播

没有顶部 AI 对话框。AI 只走终端或 MCP。

## 人怎么剪

1. 新建或打开 `.cutproj` 项目，导入成片（会分析静音和镜头）。
2. 双击素材上故事线。顶部选项卡点工具直接执行。
3. 选中片段后可用检查器，或点片段上的 × / 右键删除。
4. 空格播放，`S` 分割，焦点不在终端时 Delete / Backspace 删除，`⌘Z` 撤销。

## AI 怎么接入

推荐做法：在工具栏「终端」里直接运行 `claude` / `codex` / `grok` / `gemini`，然后用一句话说要剪成什么样（例如「剪成 60 秒竖屏短视频，去口头禅，加大字幕和背景音乐」）。

- 打开工程时，剪辑台会在工程目录写好 `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` 和 Claude Code 技能，agent 启动就能读到完整的剪辑流程和规则，不需要手动粘贴提示词。
- 内置终端里 `claude` / `grok` 在其他目录启动时，也会通过 `--append-system-prompt` / `--rules` 自动带上剪辑说明。
- agent 通过 `cutstudio` 命令操作当前工程，改动实时出现在时间线上，右侧「审查」能看到并撤销每一步。

| 入口 | 用法 |
|---|---|
| 终端 | 工具栏「终端」，运行 agent，或 `cutstudio help` |
| MCP | `http://127.0.0.1:4877/mcp`，配置在「MCP」按钮里；`initialize` 返回剪辑说明，`prompts/get` 取配方 |

```bash
cutstudio prompt [talking_head|shorts|vlog|interview|product]   # 剪辑说明 / 配方
cutstudio tools [工具名]                                         # 工具说明和参数
cutstudio get-transcript                                          # 可剪辑的文稿
cutstudio cut-sentences --sentence-ids <id,id>                    # 按文稿删句
cutstudio frame --at 3000                                         # 看画面（输出 JPEG）
cutstudio review-timeline                                         # 交付前质检
```

语音转写用本地 whisper.cpp（`brew install whisper-cpp`，模型放在 `~/Library/Application Support/剪辑台/whisper/`）。云端转写默认关闭，可在设置里打开。

## 工具（人点选项卡 = AI 调同名函数）

- 看素材：`get_project` `get_index` `get_transcript` `get_frame` `contact_sheet` `review_timeline` `render_preview`
- 按文稿剪：`detect_retakes` `cut_sentences` `remove_filler` `tighten_pauses` `remove_silence` `correct_transcript` `set_vocabulary` `reanalyze_asset`
- 剪辑手法：`punch_in` `ken_burns` `speed_ramp` `insert_broll` `adjust_broll` `audio_lead`（J/L cut） `snap_cuts_to_beats` `set_speed` `freeze_frame` `reverse_clip` `set_keyframe`
- 转场：`set_transition` `fade_to_black` `fade_from_black`（默认硬切，只在段落切换处用溶解 / 暗场）
- 字幕与包装：`captions_from_transcript` `set_subtitle_style`（clean / boxed / karaoke / keyword） `title_card`（片头 / 章节卡 / 片尾） `set_chapters` `animate_text` `add_text_layer` `add_shape`
- 声音：`normalize_loudness`（按 LUFS） `voice_enhance` `denoise_audio` `set_music`（按响度自动定音量） `duck_music`（人声侧链闪避） `fade_audio`
- 画面：`reframe`（竖屏跟随人物） `auto_enhance` `color_match` `apply_lut` `color_adjust` `set_transform` `crop` `stabilize` `key_color` `add_effect`
- 图层与蒙版：`add_layer` `set_blend` `add_adjustment_layer` `add_solid` `add_mask` `set_mask` `remove_mask`
- 工程：`apply_ops` `undo` `export` `render_queue_add` `make_proxy` `delete_asset` `remove_clip`

预览和导出走同一套 ClipFx 合成（变换、滤镜、特效、LUT、抠像、透明、裁切、翻转、淡化、溶解/淡黑/淡白/推、变速、音量关键帧、跟鼓点）。稳像走 ffmpeg deshake；降噪走 afftdn。导出：H.264、透明 MOV/ProRes、队列、半分辨率代理（预览用代理，成片用原片）。路线图见 `docs/ae-complete-roadmap.md`。

## 模块地图

```
src-tauri/            Tauri 2 窗口、菜单、系统对话框、拉起后端
src/main/sidecar.ts   Node 后端 HTTP + SSE（状态 / 终端 / 媒体）
src/main/core.ts      项目存取、底层 op、删除素材、撤销
src/main/actions.ts   高层工具（UI / MCP / CLI 共用）
src/main/textedit.ts  按文稿剪辑、字幕、质检工具
src/main/craft.ts     剪辑手法（放大、B-roll、J/L cut、变速、推镜、鼓点）
src/main/visual.ts    画幅跟随、自动调色、色调匹配
src/main/titles.ts    标题模板、章节
src/main/analysis/    静音 / 停顿 / 响度 / 节拍 / 镜头 / 转写 / 人物检测
src/main/review/      自动质检
src/main/agentdocs.ts 给终端 agent 写剪辑说明
src/main/eval/        AI 剪辑评测（npm run eval）
src/shared/prompts/   剪辑说明与配方（agent / MCP / CLI 共用）
src/main/ai/          工具注册、看图工具、内置模型循环
src/main/mcp/         MCP HTTP + stdio 代理
src/main/terminal.ts  内置终端，PATH 含 cutstudio
src/main/media.ts     缩略图
src/main/render/      合成图、ffmpeg 导出、单帧采样
src/cli/              cutstudio 命令行
src/renderer/         界面
  lib/cut.ts          前端 API（Tauri + sidecar）
  components/ToolTabs.tsx   顶栏效果分类
  components/Library.tsx    媒体库
  components/Timeline.tsx   视频+效果合成轨
  components/Inspector.tsx  检查器
  components/ReviewPanel.tsx 仅 AI 改动
```

剪辑逻辑在 Node sidecar（`http://127.0.0.1:4878`），窗口是 Tauri。MCP 仍是 `http://127.0.0.1:4877/mcp`。

新增工具：`actions.ts` 的 `ACTION_TOOLS` + `runAction` → 自动进 MCP → `src/cli/cutstudio.mjs` 加子命令 → 需要人点的放进 `ToolTabs.tsx`。

## 工程文件夹

`名字.cutproj/`

- `project.json` 时间线、字幕样式、转写、审查
- `media/` 导入拷贝
- `thumbs/` 缩略图
- `export/` 导出

## 限制

- 无 ffmpeg 时仍可预览，导出不可用（`sudo port install ffmpeg`）。
- 转写目前多用说话段占位；去静音依赖导入后的音频分析。
- macOS「完全磁盘访问」必须在系统设置里手动勾选。

## MCP 配置

```json
{
  "mcpServers": {
    "cut-studio": {
      "url": "http://127.0.0.1:4877/mcp"
    }
  }
}
```

## Contributors

- [Kr1nous](https://github.com/Kr1nous)
- [Grok](https://x.ai) (xAI)
