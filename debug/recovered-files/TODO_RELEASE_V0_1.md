# gpt-tui v0.1 Beta Release TODO

Goal: ship a public beta that is stable enough for first X posts, while clearly signaling "early access".

Definition of done for this release:
- New users can install and run without guessing hidden setup steps.
- Core chat loop (Gemini CLI/Codex CLI) feels reliable and understandable.
- Users can recover from common failures without reading source code.
- Users can share/export outputs and copy content from key UI areas.

## P0 - Must Have Before Public Beta

### 1) Session Controls (Explicit Chat Lifecycle)
Description:
- Add first-class session management in UI so behavior is clear and user-controlled.
- Current resume behavior exists but is implicit; make it discoverable and reversible.

Scope:
- Add session actions in model/settings area:
  - `New Chat (fresh session)`
  - `Resume Latest`
  - `Resume By Session ID`
- Show active session id in status/footer when using CLI providers.
- Persist last known session id in config for restart continuity.

Why this matters:
- Prevents confusion about "why model remembers/forgets".
- Makes demos/posts reproducible.

Acceptance criteria:
- User can intentionally start fresh and confirm no prior memory.
- User can intentionally resume and recover previous context.
- Session id visible when available.

---

### 2) Provider Reliability Layer (Retries + Friendly Errors)
Description:
- Harden provider calls against transient failures and convert raw backend noise into actionable messages.

Scope:
- Add retry policy for transient classes:
  - rate limits / capacity (`429`, `RESOURCE_EXHAUSTED`)
  - temporary transport failures
- Backoff strategy:
  - e.g., 0.8s -> 1.6s -> 3.2s (bounded retries)
- Error normalization:
  - map common failures to user-facing hints:
    - "Gemini capacity full, retrying..."
    - "CLI console attach failed, try running outside embedded terminal"
    - "Auth missing, run login command"
- Keep full raw details in trace logs, not in user-visible chat body.

Why this matters:
- Users tolerate temporary failures if recovery is automatic and messaging is clear.
- Eliminates "it broke for unknown reason" moments.

Acceptance criteria:
- Temporary failures auto-recover when possible.
- Final failure text includes cause + next action.
- Raw stack traces are hidden from normal UI flow.

---

### 3) First-Run Setup Check (Guided Onboarding)
Description:
- On first app launch, validate environment and display guided fix steps.

Scope:
- Verify:
  - `gemini` CLI presence
  - `codex` CLI presence
  - auth/key status depending on selected provider
- Show pass/fail checklist in modal with one-line fix commands.
- Store "setup complete" flag but allow reopening via settings.

Why this matters:
- First impression depends on "works immediately" onboarding.
- Reduces support friction before social release.

Acceptance criteria:
- Fresh machine without config gets clear setup checklist.
- User can complete setup without docs hunting.

---

### 4) Export Conversations (Shareability)
Description:
- Add export for current chat to markdown/text so users can share output from demos/posts.

Scope:
- Commands and UI action:
  - `/export md <path>`
  - `/export txt <path>`
  - optional quick export button in sidebar
- Include:
  - timestamps
  - role labels
  - model/provider metadata
- Add safe path handling via existing file service.

Why this matters:
- Public launch traction needs easy sharing and artifact creation.

Acceptance criteria:
- Exported files are readable and complete.
- Works for long chats and includes streamed content final form.

## P1 - Strongly Recommended for Launch Quality

### 5) Better Copy UX in UI (Not Only Slash Commands)
Description:
- Promote copy actions to visible controls where users expect them.

Scope:
- Add dedicated buttons:
  - `Copy Stream`
  - `Copy Console`
- Keep slash commands and keyboard shortcuts as power-user options.
- Add brief success toast/status text after copy.

Why this matters:
- Many users discover features visually first, not via `/help`.

Acceptance criteria:
- One-click copy from chat message, stream, and console works reliably.

---

### 6) Prompt Presets (Quick Task Modes)
Description:
- Add quick mode selector to prepend concise role hints.

Scope:
- Presets:
  - `Code`
  - `Debug`
  - `Refactor`
  - `Explain`
- Non-destructive:
  - mode can be changed mid-session
  - clear current mode indicator in UI

Why this matters:
- Improves output consistency for common workflows.

Acceptance criteria:
- Switching modes changes answer style as expected.
- Mode state is visible and persisted.

---

### 7) Tool Safety Mode Toggle
Description:
- Add explicit safety mode for filesystem/tool actions.

Scope:
- Modes:
  - `Read-only` (no mutating tools)
  - `Write-enabled` (full current behavior)
- Visual indicator in header.
- Command to toggle quickly.

Why this matters:
- Users want confidence before giving write permissions.

Acceptance criteria:
- Mutating tool calls are blocked in read-only mode with clear message.
- Toggle works without restart.

## P2 - Nice to Have Soon After Launch

### 8) Usage Stats per Turn
Description:
- Show simple per-turn metrics for transparency.

Scope:
- Display:
  - elapsed time
  - approximate token usage if available from provider
  - tool count used
- Persist minimal history for current session.

Why this matters:
- Helps users understand performance and model behavior.

Acceptance criteria:
- Stats appear after each completed response.
- Missing provider metrics degrade gracefully.

## Release Execution Plan

Phase 1 (2-3 days):
- Session controls
- Reliability layer
- First-run setup check

Phase 2 (1-2 days):
- Export conversations
- Copy UX polish

Phase 3 (optional 1-2 days):
- Prompt presets
- Tool safety toggle
- Basic usage stats

## Suggested X Post Positioning

Use:
- "v0.1 Beta"
- "Terminal-first AI coding workspace"
- "Gemini CLI + Codex CLI support"
- "Early access, rapid iteration"

Avoid:
- "stable" / "production-ready" claims until P0 is fully complete and tested on clean machines.

