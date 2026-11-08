/**
 * Host half of the `dsh-meow-push` plugin.
 *
 * Wiring only: resolve the row config, create the per-instance throttle,
 * register the three `meow_push*` tools, and contribute one short
 * system-prompt section that tells the model when (and when not) to use them.
 *
 * Everything that touches the network lives in `client.ts`; everything that
 * decides what a request looks like lives in `request.ts`.
 *
 * @module dsh-meow-push
 */

import { resolveConfig } from './config'
import type { HostContext, HostPromptSection, HostSystemPromptService } from './host'
import { createLedger, registerTools } from './tools'

/** Plugin name used by the Loader row and diagnostics. */
export const name = 'dsh-meow-push'

/**
 * Host services required before `apply` runs. `systemPrompt` is looked up
 * optionally so a profile without a prompt registry still gets the tools.
 */
export const inject = ['tools']

/** Stable prompt-section name (kept identical across deployments). */
export const PROMPT_SECTION_NAME = 'dsh-meow-push:channel'

/**
 * System-prompt section: the channel policy the tools cannot enforce
 * themselves, kept short because prompt space is shared.
 */
export const PROMPT_SECTION_TEXT = `## MeoW push

The \`meow_push\` tools deliver a notification to a registered MeoW nickname through api.chuckfang.com; nothing else in this session reaches that channel, and it is not a fallback for Telegram, Slack, email or Server 酱.

- Call \`meow_push\` only when the user explicitly asks to push/notify/send through MeoW and gives the recipient nickname. Never guess a nickname, never pick one from unrelated context, and never send to "test" whether it exists.
- Call \`meow_push_preview\` when the user wants to see the request, asks for integration code, or before a first push to an unfamiliar address. A preview never sends anything.
- Deliver the user's message verbatim: no rewriting, translation, signature or added emoji unless asked. Markdown is unsupported; use \`msgType: "html"\` for formatting.
- A push is not idempotent. Never retry after \`unknown\` or \`unconfirmed\`, and never send one message twice. Report the outcome and let the user decide.
- \`rejected\` means 400/403/404 (bad content or an unregistered nickname): fix the input with the user instead of resending. \`rate_limited\` or \`deferred\` means wait the reported time; never loop.
- Success means the server accepted the push, not that the phone displayed it. Say so when reporting.`

/**
 * Register the prompt section.
 *
 * Placement follows whatever the deployment uses for its persona suffix; when
 * that name is unknown the section simply lands at a late default order.
 */
function registerPromptSection(ctx: HostContext): void {
  const systemPrompt =
    ctx.get === undefined ? undefined : ctx.get<HostSystemPromptService>('systemPrompt')
  if (systemPrompt === undefined || systemPrompt === null) return
  if (typeof systemPrompt.section !== 'function') return

  let order = 1_000
  try {
    const base = systemPrompt.getSectionOrder?.('DEPLOYMENT_PERSONA_SUFFIX')
    if (typeof base === 'number' && Number.isFinite(base)) order = base + 1
  } catch {
    // The deployment does not know that section name; keep the default order.
  }

  const section: HostPromptSection = {
    name: PROMPT_SECTION_NAME,
    order,
    interpolate: false,
    text: PROMPT_SECTION_TEXT,
  }
  ctx.effect(() => systemPrompt.section(section), 'dsh-meow-push: prompt section')
}

/**
 * Plugin entry point.
 *
 * @param ctx - Host plugin context (provides `tools`).
 * @param config - Raw Loader row `config`; normalised here, never trusted.
 */
export function apply(ctx: HostContext, config?: unknown): void {
  const resolved = resolveConfig(config)
  const ledger = createLedger(resolved)
  registerTools(ctx, resolved, ledger)
  registerPromptSection(ctx)
}
