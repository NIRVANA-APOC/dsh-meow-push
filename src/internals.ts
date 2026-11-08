/**
 * Automation surface for tests and embedders.
 *
 * `lib/internals.js` re-exports the pure pieces of the plugin (request builder,
 * response classifier, throttle, HTTP exchange, config resolution) and the tool
 * factory, so a Node script can exercise the compiled artifact without a running
 * Harness. Only `lib/index.js` is mounted by the Loader.
 *
 * @module dsh-meow-push/internals
 */

export {
  buildProbeUrl,
  buildRequest,
  encodePairs,
  normalizeBaseUrl,
  resolveSendOptions,
  rfc3986,
  UsageError,
} from './request'

export { classify, toEnvelope } from './classify'

export { probe, sendPush, withDeadline } from './client'
export type { Deadline, ProbeResult } from './client'

export { DEFAULT_CAPS, RateLedger } from './rate'

export { CONFIG_DEFAULTS, resolveConfig } from './config'
export type { ResolvedConfig } from './config'

export { createLedger, createTools, registerTools } from './tools'
export type { ToolDeps } from './tools'

export * from './types'
