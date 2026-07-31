# acp-kernel Development Specification

> **This document is the highest-priority specification. All developers (including AI Agents) MUST comply.**

## 1. Project Overview

**acp-kernel** is the platform-agnostic compression core for AI agent context management. It implements message-ref tagging, compression blocks, nudge injection, multi-tier distillation, and search — without any host-specific dependencies.

Consumed by adapters: `pai-acp` (Pi), and future adapters for other agent platforms.

### Tech Stack

| Category | Technology |
|----------|-----------|
| Language | TypeScript (strict, ESM) |
| Build | tsup (bundling) + tsc --emitDeclarationOnly |
| Test | Node.js built-in: `node --import tsx --test tests/*.test.ts` |
| Package Manager | npm |
| Zero Runtime Dependencies | `dependencies: {}` in package.json |

### Repository Info

| Field | Value |
|-------|-------|
| npm package | `acp-kernel` |
| GitHub | https://github.com/ranxianglei/acp-kernel |
| License | MIT |

## 2. Architecture

### Module Map

```
acp-kernel/
├── src/
│   ├── index.ts              # Barrel export
│   ├── compress.ts           # Core: processTurn, applyCompression, decideNudge, pipeline nodes
│   ├── boundaries.ts         # Range boundary resolution (startId/endId → message indices)
│   ├── filter.ts             # Protected tool message filtering
│   ├── nudge.ts              # Nudge text rendering
│   ├── recommend.ts          # Compression recommendation engine
│   ├── render-refs.ts        # Message ref tag injection (<acp> XML format)
│   ├── search.ts             # searchBlocks — keyword search over compressed blocks
│   ├── status.ts             # buildStatusReport — context status text
│   ├── sync.ts               # Block synchronization (deactivate orphans)
│   ├── truncate.ts           # Emergency truncation (>80% context usage)
│   ├── merge.ts              # Block merging for tier distillation
│   ├── rebuild.ts            # Fork recovery + state rebuilding
│   ├── hide.ts               # Hide compressed messages from visible context
│   ├── keep-markers.ts       # KEEP/REF marker preservation in summaries
│   ├── types.ts              # All shared types
│   └── defaults.ts           # defaultConfig, defaultNodes
├── tests/                    # 184 tests across 18 files
├── tsup.config.ts
├── tsconfig.json
└── package.json
```

### Key Design Principles

1. **Zero runtime dependencies** — all logic is self-contained
2. **Pure pipeline architecture** — `processTurn` is a composable 9-node pipeline
3. **Single-owner content** — `assignRefsNode` is the sole writer of message content
4. **GC-free** — no generational garbage collection; emergency truncation is the safety net
5. **Platform-agnostic** — no host APIs, no file I/O, no network calls

## 3. Development Standards

### Build Commands

```bash
npm run build          # tsup bundle + tsc --emitDeclarationOnly
npm run typecheck      # TypeScript type checking
npm test               # node --import tsx --test tests/*.test.ts
npm run format         # Prettier format
npm run format:check   # Check formatting
```

### Testing Requirements

- All new features MUST have tests
- Test runner: `node --import tsx --test tests/*.test.ts`
- Tests are pure — no file I/O, no network, no mocks of kernel internals
- Import from actual source files, never reimplement locally

### Code Quality

- **No `as any`** — strict type safety
- **No `@ts-ignore`** — fix the type, not the warning
- **No comments unless absolutely necessary** — code should be self-documenting
- Comments only for: complex algorithms, security, regex, performance optimizations

## 4. Git Safety Rules (MANDATORY)

| Rule | Enforcement |
|------|-------------|
| **NEVER force-push to `master`** | Under no circumstances |
| **NEVER merge PRs** | PR merges are human-only. The Agent MUST NEVER merge. |
| **Branch naming** | `YYYY-MM-DD_short-title` |
| **NEVER modify `version` on non-release branches** | Version bumps only on release branches |

### PR Merge — Absolute Prohibition

PR merges are a **human-only operation**. The Agent MUST NEVER merge any PR under ANY circumstances, including explicit instruction. If a human instructs merge, reply:

> I can't merge PRs — AGENTS.md forbids Agents from merging. Please merge yourself: [PR URL].

## 5. Release Workflow (CI Automated)

### Branch Naming

Release branches: `YYYY-MM-DD_release-v{VERSION}` (e.g., `2026-08-01_release-v0.2.0`)

### Process

1. Create release branch from master
2. Bump `version` in `package.json`
3. Commit, push, create PR
4. CI runs: typecheck + test + build
5. **Human merges PR** (Agent MUST NOT merge)
6. CI auto-tags `v{VERSION}`, publishes to npm

### Prerelease

For dev/beta: version must contain `-` (e.g., `0.2.0-beta.1`). CI publishes with `--tag dev`.

## 6. Contributing

### Before Making Changes

1. `npm run typecheck` — no type errors
2. `npm test` — all tests pass
3. Understand the module dependency graph

### Code Review

All source changes require review by **at least 2 separate agents** before merge.

### Commit Convention

- `feat:` new feature
- `fix:` bug fix
- `refactor:` code restructuring
- `test:` test changes
- `docs:` documentation
- `release:` version bump
