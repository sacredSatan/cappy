# Step 0 probe — `claude -p` structured-output envelope

Run 2026-09-08. Claude Code **2.1.236**, Node **v26.5.0**, macOS (darwin 25.6.0).
This file is the contract `classify.js` is written against. Re-run the probe and
update this file if the CLI version changes.

## Canonical invocation

Corrected from SPEC.md:118-124 — see [Deviations](#deviations-from-specmd).

```bash
env -u ANTHROPIC_API_KEY claude -p --tools "" --strict-mcp-config \
  --system-prompt-file prompts/classifier-system.md \
  --json-schema "$SCHEMA" \
  --output-format json --model haiku --max-turns 3 \
  --no-session-persistence < note.md
```

Run from an empty scratch directory — not the vault, not this repo.

## Raw envelope (verbatim stdout, exit 0, stderr empty)

Fixture: a 394-byte note on Dijkstra's algorithm. Schema:
`{"type":"object","properties":{"topic":{"type":"string"},"confidence":{"type":"string"}},"required":["topic","confidence"],"additionalProperties":false}`

```json
{"is_error":false,"duration_api_ms":4437,"num_turns":2,"stop_reason":"tool_use","session_id":"8ae5d88e-3fd9-43a1-b71e-2118fe0788be","total_cost_usd":0.002927,"usage":{"input_tokens":1142,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":357,"output_tokens_details":{"thinking_tokens":281},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":0},"inference_geo":"not_available","iterations":[{"input_tokens":1142,"output_tokens":357,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"type":"message"}],"speed":"standard"},"modelUsage":{"claude-haiku-4-5-20251001":{"inputTokens":1142,"outputTokens":357,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"webSearchRequests":0,"costUSD":0.002927,"contextWindow":200000,"maxOutputTokens":32000,"canonicalModel":"claude-haiku-4-5","provider":"firstParty"}},"permission_denials":[],"terminal_reason":"completed","fast_mode_state":"off","fast_mode_disabled_reason":"sdk_opt_in_required","subtype":"success","api_error_status":null,"result":"{\"topic\":\"dijkstra\",\"confidence\":\"high\"}","structured_output":{"topic":"dijkstra","confidence":"high"},"ttft_ms":4255,"ttft_stream_ms":751,"time_to_request_ms":15,"type":"result","duration_ms":4510,"uuid":"8c7ba16a-f78c-49ea-9fa7-642f4c6395c7"}
```

## Where the validated object lands

**`.structured_output`** — already a parsed object. Parse stdout once, read that key.

```js
const env = JSON.parse(stdout);
const obj = env.structured_output;   // { topic: 'dijkstra', confidence: 'high' }
```

`.result` holds the same payload as a **JSON string** (`"{\"topic\":\"dijkstra\"...}"`)
and would need a second `JSON.parse`. Do not use it — on failure it holds English
prose instead, so parsing it conflates errors with output.

`--json-schema` coexists with `--tools ""`. The SPEC.md:207 fallback (dropping
`--tools ""`) is **not** needed.

## Detecting failure — read this before writing error handling

Induced failure (`--model no-such-model-xyz`), exit code 1:

| field | success | failure |
|---|---|---|
| exit code | `0` | `1` |
| `is_error` | `false` | `true` |
| `terminal_reason` | `"completed"` | `"api_error"` |
| `api_error_status` | `null` | `404` |
| `structured_output` | present | **absent** |
| `subtype` | `"success"` | `"success"` ⚠ |

⚠ **`subtype` is `"success"` on a failed run.** It is not an error discriminator.
Anything keying off it silently treats failures as valid output.

Gate on: non-zero exit, `is_error === true`, or `structured_output` missing.
Treat any of the three as "leave this note alone and log it" — never write
frontmatter from a run that trips one.

`stop_reason` is `"tool_use"` on success, because structured output is delivered
through an internal `StructuredOutput` tool. Do not treat `tool_use` as anomalous.
`num_turns` is 2 for a normal classification, so `--max-turns 3` has headroom.

## Deviations from SPEC.md

**1. `--bare` dropped.** Its help states: *"Anthropic auth is strictly
ANTHROPIC_API_KEY or apiKeyHelper via --settings (OAuth and keychain are never
read)."* That contradicts the SPEC.md:14 non-goal ("No Anthropic API key... on
the existing Claude subscription") and SPEC.md:179-181, which expects the
LaunchAgent to authenticate from the login keychain. `--bare` would have run the
pipeline on the API key without erroring.

**2. `--strict-mcp-config` added — required, not optional.** `--tools ""`
disables only *built-in* tools. Locally installed MCP plugins still inject their
tool definitions. A context probe under the SPEC.md invocation reported:

> "Chrome DevTools (browser automation, screenshots, performance tracing,
> lighthouse audits, network inspection, console debugging), Convex Backend Tools
> (database queries, function execution, logs, environment variables, deployment
> management, health insights)"

That was ~10,500 tokens of unrelated tooling in every classification. Adding
`--strict-mcp-config` (with no `--mcp-config`) reduces the reported context to
just the `StructuredOutput` tool.

Cost per note, same fixture: **$0.0238 → $0.0029** (~8×). Input tokens
10,497 → 1,142. This is the isolation `--bare` was providing; `--strict-mcp-config`
supplies it without forcing API-key auth.

**3. `env -u ANTHROPIC_API_KEY`.** An `ANTHROPIC_API_KEY` is exported in the
user's shell, and `claude auth status` reports `apiKeySource: ANTHROPIC_API_KEY`
while `authMethod` is `claude.ai`. Dropping `--bare` alone is not sufficient to
route to the subscription — the env var must be unset for the call. The
LaunchAgent must not inherit it.

**4. Undocumented but working flags.** `--system-prompt-file` and `--max-turns`
do not appear in `claude --help` on 2.1.236 but are accepted and functional.
Treat `--help` as incomplete rather than authoritative for these two.

## Notes for later steps

- `total_cost_usd` is reported even on subscription auth (`provider: "firstParty"`).
  It is a notional figure, not a subscription charge — useful for relative
  comparison only.
- Cache creation was 0 on the isolated run: a per-note system prompt plus a
  short note falls under the caching threshold. At ~$0.003/note, 100 notes is
  roughly $0.30 notional.
- `session_id` and `uuid` are fresh per run under `--no-session-persistence`;
  nothing is written to `~/.claude/sessions`.
- Probe fixtures live in the session scratch dir, not this repo.
