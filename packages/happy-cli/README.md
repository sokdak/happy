# Happy

Code on the go — control AI coding agents from your phone, browser, or terminal.

Free. Open source. Code anywhere.

## Installation

```bash
npm install -g happy
```

> Migrated from the `happy-coder` package. Thanks to [@franciscop](https://github.com/franciscop) for donating the `happy` package name!

## Usage

### Claude Code (default)

```bash
happy
# or
happy claude
```

This will:
1. Start a Claude Code session
2. Display a QR code to connect from your mobile device or browser
3. Allow real-time session control — all communication is end-to-end encrypted
4. Start new sessions directly from your phone or web while your computer is online

### DeepSeek

Install the official [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
CLI with **Node.js 24.9 or newer**, then set its API key on the computer running Happy:

```bash
pnpm add -g @deepseek-ai/dsh@0.2.2-rc.1
export DEEPSEEK_API_KEY="your-api-key"
happy deepseek
happy deepseek --model deepseek-v4-pro --effort max
happy deepseek --permission-mode read-only
happy resume <happy-session-id>
```

In PowerShell, use `$env:DEEPSEEK_API_KEY="your-api-key"`.

Happy runs `dsh --profile acp` directly. Claude Code is not required; an existing
Claude installation and its credentials are independent. The app lists **DeepSeek**
when the machine has a supported Node version, `dsh`, and a configured key.
Restart an already-running daemon from that shell with `happy daemon stop` and
`happy daemon start` so it inherits the key and PATH.
`HAPPY_ENABLED_AGENTS` / `HAPPY_DISABLED_AGENTS` accept `deepseek`.

Set `HAPPY_DEEPSEEK_PATH` to a specific executable or the installed package's
`lib/bin.js`. Happy stores its isolated Harness profile and persistent sessions
in `~/.happy/deepseek` (`HAPPY_DEEPSEEK_HOME` overrides this). Use
`happy deepseek --resume <harness-session-id>` for a native session, or
`happy resume <happy-session-id>` to reconnect the same encrypted Happy conversation.

The current [DeepSeek API models](https://api-docs.deepseek.com/quick_start/pricing)
(verified November 15, 2026) are `deepseek-flash` (default, DeepSeek V4.1 Flash)
and `deepseek-v4-pro`. Both offer `off`, `low`, `high` (default), and `max`
reasoning effort. Flash accepts images; Pro accepts text only. Keys stay in the
machine environment; session metadata contains selections and the native ID.

Permissions use the Codex picker vocabulary: `auto`/`default` permit workspace
writes and ask for escalation, `safe-yolo` permits workspace writes without
escalation, `read-only` rejects writes, and `yolo` permits full access. The fork's
default is `yolo`. Permission changes apply through Harness's durable policy
setters when resuming the same native session. Harness currently treats
`default` like `auto`; it has no Codex `untrusted` command policy.
"Allow for session" remembers the exact tool and arguments in the current
Happy process; changing permission modes clears these approvals.

Happy forwards text, reasoning, tools, results, context usage, cancellation,
model/effort changes, and persistent resume. Happy MCP tools supply question
cards and task plans. Native ACP delivers committed text blocks rather than
every provider token. DSH ACP currently has no session fork or transcript replay;
Happy retains its own chat history. Old Claude-based DeepSeek sessions cannot
be resumed as native Harness sessions.

Protocol support checks can run without a live API key:

```bash
HAPPY_TEST_DEEPSEEK_PATH=/path/to/dsh/lib/bin.js pnpm --filter happy exec vitest run --project unit src/deepseek/DeepSeekAcpBackend.test.ts
```

Live acceptance tests use `HAPPY_RUN_DEEPSEEK_INTEGRATION=1`, your own
`DEEPSEEK_API_KEY`, and `vitest run --project integration-deepseek-local`.

### More agents

```
happy codex
happy agy        # Antigravity CLI (Gemini's successor)
happy gemini     # deprecated — use `happy agy`
happy openclaw

# or any ACP-compatible CLI
happy acp opencode
happy acp -- custom-agent --flag
```

> **Note on agy permissions:** the agy backend runs `agy --print`, which is
> one-shot and has no interactive approval surface — tool calls proceed
> automatically without ever prompting you. The permission mode you pick in
> Happy only chooses which flag is passed to agy: the default modes use
> `--sandbox`, and the bypass/yolo-style modes (including `acceptEdits`) use
> `--dangerously-skip-permissions`. Neither adds a per-tool approval gate
> inside Happy, so selecting "default" for an agy session does **not** give
> you an approval prompt the way it does for Claude Code.

## Daemon

The daemon is a background service that stays running on your machine. It lets you spawn and manage coding sessions remotely — from your phone or the web app — without needing an open terminal.

```bash
happy daemon start
happy daemon stop
happy daemon status
happy daemon list
```

The daemon starts automatically when you run `happy`, so you usually don't need to manage it manually.

### Keeping the daemon running across reboots

If you want the daemon to come back automatically after a reboot — without opening a `happy` session first — start it from your shell profile so it inherits your normal user session context (PATH, keychain access, OAuth credentials):

```bash
# ~/.zshrc or ~/.bashrc
if [[ -o interactive ]] && [[ -z "$HAPPY_DAEMON_CHECKED" ]]; then
    export HAPPY_DAEMON_CHECKED=1
    () {
        local state=$HOME/.happy/daemon.state.json
        local pid=$(grep -oE '"pid"[[:space:]]*:[[:space:]]*[0-9]+' "$state" 2>/dev/null | grep -oE '[0-9]+')
        if [[ -z "$pid" ]] || ! kill -0 "$pid" 2>/dev/null; then
            happy daemon start >/dev/null 2>&1
        fi
    } &!
fi
```

The first interactive shell after a reboot triggers the start; subsequent shells short-circuit because the daemon is already running.

> **macOS users:** prefer this shell-init approach over a `launchd` LaunchAgent. A LaunchAgent runs in an agent domain that is **detached from your GUI/Aqua login session**, which means the bundled `claude-agent-sdk` cannot reach the macOS keychain and silently fails authentication ("Failed to authenticate. API Error: 401 terminated", `duration_api_ms: 0`). If you must use launchd, your wrapper has to read the OAuth access token from `~/.claude/.credentials.json` and export it as `CLAUDE_CODE_OAUTH_TOKEN` before exec'ing the daemon — and you'll need to handle token rotation yourself.

## Authentication

```bash
happy auth login
happy auth logout
```

Happy uses cryptographic key pairs for authentication — your private key stays on your machine. All session data is end-to-end encrypted before leaving your device.

To connect third-party agent APIs:

```bash
happy connect gemini
happy connect claude
happy connect codex
happy connect status
```

## Commands

| Command | Description |
|---------|-------------|
| `happy` | Start Claude Code session (default) |
| `happy codex` | Start Codex mode |
| `happy agy` | Start agy (Antigravity CLI) session |
| `happy gemini` | Start Gemini CLI session (**deprecated** — use `happy agy`) |
| `happy openclaw` | Start OpenClaw session |
| `happy acp` | Start any ACP-compatible agent |
| `happy resume <id>` | Resume a previous session |
| `happy notify` | Send push notification to your devices |
| `happy doctor` | Diagnostics & troubleshooting |

---

## Advanced

### Environment Variables

| Variable | Description |
|----------|-------------|
| `HAPPY_SERVER_URL` | Custom server URL (default: `https://api.cluster-fluster.com`) |
| `HAPPY_WEBAPP_URL` | Custom web app URL (default: `https://app.happy.engineering`) |
| `HAPPY_HOME_DIR` | Custom home directory for Happy data (default: `~/.happy`) |
| `HAPPY_DISABLE_CAFFEINATE` | Disable macOS sleep prevention |
| `HAPPY_EXPERIMENTAL` | Enable experimental features |

### Sandbox (experimental)

Happy can run agents inside an OS-level sandbox to restrict file system and network access.

```bash
happy sandbox configure
happy sandbox status
happy sandbox disable
```

### Building from source

```bash
git clone https://github.com/slopus/happy
cd happy-cli
yarn install
yarn workspace happy cli --help
```

## Requirements

- Node.js >= 20.0.0
- For Claude: `claude` CLI installed & logged in
- For Codex: `codex` CLI installed & logged in
- For agy: install the Antigravity CLI (`agy`) and log in
- For Gemini (**deprecated** — use agy): `npm install -g @google/gemini-cli` + `happy connect gemini`

## License

MIT
