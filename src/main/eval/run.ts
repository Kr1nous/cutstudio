/**
 * AI 剪辑评测：npm run eval -- [--driver none|scripted|agent|all] [--scenario talking_head|shorts|all]
 *   [--fixture basic|hard|all] [--asr synthetic] [--prompt "..."] [--provider anthropic|openai|xai] [--model id]
 *
 * - none：只把素材排上故事线，不剪（下限）
 * - scripted：按提示词里的流程直接调用工具（工具链回归基线，不需要 API Key）
 * - agent：内置 AI 真实剪辑（需要 ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY）
 *
 * 有 whisper.cpp 时默认用真实转写（--asr synthetic 改用真值转写）。
 * 结果写到 eval-results/<时间>.json，改提示词或工具后对比分数。
 */
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AiProvider, Project } from '../../shared/types'
import { runAgent } from '../ai/agent'
import { executeTool } from '../ai/tools'
import { store } from '../core'
import { buildFixture, syntheticTranscript, type FixtureVariant } from './fixture'
import { scoreProject, type ScoreExpect, type ScoreReport } from './score'

type Driver = 'none' | 'scripted' | 'agent'
type Scenario = 'talking_head' | 'shorts' | 'product'

const SCENARIOS: Record<Scenario, { prompt: string; expect: ScoreExpect }> = {
  talking_head: {
    prompt: '把这段口播剪成可以发布的横屏知识讲解视频：去掉口头禅、重录和多余停顿，加字幕，配上背景音乐（music.m4a），开头加一个标题。不要导出。',
    expect: { aspect: '16:9' }
  },
  shorts: {
    prompt: '把这段口播剪成竖屏短视频（抖音）：节奏紧凑，去掉口头禅、重录和停顿，人物铺满竖屏，大字幕，配背景音乐（music.m4a），开头一句大标题。不要导出。',
    expect: { aspect: '9:16' }
  },
  product: {
    prompt: '把这段耳机测评口播剪成横屏产品介绍视频：去掉口头禅和多余停顿，讲到耳机和充电盒的时候插入素材库里对应的特写镜头，加字幕和背景音乐（music.m4a）。不要导出。',
    expect: { aspect: '16:9', broll: [{ name: '耳机特写.mp4', keyword: '无线耳机' }, { name: '充电盒特写.mp4', keyword: '充电盒' }] }
  }
}

/** 场景默认用哪些素材：product 只配 product 素材。 */
const SCENARIO_FIXTURES: Record<Scenario, FixtureVariant[]> = {
  talking_head: ['basic', 'hard'],
  shorts: ['basic', 'hard'],
  product: ['product']
}

/** --asr synthetic：不用 whisper，用真值转写（隔离工具逻辑和转写误差）。 */
const forceSynthetic = process.argv.includes('--asr') && process.argv[process.argv.indexOf('--asr') + 1] === 'synthetic'

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}


function envProvider(): AiProvider | null {
  const want = flag('provider')
  const model = flag('model')
  if ((!want || want === 'anthropic') && process.env.ANTHROPIC_API_KEY) {
    return { id: 'eval', name: 'Anthropic', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: process.env.ANTHROPIC_API_KEY, model: model ?? 'claude-opus-5', enabled: true }
  }
  if ((!want || want === 'openai') && process.env.OPENAI_API_KEY) {
    return { id: 'eval', name: 'OpenAI', kind: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', apiKey: process.env.OPENAI_API_KEY, model: model ?? 'gpt-4.1', enabled: true }
  }
  if ((!want || want === 'xai') && process.env.XAI_API_KEY) {
    return { id: 'eval', name: 'xAI', kind: 'openai-compatible', baseUrl: 'https://api.x.ai/v1', apiKey: process.env.XAI_API_KEY, model: model ?? 'grok-4.6', enabled: true }
  }
  return null
}

async function waitForAnalysis(timeoutMs = 300_000): Promise<void> {
  const start = Date.now()
  for (;;) {
    const p = store.requireProject()
    const busy = p.assets.some(
      (a) => (a.kind === 'video' || a.kind === 'audio') && (a.index?.analysis === 'pending' || (a.index?.transcription ?? 'pending') === 'pending')
    )
    if (!busy || Date.now() - start > timeoutMs) return
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** 评测用临时 userData，本机装在剪辑台数据目录里的 whisper 模型要显式指过去。 */
async function useInstalledWhisperModel(): Promise<void> {
  if (process.env.CUTSTUDIO_WHISPER_MODEL) return
  const dir = join(homedir(), 'Library', 'Application Support', '剪辑台', 'whisper')
  try {
    const model = (await readdir(dir)).find((f) => /^ggml-.+\.bin$/.test(f))
    if (model) process.env.CUTSTUDIO_WHISPER_MODEL = join(dir, model)
  } catch {
    /* 没装模型：用合成转写 */
  }
}

async function setupProject(root: string, driver: Driver, variant: FixtureVariant) {
  const fixture = await buildFixture(join(root, variant === 'basic' ? 'fixture' : `fixture-${variant}`), variant)
  await store.createProject(join(root, 'projects'), `eval-${driver}-${Date.now()}`)
  const assets = await store.importFiles([fixture.talkPath, fixture.brollPath, fixture.musicPath, ...(fixture.extraBroll ?? []).map((b) => b.path)])
  const talk = assets.find((a) => a.name.startsWith('talk'))!
  await waitForAnalysis()
  const p = store.requireProject()
  const asr = !forceSynthetic && p.transcript.some((t) => t.assetId === talk.id && t.text.trim()) ? 'real' : 'synthetic'
  if (asr === 'synthetic') {
    p.transcript = syntheticTranscript(fixture, talk.id)
    for (const a of p.assets) if (a.index && a.kind !== 'image') a.index.transcription = a.id === talk.id ? 'done' : 'no_speech'
    await store.save()
  }
  return { fixture, talkId: talk.id, asr }
}

async function tool(name: string, args: Record<string, unknown> = {}) {
  return executeTool(name, args, 'ai') as Promise<Record<string, unknown>>
}

/** 按提示词 workflow + talking_head 配方调用工具，代表「理想 AI」的下限表现。 */
async function scripted(p: Project, scenario: Scenario): Promise<string[]> {
  const shorts = scenario === 'shorts'
  const log: string[] = []
  const step = async (name: string, args: Record<string, unknown> = {}) => {
    try {
      const r = await tool(name, args)
      log.push(`${name}: ${String(r.summary ?? 'ok')}${Array.isArray(r.warnings) && r.warnings.length ? ` ⚠ ${r.warnings.join(' / ')}` : ''}`)
      return r
    } catch (e) {
      log.push(`${name}: ✗ ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }
  await step('get_index')
  await step('get_transcript')
  await step('detect_retakes', { apply: true })
  await step('remove_filler')
  await step('tighten_pauses', { maxPauseMs: shorts ? 160 : 300 })
  if (shorts) await step('reframe', { aspect: '9:16' })
  else await step('punch_in', { scale: 1.1 })
  await step('set_subtitle_style', shorts ? { fontSize: 72, position: 'center', preset: 'karaoke' } : { fontSize: 46, position: 'bottom', preset: 'clean' })
  await step('captions_from_transcript', shorts ? { maxChars: 14 } : {})
  await step('normalize_loudness')
  await step('voice_enhance', { clipId: 'all', preset: 'podcast' })
  const music = p.assets.find((a) => a.name.startsWith('music'))
  if (music) {
    // 不传 volume：set_music 按素材响度自动定（固定 0.18 在响度低的素材上会听不见 → music_inaudible）
    await step('set_music', { assetId: music.id })
    await step('duck_music', { enabled: true })
  }
  await step('animate_text', { text: '怎么剪口播', preset: 'fade', startMs: 0, durationMs: 2500, ...(shorts ? { fontSize: 100 } : {}) })
  if (scenario === 'product') await scriptedBroll(p, step)
  if (!shorts) await step('fade_to_black', { durationMs: 800 })
  const review = await step('review_timeline')
  if (review && Array.isArray(review.issues)) for (const i of review.issues as { code: string; message: string }[]) log.push(`  · ${i.code} ${i.message}`)
  return log
}

type Step = (name: string, args?: Record<string, unknown>) => Promise<Record<string, unknown> | null>

/**
 * product 场景的 B-roll：先看素材（contact_sheet assetId），按台词整句插入（不传时长 = 盖到句尾），
 * 按返回的 warnings 用 adjust_broll 修，再让 auto_enhance 把 B-roll 一起调色。
 */
async function scriptedBroll(p: Project, step: Step): Promise<void> {
  const { PRODUCT_BROLL } = await import('./fixture')
  for (const b of PRODUCT_BROLL) {
    const asset = p.assets.find((a) => a.name === b.name)
    if (!asset) continue
    await step('contact_sheet', { assetId: asset.id, count: 4 })
    const r = await step('insert_broll', { assetId: asset.id, atText: b.keyword })
    const warnings = (r?.warnings as string[] | undefined) ?? []
    // 盖进下一句 / 和上一段重叠：收回到本句句尾
    if (r && warnings.some((w) => /盖进了下一句|重叠/.test(w)) && typeof r.sentenceEndMs === 'number') {
      await step('adjust_broll', { clipId: r.clipId, endMs: r.sentenceEndMs })
    }
    // 特写缓推（按当前缩放乘倍率，不能露黑边 → review letterbox 不报）
    if (r?.clipId) await step('ken_burns', { clipId: r.clipId, to: { scale: 1.1 } })
  }
  // 同一特写再用一次：从素材 3s 处开始，盖「戴久了耳朵」那句（验证 inMs + 整句对齐 + 吸附）
  const ear = p.assets.find((a) => a.name === PRODUCT_BROLL[0]!.name)
  if (ear) await step('insert_broll', { assetId: ear.id, atText: '戴久了耳朵', inMs: 3000 })
  await step('auto_enhance')
  // 渲染开头 3 秒低清预览（临时目录，不影响工程和打分）
  await step('render_preview', { startMs: 0, endMs: 3000, width: 320 })
}

type RunResult = { driver: Driver; scenario: Scenario; fixture: FixtureVariant; asr: string; report: ScoreReport; log: string[]; ms: number }

async function runOne(root: string, driver: Driver, scenario: Scenario, variant: FixtureVariant, promptOverride?: string): Promise<RunResult> {
  const t0 = Date.now()
  const prompt = promptOverride ?? SCENARIOS[scenario].prompt
  const { fixture, talkId, asr } = await setupProject(root, driver, variant)
  const p = store.requireProject()
  let log: string[] = []
  if (driver === 'none') {
    await store.applyOps([{ op: 'add_clip', assetId: talkId }], 'ai', '排上故事线')
  } else if (driver === 'scripted') {
    log = await scripted(p, scenario)
  } else {
    const provider = envProvider()
    if (!provider) throw new Error('agent 评测需要 ANTHROPIC_API_KEY / OPENAI_API_KEY / XAI_API_KEY')
    store.settings.providers = [provider, ...store.settings.providers.filter((x) => x.id !== 'eval')]
    store.settings.activeProviderId = 'eval'
    const out = await runAgent(prompt)
    log = [`${out.provider} ${out.model}`, out.text, ...store.requireProject().review.slice().reverse().map((r) => `${r.source} ${r.tool}: ${r.summary}`)]
  }
  const report = scoreProject(store.requireProject(), fixture, talkId, SCENARIOS[scenario].expect)
  return { driver, scenario, fixture: variant, asr, report, log, ms: Date.now() - t0 }
}

function printReport(r: RunResult): void {
  const m = r.report.metrics
  console.log(`\n=== ${r.driver} · ${r.scenario} · ${r.fixture}（转写：${r.asr}，${Math.round(r.ms / 1000)}s）得分 ${r.report.score} ===`)
  console.log(
    `成片 ${(r.report.durationMs / 1000).toFixed(1)}s｜应删未删 ${m.unwantedKept}｜误删 ${m.contentLost}｜最长停顿 ${m.maxPauseMs}ms｜字幕覆盖 ${Math.round(m.subtitleCoverage * 100)}%（${m.subtitleCount} 条）｜质检 ${m.reviewErrors} 错 ${m.reviewWarns} 警`
  )
  for (const s of r.report.segments) {
    console.log(`  ${s.shouldCut ? `[应删:${s.shouldCut}]` : '[正文]'.padEnd(12)} 可听 ${Math.round(s.audible * 100)}%  ${s.text}`)
  }
  for (const pen of r.report.penalties) console.log(`  -${pen.points} ${pen.reason}`)
  if (process.argv.includes('--verbose')) for (const line of r.log) console.log(`  > ${line}`)
}

type ExternalSession = { scenario: Scenario; fixture: FixtureVariant; fixtureDir: string; talkId: string; asr: string; prompt: string }

/**
 * 外部 AI（终端里的 Claude Code / Codex、MCP 客户端）评测：
 *   1. CUT_STUDIO_USER_DATA=<目录> npm run eval -- --prepare [--scenario shorts] [--fixture hard]
 *   2. 用同一个 CUT_STUDIO_USER_DATA 启动剪辑台（或 npx tsx src/main/sidecar.ts），它会自动打开准备好的工程
 *   3. 让 AI 只用 cutstudio / MCP 按打印出的指令剪辑
 *   4. npm run eval -- --score <工程目录>
 */
async function prepareExternal(root: string): Promise<void> {
  if (!process.env.CUT_STUDIO_USER_DATA_EXPLICIT) {
    throw new Error('--prepare 需要显式设置 CUT_STUDIO_USER_DATA（之后启动剪辑台时用同一个目录）')
  }
  const scenario = (flag('scenario') ?? 'talking_head') as Scenario
  const variant = (flag('fixture') ?? SCENARIO_FIXTURES[scenario][0]) as FixtureVariant
  const { fixture, talkId, asr } = await setupProject(root, 'agent', variant)
  const prompt = flag('prompt') ?? SCENARIOS[scenario].prompt
  const session: ExternalSession = { scenario, fixture: variant, fixtureDir: fixture.dir, talkId, asr, prompt }
  await writeFile(join(store.projectPath!, 'eval-session.json'), JSON.stringify(session, null, 2))
  console.log(`工程已准备：${store.projectPath}（转写：${asr}）`)
  console.log(`\n启动：CUT_STUDIO_USER_DATA="${process.env.CUT_STUDIO_USER_DATA}" npx tsx src/main/sidecar.ts`)
  console.log(`\n给 AI 的指令：\n${prompt}`)
  console.log(`\n打分：npm run eval -- --score "${store.projectPath}"`)
}

async function scoreExternal(projectDir: string): Promise<void> {
  const session = JSON.parse(await readFile(join(projectDir, 'eval-session.json'), 'utf8')) as ExternalSession
  const project = JSON.parse(await readFile(join(projectDir, 'project.json'), 'utf8')) as Project
  const fixture = await buildFixture(session.fixtureDir, session.fixture)
  const report = scoreProject(project, fixture, session.talkId, SCENARIOS[session.scenario].expect)
  const aiActions = project.review.filter((r) => r.source !== 'human').reverse()
  const r: RunResult = { driver: 'agent', scenario: session.scenario, fixture: session.fixture, asr: session.asr, report, log: aiActions.map((a) => `${a.source} ${a.tool}: ${a.summary}`), ms: 0 }
  printReport(r)
  console.log(`  AI 操作 ${aiActions.length} 步`)
  const outDir = join(process.cwd(), 'eval-results')
  await mkdir(outDir, { recursive: true })
  const file = join(outDir, `external-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await writeFile(file, JSON.stringify({ prompt: session.prompt, projectDir, results: [r] }, null, 2))
  console.log(`\n结果：${file}`)
}

async function main(): Promise<void> {
  const root = flag('dir') ?? join(tmpdir(), 'cutstudio-eval')
  const scoreDir = flag('score')
  if (scoreDir) {
    await scoreExternal(scoreDir)
    process.exit(0)
  }
  if (process.env.CUT_STUDIO_USER_DATA) process.env.CUT_STUDIO_USER_DATA_EXPLICIT = '1'
  process.env.CUT_STUDIO_USER_DATA ??= await mkdtemp(join(tmpdir(), 'cutstudio-eval-ud-'))
  await mkdir(root, { recursive: true })
  await store.loadSettings(process.env.CUT_STUDIO_USER_DATA)
  if (!forceSynthetic) await useInstalledWhisperModel()
  if (process.argv.includes('--prepare')) {
    await prepareExternal(root)
    process.exit(0)
  }
  const which = (flag('driver') ?? 'all') as Driver | 'all'
  const drivers: Driver[] = which === 'all' ? ['none', 'scripted', ...(envProvider() ? (['agent'] as const) : [])] : [which]
  const scen = flag('scenario') ?? 'talking_head'
  const scenarios: Scenario[] = scen === 'all' ? ['talking_head', 'shorts', 'product'] : [scen as Scenario]
  const fix = flag('fixture')
  const prompt = flag('prompt')
  const results: RunResult[] = []
  for (const scenario of scenarios) {
    const allowed = SCENARIO_FIXTURES[scenario]
    const variants = fix === 'all' || (!fix && scenario === 'product') ? allowed : [(fix ?? 'basic') as FixtureVariant].filter((v) => allowed.includes(v))
    for (const variant of variants) {
      for (const d of drivers) {
        const r = await runOne(root, d, scenario, variant, prompt)
        printReport(r)
        results.push(r)
      }
    }
  }
  if (results.length > 1) {
    console.log('\n汇总')
    for (const r of results) console.log(`  ${String(r.report.score).padStart(3)}  ${r.driver} · ${r.scenario} · ${r.fixture} · ${r.asr}`)
  }
  const outDir = join(process.cwd(), 'eval-results')
  await mkdir(outDir, { recursive: true })
  const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  await writeFile(file, JSON.stringify({ prompt: prompt ?? null, results }, null, 2))
  console.log(`\n结果：${file}`)
  if (!drivers.includes('agent')) console.log('（没有检测到 API Key，跳过 agent 评测）')
  process.exit(0)
}

void main().catch((e) => {
  console.error(e)
  process.exit(1)
})
