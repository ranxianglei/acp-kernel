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

### Process (exact steps)

The Agent does steps 1–5, the human does 6, CI does the rest.

1. **Sync master** — local master often lags behind origin:
   ```bash
   git checkout master && git pull --ff-only origin master
   ```
2. **Create the release branch** from master:
   ```bash
   git checkout -b $(date +%Y-%m-%d)_release-v{VERSION}
   ```
3. **Bump version** — edit ONLY the `"version"` field in `package.json`:
   ```diff
   -    "version": "0.0.14",
   +    "version": "0.0.15",
   ```
4. **Local pre-flight** — run the same three checks CI runs (release.yml):
   ```bash
   npm run typecheck   # tsc --noEmit
   npm test            # node --import tsx --test tests/*.test.ts
   npm run build       # tsup + tsc --emitDeclarationOnly
   ```
5. **Commit, push, open PR** — release-commit convention:
   - Message: `release v{VERSION}`
   - The commit changes ONLY `package.json` (1 line). Never bundle other changes into a release commit.
   - PR title: `release v{VERSION}`; body lists changes since last tag.
6. **Human merges the PR** (Agent MUST NOT merge — see "PR Merge" above).
7. **CI auto-publishes** — on detecting the release-branch merge, CI runs typecheck+test+build, creates git tag `v{VERSION}`, and runs `npm publish` to npmjs.org.
8. **Verify** the published version is live:
   ```bash
   npm view acp-kernel version
   ```

> **Node note:** run pre-flight with real Node.js, not the bun shim (see `~/AGENTS.md` §5). `npm test` uses `node --test` which the shim does not support.

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
