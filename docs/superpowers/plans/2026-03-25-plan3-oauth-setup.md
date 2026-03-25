# Plan 3 — OAuth Credentials Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an interactive `npm run setup` wizard that auto-configures `.env`, a startup config validator that prints a `[✓]/[ ]` checklist, a full beginner-friendly `SETUP.md` reference guide, and an updated `README.md` with a remodeled roadmap and Vision section.

**Architecture:** The setup wizard (`scripts/setup.ts`) is a standalone Node.js CLI using only built-in `readline` — no new dependencies. Pure helper functions (validators, env builder) are exported and unit-tested. The wizard itself is guarded by `require.main === module`. `validateConfig()` is exported from `config.ts` and called as the first statement inside the `require.main` guard in `server.ts`, keeping it out of the test execution path.

**Tech Stack:** Node.js built-in `readline` + `crypto`, TypeScript via `tsx`, vitest for tests. No new npm dependencies.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `inboxmy-backend/tsconfig.json` | Modify | Add `"scripts"` to `exclude` so `tsc` ignores `scripts/` |
| `inboxmy-backend/package.json` | Modify | Add `"setup": "tsx scripts/setup.ts"` to scripts |
| `inboxmy-backend/scripts/setup.ts` | Create | Interactive CLI wizard + exported pure helpers |
| `inboxmy-backend/tests/setup.test.ts` | Create | Unit tests for pure helper functions |
| `inboxmy-backend/src/config.ts` | Modify | Add exported `validateConfig()` function |
| `inboxmy-backend/tests/config.test.ts` | Create | Unit tests for `validateConfig()` |
| `inboxmy-backend/src/server.ts` | Modify | Call `validateConfig()` first inside `require.main` guard |
| `SETUP.md` | Create | Full Google Cloud + Azure beginner reference guide |
| `README.md` | Modify | Roadmap remodel, Vision section, Step 1 update, remove partial Google Cloud section, update Next Session Prompt |

---

## Task 1: Fix Build Config

**Files:**
- Modify: `inboxmy-backend/tsconfig.json`
- Modify: `inboxmy-backend/package.json`

- [ ] **Step 1: Add `scripts` to tsconfig exclude**

Open `inboxmy-backend/tsconfig.json`. Change the `exclude` line from:
```json
"exclude": ["node_modules", "dist"]
```
to:
```json
"exclude": ["node_modules", "dist", "scripts"]
```

- [ ] **Step 2: Add setup script to package.json**

Open `inboxmy-backend/package.json`. In the `"scripts"` block, add the `setup` entry:
```json
"scripts": {
  "dev": "tsx watch src/server.ts",
  "build": "tsc",
  "start": "node dist/server.js",
  "setup": "tsx scripts/setup.ts",
  "test": "vitest run",
  "test:watch": "vitest"
}
```

- [ ] **Step 3: Create the scripts directory**

```bash
mkdir inboxmy-backend/scripts
```

- [ ] **Step 4: Verify build still passes**

```bash
cd inboxmy-backend
npm run build
```

Expected: silent exit (no errors). The `dist/` folder is regenerated. No file from `scripts/` is compiled.

- [ ] **Step 5: Commit**

```bash
git add inboxmy-backend/tsconfig.json inboxmy-backend/package.json
git commit -m "chore: add setup script entry and exclude scripts/ from tsc build"
```

---

## Task 2: `validateConfig()` in config.ts (TDD)

**Files:**
- Modify: `inboxmy-backend/src/config.ts`
- Create: `inboxmy-backend/tests/config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `inboxmy-backend/tests/config.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { validateConfig } from '../src/config'

describe('validateConfig', () => {
  let logs: string[]

  beforeEach(() => {
    logs = []
    vi.spyOn(console, 'log').mockImplementation((msg: string) => { logs.push(msg) })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('shows [✓] for Gmail when both Google creds are set', () => {
    process.env.GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com'
    process.env.GOOGLE_CLIENT_SECRET = 'a-secret'
    delete process.env.MICROSOFT_CLIENT_ID
    delete process.env.MICROSOFT_CLIENT_SECRET

    validateConfig()

    const output = logs.join('\n')
    expect(output).toContain('[✓] Gmail')
  })

  it('shows [ ] for Gmail and setup hint when Google Client ID is missing', () => {
    delete process.env.GOOGLE_CLIENT_ID
    process.env.GOOGLE_CLIENT_SECRET = 'a-secret'

    validateConfig()

    const output = logs.join('\n')
    expect(output).toContain('[ ] Gmail')
    expect(output).toContain('npm run setup')
  })

  it('shows [ ] for Gmail when Google Client Secret is missing', () => {
    process.env.GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com'
    delete process.env.GOOGLE_CLIENT_SECRET

    validateConfig()

    const output = logs.join('\n')
    expect(output).toContain('[ ] Gmail')
  })

  it('shows [✓] for Outlook when both Microsoft creds are set', () => {
    process.env.MICROSOFT_CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    process.env.MICROSOFT_CLIENT_SECRET = 'a-secret'

    validateConfig()

    const output = logs.join('\n')
    expect(output).toContain('[✓] Outlook')
  })

  it('shows [ ] for Outlook and setup hint when Microsoft creds are missing', () => {
    delete process.env.MICROSOFT_CLIENT_ID
    delete process.env.MICROSOFT_CLIENT_SECRET

    validateConfig()

    const output = logs.join('\n')
    expect(output).toContain('[ ] Outlook')
    expect(output).toContain('npm run setup')
  })

  it('does not print setup hint when all creds are set', () => {
    process.env.GOOGLE_CLIENT_ID = 'test.apps.googleusercontent.com'
    process.env.GOOGLE_CLIENT_SECRET = 'a-secret'
    process.env.MICROSOFT_CLIENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    process.env.MICROSOFT_CLIENT_SECRET = 'a-secret'

    validateConfig()

    const output = logs.join('\n')
    expect(output).not.toContain('npm run setup')
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/config.test.ts
```

Expected: FAIL — `validateConfig` is not exported from `../src/config`.

- [ ] **Step 3: Implement `validateConfig()` in config.ts**

Add to the bottom of `inboxmy-backend/src/config.ts`:

```typescript
export function validateConfig(): void {
  const bar = '─'.repeat(44)
  console.log(bar)
  console.log('  InboxMY Config')
  console.log(bar)

  const googleOk = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
  console.log(`  ${googleOk ? '[✓]' : '[ ]'} Gmail (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)`)
  if (!googleOk) console.log('      → Run: npm run setup')

  const msOk = !!(process.env.MICROSOFT_CLIENT_ID && process.env.MICROSOFT_CLIENT_SECRET)
  console.log(`  ${msOk ? '[✓]' : '[ ]'} Outlook (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET)`)
  if (!msOk) console.log('      → Run: npm run setup')

  console.log(bar)
}
```

- [ ] **Step 4: Run test to confirm it passes**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/config.test.ts
```

Expected: 6 tests PASS.

- [ ] **Step 5: Run full test suite to confirm no regressions**

```bash
npx vitest run
```

Expected: all previously passing tests still pass (32+ tests).

- [ ] **Step 6: Commit**

```bash
git add inboxmy-backend/src/config.ts inboxmy-backend/tests/config.test.ts
git commit -m "feat: add validateConfig() to config.ts with unit tests"
```

---

## Task 3: Call `validateConfig()` in server.ts

**Files:**
- Modify: `inboxmy-backend/src/server.ts`

- [ ] **Step 1: Import and call `validateConfig()` in server.ts**

In `inboxmy-backend/src/server.ts`, update the import line for config:

```typescript
import { config, validateConfig } from './config'
```

Then update the `require.main` guard block to call `validateConfig()` first:

```typescript
if (require.main === module) {
  validateConfig()           // ← add as first statement
  getDb()                    // initialise DB on start
  startScheduler()
  const port = config.port
  app.listen(port, '127.0.0.1', () => {
    console.log(`InboxMy backend running on http://localhost:${port}`)
    console.log(`Data directory: ${config.dataDir}`)
  })
}
```

- [ ] **Step 2: Run full test suite to confirm no regressions**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run
```

Expected: all tests pass. `validateConfig()` is only called inside `require.main` so tests are unaffected.

- [ ] **Step 3: Rebuild and start server to verify checklist appears**

```bash
npm run build && npm start
```

Expected terminal output (order may vary based on your `.env`):
```
────────────────────────────────────────────
  InboxMY Config
────────────────────────────────────────────
  [✓] Gmail (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
  [ ] Outlook (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET)
      → Run: npm run setup
────────────────────────────────────────────
[scheduler] Sync scheduled every 15 minutes
InboxMy backend running on http://localhost:3001
```

- [ ] **Step 4: Commit**

```bash
git add inboxmy-backend/src/server.ts
git commit -m "feat: call validateConfig() at server startup"
```

---

## Task 4: Setup Script — Pure Helpers (TDD)

**Files:**
- Create: `inboxmy-backend/scripts/setup.ts` (helpers only, wizard stubbed)
- Create: `inboxmy-backend/tests/setup.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `inboxmy-backend/tests/setup.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  isValidGoogleClientId,
  isValidAzureClientId,
  isValidSecret,
  buildEnvContent,
} from '../scripts/setup'

describe('isValidGoogleClientId', () => {
  it('accepts a valid Google client ID', () => {
    expect(isValidGoogleClientId('202736727260-abc.apps.googleusercontent.com')).toBe(true)
  })

  it('rejects ID that does not end with .apps.googleusercontent.com', () => {
    expect(isValidGoogleClientId('notvalid')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidGoogleClientId('')).toBe(false)
  })

  it('rejects ID ending with just googleusercontent.com (missing .apps prefix)', () => {
    expect(isValidGoogleClientId('123.googleusercontent.com')).toBe(false)
  })
})

describe('isValidAzureClientId', () => {
  it('accepts a valid UUID', () => {
    expect(isValidAzureClientId('b14dc905-7164-429e-b85b-daf15dae9b87')).toBe(true)
  })

  it('rejects a non-UUID string', () => {
    expect(isValidAzureClientId('notauuid')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(isValidAzureClientId('')).toBe(false)
  })

  it('rejects UUID with wrong segment lengths', () => {
    expect(isValidAzureClientId('b14dc905-7164-429e-b85b-daf15dae9b8')).toBe(false)
  })
})

describe('isValidSecret', () => {
  it('accepts a non-empty string', () => {
    expect(isValidSecret('GOCSPX-something')).toBe(true)
  })

  it('rejects empty string', () => {
    expect(isValidSecret('')).toBe(false)
  })

  it('rejects whitespace-only string', () => {
    expect(isValidSecret('   ')).toBe(false)
  })
})

describe('buildEnvContent', () => {
  it('writes all 10 variables', () => {
    const content = buildEnvContent({
      encryptionKey: 'a'.repeat(64),
      googleClientId: 'test.apps.googleusercontent.com',
      googleClientSecret: 'gsecret',
      microsoftClientId: 'b14dc905-7164-429e-b85b-daf15dae9b87',
      microsoftClientSecret: 'msecret',
    })

    expect(content).toContain('ENCRYPTION_KEY=' + 'a'.repeat(64))
    expect(content).toContain('GOOGLE_CLIENT_ID=test.apps.googleusercontent.com')
    expect(content).toContain('GOOGLE_CLIENT_SECRET=gsecret')
    expect(content).toContain('GOOGLE_REDIRECT_URI=http://localhost:3001/auth/gmail/callback')
    expect(content).toContain('MICROSOFT_CLIENT_ID=b14dc905-7164-429e-b85b-daf15dae9b87')
    expect(content).toContain('MICROSOFT_CLIENT_SECRET=msecret')
    expect(content).toContain('MICROSOFT_REDIRECT_URI=http://localhost:3001/auth/outlook/callback')
    expect(content).toContain('PORT=3001')
    expect(content).toContain('DATA_DIR=./data')
    expect(content).toContain('SYNC_INTERVAL_MINUTES=15')
  })

  it('writes empty strings for skipped providers', () => {
    const content = buildEnvContent({
      encryptionKey: 'a'.repeat(64),
      googleClientId: '',
      googleClientSecret: '',
      microsoftClientId: '',
      microsoftClientSecret: '',
    })

    expect(content).toContain('GOOGLE_CLIENT_ID=')
    expect(content).toContain('GOOGLE_CLIENT_SECRET=')
    expect(content).toContain('MICROSOFT_CLIENT_ID=')
    expect(content).toContain('MICROSOFT_CLIENT_SECRET=')
  })
})
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/setup.test.ts
```

Expected: FAIL — cannot find module `../scripts/setup`.

- [ ] **Step 3: Create `scripts/setup.ts` with pure helpers exported**

Create `inboxmy-backend/scripts/setup.ts`:

```typescript
import * as readline from 'readline'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'

// ── Pure helpers (exported for testing) ──────────────────────────────────────

export function isValidGoogleClientId(id: string): boolean {
  return id.endsWith('.apps.googleusercontent.com') && id.length > '.apps.googleusercontent.com'.length
}

export function isValidAzureClientId(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

export function isValidSecret(secret: string): boolean {
  return secret.trim().length > 0
}

export interface EnvOptions {
  encryptionKey: string
  googleClientId: string
  googleClientSecret: string
  microsoftClientId: string
  microsoftClientSecret: string
}

export function buildEnvContent(opts: EnvOptions): string {
  return [
    '# InboxMY Configuration — generated by npm run setup',
    '',
    '# Server',
    'PORT=3001',
    'DATA_DIR=./data',
    '',
    '# Encryption (auto-generated — do not change or you cannot decrypt your data)',
    `ENCRYPTION_KEY=${opts.encryptionKey}`,
    '',
    '# Google OAuth (Gmail)',
    `GOOGLE_CLIENT_ID=${opts.googleClientId}`,
    `GOOGLE_CLIENT_SECRET=${opts.googleClientSecret}`,
    'GOOGLE_REDIRECT_URI=http://localhost:3001/auth/gmail/callback',
    '',
    '# Microsoft OAuth (Outlook)',
    `MICROSOFT_CLIENT_ID=${opts.microsoftClientId}`,
    `MICROSOFT_CLIENT_SECRET=${opts.microsoftClientSecret}`,
    'MICROSOFT_REDIRECT_URI=http://localhost:3001/auth/outlook/callback',
    '',
    '# Sync interval in minutes (default: 15)',
    'SYNC_INTERVAL_MINUTES=15',
    '',
  ].join('\n')
}

// ── Wizard (only runs when invoked directly) ─────────────────────────────────

async function main(): Promise<void> {
  // Implemented in Task 5
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Setup failed:', err.message)
    process.exit(1)
  })
}
```

- [ ] **Step 4: Run test to confirm helpers pass**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/setup.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Run full suite to confirm no regressions**

```bash
npx vitest run
```

Expected: all tests pass (38+).

- [ ] **Step 6: Commit**

```bash
git add inboxmy-backend/scripts/setup.ts inboxmy-backend/tests/setup.test.ts
git commit -m "feat: add setup script helpers with unit tests"
```

---

## Task 5: Setup Script — Interactive Wizard

**Files:**
- Modify: `inboxmy-backend/scripts/setup.ts` (implement `main()`)

- [ ] **Step 1: Implement the full wizard in `main()`**

Replace the stub `main()` function in `inboxmy-backend/scripts/setup.ts` with the full implementation:

```typescript
async function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve))
}

async function promptWithValidation(
  rl: readline.Interface,
  question: string,
  validate: (val: string) => boolean,
  hint: string,
  maxAttempts = 3
): Promise<string | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const answer = (await prompt(rl, question)).trim()
    if (validate(answer)) return answer
    if (attempt < maxAttempts) {
      console.log(`  ✗ ${hint} (${maxAttempts - attempt} attempt${maxAttempts - attempt === 1 ? '' : 's'} remaining)`)
    } else {
      console.log(`\n  ✗ Too many invalid attempts. Setup aborted — .env was not written.\n`)
    }
  }
  return null
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  console.log('\n╔══════════════════════════════════════════╗')
  console.log('║  InboxMY — First-time Setup              ║')
  console.log('╚══════════════════════════════════════════╝\n')

  // Check for existing .env
  const envPath = path.join(process.cwd(), '.env')
  if (fs.existsSync(envPath)) {
    const answer = (await prompt(rl, '⚠  .env already exists. Overwrite? (y/N): ')).trim().toLowerCase()
    if (answer !== 'y') {
      console.log('\nAborted — existing .env was not changed.\n')
      rl.close()
      return
    }
  }

  // Provider selection
  console.log('Which email providers do you want to connect?')
  console.log('  1) Gmail only')
  console.log('  2) Outlook only')
  console.log('  3) Both Gmail and Outlook\n')
  const choice = (await prompt(rl, '> ')).trim()
  const wantGmail = choice === '1' || choice === '3'
  const wantOutlook = choice === '2' || choice === '3'

  if (!wantGmail && !wantOutlook) {
    console.log('\nInvalid choice. Please re-run npm run setup and enter 1, 2, or 3.\n')
    rl.close()
    return
  }

  // Generate encryption key
  const encryptionKey = crypto.randomBytes(32).toString('hex')
  console.log('\n✓ ENCRYPTION_KEY generated automatically.\n')

  // Gmail setup
  let googleClientId = ''
  let googleClientSecret = ''

  if (wantGmail) {
    console.log('─── Gmail Setup ' + '─'.repeat(28))
    console.log('  Full guide: SETUP.md → Section 1 (Google Cloud)')
    console.log('  1. Go to https://console.cloud.google.com')
    console.log('  2. Create or select a project')
    console.log('  3. APIs & Services → Enable APIs → search "Gmail API" → Enable')
    console.log('  4. APIs & Services → OAuth consent screen → External → fill in app name')
    console.log('  5. Test users → Add your Gmail address')
    console.log('  6. Credentials → Create Credentials → OAuth 2.0 Client ID → Web application')
    console.log('  7. Add redirect URI: http://localhost:3001/auth/gmail/callback')
    console.log('  8. Copy your Client ID and Client Secret below\n')

    const id = await promptWithValidation(
      rl,
      'Enter GOOGLE_CLIENT_ID: ',
      isValidGoogleClientId,
      'Must end with .apps.googleusercontent.com'
    )
    if (id === null) { rl.close(); return }
    googleClientId = id

    const secret = await promptWithValidation(
      rl,
      'Enter GOOGLE_CLIENT_SECRET: ',
      isValidSecret,
      'Secret cannot be empty'
    )
    if (secret === null) { rl.close(); return }
    googleClientSecret = secret
  }

  // Outlook setup
  let microsoftClientId = ''
  let microsoftClientSecret = ''

  if (wantOutlook) {
    console.log('\n─── Outlook Setup ' + '─'.repeat(26))
    console.log('  Full guide: SETUP.md → Section 2 (Azure Portal)')
    console.log('  1. Go to https://portal.azure.com')
    console.log('  2. Search "App registrations" → New registration')
    console.log('  3. Name: InboxMY')
    console.log('  4. Supported account types: "Accounts in any organizational directory')
    console.log('     and personal Microsoft accounts (Outlook.com, Hotmail)"')
    console.log('  5. Redirect URI (Web): http://localhost:3001/auth/outlook/callback')
    console.log('  6. Register → copy the Application (client) ID shown on the overview page')
    console.log('  7. API permissions → Add a permission → Microsoft Graph → Delegated')
    console.log('     → add Mail.Read and User.Read → Grant admin consent')
    console.log('  8. Certificates & secrets → New client secret → copy the Value (not ID)\n')

    const id = await promptWithValidation(
      rl,
      'Enter MICROSOFT_CLIENT_ID: ',
      isValidAzureClientId,
      'Must be a UUID like xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx'
    )
    if (id === null) { rl.close(); return }
    microsoftClientId = id

    const secret = await promptWithValidation(
      rl,
      'Enter MICROSOFT_CLIENT_SECRET: ',
      isValidSecret,
      'Secret cannot be empty'
    )
    if (secret === null) { rl.close(); return }
    microsoftClientSecret = secret
  }

  // Write .env
  const content = buildEnvContent({
    encryptionKey,
    googleClientId,
    googleClientSecret,
    microsoftClientId,
    microsoftClientSecret,
  })

  fs.writeFileSync(envPath, content, 'utf-8')

  console.log('\n─── Done ' + '─'.repeat(35))
  console.log(`✓ .env written to ${envPath}`)
  console.log('\nStart the server with:')
  console.log('  npm run build && npm start')
  console.log('\nThen open http://localhost:3001 in your browser.\n')

  rl.close()
}
```

- [ ] **Step 2: Run the full test suite to confirm no regressions**

The wizard uses `require.main === module` so it never runs during tests.

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run
```

Expected: all tests pass.

- [ ] **Step 3: Manual test — happy path (both providers)**

```bash
cd inboxmy-backend
npm run setup
```

At the prompts:
- Choose `3` (Both)
- Enter a valid Google Client ID ending in `.apps.googleusercontent.com`
- Enter any non-empty secret for Google
- Enter a valid UUID for Microsoft Client ID (e.g. `b14dc905-7164-429e-b85b-daf15dae9b87`)
- Enter any non-empty secret for Microsoft

Expected: `✓ .env written to ...` message. Open `.env` and verify all 10 variables are present.

- [ ] **Step 4: Manual test — overwrite prompt defaults to no**

Run `npm run setup` again. At the `Overwrite? (y/N):` prompt, press Enter without typing.

Expected: `Aborted — existing .env was not changed.` The file is unchanged.

- [ ] **Step 5: Manual test — validation retry and abort**

Run `npm run setup`, choose `1` (Gmail only). At the `GOOGLE_CLIENT_ID` prompt, enter `notvalid` three times.

Expected: format hint after each failure, then `✗ Too many invalid attempts. Setup aborted — .env was not written.`

- [ ] **Step 6: Commit**

```bash
git add inboxmy-backend/scripts/setup.ts
git commit -m "feat: implement interactive setup wizard with validation and .env writer"
```

---

## Task 6: Write SETUP.md

**Files:**
- Create: `SETUP.md` (repo root — `C:\Users\bryan.GOAT\Downloads\VibeCode\SETUP.md`)

- [ ] **Step 1: Create SETUP.md**

Create `SETUP.md` at the repo root with the following content:

```markdown
# InboxMY — OAuth Credentials Setup Guide

This guide is for whoever is **running the InboxMY server** (that's you). You register the app with Google and Microsoft once. Your own users never touch credentials — they just click "Connect Gmail" or "Connect Outlook" in the dashboard and go through Google/Microsoft's standard permission screen.

Run `npm run setup` in the `inboxmy-backend/` directory. It walks you through every step and writes `.env` automatically. This guide is the full reference if you want to understand what you're doing.

---

## Section 1 — Google Cloud Setup (Gmail)

### Step 1: Create a Google Cloud project

1. Go to [https://console.cloud.google.com](https://console.cloud.google.com) and sign in with your Google account.
2. Click the project selector at the top of the page (it may say "Select a project" or show a project name).
3. Click **New Project**.
4. Give it a name — `InboxMY` works fine.
5. Click **Create** and wait a few seconds for it to be ready.
6. Make sure the new project is selected in the top bar before continuing.

### Step 2: Enable the Gmail API

1. In the left sidebar, click **APIs & Services → Library**.
2. Search for `Gmail API`.
3. Click on **Gmail API** in the results.
4. Click **Enable**. Wait for it to activate.

### Step 3: Configure the OAuth consent screen

Before you can create credentials, Google requires you to fill in a consent screen — this is what your users see when they authorise the app.

1. Go to **APIs & Services → OAuth consent screen**.
2. Under **User Type**, select **External** and click **Create**.
   - If you only see "Internal", your account is a Workspace account — select Internal, it will still work for personal use.
3. Fill in the required fields:
   - **App name**: InboxMY
   - **User support email**: your email address
   - **Developer contact information**: your email address
4. Click **Save and Continue** through the Scopes and Test Users pages (you'll add a test user in Step 5).
5. On the Summary page, click **Back to Dashboard**.

### Step 4: Create OAuth 2.0 credentials

1. Go to **APIs & Services → Credentials**.
2. Click **+ Create Credentials → OAuth 2.0 Client ID**.
3. Under **Application type**, select **Web application**.
4. Give it a name — `InboxMY local` works.
5. Under **Authorised redirect URIs**, click **+ Add URI** and enter:
   ```
   http://localhost:3001/auth/gmail/callback
   ```
6. Click **Create**.
7. A dialog appears with your **Client ID** and **Client Secret**. Copy both — you will paste them into `npm run setup`.

### Step 5: Add your email as a test user

Because your OAuth app is in "Testing" mode, only explicitly added email addresses can authorise it.

1. Go to **APIs & Services → OAuth consent screen**.
2. Scroll to the **Test users** section.
3. Click **+ Add Users**.
4. Enter the Gmail address you want to connect to InboxMY.
5. Click **Add**.

> Your app stays in Testing mode indefinitely for personal local use. You do not need to go through Google's full verification process.

### Step 6: Copy credentials into .env

Run `npm run setup` from `inboxmy-backend/` and paste your Client ID and Client Secret when prompted.

### Troubleshooting

**Error 403: org_internal**
Your OAuth app is set to Internal. Go to **APIs & Services → OAuth consent screen** and click **Make External**.

**Error: insufficient authentication scopes**
The Gmail API may not be enabled. Go to **APIs & Services → Library**, search Gmail API, and verify it shows "API Enabled".

**Error: Gmail API has not been used in project**
The Gmail API was just enabled — wait 1–2 minutes and try again.

---

## Section 2 — Azure Portal Setup (Outlook)

### Step 1: Sign in to Azure Portal

1. Go to [https://portal.azure.com](https://portal.azure.com) and sign in with a Microsoft account (any account — personal Outlook/Hotmail or a work/school account).
2. If you see "Welcome to Microsoft Azure" — you're in the right place.

### Step 2: Register a new application

1. In the search bar at the top, type `App registrations` and click on it.
2. Click **+ New registration**.
3. Fill in the form:
   - **Name**: InboxMY
   - **Supported account types**: Select **"Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)"**
     > This option lets you connect both personal Outlook/Hotmail accounts and work/school accounts. If you only need personal accounts, you can select the personal-only option — but the broader option is safer.
   - **Redirect URI**: leave blank for now (you'll add it in the next step)
4. Click **Register**.
5. You are taken to the app's Overview page. **Copy the Application (client) ID** — this is your `MICROSOFT_CLIENT_ID`.

### Step 3: Configure redirect URI

1. In the left sidebar of your app registration, click **Authentication**.
2. Under **Platform configurations**, click **+ Add a platform**.
3. Select **Web**.
4. In the **Redirect URIs** field, enter:
   ```
   http://localhost:3001/auth/outlook/callback
   ```
5. Click **Configure**.
6. Scroll down and under **Advanced settings**, ensure **Allow public client flows** is set to **No**.
7. Click **Save**.

### Step 4: Add API permissions

1. In the left sidebar, click **API permissions**.
2. Click **+ Add a permission**.
3. Select **Microsoft Graph**.
4. Select **Delegated permissions**.
5. Search for and check **Mail.Read**.
6. Search for and check **User.Read**.
7. Click **Add permissions**.
8. Click **Grant admin consent for [your directory]** and confirm.
   > If you don't see the Grant button, you may not have admin rights. For personal Microsoft accounts this step is usually automatic.

### Step 5: Generate a client secret

1. In the left sidebar, click **Certificates & secrets**.
2. Click **+ New client secret**.
3. Give it a description — `InboxMY local` works.
4. Set expiry — **24 months** is the longest option.
5. Click **Add**.
6. **Copy the Value immediately** (not the Secret ID). It is only shown once. This is your `MICROSOFT_CLIENT_SECRET`.

> If you lose the secret value, you must delete it and generate a new one — you cannot retrieve it later.

### Step 6: Copy credentials into .env

Run `npm run setup` from `inboxmy-backend/` and paste your Client ID and Client Secret when prompted.

### Troubleshooting

**AADSTS50011: The redirect URI does not match**
Check that the redirect URI in Azure exactly matches `http://localhost:3001/auth/outlook/callback` with no trailing slash.

**AADSTS70011: The provided value for the input parameter 'scope' is not valid**
The Mail.Read and/or User.Read permissions may not be granted. Return to API permissions and click Grant admin consent.

**Client secret is showing as expired**
Azure secrets expire. Generate a new secret in Certificates & secrets, copy the new Value, and re-run `npm run setup`.

---

## Section 3 — Verifying Setup

1. Run `npm run setup` from `inboxmy-backend/` and complete all prompts.
2. Run `npm run build && npm start`.
3. Check the terminal — you should see:
   ```
   ────────────────────────────────────────────
     InboxMY Config
   ────────────────────────────────────────────
     [✓] Gmail (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)
     [✓] Outlook (MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET)
   ────────────────────────────────────────────
   ```
4. Open `http://localhost:3001` in your browser.
5. Click **Connect Gmail** or **Connect Outlook** in the accounts sidebar.
6. You are redirected to Google/Microsoft's permission screen — approve access.
7. The account appears in the dashboard. Click **↻ Sync** to fetch your emails.
```

- [ ] **Step 2: Commit**

```bash
git add SETUP.md
git commit -m "docs: add SETUP.md with full Google Cloud and Azure setup guides"
```

---

## Task 7: Update README.md

**Files:**
- Modify: `README.md`

This task makes four targeted changes to README.md. Make each change, verify the file looks correct, then commit once at the end.

- [ ] **Step 1: Update Step 1 — replace manual .env instructions with `npm run setup`**

Find the section starting with `## Step 1 — First-Time Setup` and replace the entire `.env` creation block (from `**Create your .env file:**` down to the closing `---`) with:

```markdown
**Create your `.env` file by running the setup wizard:**

```powershell
npm run setup
```

The wizard will:
- Auto-generate a secure `ENCRYPTION_KEY` for you
- Walk you through Google Cloud setup (for Gmail) and/or Azure Portal setup (for Outlook)
- Write a complete `.env` file — you never need to edit it manually

> For the full step-by-step credential guide (every click in Google Cloud Console and Azure Portal), see [SETUP.md](./SETUP.md).
```

- [ ] **Step 2: Remove the "Google Cloud Setup" section**

Delete the entire section:
```
## Google Cloud Setup (for Gmail OAuth)

If you get `Error 403: org_internal` ...
...
Your app is now in "Testing" mode...
```
(approximately lines 265–279 in the current README). Replace it with a single link line:

```markdown
## Credentials Setup

For the full step-by-step guide to setting up Google Cloud (Gmail) and Azure Portal (Outlook) credentials, see [SETUP.md](./SETUP.md).

---
```

- [ ] **Step 3: Add Vision section before the Roadmap**

Add this section immediately before `## Roadmap`:

```markdown
## Vision

InboxMY is heading toward a **BlueMail-style model**: you (the person running the server) register the OAuth app with Google and Microsoft once. Your users connect their own email accounts by clicking "Connect Gmail" or "Connect Outlook" — they go through Google/Microsoft's standard permission screen and are done. No terminal, no credentials, no setup knowledge required.

The current version is a single-user local app. **Plan 4** adds multi-user architecture: user sign-up/sign-in, per-user data isolation, and per-user encryption keys — the foundation for both a hosted service and a local-download app.

---
```

- [ ] **Step 4: Replace the Roadmap table**

Replace the existing roadmap table (the `| Plan | Focus | Status |` table) with:

```markdown
| # | Plan | Key Deliverables | Status |
|---|------|-----------------|--------|
| 1 | **Backend Core** | Encrypted SQLite, OAuth flows (Gmail + Outlook), email sync engine, Malaysian bill parsers (TNB, Unifi, Maxis, TnG, LHDN, Shopee, Lazada), REST API, 32 tests | ✅ Done |
| 2 | **Frontend Wiring** | Dashboard panels wired to live API — email list, email detail, accounts sidebar, bills panel, sync button, infinite scroll, error handling | ✅ Done |
| 3 | **OAuth Credentials Setup** | `npm run setup` wizard, startup config validator with checklist, `SETUP.md` full reference guide, README roadmap remodel | ✅ Done |
| 4 | **Multi-User Architecture** | User sign-up/sign-in, per-user data isolation, per-user encryption keys, session management — foundation for hosted and local-download modes | ⏳ Pending |
| 5 | **Account Management UI** | Rename accounts, delete + revoke, re-auth expired tokens, per-account sync status | ⏳ Pending |
| 6 | **Notifications + Overdue Detection** | Due-date alerts, overdue bill banner, browser notifications | ⏳ Pending |
| 7 | **Search + Filtering Improvements** | Full-text search, date range filters, multi-account filter, saved searches | ⏳ Pending |
| 8 | **Packaging + Auto-start on Login** | Electron or system tray wrapper, auto-start on OS login, local-download installer | ⏳ Pending |
| 9 | **Hardening + v1.0 Polish** | Rate limiting review, error boundary UI, accessibility pass, performance profiling, v1.0 release | ⏳ Pending |
| 10 | **Hosted Deployment** | Docker setup, cloud hosting config, privacy-preserving multi-tenant model | ⏳ Pending |
```

- [ ] **Step 5: Update Next Session Prompt**

Replace the content inside the ` ``` ` block under `## Next Session Prompt` with:

```
We are building InboxMY — a privacy-first, locally-priced unified email dashboard for Malaysia.
It aggregates Gmail and Outlook accounts (up to 6), parses Malaysian bills (TNB, Unifi, Celcom/Maxis/Digi,
Touch 'n Go, LHDN, MySejahtera, Shopee, Lazada), and stores everything AES-256-GCM encrypted in a local
SQLite database. Nothing is sent to any cloud.

Completed so far:
- Plan 1 (Backend): 100% complete, 32 tests passing, running at http://localhost:3001
- Plan 2 (Frontend Wiring): 100% complete — frontend/app.js wires all dashboard panels to the live API
- Plan 3 (OAuth Credentials Setup): 100% complete — npm run setup wizard, startup config checklist,
  SETUP.md guide, README roadmap remodel

Today's goal is Plan 4: Multi-User Architecture.
Add user sign-up/sign-in, per-user data isolation, per-user encryption keys, and session management —
the foundation for both hosted and local-download modes. See docs/superpowers/specs/ for the design spec
once it is written.
```

- [ ] **Step 6: Rebuild and run tests one final time**

```bash
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run
npm run build
```

Expected: all tests pass, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add README.md
git commit -m "docs: remodel README — roadmap, Vision section, Setup step, remove partial Google Cloud guide"
```

---

## Final Verification Checklist

- [ ] `npm run build` succeeds with no errors
- [ ] `npm run setup` runs interactively, writes `.env` with all 10 variables
- [ ] Re-running `npm run setup` shows overwrite prompt, defaults to no
- [ ] Entering invalid Client ID 3 times aborts without writing `.env`
- [ ] `npm start` prints config checklist before server startup message
- [ ] `npm run dev` also prints config checklist
- [ ] Removing a credential from `.env` → `[ ]` row with `npm run setup` hint
- [ ] Removing `ENCRYPTION_KEY` → hard throw, not checklist
- [ ] All tests pass: `npx vitest run` (38+ tests)
- [ ] `SETUP.md` exists at repo root with both Google Cloud and Azure sections
- [ ] README roadmap shows 10-plan table, Vision section present, no "Google Cloud Setup" section
