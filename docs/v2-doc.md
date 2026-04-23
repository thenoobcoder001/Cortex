# Cortex V2

## Positioning

V1 proved the core product loop:
- connect a workspace
- talk to an AI coding model
- stream responses
- persist chats
- inspect diffs
- ship desktop and mobile clients

V2 should turn that into a more reliable, shareable, and production-shaped product.

## Product Goal

Make Cortex feel like a stable daily driver for local AI coding across desktop and mobile, with cleaner sync, fewer sharp edges, and better operational trust.

## V2 Themes

### 1. Reliability
- remove common failure states in chat, sync, and startup
- make workspace and chat loading deterministic
- improve recovery from interrupted runs and failed provider sessions

### 2. Cross-Device Continuity
- make desktop and mobile feel like one product, not two loosely connected clients
- keep workspace lists, chats, and session state aligned
- reduce transport-specific breakage between clients

### 3. Safer Remote Access
- keep Tailscale/LAN support, but tighten exposure defaults and visibility
- make remote access easier to understand and verify from the UI
- reduce accidental unsafe backend exposure

### 4. Release Quality
- make releases easier to trust, test, and repeat
- tighten packaging, versioning, and upgrade flow
- improve basic production readiness for broader usage

## Scope

### Desktop
- better startup flow and clearer loading states
- recent workspace persistence as real backend state
- stronger chat/message loading APIs
- cleaner release/version reporting
- improved remote access settings and status visibility

### Mobile
- stable chat transport with graceful fallback when streaming is unavailable
- workspace sync from desktop recent projects
- more reliable chat history loading
- cleaner connection status and backend error messaging

### Shared Backend
- formalize endpoints used by both clients
- ensure chat history, workspace list, and config responses are mobile-safe
- reduce expensive synchronous work on interaction-heavy paths
- improve test coverage around APIs the mobile app depends on

## Proposed Feature Tracks

### Track A: Sync and Session Consistency
- expose a stable recent workspaces contract
- make chat list and message pagination first-class API features
- ensure active chat and active workspace transitions are consistent across clients

### Track B: Transport and Streaming Hardening
- keep NDJSON streaming as primary transport
- support fallback non-streaming send for runtimes with weak stream support
- normalize event payloads so desktop and mobile share the same expectations

### Track C: UX Polish
- clearer empty states, loading states, and failure states
- better connection diagnostics
- better recovery messaging after interrupted or failed runs

### Track D: Security and Operational Hardening
- localhost-first by default
- explicit remote exposure toggle
- better visibility into current bind address and reachable URLs
- tighter review of write-enabled and command-execution paths

### Track E: Release Discipline
- versioned release checklist
- repeatable desktop packaging
- repeatable mobile APK/AAB build flow
- pre-release validation matrix for desktop and mobile

## Non-Goals

- full cloud sync or hosted Cortex backend
- multi-user collaboration
- broad plugin ecosystem
- large architectural rewrite unless required for reliability

## Success Criteria

V2 is successful if:
- desktop and mobile can connect and chat without transport-specific failures
- recent workspaces and chats load correctly across clients
- startup and routine interactions no longer feel fragile
- release artifacts are reproducible and versioned clearly
- remote access is usable without silently increasing risk

## Suggested Milestones

### Milestone 1: Stability Baseline
- fix core chat/workspace API mismatches
- stabilize mobile chat transport
- stabilize recent workspace sync

### Milestone 2: UX and Recovery
- improve loading and error states
- improve interrupted run handling
- tighten workspace/chat switching behavior

### Milestone 3: Release Hardening
- finalize versioning conventions
- validate desktop packaging and mobile AAB flow
- document production test checklist

## Open Questions

- Should V2 still target local-first single-user usage, or start preparing for team/internal deployment?
- Should mobile stay as a remote companion only, or gain more offline/local cached capability?
- How strict should remote access be by default in installed desktop builds?
- What exactly marks the V2 release boundary: reliability only, or also new user-facing features?
