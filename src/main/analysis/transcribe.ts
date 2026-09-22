import { spawn } from 'node:child_process'
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { constants } from 'node:fs'
import { homedir, tmpdir, cpus } from 'node:os'
import { delimiter, join } from 'node:path'
import type { AppSettings, TranscriptCue } from '../../shared/types'
import { userDataDir } from '../paths'
import { findFfmpeg, runFfmpeg } from '../render/ffmpeg'

type Word = NonNullable<TranscriptCue['words']>[number]

export interface TranscribeResult {
  cues: TranscriptCue[]
  language?: string
  engine: 'whisper.cpp' | 'cloud'
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

export async function findWhisperBin(): Promise<string | null> {
  const home = homedir()
  const dirs = [
    ...(process.env.PATH || '').split(delimiter).filter(Boolean),
    join(home, 'homebrew', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ]
  if (process.env.CUTSTUDIO_WHISPER_BIN && (await executable(process.env.CUTSTUDIO_WHISPER_BIN))) {
    return process.env.CUTSTUDIO_WHISPER_BIN
  }
  for (const name of ['whisper-cli', 'whisper-cpp']) {
    for (const d of dirs) {
      const p = join(d, name)
      if (await executable(p)) return p
    }
  }
  return null
}

/** 模型偏好：越靠前越好（兼顾中文准确率与速度）。 */
const MODEL_RANK = ['large-v3-turbo', 'large-v3', 'large-v2', 'medium', 'small', 'base', 'tiny']

export function modelDirs(): string[] {
  const home = homedir()
  return [
    join(userDataDir(), 'whisper'),
    join(userDataDir(), 'models'),
    join(home, 'homebrew', 'share', 'whisper-cpp'),
    '/opt/homebrew/share/whisper-cpp',
    '/usr/local/share/whisper-cpp',
    join(home, '.cache', 'whisper.cpp'),
    join(home, '.cache', 'whisper')
  ]
}

export async function findWhisperModel(): Promise<string | null> {
  const env = process.env.CUTSTUDIO_WHISPER_MODEL
  if (env && (await exists(env))) return env
  const found: string[] = []
  for (const d of modelDirs()) {
    try {
      for (const f of await readdir(d)) if (/^ggml-.+\.bin$/.test(f) && !f.includes('silero')) found.push(join(d, f))
    } catch {
      /* dir missing */
    }
  }
  const rank = (p: string) => {
    const i = MODEL_RANK.findIndex((m) => p.includes(`ggml-${m}`))
    return i < 0 ? MODEL_RANK.length : i
  }
  // 同档位里优先非量化 / 非 .en（中文素材）
  found.sort((a, b) => rank(a) - rank(b) || Number(a.includes('.en')) - Number(b.includes('.en')))
  return found[0] ?? null
}

/** 本地 whisper.cpp 是否可用（有可执行文件且有模型）。 */
export async function findWhisper(): Promise<{ bin: string; model: string } | null> {
  const bin = await findWhisperBin()
  if (!bin) return null
  const model = await findWhisperModel()
  return model ? { bin, model } : null
}

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString()
      if (stderr.length > 64_000) stderr = stderr.slice(-16_000)
    })
    child.on('error', (e) => resolve({ code: 1, stderr: String(e) }))
    child.on('close', (code) => resolve({ code: code ?? 1, stderr }))
  })
}

const utf8 = new TextDecoder('utf-8', { fatal: true })

function isCjk(s: string): boolean {
  return /[぀-ヿ㐀-鿿豈-﫿가-힯]/.test(s)
}

function isPunct(s: string): boolean {
  return /^[\s\p{P}\p{S}]+$/u.test(s)
}

/**
 * 把 BPE token 拼成词。中日韩按 token（通常 1–2 个字）成词；拉丁文按前导空格断词；
 * 纯标点并入前一个词。
 */
export function tokensToWords(pieces: { text: string; startMs: number; endMs: number; p?: number }[]): Word[] {
  const words: Word[] = []
  for (const p of pieces) {
    if (!p.text) continue
    const trimmed = p.text.trim()
    const prev = words[words.length - 1]
    if (!trimmed) continue
    if (prev && isPunct(trimmed)) {
      prev.text += trimmed
      continue
    }
    const withP = <T extends Word>(w: T): T => (p.p != null ? { ...w, p: w.p != null ? Math.min(w.p, p.p) : p.p } : w)
    const startsNew = /^\s/.test(p.text) || isCjk(trimmed) || !prev || isCjk(prev.text)
    if (startsNew) words.push(withP({ text: trimmed, startMs: p.startMs, endMs: Math.max(p.startMs, p.endMs) }))
    else {
      prev.text += trimmed
      prev.endMs = Math.max(prev.endMs, p.endMs)
      if (p.p != null) prev.p = prev.p != null ? Math.min(prev.p, p.p) : p.p
    }
  }
  return words
}

interface WhisperJsonToken {
  text: string
  p?: number
  offsets?: { from: number; to: number }
}
interface WhisperJson {
  result?: { language?: string }
  transcription?: { offsets?: { from: number; to: number }; text: string; tokens?: WhisperJsonToken[] }[]
}

/**
 * 解析 whisper-cli -ojf 输出。token 可能是半个 UTF-8 字符，所以按 latin1 读入、
 * 还原字节后再累积解码。
 */
export function parseWhisperJson(raw: Buffer, assetId?: string): { cues: TranscriptCue[]; language?: string } {
  const doc = JSON.parse(raw.toString('latin1')) as WhisperJson
  const bytesText = (s: string) => {
    try {
      return utf8.decode(Buffer.from(s, 'latin1'))
    } catch {
      return Buffer.from(s, 'latin1').toString('utf8')
    }
  }
  const cues: TranscriptCue[] = []
  for (const seg of doc.transcription ?? []) {
    const pieces: { text: string; startMs: number; endMs: number; p?: number }[] = []
    let pending: Buffer[] = []
    let pendingStart = 0
    let pendingP = 1
    for (const tok of seg.tokens ?? []) {
      if (/^\[_.*\]$/.test(tok.text) || !tok.offsets) continue
      if (!pending.length) {
        pendingStart = tok.offsets.from
        pendingP = 1
      }
      if (typeof tok.p === 'number') pendingP = Math.min(pendingP, tok.p)
      pending.push(Buffer.from(tok.text, 'latin1'))
      try {
        const text = utf8.decode(Buffer.concat(pending))
        pieces.push({ text, startMs: pendingStart, endMs: tok.offsets.to, p: Math.round(pendingP * 100) / 100 })
        pending = []
      } catch {
        /* 半个字符，等下一个 token */
      }
    }
    const text = bytesText(seg.text).trim()
    if (!text) continue
    const words = tokensToWords(pieces)
    const startMs = seg.offsets?.from ?? words[0]?.startMs ?? 0
    const endMs = seg.offsets?.to ?? words[words.length - 1]?.endMs ?? startMs
    const cue: TranscriptCue = { startMs, endMs: Math.max(startMs, endMs), text }
    if (assetId) cue.assetId = assetId
    if (words.length) cue.words = words
    cues.push(cue)
  }
  return { cues, language: doc.result?.language }
}

async function transcribeLocal(
  ffmpeg: string,
  whisper: { bin: string; model: string },
  path: string,
  assetId?: string,
  prompt?: string
): Promise<TranscribeResult | null> {
  const dir = await mkdtemp(join(tmpdir(), 'cutstudio-asr-'))
  try {
    const wav = join(dir, 'audio.wav')
    const r = await runFfmpeg(ffmpeg, ['-hide_banner', '-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav])
    if (r.code !== 0) return null
    const base = join(dir, 'out')
    const threads = String(Math.max(2, Math.min(8, cpus().length - 1)))
    const w = await run(whisper.bin, ['-m', whisper.model, '-f', wav, '-l', 'auto', '-t', threads, '-np', '-ojf', '-of', base, ...(prompt ? ['--prompt', prompt] : [])])
    if (w.code !== 0) return null
    const parsed = parseWhisperJson(await readFile(`${base}.json`), assetId)
    return { ...parsed, engine: 'whisper.cpp' }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function cloudProvider(settings: AppSettings) {
  const p = settings.providers.find((x) => x.id === settings.activeProviderId) ?? settings.providers[0]
  if (!p || p.kind !== 'openai-compatible' || !p.enabled || !p.apiKey || !p.baseUrl) return null
  return p
}

function cloudModel(baseUrl: string): string {
  if (process.env.CUTSTUDIO_ASR_MODEL) return process.env.CUTSTUDIO_ASR_MODEL
  if (/groq\.com/.test(baseUrl)) return 'whisper-large-v3-turbo'
  return 'whisper-1'
}

interface VerboseJson {
  language?: string
  text?: string
  segments?: { start: number; end: number; text: string }[]
  words?: { word: string; start: number; end: number }[]
}

/** OpenAI verbose_json → cues（时间加上分块偏移）。 */
export function cuesFromVerboseJson(doc: VerboseJson, offsetMs: number, chunkMs: number, assetId?: string): TranscriptCue[] {
  const ms = (s: number) => Math.round(s * 1000) + offsetMs
  const words: Word[] = (doc.words ?? [])
    .filter((w) => w.word?.trim())
    .map((w) => ({ text: w.word.trim(), startMs: ms(w.start), endMs: Math.max(ms(w.start), ms(w.end)) }))
  const segs = doc.segments?.length
    ? doc.segments
    : doc.text?.trim()
      ? [{ start: 0, end: (words.length ? words[words.length - 1]!.endMs - offsetMs : chunkMs) / 1000, text: doc.text }]
      : []
  return segs
    .filter((s) => s.text?.trim())
    .map((s) => {
      const startMs = ms(s.start)
      const endMs = Math.max(startMs, ms(s.end))
      const cue: TranscriptCue = { startMs, endMs, text: s.text.trim() }
      if (assetId) cue.assetId = assetId
      const inSeg = words.filter((w) => w.startMs >= startMs - 50 && w.startMs < endMs)
      if (inSeg.length) cue.words = inSeg
      return cue
    })
}

const CHUNK_MS = 10 * 60_000

async function transcribeCloud(
  ffmpeg: string,
  settings: AppSettings,
  path: string,
  durationMs: number,
  assetId?: string,
  prompt?: string
): Promise<TranscribeResult | null> {
  const provider = cloudProvider(settings)
  if (!provider) return null
  const url = `${provider.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`
  const model = cloudModel(provider.baseUrl)
  const dir = await mkdtemp(join(tmpdir(), 'cutstudio-asr-'))
  const cues: TranscriptCue[] = []
  let language: string | undefined
  try {
    const total = durationMs > 0 ? durationMs : CHUNK_MS
    for (let off = 0; off < total; off += CHUNK_MS) {
      const len = Math.min(CHUNK_MS, total - off)
      const file = join(dir, `chunk-${off}.m4a`)
      const r = await runFfmpeg(ffmpeg, [
        '-hide_banner',
        '-y',
        '-ss',
        (off / 1000).toFixed(3),
        '-t',
        (len / 1000).toFixed(3),
        '-i',
        path,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'aac',
        '-b:a',
        '48k',
        file
      ])
      if (r.code !== 0) return null
      const form = new FormData()
      form.append('file', new Blob([await readFile(file)], { type: 'audio/mp4' }), 'audio.m4a')
      form.append('model', model)
      form.append('response_format', 'verbose_json')
      if (prompt) form.append('prompt', prompt)
      form.append('timestamp_granularities[]', 'word')
      form.append('timestamp_granularities[]', 'segment')
      const res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${provider.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(10 * 60_000)
      })
      if (!res.ok) return null
      const doc = (await res.json()) as VerboseJson
      language ??= doc.language
      cues.push(...cuesFromVerboseJson(doc, off, len, assetId))
    }
    return { cues, language, engine: 'cloud' }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 云端转写会上传素材音频：必须用户单独打开（默认关），且允许上传媒体。 */
function cloudAllowed(settings: AppSettings): boolean {
  return settings.allowCloudTranscription === true && settings.allowMediaUpload
}

/** 当前可用的转写方式；null 表示本机没有 whisper.cpp（含模型），且不允许或无法走云端。 */
export async function transcriberAvailable(settings: AppSettings): Promise<'whisper.cpp' | 'cloud' | null> {
  if (await findWhisper()) return 'whisper.cpp'
  if (cloudAllowed(settings) && cloudProvider(settings)) return 'cloud'
  return null
}

/**
 * 转写一个素材文件，时间为素材源时间。优先本地 whisper.cpp；
 * 没有时，仅在用户打开 allowCloudTranscription（且 allowMediaUpload）时走 OpenAI 兼容 /audio/transcriptions。
 * 没有可用转写器或失败时返回 null，不抛错。
 */
export async function transcribeFile(
  path: string,
  opts: { settings: AppSettings; durationMs: number; assetId?: string; prompt?: string }
): Promise<TranscribeResult | null> {
  try {
    const ffmpeg = await findFfmpeg()
    if (!ffmpeg) return null
    const whisper = await findWhisper()
    if (whisper) {
      const local = await transcribeLocal(ffmpeg, whisper, path, opts.assetId, opts.prompt)
      if (local) return local
    }
    if (cloudAllowed(opts.settings)) return await transcribeCloud(ffmpeg, opts.settings, path, opts.durationMs, opts.assetId, opts.prompt)
    return null
  } catch {
    return null
  }
}
