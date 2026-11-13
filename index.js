/**
 * Model supplier picker.
 *
 * Host half: enumerates the live provider routes and their models, proves
 * whether one exact route really accepts image input, and then persists the
 * two writes that make a text-only declaration usable:
 * `llm-pi-ai` `models[].input: [text, image]` and the default model selection.
 *
 * The probe matters because declaring `input: [text, image]` is a claim about
 * the endpoint, not a check of it: nothing in the Harness interrogates the
 * gateway, so a wrong claim fails mid-turn. The probe therefore asks the
 * endpoint itself: it draws an image with random digits and a randomly colored
 * square, sends it over the route's own protocol (`openai-completions` or
 * `openai-responses`), and scores the answer. Two independent facts are checked
 * so that "guessed a plausible number" cannot pass as "read the image", and
 * every failure is classified — credential, quota, rate limit, refusal,
 * transport — so a "no" always names the actual obstacle.
 */
import { crc32, deflateSync } from 'node:zlib'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'model-vision-picker'

const PI_AI_ROW = '@deepseek-ai/dsh-llm-pi-ai'

/** Append-only record of every write this plugin makes, newest last. */
const HISTORY_FILE = join(dirname(fileURLToPath(import.meta.url)), '.history.json')

/**
 * Last probe verdict per `provider/model`, kept in memory only.
 *
 * A probe writes nothing, but its result is the evidence a later `apply` should
 * not contradict, and the picker shows it next to the model.
 */
const lastProbes = new Map()

function messageOf(error) {
  const text = String(error?.message ?? error).split('\n')[0]
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

// ---------------------------------------------------------------------------
// A minimal PNG writer: white canvas, 7-segment digits, one colored shape.
// ---------------------------------------------------------------------------

const DIGIT_SEGMENTS = {
  0: 'abcdef', 1: 'bc', 2: 'abdeg', 3: 'abcdg', 4: 'bcfg',
  5: 'acdfg', 6: 'acdefg', 7: 'abc', 8: 'abcdefg', 9: 'abcdfg',
}

/**
 * Square colors the probe may draw. Each entry carries the words a model uses
 * for that color in Chinese or English, so `colorHit` can accept either and
 * still refuse an answer that names a color that was not drawn.
 */
const PROBE_COLORS = [
  { name: 'red', zh: '红色', hex: [204, 32, 42], words: ['红', 'red'] },
  { name: 'green', zh: '绿色', hex: [26, 140, 74], words: ['绿', 'green'] },
  { name: 'blue', zh: '蓝色', hex: [22, 72, 196], words: ['蓝', 'blue'] },
]

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0, 0)
  return Buffer.concat([length, body, crc])
}

/** Encode one RGB raster as a PNG buffer. */
function encodePng(width, height, rgb) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8    // bit depth
  header[9] = 2    // color type: truecolor RGB
  const raw = Buffer.alloc(height * (width * 3 + 1))
  for (let y = 0; y < height; y += 1) {
    const at = y * (width * 3 + 1)
    raw[at] = 0    // filter: none
    rgb.copy(raw, at + 1, y * width * 3, (y + 1) * width * 3)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * Draw one probe image whose content is a random multi-digit number plus a
 * randomly colored square, and return the PNG with both ground truths.
 *
 * Two independent facts are drawn so the verdict can tell "read the image" from
 * "guessed a plausible number": digits prove text reading, the square color
 * proves the pixels were actually inspected.
 * @returns the encoded image, the digits it shows, and the square color.
 */
export function buildProbeImage() {
  const width = 460
  const height = 200
  const rgb = Buffer.alloc(width * height * 3, 0xff)

  const put = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const at = (y * width + x) * 3
    rgb[at] = color[0]
    rgb[at + 1] = color[1]
    rgb[at + 2] = color[2]
  }
  const rect = (x, y, w, h, color) => {
    for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) put(x + dx, y + dy, color)
  }

  const BLACK = [17, 17, 17]
  const code = Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)).join('')

  const thickness = 9
  const digitWidth = 48
  const digitHeight = 84
  const top = 40
  const originX = 42
  const gap = 22

  // Segments of one 7-segment cell, as [x, y, w, h] inside the cell box.
  const segments = {
    a: [(thickness / 2) | 0, 0, digitWidth - thickness, thickness],
    b: [digitWidth - thickness, (thickness / 2) | 0, thickness, (digitHeight / 2 - thickness / 2) | 0],
    c: [digitWidth - thickness, (digitHeight / 2) | 0, thickness, (digitHeight / 2 - thickness / 2) | 0],
    d: [(thickness / 2) | 0, digitHeight - thickness, digitWidth - thickness, thickness],
    e: [0, (digitHeight / 2) | 0, thickness, (digitHeight / 2 - thickness / 2) | 0],
    f: [0, (thickness / 2) | 0, thickness, (digitHeight / 2 - thickness / 2) | 0],
    g: [(thickness / 2) | 0, ((digitHeight - thickness) / 2) | 0, digitWidth - thickness, thickness],
  }

  for (let index = 0; index < code.length; index += 1) {
    const cellX = originX + index * (digitWidth + gap)
    for (const key of DIGIT_SEGMENTS[code[index]]) {
      const [sx, sy, sw, sh] = segments[key]
      rect(cellX + sx, top + sy, sw, sh, BLACK)
    }
  }

  // A square whose color is drawn at random: digits span x=42..300, so the
  // marker sits clear of every digit cell.
  const color = PROBE_COLORS[Math.floor(Math.random() * PROBE_COLORS.length)]
  rect(350, 52, 60, 60, color.hex)

  return { png: encodePng(width, height, rgb), truth: code, color }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Probe engine.
//
// A probe has to answer one question — does *this* endpoint return the content
// of *this* image? Everything below exists to keep a "no" from being reported
// for the wrong reason: wrong protocol shape, bad credential, rate limit, or a
// transient upstream fault are separated from "the pixels were ignored".
// ---------------------------------------------------------------------------

/**
 * Request/response shapes for the protocols whose image part is known.
 *
 * `styles` are alternative serializations of the image field. Gateways built on
 * the same protocol family disagree about whether `image_url` is an object or a
 * bare data URL, so a shape-level refusal is retried once with the other form
 * before it counts as "this endpoint refuses images".
 */
const PROBE_PROTOCOLS = {
  'openai-completions': {
    label: 'openai-completions',
    leaf: 'chat/completions',
    styles: ['object', 'string'],
    body({ model, prompt, dataUrl, style }) {
      const image = style === 'string' ? dataUrl : { url: dataUrl }
      return {
        model,
        stream: false,
        temperature: 0,
        max_tokens: 400,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: image },
          ],
        }],
      }
    },
    extract(json) {
      const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined
      return firstText(
        choice?.message?.content,
        choice?.message?.reasoning_content,
        choice?.text,
        json?.output_text,
      )
    },
  },
  'openai-responses': {
    label: 'openai-responses',
    leaf: 'responses',
    styles: ['string', 'object'],
    body({ model, prompt, dataUrl, style }) {
      const image = style === 'object' ? { url: dataUrl } : dataUrl
      return {
        model,
        input: [{
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: image },
          ],
        }],
        max_output_tokens: 400,
      }
    },
    extract(json) {
      if (typeof json?.output_text === 'string' && json.output_text.trim() !== '') return json.output_text
      const parts = []
      for (const item of Array.isArray(json?.output) ? json.output : []) {
        if (typeof item?.text === 'string') parts.push(item.text)
        for (const content of Array.isArray(item?.content) ? item.content : []) {
          for (const key of ['text', 'output_text']) {
            if (typeof content?.[key] === 'string') parts.push(content[key])
          }
        }
      }
      return parts.length === 0 ? undefined : parts.join('\n')
    },
  },
}

/** Verdicts that cannot improve by asking again: stop the loop immediately. */
const PROBE_HARD_STOPS = new Set([
  'unsupported', 'bad-credential', 'not-found', 'refused', 'refused-image',
])

/**
 * Flatten one protocol's content field into text.
 * Content is a string, or an array of parts that may themselves be objects.
 * @param value - the raw content value.
 * @returns the joined text, or undefined when there is nothing to read.
 */
function textOf(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return undefined
  const parts = []
  for (const part of value) {
    if (typeof part === 'string') {
      parts.push(part)
      continue
    }
    const nested = textOf(part?.text ?? part?.content)
    if (nested !== undefined && nested.trim() !== '') parts.push(nested)
  }
  return parts.length === 0 ? undefined : parts.join('\n')
}

/** The first non-empty text among the candidate content fields. */
function firstText(...values) {
  for (const value of values) {
    const text = textOf(value)
    if (text !== undefined && text.trim() !== '') return text
  }
  return undefined
}

/**
 * Normalize a configured base URL into a full endpoint URL.
 * Profiles name the root (`https://host`), the API root (`https://host/v1`),
 * or the full endpoint, so all three forms are accepted.
 * @param baseURL - the route's configured base URL.
 * @param leaf - `chat/completions` or `responses`.
 * @returns an absolute endpoint URL.
 */
export function probeEndpoint(baseURL, leaf) {
  const trimmed = String(baseURL ?? '').trim().replace(/\/+$/, '')
  if (trimmed === '') throw new Error('该供应商没有配置 baseURL，无法探测')
  if (trimmed.endsWith(`/${leaf}`)) return trimmed
  // A base that already names one endpoint is swapped, not appended to.
  const swapped = trimmed.replace(/\/(chat\/completions|responses|completions)$/, `/${leaf}`)
  if (swapped !== trimmed) return swapped
  if (/\/v\d+(?:\.\d+)?$/.test(trimmed)) return `${trimmed}/${leaf}`
  return `${trimmed}/v1/${leaf}`
}

/** The instruction sent with every probe image. */
function probePrompt(color) {
  return `这张图里有一串黑色数字，右侧还有一个${color.zh}方块。`
    + '先写出数字，再写出方块颜色，两段用竖线分隔，不要解释。'
}

/**
 * Test one answer against the digits the image actually showed.
 * A run of digits must match exactly; a bare concatenation only counts when the
 * whole answer is that number, so a longer number cannot contain the truth.
 * @param answer - the model's text.
 * @param truth - the digits drawn into the image.
 * @returns whether the answer read the digits correctly.
 */
export function digitsHit(answer, truth) {
  const text = String(answer)
  const runs = text.match(/\d+/g) ?? []
  if (runs.includes(truth)) return true
  return text.replace(/[^\d]/g, '') === truth
}

/**
 * Whether the answer named the drawn color, and no other color.
 * @param answer - the model's text.
 * @param color - the color drawn into the image (one PROBE_COLORS entry).
 * @returns whether the answer identified that color exclusively.
 */
export function colorHit(answer, color) {
  const lower = String(answer).toLowerCase()
  const named = PROBE_COLORS.filter((entry) => entry.words.some((word) => lower.includes(word.toLowerCase())))
  return named.length > 0 && named.every((entry) => entry.name === color.name)
}

/**
 * Turn one HTTP failure into a verdict that names the actual obstacle.
 * @param status - the HTTP status code.
 * @param raw - the response body text, used only for keyword evidence.
 */
function classifyFailure(status, raw) {
  const lower = String(raw ?? '').toLowerCase()
  const mentionsImage = /(image|vision|multimodal|input_image|image_url|content.?type|media type|图片|图像)/.test(lower)
  if (status === 401 || status === 403) {
    return { verdict: 'bad-credential', hint: '凭据无效或没有该模型的权限：检查 apiKeyEnv 对应的密钥' }
  }
  if (status === 402) {
    return { verdict: 'insufficient-credit', hint: '账户余额或配额不足：充值或换一个路由' }
  }
  if (status === 404) {
    return { verdict: 'not-found', hint: '404：baseURL 或协议可能不匹配，也可能该模型不在这个路由上' }
  }
  if (status === 410) {
    return { verdict: 'endpoint-gone', hint: '端点已下线或迁移：更新 baseURL 后再探测' }
  }
  if (status === 429) {
    return { verdict: 'rate-limited', transient: true, hint: '被限流：稍后重试，或换一个路由' }
  }
  if (status >= 500) {
    return { verdict: 'server-error', transient: true, hint: '端点 5xx：上游故障，稍后重试' }
  }
  if (status === 400 || status === 413 || status === 415 || status === 422) {
    return mentionsImage
      ? { verdict: 'refused-image', hint: '端点以图像相关理由拒绝了请求：这个模型大概率不接收图像，不要声明识图' }
      : { verdict: 'refused', hint: '请求被拒绝：通常是模型名、参数或协议不匹配' }
  }
  return { verdict: 'refused', hint: `端点返回 HTTP ${status}` }
}

/**
 * Send one probe request and score the answer.
 *
 * `outcome: 'answered'` means the endpoint produced text, whatever it said; the
 * caller decides what that text proves. `outcome: 'failed'` carries the verdict
 * that explains the failure.
 */
async function probeRequest(plan) {
  const { protocol, model, endpoint, headers, challenge, timeoutMs, fetchImpl, style, index } = plan
  const startedAt = Date.now()
  const dataUrl = `data:image/png;base64,${challenge.png.toString('base64')}`
  const body = JSON.stringify(protocol.body({
    model,
    prompt: probePrompt(challenge.color),
    dataUrl,
    style,
  }))

  let response
  try {
    response = await fetchImpl(endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError'
    // `fetch failed` hides the real cause (DNS, TLS, connection refused) in
    // `error.cause`; a probe that cannot say why is worth very little.
    const cause = error?.cause?.code ?? error?.cause?.message ?? error?.cause?.errno
    const detail = timedOut
      ? `请求超过 ${timeoutMs}ms 没有完成`
      : [messageOf(error), typeof cause === 'string' ? cause : undefined].filter(Boolean).join(' / ')
    return {
      index,
      style,
      outcome: 'failed',
      verdict: timedOut ? 'timeout' : 'unreachable',
      detail,
      hint: timedOut ? '端点没有在超时内响应：提高 timeoutMs，或换一个路由' : '地址无法连通：检查 baseURL、DNS 和网络',
      elapsedMs: Date.now() - startedAt,
      transient: !timedOut,
    }
  }

  const text = await response.text().catch(() => '')
  const elapsedMs = Date.now() - startedAt
  if (!response.ok) {
    return {
      index,
      style,
      outcome: 'failed',
      status: response.status,
      detail: text.slice(0, 300),
      elapsedMs,
      ...classifyFailure(response.status, text),
    }
  }

  let json
  try {
    json = JSON.parse(text)
  } catch {
    return {
      index,
      style,
      outcome: 'failed',
      status: response.status,
      verdict: 'bad-response',
      detail: `端点返回的不是 JSON：${text.slice(0, 200)}`,
      hint: '成功状态码却返回非 JSON（可能是网关错误页或返回了 SSE 流）',
      elapsedMs,
    }
  }

  const answer = protocol.extract(json)
  if (answer === undefined) {
    return {
      index,
      style,
      outcome: 'failed',
      status: response.status,
      verdict: 'empty-answer',
      detail: `响应成功但没有文本：${text.slice(0, 200)}`,
      hint: '响应里没有可读内容：可能是空 choices、只返回了 reasoning，或给了图片但没有被使用',
      elapsedMs,
    }
  }

  return {
    index,
    style,
    outcome: 'answered',
    status: response.status,
    answer: answer.slice(0, 400),
    truth: challenge.truth,
    drawnColor: challenge.color.name,
    digitHits: digitsHit(answer, challenge.truth),
    colorHits: colorHit(answer, challenge.color),
    elapsedMs,
  }
}

/**
 * Send one sample, trying each image serialization before giving up.
 *
 * A shape refusal is not evidence about vision, so it never ends the sample
 * until every shape the protocol offers has been refused. An answered sample
 * still lets the next sample run: the second image is what separates a model
 * that reads from a model that guessed once.
 */
async function probeSample(plan) {
  let last
  for (const style of plan.protocol.styles) {
    last = await probeRequest({ ...plan, style })
    if (last.outcome === 'answered') return { ...last, stopped: false }
    if (last.verdict !== 'refused-image') break
  }
  return {
    ...last,
    stopped: PROBE_HARD_STOPS.has(last.verdict),
    shapesTried: plan.protocol.styles,
  }
}

/** The UI-facing shape of one sample: everything but the image bytes. */
function publicSample(sample) {
  return {
    index: sample.index,
    outcome: sample.outcome,
    verdict: sample.verdict,
    style: sample.style,
    status: sample.status,
    truth: sample.truth,
    drawnColor: sample.drawnColor,
    answer: sample.answer,
    digitHits: sample.digitHits,
    colorHits: sample.colorHits,
    detail: sample.detail,
    hint: sample.hint,
    elapsedMs: sample.elapsedMs,
  }
}

/**
 * Aggregate samples into one verdict.
 *
 * Confirmation needs one sample read the digits exactly; agreement across
 * samples raises confidence instead of changing the verdict. A model that names
 * the drawn color but misses the digits saw the image and misread it, which is
 * reported separately from a model that answered as if no image were there.
 */
function summarizeSamples(head, samples) {
  const base = { ...head, samples: samples.map(publicSample) }
  const answered = samples.filter((sample) => sample.outcome === 'answered')
  const reads = answered.filter((sample) => sample.digitHits === true)
  const colorOnly = answered.filter((sample) => sample.digitHits !== true && sample.colorHits === true)
  const failure = samples.find((sample) => sample.outcome === 'failed')

  if (reads.length > 0) {
    return {
      ...base,
      ok: true,
      verdict: 'vision-confirmed',
      confidence: reads.length === samples.length ? (samples.length >= 2 ? 'high' : 'medium') : 'medium',
      truth: reads[0].truth,
      drawnColor: reads[0].drawnColor,
      answer: reads[0].answer,
      detail: `端点准确读出图中随机数字（${reads.length}/${samples.length} 次），图像输入真实可用`,
      hint: '可以 apply：声明识图并设为默认模型',
    }
  }
  if (answered.length === 0) {
    return {
      ...base,
      ok: false,
      verdict: failure?.verdict ?? 'unknown',
      status: failure?.status,
      detail: failure?.detail ?? '端点没有任何响应',
      hint: failure?.hint,
    }
  }
  if (colorOnly.length > 0) {
    return {
      ...base,
      ok: false,
      verdict: 'vision-partial',
      confidence: 'low',
      truth: colorOnly[0].truth,
      drawnColor: colorOnly[0].drawnColor,
      answer: colorOnly[0].answer,
      detail: '端点看到了图像（颜色判断正确），但没有准确读出数字',
      hint: '图像确实进入了模型，但读数不可靠：再探测一次，或换更清晰的图/更强模型；此时声明识图风险较高',
    }
  }
  return {
    ...base,
    ok: false,
    verdict: 'no-vision',
    confidence: 'medium',
    truth: answered[0].truth,
    drawnColor: answered[0].drawnColor,
    answer: answered[0].answer,
    detail: '端点给出了回答，但没有读出图中数字或颜色：图像内容看起来被忽略了',
    hint: '不要声明识图；可换 openai-responses 路由，或确认该模型是否支持图像输入',
  }
}

/**
 * Probe one route and model: send generated images, score the answers.
 *
 * @param options.provider - route id, echoed back in the result.
 * @param options.model - exact model id.
 * @param options.api - protocol name; must be a key of PROBE_PROTOCOLS.
 * @param options.endpoint - absolute endpoint URL.
 * @param options.headers - request headers, credentials already resolved.
 * @param options.attempts - how many independent samples, 1..3.
 * @param options.timeoutMs - per-request timeout.
 * @param options.hasCredential - false when the route has no resolvable key.
 * @param options.makeChallenge - image factory, injected by tests.
 * @param options.fetchImpl - fetch implementation, injected by tests.
 * @returns the aggregate verdict, with every sample attached.
 */
export async function runProbe(options) {
  const {
    provider = '',
    model,
    api = 'openai-completions',
    endpoint,
    headers = {},
    attempts = 2,
    timeoutMs = 45_000,
    hasCredential,
    makeChallenge = buildProbeImage,
    fetchImpl = fetch,
  } = options ?? {}

  const protocol = PROBE_PROTOCOLS[api]
  if (protocol === undefined) {
    return {
      ok: false,
      verdict: 'unsupported',
      provider,
      model,
      api,
      samples: [],
      detail: `该供应商使用 ${api} 协议，探测只支持 ${Object.keys(PROBE_PROTOCOLS).join(' / ')}`,
      hint: '换一个 openai-completions / openai-responses 路由，或先确认该协议下的图像字段',
    }
  }

  const warnings = []
  if (hasCredential === false) {
    warnings.push('没有解析到凭据，本次按无鉴权发送；若返回 401 请先在供应商卡片配置 API key')
  }

  const sampleCount = Math.min(Math.max(Number(attempts) || 1, 1), 3)
  // Clamped so a caller-supplied timeout can neither hang a probe nor fail it
  // instantly before the gateway has a chance to answer.
  const perRequestTimeout = Math.min(Math.max(Number(timeoutMs) || 45_000, 2_000), 120_000)
  const startedAt = Date.now()
  const samples = []
  let transportFailures = 0
  for (let index = 0; index < sampleCount; index += 1) {
    const challenge = makeChallenge()
    const sample = await probeSample({
      protocol, model, endpoint, headers, challenge, timeoutMs: perRequestTimeout, fetchImpl, index: index + 1,
    })
    samples.push(sample)
    if (sample.verdict === 'unreachable' || sample.verdict === 'timeout') transportFailures += 1
    if (sample.stopped === true) break
    // A dead link does not heal between samples, and every transport attempt
    // costs a full timeout: keep one retry, then stop wasting the caller's time.
    if (transportFailures >= 2) break
  }

  return summarizeSamples({
    provider,
    model,
    api: protocol.label,
    endpoint,
    elapsedMs: Date.now() - startedAt,
    warnings,
  }, samples)
}

export function apply(ctx) {
  /** Every route the Harness can currently dispatch to, with its models. */
  async function roster() {
    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('当前运行环境没有 llm 服务')
    const providers = llm.listProviders()
    const rows = []
    for (const provider of providers) {
      let models = []
      let failure
      try {
        models = await llm.listModels(provider.id)
      } catch (error) {
        failure = messageOf(error)
      }
      rows.push({
        provider: provider.id,
        displayName: provider.name ?? provider.id,
        error: failure,
        models: models.map((model) => ({
          id: model.id,
          name: model.name ?? model.id,
          inputModalities: model.inputModalities ? [...model.inputModalities] : undefined,
        })),
      })
    }
    return rows
  }

  /** The `llm-pi-ai` profile row and its effective providers, when editable. */
  function piAiRow() {
    const editor = ctx.get('configEditor')
    if (editor === undefined) return undefined
    const found = editor.configuration().find((row) => row.entry?.options?.name === PI_AI_ROW)
    if (found === undefined) return undefined
    const providers = found.inherited?.providers ?? found.override?.providers
    return {
      entry: found.entry,
      providers: providers !== null && typeof providers === 'object' ? providers : {},
      override: found.override ?? {},
      inherited: found.inherited ?? {},
    }
  }

  /** Read one route's stored profile: base URL, protocol, credential, headers. */
  function routeProfile(provider) {
    const row = piAiRow()
    const profile = row?.providers?.[provider]
    if (profile === undefined || profile === null) return undefined
    return {
      baseURL: typeof profile.baseURL === 'string' ? profile.baseURL : undefined,
      api: typeof profile.api === 'string' ? profile.api : undefined,
      apiKeyEnv: typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : undefined,
      headers: profile.headers !== null && typeof profile.headers === 'object' ? profile.headers : undefined,
      displayName: typeof profile.displayName === 'string' ? profile.displayName : provider,
      models: Array.isArray(profile.models) ? profile.models : [],
    }
  }

  /** Resolve the API key a route authenticates with, when one is configured. */
  async function resolveKey(apiKeyEnv) {
    if (typeof apiKeyEnv !== 'string' || apiKeyEnv === '') return undefined
    if (typeof process.env[apiKeyEnv] === 'string' && process.env[apiKeyEnv] !== '') return process.env[apiKeyEnv]
    const credentials = ctx.get('credentials')
    if (credentials === undefined) return undefined
    try {
      const resolved = await credentials.resolve(apiKeyEnv)
      return typeof resolved?.value === 'string' && resolved.value !== '' ? resolved.value : undefined
    } catch {
      return undefined
    }
  }

  /**
   * Ask one exact route to read freshly generated images, outside the
   * Harness's own declaration, so the answer describes the endpoint instead of
   * the profile.
   *
   * The profile supplies the endpoint, protocol, and headers; everything after
   * that is measurement, and the verdict is remembered for `state()` and for
   * the warning `apply` raises when it contradicts the probe.
   * @param provider - registered provider route.
   * @param model - exact model id.
   * @param options - optional attempts and timeoutMs from the caller.
   * @returns a verdict with the endpoint's own answers.
   */
  async function probe(provider, model, options) {
    if (typeof provider !== 'string' || provider === '') {
      return { ok: false, verdict: 'bad-request', detail: '需要 provider' }
    }
    if (typeof model !== 'string' || model === '') {
      return { ok: false, verdict: 'bad-request', detail: '需要 model' }
    }
    const profile = routeProfile(provider)
    if (profile === undefined) {
      return {
        ok: false,
        verdict: 'unsupported',
        detail: `供应商 ${provider} 不在 llm-pi-ai 配置里，无法取得端点信息`,
        hint: '该路由由插件在运行时注册，profile 里没有它的 baseURL',
      }
    }
    const api = profile.api ?? 'openai-completions'
    const protocol = PROBE_PROTOCOLS[api]
    if (protocol === undefined) {
      return {
        ok: false,
        verdict: 'unsupported',
        provider,
        model,
        api,
        samples: [],
        detail: `该供应商使用 ${api} 协议，探测只支持 ${Object.keys(PROBE_PROTOCOLS).join(' / ')}`,
        hint: '换一个 openai-completions / openai-responses 路由',
      }
    }
    let endpoint
    try {
      endpoint = probeEndpoint(profile.baseURL, protocol.leaf)
    } catch (error) {
      return { ok: false, verdict: 'unsupported', provider, model, detail: messageOf(error), samples: [] }
    }

    const key = await resolveKey(profile.apiKeyEnv)
    const headers = {
      ...(profile.headers ?? {}),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }
    if (key !== undefined) headers.Authorization = `Bearer ${key}`

    const result = await runProbe({
      provider,
      model,
      api,
      endpoint,
      headers,
      attempts: options?.attempts,
      timeoutMs: options?.timeoutMs,
      hasCredential: key !== undefined || profile.apiKeyEnv === undefined,
    })

    lastProbes.set(`${provider}/${model}`, {
      at: new Date().toISOString(),
      ok: result.ok === true,
      verdict: result.verdict,
      confidence: result.confidence,
      truth: result.truth,
      answer: result.answer,
    })
    return result
  }

  /** Find one model entry inside a route's stored profile. */
  function modelEntry(profile, model) {
    return (profile?.models ?? []).find((entry) => entry?.id === model)
  }

  /**
   * Write `input: [text, image]` onto one exact model of the `llm-pi-ai` row.
   * @param provider - provider route whose profile holds the model.
   * @param model - exact model id.
   * @returns the modalities the route reports afterwards.
   */
  async function declareImage(provider, model) {
    return declareImageWith(provider, model, ['text', 'image'])
  }

  /**
   * Write one exact `input` array onto a model row.
   *
   * Revert uses this to restore the array a row held before a write, which is
   * not always `[text, image]`.
   * @param provider - the route id owning the model.
   * @param model - the model id to write.
   * @param modalities - the exact array to store.
   * @returns the modalities the route reports afterwards.
   */
  async function declareImageWith(provider, model, modalities) {
    const row = piAiRow()
    if (row === undefined) throw new Error('未找到 llm-pi-ai 的 profile 配置行，无法写入识图声明')
    if (row.providers[provider] === undefined) {
      throw new Error(`供应商 ${provider} 不在 llm-pi-ai 的配置里：它由插件在运行时注册，无法在这里声明识图`)
    }
    const editor = ctx.get('configEditor')
    if (editor === undefined) throw new Error('当前运行环境没有 configEditor 服务，无法写入 profile 配置')
    await editor.edit(row.entry, (current) => {
      const next = { ...current }
      const providers = { ...(next.providers ?? row.providers) }
      const profile = { ...providers[provider] }
      const models = Array.isArray(profile.models) ? [...profile.models] : []
      if (models.length === 0) throw new Error(`供应商 ${provider} 在配置里没有 models 列表，无法逐模型声明识图`)
      const index = models.findIndex((entry) => entry?.id === model)
      if (index < 0) throw new Error(`供应商 ${provider} 的配置里没有模型 ${model}，请先在供应商卡片中添加它`)
      models[index] = { ...models[index], input: [...modalities] }
      profile.models = models
      providers[provider] = profile
      next.providers = providers
      return next
    })
    return currentModalities(provider, model)
  }

  /** Read the modalities the live route reports, after any write. */
  async function currentModalities(provider, model) {
    const llm = ctx.get('llm')
    if (llm === undefined) return undefined
    try {
      const info = await llm.resolveModelInfo(provider, model)
      return info.inputModalities ? [...info.inputModalities] : undefined
    } catch {
      return undefined
    }
  }

  // ---------------------------------------------------------------------------
  // History: every write records what the two settings held *before* it, so any
  // entry can be undone exactly rather than approximated.
  // ---------------------------------------------------------------------------

  /** Read the `input` array stored on one model row, if the row exists. */
  function storedInput(provider, model) {
    const row = piAiRow()
    const profile = row?.providers?.[provider]
    if (profile === undefined || profile === null) return undefined
    const models = Array.isArray(profile.models) ? profile.models : []
    const entry = models.find((item) => item?.id === model)
    if (entry === undefined) return undefined
    return Array.isArray(entry.input) ? [...entry.input] : null
  }

  /** The default selection as plain data, when the service is present. */
  function currentDefault() {
    const defaults = ctx.get('agentDefaultModel')
    if (defaults === undefined) return undefined
    try {
      const selection = defaults.currentSelection()
      return { provider: selection.provider, model: selection.model }
    } catch {
      return undefined
    }
  }

  /**
   * Read the whole history, newest last.
   * @returns the stored entries; a missing or unreadable file is an empty log.
   */
  async function readHistory() {
    try {
      const raw = await readFile(HISTORY_FILE, 'utf8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed?.entries) ? parsed.entries : []
    } catch {
      return []
    }
  }

  /** Replace the history file atomically, so a crash cannot truncate it. */
  async function writeHistory(entries) {
    await mkdir(dirname(HISTORY_FILE), { recursive: true })
    const temporary = `${HISTORY_FILE}.tmp`
    await writeFile(temporary, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`, 'utf8')
    await rename(temporary, HISTORY_FILE)
  }

  /**
   * Append one entry describing the state before a write.
   * @param entry - what changed, the previous values, and the values written.
   * @returns the recorded entry, including its id and timestamp.
   */
  async function recordChange(entry) {
    const entries = await readHistory()
    const recorded = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      undone: false,
      ...entry,
    }
    entries.push(recorded)
    // Keep the log bounded; 200 writes of this shape is still tiny.
    await writeHistory(entries.slice(-200))
    return recorded
  }

  /** Describe one history entry for the UI, without its heavy fields. */
  function summarize(entry) {
    return {
      id: entry.id,
      at: entry.at,
      action: entry.action,
      provider: entry.provider,
      model: entry.model,
      undone: entry.undone === true,
      changes: entry.changes,
    }
  }

  // ---------------------------------------------------------------------------
  // Erase and revert. Both go through the same write paths as apply, so the
  // profile keeps one code path per setting.
  // ---------------------------------------------------------------------------

  /**
   * Remove the image declaration from one model row.
   *
   * The key is deleted, not rewritten to `[text]`: a route that never declared
   * `input` should look exactly as it did before this plugin touched it.
   * @param provider - the route id owning the model.
   * @param model - the model id to clear.
   * @returns the modalities the route reports afterwards.
   */
  async function eraseImage(provider, model) {
    const row = piAiRow()
    if (row === undefined) throw new Error('未找到 llm-pi-ai 的 profile 配置行，无法抹除识图声明')
    if (row.providers[provider] === undefined) {
      throw new Error(`供应商 ${provider} 不在 llm-pi-ai 的配置里，无法抹除`)
    }
    const editor = ctx.get('configEditor')
    if (editor === undefined) throw new Error('当前运行环境没有 configEditor 服务，无法写入 profile 配置')
    await editor.edit(row.entry, (current) => {
      const next = { ...current }
      const providers = { ...(next.providers ?? row.providers) }
      const profile = { ...providers[provider] }
      const models = Array.isArray(profile.models) ? [...profile.models] : []
      const index = models.findIndex((entry) => entry?.id === model)
      if (index < 0) throw new Error(`供应商 ${provider} 的配置里没有模型 ${model}`)
      const cleared = { ...models[index] }
      if (cleared.input !== undefined) delete cleared.input
      models[index] = cleared
      profile.models = models
      providers[provider] = profile
      next.providers = providers
      return next
    })
    return currentModalities(provider, model)
  }

  /**
   * Erase what apply wrote, for one provider and model.
   *
   * Each write is recorded before it happens, so the previous values are exact
   * rather than inferred from the current ones.
   * @param request - the provider, model, and which parts to erase.
   * @returns what was erased and what remains.
   */
  async function eraseSelection(request) {
    const provider = typeof request?.provider === 'string' ? request.provider : ''
    const model = typeof request?.model === 'string' ? request.model : ''
    if (provider === '' || model === '') throw new Error('需要 provider 和 model')

    const beforeInput = storedInput(provider, model)
    const beforeDefault = currentDefault()
    const result = { provider, model, imageErased: undefined, defaultRestored: undefined, warnings: [] }

    if (request?.eraseImage !== false) {
      if (beforeInput === undefined) {
        result.warnings.push('该供应商的配置里没有这个模型，识图声明无从抹除')
      } else if (beforeInput === null) {
        result.warnings.push('该模型本来就没有识图声明，无需抹除')
      } else {
        await eraseImage(provider, model)
        result.imageErased = { from: beforeInput, to: null }
        await recordChange({
          action: 'erase-image',
          provider,
          model,
          changes: { input: beforeInput },
          revert_to: null,
        })
      }
    }

    if (request?.restoreDefault !== false) {
      const target = request?.defaultTo
      if (target === undefined || typeof target?.provider !== 'string' || typeof target?.model !== 'string') {
        result.warnings.push('未提供要恢复的默认模型（defaultTo），默认模型未改动')
      } else {
        const defaults = ctx.get('agentDefaultModel')
        if (defaults === undefined) {
          result.warnings.push('当前运行环境没有 agentDefaultModel 服务，默认模型未改动')
        } else {
          await defaults.saveSelection({ provider: target.provider, model: target.model })
          result.defaultRestored = { from: beforeDefault, to: target }
          await recordChange({
            action: 'restore-default',
            provider: target.provider,
            model: target.model,
            changes: { default: beforeDefault },
            revert_to: target,
          })
        }
      }
    }

    result.inputModalities = await currentModalities(provider, model)
    result.selection = currentDefault()
    return result
  }

  /**
   * Undo one history entry by writing back the values it recorded.
   * @param id - the entry id; the newest entry is used when omitted.
   * @returns the entry and what it restored.
   */
  async function revert(request) {
    const entries = await readHistory()
    if (entries.length === 0) throw new Error('没有可回退的历史记录')
    const id = typeof request?.id === 'string' ? request.id : ''
    const index = id === ''
      ? entries.map((entry) => entry.undone !== true).lastIndexOf(true)
      : entries.findIndex((entry) => entry.id === id)
    if (index < 0) throw new Error(id === '' ? '没有待回退的记录' : `找不到历史记录 ${id}`)
    const entry = entries[index]
    if (entry.undone === true) throw new Error('该记录已经回退过')

    const restored = { id: entry.id, action: entry.action, image: undefined, default: undefined, warnings: [] }

    if (entry.changes?.input !== undefined) {
      const target = entry.changes.input
      if (Array.isArray(target)) {
        await declareImageWith(entry.provider, entry.model, target)
        restored.image = target
      } else {
        await eraseImage(entry.provider, entry.model)
        restored.image = null
      }
    }

    if (entry.changes?.default !== undefined) {
      const target = entry.changes.default
      const defaults = ctx.get('agentDefaultModel')
      if (target !== null && defaults !== undefined) {
        await defaults.saveSelection({ provider: target.provider, model: target.model })
        restored.default = target
      } else if (target === null) {
        restored.warnings.push('这条记录的默认模型原本不存在，无法写回（该字段为必填）')
      }
    }

    entry.undone = true
    entry.undoneAt = new Date().toISOString()
    entries[index] = entry
    await writeHistory(entries)

    restored.selection = currentDefault()
    return restored
  }

  /** Everything the picker shows: routes, models, the default, and writability. */
  async function state() {
    const routes = await roster()
    const row = piAiRow()
    const editable = row !== undefined
    let selection
    const defaults = ctx.get('agentDefaultModel')
    if (defaults !== undefined) {
      try {
        selection = defaults.currentSelection()
      } catch {
        selection = undefined
      }
    }
    return {
      editable,
      editableReason: editable
        ? undefined
        : '当前运行环境没有可写的 llm-pi-ai 配置行（缺少 configEditor 或该行不在 profile patch 中）',
      documentPath: ctx.get('configEditor')?.documentPath,
      selection: selection === undefined
        ? undefined
        : { provider: selection.provider, model: selection.model },
      routes: routes.map((route) => ({
        ...route,
        writable: editable && row.providers[route.provider] !== undefined,
        models: route.models.map((model) => ({
          ...model,
          declaredImage: Array.isArray(model.inputModalities) && model.inputModalities.includes('image'),
          storedInput: storedInput(route.provider, model.id),
          lastProbe: lastProbes.get(`${route.provider}/${model.id}`),
        })),
      })),
      history: (await readHistory()).slice(-20).reverse().map(summarize),
    }
  }

  /**
   * Apply one selection: optionally declare image input, then set the default.
   * @param request - the provider, model, and which writes to perform.
   * @returns what changed and what the route reports afterwards.
   */
  async function applySelection(request) {
    const provider = typeof request?.provider === 'string' ? request.provider : ''
    const model = typeof request?.model === 'string' ? request.model : ''
    if (provider === '' || model === '') throw new Error('需要 provider 和 model')

    const llm = ctx.get('llm')
    if (llm === undefined) throw new Error('当前运行环境没有 llm 服务')
    await llm.resolveModelInfo(provider, model).catch((error) => {
      throw new Error(`模型 ${provider}/${model} 不可解析：${messageOf(error)}`)
    })

    const result = { provider, model, imageDeclared: undefined, defaultSet: undefined, warnings: [] }

    // Snapshot both settings first: the previous values are the only thing an
    // undo can restore, and after the write they are gone.
    const beforeInput = storedInput(provider, model)
    const beforeDefault = currentDefault()

    if (request?.declareImage !== false) {
      // The probe result is evidence about this exact endpoint. Declaring
      // anyway is allowed, but the contradiction must be visible.
      const probed = lastProbes.get(`${provider}/${model}`)
      if (probed !== undefined && probed.ok !== true) {
        result.warnings.push(`最近一次探测结论是「${probed.verdict}」，识图声明可能不成立`)
      }
      try {
        result.imageDeclared = await declareImage(provider, model)
        await recordChange({
          action: 'declare-image',
          provider,
          model,
          changes: { input: beforeInput === undefined ? null : beforeInput },
          revert_to: ['text', 'image'],
        })
      } catch (error) {
        result.warnings.push(`识图声明未写入：${messageOf(error)}`)
      }
    }

    const defaults = ctx.get('agentDefaultModel')
    if (request?.setDefault !== false) {
      if (defaults === undefined) {
        result.warnings.push('当前运行环境没有 agentDefaultModel 服务，默认模型未改动')
      } else {
        await defaults.saveSelection({ provider, model })
        result.defaultSet = { provider, model }
        await recordChange({
          action: 'set-default',
          provider,
          model,
          changes: { default: beforeDefault ?? null },
          revert_to: { provider, model },
        })
      }
    }

    result.inputModalities = await currentModalities(provider, model)
    return result
  }

  // Agent-facing half of the same operations.
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(() => toolCtx.tools.register({
      name: 'model_vision_picker',
      description:
        '模型与识图：action=list 列出供应商与模型、识图声明、最近探测结论和改动历史；' +
        'action=probe 真实探测某个模型能否识图：生成含随机数字与随机颜色方块的图片，直连端点请求并核对回答；' +
        '支持 openai-completions 与 openai-responses，返回 verdict、confidence、hint 和每次采样的原始回答；' +
        'action=apply 把某个模型设为默认并声明识图；' +
        'action=erase 抹除识图声明并（可选）把默认模型恢复到你指定的值；' +
        'action=revert 按历史记录逐步回退，省略 id 时回退最近一条未回退的记录。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'probe', 'apply', 'erase', 'revert'],
            description: 'list 查看；probe 探测识图；apply 应用选择；erase 抹除；revert 回退',
          },
          provider: { type: 'string', description: '供应商路由 id，probe/apply/erase 需要' },
          model: { type: 'string', description: '模型 id，probe/apply/erase 需要' },
          attempts: {
            type: 'number',
            description: 'probe 采样次数 1–3，默认 2：每次都换一张新图，用来区分“读得准”和“猜中了”',
          },
          timeoutMs: {
            type: 'number',
            description: 'probe 单次请求超时毫秒数 2000–120000，默认 45000',
          },
          declareImage: { type: 'boolean', description: 'apply 时是否写入识图声明，默认 true' },
          setDefault: { type: 'boolean', description: 'apply 时是否设为默认模型，默认 true' },
          eraseImage: { type: 'boolean', description: 'erase 时是否抹除识图声明，默认 true' },
          restoreDefault: { type: 'boolean', description: 'erase 时是否恢复默认模型，需配合 defaultTo' },
          defaultTo: {
            type: 'object',
            description: 'erase 时要把默认模型恢复成哪个（provider + model）',
            properties: {
              provider: { type: 'string' },
              model: { type: 'string' },
            },
            additionalProperties: false,
          },
          id: { type: 'string', description: 'revert 要回退的历史记录 id，省略则回退最近一条' },
        },
        additionalProperties: false,
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute(args) {
        const action = args?.action ?? 'list'
        if (action === 'probe') {
          const verdict = await probe(args.provider, args.model, {
            attempts: args.attempts,
            timeoutMs: args.timeoutMs,
          })
          return JSON.parse(JSON.stringify(verdict))
        }
        if (action === 'apply') return JSON.parse(JSON.stringify(await applySelection(args)))
        if (action === 'erase') return JSON.parse(JSON.stringify(await eraseSelection(args)))
        if (action === 'revert') return JSON.parse(JSON.stringify(await revert(args)))
        return JSON.parse(JSON.stringify(await state()))
      },
    }))
  })

  // Client-facing routes (loopback only).
  ctx.inject(['webServer'], (webCtx) => {
    const json = (res, statusCode, body) => {
      const payload = JSON.stringify(body)
      res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(payload),
        'Cache-Control': 'no-store',
      })
      res.end(payload)
    }
    const loopback = (req) => {
      const origin = req.headers.origin
      if (origin === undefined) return true
      try {
        const { hostname } = new URL(String(origin))
        return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1'
      } catch {
        return false
      }
    }
    const readBody = (req) => new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 64 * 1024) {
          reject(new Error('请求体过大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

    const route = (path, handler) => webCtx.webServer.register({
      kind: 'exact',
      path,
      handler: async (req, res) => {
        if (!loopback(req)) return json(res, 403, { error: 'origin-not-trusted' })
        try {
          await handler(req, res)
        } catch (error) {
          json(res, 500, { error: 'failed', message: messageOf(error) })
        }
      },
    })

    webCtx.effect(() => {
      const disposers = []
      disposers.push(route('/plugins/model-vision-picker/state', async (req, res) => {
        if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' })
        json(res, 200, await state())
      }))
      disposers.push(route('/plugins/model-vision-picker/probe', async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const body = JSON.parse((await readBody(req)).trim() || '{}')
        json(res, 200, await probe(body.provider, body.model, body))
      }))
      disposers.push(route('/plugins/model-vision-picker/apply', async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const body = JSON.parse((await readBody(req)).trim() || '{}')
        json(res, 200, await applySelection(body))
      }))
      disposers.push(route('/plugins/model-vision-picker/erase', async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const body = JSON.parse((await readBody(req)).trim() || '{}')
        json(res, 200, await eraseSelection(body))
      }))
      disposers.push(route('/plugins/model-vision-picker/revert', async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const body = JSON.parse((await readBody(req)).trim() || '{}')
        json(res, 200, await revert(body))
      }))
      return () => {
        for (const dispose of disposers) dispose()
      }
    })
  })
}
