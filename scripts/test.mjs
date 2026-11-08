// Integration tests for the compiled dsh-meow-push artifacts.
//
// Everything runs against lib/*.js plus a local HTTP fixture server: no request
// ever leaves the machine and no real MeoW push is issued. The fixture server
// records every request, so "preview sent nothing" and "a 302 was not followed"
// are observed rather than assumed.
//
// Usage: node scripts/test.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import {
  RateLedger,
  buildRequest,
  classify,
  createTools,
  encodePairs,
  normalizeBaseUrl,
  resolveConfig,
  resolveSendOptions,
  rfc3986,
  toEnvelope,
  UsageError,
} from '../lib/internals.js'
import { apply, PROMPT_SECTION_NAME } from '../lib/index.js'

// ── Tiny harness ────────────────────────────────────────────────────────────

let passed = 0
const failures = []

/** Run one named check. */
async function test(name, body) {
  try {
    await body()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`FAIL  ${name}`)
    console.log(`      ${error instanceof Error ? error.message.split('\n').join('\n      ') : String(error)}`)
  }
}

/** Assert that `body` throws a UsageError whose message matches `pattern`. */
function expectUsageError(body, pattern) {
  try {
    body()
  } catch (error) {
    assert.ok(error instanceof UsageError, `expected UsageError, got ${error?.name ?? typeof error}`)
    assert.match(error.message, pattern)
    return
  }
  throw new Error('expected a UsageError, but nothing was thrown')
}

// ── Fixture server ──────────────────────────────────────────────────────────

const hits = []

const server = http.createServer((request, response) => {
  let body = ''
  request.setEncoding('utf8')
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    const url = new URL(request.url ?? '/', 'http://fixture.local')
    hits.push({ method: request.method, pathname: url.pathname, search: url.search, headers: request.headers, body })

    /** Write one JSON envelope. */
    const send = (status, payload) => {
      const text = JSON.stringify(payload)
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(text)
    }

    if (url.pathname === '/') {
      send(200, { status: 200, data: true, msg: 'fixture root' })
      return
    }
    if (url.pathname.includes('Ghost')) {
      send(200, { status: 404, data: false, msg: '昵称未注册' })
      return
    }
    if (url.pathname.includes('Contradict')) {
      send(200, { status: 200, data: false, msg: '发送失败' })
      return
    }
    if (url.pathname.includes('Fail')) {
      send(200, { status: 500, data: false, msg: '服务器错误' })
      return
    }
    if (url.pathname.includes('Redirect')) {
      response.writeHead(302, { Location: '/' })
      response.end()
      return
    }
    if (url.pathname.includes('Boom')) {
      response.writeHead(502, { 'Content-Type': 'text/html' })
      response.end('<html>bad gateway</html>')
      return
    }
    if (url.pathname.includes('Slow')) {
      // Longer than the minimum configurable timeout (1000 ms), so the client
      // gives up first.
      setTimeout(() => send(200, { status: 200, data: true, msg: 'late' }), 1_600)
      return
    }
    if (url.pathname.startsWith('/foreign')) {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<html>not the API</html>')
      return
    }
    if (url.pathname.startsWith('/mirror')) {
      response.writeHead(404, { 'Content-Type': 'text/html' })
      response.end('<html>nope</html>')
      return
    }
    send(200, { status: 200, data: true, msg: '发送成功' })
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
const baseUrl = `http://127.0.0.1:${port}`
console.log(`fixture server on ${baseUrl}\n`)

// ── Fake Cordis context ─────────────────────────────────────────────────────

/** Build a context that records what a plugin registers. */
function makeContext() {
  const tools = []
  const sections = []
  const disposers = []
  const context = {
    tools: {
      register(tool) {
        tools.push(tool)
        return () => {}
      },
    },
    effect(callback, label) {
      const disposer = callback()
      disposers.push({ label, disposer })
      return () => {}
    },
    get(name) {
      if (name !== 'systemPrompt') return undefined
      return {
        section(section) {
          sections.push(section)
          return () => {}
        },
        getSectionOrder() {
          return 42
        },
      }
    },
  }
  return { context, tools, sections, disposers }
}

/** Mount the plugin against the fixture server. */
function mount(overrides = {}) {
  const harness = makeContext()
  apply(harness.context, {
    baseUrl,
    allowHttp: true,
    timeoutMs: 5_000,
    minSendIntervalMs: 0,
    ...overrides,
  })
  const byName = (name) => {
    const tool = harness.tools.find((entry) => entry.name === name)
    assert.ok(tool, `tool ${name} was not registered`)
    return tool
  }
  return { ...harness, byName, signal: () => new AbortController().signal }
}

/** Assert that every required schema key exists with a compatible value. */
function assertValueShape(schema, value, path = 'value') {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((branch) => {
      try {
        assertValueShape(branch, value, path)
        return true
      } catch {
        return false
      }
    })
    assert.equal(matches.length, 1, `${path} must match exactly one branch, matched ${matches.length}`)
    return
  }
  if (schema.enum) assert.ok(schema.enum.includes(value), `${path}=${JSON.stringify(value)} not in enum`)
  switch (schema.type) {
    case 'object': {
      assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value), `${path} must be an object`)
      for (const key of schema.required ?? []) assert.ok(key in value, `${path}.${key} is required`)
      for (const [key, child] of Object.entries(schema.properties ?? {})) {
        if (key in value) assertValueShape(child, value[key], `${path}.${key}`)
      }
      assert.equal(
        Object.keys(value).length,
        Object.keys(schema.properties ?? {}).length,
        `${path} has unexpected keys: ${Object.keys(value).join(', ')}`,
      )
      return
    }
    case 'string':
      assert.equal(typeof value, 'string', `${path} must be a string`)
      return
    case 'integer':
      assert.ok(Number.isInteger(value), `${path} must be an integer`)
      return
    case 'boolean':
      assert.equal(typeof value, 'boolean', `${path} must be a boolean`)
      return
    case 'null':
      assert.equal(value, null, `${path} must be null`)
      return
    case 'array':
      assert.ok(Array.isArray(value), `${path} must be an array`)
      return
    default:
      return
  }
}

/** Call one tool and validate its returned value against its own schema. */
async function callTool(tool, args, signal) {
  const value = await tool.execute(args, { signal })
  assertValueShape(tool.output.schema, value)
  const blocks = tool.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, 'render must return content blocks')
  assert.equal(blocks[0].type, 'text')
  assert.ok(blocks[0].text.length > 0)
  return value
}

// ── Pure request construction ───────────────────────────────────────────────

const config = resolveConfig({ baseUrl, allowHttp: true })

console.log('request builder')

await test('POST JSON puts msgType in the query and title/msg in the body', () => {
  const options = resolveSendOptions({ to: 'Chuck', msg: '部署完成', title: '系统通知' }, config)
  const { request } = buildRequest(options)
  assert.equal(request.method, 'POST')
  assert.equal(request.url, `${baseUrl}/Chuck/%E7%B3%BB%E7%BB%9F%E9%80%9A%E7%9F%A5?msgType=text`)
  assert.equal(request.headers['Content-Type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(request.body), { title: '系统通知', msg: '部署完成' })
})

await test('msgType=html adds htmlHeight (default 200) to the query only', () => {
  const options = resolveSendOptions({ to: 'Chuck', msg: '<b>hi</b>', msgType: 'html' }, config)
  const { request } = buildRequest(options)
  assert.match(request.url, /\?msgType=html&htmlHeight=200$/)
  assert.deepEqual(JSON.parse(request.body), { title: 'MeoW', msg: '<b>hi</b>' })
})

await test('a custom htmlHeight is honoured and clamped to an integer', () => {
  const options = resolveSendOptions({ to: 'Chuck', msg: 'x', msgType: 'html', htmlHeight: 320.4 }, config)
  assert.match(buildRequest(options).request.url, /htmlHeight=320$/)
})

await test('htmlHeight is ignored for msgType=text', () => {
  const options = resolveSendOptions({ to: 'Chuck', msg: 'x', htmlHeight: 320 }, config)
  assert.equal(options.htmlHeight, undefined)
  assert.doesNotMatch(buildRequest(options).request.url, /htmlHeight/)
})

await test('GET puts nickname/title/msg in separate encoded path segments', () => {
  const options = resolveSendOptions({ to: '小明', msg: '你好/世界', title: 'T', method: 'get' }, config)
  const { request } = buildRequest(options)
  assert.equal(request.method, 'GET')
  assert.equal(request.body, undefined)
  assert.equal(request.url, `${baseUrl}/${rfc3986('小明')}/T/${rfc3986('你好/世界')}?msgType=text`)
  assert.ok(!request.url.includes('你好/世界'), 'the raw message must not appear in the URL')
})

await test('GET carries url/imgUrl as query parameters', () => {
  const options = resolveSendOptions(
    { to: 'A', msg: 'm', method: 'get', url: 'https://example.com/x?a=1', imgUrl: 'https://example.com/i.png' },
    config,
  )
  const { request } = buildRequest(options)
  assert.match(request.url, /msgType=text&url=https%3A%2F%2Fexample\.com%2Fx%3Fa%3D1&imgUrl=/)
})

await test('the text/plain format sends the raw message as the body', () => {
  const options = resolveSendOptions({ to: 'A', msg: 'line1\nline2', format: 'text' }, config)
  const { request } = buildRequest(options)
  assert.equal(request.body, 'line1\nline2')
  assert.equal(request.headers['Content-Type'], 'text/plain; charset=utf-8')
})

await test('the form format encodes title/msg as a form body', () => {
  const options = resolveSendOptions({ to: 'A', msg: 'a b', title: 'T', format: 'form' }, config)
  const { request } = buildRequest(options)
  assert.equal(request.body, encodePairs([['title', 'T'], ['msg', 'a b']]))
})

await test('percent-encoding leaves no unreserved character escaped', () => {
  assert.equal(rfc3986("A-Z a_z.~0!'()*"), 'A-Z%20a_z.~0%21%27%28%29%2A')
  assert.equal(encodePairs([['k', 'a b']]), 'k=a%20b')
})

await test('a path-bearing base URL still passes the rewrite guard', () => {
  const prefixed = resolveConfig({ baseUrl: `${baseUrl}/api`, allowHttp: true })
  const options = resolveSendOptions({ to: 'Chuck', msg: 'x' }, prefixed)
  assert.equal(buildRequest(options).request.url, `${baseUrl}/api/Chuck/MeoW?msgType=text`)
})

await test('a long GET URL is reported, not failed', () => {
  const options = resolveSendOptions({ to: 'A', msg: 'x'.repeat(2_000), method: 'get' }, config)
  const { warnings } = buildRequest(options)
  assert.equal(warnings[0]?.code, 'long_get_url')
})

console.log('\nargument validation')

await test('missing or blank msg is a usage error', () => {
  expectUsageError(() => resolveSendOptions({ to: 'A' }, config), /"msg" is required/)
  expectUsageError(() => resolveSendOptions({ to: 'A', msg: '   ' }, config), /cannot be empty/)
})

await test('a nickname containing "/" is refused', () => {
  expectUsageError(() => resolveSendOptions({ to: 'a/b', msg: 'x' }, config), /cannot contain/)
})

await test('"." and ".." path segments are refused', () => {
  expectUsageError(() => resolveSendOptions({ to: '..', msg: 'x' }, config), /cannot be "\." or "\.\."/)
  expectUsageError(() => resolveSendOptions({ to: 'A', title: '.', msg: 'x' }, config), /cannot be "\." or "\.\."/)
  expectUsageError(() => resolveSendOptions({ to: 'A', msg: '..', method: 'get' }, config), /cannot be "\."/)
})

await test('control characters in a nickname are refused', () => {
  expectUsageError(() => resolveSendOptions({ to: 'a\nb', msg: 'x' }, config), /control character/)
})

await test('url/imgUrl must be absolute http(s)', () => {
  expectUsageError(() => resolveSendOptions({ to: 'A', msg: 'x', url: 'example.com' }, config), /not an absolute URL/)
  expectUsageError(() => resolveSendOptions({ to: 'A', msg: 'x', url: 'ftp://example.com' }, config), /http\(s\)/)
  expectUsageError(() => resolveSendOptions({ to: 'A', msg: 'x', imgUrl: 'https://e.com/a b.png' }, config), /whitespace/)
})

await test('htmlHeight outside 1..1000000 is refused', () => {
  expectUsageError(
    () => resolveSendOptions({ to: 'A', msg: 'x', msgType: 'html', htmlHeight: 0 }, config),
    /between 1 and 1000000/,
  )
})

await test('unknown msgType/method/format values are refused', () => {
  expectUsageError(() => resolveSendOptions({ to: 'A', msg: 'x', msgType: 'markdown' }, config), /msgType" must be one of/)
  expectUsageError(() => resolveSendOptions({ to: 'A', msg: 'x', method: 'put' }, config), /method" must be one of/)
  expectUsageError(() => resolveSendOptions({ to: 'A', msg: 'x', format: 'xml' }, config), /format" must be one of/)
})

await test('plain HTTP is refused unless allowHttp is set', () => {
  expectUsageError(() => normalizeBaseUrl('http://127.0.0.1:1', false), /refusing plain HTTP/)
  assert.equal(normalizeBaseUrl('http://127.0.0.1:1/', true), 'http://127.0.0.1:1')
  expectUsageError(() => normalizeBaseUrl('ftp://x', true), /must be http\(s\)/)
})

await test('config defaults and clamps are applied', () => {
  const resolved = resolveConfig({ timeoutMs: 5, minSendIntervalMs: -1, baseUrl: 'https://example.com///' })
  assert.equal(resolved.timeoutMs, 1_000)
  assert.equal(resolved.minSendIntervalMs, 0)
  assert.equal(resolved.baseUrl, 'https://example.com')
  assert.equal(resolved.defaultTitle, 'MeoW')
  assert.equal(resolved.allowHttp, false)
})

// ── Classification matrix ───────────────────────────────────────────────────

console.log('\nresponse classification')

const envelope = (status, data, msg = '') =>
  JSON.stringify(data === undefined ? { status, msg } : { status, data, msg })

await test('business 200 + data=true is a confirmed success', () => {
  const result = classify(200, envelope(200, true, '发送成功'))
  assert.equal(result.outcome, 'success')
  assert.equal(result.confirmed, true)
  assert.equal(result.serverMessage, '发送成功')
  assert.equal(result.serverStatus, 200)
})

await test('business 200 without data is an unconfirmed success', () => {
  const result = classify(200, envelope(200, undefined))
  assert.equal(result.outcome, 'success')
  assert.equal(result.confirmed, false)
  assert.equal(result.reason, 'success_without_data_field')
})

await test('business 200 with data=false is not success', () => {
  const result = classify(200, envelope(200, false))
  assert.equal(result.outcome, 'unconfirmed')
  assert.equal(result.confirmed, false)
  assert.equal(result.reason, 'status_200_data_false')
})

await test('400/403/404 are terminal rejections', () => {
  for (const status of [400, 403, 404]) {
    const result = classify(200, envelope(status, false))
    assert.equal(result.outcome, 'rejected')
    assert.equal(result.reason, `business_${status}`)
  }
})

await test('429 at either layer is rate limiting', () => {
  assert.equal(classify(429, '').outcome, 'rate_limited')
  assert.equal(classify(429, '').reason, 'http_rate_limited')
  assert.equal(classify(200, envelope(429, false)).reason, 'business_429')
})

await test('5xx and non-JSON replies are unknown, never success', () => {
  assert.equal(classify(502, 'oops').reason, 'http_server_error')
  assert.equal(classify(200, envelope(500, false)).reason, 'business_500')
  assert.equal(classify(200, '<html/>').reason, 'non_json_response')
  assert.equal(classify(200, '').reason, 'non_json_response')
  assert.equal(classify(200, null).reason, 'no_response_body')
  assert.equal(classify(200, '{"foo":1}').reason, 'unrecognised_envelope')
  assert.equal(classify(200, '{"msg":"x"}').reason, 'missing_business_status')
})

await test('a redirect is reported and never treated as delivered', () => {
  const result = classify(302, '')
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.reason, 'redirect_not_followed')
  assert.equal(classify(0, null).reason, 'redirect_not_followed')
})

await test('HTTP 4xx beside business 200 is an intermediary, not a success', () => {
  const result = classify(404, envelope(200, true))
  assert.equal(result.outcome, 'unknown')
  assert.equal(result.reason, 'http_status_conflict')
})

await test('a legacy "message" field is still read', () => {
  assert.equal(toEnvelope({ status: 200, message: 'ok' })?.message, 'ok')
  assert.equal(toEnvelope({ nothing: true }), null)
})

// ── Local throttle ──────────────────────────────────────────────────────────

console.log('\nlocal throttle')

await test('the minimum interval defers an immediate second push', () => {
  let now = 1_000
  const ledger = new RateLedger({ minIntervalMs: 3_000, perMinute: 15, perHour: 60, perDay: 1_000 }, () => now)
  assert.equal(ledger.peek().allowed, true)
  ledger.record()
  const blocked = ledger.peek()
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.reason, 'local_min_interval')
  assert.equal(blocked.waitMs, 3_000)
  now += 3_000
  assert.equal(ledger.peek().allowed, true)
})

await test('the per-minute budget is enforced with the wait it implies', () => {
  let now = 0
  const ledger = new RateLedger({ minIntervalMs: 0, perMinute: 3, perHour: 100, perDay: 1_000 }, () => now)
  for (let index = 0; index < 3; index += 1) {
    assert.equal(ledger.peek().allowed, true)
    ledger.record()
    now += 1_000
  }
  const blocked = ledger.peek()
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.reason, 'local_rate_window')
  assert.ok(blocked.waitMs > 0 && blocked.waitMs <= 60_000)
  now += blocked.waitMs
  assert.equal(ledger.peek().allowed, true)
})

await test('reset clears the ledger', () => {
  const ledger = new RateLedger({ minIntervalMs: 3_000, perMinute: 1, perHour: 1, perDay: 1 })
  ledger.record()
  ledger.reset()
  assert.equal(ledger.peek().allowed, true)
})

// ── Plugin wiring and end-to-end exchange ───────────────────────────────────

console.log('\nplugin wiring and end-to-end exchange')

await test('three tools and one prompt section are registered', () => {
  const harness = mount()
  assert.deepEqual(
    harness.tools.map((tool) => tool.name),
    ['meow_push', 'meow_push_preview', 'meow_push_doctor'],
  )
  assert.equal(harness.sections.length, 1)
  assert.equal(harness.sections[0].name, PROMPT_SECTION_NAME)
  assert.equal(harness.sections[0].order, 43)
  assert.match(harness.sections[0].text, /meow_push_preview/)
  assert.equal(harness.disposers.length, 4)
})

await test('meow_push performs one POST and reports a confirmed success', async () => {
  const harness = mount()
  const before = hits.length
  const value = await callTool(
    harness.byName('meow_push'),
    { to: 'Chuck', msg: '部署完成', title: '系统通知' },
    harness.signal(),
  )
  assert.equal(value.outcome, 'success')
  assert.equal(value.sent, true)
  assert.equal(value.confirmed, true)
  assert.equal(value.serverMessage, '发送成功')
  assert.equal(hits.length, before + 1)
  const hit = hits.at(-1)
  assert.equal(hit.method, 'POST')
  assert.equal(hit.pathname, `/Chuck/${rfc3986('系统通知')}`)
  assert.equal(hit.search, '?msgType=text')
  assert.match(hit.headers['content-type'], /application\/json/)
  assert.deepEqual(JSON.parse(hit.body), { title: '系统通知', msg: '部署完成' })
})

await test('meow_push sends HTML with the documented height in the query', async () => {
  const harness = mount()
  const value = await callTool(
    harness.byName('meow_push'),
    { to: 'Chuck', msg: '<h1>hi</h1>', msgType: 'html', htmlHeight: 360, imgUrl: 'https://e.com/i.png' },
    harness.signal(),
  )
  assert.equal(value.outcome, 'success')
  assert.equal(hits.at(-1).search, '?msgType=html&htmlHeight=360')
  const body = JSON.parse(hits.at(-1).body)
  assert.equal(body.msg, '<h1>hi</h1>')
  assert.equal(body.imgUrl, 'https://e.com/i.png')
})

await test('meow_push can send over GET without a body', async () => {
  const harness = mount()
  const value = await callTool(
    harness.byName('meow_push'),
    { to: 'Chuck', msg: 'hello world', method: 'get' },
    harness.signal(),
  )
  assert.equal(value.outcome, 'success')
  assert.equal(hits.at(-1).method, 'GET')
  assert.equal(hits.at(-1).body, '')
  assert.equal(hits.at(-1).pathname, `/Chuck/MeoW/${rfc3986('hello world')}`)
})

await test('meow_push_preview sends nothing and echoes the exact request', async () => {
  const harness = mount()
  const before = hits.length
  const value = await callTool(harness.byName('meow_push_preview'), { to: 'Chuck', msg: 'preview me' }, harness.signal())
  assert.equal(hits.length, before, 'a preview must not touch the network')
  assert.equal(value.outcome, 'preview')
  assert.equal(value.sent, false)
  assert.equal(value.request.method, 'POST')
  assert.match(value.request.url, /\/Chuck\/MeoW\?msgType=text$/)
  assert.deepEqual(JSON.parse(value.request.body), { title: 'MeoW', msg: 'preview me' })
})

await test('a 404 business status becomes a rejected outcome', async () => {
  const harness = mount()
  const value = await callTool(harness.byName('meow_push'), { to: 'Ghost', msg: 'x' }, harness.signal())
  assert.equal(value.outcome, 'rejected')
  assert.equal(value.reason, 'business_404')
  assert.equal(value.serverMessage, '昵称未注册')
})

await test('status 200 with data=false is never reported as success', async () => {
  const harness = mount()
  const value = await callTool(harness.byName('meow_push'), { to: 'Contradict', msg: 'x' }, harness.signal())
  assert.equal(value.outcome, 'unconfirmed')
  assert.equal(value.confirmed, false)
  assert.equal(value.reason, 'status_200_data_false')
})

await test('business 500 becomes an unknown outcome', async () => {
  const harness = mount()
  const value = await callTool(harness.byName('meow_push'), { to: 'Fail', msg: 'x' }, harness.signal())
  assert.equal(value.outcome, 'unknown')
  assert.equal(value.reason, 'business_500')
})

await test('a redirect is not followed and is reported as unknown', async () => {
  const harness = mount()
  const before = hits.length
  const value = await callTool(harness.byName('meow_push'), { to: 'Redirect', msg: 'x' }, harness.signal())
  assert.equal(value.outcome, 'unknown')
  assert.equal(value.reason, 'redirect_not_followed')
  assert.equal(hits.length, before + 1, 'exactly one request, no follow-up to Location')
  assert.equal(hits.at(-1).pathname, '/Redirect/MeoW')
})

await test('an HTML 502 body becomes an unknown outcome', async () => {
  const harness = mount()
  const value = await callTool(harness.byName('meow_push'), { to: 'Boom', msg: 'x' }, harness.signal())
  assert.equal(value.outcome, 'unknown')
  assert.equal(value.reason, 'http_server_error')
})

await test('the local throttle refuses to send and reports waitMs', async () => {
  const harness = mount({ minSendIntervalMs: 5_000 })
  const tool = harness.byName('meow_push')
  const first = await callTool(tool, { to: 'Chuck', msg: 'one' }, harness.signal())
  assert.equal(first.outcome, 'success')
  const before = hits.length
  const second = await callTool(tool, { to: 'Chuck', msg: 'two' }, harness.signal())
  assert.equal(second.outcome, 'deferred')
  assert.equal(second.sent, false)
  assert.equal(second.reason, 'local_min_interval')
  assert.ok(second.waitMs > 0 && second.waitMs <= 5_000)
  assert.equal(hits.length, before, 'a deferred push must not reach the network')
})

await test('a timeout is reported as unknown and not retried', async () => {
  const harness = mount({ timeoutMs: 1_000 })
  const tool = harness.byName('meow_push')
  const before = hits.length
  const value = await callTool(tool, { to: 'Slow', msg: 'x' }, harness.signal())
  assert.equal(value.outcome, 'unknown')
  assert.equal(value.reason, 'timeout')
  assert.equal(hits.length, before + 1, 'exactly one attempt')
})

await test('a cancelled step aborts before any request', async () => {
  const harness = mount()
  const controller = new AbortController()
  controller.abort()
  const before = hits.length
  await assert.rejects(
    () => harness.byName('meow_push').execute({ to: 'Chuck', msg: 'x' }, { signal: controller.signal }),
    /cancelled/,
  )
  assert.equal(hits.length, before)
})

await test('a caller mistake throws before any request', async () => {
  const harness = mount()
  const before = hits.length
  await assert.rejects(
    () => harness.byName('meow_push').execute({ to: 'Chuck' }, { signal: harness.signal() }),
    /"msg" is required/,
  )
  assert.equal(hits.length, before)
})

await test('meow_push_doctor reports settings and skips the probe by default', async () => {
  const harness = mount()
  const before = hits.length
  const value = await callTool(harness.byName('meow_push_doctor'), {}, harness.signal())
  assert.equal(value.probed, false)
  assert.equal(value.reachable, null)
  assert.equal(value.baseUrl, baseUrl)
  assert.equal(value.minSendIntervalMs, 0)
  assert.equal(hits.length, before, 'no probe was requested')
})

await test('meow_push_doctor probes the API root without pushing', async () => {
  const harness = mount()
  const before = hits.length
  const value = await callTool(harness.byName('meow_push_doctor'), { probe: true }, harness.signal())
  assert.equal(value.probed, true)
  assert.equal(value.reachable, true)
  assert.equal(value.probeHttpStatus, 200)
  assert.equal(value.probeServerStatus, 200)
  assert.equal(hits.length, before + 1)
  assert.equal(hits.at(-1).pathname, '/')
})

await test('meow_push_doctor explains an unusable base URL', async () => {
  const harness = mount({ baseUrl: 'not a url', allowHttp: true })
  const value = await callTool(harness.byName('meow_push_doctor'), { probe: true }, harness.signal())
  assert.equal(value.ok, false)
  assert.equal(value.probed, false)
  assert.match(value.detail, /not a valid URL/)
})

await test('a 2xx root page without the envelope leaves reachability unknown, not failed', async () => {
  // The real api.chuckfang.com root serves its HTML documentation with HTTP 200.
  const harness = mount({ baseUrl: `${baseUrl}/foreign` })
  const value = await callTool(harness.byName('meow_push_doctor'), { probe: true }, harness.signal())
  assert.equal(value.ok, true)
  assert.equal(value.reachable, null)
  assert.equal(value.probeHttpStatus, 200)
  assert.match(value.detail, /HTML documentation/)
})

await test('an error reply without the envelope marks the base URL as foreign', async () => {
  const harness = mount({ baseUrl: `${baseUrl}/mirror` })
  const value = await callTool(harness.byName('meow_push_doctor'), { probe: true }, harness.signal())
  assert.equal(value.ok, false)
  assert.equal(value.reachable, false)
  assert.equal(value.probeHttpStatus, 404)
  assert.match(value.detail, /does not look like the MeoW API/)
})

await test('meow_push_doctor refuses plain http unless allowed', async () => {
  const harness = mount({ allowHttp: false })
  const value = await callTool(harness.byName('meow_push_doctor'), {}, harness.signal())
  assert.equal(value.ok, false)
  assert.match(value.detail, /refusing plain HTTP/)
})

await test('meow_push escapes nothing when the message contains spaces and CJK', async () => {
  const harness = mount()
  const value = await callTool(harness.byName('meow_push'), { to: '小明', msg: '服务 部署 完成 ✅' }, harness.signal())
  assert.equal(value.outcome, 'success')
  assert.equal(hits.at(-1).pathname, `/${rfc3986('小明')}/MeoW`)
  assert.equal(JSON.parse(hits.at(-1).body).msg, '服务 部署 完成 ✅')
})

// ── Report ──────────────────────────────────────────────────────────────────

await new Promise((resolve) => server.close(resolve))

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) {
  for (const failure of failures) {
    console.log(`\n--- ${failure.name}`)
    console.log(failure.error instanceof Error ? failure.error.stack : String(failure.error))
  }
  process.exitCode = 1
}
