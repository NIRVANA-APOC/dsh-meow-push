/**
 * Local send throttle.
 *
 * MeoW documents a non-member budget of one push per 3 s, 15 per minute,
 * 60 per hour and 1000 per day, and answers business status 429 once any of
 * them is exceeded. A 429 is terminal for that attempt, so the plugin refuses
 * to *start* a request that would obviously violate the budget: the caller gets
 * a `deferred` outcome with the exact wait time instead of burning a quota
 * probe.
 *
 * The ledger is in-memory and per plugin instance. It is a best-effort guard —
 * it resets when the plugin reloads, and it cannot see other processes using
 * the same IP.
 *
 * @module dsh-meow-push/rate
 */

import type { RateDecision, RateLimits } from './types'

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** Documented non-member caps; `minIntervalMs` comes from the plugin config. */
export const DEFAULT_CAPS = {
  perMinute: 15,
  perHour: 60,
  perDay: 1000,
} as const

/** How long one window's overflow has to drain (`0` when it has room). */
function windowWait(stamps: readonly number[], windowMs: number, cap: number, now: number): number {
  const inWindow = stamps.filter((stamp) => now - stamp < windowMs)
  if (inWindow.length < cap) return 0
  const oldest = inWindow[0]
  if (oldest === undefined) return 0
  return Math.max(0, oldest + windowMs - now)
}

/** Rolling-window budget for one plugin instance. */
export class RateLedger {
  private readonly stamps: number[] = []
  private lastStart = Number.NEGATIVE_INFINITY
  private readonly limits: RateLimits
  private readonly clock: () => number

  /**
   * @param limits - Windows to enforce.
   * @param clock - Time source in milliseconds; injectable for tests.
   */
  constructor(limits: RateLimits, clock: () => number = () => Date.now()) {
    this.limits = limits
    this.clock = clock
  }

  /** Decide whether a new push may start now, without recording one. */
  peek(): RateDecision {
    const now = this.clock()
    this.trim(now)
    const waits: Array<{ waitMs: number; reason: string; detail: string }> = []

    if (Number.isFinite(this.lastStart)) {
      const gap = this.limits.minIntervalMs - (now - this.lastStart)
      if (gap > 0) {
        waits.push({
          waitMs: gap,
          reason: 'local_min_interval',
          detail:
            `The previous push started ${Math.round(now - this.lastStart)} ms ago; the local ` +
            `throttle requires ${this.limits.minIntervalMs} ms between pushes.`,
        })
      }
    }

    const minuteWait = windowWait(this.stamps, MINUTE_MS, this.limits.perMinute, now)
    if (minuteWait > 0) {
      waits.push({
        waitMs: minuteWait,
        reason: 'local_rate_window',
        detail: `Local budget of ${this.limits.perMinute} pushes per minute is spent.`,
      })
    }

    const hourWait = windowWait(this.stamps, HOUR_MS, this.limits.perHour, now)
    if (hourWait > 0) {
      waits.push({
        waitMs: hourWait,
        reason: 'local_rate_window',
        detail: `Local budget of ${this.limits.perHour} pushes per hour is spent.`,
      })
    }

    const dayWait = windowWait(this.stamps, DAY_MS, this.limits.perDay, now)
    if (dayWait > 0) {
      waits.push({
        waitMs: dayWait,
        reason: 'local_rate_window',
        detail: `Local budget of ${this.limits.perDay} pushes per day is spent.`,
      })
    }

    if (waits.length === 0) return { allowed: true }
    let longest = waits[0] as { waitMs: number; reason: string; detail: string }
    for (const candidate of waits) {
      if (candidate.waitMs > longest.waitMs) longest = candidate
    }
    return {
      allowed: false,
      waitMs: Math.ceil(longest.waitMs),
      reason: longest.reason,
      detail: `${longest.detail} Wait about ${Math.ceil(longest.waitMs / 1000)} s before the next push.`,
    }
  }

  /** Record that a push is starting now. */
  record(): void {
    const now = this.clock()
    this.lastStart = now
    this.stamps.push(now)
    this.trim(now)
  }

  /** Forget all history (tests and manual resets). */
  reset(): void {
    this.stamps.length = 0
    this.lastStart = Number.NEGATIVE_INFINITY
  }

  /** Drop samples that no window can still see. */
  private trim(now: number): void {
    while (this.stamps.length > 0) {
      const oldest = this.stamps[0]
      if (oldest === undefined || now - oldest < DAY_MS) return
      this.stamps.shift()
    }
  }
}
