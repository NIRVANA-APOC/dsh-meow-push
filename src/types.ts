/**
 * Shared vocabulary for the `dsh-meow-push` Host plugin.
 *
 * The plugin targets the documented MeoW push API (`https://api.chuckfang.com`):
 * one nickname per request, `msgType`/`htmlHeight` in the query string, title
 * and message in the body (POST) or path (GET), and a JSON envelope whose
 * business `status` — not the HTTP status — decides success.
 *
 * Every value a tool returns is a canonical JSON object described by one of the
 * `*Report` types below. `outcome` is the part a caller branches on; `reason` is
 * the stable, machine-readable token that explains a non-success outcome.
 *
 * @module dsh-meow-push/types
 */

/** Documented default title, applied locally when the caller omits one. */
export const DEFAULT_TITLE = 'MeoW'

/** Documented default HTML display height, in pixels. */
export const DEFAULT_HTML_HEIGHT = 200

/** Documented API base URL. */
export const DEFAULT_BASE_URL = 'https://api.chuckfang.com'

/** Per-request deadline used when the plugin row does not configure one. */
export const DEFAULT_TIMEOUT_MS = 15_000

/** Local throttle floor: the documented non-member rate is one push per 3 s. */
export const DEFAULT_MIN_SEND_INTERVAL_MS = 3_000

/** `msgType` values the API accepts. Markdown is not one of them. */
export const MSG_TYPES = ['text', 'html'] as const

/** One accepted `msgType`. */
export type MsgType = (typeof MSG_TYPES)[number]

/** HTTP methods the API documents for a push. */
export const HTTP_METHODS = ['GET', 'POST'] as const

/** One accepted HTTP method. */
export type HttpMethod = (typeof HTTP_METHODS)[number]

/** POST body encodings the API documents. `text` sends the raw message. */
export const POST_FORMATS = ['json', 'form', 'text'] as const

/** One accepted POST body encoding. */
export type PostFormat = (typeof POST_FORMATS)[number]

/**
 * Coarse classification of one push attempt (or of a request that was only
 * built). The first five mirror the documented API outcomes; `deferred` is the
 * local throttle refusing to start a request at all, and `preview` marks a
 * request that was never sent.
 */
export const OUTCOMES = [
  'success',
  'unconfirmed',
  'rejected',
  'rate_limited',
  'deferred',
  'unknown',
  'preview',
] as const

/** One accepted outcome. */
export type OutcomeKind = (typeof OUTCOMES)[number]

/** Inclusive HTML display-height bounds (`--html-height`, pixels). */
export const MIN_HTML_HEIGHT = 1
export const MAX_HTML_HEIGHT = 1_000_000

/** Local argument bounds, chosen to fail loudly instead of truncating. */
export const MAX_NICKNAME_LENGTH = 128
export const MAX_TITLE_LENGTH = 200
export const MAX_MESSAGE_LENGTH = 20_000

/** Longest request body echoed back to the model, in characters. */
export const MAX_BODY_PREVIEW = 2_000

/** Everything needed to build one push request. */
export interface SendOptions {
  /** Registered MeoW nickname; never contains `/`. */
  nickname: string
  /** Always resolved: an omitted title becomes {@link DEFAULT_TITLE}. */
  title: string
  /** Message body exactly as the caller supplied it. */
  msg: string
  /** Click-through link, already normalised, when supplied. */
  url: string | undefined
  /** Notification image URL, already normalised, when supplied. */
  imgUrl: string | undefined
  /** Display type; `html` additionally carries {@link htmlHeight}. */
  msgType: MsgType
  /** Rendered height in pixels; only meaningful for `html`. */
  htmlHeight: number | undefined
  /** `GET` puts everything in the path; `POST` keeps the message in the body. */
  method: HttpMethod
  /** POST body encoding; ignored for `GET`. */
  format: PostFormat
  /** API base URL without a trailing slash. */
  baseUrl: string
}

/** A fully materialised HTTP request: the pure output of the builder. */
export interface BuiltRequest {
  method: HttpMethod
  url: string
  headers: Record<string, string>
  /** `undefined` for GET. */
  body: string | undefined
}

/** Non-fatal advisory attached to a built request. */
export interface Warning {
  code: string
  text: string
}

/** The JSON envelope the API returns; `message` is the legacy spelling. */
export interface ApiEnvelope {
  status: number | null
  data: boolean | null
  msg: string | null
  message: string | null
}

/** Outcome of one HTTP exchange (or of a locally refused attempt). */
export interface Classification {
  outcome: OutcomeKind
  /** True only when the server positively confirmed the push. */
  confirmed: boolean
  /** Stable machine token; empty string when the outcome needs no reason. */
  reason: string
  httpStatus: number | null
  serverStatus: number | null
  serverMessage: string | null
  detail: string
}

/** How the request looked on the wire, echoed back to the caller. */
export interface RequestView {
  method: HttpMethod
  url: string
  contentType: string | null
  body: string | null
}

/** Canonical value returned by `meow_push` and `meow_push_preview`. */
export interface PushReport {
  outcome: OutcomeKind
  /** True only when an HTTP request was actually issued. */
  sent: boolean
  confirmed: boolean
  reason: string
  httpStatus: number | null
  serverStatus: number | null
  serverMessage: string | null
  detail: string
  /** Milliseconds the caller should wait before retrying (`deferred` only). */
  waitMs: number | null
  request: RequestView
}

/** Canonical value returned by `meow_push_doctor`. */
export interface DoctorReport {
  ok: boolean
  baseUrl: string
  timeoutMs: number
  defaultTitle: string
  minSendIntervalMs: number
  allowHttp: boolean
  /** Whether `probe` was requested at all. */
  probed: boolean
  /** `null` when no probe ran, or when the probe could not classify a reply. */
  reachable: boolean | null
  probeHttpStatus: number | null
  probeServerStatus: number | null
  probeServerMessage: string | null
  detail: string
}

/** Rate windows enforced locally before a request is started. */
export interface RateLimits {
  /** Minimum spacing between two started pushes, in milliseconds. */
  minIntervalMs: number
  /** Maximum pushes inside any rolling minute. */
  perMinute: number
  /** Maximum pushes inside any rolling hour. */
  perHour: number
  /** Maximum pushes inside any rolling 24 hours. */
  perDay: number
}

/** A local throttle decision. */
export type RateDecision =
  | { allowed: true }
  | { allowed: false; waitMs: number; reason: string; detail: string }
