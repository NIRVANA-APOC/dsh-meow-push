/**
 * Argument validation, percent-encoding and request construction.
 *
 * Everything in this module is pure: no network, no clock, no state. The same
 * builder backs `meow_push` and `meow_push_preview`, so a preview is byte-for-
 * byte the request a send would issue.
 *
 * Route shape (the only two documented push routes):
 *
 *   GET  /{nickname}/{title}/{msg}?msgType=…[&htmlHeight=…][&url=…][&imgUrl=…]
 *   POST /{nickname}/{title}?msgType=…[&htmlHeight=…]   body: JSON | form | raw
 *
 * `msgType` and `htmlHeight` are always query parameters — never body fields;
 * `title` always rides in the path, and JSON/form bodies repeat it because the
 * documented precedence is body > path > "MeoW".
 *
 * @module dsh-meow-push/request
 */

import type { ResolvedConfig } from './config'
import {
  DEFAULT_HTML_HEIGHT,
  HTTP_METHODS,
  MAX_HTML_HEIGHT,
  MAX_MESSAGE_LENGTH,
  MAX_NICKNAME_LENGTH,
  MAX_TITLE_LENGTH,
  MIN_HTML_HEIGHT,
  MSG_TYPES,
  POST_FORMATS,
  type BuiltRequest,
  type HttpMethod,
  type MsgType,
  type PostFormat,
  type SendOptions,
  type Warning,
} from './types'

/** Raised for a caller mistake: nothing was sent, and fixing the input helps. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UsageError'
  }
}

/** RFC 3986 unreserved characters; everything else is percent-encoded. */
const UNRESERVED = /^[A-Za-z0-9\-._~]$/

const encoder = new TextEncoder()

/** Control characters a path segment or URL must never carry. */
const CONTROL = /[\u0000-\u001f\u007f]/

/**
 * Percent-encode one path segment or query component (UTF-8, uppercase hex).
 *
 * `encodeURIComponent` leaves `!'()*` untouched, which some routers mishandle
 * inside path segments, so this encodes the RFC 3986 unreserved set only.
 */
export function rfc3986(value: string): string {
  let out = ''
  for (const ch of value) {
    if (UNRESERVED.test(ch)) {
      out += ch
      continue
    }
    for (const byte of encoder.encode(ch)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

/** Join `key=value` pairs with `&`, percent-encoding both sides. */
export function encodePairs(pairs: readonly (readonly [string, string])[]): string {
  return pairs.map(([key, value]) => `${rfc3986(key)}=${rfc3986(value)}`).join('&')
}

/**
 * Validate and normalise the API base URL.
 *
 * Plain HTTP is refused unless the deployment explicitly allows it, because the
 * message body travels in the clear.
 */
export function normalizeBaseUrl(raw: string, allowHttp: boolean): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new UsageError(`base URL is not a valid URL: ${JSON.stringify(raw)}`)
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new UsageError(`base URL must be http(s): ${JSON.stringify(raw)}`)
  }
  if (parsed.protocol === 'http:' && !allowHttp) {
    throw new UsageError(
      `refusing plain HTTP (${JSON.stringify(raw)}): the message body would travel in clear. ` +
        'Set config allowHttp: true only for a local fixture server; the real API is https://api.chuckfang.com',
    )
  }
  parsed.search = ''
  parsed.hash = ''
  return parsed.toString().replace(/\/+$/, '')
}

/**
 * The one URL that can be probed without delivering a message: the API root
 * carries no nickname, so a GET there cannot push anything.
 */
export function buildProbeUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/`
}

/** Read one argument as a string, or `undefined` when absent. */
function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new UsageError(`expected a string, got ${value === null ? 'null' : typeof value}`)
  }
  return value
}

/** Validate one path segment that must not be a relative-path token. */
function assertPathSegment(value: string, field: string): void {
  if (value === '.' || value === '..') {
    throw new UsageError(
      `${field} cannot be "." or "..": the WHATWG URL parser deletes such a path segment, ` +
        'so the request on the wire would differ from the validated one',
    )
  }
  if (CONTROL.test(value)) {
    throw new UsageError(`${field} contains a control character`)
  }
}

/** Validate and normalise one optional absolute http(s) URL. */
function normalizeHttpUrl(value: string, field: string): string {
  if (value.trim() !== value) {
    throw new UsageError(`${field} must not start or end with whitespace`)
  }
  if (/\s/.test(value)) throw new UsageError(`${field} must not contain whitespace`)
  if (CONTROL.test(value)) throw new UsageError(`${field} contains a control character`)
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new UsageError(`${field} is not an absolute URL: ${JSON.stringify(value)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UsageError(`${field} must be an absolute http(s) URL: ${JSON.stringify(value)}`)
  }
  return parsed.toString()
}

/** Resolve the nickname, rejecting anything the API cannot route. */
function resolveNickname(value: unknown): string {
  const raw = optionalString(value)
  if (raw === undefined || raw.trim() === '') {
    throw new UsageError('"to" is required: the registered MeoW nickname to push to')
  }
  const nickname = raw.trim()
  if (nickname.includes('/')) {
    throw new UsageError('"to" cannot contain "/": the nickname is one URL path segment')
  }
  if (nickname.length > MAX_NICKNAME_LENGTH) {
    throw new UsageError(`"to" is longer than ${MAX_NICKNAME_LENGTH} characters`)
  }
  assertPathSegment(nickname, '"to"')
  return nickname
}

/** Resolve the title, falling back to the configured default when omitted. */
function resolveTitle(value: unknown, fallback: string): string {
  const raw = optionalString(value)
  const title = raw === undefined || raw.trim() === '' ? fallback : raw.trim()
  if (title.length > MAX_TITLE_LENGTH) {
    throw new UsageError(`"title" is longer than ${MAX_TITLE_LENGTH} characters`)
  }
  assertPathSegment(title, '"title"')
  return title
}

/** Resolve the message, preserving the caller's text exactly. */
function resolveMessage(value: unknown): string {
  const raw = optionalString(value)
  if (raw === undefined) {
    throw new UsageError('"msg" is required: the message text to deliver')
  }
  if (raw.trim() === '') {
    throw new UsageError('"msg" cannot be empty or whitespace only')
  }
  if (raw.length > MAX_MESSAGE_LENGTH) {
    throw new UsageError(`"msg" is longer than ${MAX_MESSAGE_LENGTH} characters`)
  }
  return raw
}

/** Read one value from a fixed enum, case-insensitively for method names. */
function enumValue<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  field: string,
): T {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'string') throw new UsageError(`${field} must be a string`)
  const lowered = value.trim().toLowerCase()
  const match = allowed.find((entry) => entry.toLowerCase() === lowered)
  if (match === undefined) {
    throw new UsageError(`${field} must be one of ${allowed.join(', ')} (got ${JSON.stringify(value)})`)
  }
  return match
}

/** Resolve the HTML display height, which only `msgType=html` consumes. */
function resolveHtmlHeight(value: unknown, msgType: MsgType): number | undefined {
  if (msgType !== 'html') return undefined
  if (value === undefined || value === null) return DEFAULT_HTML_HEIGHT
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new UsageError('"htmlHeight" must be a number of pixels')
  }
  const rounded = Math.round(value)
  if (rounded < MIN_HTML_HEIGHT || rounded > MAX_HTML_HEIGHT) {
    throw new UsageError(
      `"htmlHeight" must be between ${MIN_HTML_HEIGHT} and ${MAX_HTML_HEIGHT} pixels`,
    )
  }
  return rounded
}

/**
 * Validate raw tool arguments into one complete {@link SendOptions}.
 *
 * @param args - Model-supplied arguments (untyped by design).
 * @param config - Deployment settings supplying the base URL and title default.
 * @throws UsageError when the caller's input cannot become a valid request.
 */
export function resolveSendOptions(
  args: Record<string, unknown>,
  config: ResolvedConfig,
): SendOptions {
  const msgType = enumValue<MsgType>(args.msgType, MSG_TYPES, 'text', '"msgType"')
  const method = enumValue<HttpMethod>(args.method, HTTP_METHODS, 'POST', '"method"')
  const format = enumValue<PostFormat>(args.format, POST_FORMATS, 'json', '"format"')
  const msg = resolveMessage(args.msg)
  if (method === 'GET') assertPathSegment(msg, '"msg"')

  const url = optionalString(args.url)
  const imgUrl = optionalString(args.imgUrl)

  return {
    nickname: resolveNickname(args.to),
    title: resolveTitle(args.title, config.defaultTitle),
    msg,
    url: url === undefined || url === '' ? undefined : normalizeHttpUrl(url, '"url"'),
    imgUrl: imgUrl === undefined || imgUrl === '' ? undefined : normalizeHttpUrl(imgUrl, '"imgUrl"'),
    msgType,
    htmlHeight: resolveHtmlHeight(args.htmlHeight, msgType),
    method,
    format,
    baseUrl: normalizeBaseUrl(config.baseUrl, config.allowHttp),
  }
}

/** Advisories that do not fail the request. */
function collectWarnings(options: SendOptions, url: string): Warning[] {
  const warnings: Warning[] = []
  if (options.method === 'GET' && url.length > 1800) {
    warnings.push({
      code: 'long_get_url',
      text:
        `GET URL is ${url.length} characters, close to the common 2 KB limit ` +
        '(CJK text costs 9 characters per glyph after percent-encoding). Use method "post" instead.',
    })
  }
  return warnings
}

/**
 * Materialise the exact HTTP request for one push.
 *
 * @param options - Fully validated options.
 * @returns The request plus non-fatal warnings.
 * @throws UsageError when URL normalisation would rewrite the validated path.
 */
export function buildRequest(options: SendOptions): {
  request: BuiltRequest
  warnings: Warning[]
} {
  const path =
    options.method === 'GET'
      ? `/${[options.nickname, options.title, options.msg].map(rfc3986).join('/')}`
      : `/${[options.nickname, options.title].map(rfc3986).join('/')}`

  const query: Array<[string, string]> = [['msgType', options.msgType]]
  if (options.msgType === 'html' && options.htmlHeight !== undefined) {
    query.push(['htmlHeight', String(options.htmlHeight)])
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  let body: string | undefined

  if (options.method === 'GET') {
    if (options.url !== undefined) query.push(['url', options.url])
    if (options.imgUrl !== undefined) query.push(['imgUrl', options.imgUrl])
  } else if (options.format === 'json') {
    const payload: Record<string, string> = { title: options.title, msg: options.msg }
    if (options.url !== undefined) payload.url = options.url
    if (options.imgUrl !== undefined) payload.imgUrl = options.imgUrl
    body = JSON.stringify(payload)
    headers['Content-Type'] = 'application/json; charset=utf-8'
  } else if (options.format === 'form') {
    const form: Array<[string, string]> = [
      ['title', options.title],
      ['msg', options.msg],
    ]
    if (options.url !== undefined) form.push(['url', options.url])
    if (options.imgUrl !== undefined) form.push(['imgUrl', options.imgUrl])
    body = encodePairs(form)
    headers['Content-Type'] = 'application/x-www-form-urlencoded; charset=utf-8'
  } else {
    // text/plain: the body *is* the message, so the title must ride in the path
    // and the optional url/imgUrl have to go in the query string.
    body = options.msg
    headers['Content-Type'] = 'text/plain; charset=utf-8'
    if (options.url !== undefined) query.push(['url', options.url])
    if (options.imgUrl !== undefined) query.push(['imgUrl', options.imgUrl])
  }

  const suffix = query.length > 0 ? `?${encodePairs(query)}` : ''
  const url = `${options.baseUrl}${path}${suffix}`

  // Safety net: the URL parser deletes a path segment that is exactly "." or
  // ".." (even percent-encoded, since %2E is decoded for that test), so the
  // request on the wire would silently differ from the one that was validated,
  // previewed and reported. Callers reject those upfront; this catches any
  // other rewriting, including a base URL that carries its own path.
  const parsed = new URL(url)
  const basePath = new URL(options.baseUrl).pathname.replace(/\/+$/, '')
  if (parsed.pathname !== `${basePath}${path}`) {
    throw new UsageError(
      `URL normalisation would rewrite the request path (built ${JSON.stringify(path)}, ` +
        `actual ${JSON.stringify(parsed.pathname)}). Check the nickname, title and message for ` +
        'relative path segments such as "." or "..".',
    )
  }

  return {
    request: { method: options.method, url, headers, body },
    warnings: collectWarnings(options, url),
  }
}
