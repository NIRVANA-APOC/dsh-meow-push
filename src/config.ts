/**
 * Deployment configuration for the `dsh-meow-push` Host plugin.
 *
 * The plugin row lives in `cordis.patch.yml`, so every value here is read from
 * that mapping at activation. The row is not schema-validated (the package
 * declares no `Config` export on purpose: a linked local plugin cannot resolve
 * the Harness schema library at runtime), therefore {@link resolveConfig}
 * normalises and clamps every field itself and never throws for a bad value.
 * Invalid values fall back to the documented defaults, and a malformed
 * `baseUrl` is reported by `meow_push_doctor` and refused by the request
 * builder instead of being silently replaced.
 *
 * @module dsh-meow-push/config
 */

import {
  DEFAULT_BASE_URL,
  DEFAULT_MIN_SEND_INTERVAL_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TITLE,
  MAX_TITLE_LENGTH,
} from './types'

/** Bounds applied to deployment-provided numbers. */
const MIN_TIMEOUT_MS = 1_000
const MAX_TIMEOUT_MS = 120_000
const MAX_MIN_SEND_INTERVAL_MS = 3_600_000

/** Fully defaulted settings consumed by the plugin. */
export interface ResolvedConfig {
  /** API base URL exactly as configured (no trailing slash); validated per call. */
  baseUrl: string
  /** Per-request deadline in milliseconds. */
  timeoutMs: number
  /** Title used when a caller omits one. */
  defaultTitle: string
  /** Minimum spacing between two started pushes, in milliseconds (0 = off). */
  minSendIntervalMs: number
  /** Whether a plain-http base URL is accepted. */
  allowHttp: boolean
}

/** Defaults, exported so tests and documentation share one source. */
export const CONFIG_DEFAULTS: ResolvedConfig = {
  baseUrl: DEFAULT_BASE_URL,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  defaultTitle: DEFAULT_TITLE,
  minSendIntervalMs: DEFAULT_MIN_SEND_INTERVAL_MS,
  allowHttp: false,
}

/** Coerce an unknown value to a non-empty trimmed string. */
function textOr(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return trimmed === '' ? fallback : trimmed
}

/** Coerce an unknown value to a finite number inside an inclusive range. */
function numberOr(value: unknown, fallback: number, min: number, max: number): number {
  const raw = typeof value === 'number' ? value : Number.NaN
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.round(raw)))
}

/** Coerce an unknown value to a boolean. */
function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Strip query, fragment and trailing slashes from a configured base URL.
 *
 * Nothing else is validated here: a base URL that is not a URL at all is kept
 * verbatim so `meow_push_doctor` can display exactly what the deployment asked
 * for, and the request builder refuses it with an actionable message.
 */
function stripBaseUrl(value: string): string {
  try {
    const parsed = new URL(value)
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString().replace(/\/+$/, '')
  } catch {
    return value.replace(/\/+$/, '')
  }
}

/**
 * Apply defaults and bounds to the plugin row's `config`.
 *
 * @param raw - The row's `config` mapping, as handed to `apply`.
 * @returns Complete settings consumed by the plugin.
 */
export function resolveConfig(raw: unknown): ResolvedConfig {
  const source = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
  const defaultTitle = textOr(source.defaultTitle, CONFIG_DEFAULTS.defaultTitle)
  return {
    baseUrl: stripBaseUrl(textOr(source.baseUrl, CONFIG_DEFAULTS.baseUrl)),
    timeoutMs: numberOr(
      source.timeoutMs,
      CONFIG_DEFAULTS.timeoutMs,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    ),
    defaultTitle:
      defaultTitle.length > MAX_TITLE_LENGTH
        ? defaultTitle.slice(0, MAX_TITLE_LENGTH)
        : defaultTitle,
    minSendIntervalMs: numberOr(
      source.minSendIntervalMs,
      CONFIG_DEFAULTS.minSendIntervalMs,
      0,
      MAX_MIN_SEND_INTERVAL_MS,
    ),
    allowHttp: booleanOr(source.allowHttp, CONFIG_DEFAULTS.allowHttp),
  }
}
