# AI 剪辑质量改进进度

## 终端会话（cut-studio-63）

负责：感知层（素材分析 / 转写）、文字驱动剪辑与字幕的纯逻辑、字幕样式渲染、时间线质检、画面分析。工具 / CLI / 提示词接入由 cut-studio-14 负责。

验证状态（收尾时）：`npm run verify:compose` 通过；`npx tsc --noEmit -p tsconfig.node.json` 仅剩 9 个基线错误（verify.ts 的 `string | null`、terminal.ts、shared/audio.ts 的 EaseKind、vite.config）；`npm run eval -- --driver scripted` 得分 100（应删未删 0、误删 0、质检 0 错 0 警）。

### 已完成模块

#### 1. 素材分析（阶段 1）

- `src/main/analysis/audio.ts`
  - `readAudioFrames(ffmpeg, path)` → `{rms, hf, lufs?, truePeak?, lra?}`：一次 ffmpeg 流式解码，10ms 帧能量 + ebur128 响度。
  - `segmentSpeech(rms, durationMs, {minSilenceMs=150, minSpeechMs=60})`：按素材噪底自适应 dBFS 阈值、带迟滞的静音/语音分段。
  - `detectBeats(rms, hf)` → `{beats, bpm?}`：onset 检测 + 自相关估 BPM。
  - `parseEbur128(stderr)`、`toDb`、`FRAME_MS`。
- `src/main/analysis/scenes.ts`：`detectScenes(ffmpeg, path, durationMs, threshold=0.3)`（160px、长素材降帧率）、`parseShowinfoTime`、`cleanScenes`。
- `src/main/render/wave.ts`：`analyzeMediaFile(path, durationMs, {scenes?})`（签名兼容）、`analyzeAudioFile`、`readWaveform`（仍为 240 桶 UI 波形）、`ANALYSIS_VERSION = 2`。
- `src/main/analysis/transcribe.ts`：`transcribeFile(path, {settings, durationMs, assetId?})` → `{cues, language?, engine} | null`（不抛错）；`transcriberAvailable(settings)`；`findWhisper` / `findWhisperBin` / `findWhisperModel`；纯函数 `parseWhisperJson`、`tokensToWords`、`cuesFromVerboseJson`。优先本地 whisper.cpp（`-ojf` 词级时间戳，按字节拼接半个 UTF-8 的 token），否则仅在 `allowMediaUpload` 为真且当前提供方为 openai-compatible 时走 `/audio/transcriptions`（10 分钟分块）。
- `src/main/analysis/background.ts`：`queueAssetAnalysis(store, assetIds)` 串行后台队列：旧索引升级 → 镜头检测 → 转写，每步 save + broadcast。`core.ts importFiles`（≤2 分钟素材同步做镜头检测）和 `media.ts probeAssetFile` 会入队。
- `src/shared/types.ts`（只追加可选字段）：
  - `AssetIndex`：`version`、`scenesDetected`、`beats`、`bpm`、`lufs`、`truePeak`、`lra`、`noiseFloorDb`、`speechLevelDb`、`analysis: 'pending'|'done'|'error'`、`transcription: 'pending'|'done'|'unavailable'|'no_speech'|'error'`。
  - `TranscriptCue`：`assetId`、`words`（素材源时间）。
  - `SubtitleCue.words`（时间线时间）。
  - `SubtitleStyle`：`preset: 'clean'|'boxed'|'karaoke'|'keyword'`、`highlightColor`、`boxColor`、`boxOpacity`、`keywords`。
- `src/shared/audio.ts`：`onsetTimes(peaks, durationMs, thresh, beats?)`，有 beats 时优先使用。
- `src/shared/compose.ts`（末尾追加）：`timelineTimeMs(clip, sourceMs)`、`sourceRangeToTimeline(clip, startMs, endMs)`。

#### 2. 文字驱动剪辑与字幕（阶段 2）

- `src/shared/transcript.ts`（辅助）：`assetWords`、`splitSentences`（句子 id = `${assetId}#${n}`）、`timelineWords`、`mapWord`、`speechClips`、`textUnits`、`joinWords`、`stripTrailingPunct`、`normalizeForMatch`。
- `src/shared/captions.ts`：`buildCaptions(project, {maxChars, maxLines?, minMs?=700, maxMs?=4500, pauseMs?=250, source?, makeId?})`。断点优先级：句末 > 逗号类 / cue 结尾 > 停顿 / 剪辑点；离断点只差几个字时允许超出 25%，避免孤字；行尾去掉逗号和句号；每条字幕带 `words`。
- `src/shared/textcut.ts`（用到 `ids.ts` → node:crypto，只能在 main 进程用）：
  - `transcriptDoc(project)` → `{sentences: DocSentence[]}`
  - `planCutSentences(project, ids, padMs=60)` → `CutsByAsset`
  - `applySourceCuts(storyline, cuts, minKeepMs=80)`：不修改输入，已 pack。
  - `detectRetakes(project, threshold=0.6)`、`textSimilarity`
  - `fillerWordRanges(project, words?, minPauseMs=120)`、`DEFAULT_FILLERS`
  - `tightenPauses(project, maxPauseMs)`：按时间线上相邻的已听到词计算，跨剪辑点也算；第一个词之前、最后一个词之后的静音压到 ≤ max/2。
- `src/shared/subtitle.ts`：`subtitlePreset`、`keywordRuns`、`karaokeLines`、`assAlpha`，以及默认高亮色 / 底框色 / 底框不透明度常量。
- `src/main/render/graph.ts`：`writeAss` 内部改为调用 `assDocument(project, w, h)`。boxed 用 BorderStyle 3；karaoke 用 `\kf` / `\k`；keyword 用 `\c&H..&\fscx115`。音频混音段未动。
- `src/renderer/src/components/Viewer.tsx`：字幕预览支持多行、boxed、keyword、karaoke（按词高亮，不做平滑填充）。

#### 3. 时间线质检

- `src/main/review/check.ts`：`reviewTimeline(project, {maxChars?})` → `ReviewIssue[]`（按 error / warn / info 排序）。code 包括 storyline_gap、subtitle_overlap、fragment、dissolve_on_jump_cut、transition_too_long、transition_on_last、subtitle_too_long / too_short / after_end、text_covers_subtitle、music_too_loud、duck_off、clipping_risk（cut-studio-14 已把阈值改为预估峰值 > +3 dBTP）、overlay_past_end、slow_open、audio_past_end。

#### 4. 画面分析

- `src/main/analysis/subject.ts`：`detectSubjects(path, {intervalMs?=500, startMs?, endMs?})` → `SubjectSample[] | null`；`ensureSubjectTool`；`subjectBuildError`。Swift 源码内嵌在 TS 中，首次调用时用 `xcrun swiftc` 编译到 `userDataDir()/bin/cs-subject-<hash>`（AVAssetImageGenerator + Vision 人脸 / 人体检测）。
- `src/shared/reframe.ts`：`reframeTrack(samples, srcW, srcH, dstAspect, {smoothMs=800, deadZone=0.08, zoom, cuts, anchorX})` → `{t(源时间 ms), posX, posY, scale}[]`；另有 `coverScale`、`containFraction`、`posForSubject`、`pickSubjects`。posX/scale 的语义与 `mask.ts layerBox` 一致，保证不露黑边；切点处直接跳。
- `src/main/analysis/look.ts`：`measureLook(path, atMs[])` → `LookStats | null`。
- `src/shared/look.ts`：`enhanceFromLook(look)`、`matchLook(ref, target)` → `{exposure, contrast, saturation, warmth}`（各项 −0.3…0.3）、`LookAccumulator`。

#### 单测（src/main/render/verify.ts）

`analysisUnitTests`、`textcutUnitTests`（含“两个口头禅中间有正文”“片头碎片”用例）、`reviewUnitTests`、`visualUnitTests`、`analysisFfmpegTests`（用 ffmpeg 生成带停顿的测试音和带切点的视频）。

### 已知限制

- **转写本机不可用**：没有装 whisper.cpp 和模型，真实素材的 transcription 状态为 `unavailable`，文字剪辑工具都用不了。本地 whisper 路径只验证了 JSON 解析，没有真跑过。
- **云端转写默认会上传**：`allowMediaUpload` 默认为 true，配了 openai-compatible key 就会在导入后自动上传音频。要不要改成单独开关，待用户决定。
- **人脸 / 人体检测准确度未验证**：本机没有含真人的素材，只确认了编译和运行流程能通（无人画面返回 []）。
- **本机 ffmpeg 没有 libass**：无法渲染验证 ASS 输出（cut-studio-14 已加兜底：mov_text 软字幕 + .srt）。
- **warmth 渲染不准**：`shared/fx.ts` 的 warmth 实际是色相旋转（`hue=h` / CSS `hue-rotate`），不是色温，`matchLook` / `enhanceFromLook` 的 warmth 只有方向是对的。
- `applySourceCuts` 不会重映射片段内相对 t 的关键帧（fx.keys）。
- `detectRetakes` 在“前句后半截 = 后句开头”时会 drop 整个前句（包括前半截），需要 AI 复核。
- `reframeTrack` 不考虑 crop / rotate；t 为源时间，需要调用方换算成片段内的 0–1。
- 删句后两侧停顿会连在一起，需要配合 `tightenPauses`。

### 未做 / 下一步建议

1. **warmth 渲染（未开始）**：把 `shared/fx.ts` 的 ffmpeg warmth 改成 `colortemperature` 或 `colorbalance`（中间调 / 高光的 rs、bs），CSS 预览改成视觉上接近的组合，并同步 `look.ts` 的 WARMTH_GAIN 换算；`actions.ts clipCssFilter` 里的 hue-rotate 需要由 cut-studio-14 同步修改。
2. **Apple Speech 转写可行性（未开始）**：评估 `SFSpeechRecognizer`（`requiresOnDeviceRecognition = true`，避免上传）或 macOS 26 的 `SpeechAnalyzer` / `SpeechTranscriber`，沿用 subject.ts 的 swiftc 方式。要注意：命令行二进制需要内嵌带 NSSpeechRecognitionUsageDescription 的 Info.plist（`-sectcreate __TEXT __info_plist`），TCC 授权可能算到父进程（应用 / 终端）头上，并且会弹系统授权框，所以先不要接进导入流程。
3. 用真人素材实测 `detectSubjects` + `reframeTrack`，按实际效果调 deadZone、smoothMs。
4. 装好 whisper.cpp 后用真实口播素材跑 eval（不只用 synthetic 转写），检查词级时间戳精度对 `planCutSentences` 吸附的影响。

### 续：接手的终端会话（2026-09-17）

分工沿用上一节：本会话负责分析、渲染和纯逻辑模块；工具、CLI、提示词和评测由主会话（「视频剪辑软件优化计划」）负责。

**收尾时的验证状态**：`npm run verify:compose` 通过；node tsc 9 / web tsc 2（都是基线）。`npm run eval -- --driver scripted --scenario all --fixture all`：real 和 synthetic 下，talking_head basic/hard、product 都是 100；shorts 有 3 个组合是 97（real hard、synthetic basic、synthetic hard），real basic 是 100。扣的 3 分全部来自本轮新增的 subtitle_overflow 检查，原因见“未做 / 下一步”第 1 条。

#### 本会话的改动（导出签名要点）

1. **warmth 渲染**（`shared/fx.ts`、`shared/look.ts`）
   - ffmpeg 改用 `colortemperature=temperature=K:pl=1`；`warmthKelvin(w) = 6600 − w×3333`（6600K 为中性点，这时 ffmpeg 的三路增益全是 1）。
   - `warmthGains(w) → {r,g,b,lightness}` 照搬 vf_colortemperature 的公式；`applyWarmthCanvas(ctx,w,h,fx)` 在预览里 multiply 增益色，并用 destination-in 保留透明区域；`colorCss` 里 warmth 只输出亮度补偿。Viewer 的三处绘制都调用了它。
   - `look.ts` WARMTH_GAIN = 4.7（灰卡标定：ΔR−B ≈ 0.21×w）。单测 `warmthFfmpegTests`。
   - 限制：饱和画面响应偏小（testsrc2 约 0.06×w），自动调色只会偏保守。
2. **词时间对齐**（`shared/wordalign.ts`）
   - `refineWordTimings(cues, speech, pauses?)`：按标点切短语，单调 DP 对齐到能量语音段；硬停顿把语音段切细；段间停顿的吸附范围 50%，valley 25%。
   - `TRANSCRIPT_ALIGN_VERSION = 3`，写入 `TranscriptCue.alignVersion`。
   - 限制：没有停顿隔开的句中口头禅只能按字数比例切。
3. **精细停顿与底噪**（`analysis/audio.ts`、`render/wave.ts`、`types.ts`）
   - `detectPauses(rms, speech) → PauseRange[]`（`{startMs, endMs, depthDb, valley?}`），写入 `index.pauses`。
   - `segmentSpeech` 的噪底估计排除数字静音（< −90dB）。ANALYSIS_VERSION = 3。
   - 单测 `noiseRobustnessTests`（粉噪 −45dBFS + say，80/150/300ms 停顿，另测片头数字静音）。
4. **分句与句内重录**（`shared/textcut.ts`）
   - `sentenceClauses(s, project?, heard?)`：标点和 cueEnd 处总是断；≥150ms 的硬停顿处只有两侧都 ≥4 字才断；只断在词（whisper token）之间。
   - `resolveSpans(project, ids)`；分句 id 为 `${sentenceId}.${k}`，`planCutSentences` 同时支持句子和分句 id。
   - `detectRetakes → RetakeGroup{keep, drop, similarity, kind:'sentence'|'clause', keepText, dropText}`，分句规则：前缀相同或 Dice > 0.7，并且前 3 个字一致。
5. **幻听过滤**（`shared/wordalign.ts`、`analysis/background.ts`）
   - `filterHallucinations(cues, speech)` 丢弃三类 cue：和语音段重叠 < 30%；时长 ≥3s 且 < 0.6 字/秒；已知幻听短语且重叠 < 60%。
   - 发声总时长 < 1s 或 speechLevelDb < −50 时不转写。
   - 限制：只有单测，没在 music.m4a 上跑过完整导入流程。
6. **重新对齐 / reanalyzeAsset**（`analysis/background.ts`、`core.ts`）
   - `alignVersion` 过旧的转写会在后台用现有索引重新对齐（不重跑 whisper）；`openProject` 末尾会把素材排进分析队列。
   - `reanalyzeAsset(store, assetId, {retranscribe?}) → Promise<{assetId, analysis, transcription, cues}>`。
   - 限制：重新对齐不会重建已有字幕，也不会移动已经下的刀。
7. **可听比例**（`textcut.ts`）
   - `DocSentence.audible / keptText`；`TextSpan.audible / inTimeline / keptText`（传 project 时才有）。
   - `heardWords(project)`、`spanAudibility(words, heard)`。
8. **字幕标点与严格行宽**（`shared/captions.ts`）
   - `subtitlePunct(text)`：中文语境下半角 , ; : ? ! 转全角。
   - maxChars 严格执行；为了不出孤字，带到下一条的字数加上到下一个强断点前剩余的字要 ≥3。
9. **letterbox 检查**（`review/check.ts`）
   - `code: 'letterbox'`：采样首尾和缩放 / 位置关键帧，考虑 crop 和 90/270 旋转；有缩放关键帧时按导出语义，动画 scale 同时覆盖两个轴。叠加层 scale<1 或带蒙版时跳过。单测 `letterboxUnitTests`。
10. **抽帧叠加字幕**（`render/frame.ts`、`render/textpng.ts`）
    - `renderFrame(project, t, preset, {subtitles?})`；`bakeSubtitleFrame(project, w, h, t, dest) → boolean`，用 PIL 绘制 clean / boxed / keyword / karaoke，参数和 assDocument 对应。
11. **字幕 / 文字超宽**（`shared/subtitle.ts`、`review/check.ts`、`graph.ts`、`textpng.ts`、`Viewer.tsx`）
    - 字宽估算按 PIL 实测的 Hiragino 字宽：中文和全角标点 1em，小写 0.56，大写 0.71，数字 0.66，半角标点 / 空格 0.32。
    - 导出：`charWidthEm`、`estimateTextWidthEm/Px`、`subtitleFontPx`、`subtitleAvailablePx`（左右各留 5%，boxed 再减内边距）、`subtitleLineWidthPx`（keyword 命中词 ×1.15）、`maxCharsForStyle(style, w, h)`、`wrapLineByWidth(line, maxPx, widthOf)`、`wrapSubtitleText(text, style, w, h)`。
    - 折行规则：优先在标点处断，不拆拉丁单词，放不下时退回到最后一个合法断点。导出的 ASS、抽帧、应用内预览都先经过 `wrapSubtitleText`。
    - 质检新增 `subtitle_overflow` 和 `text_overflow`（warn），message 里给出建议的 fontSize 或 maxChars。单测 `overflowUnitTests`。

#### 已知限制（汇总）

- whisper 在底噪下会有错别字（例如「停顿衣裳就会化走」「大字母」），字幕会带上这些错字。
- 字宽是估算值，实际字体不同（比如装了别的字体）时可能有几个百分点的误差；左右 5% 边距留了余量。
- karaoke 折行时，如果一个词正好跨行，高亮可能错位。现在的词基本是 1–2 个字，影响不大。
- 人物检测（reframe）没有用真人素材验证过。

#### 未做 / 下一步

1. **shorts 场景 97 分（本轮遗留）**：shorts 配方写的是 `captions_from_transcript maxChars 14` 配 `set_subtitle_style fontSize 72`，但 72 号字竖屏一行只放得下 13 个字（`maxCharsForStyle` = 13），新的 subtitle_overflow 检查因此报警。修法（归主会话）：在 textedit.ts 里把 `maxCharsForStyle` 接进 captions_from_transcript 的默认值；配方改成 maxChars 13，或者先设字幕样式再生成字幕；set_subtitle_style 改字号后提示重跑 captions。评测 scripted 的顺序（先生成字幕再改字号）也要一起调整。
2. **第二次 CLI 试剪（product 场景、B-roll 插入）还没做**：工程在 `scratchpad/eval/projects/eval-agent-1789621799866.cutproj`，用户指令见主会话记录。
3. 用真人素材验证词对齐、句中口头禅、reframe 和人物检测。
4. whisper 错别字：考虑 `--prompt` 或热词。
5. 幻听过滤在真实音乐素材上端到端验证一遍。

## 主会话（cut-studio-14）

负责：提示词体系、工具接入与工具语义、MCP / CLI、Anthropic 通道、音频混音与导出兜底、评测框架。计划见 `~/.claude/plans/macos-tauri-2-ai-shimmying-donut.md`。所有改动都在 `ai-quality` 分支上，未提交。

验证状态：`npm run verify:compose` 通过；node tsc 9 个基线错误（web tsc 2 个，也是原有的）；`npm run eval -- --driver scripted` 得分 100，`--driver none` 得分 22。另用隔离的 sidecar（`CUT_STUDIO_USER_DATA=<临时目录> CUT_STUDIO_API_PORT=4988 npx tsx src/main/sidecar.ts`）通过 CLI 和 MCP 实测了下面的工具。

### 已完成

#### 提示词（单一来源）
- `src/shared/prompts/index.ts`：`CORE`（硬约束）、`WORKFLOW`（看 → 定方案 → 粗剪 → 精剪 → 字幕 → 声音 → 画面 → 包装 → review_timeline 检查）、`GRAMMAR`（默认硬切，跳剪禁止溶解；节奏、字幕、声音的规则）、`RECIPES`（talking_head / shorts / vlog / interview / product）、`fullPrompt()`、`mcpInstructions()`、`recipeText()`。
- 使用方：`ai/agent.ts` 的 SYSTEM、MCP `initialize.instructions` 和 `prompts/list|get`（editing_guide + 5 个配方）、`cutstudio prompt [配方] [--goal]`、`cutstudio install-skill`（生成 Claude Code 用的 SKILL.md）。

#### 接入层
- `ai/providers.ts`：修复 Anthropic 通道（assistant 消息保留 tool_use，连续的 tool_result 合并成一条 user 消息），max_tokens 改为 16000；修正 openai v5 tool_calls 的类型。
- `ai/agent.ts`：步数上限从 8 改为 40；视觉工具返回的图片不塞进内置 agent 的上下文。
- `mcp/protocol.ts`：`instructions`、`prompts/get`；工具出错时返回 `isError: true`（模型能看到原因）；视觉结果返回 image content。
- `ai/tools.ts`：`ALL_TOOLS` = EDITOR + VISION + TEXT + CRAFT + VISUAL + ACTION。`HIDDEN_FROM_AI` 里的别名 / 旧工具不对 AI 显示（keep_speech、jump_cut、slow_motion、add_title、lower_third、zoom_in、audio_preset、keep_head_tail、mute_clip、overlay_broll），但仍可按名字调用。
- `cli/cutstudio.mjs`：`prompt` 从 MCP 拉取；新增 `index` / `frame` / `contact-sheet` / `call` / `tools` / `skill` / `install-skill`；未知命令自动映射成工具（连字符 → 下划线，`--kebab-flag` → camelCase 参数，按 schema 转换类型）；支持 `--clip all` / `--clips a,b`；出错时处理 `isError`。
- `core.ts`：`store.batch(label, fn)`（多次改动合并为一次撤销、一条审查记录、一个快照）；`compactForAi` 只输出非默认的 fx（`fxDiff`），并加上 `analyzed` / `transcriptReady`；`add_audio` op 支持 `inMs/outMs/fx/role`。

#### 工具语义修复（`actions.ts`）
- `clipIdArg`：AI / MCP 调用必须给 clipId，否则报错并列出可选片段（human 调用仍回退到第一段）；`BATCH_TOOLS` 支持 `clipId:"all"` / `clipIds`，整批只算一次撤销。
- `set_transition`：必须给 clipId / clipIds；AI 传 `"all"` 时只允许 type=none；对跳剪、最后一段、片段过短给出 warnings。
- `add_title` / `lower_third` → `animate_text` 文字层（不再覆盖全局字幕样式）。
- `normalize_loudness`：按 `index.lufs` 计算增益（目标默认 -16），峰值上限 +3 dBTP（剩下的交给导出限幅器）。
- `fit_duration`：最多加速 1.15x，仍超长时提示删内容。
- `set_music`：裁到故事线长度、默认结尾淡出 1.5s、`role: 'music'`，保留 dialog 音频；修复了原来先改数据再 pushUndo 导致撤销无效的问题。
- `ensureStoryline`：只把有人声的视频排上故事线（不再把 B-roll 和音乐放进去）。
- `remove_silence` 返回碎片警告，并自动重建字幕；`get_index` 展示 speech / scenes / lufs / beats / analysis / transcription 状态和建议。
- `ActionResult.warnings?: string[]`（types.ts）。

#### 新工具
- `ai/vision.ts`：`get_frame`、`contact_sheet`（MCP 返回图片，CLI 写 JPEG 文件）。
- `textedit.ts`：`get_transcript`、`cut_sentences`、`detect_retakes`（先预览再 apply）、`remove_filler`、`tighten_pauses`、`captions_from_transcript`、`review_timeline`；`rebuildCaptionsIfAny` 在故事线变化后自动重建字幕。
- `craft.ts`：`punch_in`（自动找同素材的跳剪，隔一段放大一段）、`insert_broll`（atMs 或 atText 按台词定位）、`audio_lead`（J/L cut，对白音频 `role: 'dialog'`）。
- `visual.ts`：`reframe`（Vision 人物跟随，写 posX/posY 关键帧；检测不到人时居中铺满）、`auto_enhance`（measureLook → enhanceFromLook）、`color_match`。
- `set_subtitle_style`：新增 preset / highlightColor / boxColor / boxOpacity / keywords。

#### 渲染与导出
- `render/frame.ts`：footage 加 `setpts=PTS-STARTPTS`，修复大部分时刻渲染成黑帧的旧 bug（预览接口也受影响）。
- `render/graph.ts` 混音：音乐闪避从整首压低改成人声侧链 `sidechaincompress`（实测只在有人声时压低）；dialog 音频进人声总线；母线 `alimiter` 限幅到 -1 dBTP。
- `render/export.ts` + `render/ffmpeg.ts`：`ffmpegHasFilter`；没有 libass 时改为 mov_text 软字幕轨 + 同名 .srt，并通过 `lastRenderWarnings` 返回给 export 工具。
- `shared/text.ts textScale(w,h) = min(w,h)/1080`：字幕和文字层的字号换算（原来是 宽/1920，竖屏字只有 56%）。graph / textpng / Viewer 已统一。
- `review/check.ts` clipping_risk 阈值改为 +3 dBTP（配合限幅器）。

#### 评测（阶段 4）
- `src/main/eval/fixture.ts`：用 `say` 合成带口头禅 / 重录 / 长停顿的中文口播，外加 B-roll、音乐和句子真值；`syntheticTranscript`。
- `src/main/eval/score.ts`：`scoreProject` 检查应删未删、误删、停顿、字幕覆盖、质检问题、过度加速。
- `src/main/eval/run.ts`：`npm run eval -- [--driver none|scripted|agent|all] [--prompt] [--provider] [--model] [--dir] [--verbose]`；agent 需要 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `XAI_API_KEY`；结果写入 `eval-results/`（已加进 .gitignore）。

### 已知限制
- **还没用真实 LLM 跑过评测**（没有 API Key），提示词对真实模型的效果未量化。
- 预览（Viewer）同一时刻只播一条音频轨片段：J/L cut 的对白和音乐重叠时，预览听不到对白，导出正常。预览里的闪避仍是固定比例。
- `actions.ts clipCssFilter` 的 warmth 仍是 hue-rotate（等 warmth 渲染整体改造时一起改）。
- `reframe` 和人物检测没有用真人素材验证；检测耗时约为素材时长 / 500ms 次取帧。
- `audio_lead` 按原速计算，变速 / 倒放片段会给警告但不做修正。
- Anthropic 默认模型仍是 settings 里的 `claude-sonnet-4-5`，没改默认值。

### 下一步建议
1. 用真实 API Key 跑 `npm run eval -- --driver agent --verbose`，看模型是否按 WORKFLOW 调用工具，再迭代提示词和工具描述。
2. 装 whisper.cpp 后用真人口播素材跑一遍完整流程（转写 → 文字剪辑 → reframe → 导出）。
3. warmth 渲染改造（见终端会话一节第 1 条），完成后同步 `clipCssFilter`。
4. 预览多音轨混音（J/L cut 对白 + 音乐），以及预览里的侧链闪避近似。
5. 云端转写开关、allowMediaUpload 默认值，待用户决定。

### 续：2026-09-17（主会话「视频剪辑软件优化计划」，与终端会话 cut-studio-aa 协作）

验证状态（本轮收尾）：`npm run verify:compose` 通过；node tsc 9 / web tsc 2（均为原有错误）；`npm run eval -- --driver scripted --scenario all --fixture all` 在真实 whisper 转写和 `--asr synthetic` 下，5 个组合（talking_head basic/hard、shorts basic/hard、product）全部 100 分。

#### 环境与用户决定
- whisper.cpp 1.9.4 用 Homebrew 装好（`~/homebrew/bin/whisper-cli`）。模型 `~/Library/Application Support/剪辑台/whisper/ggml-large-v3-turbo-q5_0.bin`（574MB），30 秒中文转写约 23 秒。
- 云端转写默认关闭：`AppSettings.allowCloudTranscription`（默认 false，`transcribe.ts cloudAllowed()` 要求它和 allowMediaUpload 同时为真）。设置面板加了开关；`App.tsx` 里 SettingsModal 的 onSave 原来是空函数，已接到 `window.cut.updateSettings`。
- 用户要求不提交改动：所有改动仍在 `ai-quality` 分支、未提交。

#### 评测
- `eval/run.ts`：有 whisper 模型时默认用真实转写（`--asr synthetic` 用真值转写）；`--scenario talking_head|shorts|product|all`、`--fixture basic|hard|product|all`（product 场景只配 product 素材）；汇总表。
- `eval/fixture.ts`：`HARD_SCRIPT`（语速 230、粉噪 −45dBFS、短语间停顿 80–250ms、句中口头禅、不停顿重说）、`PRODUCT_SCRIPT` + `PRODUCT_BROLL`（耳机特写、充电盒特写）。
- `eval/score.ts`：`ScoreExpect.aspect`（画幅、黑边、竖屏行宽）、`ScoreExpect.broll`（讲到关键词时对应 B-roll 是否在位、时长、透明度）。
- 外部 AI 评测：`CUT_STUDIO_USER_DATA=<目录> npm run eval -- --prepare [--scenario] [--fixture]` 准备工程并打印指令，用同一 userData 启动 sidecar 让 AI 只用 cutstudio / MCP 剪，再 `npm run eval -- --score <工程目录>`。
- 第一次 CLI 扮演试剪（终端会话，shorts × hard）得 100 分，但暴露了 11 条使用摩擦，本轮已全部处理（分工见下）。

#### 工具与接入（主会话负责的部分）
- 内置 AI 能看图：`ChatMessage.images`；Anthropic 把图片放进 tool_result，OpenAI 兼容接口在同一轮 tool 消息后补一条带图的 user 消息；只保留最近两次看图的图片；关闭媒体上传时不发。
- `punch_in` 改为在当前缩放上乘倍率（reframe 竖屏铺满后再放大不会露黑边）。
- 只读工具不改工程：`withVirtualStoryline(p)`；`get_transcript`、`detect_retakes`（不带 apply）不再自动排故事线。
- `get_index` 精简（不含逐词转写，约 1KB）。
- `executeTool` 返回 `createdIds`（新建的片段 / 图层 id）；删除类工具返回 `removed`（删掉的台词、时间线位置、时长）。
- `get_transcript`：部分被剪的句子 text 显示 keptText，附 original 和 audible；分句带 cut / audible；分句 id `句子id.序号` 可直接用于 `cut_sentences`。`detect_retakes` 输出 kind（sentence / clause）和 keepText / dropText。
- `reanalyze_asset` 工具（包装 `reanalyzeAsset`）。
- `get_frame` / `contact_sheet` 的 `subtitles` 参数（默认 true）。
- `animate_text`：position（top / center / bottom）/ y / fontSize；默认自动避开字幕（字幕居中时标题在上方，字幕在底部时人名条抬到字幕上方）。
- `captions_from_transcript`：每行字数不超过 `maxCharsForStyle`（当前字号在画布上一行能放下的字数），超出时自动降低并给出 warning。
- CLI：专用命令也会带上 schema 认识的参数；未知参数报错并列出可用参数；`cutstudio tools [工具名]` 输出参数类型和是否必填。
- 删除没有调用方的 `actions.ts clipCssFilter`。
- 提示词：核心约束补充 createdIds / removed / 只读工具的说明；流程改为先设字幕样式再生成字幕；检查步骤改为 review_timeline（含黑边 / 超宽）+ 带字幕抽帧 + 通读 get_transcript；shorts 配方调整顺序和字号说明。

#### 已知限制 / 下一步
1. **第二次 CLI 扮演试剪（product 场景）没做**：用 `--prepare --scenario product` 准备工程后，让终端里的 AI 只用 cutstudio 剪一遍，重点看 insert_broll 好不好用、上一轮的摩擦是否已消除。
2. 还没有用真实 LLM API 跑 `--driver agent`（没有 API Key）。
3. 评测素材都是 TTS 合成，没有真人口播；人脸跟随、真实语速和口音下的对齐都没验证。
4. whisper 在底噪下有错别字（如「停顿衣裳就会化走」），字幕会带出来；可考虑用 `--prompt` 热词或提供字幕校对工具。
5. 预览里 J/L cut 对白和音乐不能同时播放；预览的闪避是固定比例。

## 续：2026-09-22（主会话「视频剪辑软件优化计划」+ 终端会话 kr1nous-a1）

**验证状态**：node tsc 9 / web tsc 2（基线）；`npm run verify:compose` 通过（含 `broll tests ok`）；`npm run eval -- --driver scripted --scenario all --fixture all` 在 real 和 `--asr synthetic` 下 10/10 全部 100。

### 第二次 CLI 扮演试剪（product）
终端会话 kr1nous-a1 在没读源码的情况下只用 cutstudio 剪了耳机测评，外部打分 100，但报告了约 15 条使用摩擦（集中在 B-roll）。本轮全部处理，只有 P6 除外：分句的 cut 标记本来就有，是报告误读。

### 主会话改动
- `captions_from_transcript` 补上工具 spec。此前它不在 tools/list 里，MCP 客户端和内置 AI 都看不到这个工具（阶段 2 整理工具时漏掉的）。
- 撤销：撤销点是 `{timeline, transcript?, label}`，`pushUndo(label?, {transcript?})`，`log()` 会给未命名的撤销点补上说明；`undoLast/redoLast()` 返回 `{label}`，`undoPreview()` 预览下一次撤销。`undo` 工具返回 `undone / nextUndo`。只有改转写的操作才保存转写，避免撤销剪辑时把后台重新对齐也一起回退。
- 删除类工具的 `removed` 改为 `{text, removedMs, wasAtMs, cutAtMs}`（`cutAtMs` 是剪后时间线上的切点位置）。
- CLI 参数简写（`PARAM_ALIASES`：at / start / end / ms / duration / in / out / clip / clips / asset / query↔q / text→atText / size）。`search_media` 参数改为 `query`，仍接受 `q`。
- `set_music`：不传 volume 时按实测响度自动定音量（`relativeLu` 默认 −12，最多 +6dB）；返回 `musicLufs / speechLufs / estimatedLufs / relativeLu`，太小声会警告。
- 转写纠错：`shared/transcriptfix.ts` 导出 `fixTranscript(cues, find, replace, assetId?)`（命中的词合并成一个词，占原来的时间范围）和 `transcriptionPrompt(vocab)`（只有设了热词才返回提示词）。新工具 `correct_transcript`（可撤销，字幕自动重建）和 `set_vocabulary`（写入 `Project.vocabulary`，转写时作为 whisper `--prompt` 或云端 prompt）。实测：提示词只能纠正部分同音错字（「化走」→「划走」，「衣裳」没改过来），而且会让 whisper 把整段合成一个 cue，所以没有热词时不加。
- 自动重建字幕时沿用上次的 maxChars / maxLines（记在 `SubtitleStyle.maxChars/maxLines`），并受字号上限约束。
- 预览音频（Viewer）：音频轨每个片段一个 `<audio>`（key `aud:<clipId>`），J/L cut 对白和音乐可以同时播放；闪避改为故事线此刻在人声段（按 `index.speech`）时才压低音乐。在浏览器里实测过 L-cut 窗口内两路同时播放。
- `runAction` 也会分发 craft 工具（界面的 `/action/run` 能调用 punch_in / insert_broll / audio_lead / adjust_broll）。
- `insert_broll align='clause'`：`TextHit` 新增 `clauseStartMs/clauseEndMs`，只盖命中文字所在的逗号分句。
- 提示词：纠错 / 热词的用法；B-roll 流程（contact_sheet assetId → insert_broll atText 不传时长 → adjust_broll 修正）。
- Anthropic 默认模型改为 `claude-sonnet-5`。
- 幻听过滤在真实的纯音乐素材上端到端验证过（两个「Thank you.」都被过滤）。
- 新增 `.claude/launch.json`（`cut-studio-ui`，Vite 5173），方便在浏览器里预览界面。

### 终端会话 kr1nous-a1 改动（B-roll）
- `shared/broll.ts`：`findTextHit`、`timelineSentences`、`snapBrollStart`、`overlappingBroll`、`spillsIntoNext`、`brollSentenceCrossing`、`isFullFrameBroll`。
- `insert_broll`：默认按整句对齐，不传时长就盖满那句；起点往前 500ms 内有可吸附的点时吸附过去；返回匹配到的句子和起止时间；盖进下一句或和已有 B-roll 重叠时给 warning。新工具 `adjust_broll`（参数都用时间线毫秒）。
- `get_frame` / `contact_sheet` 支持 `assetId`，直接对素材抽帧。`auto_enhance` / `color_match` 默认包含铺满画面的 B-roll。
- review 新增 `broll_overlap`、`broll_crosses_sentence`、`music_inaudible`；`music_too_loud` 有响度数据时按响度判断；新导出 `dialogLoudness`。
- eval：product 场景的 scripted 改用新的 B-roll 流程；score 新增 B-roll 覆盖检查；单测在 `render/verify-broll.ts`。

### 仍未做 / 下一步
1. 没有 API Key，还没用真实大模型跑 `--driver agent`。
2. 没有真人口播素材：人物跟随（reframe）、真实语速和口音下的词对齐都没验证。
3. B-roll 和讲解画面的色调差异检查没做：需要在 review_timeline 工具里实测画面观感后再传给 reviewTimeline。
4. whisper 错别字只能靠 AI 用 correct_transcript 逐个纠正，没有自动的错别字检测。

## 续：2026-09-22（下午）阶段 2 收尾 + agent 自动加载说明

**验证状态**：node tsc 9 / web tsc 2（基线）；`npm run verify:compose` 通过（含 `broll tests ok`、`phase-2 tool tests ok`）；eval scripted real 5/5 都是 100。

### agent 启动时自动加载剪辑说明（主会话）
- `src/main/agentdocs.ts`：`writeAgentDocs(dir)` 在工程目录写 `CLAUDE.md`（claude）、`AGENTS.md`（codex / grok）、`GEMINI.md`（gemini）、`.claude/skills/cutstudio/SKILL.md`，内容是 `agentGuide()`（CLI 用法 + fullPrompt）。文件带 `cutstudio:auto` 标记，用户自己写的同名文件不会被覆盖。新建 / 打开工程和每次打开内置终端时都会刷新。
- `terminal.ts` 的 zsh 包装函数：`claude` / `grok` 在当前目录没有自动生成的说明时，分别用 `--append-system-prompt` / `--rules` 注入 `cutstudio-guide.md`（终端启动时写进 zdot 目录，不依赖 MCP 在线）；`codex` / `gemini` 读不到说明时给提示。

### 阶段 2 剩余工具
- 主会话：`title_card`（intro / chapter / end × minimal / bold / box，放不下自动缩小字号、避开字幕、重叠时提醒）、`set_chapters`（按台词定位，返回「00:00 标题」列表，可选加章节卡）、`TimelineMarker.kind='chapter'`（`src/main/titles.ts`）；`review_timeline` 的 `broll_color_mismatch`（`src/main/review/visualcheck.ts`，渲染 B-roll 和旁边讲解画面各一帧对比，`visual:false` 跳过）；错别字提示：whisper token 置信度存成 `words[].p`，`get_transcript` 输出 `suspect`（p<0.7，带上下文）。
- 终端会话 kr1nous-a1：`speed_ramp`（拆成若干恒速子片段近似，最多 8 段）、`ken_burns`（在当前缩放上乘倍率，不会露黑边）、`voice_enhance`（podcast / clear / warm，导出生效，预览听不出）、`snap_cuts_to_beats`（roll edit，只挪静音处的切点）、`render_preview`（低清 mp4，写到临时目录）。纯逻辑在 `shared/{cliptime,ramp,kenburns,voice,beatsnap}.ts`，测试在 `render/verify-tools.ts`。
- 提示词：已写入以上工具的用法。

### 仍未做
- 没有真人口播素材：人物跟随、真实口音下的词对齐、置信度阈值 0.7 都没用真实素材校准。
- 已有工程的转写没有置信度，要 reanalyze_asset retranscribe=true 才有。
