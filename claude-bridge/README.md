# Claude Code bridge

Lets Capri think with **Claude Code** on your Claude subscription (Pro or Max) instead of an API key.

The bridge is a small local server that speaks the OpenAI chat API, which Capri already supports. Each reply runs one isolated `claude -p` turn, so the answers come from your logged-in Claude Code.

```
Capri ──OpenAI API──> bridge (localhost:4747) ──> claude -p ──> your Claude subscription
```

It doesn't replace anything in Capri. Claude API keys (`sk-ant-...`) under MAX INTELLIGENCE work the same as before, and you can switch between the two whenever you like.

## What you need

- [Claude Code](https://code.claude.com) installed and logged in. Run `claude` once in a terminal and log in with your Claude account
- Node.js 20 or newer
- No `npm install`: the bridge has no dependencies

## Use it

**Mac and Linux: nothing to run.** The bridge ships inside Capri, next to her app. Right-click her > Brain > **Use Claude Code (your Claude plan)**. A fresh install of this fork starts on it already.

- She starts the bridge when she opens, and stops it when she quits or you pick another brain
- If she crashes, the bridge notices that she's gone and stops too
- She finds `node` and `claude` in the usual places (Homebrew, `~/.local/bin`, nvm, Volta...), even when she's opened from the Finder
- A bridge you already started yourself (in a terminal or at login) is used as it is and left running
- Its output goes to `claude-bridge.log` in her data folder (`~/Library/Application Support/Capri` on a Mac). If it can't start, she says why, and the reason is also in `errors.txt`

Stopping the bridge loses nothing. It keeps no state: her memories and chats stay in her own files (`me.md`, `chat.json`...).

**Windows, or running it by hand:**

```sh
cd claude-bridge
npm start
```

Then connect Capri to it:

- **Mac and Linux:** right-click her > Brain > **Use my own server (OpenAI API)...**, type `http://localhost:4747` and press Enter
- **Windows:** Mainframe > BRAIN > **Provider**, address `http://localhost:4747`, no key

Pick `claude-sonnet`, `claude-opus` or `claude-haiku` in her model menu. Leave the terminal open while she uses it.

## What works

| | |
| --- | --- |
| Chat and history | Yes. The earlier turns go to Claude as a transcript |
| Seeing your screen | Yes. Pictures go to Claude as images |
| Her tools (open apps, click, music...) | Yes. They're described to Claude, and its calls come back as normal OpenAI tool calls |
| Streaming | The answer comes back in one piece. Capri waits for the whole reply anyway |

Speed, measured on a Mac: about 1.3 s for a Haiku turn with tools, about 2 to 3 s for Sonnet, and more with a screenshot. Each turn starts a fresh `claude` process, which adds about a second compared with an API key.

## How it stays clean

Each `claude -p` runs as a plain brain:

- **No Claude Code tools.** It can't run commands or edit files (`--tools ""`)
- **None of your hooks, plugins, MCP servers, skills or settings** (`--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`). This also keeps Capri's own Code/Husk hooks from reacting to her brain's turns
- **No `CLAUDE.md`.** It runs in an empty temporary folder
- **No session history** saved (`--no-session-persistence`)
- **Never your API key.** `ANTHROPIC_API_KEY` is removed from its environment, so it can't bill an API key by mistake

Claude Code still adds a little context of its own: the date, the OS, and who's logged in. So she may know your name.

## Settings

All of them are optional environment variables, for example `CAPRI_BRIDGE_MODEL=haiku npm start`.

| Variable | Default | What it does |
| --- | --- | --- |
| `CAPRI_BRIDGE_PORT` | `4747` | Port to listen on |
| `CAPRI_BRIDGE_HOST` | `127.0.0.1` | Address to listen on. Keep it local |
| `CAPRI_BRIDGE_MODEL` | `sonnet` | Model when Capri doesn't name one, and the first one in her menu |
| `CAPRI_BRIDGE_EFFORT` | `low` | Claude Code effort (`low`, `medium`, `high`...). Low keeps her quick. Empty uses Claude Code's default |
| `CAPRI_BRIDGE_MAX_CONCURRENT` | `2` | Turns at once. The others wait in line, so a burst of glances can't eat your plan's limits |
| `CAPRI_BRIDGE_TIMEOUT_MS` | `170000` | Gives up on a turn after this long. Capri waits 180 s |
| `CAPRI_BRIDGE_TOKEN` | none | Requires this token, so other apps on your computer can't use your subscription. In Capri, use **Use my own provider with a key** and paste the token |
| `CLAUDE_BIN` | `claude` | Full path to Claude Code if it isn't on your PATH |
| `CAPRI_BRIDGE_KEEP_API_KEY` | off | Passes `ANTHROPIC_API_KEY` through to Claude Code |
| `CAPRI_BRIDGE_DEBUG` | off | Prints each prompt it sends (pictures shortened) |

## Your plan's limits

Every reply counts against your Claude plan's limits, which you share with your normal Claude Code use. Capri asks her brain more often than you might think: glances at your screen, game reactions and follow-ups. If you use those a lot, pick `claude-haiku`, or turn them down in her settings. When you hit the limit, the bridge answers with a rate-limit error (HTTP 429) carrying Claude Code's message and reset time, and prints it in its terminal.

Anthropic's terms let you script Claude Code for yourself. They don't allow offering your Claude login or plan limits to other people's products. Keep the bridge local and for your own use.

## Start it with your Mac

To start it automatically, save this as `~/Library/LaunchAgents/app.capri.claude-bridge.plist`, with your own paths:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>app.capri.claude-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>/path/to/capri-desktop/claude-bridge/server.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>CLAUDE_BIN</key><string>/Users/you/.local/bin/claude</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/capri-claude-bridge.log</string>
  <key>StandardErrorPath</key><string>/tmp/capri-claude-bridge.log</string>
</dict>
</plist>
```

Then run `launchctl load ~/Library/LaunchAgents/app.capri.claude-bridge.plist`.

## Tests

```sh
npm test
```

The tests use a fake `claude`, so they don't touch your plan.
