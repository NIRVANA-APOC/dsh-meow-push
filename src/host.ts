/**
 * Minimal ambient types for the Cordis context this plugin consumes.
 *
 * The plugin is installed from a local directory and linked into a profile, so
 * Harness packages are not importable from its real path; the Host half
 * therefore declares the exact surface it uses instead of importing
 * `@deepseek-ai/dsh-tools`. Only runtime values are real — never import this
 * module for anything but types.
 *
 * @module dsh-meow-push/host
 */

/** One rendered content block; this plugin only ever emits text. */
export interface TextContentBlock {
  type: 'text'
  text: string
}

/** A JSON value the tool registry can validate and serialize. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

/** Execution context handed to every tool body. */
export interface ToolRunContext {
  /** Aborted when the model step is cancelled or times out. */
  readonly signal: AbortSignal
  readonly [key: string]: unknown
}

/** Canonical-value projection of one tool. */
export interface ToolOutputDefinition {
  /** Raw JSON Schema the registry validates the returned value against. */
  readonly schema: Record<string, unknown>
  render(args: unknown, value: unknown): TextContentBlock[]
}

/** Registry-ready tool definition (structural subset of `ToolDefinition`). */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: ToolOutputDefinition
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  timeoutMs?: number
}

/** The `tools` service surface used by this plugin. */
export interface HostToolsService {
  register(tool: ToolDefinition): () => void
}

/** One ordered system-prompt section. */
export interface HostPromptSection {
  name: string
  order: number
  text: string | ((context: unknown) => string)
  interpolate?: boolean
}

/** The `systemPrompt` service surface used by this plugin. */
export interface HostSystemPromptService {
  section(section: HostPromptSection): unknown
  getSectionOrder?(name: string): number
}

/** A Cordis effect callback: registers something and returns its disposer. */
export type HostEffectCallback = () => unknown

/** The subset of the Cordis `Context` the plugin uses. */
export interface HostContext {
  /** Guaranteed by `export const inject = ['tools']`. */
  tools?: HostToolsService
  /** Optional prompt registry; looked up so a profile without it still works. */
  get?<T = unknown>(name: string): T | undefined
  effect(callback: HostEffectCallback, label?: string): () => void
}
