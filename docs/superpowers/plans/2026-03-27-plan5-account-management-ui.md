# Plan 5 — Account Management UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire rename, delete, re-auth badge, and sync status into the Settings modal account cards, backed by a new `token_expired` DB column.

**Architecture:** Backend adds a `token_expired` column (Migration 5) and exposes it via GET /api/accounts. The sync engine sets/clears it. The frontend extends `openConfirm()` with a simple mode and rewrites `renderSettingsAccounts()` with pencil-rename, × delete, and a status badge per card.

**Tech Stack:** TypeScript/Express backend, better-sqlite3, Vitest for tests, vanilla JS + HTML/CSS frontend (no build step).

**Spec:** `docs/superpowers/specs/2026-03-27-plan5-account-management-ui-design.md`

---

## File Map

| File | Action | What changes |
|---|---|---|
| `src/db/migrations.ts` | Modify | Add Migration 5: `token_expired INTEGER NOT NULL DEFAULT 0` |
| `src/routes/accounts.ts` | Modify | Add `token_expired` to GET SELECT |
| `src/email/sync-engine.ts` | Modify | Combined `last_synced + token_expired=0` on success; detect auth errors → set `token_expired=1` |
| `src/server.ts` | Modify | Clear `token_expired=0` after successful Gmail/Outlook OAuth callbacks |
| `tests/routes/accounts.test.ts` | Modify | Add 3 new test cases |
| `tests/email/sync-engine.test.ts` | Create | 4 tests for token_expired set/clear |
| `frontend/index.html` | Modify | Add `id="confirm-type-label"` to div; add CSS for rename/delete/badge elements |
| `frontend/app.js` | Modify | Extend `openConfirm()`; fix `closeConfirm()`; rewrite `renderSettingsAccounts()` |

---

## Task 1: Backend schema + GET route (TDD)

**Files:**
- Modify: `inboxmy-backend/tests/routes/accounts.test.ts`
- Modify: `inboxmy-backend/src/db/migrations.ts`
- Modify: `inboxmy-backend/src/routes/accounts.ts`

- [ ] **Step 1.1: Write three failing tests**

Open `inboxmy-backend/tests/routes/accounts.test.ts`. Append these three `describe` blocks after the existing `DELETE` block:

```typescript
describe('GET /api/accounts — token_expired field', () => {
  it('returns token_expired = 0 by default for each account', async () => {
    const { agent, id: userId } = await createTestUser()
    const id = randomUUID()
    seedAccount(userId, id, `te-test-${id}@test.com`)
    const res = await agent.get('/api/accounts')
    expect(res.status).toBe(200)
    const acct = res.body.accounts.find((a: any) => a.id === id)
    expect(acct).toBeDefined()
    expect(acct.token_expired).toBe(0)
  })
})

describe('PATCH /api/accounts/:id/label — edge cases', () => {
  it('accepts empty string label', async () => {
    const { agent, id: userId } = await createTestUser()
    const id = randomUUID()
    seedAccount(userId, id, `empty-label-${id}@test.com`)
    const res = await agent.patch(`/api/accounts/${id}/label`).send({ label: '' })
    expect(res.status).toBe(200)
    const row = getDb().prepare('SELECT label FROM accounts WHERE id = ?').get(id) as any
    expect(row.label).toBe('')
  })
})

describe('DELETE /api/accounts/:id — cascade', () => {
  it('deletes associated emails via ON DELETE CASCADE', async () => {
    const { agent, id: userId } = await createTestUser()
    const acctId = randomUUID()
    seedAccount(userId, acctId, `cascade-${acctId}@test.com`)
    getDb().prepare(`
      INSERT INTO emails
        (id, account_id, subject_enc, sender, received_at, is_read, folder, tab, is_important)
      VALUES (?, ?, ?, 'x@x.com', ?, 0, 'inbox', 'primary', 0)
    `).run(randomUUID(), acctId, encryptSystem('subj'), Date.now())

    const before = getDb().prepare('SELECT count(*) as n FROM emails WHERE account_id = ?').get(acctId) as any
    expect(before.n).toBe(1)

    await agent.delete(`/api/accounts/${acctId}`)

    const after = getDb().prepare('SELECT count(*) as n FROM emails WHERE account_id = ?').get(acctId) as any
    expect(after.n).toBe(0)
  })
})
```

- [ ] **Step 1.2: Run tests to verify they fail**

```powershell
cd inboxmy-backend
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/accounts.test.ts
```

Expected: the `token_expired` test fails with a column-not-found error (or returns undefined). The other two likely pass already — verify and note which ones fail.

- [ ] **Step 1.3: Add Migration 5 to `src/db/migrations.ts`**

Add a fifth entry to the `MIGRATIONS` array (after the existing 4th entry at index 3):

```typescript
  // Migration 5: per-account token expiry flag
  `ALTER TABLE accounts ADD COLUMN token_expired INTEGER NOT NULL DEFAULT 0;`,
```

The full array tail should look like:
```typescript
  // Migration 4: Gmail inbox tab
  `
  ALTER TABLE emails ADD COLUMN tab TEXT NOT NULL DEFAULT 'primary';
  CREATE INDEX IF NOT EXISTS idx_emails_tab ON emails(tab);
  `,
  // Migration 5: per-account token expiry flag
  `ALTER TABLE accounts ADD COLUMN token_expired INTEGER NOT NULL DEFAULT 0;`,
]
```

- [ ] **Step 1.4: Update the GET SELECT in `src/routes/accounts.ts`**

Change line 13 from:
```typescript
    'SELECT id, provider, email, label, created_at, last_synced FROM accounts WHERE user_id = ?'
```
to:
```typescript
    'SELECT id, provider, email, label, created_at, last_synced, token_expired FROM accounts WHERE user_id = ?'
```

- [ ] **Step 1.5: Run tests to verify they pass**

```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/accounts.test.ts
```

Expected: all tests in the file pass (now 7 total).

- [ ] **Step 1.6: Commit**

```bash
git add inboxmy-backend/src/db/migrations.ts inboxmy-backend/src/routes/accounts.ts inboxmy-backend/tests/routes/accounts.test.ts
git commit -m "feat: add token_expired column (Migration 5) and expose via GET /api/accounts"
```

---

## Task 2: Sync engine auth error detection (TDD)

**Files:**
- Create: `inboxmy-backend/tests/email/sync-engine.test.ts`
- Modify: `inboxmy-backend/src/email/sync-engine.ts`

- [ ] **Step 2.1: Create the test file**

Create `inboxmy-backend/tests/email/sync-engine.test.ts`:

```typescript
// tests/email/sync-engine.test.ts
import { vi, describe, it, expect, beforeEach, afterAll } from 'vitest'

vi.mock('../../src/email/gmail-client', () => ({ fetchNewEmails: vi.fn() }))
vi.mock('../../src/email/outlook-client', () => ({ fetchNewEmails: vi.fn() }))

import { fetchNewEmails as mockGmailFetch } from '../../src/email/gmail-client'
import { fetchNewEmails as mockOutlookFetch } from '../../src/email/outlook-client'
import { syncAccount } from '../../src/email/sync-engine'
import { getDb, closeDb } from '../../src/db'
import { encryptSystem } from '../../src/crypto'
import { randomUUID } from 'crypto'

afterAll(() => closeDb())

// Note: Task 1 must be fully complete (migration applied to data-test DB) before running these tests.
// Do NOT include token_expired in the INSERT — let it default to 0 via the DEFAULT constraint.
function seedAccount(id: string, provider: 'gmail' | 'outlook' = 'gmail') {
  getDb().prepare(`
    INSERT OR IGNORE INTO accounts
      (id, provider, email, token_enc, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, provider, `${id}@sync-test.com`, encryptSystem('{}'), Date.now())
}

const TEST_KEY = Buffer.alloc(32)

describe('syncAccount — token_expired flag', () => {
  beforeEach(() => { vi.resetAllMocks() })

  it('sets token_expired = 1 when Gmail fetch throws invalid_grant', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')
    vi.mocked(mockGmailFetch).mockRejectedValue(new Error('invalid_grant'))
    await syncAccount(id, TEST_KEY)
    const row = getDb().prepare('SELECT token_expired FROM accounts WHERE id = ?').get(id) as any
    expect(row.token_expired).toBe(1)
  })

  it('sets token_expired = 1 when Outlook fetch throws re-auth required', async () => {
    const id = randomUUID()
    seedAccount(id, 'outlook')
    vi.mocked(mockOutlookFetch).mockRejectedValue(
      new Error('Outlook account not found in MSAL cache — re-auth required')
    )
    await syncAccount(id, TEST_KEY)
    const row = getDb().prepare('SELECT token_expired FROM accounts WHERE id = ?').get(id) as any
    expect(row.token_expired).toBe(1)
  })

  it('does NOT set token_expired = 1 for non-auth errors', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')
    vi.mocked(mockGmailFetch).mockRejectedValue(new Error('Network timeout'))
    await syncAccount(id, TEST_KEY)
    const row = getDb().prepare('SELECT token_expired FROM accounts WHERE id = ?').get(id) as any
    expect(row.token_expired).toBe(0)
  })

  it('clears token_expired to 0 on successful sync even if previously 1', async () => {
    const id = randomUUID()
    seedAccount(id, 'gmail')
    getDb().prepare('UPDATE accounts SET token_expired = 1 WHERE id = ?').run(id)
    vi.mocked(mockGmailFetch).mockResolvedValue([])
    await syncAccount(id, TEST_KEY)
    const row = getDb().prepare('SELECT token_expired FROM accounts WHERE id = ?').get(id) as any
    expect(row.token_expired).toBe(0)
  })
})
```

- [ ] **Step 2.2: Run tests to verify they fail**

```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/email/sync-engine.test.ts
```

Expected: all 4 tests fail — `token_expired` column exists (from Task 1) but sync engine doesn't set/clear it yet.

- [ ] **Step 2.3: Update `src/email/sync-engine.ts`**

**Change 1:** Replace the `last_synced` update line (line ~87) from:
```typescript
    db.prepare('UPDATE accounts SET last_synced = ? WHERE id = ?').run(Date.now(), accountId)
```
to a combined statement:
```typescript
    db.prepare('UPDATE accounts SET last_synced = ?, token_expired = 0 WHERE id = ?').run(Date.now(), accountId)
```

**Change 2:** In the `catch` block, add auth-error detection before `errors.push`. Replace:
```typescript
  } catch (err: any) {
    errors.push(err.message)
    db.prepare('UPDATE sync_log SET finished_at = ?, error = ? WHERE id = ?')
      .run(Date.now(), err.message, logId)
  }
```
with:
```typescript
  } catch (err: any) {
    const AUTH_ERRORS = /invalid_grant|401|token has been expired or revoked|unauthorized|re-auth required/i
    if (AUTH_ERRORS.test(err.message)) {
      db.prepare('UPDATE accounts SET token_expired = 1 WHERE id = ?').run(accountId)
    }
    errors.push(err.message)
    db.prepare('UPDATE sync_log SET finished_at = ?, error = ? WHERE id = ?')
      .run(Date.now(), err.message, logId)
  }
```

- [ ] **Step 2.4: Run tests to verify they pass**

```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/email/sync-engine.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 2.5: Run full test suite to check for regressions**

```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npm test
```

Expected: all tests pass (now 75+ total).

- [ ] **Step 2.6: Commit**

```bash
git add inboxmy-backend/src/email/sync-engine.ts inboxmy-backend/tests/email/sync-engine.test.ts
git commit -m "feat: sync engine sets token_expired=1 on auth errors, clears on success"
```

---

## Task 3: OAuth callbacks clear token_expired

**Files:**
- Modify: `inboxmy-backend/src/server.ts`

No automated test here — the OAuth flow requires a real browser redirect. Covered by the manual checklist in Task 5.

- [ ] **Step 3.1: Update Gmail callback in `src/server.ts`**

In the Gmail callback handler (around line 66), change:
```typescript
    const accountId = await gmailCallback(code as string, session.user_id)
    res.send(`<script>window.close()</script><p>Gmail connected! Account: ${accountId}</p>`)
```
to:
```typescript
    const accountId = await gmailCallback(code as string, session.user_id)
    getDb().prepare('UPDATE accounts SET token_expired = 0 WHERE id = ?').run(accountId)
    res.send(`<script>window.close()</script><p>Gmail connected! Account: ${accountId}</p>`)
```

- [ ] **Step 3.2: Update Outlook callback in `src/server.ts`**

In the Outlook callback handler (around line 87), change:
```typescript
    const accountId = await outlookCallback(code as string, session.user_id)
    res.send(`<script>window.close()</script><p>Outlook connected! Account: ${accountId}</p>`)
```
to:
```typescript
    const accountId = await outlookCallback(code as string, session.user_id)
    getDb().prepare('UPDATE accounts SET token_expired = 0 WHERE id = ?').run(accountId)
    res.send(`<script>window.close()</script><p>Outlook connected! Account: ${accountId}</p>`)
```

- [ ] **Step 3.3: Build to verify TypeScript compiles**

```powershell
cd inboxmy-backend
npm run build
```

Expected: silent exit (no errors).

- [ ] **Step 3.4: Commit**

```bash
git add inboxmy-backend/src/server.ts
git commit -m "feat: clear token_expired=0 after successful OAuth reconnect"
```

---

## Task 4: Frontend — openConfirm simple mode + closeConfirm fix

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`

- [ ] **Step 4.1: Add `id` attribute to confirm-type-label div in `frontend/index.html`**

Find the line (around line 509):
```html
      <div class="confirm-type-label">Type <strong>DELETE</strong> to confirm</div>
```
Change it to:
```html
      <div class="confirm-type-label" id="confirm-type-label">Type <strong>DELETE</strong> to confirm</div>
```

- [ ] **Step 4.2: Replace `openConfirm` and `closeConfirm` in `frontend/app.js`**

Find and replace the entire `openConfirm` function (lines ~851-858):
```javascript
function openConfirm(message, action) {
  _confirmedAction = action;
  document.getElementById('confirm-message').innerHTML = message;
  document.getElementById('confirm-input').value = '';
  document.getElementById('confirm-submit').disabled = true;
  document.getElementById('confirm-modal').classList.add('open');
  setTimeout(() => document.getElementById('confirm-input').focus(), 100);
}
```
with:
```javascript
function openConfirm(message, action, { simple = false } = {}) {
  _confirmedAction = action;
  document.getElementById('confirm-message').innerHTML = message;
  const typeLabel = document.getElementById('confirm-type-label');
  const input = document.getElementById('confirm-input');
  const submit = document.getElementById('confirm-submit');
  if (simple) {
    typeLabel.style.display = 'none';
    input.style.display = 'none';
    submit.disabled = false;
  } else {
    typeLabel.style.display = '';
    input.style.display = '';
    input.value = '';
    submit.disabled = true;
    setTimeout(() => input.focus(), 100);
  }
  document.getElementById('confirm-modal').classList.add('open');
}
```

Find and replace the entire `closeConfirm` function (lines ~859-862):
```javascript
function closeConfirm() {
  document.getElementById('confirm-modal').classList.remove('open');
  _confirmedAction = null;
}
```
with:
```javascript
function closeConfirm() {
  document.getElementById('confirm-modal').classList.remove('open');
  _confirmedAction = null;
  // Always restore modal to default state for the next caller
  document.getElementById('confirm-type-label').style.display = '';
  document.getElementById('confirm-input').style.display = '';
  document.getElementById('confirm-input').value = '';
  document.getElementById('confirm-submit').disabled = true;
  document.getElementById('confirm-submit').textContent = 'Delete';
}
```

- [ ] **Step 4.3: Manual smoke test of existing confirm flows**

Start the server (`npm start`) and open the dashboard. Verify:
1. Go to Settings → "Delete all email data…" — the "Type DELETE to confirm" input appears, button is disabled until you type DELETE. ✓
2. Type DELETE → button enables → click Delete → modal closes, toast appears. ✓
3. Open Settings again → modal is clean (input empty, button disabled, label visible). ✓

- [ ] **Step 4.4: Commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "feat: extend openConfirm with simple mode, fix closeConfirm to fully restore modal state"
```

---

## Task 5: Frontend — renderSettingsAccounts + CSS

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/app.js`

- [ ] **Step 5.1: Add new CSS classes to `frontend/index.html`**

Find the existing `.mac-btn:hover` line (around line 238):
```css
.mac-btn:hover{background:var(--cream2)}
```
After it, add:
```css
.mac-card-actions{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0}
.mac-header{display:flex;align-items:center;gap:6px}
.mac-rename-btn{background:none;border:none;cursor:pointer;color:var(--ink4);font-size:11px;padding:0 2px;line-height:1;opacity:.6;flex-shrink:0;transition:opacity .15s}
.mac-rename-btn:hover{opacity:1}
.mac-rename-row{display:flex;align-items:center;gap:5px;margin-top:2px}
.mac-rename-input{flex:1;font-size:12px;font-family:var(--sans);padding:3px 7px;border:1px solid var(--border);border-radius:5px;color:var(--ink);background:#fff;outline:none;min-width:0}
.mac-rename-input:focus{border-color:var(--coral)}
.mac-save-btn,.mac-cancel-btn{padding:3px 9px;border-radius:5px;font-family:var(--sans);font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0}
.mac-save-btn{border:none;background:var(--coral);color:#fff}
.mac-cancel-btn{border:1px solid var(--border);background:#fff;color:var(--ink3)}
.mac-delete-btn{background:none;border:none;cursor:pointer;color:var(--ink4);font-size:18px;line-height:1;padding:0;transition:color .15s;font-family:var(--sans)}
.mac-delete-btn:hover{color:var(--coral)}
.mac-auth-expired{color:var(--coral) !important;font-weight:600}
.mac-auth-expired a{color:var(--coral)}
.mac-sync-ok{color:var(--green) !important;display:flex;align-items:center;gap:4px}
.mac-sync-dot{width:6px;height:6px;border-radius:50%;background:var(--green);flex-shrink:0;display:inline-block}
```

- [ ] **Step 5.2: Replace `renderSettingsAccounts` in `frontend/app.js`**

Find and replace the entire `renderSettingsAccounts` function (lines ~818-846) with:

```javascript
function renderSettingsAccounts() {
  const list = document.getElementById('settings-accounts-list');
  if (!list) return;
  if (accountsData.length === 0) {
    list.innerHTML = '<div style="color:var(--ink4);font-size:13px;padding:4px 0">No accounts connected</div>';
    return;
  }
  const providerColors = { gmail: '#4285f4', outlook: '#0078d4' };
  list.innerHTML = '';
  accountsData.forEach(acct => {
    const color = providerColors[acct.provider] || 'var(--purple)';
    const currentLabel = acct.label || acct.email;

    let statusHtml;
    if (acct.token_expired === 1) {
      const url = `/api/accounts/connect/${acct.provider}`;
      statusHtml = `<div class="mac-sync mac-auth-expired">⚠ Auth expired — <a href="${escHtml(url)}">Reconnect</a></div>`;
    } else if (acct.last_synced) {
      const t = new Date(acct.last_synced).toLocaleString('en-MY', {
        day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true
      });
      statusHtml = `<div class="mac-sync mac-sync-ok"><span class="mac-sync-dot"></span>Synced ${t}</div>`;
    } else {
      statusHtml = `<div class="mac-sync">Never synced</div>`;
    }

    const card = document.createElement('div');
    card.className = 'modal-acct-card';
    card.innerHTML = `
      <div class="mac-dot" style="background:${color}"></div>
      <div class="mac-info">
        <div class="mac-header">
          <div class="mac-email">${escHtml(currentLabel)}</div>
          <button class="mac-rename-btn" title="Rename">✏</button>
        </div>
        <div class="mac-rename-row" style="display:none">
          <input class="mac-rename-input" type="text" value="${escHtml(currentLabel)}">
          <button class="mac-save-btn">Save</button>
          <button class="mac-cancel-btn">Cancel</button>
        </div>
        ${statusHtml}
      </div>
      <div class="mac-card-actions">
        <button class="mac-btn">↺ Re-sync from scratch</button>
        <button class="mac-delete-btn" title="Remove account">×</button>
      </div>`;

    // ── Rename ────────────────────────────────────────────────────────────────
    const headerEl = card.querySelector('.mac-header');
    const renameRow = card.querySelector('.mac-rename-row');
    const input = card.querySelector('.mac-rename-input');

    card.querySelector('.mac-rename-btn').addEventListener('click', () => {
      headerEl.style.display = 'none';
      renameRow.style.display = 'flex';
      input.focus();
      input.select();
    });

    const doSave = async () => {
      const newLabel = input.value.trim();
      try {
        await apiFetch(`/api/accounts/${acct.id}/label`, {
          method: 'PATCH',
          body: JSON.stringify({ label: newLabel })
        });
        const idx = accountsData.findIndex(a => a.id === acct.id);
        if (idx !== -1) accountsData[idx].label = newLabel;
        renderAccounts();
        renderSettingsAccounts();
      } catch (err) {
        showToast('Failed to rename: ' + (err.message || 'Unknown error'));
        input.value = acct.label || acct.email; // reset to original on failure
        headerEl.style.display = '';
        renameRow.style.display = 'none';
      }
    };

    const doCancel = () => {
      headerEl.style.display = '';
      renameRow.style.display = 'none';
      input.value = acct.label || acct.email;
    };

    card.querySelector('.mac-save-btn').addEventListener('click', doSave);
    card.querySelector('.mac-cancel-btn').addEventListener('click', doCancel);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') doSave();
      if (e.key === 'Escape') doCancel();
    });

    // ── Re-sync ───────────────────────────────────────────────────────────────
    card.querySelector('.mac-btn').addEventListener('click', () => {
      confirmResync(acct.id, acct.label || acct.email);
    });

    // ── Delete ────────────────────────────────────────────────────────────────
    card.querySelector('.mac-delete-btn').addEventListener('click', () => {
      const label = acct.label || acct.email;
      openConfirm(
        `Remove <strong>${escHtml(label)}</strong>? This deletes all its synced emails from this device. Your actual mailbox is not affected.`,
        async () => {
          await apiFetch(`/api/accounts/${acct.id}`, { method: 'DELETE' });
          accountsData.splice(accountsData.findIndex(a => a.id === acct.id), 1);
          renderAccounts();
          renderSettingsAccounts();
          showToast('Account removed.');
        },
        { simple: true }
      );
    });

    list.appendChild(card);
  });
}
```

- [ ] **Step 5.3: Manual test checklist**

Start the server (`npm start`), open `http://localhost:3001`, sign in. Open Settings (profile dropdown → Settings).

**Rename:**
- [ ] Account card shows a small ✏ button next to the label
- [ ] Click ✏ → label disappears, input appears pre-filled with current label, Save and Cancel visible
- [ ] Type a new name → press Enter → label updates in settings card AND in the sidebar immediately
- [ ] Click ✏ again → type new name → press Escape → input disappears, original label restored
- [ ] Click ✏ → click Cancel → same cancel behaviour

**Delete:**
- [ ] Account card shows a × button in the bottom-right action area
- [ ] Click × → confirm modal opens WITHOUT the "Type DELETE" input, Delete button immediately enabled
- [ ] Click Cancel → modal closes, account still present
- [ ] Click × again → click Delete → account disappears from settings list AND sidebar, "Account removed." toast shown
- [ ] After delete: open Settings again → "Type DELETE" input and label are visible (normal mode restored)

**Sync status badge:**
- [ ] Account with a past sync shows "● Synced [date time]" in green
- [ ] Account never synced shows "Never synced" in grey
- [ ] Manually set `token_expired = 1` in DB (`sqlite3 data/inboxmy.db "UPDATE accounts SET token_expired=1"`) → reload page → open Settings → red "⚠ Auth expired — Reconnect" badge appears
- [ ] Reconnect link URL is `/api/accounts/connect/gmail` (or outlook) for the right provider

**Re-sync still works:**
- [ ] "↺ Re-sync from scratch" button still triggers the resync confirm flow (type-DELETE modal, not simple mode)

- [ ] **Step 5.4: Build backend to confirm no TypeScript issues (frontend is plain JS)**

```powershell
cd inboxmy-backend
npm run build
```

Expected: silent exit.

- [ ] **Step 5.5: Run full test suite one final time**

```powershell
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npm test
```

Expected: all tests pass.

- [ ] **Step 5.6: Commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "feat: account management UI — rename, delete, auth-expired badge, sync status"
```

---

## Task 6: Update README + docs

**Files:**
- Modify: `README.md`

- [ ] **Step 6.1: Update the README Roadmap table**

Find the Plan 5 row:
```markdown
| 5 | **Account Management UI** | Rename accounts, delete + revoke, re-auth expired tokens, per-account sync status | ⏳ Pending |
```
Change it to:
```markdown
| 5 | **Account Management UI** | Rename accounts, delete + revoke, re-auth expired tokens, per-account sync status | ✅ Done |
```

- [ ] **Step 6.2: Add Plan 5 test section to README**

Find the `### Plan 4 — Multi-User Architecture tests` section. After it (before `---`) add the following
block verbatim (note: the powershell block below is the literal text to paste into README.md):

Section heading: `### Plan 5 — Account Management UI tests`

Table:

| Test file | What it tests |
|---|---|
| `tests/routes/accounts.test.ts` | GET returns `token_expired` field; empty-string label accepted; DELETE cascades to emails |
| `tests/email/sync-engine.test.ts` | `token_expired=1` on Gmail `invalid_grant`; Outlook re-auth error; no flag on non-auth errors; clears on success |

Run command (paste this as a fenced powershell block in README):

```
$env:ENCRYPTION_KEY="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
$env:DATA_DIR="./data-test"
npx vitest run tests/routes/accounts.test.ts tests/email/sync-engine.test.ts
```

Manual checklist (paste as numbered list in README):

1. Open Settings → account cards show ✏ rename button and × delete button
2. Click ✏ → label becomes editable input → Enter saves → sidebar updates instantly
3. Escape during rename → reverts with no API call
4. Click × → simple confirm modal (no type-DELETE), Delete immediately enabled
5. Confirm delete → account gone from sidebar and settings, toast shown
6. After delete, open wipe-all confirm → type-DELETE input is back (modal restored correctly)
7. Set `token_expired=1` in DB → reload → red "⚠ Auth expired — Reconnect" badge on card
8. Reconnect link points to correct `/api/accounts/connect/gmail` (or `outlook`)

- [ ] **Step 6.3: Update Next Session Prompt in README for Plan 6**

Find the "Next Session Prompt" section. Replace its content with:

```
We are building InboxMY — a privacy-first, locally-priced unified email dashboard for Malaysia.
It aggregates Gmail and Outlook accounts (up to 6), parses Malaysian bills (TNB, Unifi, Celcom/Maxis/Digi,
Touch 'n Go, LHDN, MySejahtera, Shopee, Lazada), and stores everything AES-256-GCM encrypted in a local
SQLite database. Nothing is sent to any cloud.

Completed so far:
- Plan 1 (Backend): 100% complete — encrypted SQLite, OAuth flows (Gmail + Outlook), sync engine,
  Malaysian bill parsers (TNB, Unifi, Maxis, TnG, LHDN, Shopee, Lazada), REST API. 7 test files.
- Plan 2 (Frontend Wiring): 100% complete — frontend/app.js wires all dashboard panels to the live API
  (email list, detail, accounts sidebar, bills panel, sync button, infinite scroll, error handling).
- Plan 3 (OAuth Credentials Setup): 100% complete — npm run setup wizard, startup config validator with
  checklist, SETUP.md full reference guide, README roadmap remodel. 2 test files.
- Plan 4 (Multi-User Architecture): 100% complete — user sign-up/sign-in (email + password), per-user
  AES-256-GCM encrypted data keys, HTTP-only cookie sessions (30-day absolute TTL), forgot-password +
  reset-password with key re-wrap, requireAuth middleware on all API routes, OAuth state relay,
  frontend auth.html login/signup page, sign-out button. 3 test files. 71 tests total passing.
- Plan 5 (Account Management UI): 100% complete — rename accounts (pencil icon → inline input, Enter/Escape),
  delete + revoke (simple confirm modal, cascades emails), re-auth badge (token_expired column, sync engine
  sets/clears it, red reconnect badge in settings), per-account sync status badge (green synced / grey never).
  2 new test files. ~79 tests total passing.

Today's goal is Plan 6: Notifications + Overdue Detection.
Add due-date alerts, overdue bill banner, and browser notifications.
See docs/superpowers/specs/ for the design spec once it is written.
```

- [ ] **Step 6.4: Commit**

```bash
git add README.md
git commit -m "docs: mark Plan 5 complete, add test section, update next-session prompt for Plan 6"
```

---

## Final Verification

- [ ] Run `npm test` — all tests pass
- [ ] `npm run build` — no TypeScript errors
- [ ] Start server, manually run the Plan 5 checklist from Task 5.3 end-to-end
- [ ] Confirm the sidebar and settings modal look correct with no visual regressions
