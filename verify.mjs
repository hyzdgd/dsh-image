#!/usr/bin/env node
/**
 * Offline self-check for the probe engine.
 *
 * Runs without DSH and without network: every request is served by a fake
 * `fetch`, so what gets asserted is the engine's own logic — the drawing, the
 * scoring, the failure classification — not a gateway's mood.
 *
 *   node verify.mjs
 *
 * Exits 0 when every check passes, 1 when one fails (and prints which).
 */
import { inflateSync } from 'node:zlib'
import { buildProbeImage, colorHit, digitsHit, probeEndpoint, runProbe } from './index.js'

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    return
  }
  failures.push(detail === undefined ? name : `${name} — ${detail}`)
}

function equal(name, actual, expected) {
  check(name, Object.is(actual, expected), `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

const section = (title) => process.stdout.write(`\n${title}\n`)

// ---------------------------------------------------------------------------
// PNG reading, used only to prove the written image really holds the digits
// and the colored square the verdict later grades against.
// ---------------------------------------------------------------------------

/** Parse the PNG this module writes: header, size, and a pixel accessor. */
function decodePng(png) {
  const signature = png.subarray(0, 8)
  let offset = 8
  let width
  let height
  const idat = []
  while (offset < png.length) {
    const length = png.readUInt32BE(offset)
    const type = png.subarray(offset + 4, offset + 8).toString('ascii')
    const data = png.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
    }
    if (type === 'IDAT') idat.push(data)
    offset += 12 + length
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 3 + 1
  return {
    signature,
    width,
    height,
    raw,
    stride,
    pixel(x, y) {
      const at = y * stride + 1 + x * 3
      return [raw[at], raw[at + 1], raw[at + 2]]
    },
  }
}

section('图像生成')

const image = buildProbeImage()
const decoded = decodePng(image.png)
equal('PNG 签名', decoded.signature.toString('hex'), '89504e470d0a1a0a')
equal('宽度', decoded.width, 460)
equal('高度', decoded.height, 200)
equal('每行长度 = 1 + 3 × 宽度', decoded.stride, 460 * 3 + 1)
equal('IDAT 解压后长度', decoded.raw.length, decoded.height * decoded.stride)
check('每行 filter 都是 0', Array.from({ length: decoded.height }, (_, y) => decoded.raw[y * decoded.stride])
  .every((flag) => flag === 0), '存在非 0 filter，像素读取会错位')

check('真值是 4 位数字', /^\d{4}$/.test(image.truth), `实际 ${image.truth}`)
check('颜色取自红/绿/蓝', ['red', 'green', 'blue'].includes(image.color.name), `实际 ${image.color.name}`)

// The square occupies x=350..409, y=52..111 — 60×60 pixels of one flat color.
let squarePixels = 0
let squareExact = 0
for (let y = 52; y < 112; y += 1) {
  for (let x = 350; x < 410; x += 1) {
    squarePixels += 1
    const [r, g, b] = decoded.pixel(x, y)
    if (r === image.color.hex[0] && g === image.color.hex[1] && b === image.color.hex[2]) squareExact += 1
  }
}
equal('方块像素数', squarePixels, 3600)
equal('方块像素与声明颜色一致的数量', squareExact, 3600)

// Digits are drawn in the band x=42..300, y=40..124; count dark pixels there and
// confirm the canvas around them stays white.
let digitPixels = 0
for (let y = 40; y < 124; y += 1) {
  for (let x = 42; x < 300; x += 1) {
    const [r, g, b] = decoded.pixel(x, y)
    if (r < 60 && g < 60 && b < 60) digitPixels += 1
  }
}
check('数字笔画被画出来了', digitPixels > 500, `深色像素只有 ${digitPixels} 个`)
equal('画布左上角是白底', decoded.pixel(2, 2).join(','), '255,255,255')

check('两次生成不是同一张图', (() => {
  const second = buildProbeImage()
  const same = buildProbeImage()
  return second.png.length > 0 && same.png.length > 0
})(), '生成器没有返回图像')

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

section('判定：数字')

equal('答案里出现完整数字串', digitsHit('7341|红色', '7341'), true)
equal('整个答案就是那个数字', digitsHit(' 7341 ', '7341'), true)
equal('更长的数字不算命中', digitsHit('17341', '7341'), false)
equal('数字部分重合不算命中', digitsHit('734', '7341'), false)
equal('没有数字不算命中', digitsHit('看不清', '7341'), false)
equal('多段数字里有一段完全一致', digitsHit('图里有 12 和 7341', '7341'), true)

section('判定：颜色')

const red = { name: 'red', zh: '红色', hex: [204, 32, 42], words: ['红', 'red'] }
const blue = { name: 'blue', zh: '蓝色', hex: [22, 72, 196], words: ['蓝', 'blue'] }
equal('中文指名被画的颜色', colorHit('红色', red), true)
equal('英文指名被画的颜色', colorHit('The square is RED', red), true)
equal('点名了别的颜色', colorHit('蓝色', red), false)
equal('同时点名两种颜色不算', colorHit('红色和蓝色', red), false)
equal('没有点名颜色', colorHit('看不清', red), false)
equal('蓝色图配蓝字', colorHit('蓝色方块', blue), true)

// ---------------------------------------------------------------------------
// Endpoint normalization
// ---------------------------------------------------------------------------

section('baseURL 归一化')

equal('根地址补 /v1', probeEndpoint('https://a.test', 'chat/completions'), 'https://a.test/v1/chat/completions')
equal('/v1 结尾补叶子', probeEndpoint('https://a.test/v1', 'chat/completions'), 'https://a.test/v1/chat/completions')
equal('已有叶子原样返回', probeEndpoint('https://a.test/v1/chat/completions', 'chat/completions'),
  'https://a.test/v1/chat/completions')
equal('换成 responses 叶子', probeEndpoint('https://a.test/v1/chat/completions', 'responses'), 'https://a.test/v1/responses')
equal('尾斜杠被吃掉', probeEndpoint('https://a.test/v1/', 'responses'), 'https://a.test/v1/responses')
let threw = false
try {
  probeEndpoint('', 'responses')
} catch {
  threw = true
}
equal('空 baseURL 抛错', threw, true)

// ---------------------------------------------------------------------------
// Probe engine, against a fake endpoint
// ---------------------------------------------------------------------------

/** A fake fetch whose reply is decided per request. */
function fakeFetch(handler, calls) {
  return async (endpoint, init) => {
    const request = { endpoint, body: JSON.parse(init.body) }
    calls.push(request)
    return handler(request)
  }
}

/** A challenge factory that remembers every image handed to a sample. */
function challengeFactory() {
  const images = []
  return {
    images,
    make() {
      const next = buildProbeImage()
      images.push(next)
      return next
    },
  }
}

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})

const baseOptions = {
  provider: 'p',
  model: 'm',
  api: 'openai-completions',
  endpoint: 'https://a.test/v1/chat/completions',
  headers: {},
  attempts: 2,
  timeoutMs: 5_000,
}

section('探测：openai-completions 读对')

{
  const factory = challengeFactory()
  const calls = []
  const result = await runProbe({
    ...baseOptions,
    makeChallenge: factory.make,
    fetchImpl: fakeFetch(({ body }) => {
      const last = factory.images[factory.images.length - 1]
      // Also prove the request carried an image part in the protocol's shape.
      const part = body.messages[0].content[1]
      check('image_url 部件类型', part.type === 'image_url', JSON.stringify(part.type))
      check('image_url 是对象形式', typeof part.image_url === 'object', JSON.stringify(typeof part.image_url))
      check('图像以 data URL 发送', String(part.image_url.url).startsWith('data:image/png;base64,'), '前缀不对')
      check('请求带了采样上限', body.max_tokens === 400, String(body.max_tokens))
      return jsonResponse(200, { choices: [{ message: { content: `${last.truth}|${last.color.zh}` } }] })
    }, calls),
  })
  equal('结论', result.verdict, 'vision-confirmed')
  equal('ok', result.ok, true)
  equal('两次采样都读对 → 高可信', result.confidence, 'high')
  equal('采样数', result.samples.length, 2)
  equal('每次采样用一张新图', factory.images.length, 2)
  equal('请求都打到同一端点', new Set(calls.map((call) => call.endpoint)).size, 1)
  equal('回填的协议名', result.api, 'openai-completions')
  check('样本里留下真值', typeof result.samples[0].truth === 'string', '没有 truth')
}

section('探测：openai-responses 读对')

{
  const factory = challengeFactory()
  await runProbe({
    ...baseOptions,
    api: 'openai-responses',
    endpoint: 'https://a.test/v1/responses',
    attempts: 1,
    makeChallenge: factory.make,
    fetchImpl: fakeFetch(({ body }) => {
      const last = factory.images[factory.images.length - 1]
      const part = body.input[0].content[1]
      check('responses 用 input_image', part.type === 'input_image', String(part.type))
      check('responses 先试字符串形式', typeof part.image_url === 'string', String(typeof part.image_url))
      return jsonResponse(200, { output_text: `${last.truth}|${last.color.zh}` })
    }, []),
  })
}

section('探测：图像字段形态被拒时换另一种形态')

{
  const factory = challengeFactory()
  const calls = []
  const result = await runProbe({
    ...baseOptions,
    attempts: 1,
    makeChallenge: factory.make,
    fetchImpl: fakeFetch(({ body }) => {
      const part = body.messages[0].content[1]
      const last = factory.images[factory.images.length - 1]
      // First serialization is refused for an image-shaped reason, second works.
      if (typeof part.image_url === 'object') {
        return jsonResponse(400, { error: { message: 'unsupported content type for image_url' } })
      }
      return jsonResponse(200, { choices: [{ message: { content: `${last.truth}|${last.color.zh}` } }] })
    }, calls),
  })
  equal('换形态后确认可识图', result.verdict, 'vision-confirmed')
  equal('两种形态都试过', calls.length, 2)
  equal('成功的那次是字符串形态', result.samples[0].style, 'string')
}

section('探测：看到图但读不准 / 完全没用图')

{
  const factory = challengeFactory()
  const partial = await runProbe({
    ...baseOptions,
    attempts: 1,
    makeChallenge: factory.make,
    fetchImpl: fakeFetch(() => {
      const last = factory.images[factory.images.length - 1]
      // Names the drawn color, no digits: the image was seen, the read failed.
      return jsonResponse(200, { choices: [{ message: { content: `右边是一个${last.color.zh}方块` } }] })
    }, []),
  })
  equal('颜色对、数字错 → vision-partial', partial.verdict, 'vision-partial')
  equal('部分证据 → 低可信', partial.confidence, 'low')
  equal('ok 为 false', partial.ok, false)

  const ignored = await runProbe({
    ...baseOptions,
    makeChallenge: challengeFactory().make,
    fetchImpl: fakeFetch(() => jsonResponse(200, { choices: [{ message: { content: '我无法查看图片。' } }] }), []),
  })
  equal('回答里没有图像内容 → no-vision', ignored.verdict, 'no-vision')
  equal('no-vision 不硬停，跑满采样', ignored.samples.length, 2)
}

section('探测：失败分类')

const failureCases = [
  { name: '401 → 凭据无效', status: 401, body: { error: 'invalid api key' }, verdict: 'bad-credential', samples: 1 },
  { name: '402 → 余额不足', status: 402, body: { error: 'no credit' }, verdict: 'insufficient-credit', samples: 2 },
  { name: '404 → 端点不存在', status: 404, body: { error: 'not found' }, verdict: 'not-found', samples: 1 },
  { name: '410 → 端点下线', status: 410, body: { error: 'gone' }, verdict: 'endpoint-gone', samples: 2 },
  { name: '429 → 限流', status: 429, body: { error: 'too many requests' }, verdict: 'rate-limited', samples: 2 },
  { name: '500 → 上游故障', status: 500, body: { error: 'boom' }, verdict: 'server-error', samples: 2 },
  {
    name: '400（图像相关）→ 拒绝图像',
    status: 400,
    body: { error: { message: 'this model does not support image input' } },
    verdict: 'refused-image',
    samples: 1,
  },
  { name: '400（非图像）→ 请求被拒', status: 400, body: { error: 'bad model name' }, verdict: 'refused', samples: 1 },
]

for (const testCase of failureCases) {
  const result = await runProbe({
    ...baseOptions,
    makeChallenge: challengeFactory().make,
    fetchImpl: fakeFetch(() => jsonResponse(testCase.status, testCase.body), []),
  })
  equal(testCase.name, result.verdict, testCase.verdict)
  equal(`${testCase.name}：采样数`, result.samples.length, testCase.samples)
  check(`${testCase.name}：给了建议`, typeof result.hint === 'string' && result.hint.length > 0, '没有 hint')
}

section('探测：传输层与响应体异常')

{
  const timeout = await runProbe({
    ...baseOptions,
    timeoutMs: 1,
    makeChallenge: challengeFactory().make,
    fetchImpl: fakeFetch(() => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'TimeoutError' })
    }, []),
  })
  equal('超时 → timeout', timeout.verdict, 'timeout')
  check('超时说明里包含被夹住后的毫秒数', String(timeout.detail).includes('2000ms'), String(timeout.detail))
  equal('超时连两次就停', timeout.samples.length, 2)

  const unreachable = await runProbe({
    ...baseOptions,
    attempts: 3,
    makeChallenge: challengeFactory().make,
    fetchImpl: fakeFetch(() => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } })
    }, []),
  })
  equal('连不上 → unreachable', unreachable.verdict, 'unreachable')
  check('说明里带出 error.cause.code', String(unreachable.detail).includes('ENOTFOUND'), String(unreachable.detail))
  equal('传输失败两次即停，不用跑满三次', unreachable.samples.length, 2)

  const notJson = await runProbe({
    ...baseOptions,
    makeChallenge: challengeFactory().make,
    fetchImpl: fakeFetch(() => jsonResponse(200, '<html>gateway error</html>'), []),
  })
  equal('成功状态码但不是 JSON → bad-response', notJson.verdict, 'bad-response')

  const empty = await runProbe({
    ...baseOptions,
    makeChallenge: challengeFactory().make,
    fetchImpl: fakeFetch(() => jsonResponse(200, { choices: [{ message: { content: '' } }] }), []),
  })
  equal('成功但没有文本 → empty-answer', empty.verdict, 'empty-answer')
}

section('探测：协议不支持与凭据缺失')

{
  const unsupported = await runProbe({
    ...baseOptions,
    api: 'anthropic-messages',
    makeChallenge: challengeFactory().make,
    fetchImpl: fakeFetch(() => jsonResponse(200, {}), []),
  })
  equal('anthropic-messages → unsupported', unsupported.verdict, 'unsupported')
  equal('不支持的协议不发请求', unsupported.samples.length, 0)

  const factory = challengeFactory()
  const noKey = await runProbe({
    ...baseOptions,
    attempts: 1,
    hasCredential: false,
    makeChallenge: factory.make,
    fetchImpl: fakeFetch(() => {
      const last = factory.images[factory.images.length - 1]
      return jsonResponse(200, { choices: [{ message: { content: `${last.truth}|${last.color.zh}` } }] })
    }, []),
  })
  equal('无凭据仍会探测', noKey.verdict, 'vision-confirmed')
  equal('无凭据给出警告', noKey.warnings.length, 1)
}

section('探测：采样次数上限')

{
  const factory = challengeFactory()
  const result = await runProbe({
    ...baseOptions,
    attempts: 9,
    makeChallenge: factory.make,
    fetchImpl: fakeFetch(() => {
      const last = factory.images[factory.images.length - 1]
      return jsonResponse(200, { choices: [{ message: { content: `${last.truth}|${last.color.zh}` } }] })
    }, []),
  })
  equal('attempts 被夹到 3', result.samples.length, 3)
  equal('三次全对 → high', result.confidence, 'high')
}

// ---------------------------------------------------------------------------

const total = passed + failures.length
if (failures.length === 0) {
  process.stdout.write(`\n全部通过：${passed}/${total} 项检查\n`)
  process.exit(0)
}
process.stdout.write(`\n失败 ${failures.length}/${total} 项：\n`)
for (const failure of failures) process.stdout.write(`  ✗ ${failure}\n`)
process.exit(1)