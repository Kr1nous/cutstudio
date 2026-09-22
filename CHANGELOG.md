# 更新日志

## 1.2.0（2026-09-22）

这一版的重点是 **让终端里的 AI agent 剪得好**：AI 能听懂内容、看到画面，按剪辑规则下刀，剪完自己检查。

### 终端里的 AI 剪辑
- 打开工程时自动在工程目录写 `CLAUDE.md` / `AGENTS.md` / `GEMINI.md` 和 Claude Code 技能，`claude` / `codex` / `grok` / `gemini` 启动就能读到完整剪辑说明；内置终端里的 `claude` / `grok` 在别的目录启动时也会自动注入。
- 重写剪辑提示词：统一的剪辑流程（看素材 → 粗剪 → 精剪 → 字幕 → 声音 → 画面 → 包装 → 质检）、剪辑规则（跳剪硬切、开头 3 秒、字幕行宽、音乐不盖人声）和 5 个配方（口播、竖屏短视频、Vlog、访谈、产品介绍）。终端、MCP、内置 AI 共用同一份。
- 工具要求明确目标：不再悄悄改第一个片段；每个工具都返回 warnings；删除类工具返回删了什么；新建类工具返回新 id；`undo` 会说明撤掉了哪一步。
- CLI：任何工具都能当命令用，支持参数简写；`cutstudio tools <工具名>` 显示参数；遇到不认识的参数会报错。
- MCP：`initialize` 返回剪辑说明，`prompts/get` 返回配方，工具出错时能看到原因，看图工具返回图片。

### 听懂内容
- 本地 whisper.cpp 转写（逐词时间），导入后在后台自动完成；云端转写默认关闭。
- 用能量分析重新对齐转写的逐词时间，修正 whisper 零长度词和停顿对不上的问题；旧工程打开时自动重新对齐。
- 过滤 whisper 在音乐 / 静音上编出来的句子（如「Thank you.」）。
- 错别字提示：`get_transcript` 标出识别置信度低的词；`correct_transcript` 改错字，字幕自动更新；`set_vocabulary` 设置工程热词。
- 静音检测精度从每段约 2.5 秒提高到 10ms，阈值随素材噪底自适应；新增细粒度停顿、镜头切点、EBU R128 响度、节拍分析。

### 按文稿剪辑
- `get_transcript`（带句子和分句 id、可听比例）、`cut_sentences`、`detect_retakes`（整句重说和说到一半重来）、`remove_filler`（逐词）、`tighten_pauses`（只删安静的部分）。
- 剪辑后字幕自动重建。

### 剪辑手法
- `punch_in` 跳剪放大、`ken_burns` 缓推 / 平移、`speed_ramp` 变速曲线、`audio_lead` J/L cut、`snap_cuts_to_beats` 切点对齐节拍。
- `insert_broll` 按台词插 B-roll（默认盖满整句，也可只盖逗号分句）、`adjust_broll` 调整位置和长度；插入前可以用 `contact_sheet --asset-id` 预览素材。
- 转场默认硬切，禁止给跳剪加溶解。

### 字幕与包装
- 字幕按标点和停顿断句，时间跟着说话走；中文标点转全角；按字号严格控制每行字数，超宽时导出自动折行。
- 字幕样式：clean / boxed / karaoke（逐词高亮） / keyword（关键词高亮）。
- `title_card` 片头 / 章节卡 / 片尾模板（minimal / bold / box）；`set_chapters` 标章节，并生成可贴进视频简介的章节列表。
- 竖屏下字幕和文字不再偏小。

### 声音
- `normalize_loudness` 按实测 LUFS 统一响度；导出母线加 −1 dBTP 限幅。
- 音乐闪避改成人声侧链：只在有人说话时压低音乐。
- `set_music` 按响度自动定音量，自动裁到成片长度并淡出。
- `voice_enhance` 人声增强（podcast / clear / warm）。
- 预览里 J/L cut 的对白和背景音乐可以同时播放。

### 画面
- `reframe` 横屏转竖屏时铺满画面并跟随人物（macOS Vision 人脸 / 人体检测）。
- `auto_enhance` 按实测亮度、饱和度、冷暖自动校正；`color_match` 统一多机位 / B-roll 色调。
- 冷暖（warmth）改为真正的色温，预览和导出一致。
- `get_frame` / `contact_sheet` 让 AI 看画面，可叠加字幕；`render_preview` 渲染一小段低清预览。

### 质检
- `review_timeline` 检查时间线空洞、碎片、跳剪误加溶解、转场过长、黑边、字幕重叠 / 超宽 / 过短、文字层挡字幕、B-roll 重叠 / 盖进下一句 / 色调不一致、音乐过响或听不见、削波风险、开头 3 秒没有人声。

### 修复
- 取单帧时大部分时刻渲染成黑帧（影响预览）。
- 本机 ffmpeg 没有 libass 时带字幕导出失败：改为写入软字幕轨，另存 .srt。
- 字幕生成工具没有出现在 AI 的工具列表里。
- Anthropic 多轮工具调用第二步报错。
- `add_title` / `lower_third` 覆盖全局字幕样式。
- 自动排故事线时把 B-roll 和音乐也排了进去。

### 开发
- `npm run eval`：用合成口播素材给 AI 剪辑打分（口播、竖屏短视频、产品介绍，普通 / 困难素材），支持外部 agent 的 `--prepare` / `--score`。
- `npm run verify:compose` 增加分析、按文稿剪辑、字幕、质检、B-roll、新工具的单测。
- 进度与模块说明见 `docs/ai-quality-progress.md`。
