/**
 * HTTP exchange with the MeoW API.
 *
 * Two rules drive this module:
 *
 *  - A push is never retried. Pushes are not idempotent, so a timeout, a
 *    dropped connection, a 5xx or an unparsable body is reported as an
 *    indeterminate result instead of being replayed.
 *  - Redirects are not followed on a push. A 301/302/303 may re-deliver the
 *    request or drop its body; the caller gets `redirect_not_followed` and can
 *    point `baseUrl` at the final address.
 *
 * The probe (API root, no nickname) is the one request that may follow
 * redirects: it is idempotent and cannot deliver anything.
 *
 * @module dsh-meow-push/client
 */

import { classify, toEnvelope } from './classify'
import { buildProbeUrl } from './request'
import type { ApiEnvelope, BuiltRequest, Classification } from './types'

/** A request deadline combined with the caller's cancellation signal. */
export interface Deadline {
  signal: AbortSignal
  /** True when the timeout fired. */
  timedOut(): boolean
  /** True when the caller's own signal aborted the request. */
  cancelled(): boolean
  /** Release the timer and listener. */
  dispose(): void
}

/**
 * Combine the model step's cancellation signal with a per-request timeout.
 *
 * @param external - The calling tool's signal, when one exists.
 * @param timeoutMs - Deadline in milliseconds.
 */
export function withDeadline(external: AbortSignal | undefined, timeoutMs: number): Deadline {
  const controller = new AbortController()
  let timedOut = false
  let cancelled = false

  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  const onExternalAbort = (): void => {
    cancelled = true
    controller.abort()
  }

  if (external !== undefined) {
    if (external.aborted) {
      cancelled = true
      controller.abort()
    } else {
      external.addEventListener('abort', onExternalAbort, { once: true })
    }
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cancelled: () => cancelled,
    dispose: () => {
      clearTimeout(timer)
      if (external !== undefined) external.removeEventListener('abort', onExternalAbort)
    },
  }
}

/** Turn a thrown fetch failure into a classification. */
function transportFailure(error: unknown, deadline: Deadline, timeoutMs: number): Classification {
  const name = error instanceof Error ? error.name : ''
  const message = error instanceof Error ? error.message : String(error)
  if (deadline.timedOut() || name === 'TimeoutError' || name === 'AbortError') {
    return {
      outcome: 'unknown',
      confirmed: false,
      reason: 'timeout',
      httpStatus: null,
      serverStatus: null,
      serverMessage: null,
      detail:
        `The request timed out after ${timeoutMs} ms. The message may already have been sent; ` +
        'do not resend automatically.',
    }
  }
  return {
    outcome: 'unknown',
    confirmed: false,
    reason: 'network_error',
    httpStatus: null,
    serverStatus: null,
    serverMessage: null,
    detail:
      `Network failure, no response read: ${message}. Whether the push was delivered is ` +
      'unknown; do not resend automatically.',
  }
}

/**
 * Perform exactly one push attempt.
 *
 * @param request - Materialised request from the builder.
 * @param timeoutMs - Per-request deadline.
 * @param external - Cancellation signal of the calling tool.
 * @throws Error when the caller cancelled the call (nothing is reported back).
 */
export async function sendPush(
  request: BuiltRequest,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<Classification> {
  const deadline = withDeadline(external, timeoutMs)
  try {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      signal: deadline.signal,
      // Deliberately not 'follow': see the redirect branch in classify().
      redirect: 'manual',
    }
    if (request.body !== undefined) init.body = request.body

    let response: Response
    try {
      response = await fetch(request.url, init)
    } catch (error) {
      if (deadline.cancelled()) throw new Error('meow_push: the call was cancelled')
      return transportFailure(error, deadline, timeoutMs)
    }

    let rawBody: string | null = null
    try {
      rawBody = await response.text()
    } catch {
      rawBody = null
    }
    return classify(response.status, rawBody)
  } finally {
    deadline.dispose()
  }
}

/** Result of the non-delivering API-root probe. */
export interface ProbeResult {
  /**
   * `true` — the endpoint answered with the documented JSON envelope.
   * `false` — it answered with an error and no envelope (not the MeoW API).
   * `null` — no conclusion: transport failure, or a 2xx/3xx that carried no
   * envelope (the real API root serves its HTML documentation, so this is the
   * normal answer there and leaves IP restrictions unknown).
   */
  reachable: boolean | null
  httpStatus: number | null
  serverStatus: number | null
  serverMessage: string | null
  /** Transport failure text, when the probe could not complete. */
  error: string | null
}

/**
 * Probe the API root. Carries no nickname, so it cannot deliver a message.
 *
 * @param baseUrl - Normalised base URL.
 * @param timeoutMs - Per-request deadline.
 * @param external - Cancellation signal of the calling tool.
 */
export async function probe(
  baseUrl: string,
  timeoutMs: number,
  external?: AbortSignal,
): Promise<ProbeResult> {
  const deadline = withDeadline(external, timeoutMs)
  try {
    const response = await fetch(buildProbeUrl(baseUrl), {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: deadline.signal,
      // Safe here: an idempotent GET that delivers nothing.
      redirect: 'follow',
    })
    const rawBody = await response.text().catch(() => null)
    let envelope: ApiEnvelope | null = null
    if (rawBody !== null) {
      try {
        envelope = toEnvelope(JSON.parse(rawBody))
      } catch {
        envelope = null
      }
    }
    const status = response.status
    // The documented API answers with `{status, data, msg}`. Its own root is an
    // HTML documentation page, so a 2xx without an envelope proves reachability
    // but says nothing about IP restrictions; only an error status without an
    // envelope suggests a foreign server.
    const reachable: boolean | null =
      envelope !== null && envelope.status !== null
        ? true
        : status >= 200 && status < 400
          ? null
          : false
    return {
      reachable,
      httpStatus: status,
      serverStatus: envelope?.status ?? null,
      serverMessage: envelope === null ? null : (envelope.msg ?? envelope.message),
      error: null,
    }
  } catch (error) {
    return {
      reachable: null,
      httpStatus: null,
      serverStatus: null,
      serverMessage: null,
      error: deadline.cancelled()
        ? 'cancelled'
        : error instanceof Error
          ? error.message
          : String(error),
    }
  } finally {
    deadline.dispose()
  }
}
