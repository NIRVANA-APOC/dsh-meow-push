/**
 * Response classification for one MeoW push exchange.
 *
 * The API answers HTTP 200 for every exchange and states the real outcome in a
 * JSON envelope `{status, data, msg}`. Both layers are therefore inspected:
 * a transport anomaly is never accepted as success, and `status: 200` alone is
 * never treated as confirmation unless `data` is absent (the documented
 * data-less success) or `true`.
 *
 * @module dsh-meow-push/classify
 */

import type { ApiEnvelope, Classification } from './types'

/** Narrow an unknown value to a plain object. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Read a numeric business status, tolerating a numeric string. */
function readStatus(source: Record<string, unknown>): number | null {
  const raw = source.status
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    return Number.parseInt(raw.trim(), 10)
  }
  return null
}

/** Read a boolean flag, tolerating the strings `"true"` / `"false"`. */
function readBoolean(source: Record<string, unknown>, key: string): boolean | null {
  const raw = source[key]
  if (typeof raw === 'boolean') return raw
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

/** Read a text field. */
function readText(source: Record<string, unknown>, key: string): string | null {
  const raw = source[key]
  return typeof raw === 'string' ? raw : null
}

/**
 * Project a parsed body onto the documented envelope, tolerating the legacy
 * `message` spelling.
 *
 * @param value - Parsed JSON body.
 * @returns The envelope, or `null` when the body carries none of its fields.
 */
export function toEnvelope(value: unknown): ApiEnvelope | null {
  const record = asRecord(value)
  if (record === null) return null
  const envelope: ApiEnvelope = {
    status: readStatus(record),
    data: readBoolean(record, 'data'),
    msg: readText(record, 'msg'),
    message: readText(record, 'message'),
  }
  if (
    envelope.status === null &&
    envelope.data === null &&
    envelope.msg === null &&
    envelope.message === null
  ) {
    return null
  }
  return envelope
}

/** Build one classification record with every field present. */
function result(fields: {
  outcome: Classification['outcome']
  confirmed?: boolean
  reason: string
  httpStatus?: number | null
  serverStatus?: number | null
  serverMessage?: string | null
  detail: string
}): Classification {
  return {
    outcome: fields.outcome,
    confirmed: fields.confirmed ?? false,
    reason: fields.reason,
    httpStatus: fields.httpStatus ?? null,
    serverStatus: fields.serverStatus ?? null,
    serverMessage: fields.serverMessage ?? null,
    detail: fields.detail,
  }
}

/** The documented non-member caps, used to explain a 429. */
const RATE_LIMIT_NOTE =
  'Non-member limits: 1 push per 3 s, 15 per minute, 60 per hour, 1000 per day. ' +
  'Do not loop or retry automatically.'

/**
 * Map one HTTP exchange onto an outcome.
 *
 * @param httpStatus - Transport status, or `null` when no response was read.
 *   `0` stands for an opaque redirect that exposed no status.
 * @param rawBody - Response body text, or `null` when it could not be read.
 */
export function classify(httpStatus: number | null, rawBody: string | null): Classification {
  if (httpStatus === 0 || (httpStatus !== null && httpStatus >= 300 && httpStatus < 400)) {
    return result({
      outcome: 'unknown',
      reason: 'redirect_not_followed',
      httpStatus,
      detail:
        `Received a redirect (${String(httpStatus)}). A push is not idempotent: following a ` +
        '301/302/303 can re-deliver the push or drop the request body, so redirects are not ' +
        'followed. Point baseUrl at the final API address instead.',
    })
  }
  if (httpStatus !== null && httpStatus >= 500) {
    return result({
      outcome: 'unknown',
      reason: 'http_server_error',
      httpStatus,
      detail:
        `HTTP ${httpStatus}: gateway/server error, so whether the push was delivered is ` +
        'unknown. Do not resend automatically.',
    })
  }
  if (httpStatus === 429) {
    return result({
      outcome: 'rate_limited',
      reason: 'http_rate_limited',
      httpStatus,
      detail: `HTTP 429: the request was rate limited. ${RATE_LIMIT_NOTE}`,
    })
  }
  if (rawBody === null) {
    return result({
      outcome: 'unknown',
      reason: 'no_response_body',
      httpStatus,
      detail: 'No response body was read, so the push result is unknown. Do not resend automatically.',
    })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return result({
      outcome: 'unknown',
      reason: 'non_json_response',
      httpStatus,
      detail:
        `The response is not JSON (HTTP ${String(httpStatus)}), so the push result is unknown. ` +
        'Do not resend automatically.',
    })
  }

  const envelope = toEnvelope(parsed)
  if (envelope === null) {
    return result({
      outcome: 'unknown',
      reason: 'unrecognised_envelope',
      httpStatus,
      detail:
        'The response JSON carries no status/msg field, so the push result is unknown. ' +
        'Do not resend automatically.',
    })
  }

  const serverMessage = envelope.msg ?? envelope.message
  const biz = envelope.status

  if (biz === null) {
    return result({
      outcome: 'unknown',
      reason: 'missing_business_status',
      httpStatus,
      serverMessage,
      detail: 'The response has no business status field, so the push result is unknown. Do not resend.',
    })
  }

  if (biz === 200) {
    // The service answers HTTP 200 for every exchange, so an HTTP error status
    // next to a business 200 means an intermediary answered and the request may
    // never have reached the push endpoint.
    if (httpStatus !== null && httpStatus >= 400) {
      return result({
        outcome: 'unknown',
        reason: 'http_status_conflict',
        httpStatus,
        serverStatus: biz,
        serverMessage,
        detail:
          `HTTP ${httpStatus} contradicts business status 200; the reply may come from an ` +
          'intermediary, so delivery is unconfirmed. Do not resend automatically.',
      })
    }
    if (envelope.data === false) {
      return result({
        outcome: 'unconfirmed',
        reason: 'status_200_data_false',
        httpStatus,
        serverStatus: biz,
        serverMessage,
        detail:
          'Business status is 200 but carries data=false, so the two layers contradict each ' +
          'other and this cannot be reported as success. Treat it as a failure; do not resend.',
      })
    }
    if (envelope.data === true) {
      return result({
        outcome: 'success',
        confirmed: true,
        reason: '',
        httpStatus,
        serverStatus: biz,
        serverMessage,
        detail:
          'The server accepted the push (data=true). This means the request was accepted, not ' +
          'that the device displayed a notification.',
      })
    }
    return result({
      outcome: 'success',
      reason: 'success_without_data_field',
      httpStatus,
      serverStatus: biz,
      serverMessage,
      detail:
        'The server returned status=200 without a data confirmation field; per the documented ' +
        'examples this means accepted. Treat it as possibly delivered and do not resend.',
    })
  }

  if (biz === 400 || biz === 403 || biz === 404) {
    const what =
      biz === 400
        ? 'Invalid request (missing or invalid title/message).'
        : biz === 403
          ? 'Content rejected by policy (possibly a sensitive term).'
          : 'That nickname is not registered with MeoW.'
    return result({
      outcome: 'rejected',
      reason: `business_${biz}`,
      httpStatus,
      serverStatus: biz,
      serverMessage,
      detail: `${what} Retrying the same input cannot succeed; fix it first.`,
    })
  }

  if (biz === 429) {
    return result({
      outcome: 'rate_limited',
      reason: 'business_429',
      httpStatus,
      serverStatus: biz,
      serverMessage,
      detail: `Rate or IP limit reached. ${RATE_LIMIT_NOTE}`,
    })
  }

  if (biz === 500) {
    return result({
      outcome: 'unknown',
      reason: 'business_500',
      httpStatus,
      serverStatus: biz,
      serverMessage,
      detail: 'Server error, so whether the push was delivered is unknown. Do not resend automatically.',
    })
  }

  return result({
    outcome: 'unknown',
    reason: 'unexpected_business_status',
    httpStatus,
    serverStatus: biz,
    serverMessage,
    detail: `Unrecognised business status ${biz}, so the push result is unknown. Do not resend.`,
  })
}
