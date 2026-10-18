# Cortex catch-up plan (Oct 2026)

Nothing has shipped since 18 Aug 2026 (v0.0.9). This plan compares Cortex with
[t3code](https://github.com/pingdotgg/t3code) (cloned at `../t3code`, commit
`42da166d`, 15 Oct 2026). It also applies the UX lessons from
`../reports/arduino-sim-ux-study/` to the desktop app.

Effort: S = under a day, M = 1–3 days, L = a week or more.

## Where we stand

**t3code has caught up with our pitch.** It's free and open source, with
desktop, web and CLI apps, plus native iOS and Android apps that control your
local agents remotely. It supports Claude Code, Codex, Cursor, Grok Build,
OpenCode and Antigravity. "Control your desktop AI from your phone" is no
longer a differentiator.

**What we have that they don't:**
- hash-chained audit trail with JSONL export
- the planned policy engine (ROADMAP Phase 2)
- Android emulator orchestration
- resource dashboard
- API providers (Groq, Gemini API)

Governance/audit stays the wedge. Everything else below is about not looking
dated next to t3code.

## Found in live testing (15 Oct)

- [x] Codex was completely broken: every hard-coded model (gpt-5.5, 5.4,
      5.4-mini, 5.3-codex) has been retired for ChatGPT accounts. Cortex now
      loads the live list from `codex app-server` (`model/list`), switches a
      retired saved model to Codex's default, and shows Codex's real error
      instead of "turn failed with status: failed".
- [ ] **M, top priority** Claude Code and Codex actions are not in the audit
      trail. Only the built-in terminal and API-key providers are logged.
      This is the "provider streaming taps" item from ROADMAP Phase 1, and
      the core claim of the product.
- [ ] **S** Your message shows twice while a reply runs (the pending copy isn't
      replaced by the sent one).
- [ ] **S** Consecutive agent messages are joined with no space
      ("version.Cortex").
- [ ] **S** `/api/status` sends ~810 KB of full-file diffs (`changes`) on every
      call. The desktop UI never reads them, and the diff baseline is stale
      (it lists already-committed files). Send only on request, or reset the baseline.
- [ ] **S** User messages render in a monospace `<pre>`; use the body font.
- [ ] **S** Header chat title has a wide gap before its chevron on short titles.
- Note: Android builds on this PC need
  `JAVA_TOOL_OPTIONS=-Djavax.net.ssl.trustStoreType=Windows-ROOT`
  (Avast intercepts HTTPS).

## Phase 0: Housekeeping (S each, do first)

- [ ] Commit or drop the pending `web/src/styles.css` hover/focus polish
- [x] Remove the hard-coded `E:\codex\gpt-tui\CLAUDE.md` path from
      `BASE_ASSISTANT_SYSTEM_PROMPT` (`backend/constants/index.js`)
- [ ] Update model lists in `backend/constants/index.js`:
  - drop retired Gemini 1.5/2.0 and Groq Mixtral/DeepSeek-distill models
  - update the Gemini CLI default (still `auto-gemini-2.5`)
  - re-check the Codex list against the current lineup
- [ ] Rename `gpt-tui.*` localStorage keys to `cortex.*`, migrating the old values
- [ ] Upgrade Electron 36 → 44 (current is 44.7.2); re-test PTY, the
      updater and the relay
- [ ] Rewrite `ROADMAP.md`: dates, the t3code reality, what we drop

## Phase 1: Design pass (UX study lessons 1–5)

These are the study's main findings, applied to Cortex:
- polish comes from consistency, not more features
- one accent colour
- show, don't tell

- [x] **M** Design tokens: one accent (`--accent`, orange) on neutral
      surfaces, one radius set. Done 15 Oct; a type scale is still to do.
- [x] **M** Button hierarchy:
  - one filled primary per screen (Send turns into Stop while running)
  - secondary buttons tonal, toolbar buttons ghost (icon + label)
  - destructive buttons only where needed
  - sentence case everywhere (13 all-caps labels removed)
- [~] **S** Fewer borders: done for the sidebar, audit toolbar and secondary
      buttons. The conversation and composer boxes are still to do.
- [x] **S** One icon set (Lucide, also in Settings); no text glyphs or emoji
- [x] **S** Every icon button has a title and aria-label (shortcut hints come
      with the command palette)
- [~] **M** Empty states: done for a new chat (starter cards) and the audit
      log (separate "no events" and "no matches" messages). No-project and
      no-changes states are still to do.
- [x] **S** Update banner: a quiet card, and "Not now" is remembered per version
- [x] **S** Model picker showed "Model" for saved ids without an effort suffix
- [ ] **M** Make the chat the hero: the conversation gets full width; side
      panels (terminal, resources, audit) collapse
- [ ] **L** Split `App.jsx` (2256 lines) and `styles.css` (3239 lines) into
      feature modules before adding more UI

## Phase 2: Core agent UX (biggest gaps vs t3code)

- [ ] **L** Threads sidebar:
  - many chats per project
  - live status dots (running, waiting for you, done, error)
  - search, archive, rename
- [ ] **L** Diff panel in the main view: per-file diff, accept/revert per
      file. The backend has the diff data, but the chat UI never shows it.
- [ ] **M** Permission modes (ask / auto-edit / full / plan), with inline
      approval cards for pending tool calls. This also feeds the policy engine.
- [ ] **M** Composer:
  - `@file` mentions
  - image and file attachments
  - draft saved per thread
  - queued follow-up messages
- [ ] **M** Command palette (Ctrl+K) and a keybindings settings page
- [ ] **S** Desktop notification when a thread finishes or needs approval
- [ ] **S** Markdown polish: code blocks with copy, collapsible tool calls,
      clickable file paths. Never show raw markdown.

UX-study behaviours that apply here:
- **Tap a part, see its numbers:** click a tool call or file to see what
  it did, in place
- **Something always moving:** a live activity line while the agent works
  (reading X, running Y)

## Phase 3: Git and workspace

- [ ] **M** Branch picker and status in the toolbar
- [ ] **L** Optional git worktree per thread, so parallel agents don't collide
- [ ] **M** Git actions: commit (with an AI message), push, open PR
- [ ] **M** Project scripts: run buttons for dev/test/build, defined per project
- [ ] **S** Open in editor: keep the current feature and add JetBrains

## Phase 4: Providers and first run

- [ ] **M** Welcome wizard:
  - detect installed CLIs and their login state
  - when one is missing, say so in plain words with a one-click fix (install
    link, or "Run `claude auth login`"), like ArduinoDroid's FIX button
  - ask for no permissions up front
- [ ] **M** New providers: OpenCode, Cursor CLI, Grok Build. Make the
      provider layer table-driven before adding these.
- [ ] **S** Provider update notices (CLI out of date)
- [ ] **M** Usage page: tokens and limits per provider and per day, like the
      study's "4 / 4 left today" pattern
- [ ] Rule from the study: tips dismissed with "Don't show again" stay dismissed

## Phase 5: Remote and mobile

- [ ] **M** QR-code pairing for the mobile app (replace the manual login flow)
- [ ] **M** Push to phone: thread finished, approval needed, policy violation
- [ ] **S** Devices page: paired phones, revoke a device

## Phase 6: The differentiator (ROADMAP Phase 2, rescoped)

- [ ] **L** Policy engine: `cortex-policy.json`, enforced in
      `toolExecutor.js` / `terminalService.js`, with blocks shown in chat
- [ ] **M** Policy and audit view per thread: what the agent did, what was blocked
- [ ] **M** Compliance export (report from the audit chain)

## Later / maybe

Things t3code has that we can skip for now:
- scheduled tasks
- built-in browser / preview panel
- VS Code theme import
- an MCP endpoint for outside agents
- winget/scoop/brew packages
- a CLI with a background service
- multiple accounts per provider

Also in this bucket: code signing (Azure Trusted Signing + Apple
notarization). It's still needed before any governance pitch.

## Suggested order

1. Phase 0 (all of it, ~2 days)
2. Phase 1 tokens, buttons, icons and the `App.jsx` split
3. Phase 2 threads sidebar + diff panel + permission modes
4. Phase 4 welcome wizard
5. Then Phases 3, 5 and 6, depending on whether anyone uses it
