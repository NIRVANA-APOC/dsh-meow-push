# dsh-meow-push

A DeepSeek Harness bundle that turns the official **meow-push** skill into executable
tools. The original skill is markdown only: it explains the MeoW API and asks the model to
hand-write a request. This plugin performs the request itself — with argument validation,
the documented query/body split, response classification, a non-idempotency guard and a
local rate throttle — so nothing is left to shell escaping or model arithmetic.

- Channel: **MeoW only** (`https://api.chuckfang.com`). It is not a fallback for Telegram,
  Slack, email or Server 酱.
- Tools: `meow_push`, `meow_push_preview`, `meow_push_doctor`.
- Language: TypeScript sources, esbuild output in `lib/`, **zero runtime dependencies**.
- Reference: the original API notes are kept in [`references/api.md`](references/api.md).

## Tools

### `meow_push`

Sends exactly one text or HTML notification to one registered nickname.

| Parameter | Type | Notes |
|---|---|---|
| `to` | string, **required** | Registered nickname. One URL path segment, so `/` is refused; `.` / `..` are refused because the URL parser would delete them. |
| `msg` | string, **required** | Delivered verbatim (1..20 000 chars, must not be blank). No rewriting, translation, signature or emoji is added. |
| `title` | string | Defaults to the configured title (`MeoW`, the documented server default). |
| `msgType` | `text` \| `html` | `text` by default. Markdown is not supported. |
| `htmlHeight` | integer | 1..1 000 000 px, `html` only, default 200. |
| `url` | string | Click-through link; absolute `http(s)`, normalised locally. |
| `imgUrl` | string | Notification image; absolute `http(s)`, normalised locally. |
| `method` | `post` \| `get` | `post` by default. `get` puts the message in the URL path, so it can leak into proxy/gateway logs and is length-limited. |
| `format` | `json` \| `form` \| `text` | POST body encoding, `json` by default. |

`msgType` and `htmlHeight` always travel in the query string; `title` rides in the path and
is repeated in JSON/form bodies, because the documented precedence is body > path > `MeoW`.

### `meow_push_preview`

Builds and validates the identical request with **no network I/O**, and returns it
(`outcome: "preview"`, `sent: false`) together with any advisory and the throttle wait the
request would incur. First choice for "show me the request", integration snippets, or a
first push to an unfamiliar address.

### `meow_push_doctor`

Reports the effective settings and, with `probe: true`, a `GET` of the API root — a request
that carries no nickname and therefore cannot deliver anything. It cannot tell whether a
nickname is registered; only a real push can.

`reachable` distinguishes three answers, because the real API root is an HTML documentation
page rather than a JSON envelope:

| `reachable` | `ok` | Meaning |
|---|---|---|
| `true` | `true` | The root answered with the documented `{status, data, msg}` envelope. |
| `null` | `true` | The host answered (2xx/3xx) but not with the envelope — the normal result against `api.chuckfang.com`. Reachability is confirmed; IP restrictions are unknown. |
| `false` | `false` | An error status without the envelope: the configured `baseUrl` does not look like the MeoW API. |

A transport failure also yields `reachable: null` with the error text. The probe never
proves that a push will be accepted, and its absence proves nothing either.

## Outcome vocabulary

`meow_push` returns one canonical value; branch on `outcome`, refine with `reason`.

| `outcome` | `reason` examples | Meaning / what to do |
|---|---|---|
| `success` | `""` (with `data=true`), `success_without_data_field` | Server accepted the push. `confirmed` is true only for `data=true`. Not a delivery receipt for the device. |
| `unconfirmed` | `status_200_data_false` | Envelope contradicts itself; treat as failure, never resend. |
| `rejected` | `business_400`, `business_403`, `business_404` | Terminal: bad content, policy refusal, or unregistered nickname. Fix the input. |
| `rate_limited` | `business_429`, `http_rate_limited` | Server-side limit hit. Wait; never loop. |
| `deferred` | `local_min_interval`, `local_rate_window` | The plugin refused to *start* the request. `waitMs` says how long. Nothing was sent. |
| `unknown` | `timeout`, `network_error`, `http_server_error`, `non_json_response`, `redirect_not_followed`, `http_status_conflict`, … | Delivery is indeterminate. Never resend automatically. |
| `preview` | `""` | Request built only; nothing was sent. |

Two invariants the plugin enforces so a model cannot get them wrong:

1. **No retries.** One call is one HTTP attempt. Timeouts, resets, 5xx, redirects and
   unparsable bodies are reported as `unknown` rather than replayed — a push is not
   idempotent. Redirects are not followed for the same reason.
2. **No self-inflicted 429.** Before sending, the plugin checks the documented non-member
   budget (1 per 3 s, 15/min, 60/h, 1 000/day) in a per-instance ledger and returns
   `deferred` with `waitMs` instead of spending the quota.

## Configuration

The bundle patch inserts one row:

```yaml
- insert:
    - id: dsh-meow-push
      name: dsh-meow-push
      config:
        baseUrl: https://api.chuckfang.com
        timeoutMs: 15000
        defaultTitle: MeoW
        minSendIntervalMs: 3000
        allowHttp: false
```

| Key | Default | Meaning |
|---|---|---|
| `baseUrl` | `https://api.chuckfang.com` | API root, no trailing slash. Query and fragment are stripped; an unparsable value is reported by `meow_push_doctor` and refused by every send. |
| `timeoutMs` | `15000` | Per-request deadline, clamped to 1 000..120 000. |
| `defaultTitle` | `MeoW` | Title used when `title` is omitted. |
| `minSendIntervalMs` | `3000` | Local spacing between pushes, 0..3 600 000 (`0` disables only the spacing rule; the window caps stay). |
| `allowHttp` | `false` | Accept a plain-http `baseUrl`. Only for a local fixture server — the message body would otherwise travel in clear. |

The package deliberately exports no `Config` schema: a linked local plugin cannot resolve
the Harness schema library at runtime, so the row is normalised by `resolveConfig()` instead.
Out-of-range values are clamped, never thrown.

## Install

```bash
# from a shell with dsh available
dsh --profile "$DSH_PROFILE" plugin list
```

Install and manage it through the Harness (agent `plugin_manager` tool or the Web Plugins
page) with `install_bundle` and this directory as the target. The directory is linked into
the profile, so after editing `src/` rebuild `lib/` and reload the plugin.

## Build and test

`lib/` is committed, so an install needs no build step and no dependencies.

```bash
node scripts/build.mjs      # esbuild → lib/index.js, lib/internals.js
node scripts/test.mjs       # 52 checks against lib/*.js and a local fixture server
```

`scripts/build.mjs` needs esbuild. It resolves, in order: `$ESBUILD_MODULE`, the `esbuild`
package, then `./node_modules/esbuild`. `scripts/test.mjs` needs nothing at all: it starts
an `http` fixture server on `127.0.0.1:0`, points the plugin at it with `allowHttp: true`,
and asserts the wire shape (path, query, body), the full classification matrix, the throttle
and the three tools' canonical values. **No real MeoW push is issued by the tests.**

## Layout

```text
package.json          bundle manifest (dsh.bundle.patch, exports, files)
cordis.patch.yml      the Loader row this bundle inserts
icon.svg              plugin artwork
locale/{en,zh}.json   plugin title/description per locale
src/index.ts          apply(): config → throttle → tools → prompt section
src/tools.ts          the three tool definitions, validation call sites, renderers
src/request.ts        argument validation, percent-encoding, request builder
src/classify.ts       envelope parsing and outcome classification
src/client.ts         fetch exchange, deadline handling, non-delivering probe
src/rate.ts           per-instance rolling-window throttle
src/config.ts         row config normalisation
src/host.ts           ambient Cordis context/tool types (no Harness imports)
src/internals.ts      test/embedder surface (built to lib/internals.js)
scripts/build.mjs     esbuild pipeline
scripts/test.mjs      fixture-server integration tests
references/api.md     original MeoW API notes
```

## Relationship to the skill

`meow-push-skill/` (markdown) is the source of the contract; this package implements it.
The skill's behavioural rules are preserved as code and as one short system-prompt
section (`dsh-meow-push:channel`): send only on an explicit request, never guess or probe a
nickname, never resend, report acceptance rather than delivery, and use preview when the
request itself matters.
