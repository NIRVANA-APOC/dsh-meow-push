/**
 * Model-facing tool surface of `dsh-meow-push`.
 *
 * Three tools cover the whole MeoW channel:
 *
 *  - `meow_push`          — send one push (POST JSON by default);
 *  - `meow_push_preview`  — build and return the exact request, no network;
 *  - `meow_push_doctor`   — report settings and optionally probe the API root.
 *
 * Conventions shared with the first-party tools: arguments are validated
 * before any I/O, `execute` returns one canonical JSON value, `render` is a
 * pure text projection of that value, the calling step's abort signal is
 * honoured, and a push is never retried.
 *
 * @module dsh-meow-push/tools
 */

import { probe, sendPush } from './client'
import type { ResolvedConfig } from './config'
import type { HostContext, TextContentBlock, ToolDefinition, ToolRunContext } from './host'
import { RateLedger, DEFAULT_CAPS } from './rate'
import { buildRequest, normalizeBaseUrl, resolveSendOptions, UsageError } from './request'
import {
  MAX_BODY_PREVIEW,
  OUTCOMES,
  type BuiltRequest,
  type Classification,
  type DoctorReport,
  type PushReport,
  type RequestView,
} from './types'

/** Service dependencies shared by the three tools. */
export interface ToolDeps {
  config: ResolvedConfig
  ledger: RateLedger
}

/** Raw JSON Schema node (the registry stores plain JSON Schema). */
type SchemaNode = Record<string, unknown>

// ── Schema helpers ──────────────────────────────────────────────────────────

/** Object node with an explicit property list and required set. */
function objectNode(
  properties: Record<string, SchemaNode>,
  required: readonly string[] = [],
): SchemaNode {
  const node: SchemaNode = { type: 'object', additionalProperties: false, properties }
  if (required.length > 0) node.required = [...required]
  return node
}

/** Nullable scalar/object node. */
function nullable(node: SchemaNode): SchemaNode {
  return { oneOf: [node, { type: 'null' }] }
}

/** The request echo shared by the push reports. */
const REQUEST_SCHEMA = objectNode(
  {
    method: { type: 'string', enum: ['GET', 'POST'] },
    url: { type: 'string', description: 'Exact URL requested (or that would be requested).' },
    contentType: nullable({ type: 'string' }),
    body: nullable({ type: 'string', description: 'Request body, truncated for display.' }),
  },
  ['method', 'url', 'contentType', 'body'],
)

/** Canonical value of `meow_push` and `meow_push_preview`. */
const PUSH_REPORT_SCHEMA = objectNode(
  {
    outcome: {
      type: 'string',
      enum: [...OUTCOMES],
      description:
        'success|unconfirmed|rejected|rate_limited|deferred|unknown|preview. Branch on this.',
    },
    sent: { type: 'boolean', description: 'True only when an HTTP request was actually issued.' },
    confirmed: { type: 'boolean', description: 'True only when the server confirmed (data=true).' },
    reason: { type: 'string', description: 'Stable machine token; empty when none applies.' },
    httpStatus: nullable({ type: 'integer', description: 'Transport status; null when none.' }),
    serverStatus: nullable({ type: 'integer', description: 'Business status from the JSON envelope.' }),
    serverMessage: nullable({ type: 'string', description: 'Server-reported text, when present.' }),
    detail: { type: 'string', description: 'One-paragraph explanation for the caller.' },
    waitMs: nullable({ type: 'integer', description: 'Wait before retrying, for deferred outcomes.' }),
    request: REQUEST_SCHEMA,
  },
  [
    'outcome',
    'sent',
    'confirmed',
    'reason',
    'httpStatus',
    'serverStatus',
    'serverMessage',
    'detail',
    'waitMs',
    'request',
  ],
)

/** Canonical value of `meow_push_doctor`. */
const DOCTOR_REPORT_SCHEMA = objectNode(
  {
    ok: { type: 'boolean', description: 'True when the base URL is usable as configured.' },
    baseUrl: { type: 'string' },
    timeoutMs: { type: 'integer' },
    defaultTitle: { type: 'string' },
    minSendIntervalMs: { type: 'integer' },
    allowHttp: { type: 'boolean' },
    probed: { type: 'boolean', description: 'Whether the API root was actually requested.' },
    reachable: nullable({
      type: 'boolean',
      description:
        'true = documented envelope read, false = an error reply without one, null = unknown (transport ' +
        'failure, or a 2xx root page such as the API documentation).',
    }),
    probeHttpStatus: nullable({ type: 'integer' }),
    probeServerStatus: nullable({ type: 'integer' }),
    probeServerMessage: nullable({ type: 'string' }),
    detail: { type: 'string' },
  },
  [
    'ok',
    'baseUrl',
    'timeoutMs',
    'defaultTitle',
    'minSendIntervalMs',
    'allowHttp',
    'probed',
    'reachable',
    'probeHttpStatus',
    'probeServerStatus',
    'probeServerMessage',
    'detail',
  ],
)

/** Type-erasing constructor so each tool body stays concretely typed. */
interface ToolSpec<Value> {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render(args: unknown, value: Value): TextContentBlock[] }
  execute(args: unknown, exec: ToolRunContext): Promise<Value>
  timeoutMs?: number
}

/** Build one registry-ready definition from a concretely typed spec. */
function defineTool<Value>(spec: ToolSpec<Value>): ToolDefinition {
  const definition: ToolDefinition = {
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      schema: spec.output.schema,
      render: (args, value) => spec.output.render(args, value as Value),
    },
    execute: (args, exec) => spec.execute(args, exec),
  }
  if (spec.timeoutMs !== undefined) definition.timeoutMs = spec.timeoutMs
  return definition
}

// ── Argument helpers ────────────────────────────────────────────────────────

/** Read the tool arguments as a plain record; anything else is a caller bug. */
function asArgs(args: unknown): Record<string, unknown> {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    throw new UsageError('arguments must be an object')
  }
  return args as Record<string, unknown>
}

/** Truncate text for display. */
function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}… (${text.length - limit} more characters)`
}

/** Project a built request onto the report's request echo. */
function requestView(request: BuiltRequest): RequestView {
  return {
    method: request.method,
    url: request.url,
    contentType: request.headers['Content-Type'] ?? null,
    body: request.body === undefined ? null : truncate(request.body, MAX_BODY_PREVIEW),
  }
}

/** Compose one push report with every field present. */
function pushReport(
  classification: Classification,
  request: RequestView,
  sent: boolean,
  waitMs: number | null = null,
): PushReport {
  return {
    outcome: classification.outcome,
    sent,
    confirmed: classification.confirmed,
    reason: classification.reason,
    httpStatus: classification.httpStatus,
    serverStatus: classification.serverStatus,
    serverMessage: classification.serverMessage,
    detail: classification.detail,
    waitMs,
    request,
  }
}

// ── Renderers (pure text projections) ───────────────────────────────────────

/** One-line request echo shared by every renderer. */
function requestLine(request: RequestView): string {
  return `${request.method} ${request.url}`
}

/** Text projection of a push report. */
function renderPush(value: PushReport): TextContentBlock[] {
  const lines: string[] = []
  const target = value.request.url
  switch (value.outcome) {
    case 'success':
      lines.push(
        value.confirmed
          ? `Pushed. The server accepted the message (business 200, data=true).`
          : `Submitted. The server answered business 200 without a data field, so it is probably delivered.`,
      )
      break
    case 'unconfirmed':
      lines.push('Not confirmed. The envelope contradicts itself (business 200 with data=false).')
      break
    case 'rejected':
      lines.push(`Rejected (${value.reason}). Retrying the same input cannot succeed.`)
      break
    case 'rate_limited':
      lines.push('Rate limited. Wait before the next push; do not loop.')
      break
    case 'deferred':
      lines.push(
        `Not sent: local throttle. Wait about ${Math.ceil((value.waitMs ?? 0) / 1000)} s, then call ` +
          'meow_push again if the user still wants it.',
      )
      break
    case 'unknown':
      lines.push(`Result unknown (${value.reason}). The message may have been delivered; do not resend.`)
      break
    case 'preview':
      lines.push('Preview only — nothing was sent.')
      break
  }
  lines.push(requestLine(value.request))
  if (value.serverMessage !== null && value.serverMessage !== '') {
    lines.push(`Server message: ${value.serverMessage}`)
  }
  lines.push(value.detail)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Text projection of a doctor report. */
function renderDoctor(value: DoctorReport): TextContentBlock[] {
  const lines: string[] = [
    `Base URL: ${value.baseUrl}`,
    `Timeout: ${value.timeoutMs} ms · throttle: ${value.minSendIntervalMs} ms · allowHttp: ${String(value.allowHttp)}`,
    `Default title: ${value.defaultTitle}`,
  ]
  if (value.probed) {
    const reachable =
      value.reachable === true ? 'API envelope read' : value.reachable === false ? 'replied without the API envelope' : 'unknown'
    lines.push(
      `Probe: ${reachable} · HTTP ${String(value.probeHttpStatus)} · business ${String(value.probeServerStatus)}`,
    )
    if (value.probeServerMessage !== null && value.probeServerMessage !== '') {
      lines.push(`Probe message: ${value.probeServerMessage}`)
    }
  } else {
    lines.push('Probe: skipped (pass probe=true to GET the API root; it cannot push anything).')
  }
  lines.push(value.detail)
  return [{ type: 'text', text: lines.join('\n') }]
}

// ── Tool descriptions ───────────────────────────────────────────────────────

const SEND_DESCRIPTION =
  'Push one text or HTML notification to a registered MeoW nickname through api.chuckfang.com. ' +
  'Use it ONLY when the user explicitly asks to push/notify/send through MeoW and names the recipient: ' +
  'never invent a nickname, never try one to see whether it exists, and never send the same message twice — ' +
  'a push is not idempotent. `msg` is delivered verbatim (no rewriting, translation, signature or emoji). ' +
  'POST JSON is the default; `msgType: "html"` renders HTML at `htmlHeight` pixels and Markdown is unsupported. ' +
  'The documented 3 s / 15-per-minute budget is enforced locally: a too-early call returns outcome "deferred" ' +
  'with waitMs and is NOT sent. Never retry after outcome "unknown" or "unconfirmed" — report it to the user ' +
  'and let them decide. Use meow_push_preview first when the request itself matters.'

const PREVIEW_DESCRIPTION =
  'Build, validate and return the exact HTTP request that meow_push would issue, without any network I/O. ' +
  'Use it when the user wants to see the request, asks for integration code, or before the first push to an ' +
  'unfamiliar address. Returns outcome "preview" with the method, URL, content type and body, plus the waitMs ' +
  'the local throttle would impose right now. It cannot reveal whether a nickname is registered — only a real ' +
  'push can, so never send as a probe.'

const DOCTOR_DESCRIPTION =
  'Report the MeoW push settings (base URL, timeout, default title, local throttle, plain-http policy) and, ' +
  'with probe=true, whether the API root answers with the documented JSON envelope. It never pushes and cannot ' +
  'tell whether a nickname is registered. Use it to explain failures: a refused plain-http base URL, a DNS/TLS ' +
  'problem, or a reply that is not the MeoW API.'

// ── Tool factory ────────────────────────────────────────────────────────────

/** Build the three tool definitions bound to this plugin instance. */
export function createTools(deps: ToolDeps): ToolDefinition[] {
  const { config, ledger } = deps

  return [
    defineTool<PushReport>({
      name: 'meow_push',
      description: SEND_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Registered MeoW nickname; one URL path segment, so no "/".',
          },
          msg: {
            type: 'string',
            description: `Message text, delivered verbatim (1..${String(20_000)} characters; must not be blank).`,
          },
          title: { type: 'string', description: 'Notification title; defaults to the configured title ("MeoW").' },
          msgType: {
            type: 'string',
            enum: ['text', 'html'],
            description: 'Display type; "text" is the default. Markdown is not supported.',
          },
          htmlHeight: {
            type: 'integer',
            minimum: 1,
            maximum: 1_000_000,
            description: 'Rendered height in pixels for msgType="html"; defaults to 200.',
          },
          url: { type: 'string', description: 'Optional click-through link, absolute http(s).' },
          imgUrl: {
            type: 'string',
            description: 'Optional notification image, absolute http(s); 216x216 PNG works best.',
          },
          method: {
            type: 'string',
            enum: ['post', 'get'],
            description: 'Transport; "post" is the default. "get" puts the message in the URL path.',
          },
          format: {
            type: 'string',
            enum: ['json', 'form', 'text'],
            description: 'POST body encoding; "json" is the default. "text" sends the raw message.',
          },
        },
        required: ['to', 'msg'],
      },
      output: { schema: PUSH_REPORT_SCHEMA, render: (_args, value) => renderPush(value) },
      timeoutMs: config.timeoutMs + 10_000,
      execute: async (args, exec: ToolRunContext) => {
        if (exec.signal.aborted) throw new Error('meow_push: the call was cancelled')
        const options = resolveSendOptions(asArgs(args), config)
        const { request } = buildRequest(options)
        const view = requestView(request)

        const decision = ledger.peek()
        if (!decision.allowed) {
          return pushReport(
            {
              outcome: 'deferred',
              confirmed: false,
              reason: decision.reason,
              httpStatus: null,
              serverStatus: null,
              serverMessage: null,
              detail: decision.detail,
            },
            view,
            false,
            decision.waitMs,
          )
        }

        ledger.record()
        const classification = await sendPush(request, config.timeoutMs, exec.signal)
        return pushReport(classification, view, true)
      },
    }),

    defineTool<PushReport>({
      name: 'meow_push_preview',
      description: PREVIEW_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Registered MeoW nickname; one URL path segment, so no "/".' },
          msg: { type: 'string', description: 'Message text that would be delivered verbatim.' },
          title: { type: 'string', description: 'Notification title; defaults to the configured title ("MeoW").' },
          msgType: { type: 'string', enum: ['text', 'html'], description: 'Display type; "text" is the default.' },
          htmlHeight: {
            type: 'integer',
            minimum: 1,
            maximum: 1_000_000,
            description: 'Rendered height in pixels for msgType="html"; defaults to 200.',
          },
          url: { type: 'string', description: 'Optional click-through link, absolute http(s).' },
          imgUrl: { type: 'string', description: 'Optional notification image, absolute http(s).' },
          method: {
            type: 'string',
            enum: ['post', 'get'],
            description: 'Transport; "post" is the default. "get" puts the message in the URL path.',
          },
          format: {
            type: 'string',
            enum: ['json', 'form', 'text'],
            description: 'POST body encoding; "json" is the default.',
          },
        },
        required: ['to', 'msg'],
      },
      output: { schema: PUSH_REPORT_SCHEMA, render: (_args, value) => renderPush(value) },
      execute: async (args) => {
        const options = resolveSendOptions(asArgs(args), config)
        const { request, warnings } = buildRequest(options)
        const decision = ledger.peek()
        const notes: string[] = ['No request was sent: this is a preview of the exact request meow_push would issue.']
        for (const warning of warnings) notes.push(warning.text)
        if (!decision.allowed) {
          notes.push(
            `A send right now would be deferred for about ${Math.ceil(decision.waitMs / 1000)} s by the local throttle.`,
          )
        } else if (config.minSendIntervalMs > 0) {
          notes.push(`The local throttle requires ${config.minSendIntervalMs} ms between pushes.`)
        }
        return pushReport(
          {
            outcome: 'preview',
            confirmed: false,
            reason: '',
            httpStatus: null,
            serverStatus: null,
            serverMessage: null,
            detail: notes.join(' '),
          },
          requestView(request),
          false,
          decision.allowed ? null : decision.waitMs,
        )
      },
    }),

    defineTool<DoctorReport>({
      name: 'meow_push_doctor',
      description: DOCTOR_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          probe: {
            type: 'boolean',
            description:
              'Also GET the API root (no nickname, so nothing can be delivered) and report whether the ' +
              'documented JSON envelope came back.',
          },
        },
      },
      output: { schema: DOCTOR_REPORT_SCHEMA, render: (_args, value) => renderDoctor(value) },
      timeoutMs: config.timeoutMs + 10_000,
      execute: async (args, exec: ToolRunContext) => {
        const probeRequested = asArgs(args).probe === true
        const base = {
          timeoutMs: config.timeoutMs,
          defaultTitle: config.defaultTitle,
          minSendIntervalMs: config.minSendIntervalMs,
          allowHttp: config.allowHttp,
        }

        let baseUrl: string
        try {
          baseUrl = normalizeBaseUrl(config.baseUrl, config.allowHttp)
        } catch (error) {
          return {
            ...base,
            ok: false,
            baseUrl: config.baseUrl,
            probed: false,
            reachable: null,
            probeHttpStatus: null,
            probeServerStatus: null,
            probeServerMessage: null,
            detail: error instanceof Error ? error.message : String(error),
          }
        }

        if (!probeRequested) {
          return {
            ...base,
            ok: true,
            baseUrl,
            probed: false,
            reachable: null,
            probeHttpStatus: null,
            probeServerStatus: null,
            probeServerMessage: null,
            detail:
              'Configuration is usable. A probe was not requested; it only reads the API root and cannot push.',
          }
        }

        if (exec.signal.aborted) throw new Error('meow_push_doctor: the call was cancelled')
        const result = await probe(baseUrl, config.timeoutMs, exec.signal)
        const detail =
          result.error !== null
            ? `Probe failed: ${result.error}. Reachability is unknown; a push may still succeed later.`
            : result.reachable === true
              ? `The API answered with its documented envelope (business status ${String(result.serverStatus)}). ` +
                'This does not prove a nickname is registered or that a push will be accepted.'
              : result.reachable === null
                ? `The endpoint answered HTTP ${String(result.httpStatus)} without the MeoW JSON envelope ` +
                  '(the real API root serves its HTML documentation), so the host is reachable but whether ' +
                  'this IP is rate limited is unknown. This says nothing about the push route.'
                : `HTTP ${String(result.httpStatus)} came back without the MeoW API envelope, so the configured ` +
                  'base URL does not look like the MeoW API. Check baseUrl before pushing.'
        return {
          ...base,
          ok: result.error === null && result.reachable !== false,
          baseUrl,
          probed: true,
          reachable: result.reachable,
          probeHttpStatus: result.httpStatus,
          probeServerStatus: result.serverStatus,
          probeServerMessage: result.serverMessage,
          detail,
        }
      },
    }),
  ]
}

// ── Registration ────────────────────────────────────────────────────────────

/**
 * Register the `meow_push*` tools on the Host tool registry.
 *
 * @param ctx - Host plugin context (must provide `ctx.tools`).
 * @param config - Resolved deployment settings.
 * @param ledger - Throttle shared by every tool of this plugin instance.
 */
export function registerTools(ctx: HostContext, config: ResolvedConfig, ledger: RateLedger): void {
  const tools = ctx.tools
  if (tools === undefined) return
  for (const tool of createTools({ config, ledger })) {
    ctx.effect(() => tools.register(tool), `dsh-meow-push: tool ${tool.name}`)
  }
}

/** Documented non-member caps composed with the configured minimum spacing. */
export function createLedger(config: ResolvedConfig): RateLedger {
  return new RateLedger({ minIntervalMs: config.minSendIntervalMs, ...DEFAULT_CAPS })
}
