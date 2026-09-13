# Discord Issue Bridge Implementation Plan (Plan A of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `matsubo/discord-issue-bridge`, a Bun HTTP service that turns a Discord "Create GitHub Issue" message command into a complete GitHub issue (message + text attachments) on the repository mapped to the Discord channel, then replies with the issue URL.

**Architecture:** One Web-standard `fetch` handler (`src/handler.ts`) with all I/O injected through a `deps` object, so every module is unit-testable with a fake `fetch`. Pure modules (signature check, payload parsing, attachment policy, issue composition, routing) are separated from the two HTTP clients (GitHub, Discord follow-up) and from the orchestration (`process-report.ts`). `src/server.ts` wires real dependencies into `Bun.serve`. Stage 2 (the auto-fix action) is Plan B: `docs/superpowers/plans/2026-09-07-auto-fix-action.md`.

**Tech Stack:** Bun ≥ 1.3 (runtime, test runner, `crypto.subtle` Ed25519), TypeScript strict, zod 3 (contracts), Biome 1.9 (lint/format), Docker (`oven/bun:1.3`) deployed on Coolify.

**Spec:** `docs/superpowers/specs/2026-09-07-discord-report-to-pr-design.md` (§3, §4, §7, §8, §9 apply to this plan)

## Global Constraints

- New repository `matsubo/discord-issue-bridge`, **private**. Local clone at `/Volumes/nvme/matsu/ghq/github.com/matsubo/discord-issue-bridge` (ghq layout). Every command in this plan runs from that directory unless stated otherwise. **Never `git push` unless the maintainer explicitly says so** (`~/.claude/rules/git-workflow.md`).
- Documentation, commit messages, and code comments in English.
- Runtime dependency: `zod` only. No `discord.js`, no `discord-interactions`, no `octokit`.
- TypeScript settings copied from dam's `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `allowImportingTsExtensions`. Imports use the `.ts` extension. No `any`, no non-null assertions (Biome errors).
- Immutability: build new objects, never mutate inputs. Local accumulators inside a function are acceptable only when they never escape it.
- No `console.log`. The server logs through an injected `log(message)` function that writes to stderr.
- Files stay under 400 lines; one responsibility per file.
- Command name registered on Discord: exactly `Create GitHub Issue` (type 3). Endpoint path: `/discord/interactions`. Health path: `/healthz`.
- Limits (spec §4.3, §4.4): attachment ≤ 262,144 bytes, ≤ 5 transferred, download timeout 8 s; issue body / comment ≤ 60,000 characters; title ≤ 80 characters.
- GitHub write order is fixed: create issue → all overflow comments → labels **last** → Discord follow-up. If any comment fails, apply **no** labels (so `auto-fix` never starts on an incomplete issue) and say so in the follow-up.
- Commit after every task with a conventional-commit message (`feat:`, `test:`, `chore:`, `docs:`).

---

## File Structure

| Path | Responsibility |
|---|---|
| `package.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `README.md` | Scaffold (Task 1) |
| `docs/superpowers/specs/…`, `docs/superpowers/plans/…` | Copies of the spec and both plans (Task 1) |
| `src/config.ts` | Parse environment into `Config`; report errors instead of throwing (Task 2) |
| `src/routing.ts` | Parse `routes.json` into `RouteTable`; `resolveRoute` (Task 3) |
| `src/discord/verify.ts` | Ed25519 signature verification (Task 4) |
| `test/helpers/discord-signing.ts` | Key generation + signing for tests (Task 4) |
| `src/discord/interaction.ts` | zod schemas for the interaction payload; `parseInteraction`, `toDiscordReport`, `DiscordReport` type (Task 5) |
| `test/fixtures/interactions.ts` | PING and message-command fixtures (Task 5) |
| `src/discord/attachments.ts` | `selectAttachments` (policy) + `downloadAttachments` (capped fetch) (Task 6) |
| `test/helpers/fake-fetch.ts` | Recording fake `fetch` (Task 6) |
| `src/github/issue-body.ts` | `composeIssue`: title, body, comment chunks (Task 7) |
| `src/github/issues.ts` | `GitHubClient` over REST (Task 8) |
| `src/discord/followup.ts` | `editOriginalResponse` (Task 8) |
| `src/process-report.ts` | Orchestration of the deferred work (Task 9) |
| `src/handler.ts` | `handle(request, deps)`: routing, verification, replies (Task 10) |
| `src/server.ts`, `src/background.ts`, `Dockerfile`, `routes.json` | Runtime wiring, SIGTERM drain, container (Task 11) |
| `bin/register-command.ts` | One-off guild command registration (Task 12) |
| Task 13 | Local live handshake, Coolify deploy, production Discord setup (manual checklist) |

---

### Task 1: Repository scaffold

**Files:**
- Create: `package.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `README.md`
- Create: `docs/superpowers/specs/2026-09-07-discord-report-to-pr-design.md` (copy from dam)
- Create: `docs/superpowers/plans/2026-09-07-discord-issue-bridge.md`, `docs/superpowers/plans/2026-09-07-auto-fix-action.md` (copies from dam)

**Interfaces:**
- Produces: the repository every later task works in; `bun test`, `bun run lint`, `bun run typecheck` commands.

- [ ] **Step 1: Create the local repository**

```bash
mkdir -p /Volumes/nvme/matsu/ghq/github.com/matsubo/discord-issue-bridge
cd /Volumes/nvme/matsu/ghq/github.com/matsubo/discord-issue-bridge
git init -b main
mkdir -p src/discord src/github bin test/helpers test/fixtures docs/superpowers/specs docs/superpowers/plans
```

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "discord-issue-bridge",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "bun run src/server.ts",
    "test": "bun test",
    "lint": "biome check .",
    "format": "biome format --write .",
    "typecheck": "tsc --noEmit",
    "register-command": "bun run bin/register-command.ts"
  },
  "dependencies": {
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.9.0",
    "@types/bun": "latest",
    "typescript": "^5.6.0"
  },
  "engines": {
    "bun": ">=1.3.0"
  }
}
```

- [ ] **Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "verbatimModuleSyntax": true,
    "types": ["bun-types"],
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src", "bin", "test", "auto-fix"]
}
```

- [ ] **Step 4: Write `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/1.9.0/schema.json",
  "organizeImports": { "enabled": true },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true,
      "style": { "noNonNullAssertion": "error" },
      "suspicious": { "noExplicitAny": "error", "noConsoleLog": "error" }
    }
  },
  "formatter": { "enabled": true, "indentStyle": "space", "indentWidth": 2, "lineWidth": 100 },
  "javascript": {
    "formatter": { "quoteStyle": "single", "trailingCommas": "all", "semicolons": "always" }
  },
  "files": { "ignore": ["**/node_modules/**", "**/.claude/**"] }
}
```

- [ ] **Step 5: Write `.gitignore` and `README.md`**

`.gitignore`:

```
node_modules/
.env
.env.*
*.pem
```

`README.md` (the doc-blocker hook allows README; write it with Bash `cat > README.md <<'EOF'` if the Write tool is refused):

```markdown
# discord-issue-bridge

Turns a Discord message into a GitHub issue with one right-click, and ships a
reusable GitHub Action that lets Claude Code fix labelled issues.

- Design: `docs/superpowers/specs/2026-09-07-discord-report-to-pr-design.md`
- Bridge plan: `docs/superpowers/plans/2026-09-07-discord-issue-bridge.md`
- Action plan: `docs/superpowers/plans/2026-09-07-auto-fix-action.md`

## Run locally

    bun install
    cp .env.example .env   # fill in values
    bun run src/server.ts

## Test

    bun test
    bun run lint && bun run typecheck
```

- [ ] **Step 6: Copy the spec and plans from dam, install, verify the toolchain**

```bash
DAM=/Users/matsu/orca/workspaces/dam/check-report-on-discord
cp "$DAM/docs/superpowers/specs/2026-09-07-discord-report-to-pr-design.md" docs/superpowers/specs/
cp "$DAM/docs/superpowers/plans/2026-09-07-discord-issue-bridge.md" docs/superpowers/plans/
cp "$DAM/docs/superpowers/plans/2026-09-07-auto-fix-action.md" docs/superpowers/plans/
bun install
bun run lint && bun run typecheck && bun test
```

Expected: `bun install` creates `bun.lock`; lint and typecheck pass on an empty tree; `bun test` reports `0 pass, 0 fail` (no test files yet).

- [ ] **Step 7: Create the GitHub repository (private) and commit — do not push**

```bash
gh repo create matsubo/discord-issue-bridge --private --description "Discord message → GitHub issue bridge + Claude auto-fix action"
git remote add origin git@github.com:matsubo/discord-issue-bridge.git
git add -A
git commit -m "chore: scaffold discord-issue-bridge (bun, biome, tsconfig, spec, plans)"
```

Pushing waits for the maintainer's explicit instruction.

---

### Task 2: Configuration loader

**Files:**
- Create: `src/config.ts`
- Test: `src/config.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface Config {
    readonly discordPublicKey: string;      // 64 hex chars
    readonly discordAppId: string;
    readonly allowedUserIds: ReadonlySet<string>;
    readonly githubToken: string;
    readonly port: number;                  // default 3000
    readonly routesPath: string;            // default './routes.json'
  }
  type ConfigResult = { ok: true; config: Config } | { ok: false; error: string };
  function loadConfig(env: Record<string, string | undefined>): ConfigResult;
  ```

- [ ] **Step 1: Write the failing test**

`src/config.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { loadConfig } from './config.ts';

const VALID = {
  DISCORD_PUBLIC_KEY: 'a'.repeat(64),
  DISCORD_APP_ID: '123',
  DISCORD_ALLOWED_USER_IDS: '42, 43',
  GITHUB_TOKEN: 'ghp_x',
};

describe('loadConfig', () => {
  test('parses a valid environment with defaults', () => {
    const r = loadConfig(VALID);
    if (!r.ok) throw new Error(r.error);
    expect(r.config.port).toBe(3000);
    expect(r.config.routesPath).toBe('./routes.json');
    expect([...r.config.allowedUserIds]).toEqual(['42', '43']);
    expect(r.config.discordPublicKey).toBe('a'.repeat(64));
  });

  test('honours PORT and ROUTES_PATH', () => {
    const r = loadConfig({ ...VALID, PORT: '8080', ROUTES_PATH: '/etc/routes.json' });
    if (!r.ok) throw new Error(r.error);
    expect(r.config.port).toBe(8080);
    expect(r.config.routesPath).toBe('/etc/routes.json');
  });

  test('reports a missing public key instead of throwing', () => {
    const { DISCORD_PUBLIC_KEY: _omit, ...rest } = VALID;
    const r = loadConfig(rest);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('DISCORD_PUBLIC_KEY');
  });

  test('rejects a public key that is not 64 hex characters', () => {
    const r = loadConfig({ ...VALID, DISCORD_PUBLIC_KEY: 'zz' });
    expect(r.ok).toBe(false);
  });

  test('rejects an empty allow-list', () => {
    const r = loadConfig({ ...VALID, DISCORD_ALLOWED_USER_IDS: ' , ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('DISCORD_ALLOWED_USER_IDS');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/config.test.ts`
Expected: FAIL — `Cannot find module './config.ts'`.

- [ ] **Step 3: Write the implementation**

`src/config.ts`:

```ts
import { z } from 'zod';

const envSchema = z.object({
  DISCORD_PUBLIC_KEY: z.string().regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters'),
  DISCORD_APP_ID: z.string().min(1),
  DISCORD_ALLOWED_USER_IDS: z
    .string()
    .transform((s) => s.split(',').map((id) => id.trim()).filter((id) => id.length > 0))
    .refine((ids) => ids.length > 0, 'must list at least one Discord user id'),
  GITHUB_TOKEN: z.string().min(1),
  PORT: z.coerce.number().int().positive().default(3000),
  ROUTES_PATH: z.string().min(1).default('./routes.json'),
});

export interface Config {
  readonly discordPublicKey: string;
  readonly discordAppId: string;
  readonly allowedUserIds: ReadonlySet<string>;
  readonly githubToken: string;
  readonly port: number;
  readonly routesPath: string;
}

export type ConfigResult = { ok: true; config: Config } | { ok: false; error: string };

export function loadConfig(env: Record<string, string | undefined>): ConfigResult {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return { ok: false, error: `invalid environment: ${issues.join('; ')}` };
  }
  const e = parsed.data;
  return {
    ok: true,
    config: {
      discordPublicKey: e.DISCORD_PUBLIC_KEY,
      discordAppId: e.DISCORD_APP_ID,
      allowedUserIds: new Set(e.DISCORD_ALLOWED_USER_IDS),
      githubToken: e.GITHUB_TOKEN,
      port: e.PORT,
      routesPath: e.ROUTES_PATH,
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/config.test.ts && bun run lint && bun run typecheck`
Expected: 5 pass; lint and typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts src/config.test.ts
git commit -m "feat: parse environment into Config with explicit error reporting"
```

---

### Task 3: Channel → repository routing

**Files:**
- Create: `src/routing.ts`
- Test: `src/routing.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface Route { readonly repo: string; readonly labels: readonly string[] }
  type RouteTable = ReadonlyMap<string, Route>;
  type RoutesResult = { ok: true; routes: RouteTable } | { ok: false; error: string };
  function parseRoutes(json: unknown): RoutesResult;
  function loadRoutes(path: string): Promise<RoutesResult>;
  function resolveRoute(routes: RouteTable, channelId: string): Route | null;
  const DEFAULT_LABELS: readonly string[]; // ['from-discord', 'auto-fix']
  ```

- [ ] **Step 1: Write the failing test**

`src/routing.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { DEFAULT_LABELS, loadRoutes, parseRoutes, resolveRoute } from './routing.ts';

describe('parseRoutes', () => {
  test('applies default labels when omitted', () => {
    const r = parseRoutes({ '123456789012345678': { repo: 'matsubo/dam' } });
    if (!r.ok) throw new Error(r.error);
    expect(resolveRoute(r.routes, '123456789012345678')).toEqual({
      repo: 'matsubo/dam',
      labels: [...DEFAULT_LABELS],
    });
  });

  test('keeps explicit labels', () => {
    const r = parseRoutes({ '123456789012345678': { repo: 'matsubo/postcode', labels: ['from-discord'] } });
    if (!r.ok) throw new Error(r.error);
    expect(resolveRoute(r.routes, '123456789012345678')?.labels).toEqual(['from-discord']);
  });

  test('returns null for an unmapped channel', () => {
    const r = parseRoutes({});
    if (!r.ok) throw new Error(r.error);
    expect(resolveRoute(r.routes, '999')).toBeNull();
  });

  test('rejects a repo that is not owner/name', () => {
    const r = parseRoutes({ '123456789012345678': { repo: 'dam' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('owner/name');
  });

  test('rejects a key that is not a snowflake', () => {
    const r = parseRoutes({ 'service-dam': { repo: 'matsubo/dam' } });
    expect(r.ok).toBe(false);
  });
});

describe('loadRoutes', () => {
  test('reports an unreadable file', async () => {
    const r = await loadRoutes('/nonexistent/routes.json');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('/nonexistent/routes.json');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/routing.test.ts`
Expected: FAIL — `Cannot find module './routing.ts'`.

- [ ] **Step 3: Write the implementation**

`src/routing.ts`:

```ts
import { z } from 'zod';

export const DEFAULT_LABELS: readonly string[] = ['from-discord', 'auto-fix'];

const routeSchema = z.object({
  repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, 'repo must be owner/name'),
  labels: z.array(z.string().min(1)).optional(),
});

const routesFileSchema = z.record(
  z.string().regex(/^\d{17,20}$/, 'channel id must be a Discord snowflake'),
  routeSchema,
);

export interface Route {
  readonly repo: string;
  readonly labels: readonly string[];
}

export type RouteTable = ReadonlyMap<string, Route>;

export type RoutesResult = { ok: true; routes: RouteTable } | { ok: false; error: string };

export function parseRoutes(json: unknown): RoutesResult {
  const parsed = routesFileSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    return { ok: false, error: `invalid routes: ${issues.join('; ')}` };
  }
  const entries = Object.entries(parsed.data).map(
    ([channelId, route]): [string, Route] => [
      channelId,
      { repo: route.repo, labels: route.labels ?? [...DEFAULT_LABELS] },
    ],
  );
  return { ok: true, routes: new Map(entries) };
}

export async function loadRoutes(path: string): Promise<RoutesResult> {
  try {
    const json: unknown = await Bun.file(path).json();
    return parseRoutes(json);
  } catch (err) {
    return { ok: false, error: `cannot read ${path}: ${(err as Error).message}` };
  }
}

export function resolveRoute(routes: RouteTable, channelId: string): Route | null {
  return routes.get(channelId) ?? null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/routing.test.ts && bun run lint && bun run typecheck`
Expected: 6 pass; clean.

- [ ] **Step 5: Commit**

```bash
git add src/routing.ts src/routing.test.ts
git commit -m "feat: parse routes.json into a channel → repository table"
```

---

### Task 4: Ed25519 signature verification

**Files:**
- Create: `src/discord/verify.ts`
- Create: `test/helpers/discord-signing.ts`
- Test: `src/discord/verify.test.ts`

**Interfaces:**
- Produces:
  ```ts
  function verifyDiscordSignature(args: {
    publicKeyHex: string; signatureHex: string | null; timestamp: string | null; body: string;
  }): Promise<boolean>;
  // test helper
  interface SigningKeys { publicKeyHex: string; sign(timestamp: string, body: string): Promise<string> }
  function createSigningKeys(): Promise<SigningKeys>;
  ```

- [ ] **Step 1: Write the test helper**

`test/helpers/discord-signing.ts`:

```ts
export interface SigningKeys {
  readonly publicKeyHex: string;
  sign(timestamp: string, body: string): Promise<string>;
}

function bytesToHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createSigningKeys(): Promise<SigningKeys> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKeyHex = bytesToHex(await crypto.subtle.exportKey('raw', pair.publicKey));
  return {
    publicKeyHex,
    async sign(timestamp, body) {
      const message = new TextEncoder().encode(timestamp + body);
      return bytesToHex(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, message));
    },
  };
}
```

- [ ] **Step 2: Write the failing test**

`src/discord/verify.test.ts`:

```ts
import { beforeAll, describe, expect, test } from 'bun:test';
import { createSigningKeys, type SigningKeys } from '../../test/helpers/discord-signing.ts';
import { verifyDiscordSignature } from './verify.ts';

let keys: SigningKeys;
const BODY = '{"type":1}';
const TS = '1757200000';

beforeAll(async () => {
  keys = await createSigningKeys();
});

describe('verifyDiscordSignature', () => {
  test('accepts a valid signature', async () => {
    const signatureHex = await keys.sign(TS, BODY);
    const ok = await verifyDiscordSignature({ publicKeyHex: keys.publicKeyHex, signatureHex, timestamp: TS, body: BODY });
    expect(ok).toBe(true);
  });

  test('rejects a tampered body', async () => {
    const signatureHex = await keys.sign(TS, BODY);
    const ok = await verifyDiscordSignature({ publicKeyHex: keys.publicKeyHex, signatureHex, timestamp: TS, body: '{"type":2}' });
    expect(ok).toBe(false);
  });

  test('rejects a tampered timestamp', async () => {
    const signatureHex = await keys.sign(TS, BODY);
    const ok = await verifyDiscordSignature({ publicKeyHex: keys.publicKeyHex, signatureHex, timestamp: '1757200001', body: BODY });
    expect(ok).toBe(false);
  });

  test('rejects a signature from another key', async () => {
    const other = await createSigningKeys();
    const signatureHex = await other.sign(TS, BODY);
    const ok = await verifyDiscordSignature({ publicKeyHex: keys.publicKeyHex, signatureHex, timestamp: TS, body: BODY });
    expect(ok).toBe(false);
  });

  test('rejects missing headers and malformed hex without throwing', async () => {
    expect(await verifyDiscordSignature({ publicKeyHex: keys.publicKeyHex, signatureHex: null, timestamp: TS, body: BODY })).toBe(false);
    expect(await verifyDiscordSignature({ publicKeyHex: keys.publicKeyHex, signatureHex: 'zz', timestamp: null, body: BODY })).toBe(false);
    expect(await verifyDiscordSignature({ publicKeyHex: 'not-hex', signatureHex: 'ab', timestamp: TS, body: BODY })).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/discord/verify.test.ts`
Expected: FAIL — `Cannot find module './verify.ts'`.

- [ ] **Step 4: Write the implementation**

`src/discord/verify.ts`:

```ts
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
}

export async function verifyDiscordSignature(args: {
  publicKeyHex: string;
  signatureHex: string | null;
  timestamp: string | null;
  body: string;
}): Promise<boolean> {
  if (!args.signatureHex || !args.timestamp) return false;
  const key = hexToBytes(args.publicKeyHex);
  const signature = hexToBytes(args.signatureHex);
  if (!key || !signature) return false;
  if (key.length !== PUBLIC_KEY_BYTES || signature.length !== SIGNATURE_BYTES) return false;
  try {
    const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'Ed25519' }, false, ['verify']);
    const message = new TextEncoder().encode(args.timestamp + args.body);
    return await crypto.subtle.verify({ name: 'Ed25519' }, cryptoKey, signature, message);
  } catch {
    return false;
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/discord/verify.test.ts && bun run lint && bun run typecheck`
Expected: 5 pass; clean.

- [ ] **Step 6: Commit**

```bash
git add src/discord/verify.ts src/discord/verify.test.ts test/helpers/discord-signing.ts
git commit -m "feat: verify Discord Ed25519 request signatures with WebCrypto"
```

---

### Task 5: Interaction payload contract

**Files:**
- Create: `src/discord/interaction.ts`
- Create: `test/fixtures/interactions.ts`
- Test: `src/discord/interaction.test.ts`

**Interfaces:**
- Produces:
  ```ts
  const COMMAND_NAME = 'Create GitHub Issue';
  type Interaction = { type: 1 } | MessageCommandInteraction;           // zod-inferred
  type ParseResult = { ok: true; interaction: Interaction } | { ok: false; error: string };
  function parseInteraction(rawBody: string): ParseResult;
  interface ReportAttachment { readonly id: string; readonly filename: string; readonly size: number; readonly url: string; readonly contentType: string | null }
  interface DiscordReport {
    readonly messageId: string; readonly guildId: string | null; readonly channelId: string;
    readonly channelName: string | null; readonly authorUsername: string; readonly timestamp: string;
    readonly content: string; readonly attachments: readonly ReportAttachment[];
    readonly filedBy: string; readonly invokerId: string; readonly interactionToken: string;
  }
  type ReportResult = { ok: true; report: DiscordReport } | { ok: false; reason: string };
  function toDiscordReport(i: MessageCommandInteraction): ReportResult;
  ```

- [ ] **Step 1: Write the fixtures**

`test/fixtures/interactions.ts`:

```ts
export const PING = { type: 1, id: '1', application_id: '999', token: 't', version: 1 };

export const REPORT_MD_URL = 'https://cdn.discordapp.com/attachments/555/a1/teraren_report.md?ex=1';
export const REPORT_CSV_URL = 'https://cdn.discordapp.com/attachments/555/a2/teraren_report_capacity.csv?ex=1';

export const MESSAGE_COMMAND = {
  id: '111',
  application_id: '999',
  type: 2,
  token: 'interaction-token',
  version: 1,
  guild_id: '777',
  channel_id: '123456789012345678',
  channel: { id: '123456789012345678', name: 'service-dam' },
  member: { user: { id: '42', username: 'matsubokkuri' } },
  data: {
    id: '1',
    name: 'Create GitHub Issue',
    type: 3,
    target_id: '333',
    resolved: {
      messages: {
        '333': {
          id: '333',
          content: '初めまして。HTといいます。貯水率について検証したところ、不一致がありました。\n報告させていただきます。',
          timestamp: '2026-09-06T12:18:00.000Z',
          author: { id: '43', username: 'HTokui' },
          attachments: [
            { id: 'a1', filename: 'teraren_report.md', size: 33412, url: REPORT_MD_URL, content_type: 'text/markdown; charset=utf-8' },
            { id: 'a2', filename: 'teraren_report_capacity.csv', size: 42011, url: REPORT_CSV_URL, content_type: 'text/csv' },
          ],
        },
      },
    },
  },
} as const;
```

- [ ] **Step 2: Write the failing test**

`src/discord/interaction.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { MESSAGE_COMMAND, PING } from '../../test/fixtures/interactions.ts';
import { parseInteraction, toDiscordReport } from './interaction.ts';

function parseCommand(payload: unknown) {
  const r = parseInteraction(JSON.stringify(payload));
  if (!r.ok) throw new Error(r.error);
  if (r.interaction.type !== 2) throw new Error('expected a command');
  return r.interaction;
}

describe('parseInteraction', () => {
  test('parses a PING', () => {
    const r = parseInteraction(JSON.stringify(PING));
    expect(r.ok && r.interaction.type).toBe(1);
  });

  test('rejects invalid JSON and unknown types', () => {
    expect(parseInteraction('{').ok).toBe(false);
    expect(parseInteraction(JSON.stringify({ type: 9 })).ok).toBe(false);
  });
});

describe('toDiscordReport', () => {
  test('extracts the report from a message command', () => {
    const r = toDiscordReport(parseCommand(MESSAGE_COMMAND));
    if (!r.ok) throw new Error(r.reason);
    expect(r.report).toMatchObject({
      messageId: '333',
      guildId: '777',
      channelId: '123456789012345678',
      channelName: 'service-dam',
      authorUsername: 'HTokui',
      timestamp: '2026-09-06T12:18:00.000Z',
      filedBy: 'matsubokkuri',
      invokerId: '42',
      interactionToken: 'interaction-token',
    });
    expect(r.report.content).toContain('貯水率');
    expect(r.report.attachments).toHaveLength(2);
    expect(r.report.attachments[0]).toEqual({
      id: 'a1',
      filename: 'teraren_report.md',
      size: 33412,
      url: MESSAGE_COMMAND.data.resolved.messages['333'].attachments[0].url,
      contentType: 'text/markdown; charset=utf-8',
    });
  });

  test('rejects a command with the wrong data.type', () => {
    const r = toDiscordReport(parseCommand({ ...MESSAGE_COMMAND, data: { ...MESSAGE_COMMAND.data, type: 1 } }));
    expect(r.ok).toBe(false);
  });

  test('rejects an unknown command name', () => {
    const r = toDiscordReport(parseCommand({ ...MESSAGE_COMMAND, data: { ...MESSAGE_COMMAND.data, name: 'Other' } }));
    expect(r.ok).toBe(false);
  });

  test('rejects a payload whose target message is not resolved', () => {
    const r = toDiscordReport(parseCommand({ ...MESSAGE_COMMAND, data: { ...MESSAGE_COMMAND.data, target_id: '000' } }));
    expect(r.ok).toBe(false);
  });

  test('rejects a payload without an invoking user', () => {
    const { member: _omit, ...rest } = MESSAGE_COMMAND;
    const r = toDiscordReport(parseCommand(rest));
    expect(r.ok).toBe(false);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/discord/interaction.test.ts`
Expected: FAIL — `Cannot find module './interaction.ts'`.

- [ ] **Step 4: Write the implementation**

`src/discord/interaction.ts`:

```ts
import { z } from 'zod';

export const COMMAND_NAME = 'Create GitHub Issue';
const MESSAGE_COMMAND_TYPE = 3;

const userSchema = z.object({ id: z.string(), username: z.string() });

const attachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  size: z.number().int().nonnegative(),
  url: z.string().url(),
  content_type: z.string().optional(),
});

const messageSchema = z.object({
  id: z.string(),
  content: z.string(),
  timestamp: z.string(),
  author: userSchema,
  attachments: z.array(attachmentSchema).default([]),
});

const pingSchema = z.object({ type: z.literal(1) });

const messageCommandSchema = z.object({
  type: z.literal(2),
  id: z.string(),
  token: z.string(),
  application_id: z.string(),
  guild_id: z.string().optional(),
  channel_id: z.string(),
  channel: z.object({ id: z.string(), name: z.string().optional() }).optional(),
  member: z.object({ user: userSchema }).optional(),
  user: userSchema.optional(),
  data: z.object({
    name: z.string(),
    type: z.number().int(),
    target_id: z.string().optional(),
    resolved: z.object({ messages: z.record(messageSchema).optional() }).optional(),
  }),
});

const interactionSchema = z.discriminatedUnion('type', [pingSchema, messageCommandSchema]);

export type Interaction = z.infer<typeof interactionSchema>;
export type MessageCommandInteraction = z.infer<typeof messageCommandSchema>;

export type ParseResult = { ok: true; interaction: Interaction } | { ok: false; error: string };

export function parseInteraction(rawBody: string): ParseResult {
  try {
    const parsed = interactionSchema.safeParse(JSON.parse(rawBody));
    if (!parsed.success) return { ok: false, error: 'unsupported interaction payload' };
    return { ok: true, interaction: parsed.data };
  } catch {
    return { ok: false, error: 'body is not valid JSON' };
  }
}

export interface ReportAttachment {
  readonly id: string;
  readonly filename: string;
  readonly size: number;
  readonly url: string;
  readonly contentType: string | null;
}

export interface DiscordReport {
  readonly messageId: string;
  readonly guildId: string | null;
  readonly channelId: string;
  readonly channelName: string | null;
  readonly authorUsername: string;
  readonly timestamp: string;
  readonly content: string;
  readonly attachments: readonly ReportAttachment[];
  readonly filedBy: string;
  readonly invokerId: string;
  readonly interactionToken: string;
}

export type ReportResult = { ok: true; report: DiscordReport } | { ok: false; reason: string };

export function toDiscordReport(i: MessageCommandInteraction): ReportResult {
  if (i.data.type !== MESSAGE_COMMAND_TYPE) return { ok: false, reason: 'not a message command' };
  if (i.data.name !== COMMAND_NAME) return { ok: false, reason: `unknown command: ${i.data.name}` };
  const invoker = i.member?.user ?? i.user;
  if (!invoker) return { ok: false, reason: 'missing invoking user' };
  const targetId = i.data.target_id;
  const message = targetId === undefined ? undefined : i.data.resolved?.messages?.[targetId];
  if (!message) return { ok: false, reason: 'target message not resolved' };
  return {
    ok: true,
    report: {
      messageId: message.id,
      guildId: i.guild_id ?? null,
      channelId: i.channel_id,
      channelName: i.channel?.name ?? null,
      authorUsername: message.author.username,
      timestamp: message.timestamp,
      content: message.content,
      attachments: message.attachments.map((a) => ({
        id: a.id,
        filename: a.filename,
        size: a.size,
        url: a.url,
        contentType: a.content_type ?? null,
      })),
      filedBy: invoker.username,
      invokerId: invoker.id,
      interactionToken: i.token,
    },
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/discord/interaction.test.ts && bun run lint && bun run typecheck`
Expected: 7 pass; clean.

- [ ] **Step 6: Commit**

```bash
git add src/discord/interaction.ts src/discord/interaction.test.ts test/fixtures/interactions.ts
git commit -m "feat: zod contract for Discord interactions and DiscordReport extraction"
```

---

### Task 6: Attachment policy and download

**Files:**
- Create: `src/discord/attachments.ts`
- Create: `test/helpers/fake-fetch.ts`
- Test: `src/discord/attachments.test.ts`

**Interfaces:**
- Consumes: `ReportAttachment` (Task 5).
- Produces:
  ```ts
  const MAX_ATTACHMENT_BYTES = 262_144; const MAX_TRANSFERRED = 5;
  type AttachmentDecision =
    | { readonly attachment: ReportAttachment; readonly transfer: true }
    | { readonly attachment: ReportAttachment; readonly transfer: false; readonly reason: string };
  function selectAttachments(attachments: readonly ReportAttachment[]): readonly AttachmentDecision[];
  type DownloadedAttachment =
    | { readonly attachment: ReportAttachment; readonly content: string }
    | { readonly attachment: ReportAttachment; readonly content: null; readonly reason: string };
  function downloadAttachments(decisions: readonly AttachmentDecision[], fetchFn: typeof fetch, timeoutMs?: number): Promise<readonly DownloadedAttachment[]>;
  // test helper
  interface FakeFetch { fetch: typeof fetch; calls: readonly RecordedCall[] }
  interface RecordedCall { readonly method: string; readonly url: string; readonly body: unknown }
  function createFakeFetch(rules: readonly FakeRule[]): FakeFetch;
  interface FakeRule { readonly method: string; readonly urlIncludes: string; readonly respond: (call: RecordedCall) => Response }
  ```

- [ ] **Step 1: Write the fake fetch helper**

`test/helpers/fake-fetch.ts`:

```ts
export interface RecordedCall {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

export interface FakeRule {
  readonly method: string;
  readonly urlIncludes: string;
  readonly respond: (call: RecordedCall) => Response;
}

export interface FakeFetch {
  readonly fetch: typeof fetch;
  readonly calls: readonly RecordedCall[];
}

function parseBody(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') return null;
  try {
    return JSON.parse(init.body);
  } catch {
    return init.body;
  }
}

export function createFakeFetch(rules: readonly FakeRule[]): FakeFetch {
  const calls: RecordedCall[] = [];
  const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const call: RecordedCall = { method, url, body: parseBody(init) };
    calls.push(call);
    const rule = rules.find((r) => r.method === method && url.includes(r.urlIncludes));
    if (!rule) return new Response(`no fake rule for ${method} ${url}`, { status: 599 });
    return rule.respond(call);
  }) as typeof fetch;
  return { fetch: fakeFetch, calls };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
```

- [ ] **Step 2: Write the failing test**

`src/discord/attachments.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createFakeFetch } from '../../test/helpers/fake-fetch.ts';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_TRANSFERRED,
  downloadAttachments,
  selectAttachments,
} from './attachments.ts';
import type { ReportAttachment } from './interaction.ts';

function att(over: Partial<ReportAttachment>): ReportAttachment {
  return { id: 'x', filename: 'a.md', size: 10, url: 'https://cdn.example/a.md', contentType: 'text/markdown', ...over };
}

describe('selectAttachments', () => {
  test('transfers text types and text extensions', () => {
    const d = selectAttachments([
      att({ id: '1', contentType: 'text/csv' }),
      att({ id: '2', contentType: 'application/json' }),
      att({ id: '3', contentType: null, filename: 'notes.txt' }),
      att({ id: '4', contentType: 'application/octet-stream', filename: 'data.log' }),
    ]);
    expect(d.map((x) => x.transfer)).toEqual([true, true, true, true]);
  });

  test('skips binaries with reason "binary"', () => {
    const [d] = selectAttachments([att({ contentType: 'image/png', filename: 'photo.png' })]);
    expect(d).toMatchObject({ transfer: false, reason: 'binary' });
  });

  test('skips files over the byte cap', () => {
    const [d] = selectAttachments([att({ size: MAX_ATTACHMENT_BYTES + 1 })]);
    expect(d?.transfer).toBe(false);
    if (d && !d.transfer) expect(d.reason).toContain(String(MAX_ATTACHMENT_BYTES));
  });

  test('transfers at most MAX_TRANSFERRED files, in order', () => {
    const many = Array.from({ length: MAX_TRANSFERRED + 2 }, (_, i) => att({ id: String(i) }));
    const d = selectAttachments(many);
    expect(d.filter((x) => x.transfer)).toHaveLength(MAX_TRANSFERRED);
    expect(d[MAX_TRANSFERRED]?.transfer).toBe(false);
  });
});

describe('downloadAttachments', () => {
  test('downloads transferred files, strips a BOM, and passes through skips', async () => {
    const fake = createFakeFetch([
      { method: 'GET', urlIncludes: 'a.md', respond: () => new Response('\uFEFF# hello') },
    ]);
    const out = await downloadAttachments(
      [
        { attachment: att({ id: '1' }), transfer: true },
        { attachment: att({ id: '2', filename: 'p.png' }), transfer: false, reason: 'binary' },
      ],
      fake.fetch,
    );
    expect(out[0]).toMatchObject({ content: '# hello' });
    expect(out[1]).toMatchObject({ content: null, reason: 'binary' });
  });

  test('reports HTTP failures and over-cap bodies as not transferred', async () => {
    const fake = createFakeFetch([
      { method: 'GET', urlIncludes: 'gone', respond: () => new Response('', { status: 404 }) },
      { method: 'GET', urlIncludes: 'big', respond: () => new Response('x'.repeat(MAX_ATTACHMENT_BYTES + 1)) },
    ]);
    const out = await downloadAttachments(
      [
        { attachment: att({ url: 'https://cdn.example/gone' }), transfer: true },
        { attachment: att({ url: 'https://cdn.example/big' }), transfer: true },
      ],
      fake.fetch,
    );
    expect(out[0]).toMatchObject({ content: null, reason: 'download failed: HTTP 404' });
    expect(out[1]).toMatchObject({ content: null, reason: 'download exceeded size cap' });
  });

  test('reports a thrown fetch error instead of rejecting', async () => {
    const throwing = (async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const out = await downloadAttachments([{ attachment: att({}), transfer: true }], throwing);
    expect(out[0]).toMatchObject({ content: null, reason: 'download failed: boom' });
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test src/discord/attachments.test.ts`
Expected: FAIL — `Cannot find module './attachments.ts'`.

- [ ] **Step 4: Write the implementation**

`src/discord/attachments.ts`:

```ts
import type { ReportAttachment } from './interaction.ts';

export const MAX_ATTACHMENT_BYTES = 262_144;
export const MAX_TRANSFERRED = 5;
const DEFAULT_TIMEOUT_MS = 8_000;
const TEXT_EXTENSIONS = ['.md', '.txt', '.csv', '.tsv', '.json', '.log'];
const TEXT_MEDIA_TYPES = ['application/json', 'application/csv'];

export type AttachmentDecision =
  | { readonly attachment: ReportAttachment; readonly transfer: true }
  | { readonly attachment: ReportAttachment; readonly transfer: false; readonly reason: string };

export type DownloadedAttachment =
  | { readonly attachment: ReportAttachment; readonly content: string }
  | { readonly attachment: ReportAttachment; readonly content: null; readonly reason: string };

function isTextLike(a: ReportAttachment): boolean {
  const mediaType = (a.contentType ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (mediaType.startsWith('text/') || TEXT_MEDIA_TYPES.includes(mediaType)) return true;
  const name = a.filename.toLowerCase();
  return TEXT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

function rejectReason(a: ReportAttachment, transferredSoFar: number): string | null {
  if (!isTextLike(a)) return 'binary';
  if (a.size > MAX_ATTACHMENT_BYTES) return `larger than ${MAX_ATTACHMENT_BYTES} bytes`;
  if (transferredSoFar >= MAX_TRANSFERRED) return `more than ${MAX_TRANSFERRED} attachments`;
  return null;
}

export function selectAttachments(
  attachments: readonly ReportAttachment[],
): readonly AttachmentDecision[] {
  const initial = { decisions: [] as readonly AttachmentDecision[], transferred: 0 };
  return attachments.reduce((acc, attachment) => {
    const reason = rejectReason(attachment, acc.transferred);
    const decision: AttachmentDecision =
      reason === null ? { attachment, transfer: true } : { attachment, transfer: false, reason };
    return {
      decisions: [...acc.decisions, decision],
      transferred: acc.transferred + (reason === null ? 1 : 0),
    };
  }, initial).decisions;
}

async function downloadOne(
  attachment: ReportAttachment,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<DownloadedAttachment> {
  try {
    const res = await fetchFn(attachment.url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { attachment, content: null, reason: `download failed: HTTP ${res.status}` };
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      return { attachment, content: null, reason: 'download exceeded size cap' };
    }
    // TextDecoder strips a leading UTF-8 BOM by default (ignoreBOM: false).
    return { attachment, content: new TextDecoder('utf-8').decode(bytes) };
  } catch (err) {
    return { attachment, content: null, reason: `download failed: ${(err as Error).message}` };
  }
}

export function downloadAttachments(
  decisions: readonly AttachmentDecision[],
  fetchFn: typeof fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<readonly DownloadedAttachment[]> {
  return Promise.all(
    decisions.map((d) =>
      d.transfer
        ? downloadOne(d.attachment, fetchFn, timeoutMs)
        : Promise.resolve<DownloadedAttachment>({ attachment: d.attachment, content: null, reason: d.reason }),
    ),
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test src/discord/attachments.test.ts && bun run lint && bun run typecheck`
Expected: 7 pass; clean.

- [ ] **Step 6: Commit**

```bash
git add src/discord/attachments.ts src/discord/attachments.test.ts test/helpers/fake-fetch.ts
git commit -m "feat: attachment transfer policy and capped download"
```

---

### Task 7: Issue composition (title, body, comment chunks)

**Files:**
- Create: `src/github/issue-body.ts`
- Test: `src/github/issue-body.test.ts`

**Interfaces:**
- Consumes: `DiscordReport` (Task 5), `DownloadedAttachment` (Task 6).
- Produces:
  ```ts
  const MAX_CHUNK_CHARS = 60_000;
  interface ComposedIssue { readonly title: string; readonly body: string; readonly comments: readonly string[] }
  function composeIssue(report: DiscordReport, attachments: readonly DownloadedAttachment[]): ComposedIssue;
  function deriveTitle(report: DiscordReport): string;
  function fenceFor(content: string): string;
  ```

- [ ] **Step 1: Write the failing test**

`src/github/issue-body.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import type { DownloadedAttachment } from '../discord/attachments.ts';
import type { DiscordReport, ReportAttachment } from '../discord/interaction.ts';
import { MAX_CHUNK_CHARS, composeIssue, deriveTitle, fenceFor } from './issue-body.ts';

const REPORT: DiscordReport = {
  messageId: '333',
  guildId: '777',
  channelId: '123456789012345678',
  channelName: 'service-dam',
  authorUsername: 'HTokui',
  timestamp: '2026-09-06T12:18:00.000Z',
  content: '初めまして。HTといいます。\n貯水率について検証したところ、不一致がありました。',
  attachments: [],
  filedBy: 'matsubokkuri',
  invokerId: '42',
  interactionToken: 't',
};

function att(filename: string, size = 100, contentType: string | null = 'text/plain'): ReportAttachment {
  return { id: filename, filename, size, url: `https://cdn.example/${filename}`, contentType };
}

const ok = (filename: string, content: string): DownloadedAttachment => ({ attachment: att(filename, content.length), content });
const skipped = (filename: string, reason: string): DownloadedAttachment => ({ attachment: att(filename, 5, 'image/png'), content: null, reason });

describe('deriveTitle', () => {
  test('uses the first non-empty line with the [Discord] prefix', () => {
    expect(deriveTitle(REPORT)).toBe('[Discord] 初めまして。HTといいます。');
  });

  test('truncates to 80 characters', () => {
    const t = deriveTitle({ ...REPORT, content: 'x'.repeat(200) });
    expect(t.length).toBe(80);
    expect(t.startsWith('[Discord] ')).toBe(true);
  });

  test('falls back to author and date when the message has no text', () => {
    expect(deriveTitle({ ...REPORT, content: '  \n ' })).toBe('[Discord] Report from HTokui (2026-09-06)');
  });
});

describe('fenceFor', () => {
  test('is one backtick longer than the longest run inside', () => {
    expect(fenceFor('plain')).toBe('```');
    expect(fenceFor('has ``` fence')).toBe('````');
    expect(fenceFor('has ````` five')).toBe('``````');
  });
});

describe('composeIssue', () => {
  test('renders header, message, and inline attachments in the body', () => {
    const issue = composeIssue(REPORT, [ok('report.md', '# Report\n\nbody'), skipped('photo.png', 'binary')]);
    expect(issue.body).toContain('**Reported via Discord** by `HTokui` in `#service-dam` at 2026-09-06T12:18:00.000Z');
    expect(issue.body).toContain('https://discord.com/channels/777/123456789012345678/333');
    expect(issue.body).toContain('Filed by: `matsubokkuri` via message command');
    expect(issue.body).toContain('## Message\n\n初めまして。HTといいます。');
    expect(issue.body).toContain('### report.md (14 bytes, text/plain)\n<details><summary>Show content</summary>\n\n```md\n# Report\n\nbody\n```\n</details>');
    expect(issue.body).toContain('### photo.png (5 bytes, image/png) — not transferred: binary');
    expect(issue.comments).toEqual([]);
  });

  test('says "None" when there are no attachments', () => {
    expect(composeIssue(REPORT, []).body).toContain('## Attachments\n\n_None_');
  });

  test('moves attachments that do not fit into ordered comments and never exceeds the chunk limit', () => {
    const a = ok('a.txt', 'a'.repeat(30_000));
    const b = ok('b.txt', 'b'.repeat(35_000));
    const c = ok('c.txt', 'c'.repeat(10));
    const issue = composeIssue(REPORT, [a, b, c]);
    expect(issue.body.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    expect(issue.body).toContain('a.txt');
    expect(issue.body).not.toContain('b.txt');
    expect(issue.comments).toHaveLength(2);
    expect(issue.comments[0]).toContain('_Attachment 2 of 3_');
    expect(issue.comments[0]).toContain('b.txt');
    expect(issue.comments[1]).toContain('_Attachment 3 of 3_');
    for (const c of issue.comments) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  test('splits one oversize attachment into numbered parts that preserve every character', () => {
    const content = 'z'.repeat(130_000);
    const issue = composeIssue(REPORT, [ok('big.csv', content)]);
    expect(issue.comments.length).toBe(3);
    expect(issue.comments[0]).toContain('_Attachment 1 of 1 (part 1/3)_');
    expect(issue.comments[2]).toContain('(part 3/3)');
    for (const c of issue.comments) expect(c.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    const zs = issue.comments.reduce((n, c) => n + (c.match(/z/g)?.length ?? 0), 0);
    expect(zs).toBe(130_000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/github/issue-body.test.ts`
Expected: FAIL — `Cannot find module './issue-body.ts'`.

- [ ] **Step 3: Write the implementation**

`src/github/issue-body.ts`:

```ts
import type { DownloadedAttachment } from '../discord/attachments.ts';
import type { DiscordReport } from '../discord/interaction.ts';

export const MAX_CHUNK_CHARS = 60_000;
const MAX_TITLE_CHARS = 80;
const TITLE_PREFIX = '[Discord] ';
const PART_OVERHEAD_CHARS = 400;
const LANG_BY_EXT: Readonly<Record<string, string>> = {
  md: 'md',
  csv: 'csv',
  tsv: 'tsv',
  json: 'json',
  txt: 'text',
  log: 'text',
};

export interface ComposedIssue {
  readonly title: string;
  readonly body: string;
  readonly comments: readonly string[];
}

interface RenderedSection {
  readonly ordinal: number;
  readonly text: string;
  readonly meta: string;
  readonly lang: string;
  readonly content: string | null;
}

export function deriveTitle(report: DiscordReport): string {
  const firstLine = report.content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  const base = firstLine ?? `Report from ${report.authorUsername} (${report.timestamp.slice(0, 10)})`;
  const title = `${TITLE_PREFIX}${base}`;
  return title.length > MAX_TITLE_CHARS ? `${title.slice(0, MAX_TITLE_CHARS - 1)}…` : title;
}

export function fenceFor(content: string): string {
  const longest = Math.max(0, ...(content.match(/`+/g) ?? []).map((run) => run.length));
  return '`'.repeat(Math.max(3, longest + 1));
}

function langFor(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return LANG_BY_EXT[ext] ?? '';
}

function renderHeader(report: DiscordReport, attachmentCount: number): string {
  const link = report.guildId
    ? `https://discord.com/channels/${report.guildId}/${report.channelId}/${report.messageId}`
    : `(channel ${report.channelId}, message ${report.messageId})`;
  const channel = report.channelName ? `#${report.channelName}` : report.channelId;
  return [
    `**Reported via Discord** by \`${report.authorUsername}\` in \`${channel}\` at ${report.timestamp}`,
    `Original message: ${link}`,
    `Filed by: \`${report.filedBy}\` via message command`,
    '',
    '## Message',
    '',
    report.content,
    '',
    '## Attachments',
    '',
    ...(attachmentCount === 0 ? ['_None_', ''] : []),
  ].join('\n');
}

function renderSection(a: DownloadedAttachment, ordinal: number): RenderedSection {
  const { filename, size, contentType } = a.attachment;
  const meta = `${filename} (${size.toLocaleString('en-US')} bytes, ${contentType ?? 'unknown type'})`;
  const lang = langFor(filename);
  if (a.content === null) {
    return { ordinal, meta, lang, content: null, text: `### ${meta} — not transferred: ${a.reason}\n` };
  }
  const fence = fenceFor(a.content);
  const text = [
    `### ${meta}`,
    '<details><summary>Show content</summary>',
    '',
    `${fence}${lang}`,
    a.content,
    fence,
    '</details>',
    '',
  ].join('\n');
  return { ordinal, meta, lang, content: a.content, text };
}

function splitIntoParts(section: RenderedSection, total: number): readonly string[] {
  const content = section.content ?? '';
  const sliceSize = MAX_CHUNK_CHARS - PART_OVERHEAD_CHARS - section.meta.length;
  const parts = Math.max(1, Math.ceil(content.length / sliceSize));
  return Array.from({ length: parts }, (_, i) => {
    const slice = content.slice(i * sliceSize, (i + 1) * sliceSize);
    const fence = fenceFor(slice);
    return [
      `_Attachment ${section.ordinal} of ${total} (part ${i + 1}/${parts})_`,
      '',
      `### ${section.meta}`,
      '',
      `${fence}${section.lang}`,
      slice,
      fence,
      '',
    ].join('\n');
  });
}

function toComments(section: RenderedSection, total: number): readonly string[] {
  const heading = `_Attachment ${section.ordinal} of ${total}_`;
  const whole = `${heading}\n\n${section.text}`;
  if (whole.length <= MAX_CHUNK_CHARS || section.content === null) return [whole];
  return splitIntoParts(section, total);
}

export function composeIssue(
  report: DiscordReport,
  attachments: readonly DownloadedAttachment[],
): ComposedIssue {
  const header = renderHeader(report, attachments.length);
  const sections = attachments.map((a, i) => renderSection(a, i + 1));
  const packed = sections.reduce(
    (acc, section) => {
      const fits = acc.overflow.length === 0 && acc.body.length + section.text.length + 1 <= MAX_CHUNK_CHARS;
      return fits
        ? { body: `${acc.body}\n${section.text}`, overflow: acc.overflow }
        : { body: acc.body, overflow: [...acc.overflow, section] };
    },
    { body: header, overflow: [] as readonly RenderedSection[] },
  );
  const comments = packed.overflow.flatMap((s) => toComments(s, sections.length));
  return { title: deriveTitle(report), body: packed.body, comments };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/github/issue-body.test.ts && bun run lint && bun run typecheck`
Expected: 9 pass; clean. If the inline-attachment assertion fails on whitespace, compare the exact `join('\n')` output in `renderSection` against the expected string in the test — the test is the contract.

- [ ] **Step 5: Commit**

```bash
git add src/github/issue-body.ts src/github/issue-body.test.ts
git commit -m "feat: compose issue title, body, and overflow comments from a Discord report"
```

---

### Task 8: Outbound HTTP clients (GitHub REST, Discord follow-up)

**Files:**
- Create: `src/github/issues.ts`, `src/discord/followup.ts`
- Test: `src/github/issues.test.ts`, `src/discord/followup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  interface CreatedIssue { readonly number: number; readonly htmlUrl: string }
  interface GitHubClient {
    createIssue(repo: string, title: string, body: string): Promise<CreatedIssue>;
    addComment(repo: string, issueNumber: number, body: string): Promise<void>;
    addLabels(repo: string, issueNumber: number, labels: readonly string[]): Promise<void>;
  }
  class GitHubApiError extends Error { readonly status: number }
  function createGitHubClient(token: string, fetchFn: typeof fetch, baseUrl?: string): GitHubClient;
  function editOriginalResponse(args: { appId: string; token: string; content: string; fetchFn: typeof fetch; baseUrl?: string }): Promise<boolean>;
  ```

- [ ] **Step 1: Write the failing tests**

`src/github/issues.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createFakeFetch, jsonResponse } from '../../test/helpers/fake-fetch.ts';
import { GitHubApiError, createGitHubClient } from './issues.ts';

describe('createGitHubClient', () => {
  test('creates an issue and returns number + url', async () => {
    const fake = createFakeFetch([
      { method: 'POST', urlIncludes: '/repos/matsubo/dam/issues', respond: () => jsonResponse(201, { number: 21, html_url: 'https://github.com/matsubo/dam/issues/21' }) },
    ]);
    const gh = createGitHubClient('tok', fake.fetch);
    const created = await gh.createIssue('matsubo/dam', 'T', 'B');
    expect(created).toEqual({ number: 21, htmlUrl: 'https://github.com/matsubo/dam/issues/21' });
    expect(fake.calls[0]).toMatchObject({ method: 'POST', url: 'https://api.github.com/repos/matsubo/dam/issues', body: { title: 'T', body: 'B' } });
  });

  test('posts comments and labels to the issue sub-resources', async () => {
    const fake = createFakeFetch([
      { method: 'POST', urlIncludes: '/issues/21/comments', respond: () => jsonResponse(201, { id: 1 }) },
      { method: 'POST', urlIncludes: '/issues/21/labels', respond: () => jsonResponse(200, []) },
    ]);
    const gh = createGitHubClient('tok', fake.fetch);
    await gh.addComment('matsubo/dam', 21, 'c');
    await gh.addLabels('matsubo/dam', 21, ['from-discord', 'auto-fix']);
    expect(fake.calls.map((c) => c.url)).toEqual([
      'https://api.github.com/repos/matsubo/dam/issues/21/comments',
      'https://api.github.com/repos/matsubo/dam/issues/21/labels',
    ]);
    expect(fake.calls[1]?.body).toEqual({ labels: ['from-discord', 'auto-fix'] });
  });

  test('throws GitHubApiError with the status on failure', async () => {
    const fake = createFakeFetch([{ method: 'POST', urlIncludes: '/issues', respond: () => jsonResponse(422, { message: 'nope' }) }]);
    const gh = createGitHubClient('tok', fake.fetch);
    await expect(gh.createIssue('matsubo/dam', 'T', 'B')).rejects.toBeInstanceOf(GitHubApiError);
    await expect(gh.createIssue('matsubo/dam', 'T', 'B')).rejects.toMatchObject({ status: 422 });
  });
});
```

`src/discord/followup.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createFakeFetch } from '../../test/helpers/fake-fetch.ts';
import { editOriginalResponse } from './followup.ts';

describe('editOriginalResponse', () => {
  test('PATCHes the @original message and returns true on 2xx', async () => {
    const fake = createFakeFetch([{ method: 'PATCH', urlIncludes: '/messages/@original', respond: () => new Response('{}') }]);
    const ok = await editOriginalResponse({ appId: '999', token: 'tok', content: 'Issue created: u', fetchFn: fake.fetch });
    expect(ok).toBe(true);
    expect(fake.calls[0]).toMatchObject({
      method: 'PATCH',
      url: 'https://discord.com/api/v10/webhooks/999/tok/messages/@original',
      body: { content: 'Issue created: u' },
    });
  });

  test('returns false on HTTP failure or thrown error', async () => {
    const failing = createFakeFetch([{ method: 'PATCH', urlIncludes: '@original', respond: () => new Response('', { status: 500 }) }]);
    expect(await editOriginalResponse({ appId: '9', token: 't', content: 'x', fetchFn: failing.fetch })).toBe(false);
    const throwing = (async () => {
      throw new Error('net');
    }) as unknown as typeof fetch;
    expect(await editOriginalResponse({ appId: '9', token: 't', content: 'x', fetchFn: throwing })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test src/github/issues.test.ts src/discord/followup.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the implementations**

`src/github/issues.ts`:

```ts
const DEFAULT_BASE_URL = 'https://api.github.com';
const TIMEOUT_MS = 15_000;

export interface CreatedIssue {
  readonly number: number;
  readonly htmlUrl: string;
}

export interface GitHubClient {
  createIssue(repo: string, title: string, body: string): Promise<CreatedIssue>;
  addComment(repo: string, issueNumber: number, body: string): Promise<void>;
  addLabels(repo: string, issueNumber: number, labels: readonly string[]): Promise<void>;
}

export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'GitHubApiError';
  }
}

export function createGitHubClient(
  token: string,
  fetchFn: typeof fetch,
  baseUrl = DEFAULT_BASE_URL,
): GitHubClient {
  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetchFn(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'discord-issue-bridge',
        'x-github-api-version': '2022-11-28',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new GitHubApiError(res.status, `GitHub POST ${path} failed: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  return {
    async createIssue(repo, title, body) {
      const r = await post<{ number: number; html_url: string }>(`/repos/${repo}/issues`, { title, body });
      return { number: r.number, htmlUrl: r.html_url };
    },
    async addComment(repo, issueNumber, body) {
      await post(`/repos/${repo}/issues/${issueNumber}/comments`, { body });
    },
    async addLabels(repo, issueNumber, labels) {
      await post(`/repos/${repo}/issues/${issueNumber}/labels`, { labels: [...labels] });
    },
  };
}
```

`src/discord/followup.ts`:

```ts
const DEFAULT_BASE_URL = 'https://discord.com/api/v10';
const TIMEOUT_MS = 8_000;

export async function editOriginalResponse(args: {
  appId: string;
  token: string;
  content: string;
  fetchFn: typeof fetch;
  baseUrl?: string;
}): Promise<boolean> {
  const base = args.baseUrl ?? DEFAULT_BASE_URL;
  try {
    const res = await args.fetchFn(`${base}/webhooks/${args.appId}/${args.token}/messages/@original`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: args.content }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test src/github/issues.test.ts src/discord/followup.test.ts && bun run lint && bun run typecheck`
Expected: 5 pass; clean.

- [ ] **Step 5: Commit**

```bash
git add src/github/issues.ts src/github/issues.test.ts src/discord/followup.ts src/discord/followup.test.ts
git commit -m "feat: GitHub issue client and Discord follow-up editor"
```

---

### Task 9: Deferred work orchestration

**Files:**
- Create: `src/process-report.ts`
- Test: `src/process-report.test.ts`

**Interfaces:**
- Consumes: `DiscordReport` (Task 5), `Route` (Task 3), `selectAttachments`/`downloadAttachments` (Task 6), `composeIssue` (Task 7), `GitHubClient`/`GitHubApiError` (Task 8), `editOriginalResponse` (Task 8).
- Produces:
  ```ts
  interface ProcessDeps {
    readonly github: GitHubClient; readonly fetch: typeof fetch; readonly discordAppId: string;
    readonly log: (message: string) => void; readonly discordBaseUrl?: string;
  }
  function processReport(report: DiscordReport, route: Route, deps: ProcessDeps): Promise<void>;
  ```

- [ ] **Step 1: Write the failing test**

`src/process-report.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createFakeFetch } from '../test/helpers/fake-fetch.ts';
import type { DiscordReport } from './discord/interaction.ts';
import { GitHubApiError, type GitHubClient } from './github/issues.ts';
import { processReport } from './process-report.ts';
import type { Route } from './routing.ts';

const ROUTE: Route = { repo: 'matsubo/dam', labels: ['from-discord', 'auto-fix'] };

const REPORT: DiscordReport = {
  messageId: '333',
  guildId: '777',
  channelId: '123456789012345678',
  channelName: 'service-dam',
  authorUsername: 'HTokui',
  timestamp: '2026-09-06T12:18:00.000Z',
  content: 'hello',
  attachments: [
    { id: 'a1', filename: 'big.txt', size: 70_000, url: 'https://cdn.example/big.txt', contentType: 'text/plain' },
  ],
  filedBy: 'matsubokkuri',
  invokerId: '42',
  interactionToken: 'tok',
};

interface Recorded { readonly op: string; readonly args: readonly unknown[] }

function fakeGitHub(overrides: Partial<GitHubClient> = {}): { client: GitHubClient; ops: Recorded[] } {
  const ops: Recorded[] = [];
  const client: GitHubClient = {
    async createIssue(...args) {
      ops.push({ op: 'create', args });
      return { number: 7, htmlUrl: 'https://github.com/matsubo/dam/issues/7' };
    },
    async addComment(...args) {
      ops.push({ op: 'comment', args });
    },
    async addLabels(...args) {
      ops.push({ op: 'labels', args });
    },
    ...overrides,
  };
  return { client, ops };
}

function discordAndCdn() {
  return createFakeFetch([
    { method: 'GET', urlIncludes: 'big.txt', respond: () => new Response('x'.repeat(70_000)) },
    { method: 'PATCH', urlIncludes: '@original', respond: () => new Response('{}') },
  ]);
}

describe('processReport', () => {
  test('writes create → comments → labels, then replies with the issue URL', async () => {
    const gh = fakeGitHub();
    const fake = discordAndCdn();
    const logs: string[] = [];
    await processReport(REPORT, ROUTE, { github: gh.client, fetch: fake.fetch, discordAppId: '999', log: (m) => logs.push(m) });
    expect(gh.ops.map((o) => o.op)).toEqual(['create', 'comment', 'comment', 'labels']);
    expect(gh.ops[3]?.args).toEqual(['matsubo/dam', 7, ['from-discord', 'auto-fix']]);
    const patch = fake.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ content: 'Issue created: https://github.com/matsubo/dam/issues/7' });
  });

  test('reports a create failure to Discord and stops', async () => {
    const gh = fakeGitHub({
      async createIssue() {
        throw new GitHubApiError(401, 'GitHub POST /repos/matsubo/dam/issues failed: HTTP 401');
      },
    });
    const fake = discordAndCdn();
    await processReport(REPORT, ROUTE, { github: gh.client, fetch: fake.fetch, discordAppId: '999', log: () => undefined });
    expect(gh.ops.map((o) => o.op)).toEqual([]);
    const patch = fake.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ content: 'Failed to create issue: HTTP 401' });
  });

  test('applies no labels when a comment fails, and says so', async () => {
    const gh = fakeGitHub({
      async addComment() {
        throw new GitHubApiError(500, 'GitHub POST /repos/matsubo/dam/issues/7/comments failed: HTTP 500');
      },
    });
    const fake = discordAndCdn();
    await processReport(REPORT, ROUTE, { github: gh.client, fetch: fake.fetch, discordAppId: '999', log: () => undefined });
    expect(gh.ops.map((o) => o.op)).toEqual(['create']);
    const patch = fake.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({
      content: 'Issue created: https://github.com/matsubo/dam/issues/7\n⚠️ attachments incomplete (HTTP 500); labels not applied, so auto-fix will not start',
    });
  });

  test('warns when labels fail after comments succeeded', async () => {
    const gh = fakeGitHub({
      async addLabels() {
        throw new GitHubApiError(404, 'GitHub POST /repos/matsubo/dam/issues/7/labels failed: HTTP 404');
      },
    });
    const fake = discordAndCdn();
    await processReport(REPORT, ROUTE, { github: gh.client, fetch: fake.fetch, discordAppId: '999', log: () => undefined });
    const patch = fake.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({
      content: 'Issue created: https://github.com/matsubo/dam/issues/7\n⚠️ labels not applied (HTTP 404)',
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/process-report.test.ts`
Expected: FAIL — `Cannot find module './process-report.ts'`.

- [ ] **Step 3: Write the implementation**

`src/process-report.ts`:

```ts
import { downloadAttachments, selectAttachments } from './discord/attachments.ts';
import { editOriginalResponse } from './discord/followup.ts';
import type { DiscordReport } from './discord/interaction.ts';
import { composeIssue } from './github/issue-body.ts';
import { type CreatedIssue, GitHubApiError, type GitHubClient } from './github/issues.ts';
import type { Route } from './routing.ts';

export interface ProcessDeps {
  readonly github: GitHubClient;
  readonly fetch: typeof fetch;
  readonly discordAppId: string;
  readonly log: (message: string) => void;
  readonly discordBaseUrl?: string;
}

type Step<T> = { ok: true; value: T } | { ok: false; error: string };

function describeError(err: unknown): string {
  if (err instanceof GitHubApiError) return `HTTP ${err.status}`;
  return err instanceof Error ? err.message : String(err);
}

async function attempt<T>(work: () => Promise<T>): Promise<Step<T>> {
  try {
    return { ok: true, value: await work() };
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }
}

async function postComments(
  github: GitHubClient,
  repo: string,
  issue: CreatedIssue,
  comments: readonly string[],
): Promise<Step<void>> {
  for (const comment of comments) {
    const step = await attempt(() => github.addComment(repo, issue.number, comment));
    if (!step.ok) return step;
  }
  return { ok: true, value: undefined };
}

export async function processReport(
  report: DiscordReport,
  route: Route,
  deps: ProcessDeps,
): Promise<void> {
  const reply = async (content: string): Promise<void> => {
    const sent = await editOriginalResponse({
      appId: deps.discordAppId,
      token: report.interactionToken,
      content,
      fetchFn: deps.fetch,
      ...(deps.discordBaseUrl === undefined ? {} : { baseUrl: deps.discordBaseUrl }),
    });
    if (!sent) deps.log(`discord follow-up failed for message ${report.messageId}`);
  };

  const downloaded = await downloadAttachments(selectAttachments(report.attachments), deps.fetch);
  const issue = composeIssue(report, downloaded);

  const created = await attempt(() => deps.github.createIssue(route.repo, issue.title, issue.body));
  if (!created.ok) {
    deps.log(`issue creation failed for ${route.repo}: ${created.error}`);
    await reply(`Failed to create issue: ${created.error}`);
    return;
  }

  const comments = await postComments(deps.github, route.repo, created.value, issue.comments);
  if (!comments.ok) {
    deps.log(`comment failed on ${route.repo}#${created.value.number}: ${comments.error}`);
    await reply(
      `Issue created: ${created.value.htmlUrl}\n⚠️ attachments incomplete (${comments.error}); labels not applied, so auto-fix will not start`,
    );
    return;
  }

  const labels = await attempt(() => deps.github.addLabels(route.repo, created.value.number, route.labels));
  if (!labels.ok) {
    deps.log(`labels failed on ${route.repo}#${created.value.number}: ${labels.error}`);
    await reply(`Issue created: ${created.value.htmlUrl}\n⚠️ labels not applied (${labels.error})`);
    return;
  }

  deps.log(`issue created ${created.value.htmlUrl} from message ${report.messageId}`);
  await reply(`Issue created: ${created.value.htmlUrl}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test src/process-report.test.ts && bun run lint && bun run typecheck`
Expected: 4 pass; clean.

- [ ] **Step 5: Commit**

```bash
git add src/process-report.ts src/process-report.test.ts
git commit -m "feat: orchestrate deferred work with labels applied last"
```

---

### Task 10: HTTP handler

**Files:**
- Create: `src/handler.ts`
- Test: `src/handler.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 2), `RouteTable`/`resolveRoute` (Task 3), `verifyDiscordSignature` (Task 4), `parseInteraction`/`toDiscordReport` (Task 5), `GitHubClient` (Task 8), `processReport` (Task 9).
- Produces:
  ```ts
  interface HandlerDeps {
    readonly config: Config | null; readonly configError: string | null;
    readonly routes: RouteTable; readonly github: GitHubClient; readonly fetch: typeof fetch;
    readonly background: (work: Promise<void>) => void; readonly log: (message: string) => void;
    readonly discordBaseUrl?: string;
  }
  function handle(request: Request, deps: HandlerDeps): Promise<Response>;
  ```

- [ ] **Step 1: Write the failing test**

`src/handler.test.ts`:

```ts
import { beforeAll, describe, expect, test } from 'bun:test';
import { MESSAGE_COMMAND, PING } from '../test/fixtures/interactions.ts';
import { createSigningKeys, type SigningKeys } from '../test/helpers/discord-signing.ts';
import { createFakeFetch, jsonResponse } from '../test/helpers/fake-fetch.ts';
import type { Config } from './config.ts';
import { createGitHubClient } from './github/issues.ts';
import { type HandlerDeps, handle } from './handler.ts';
import { parseRoutes } from './routing.ts';

let keys: SigningKeys;
beforeAll(async () => {
  keys = await createSigningKeys();
});

function config(over: Partial<Config> = {}): Config {
  return {
    discordPublicKey: keys.publicKeyHex,
    discordAppId: '999',
    allowedUserIds: new Set(['42']),
    githubToken: 'tok',
    port: 3000,
    routesPath: './routes.json',
    ...over,
  };
}

function routes() {
  const r = parseRoutes({ '123456789012345678': { repo: 'matsubo/dam' } });
  if (!r.ok) throw new Error(r.error);
  return r.routes;
}

function fakeUpstreams() {
  return createFakeFetch([
    { method: 'GET', urlIncludes: 'teraren_report.md', respond: () => new Response('# report') },
    { method: 'GET', urlIncludes: 'teraren_report_capacity.csv', respond: () => new Response('a,b\n1,2') },
    { method: 'POST', urlIncludes: '/repos/matsubo/dam/issues/7/labels', respond: () => jsonResponse(200, []) },
    { method: 'POST', urlIncludes: '/repos/matsubo/dam/issues/7/comments', respond: () => jsonResponse(201, {}) },
    { method: 'POST', urlIncludes: '/repos/matsubo/dam/issues', respond: () => jsonResponse(201, { number: 7, html_url: 'https://github.com/matsubo/dam/issues/7' }) },
    { method: 'PATCH', urlIncludes: '@original', respond: () => new Response('{}') },
  ]);
}

function deps(over: Partial<HandlerDeps> = {}) {
  const fake = fakeUpstreams();
  const pending: Promise<void>[] = [];
  const d: HandlerDeps = {
    config: config(),
    configError: null,
    routes: routes(),
    github: createGitHubClient('tok', fake.fetch),
    fetch: fake.fetch,
    background: (p) => {
      pending.push(p);
    },
    log: () => undefined,
    ...over,
  };
  return { d, fake, pending };
}

async function signed(payload: unknown, sign = true): Promise<Request> {
  const body = JSON.stringify(payload);
  const ts = '1757200000';
  const sig = sign ? await keys.sign(ts, body) : 'ab'.repeat(64);
  return new Request('http://bridge.local/discord/interactions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature-ed25519': sig, 'x-signature-timestamp': ts },
    body,
  });
}

describe('handle', () => {
  test('GET /healthz is 200 when configured and 503 when not', async () => {
    const ok = await handle(new Request('http://bridge.local/healthz'), deps().d);
    expect(ok.status).toBe(200);
    const bad = await handle(new Request('http://bridge.local/healthz'), deps({ config: null, configError: 'missing key' }).d);
    expect(bad.status).toBe(503);
    expect(await bad.json()).toEqual({ ok: false, error: 'missing key' });
  });

  test('unknown paths are 404', async () => {
    const res = await handle(new Request('http://bridge.local/nope'), deps().d);
    expect(res.status).toBe(404);
  });

  test('interactions are 503 when unconfigured, before reading the signature', async () => {
    const res = await handle(await signed(PING), deps({ config: null, configError: 'x' }).d);
    expect(res.status).toBe(503);
  });

  test('rejects a bad signature with 401', async () => {
    const res = await handle(await signed(PING, false), deps().d);
    expect(res.status).toBe(401);
  });

  test('answers PING with PONG', async () => {
    const res = await handle(await signed(PING), deps().d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ type: 1 });
  });

  test('rejects an unparseable payload with 400', async () => {
    const res = await handle(await signed({ type: 2, data: {} }), deps().d);
    expect(res.status).toBe(400);
  });

  test('replies ephemerally to a non-allow-listed user and does no work', async () => {
    const { d, pending } = deps({ config: config({ allowedUserIds: new Set(['1']) }) });
    const res = await handle(await signed(MESSAGE_COMMAND), d);
    expect(await res.json()).toEqual({ type: 4, data: { content: 'This command is restricted to the maintainer.', flags: 64 } });
    expect(pending).toHaveLength(0);
  });

  test('replies ephemerally for an unmapped channel and does no work', async () => {
    const { d, pending } = deps();
    const res = await handle(await signed({ ...MESSAGE_COMMAND, channel_id: '999999999999999999' }), d);
    expect(await res.json()).toEqual({ type: 4, data: { content: 'This channel is not mapped to a repository.', flags: 64 } });
    expect(pending).toHaveLength(0);
  });

  test('defers, then creates the issue, comments, labels, and follows up — labels after the last comment', async () => {
    const { d, fake, pending } = deps();
    const res = await handle(await signed(MESSAGE_COMMAND), d);
    expect(await res.json()).toEqual({ type: 5 });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
    const writes = fake.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${new URL(c.url).pathname}`);
    expect(writes).toEqual([
      'POST /repos/matsubo/dam/issues',
      'POST /repos/matsubo/dam/issues/7/labels',
      'PATCH /api/v10/webhooks/999/interaction-token/messages/@original',
    ]);
    const create = fake.calls.find((c) => c.url.endsWith('/repos/matsubo/dam/issues'));
    expect(create?.body).toMatchObject({ title: '[Discord] 初めまして。HTといいます。貯水率について検証したところ、不一致がありました。' });
    expect(String((create?.body as { body: string }).body)).toContain('# report');
    expect(String((create?.body as { body: string }).body)).toContain('a,b\n1,2');
    const labelIndex = writes.findIndex((w) => w.endsWith('/labels'));
    const lastComment = writes.map((w, i) => (w.endsWith('/comments') ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
    expect(labelIndex).toBeGreaterThan(lastComment);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/handler.test.ts`
Expected: FAIL — `Cannot find module './handler.ts'`.

- [ ] **Step 3: Write the implementation**

`src/handler.ts`:

```ts
import type { Config } from './config.ts';
import { parseInteraction, toDiscordReport } from './discord/interaction.ts';
import { verifyDiscordSignature } from './discord/verify.ts';
import type { GitHubClient } from './github/issues.ts';
import { processReport } from './process-report.ts';
import { type RouteTable, resolveRoute } from './routing.ts';

export interface HandlerDeps {
  readonly config: Config | null;
  readonly configError: string | null;
  readonly routes: RouteTable;
  readonly github: GitHubClient;
  readonly fetch: typeof fetch;
  readonly background: (work: Promise<void>) => void;
  readonly log: (message: string) => void;
  readonly discordBaseUrl?: string;
}

const INTERACTIONS_PATH = '/discord/interactions';
const HEALTH_PATH = '/healthz';
const PONG = 1;
const CHANNEL_MESSAGE = 4;
const DEFERRED = 5;
const EPHEMERAL_FLAG = 64;
const RESTRICTED_MESSAGE = 'This command is restricted to the maintainer.';
const UNMAPPED_MESSAGE = 'This channel is not mapped to a repository.';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function ephemeral(content: string): Response {
  return json(200, { type: CHANNEL_MESSAGE, data: { content, flags: EPHEMERAL_FLAG } });
}

async function handleInteraction(req: Request, deps: HandlerDeps, config: Config): Promise<Response> {
  const body = await req.text();
  const valid = await verifyDiscordSignature({
    publicKeyHex: config.discordPublicKey,
    signatureHex: req.headers.get('x-signature-ed25519'),
    timestamp: req.headers.get('x-signature-timestamp'),
    body,
  });
  if (!valid) return new Response(null, { status: 401 });

  const parsed = parseInteraction(body);
  if (!parsed.ok) return json(400, { error: parsed.error });
  if (parsed.interaction.type === 1) return json(200, { type: PONG });

  const extracted = toDiscordReport(parsed.interaction);
  if (!extracted.ok) return json(400, { error: extracted.reason });
  const { report } = extracted;

  if (!config.allowedUserIds.has(report.invokerId)) return ephemeral(RESTRICTED_MESSAGE);
  const route = resolveRoute(deps.routes, report.channelId);
  if (!route) return ephemeral(UNMAPPED_MESSAGE);

  deps.background(
    processReport(report, route, {
      github: deps.github,
      fetch: deps.fetch,
      discordAppId: config.discordAppId,
      log: deps.log,
      ...(deps.discordBaseUrl === undefined ? {} : { discordBaseUrl: deps.discordBaseUrl }),
    }),
  );
  return json(200, { type: DEFERRED });
}

export async function handle(req: Request, deps: HandlerDeps): Promise<Response> {
  const { pathname } = new URL(req.url);
  if (pathname === HEALTH_PATH) {
    return deps.config
      ? json(200, { ok: true })
      : json(503, { ok: false, error: deps.configError ?? 'not configured' });
  }
  if (pathname === INTERACTIONS_PATH && req.method === 'POST') {
    if (!deps.config) return json(503, { error: deps.configError ?? 'not configured' });
    return handleInteraction(req, deps, deps.config);
  }
  return json(404, { error: 'not found' });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test && bun run lint && bun run typecheck`
Expected: all suites pass (9 in this file); clean.

- [ ] **Step 5: Commit**

```bash
git add src/handler.ts src/handler.test.ts
git commit -m "feat: HTTP handler for /healthz and Discord interactions"
```

---

### Task 11: Server wiring, SIGTERM drain, container

**Files:**
- Create: `src/background.ts`, `src/server.ts`, `Dockerfile`, `routes.json`, `.env.example`
- Test: `src/background.test.ts`

**Interfaces:**
- Consumes: `loadConfig` (Task 2), `loadRoutes` (Task 3), `createGitHubClient` (Task 8), `handle` (Task 10).
- Produces:
  ```ts
  interface BackgroundTracker { readonly background: (work: Promise<void>) => void; drain(timeoutMs: number): Promise<number> /* unfinished count */ }
  function createBackgroundTracker(log: (message: string) => void): BackgroundTracker;
  ```

- [ ] **Step 1: Write the failing test**

`src/background.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createBackgroundTracker } from './background.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('createBackgroundTracker', () => {
  test('drain waits for in-flight work and returns 0', async () => {
    const t = createBackgroundTracker(() => undefined);
    const done: string[] = [];
    t.background(sleep(20).then(() => void done.push('a')));
    expect(await t.drain(1000)).toBe(0);
    expect(done).toEqual(['a']);
  });

  test('drain gives up after the timeout and reports unfinished work', async () => {
    const t = createBackgroundTracker(() => undefined);
    t.background(sleep(500));
    expect(await t.drain(20)).toBe(1);
  });

  test('a rejected job is logged and does not break tracking', async () => {
    const logs: string[] = [];
    const t = createBackgroundTracker((m) => logs.push(m));
    t.background(Promise.reject(new Error('boom')));
    expect(await t.drain(100)).toBe(0);
    expect(logs[0]).toContain('boom');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test src/background.test.ts`
Expected: FAIL — `Cannot find module './background.ts'`.

- [ ] **Step 3: Write the implementation and the server**

`src/background.ts`:

```ts
export interface BackgroundTracker {
  readonly background: (work: Promise<void>) => void;
  drain(timeoutMs: number): Promise<number>;
}

// The Set is process-local state owned by this closure; nothing outside can reach it.
export function createBackgroundTracker(log: (message: string) => void): BackgroundTracker {
  const inflight = new Set<Promise<void>>();
  return {
    background(work) {
      const tracked = work
        .catch((err: unknown) => log(`background job failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => inflight.delete(tracked));
      inflight.add(tracked);
    },
    async drain(timeoutMs) {
      const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), timeoutMs));
      await Promise.race([Promise.all([...inflight]), timeout]);
      return inflight.size;
    },
  };
}
```

`src/server.ts`:

```ts
import { createBackgroundTracker } from './background.ts';
import { loadConfig } from './config.ts';
import { createGitHubClient } from './github/issues.ts';
import { handle } from './handler.ts';
import { type Route, loadRoutes } from './routing.ts';

const DRAIN_TIMEOUT_MS = 10_000;

const log = (message: string): void => {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`);
};

const configResult = loadConfig(process.env);
const routesResult = configResult.ok ? await loadRoutes(configResult.config.routesPath) : null;

const configError = !configResult.ok
  ? configResult.error
  : routesResult && !routesResult.ok
    ? routesResult.error
    : null;
if (configError) log(`startup: ${configError} — serving 503 until fixed`);

const config = configResult.ok && routesResult?.ok ? configResult.config : null;
const routes = routesResult?.ok ? routesResult.routes : new Map<string, Route>();
const tracker = createBackgroundTracker(log);
const github = createGitHubClient(config?.githubToken ?? '', fetch);

const server = Bun.serve({
  port: configResult.ok ? configResult.config.port : Number(process.env.PORT ?? 3000),
  fetch: (req) => handle(req, { config, configError, routes, github, fetch, background: tracker.background, log }),
});
log(`listening on :${server.port} with ${routes.size} route(s)`);

process.on('SIGTERM', async () => {
  log('SIGTERM: draining in-flight work');
  server.stop();
  const unfinished = await tracker.drain(DRAIN_TIMEOUT_MS);
  if (unfinished > 0) log(`exiting with ${unfinished} unfinished job(s)`);
  process.exit(0);
});
```

`routes.json` (empty until the maintainer adds channel IDs in Task 13):

```json
{}
```

`.env.example`:

```
DISCORD_PUBLIC_KEY=
DISCORD_APP_ID=
DISCORD_ALLOWED_USER_IDS=
GITHUB_TOKEN=
PORT=3000
ROUTES_PATH=./routes.json
```

`Dockerfile`:

```dockerfile
FROM oven/bun:1.3
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY src ./src
COPY routes.json ./routes.json
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:3000/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "run", "src/server.ts"]
```

- [ ] **Step 4: Run the tests, then smoke-test the real server and the image**

```bash
bun test && bun run lint && bun run typecheck
# Unconfigured boot must serve 503 on /healthz, not crash:
(bun run src/server.ts &) ; sleep 1; curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/healthz; pkill -f 'bun run src/server.ts'
# Container builds and starts:
docker build -t discord-issue-bridge:dev .
docker run --rm -d --name dib -p 3100:3000 -e DISCORD_PUBLIC_KEY=$(printf 'a%.0s' $(seq 64)) -e DISCORD_APP_ID=1 -e DISCORD_ALLOWED_USER_IDS=1 -e GITHUB_TOKEN=x discord-issue-bridge:dev
sleep 2; curl -s http://127.0.0.1:3100/healthz; echo; docker stop dib
```

Expected: tests pass; first curl prints `503`; second curl prints `{"ok":true}`.

- [ ] **Step 5: Commit**

```bash
git add src/background.ts src/background.test.ts src/server.ts routes.json .env.example Dockerfile
git commit -m "feat: Bun server with SIGTERM drain, routes.json, and container image"
```

---

### Task 12: Command registration script

**Files:**
- Create: `bin/register-command.ts`

**Interfaces:**
- Consumes: `COMMAND_NAME` (Task 5).

- [ ] **Step 1: Write the script**

`bin/register-command.ts`:

```ts
import { z } from 'zod';
import { COMMAND_NAME } from '../src/discord/interaction.ts';

const env = z
  .object({
    DISCORD_BOT_TOKEN: z.string().min(1),
    DISCORD_APP_ID: z.string().min(1),
    DISCORD_GUILD_ID: z.string().min(1),
  })
  .safeParse(process.env);

if (!env.success) {
  process.stderr.write('Set DISCORD_BOT_TOKEN, DISCORD_APP_ID, and DISCORD_GUILD_ID.\n');
  process.exit(1);
}

const MESSAGE_COMMAND_TYPE = 3;
const GUILD_CONTEXT = 0;
const ADMIN_ONLY = '0';

const url = `https://discord.com/api/v10/applications/${env.data.DISCORD_APP_ID}/guilds/${env.data.DISCORD_GUILD_ID}/commands`;
const res = await fetch(url, {
  method: 'PUT',
  headers: { authorization: `Bot ${env.data.DISCORD_BOT_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify([
    { name: COMMAND_NAME, type: MESSAGE_COMMAND_TYPE, default_member_permissions: ADMIN_ONLY, contexts: [GUILD_CONTEXT] },
  ]),
});

process.stdout.write(`${res.status} ${await res.text()}\n`);
process.exit(res.ok ? 0 : 1);
```

- [ ] **Step 2: Verify it refuses to run without credentials**

Run: `bun run bin/register-command.ts; echo "exit=$?"`
Expected: prints the "Set DISCORD_BOT_TOKEN…" line and `exit=1`. Lint and typecheck stay clean: `bun run lint && bun run typecheck`.

- [ ] **Step 3: Commit**

```bash
git add bin/register-command.ts
git commit -m "feat: one-off guild message-command registration script"
```

---

### Task 13: Live handshake, deployment, production Discord setup (manual checklist)

This task is performed by the maintainer with the agent's help; every command is listed so nothing is improvised. Do not push or deploy until the maintainer says so.

- [ ] **Step 1: Throwaway Discord application for the local test**

In https://discord.com/developers/applications: *New Application* → name `issue-bridge-dev`. Copy **Application ID** and **Public Key** (General Information) and the **Bot Token** (Bot → Reset Token). Under *OAuth2 → URL Generator* tick scope `applications.commands`, open the generated URL, add it to the maintainer's server.

- [ ] **Step 2: Run the bridge locally behind a tunnel**

```bash
cd /Volumes/nvme/matsu/ghq/github.com/matsubo/discord-issue-bridge
brew install cloudflared   # if missing
cp .env.example .env       # fill DISCORD_PUBLIC_KEY, DISCORD_APP_ID (dev app), DISCORD_ALLOWED_USER_IDS (your Discord user id: Settings → Advanced → Developer Mode, then right-click your name → Copy User ID), GITHUB_TOKEN (fine-grained PAT, Issues RW, on a scratch repo)
```

Create a scratch repository and route a test channel to it (right-click the channel → *Copy Channel ID*):

```bash
gh repo create matsubo/issue-bridge-scratch --private
cat > routes.json <<'EOF'
{ "<TEST_CHANNEL_ID>": { "repo": "matsubo/issue-bridge-scratch", "labels": ["from-discord"] } }
EOF
tmux new-session -d -s bridge 'set -a; . ./.env; set +a; bun run src/server.ts'
cloudflared tunnel --url http://127.0.0.1:3000
```

Paste the printed `https://….trycloudflare.com/discord/interactions` into the dev application's **Interactions Endpoint URL** and save. Expected: Discord accepts the URL (PING → PONG succeeded). Register the command:

```bash
DISCORD_BOT_TOKEN=… DISCORD_APP_ID=… DISCORD_GUILD_ID=<server id: right-click server name → Copy Server ID> bun run bin/register-command.ts
```

Expected: `200 [...]`. In Discord, post a message with a `.md` attachment in the test channel, right-click it → *Apps → Create GitHub Issue*. Expected within seconds: the "thinking" state resolves to `Issue created: https://github.com/matsubo/issue-bridge-scratch/issues/1`, and the issue contains the message and the attachment content. Stop the tunnel and tmux session afterwards. Reset `routes.json` to `{}` before committing anything.

- [ ] **Step 3: Production Discord application**

Repeat Step 1 for the production app (name `issue-bridge`). Keep its Public Key, Application ID, and Bot Token for the next steps.

- [ ] **Step 4: GitHub PAT for the bridge**

GitHub → Settings → Developer settings → Fine-grained tokens → *Generate new token*: repository access = *Only select repositories* (start with `matsubo/dam`; add each onboarded repository later), permissions = Issues: Read and write, Metadata: Read. Expiry ≤ 1 year; note the date.

- [ ] **Step 5: Push and deploy on Coolify (after the maintainer approves the push)**

```bash
git push -u origin main
```

Coolify → New Resource → *Dockerfile* build pack from `matsubo/discord-issue-bridge`, branch `main`, domain `discord-bridge.teraren.com` (or whatever the maintainer chooses), health-check path `/healthz`, environment variables `DISCORD_PUBLIC_KEY`, `DISCORD_APP_ID`, `DISCORD_ALLOWED_USER_IDS`, `GITHUB_TOKEN`. Deploy. Expected: `curl https://discord-bridge.teraren.com/healthz` → `{"ok":true}`.

- [ ] **Step 6: Wire the production app**

Set the production application's **Interactions Endpoint URL** to `https://discord-bridge.teraren.com/discord/interactions` (must save without error). Register the command against the real guild with the production Bot Token. Add `#service-dam` to `routes.json`:

```json
{ "<SERVICE_DAM_CHANNEL_ID>": { "repo": "matsubo/dam" } }
```

Commit (`chore: route #service-dam to matsubo/dam`) and, with approval, push; Coolify redeploys. Until Plan B has landed in dam, temporarily use `"labels": ["from-discord"]` so no `auto-fix` label is applied; switch to the default after Plan B's dry run passes.

- [ ] **Step 7: Transcribe the HTokui report**

Right-click the 2026-09-06 report in `#service-dam` → *Apps → Create GitHub Issue*. Expected: an issue on `matsubo/dam` titled `[Discord] 初めまして。HTといいます。貯水率のサイトを作成中で、データを利用させていただいています。` whose body includes `teraren_report.md` and whose first comment includes `teraren_report_capacity.csv`; the Discord message shows `Issue created: <url>`.
