# InboxMY Frontend Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `frontend/index.html` to the live backend API at `http://localhost:3001`, replacing all hardcoded mock data with real API calls using vanilla JavaScript (no build step, no bundler).

**Architecture:** Extract all API logic into a new `frontend/app.js` module that is `<script src>`-linked from `index.html`. The existing DOM structure, CSS, and UX logic (lang switching, compose, toast) remain unchanged. All mock data (`EMAILS` array, static accounts, static bills) is removed and replaced with fetch calls to the backend. State is managed in plain JS variables (`emailCache`, `offset`, `currentAccountId`, etc.).

**Tech Stack:** Vanilla JS (ES2020), Fetch API, IntersectionObserver, no bundler, no framework. Backend: Express + better-sqlite3 at `http://localhost:3001`.

---

## API Reference (read before implementing)

All endpoints are at `http://localhost:3001` (same origin since Express serves the frontend statically).

| Endpoint | Method | Params / Body | Returns |
|---|---|---|---|
| `/api/accounts` | GET | — | `{ accounts: [{id, provider, email, label, created_at, last_synced}] }` |
| `/api/accounts/connect/gmail` | GET | — | Redirect to Google OAuth |
| `/api/accounts/connect/outlook` | GET | — | Redirect to MS OAuth |
| `/api/accounts/:id` | DELETE | — | `{ ok: true }` |
| `/api/emails` | GET | `category`, `accountId`, `limit`, `offset`, `search` | `{ emails, limit, offset }` |
| `/api/emails/:id` | GET | — | `{ id, subject, body, sender, sender_name, received_at, is_read, category, snippet, biller, amount_rm, due_date, account_ref, status }` |
| `/api/emails/:id/read` | PATCH | — | `{ ok: true }` |
| `/api/bills` | GET | `status` (unpaid/paid/overdue) | `{ bills: [{id, biller, amount_rm, due_date, account_ref, status, subject, received_at, account_id}] }` |
| `/api/bills/:id/status` | PATCH | `{ status }` | `{ ok: true }` |
| `/api/sync/trigger` | POST | `{ accountId? }` | `{ ok: true }` |

**Email category values from API:** `'bill'` `'govt'` `'receipt'` `'work'` (note: API uses `'receipt'` not `'shop'`)

---

## File Structure

```
frontend/
  index.html   — MODIFY: remove EMAILS array + inline JS, add <script src="app.js">,
                  add sync button to topbar, add sentinel div for infinite scroll,
                  keep all CSS, DOM structure, compose, toast, lang switch intact
  app.js       — CREATE: all API client + wiring logic (~400 lines)
```

**Decomposition decisions:**
- Keep lang switch / compose / toast functions in `index.html` (they are pure UI, no API dependency)
- Move all data-fetching and DOM rendering into `app.js`
- `app.js` exports nothing — it runs on `DOMContentLoaded` and wires up globals the HTML onclick= attributes need (`setFolder`, `setFilter`, `setAccount`, `filterEmails`, `selectEmail`, `selectEmailById`)

---

## Task 1: API Client Foundation (`frontend/app.js`)

**Files:**
- Create: `frontend/app.js`

This task creates the module skeleton and the raw API fetch helpers. No UI wiring yet.

- [ ] **Step 1: Create `frontend/app.js` with the API base URL and fetch wrapper**

```javascript
// frontend/app.js
// ── CONFIG ──────────────────────────────────────────────────────────────────
const API = '';  // same-origin: Express serves frontend at localhost:3001

// ── API CLIENT ───────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    throw Object.assign(new Error(err.error || `HTTP ${res.status}`), { status: res.status });
  }
  return res.json();
}

async function fetchAccounts() {
  return apiFetch('/api/accounts');
}

async function fetchEmails({ category, accountId, search, limit = 50, offset = 0 } = {}) {
  const p = new URLSearchParams();
  if (category) p.set('category', category);
  if (accountId) p.set('accountId', accountId);
  if (search) p.set('search', search);
  p.set('limit', limit);
  p.set('offset', offset);
  return apiFetch('/api/emails?' + p);
}

async function fetchEmail(id) {
  return apiFetch('/api/emails/' + id);
}

async function markRead(id) {
  return apiFetch('/api/emails/' + id + '/read', { method: 'PATCH' });
}

async function fetchBills(status) {
  const p = status ? '?status=' + status : '';
  return apiFetch('/api/bills' + p);
}

async function updateBillStatus(id, status) {
  return apiFetch('/api/bills/' + id + '/status', {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

async function triggerSync(accountId) {
  return apiFetch('/api/sync/trigger', {
    method: 'POST',
    body: JSON.stringify(accountId ? { accountId } : {}),
  });
}
```

- [ ] **Step 2: Verify API helpers work — open browser console at `http://localhost:3001` and run:**

```javascript
fetch('/api/accounts').then(r=>r.json()).then(console.log)
fetch('/api/emails?limit=5').then(r=>r.json()).then(console.log)
fetch('/api/bills').then(r=>r.json()).then(console.log)
```

Expected: JSON responses (may be empty arrays if no accounts synced yet, but no 404/500).

- [ ] **Step 3: Add `<script src="app.js"></script>` to `frontend/index.html` just before `</body>`**

In `index.html`, replace the entire `<script>` block (lines 422–753) with just the UI-only functions (lang switch, compose, toast) and a script tag for `app.js`:

```html
<!-- Keep only these in inline <script>: -->
<script>
// ── LANG ──────────────────────────────────────────────────────────────────
// (keep setLang, LABELS exactly as-is)

// ── COMPOSE ───────────────────────────────────────────────────────────────
// (keep openCompose, closeCompose, sendEmail, showToast exactly as-is)
</script>
<script src="app.js"></script>
```

- [ ] **Step 4: Add a sync button to the topbar in `index.html`**

Find the `.tb-right` div and add before the lang buttons:

```html
<button class="tb-lang" id="sync-btn" onclick="doSync()" style="gap:4px">↻ Sync</button>
<span id="sync-status" style="font-size:11px;color:var(--ink4)"></span>
```

- [ ] **Step 5: Add infinite scroll sentinel div to `index.html`**

After `<div class="el-items" id="el-items"></div>`:

```html
<div id="scroll-sentinel" style="height:1px"></div>
```

- [ ] **Step 6: Commit**

```bash
git add frontend/app.js frontend/index.html
git commit -m "feat: add API client foundation and scaffold app.js"
```

---

## Task 2: State Management + Email List Rendering

**Files:**
- Modify: `frontend/app.js`

Replace the mock `EMAILS`-based state with API-backed state variables and async `renderList`.

- [ ] **Step 1: Add state variables to `app.js`**

```javascript
// ── STATE ────────────────────────────────────────────────────────────────────
let currentFolder = 'inbox';   // sidebar folder (maps to category filter)
let currentFilter = 'all';     // tab filter (all/unread/bills/govt/receipts)
let currentSearch = '';
let currentAccountId = null;   // null = all accounts
let selectedEmailId = null;

let emailCache = [];           // loaded emails so far
let emailTotal = 0;
let emailOffset = 0;
let emailLoading = false;
let emailHasMore = true;

// Folder → API category mapping (sidebar folders map directly to categories)
const FOLDER_CATEGORY = {
  inbox: null,        // all categories
  bills: 'bill',
  govt: 'govt',
  receipts: 'receipt',
  work: 'work',
};

// Filter tab → API category override (subset of folders)
const FILTER_CATEGORY = {
  all: null,
  unread: null,       // handled client-side after fetch (no API param)
  bills: 'bill',
  govt: 'govt',
  receipts: 'receipt',
};
```

- [ ] **Step 2: Add `buildEmailParams()` helper**

```javascript
function buildEmailParams(offset = 0) {
  // Folder takes precedence; filter tab further narrows
  const folderCat = FOLDER_CATEGORY[currentFolder] ?? null;
  const filterCat = FILTER_CATEGORY[currentFilter] ?? null;
  const category = folderCat || filterCat || undefined;
  return {
    category,
    accountId: currentAccountId || undefined,
    search: currentSearch || undefined,
    limit: 50,
    offset,
  };
}
```

- [ ] **Step 3: Add `renderEmailRow(email)` — returns an HTMLElement from an API email object**

```javascript
// API email shape: { id, subject, snippet, sender, sender_name, received_at, is_read, category }
function renderEmailRow(email) {
  const row = document.createElement('div');
  const isUnread = !email.is_read;
  const isSelected = email.id === selectedEmailId;
  row.className = 'email-row' + (isUnread ? ' unread' : '') + (isSelected ? ' selected' : '');
  row.id = 'row-' + email.id;

  // Avatar color + initial from sender
  const name = email.sender_name || email.sender || '?';
  const initial = name.charAt(0).toUpperCase();
  const avatarColors = {
    bill: '#c97a1a', govt: '#0d7a6e', receipt: '#5c48c9', work: '#2a6abf'
  };
  const color = avatarColors[email.category] || '#a89e94';

  const tagHtml = {
    bill:    '<div class="er-tag tag-bill">Bill</div>',
    govt:    '<div class="er-tag tag-govt">Govt</div>',
    receipt: '<div class="er-tag tag-shop">Receipt</div>',
    work:    '<div class="er-tag tag-work">Work</div>',
  }[email.category] || '';

  const time = email.received_at
    ? formatRelativeTime(email.received_at)
    : '';

  row.innerHTML = `
    <div class="er-avatar" style="background:${color}">${initial}</div>
    <div class="er-body">
      <div class="er-from">${escHtml(name)}</div>
      <div class="er-subject">${escHtml(email.subject || '(no subject)')}</div>
      <div class="er-preview">${escHtml(email.snippet || '')}</div>
    </div>
    <div class="er-meta">
      <div class="er-time">${time}</div>
      ${tagHtml}
      ${isUnread ? '<div class="er-unread-dot"></div>' : ''}
    </div>`;
  row.onclick = () => selectEmail(email.id);
  return row;
}
```

- [ ] **Step 4: Add utility helpers**

```javascript
function escHtml(str) {
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatRelativeTime(ms) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm';
  if (diff < 86_400_000) {
    const h = new Date(ms);
    return h.toLocaleTimeString('en-MY', { hour: '2-digit', minute: '2-digit', hour12: true });
  }
  const d = new Date(ms);
  const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const now = new Date();
  if (diff < 7 * 86_400_000) return days[d.getDay()];
  return d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' });
}
```

- [ ] **Step 5: Add async `loadEmails(reset)` and `renderList()`**

```javascript
async function loadEmails(reset = false) {
  if (emailLoading) return;
  if (!reset && !emailHasMore) return;

  emailLoading = true;
  if (reset) {
    emailCache = [];
    emailOffset = 0;
    emailHasMore = true;
    document.getElementById('el-items').innerHTML = '';
  }

  try {
    const data = await fetchEmails(buildEmailParams(emailOffset));
    const rawEmails = data.emails || [];

    // Client-side unread filter (API has no unread param).
    // KNOWN LIMITATION: if a full page (50) arrives but few are unread,
    // emailHasMore stays true based on raw count — user must scroll to load more.
    let emails = currentFilter === 'unread'
      ? rawEmails.filter(e => !e.is_read)
      : rawEmails;

    emailCache = emailCache.concat(emails);
    // Advance offset by raw count (not data.limit) to avoid skipping rows on last page
    emailOffset += rawEmails.length;
    // More pages exist only if the server returned a full page of raw results
    emailHasMore = rawEmails.length >= data.limit;

    renderList(emails, reset);
  } catch (err) {
    showApiError(err);
  } finally {
    emailLoading = false;
  }
}

function renderList(emails, reset = false) {
  const wrap = document.getElementById('el-items');
  document.getElementById('email-count').textContent = emailCache.length + (emailHasMore ? '+' : '') + ' emails';

  if (reset && emailCache.length === 0) {
    wrap.innerHTML = '<div style="padding:32px;text-align:center;color:var(--ink4);font-size:13px">No emails found</div>';
    return;
  }

  emails.forEach(email => wrap.appendChild(renderEmailRow(email)));
}
```

- [ ] **Step 6: Add `setFolder`, `setAccount`, `setFilter`, `filterEmails` (replace old versions)**

```javascript
function setFolder(f, el) {
  currentFolder = f;
  currentFilter = 'all';
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  const titles = { inbox:'All inbox', bills:'Bills', govt:'Government', receipts:'Receipts', work:'Work', sent:'Sent', spam:'Spam' };
  document.getElementById('folder-title').textContent = titles[f] || f;
  document.querySelectorAll('.el-filter').forEach(i => i.classList.remove('active'));
  document.getElementById('filter-all').classList.add('active');
  loadEmails(true);
}

function setAccount(id, el) {
  currentAccountId = id === 'all' ? null : id;
  document.querySelectorAll('.sb-account').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  loadEmails(true);
}

function setFilter(f, el) {
  currentFilter = f;
  document.querySelectorAll('.el-filter').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  loadEmails(true);
}

let searchDebounce;
function filterEmails(q) {
  currentSearch = q;
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => loadEmails(true), 300);
}
```

- [ ] **Step 7: Add IntersectionObserver for infinite scroll**

```javascript
function setupInfiniteScroll() {
  const sentinel = document.getElementById('scroll-sentinel');
  if (!sentinel) return;
  const observer = new IntersectionObserver(entries => {
    if (entries[0].isIntersecting && emailHasMore && !emailLoading) {
      loadEmails(false);
    }
  }, { rootMargin: '200px' });
  observer.observe(sentinel);
}
```

- [ ] **Step 8: Verify — open browser, check email list loads from API (empty state is fine)**

Open DevTools Network tab → reload → confirm `GET /api/emails?limit=50&offset=0` fires and returns 200.

- [ ] **Step 9: Commit**

```bash
git add frontend/app.js
git commit -m "feat: async email list with API fetch, infinite scroll, state management"
```

---

## Task 3: Email Detail + Mark Read

**Files:**
- Modify: `frontend/app.js`

Wire `selectEmail(id)` to fetch real email body from `GET /api/emails/:id` and auto-mark read.

- [ ] **Step 1: Add async `selectEmail(id)` (replace mock version)**

```javascript
async function selectEmail(id) {
  selectedEmailId = id;

  // Highlight row immediately (optimistic)
  document.querySelectorAll('.email-row').forEach(r => r.classList.remove('selected'));
  const row = document.getElementById('row-' + id);
  if (row) row.classList.add('selected');

  document.getElementById('ed-empty').style.display = 'none';
  const content = document.getElementById('ed-content');
  content.style.display = 'flex';

  // Show loading state
  document.getElementById('ed-subject').textContent = 'Loading…';
  document.getElementById('ed-body-content').innerHTML = '<div style="color:var(--ink4);padding:8px">Loading email…</div>';
  document.getElementById('ed-smart-card').innerHTML = '';

  try {
    const email = await fetchEmail(id);
    renderEmailDetail(email);

    // Mark read (fire & forget — don't block UI)
    if (!email.is_read) {
      markRead(id).catch(() => {});
      // Update row UI
      if (row) {
        row.classList.remove('unread');
        const dot = row.querySelector('.er-unread-dot');
        if (dot) dot.remove();
        const fromEl = row.querySelector('.er-from');
        if (fromEl) fromEl.style.fontWeight = '500';
      }
      // Update cache
      const cached = emailCache.find(e => e.id === id);
      if (cached) cached.is_read = true;
    }
  } catch (err) {
    document.getElementById('ed-subject').textContent = 'Failed to load email';
    document.getElementById('ed-body-content').innerHTML =
      `<div style="color:var(--coral);padding:8px">Error: ${escHtml(err.message)}</div>`;
    if (err.status === 401) showReconnectPrompt();
  }
}

function selectEmailById(id) { selectEmail(id); }
```

- [ ] **Step 2: Add `renderEmailDetail(email)` — populates the email detail pane**

```javascript
function renderEmailDetail(email) {
  const name = email.sender_name || email.sender || '?';
  const initial = name.charAt(0).toUpperCase();
  const avatarColors = {
    bill: '#c97a1a', govt: '#0d7a6e', receipt: '#5c48c9', work: '#2a6abf'
  };
  const color = avatarColors[email.category] || '#a89e94';

  document.getElementById('ed-subject').textContent = email.subject || '(no subject)';

  const av = document.getElementById('ed-avatar');
  av.textContent = initial;
  av.style.background = color;

  document.getElementById('ed-from-name').textContent = name;
  document.getElementById('ed-from-email').textContent = email.sender ? `<${email.sender}>` : '';
  document.getElementById('ed-timestamp').textContent = email.received_at
    ? new Date(email.received_at).toLocaleString('en-MY', {
        weekday:'short', day:'numeric', month:'short', year:'numeric',
        hour:'2-digit', minute:'2-digit', hour12:true
      })
    : '';

  const tagMap = {
    bill:    '<div class="ed-tag tag-bill">Bill</div>',
    govt:    '<div class="ed-tag tag-govt">Government</div>',
    receipt: '<div class="ed-tag tag-shop">Receipt</div>',
    work:    '<div class="ed-tag tag-work">Work</div>',
  };
  document.getElementById('ed-tags').innerHTML = tagMap[email.category] || '';

  // Body: prefer HTML, fall back to plain text wrapped in <pre>
  const bodyEl = document.getElementById('ed-body-content');
  if (email.body) {
    // body is stored as plain text or HTML — render as-is (it came from a trusted local DB)
    bodyEl.innerHTML = email.body;
  } else if (email.snippet) {
    bodyEl.innerHTML = `<p>${escHtml(email.snippet)}</p>`;
  } else {
    bodyEl.innerHTML = '<p style="color:var(--ink4)">No body content.</p>';
  }

  // Smart card for bills
  renderSmartCard(email);
}

function renderSmartCard(email) {
  const sc = document.getElementById('ed-smart-card');
  if (email.category === 'bill' && email.biller) {
    const amt = email.amount_rm != null ? 'RM' + Number(email.amount_rm).toFixed(2) : '—';
    const due = email.due_date
      ? new Date(email.due_date).toLocaleDateString('en-MY', { day:'numeric', month:'long', year:'numeric' })
      : '—';
    const acct = email.account_ref || '—';
    sc.innerHTML = `<div class="smart-card">
      <div class="sc-header">
        <div class="sc-icon">⚡</div>
        <div>
          <div class="sc-label">${escHtml(email.biller)} — extracted by InboxMY</div>
          <div class="sc-sublabel">Account: ${escHtml(acct)}</div>
        </div>
      </div>
      <div class="sc-body">
        <div class="sc-stat"><span class="sc-val coral">${escHtml(amt)}</span><div class="sc-key">Amount due</div></div>
        <div class="sc-stat"><span class="sc-val">${escHtml(due)}</span><div class="sc-key">Due date</div></div>
      </div>
    </div>`;
  } else if (email.category === 'receipt' && email.biller) {
    const amt = email.amount_rm != null ? 'RM' + Number(email.amount_rm).toFixed(2) : '—';
    sc.innerHTML = `<div class="smart-card">
      <div class="sc-header">
        <div class="sc-icon">🛍️</div>
        <div>
          <div class="sc-label">${escHtml(email.biller)} order — parsed by InboxMY</div>
          <div class="sc-sublabel">${escHtml(email.account_ref || '')}</div>
        </div>
      </div>
      <div class="sc-body">
        <div class="sc-stat"><span class="sc-val amber">${escHtml(amt)}</span><div class="sc-key">Total paid</div></div>
      </div>
    </div>`;
  } else {
    sc.innerHTML = '';
  }
}
```

- [ ] **Step 3: Verify — click any email row → detail pane shows real data, network request fires**

Open DevTools Network → click an email row → confirm `GET /api/emails/{id}` fires and returns 200.
Also confirm `PATCH /api/emails/{id}/read` fires automatically.

- [ ] **Step 4: Commit**

```bash
git add frontend/app.js
git commit -m "feat: email detail with API fetch, smart card, auto-mark-read"
```

---

## Task 4: Accounts Panel

**Files:**
- Modify: `frontend/index.html` — replace static account HTML with a dynamic container
- Modify: `frontend/app.js` — add `loadAccounts()` and `renderAccounts()`

- [ ] **Step 1: Replace static accounts section in `index.html`**

Find the accounts section in the sidebar (lines 254–280) and replace with:

```html
<div class="sb-section">
  <div class="sb-label" id="lbl-accounts">Accounts</div>
  <div class="sb-account active" onclick="setAccount('all', this)">
    <div class="acct-dot" style="background:var(--coral)"></div>
    <div class="acct-name" id="lbl-all-accounts">All accounts</div>
    <div class="acct-count" id="acct-all-count">—</div>
  </div>
  <div id="accounts-list"></div>
  <div id="accounts-connect" style="padding:6px 10px;margin-top:4px">
    <a href="/api/accounts/connect/gmail"
       style="display:block;font-size:11px;color:var(--ink4);text-decoration:none;padding:4px 0"
       title="Connect a Gmail account">+ Connect Gmail</a>
    <a href="/api/accounts/connect/outlook"
       style="display:block;font-size:11px;color:var(--ink4);text-decoration:none;padding:4px 0"
       title="Connect an Outlook account">+ Connect Outlook</a>
  </div>
</div>
```

- [ ] **Step 2: Add `loadAccounts()` and `renderAccounts()` to `app.js`**

```javascript
let accountsData = [];

async function loadAccounts() {
  try {
    const data = await fetchAccounts();
    accountsData = data.accounts || [];
    renderAccounts();
  } catch (err) {
    showApiError(err);
  }
}

function renderAccounts() {
  const list = document.getElementById('accounts-list');
  if (!list) return;
  list.innerHTML = '';

  if (accountsData.length === 0) {
    list.innerHTML = '<div style="padding:6px 10px;font-size:11px;color:var(--ink4)">No accounts connected</div>';
    return;
  }

  accountsData.forEach(acct => {
    const dot = document.createElement('div');
    const providerColors = { gmail: '#4285f4', outlook: '#0078d4' };
    const color = providerColors[acct.provider] || 'var(--purple)';

    const el = document.createElement('div');
    el.className = 'sb-account';
    el.onclick = function() { setAccount(acct.id, this); };
    el.innerHTML = `
      <div class="acct-dot" style="background:${color}"></div>
      <div class="acct-name" title="${escHtml(acct.email)}">${escHtml(acct.label || acct.email)}</div>
      <div class="acct-count" id="acct-count-${acct.id}">—</div>`;
    list.appendChild(el);
  });

  // Hide connect links if already at 6 accounts
  const connectDiv = document.getElementById('accounts-connect');
  if (connectDiv) connectDiv.style.display = accountsData.length >= 6 ? 'none' : '';
}
```

- [ ] **Step 3: Verify — reload page, accounts list populates from API**

If no accounts connected: "No accounts connected" + Gmail/Outlook links visible.
If accounts exist: each account shows with correct email, provider color dot.

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "feat: dynamic accounts panel with connect links"
```

---

## Task 5: Bills Panel (Right Panel)

**Files:**
- Modify: `frontend/index.html` — replace static bill/order HTML with dynamic containers
- Modify: `frontend/app.js` — add `loadBills()` and `renderBillsPanel()`

- [ ] **Step 1: Replace static right panel content in `index.html`**

**Note:** The original mock HTML had a "Recent orders" section with hardcoded Shopee/Lazada items. This is intentionally replaced with a dynamic version that loads receipts from `GET /api/bills` (which includes Shopee/Lazada parsed receipts when available). The orders section is hidden if no receipt-category emails exist.

Find `<div id="right-panel">` and replace its inner content with:

```html
<div id="right-panel">
  <div class="rp-section">
    <div class="rp-title" id="lbl-bills-due">Bills due soon</div>
    <div id="bills-list"><div style="color:var(--ink4);font-size:12px;padding:4px 0">Loading…</div></div>
  </div>
  <div class="rp-section" id="orders-section" style="display:none">
    <div class="rp-title">Recent orders</div>
    <div id="orders-list"></div>
  </div>
  <div class="rp-section">
    <div class="rp-title">This month</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <div style="background:#fff;border:1px solid var(--border);border-radius:9px;padding:10px;text-align:center">
        <div id="bills-total-amt" style="font-family:var(--serif);font-size:19px;font-weight:600;color:var(--coral)">RM—</div>
        <div style="font-size:10px;color:var(--ink4);margin-top:2px" id="lbl-bills-total">Bills total</div>
      </div>
      <div style="background:#fff;border:1px solid var(--border);border-radius:9px;padding:10px;text-align:center">
        <div id="bills-overdue-count" style="font-family:var(--serif);font-size:19px;font-weight:600;color:var(--amber)">0</div>
        <div style="font-size:10px;color:var(--ink4);margin-top:2px">Overdue</div>
      </div>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Add `loadBills()` and `renderBillsPanel()` to `app.js`**

```javascript
async function loadBills() {
  try {
    // Fetch unpaid + overdue bills, and all receipts (Shopee/Lazada orders)
    const [unpaid, overdue, receipts] = await Promise.all([
      fetchBills('unpaid'),
      fetchBills('overdue'),
      fetchBills(),  // all statuses — we filter for receipt billers client-side
    ]);
    const bills = [...(overdue.bills || []), ...(unpaid.bills || [])];
    const orders = (receipts.bills || []).filter(b =>
      b.biller && /shopee|lazada/i.test(b.biller)
    );
    renderBillsPanel(bills, orders);
  } catch (err) {
    const list = document.getElementById('bills-list');
    if (list) list.innerHTML = '<div style="color:var(--coral);font-size:12px">Failed to load bills</div>';
  }
}

const BILLER_ICON = {
  TNB: '⚡', Unifi: '📡', Celcom: '📱', Maxis: '📱', Digi: '📱',
  'Touch n Go': '💳', LHDN: '🏛️', MySejahtera: '💉',
  Shopee: '🛍️', Lazada: '🛍️',
};

function getBillerIcon(biller) {
  for (const [key, icon] of Object.entries(BILLER_ICON)) {
    if (biller && biller.toLowerCase().includes(key.toLowerCase())) return icon;
  }
  return '📄';
}

function renderBillsPanel(bills, orders = []) {
  // Render recent orders (Shopee / Lazada receipts)
  const ordersSection = document.getElementById('orders-section');
  const ordersList = document.getElementById('orders-list');
  if (ordersSection && ordersList) {
    if (orders.length === 0) {
      ordersSection.style.display = 'none';
    } else {
      ordersSection.style.display = '';
      ordersList.innerHTML = '';
      orders.slice(0, 3).forEach(o => {
        const el = document.createElement('div');
        el.className = 'order-item';
        const shop = /shopee/i.test(o.biller) ? 'Shopee' : /lazada/i.test(o.biller) ? 'Lazada' : o.biller;
        const shopColor = /shopee/i.test(o.biller) ? 'var(--coral)' : 'var(--amber)';
        const amt = o.amount_rm != null ? 'RM' + Number(o.amount_rm).toFixed(2) : '';
        el.innerHTML = `
          <div class="oi-shop" style="color:${shopColor}">${escHtml(shop)}</div>
          <div class="oi-name">${escHtml(o.subject || o.biller)}</div>
          <div class="oi-status"><div class="oi-dot"></div>${escHtml(amt)}</div>`;
        ordersList.appendChild(el);
      });
    }
  }

  // Render bills due soon
  const list = document.getElementById('bills-list');
  if (!list) return;

  if (bills.length === 0) {
    list.innerHTML = '<div style="color:var(--ink4);font-size:12px;padding:4px 0">No unpaid bills 🎉</div>';
    document.getElementById('bills-total-amt').textContent = 'RM0.00';
    document.getElementById('bills-overdue-count').textContent = '0';
    return;
  }

  list.innerHTML = '';
  let total = 0;
  let overdueCount = 0;
  const now = Date.now();

  bills.slice(0, 5).forEach(bill => {
    const amt = bill.amount_rm != null ? Number(bill.amount_rm) : 0;
    total += amt;
    const isOverdue = bill.status === 'overdue' || (bill.due_date && bill.due_date < now);
    if (isOverdue) overdueCount++;

    const daysUntilDue = bill.due_date
      ? Math.ceil((bill.due_date - now) / 86_400_000)
      : null;
    const dueText = daysUntilDue == null ? 'No due date'
      : daysUntilDue < 0 ? `Overdue by ${Math.abs(daysUntilDue)}d`
      : daysUntilDue === 0 ? 'Due today'
      : `Due in ${daysUntilDue} day${daysUntilDue === 1 ? '' : 's'}`;

    const el = document.createElement('div');
    el.className = 'bill-item';
    el.innerHTML = `
      <div class="bi-icon">${getBillerIcon(bill.biller)}</div>
      <div class="bi-info">
        <div class="bi-name">${escHtml(bill.biller || 'Unknown')}</div>
        <div class="bi-due">${dueText}</div>
      </div>
      <div class="bi-amt${isOverdue ? ' urgent' : ''}">RM${amt.toFixed(2)}</div>`;

    // Click bill → jump to its email (bill has email_id via subject match — use id as bill_id)
    el.title = 'Click to mark as paid';
    el.onclick = () => {
      updateBillStatus(bill.id, 'paid')
        .then(() => { showToast('Marked as paid!'); loadBills(); })
        .catch(err => showApiError(err));
    };

    list.appendChild(el);
  });

  document.getElementById('bills-total-amt').textContent = 'RM' + total.toFixed(2);
  document.getElementById('bills-overdue-count').textContent = String(overdueCount);
}
```

- [ ] **Step 3: Verify — bills panel shows real data from `/api/bills`**

Open Network tab → confirm `GET /api/bills?status=unpaid` and `GET /api/bills?status=overdue` fire.
Bills panel shows "No unpaid bills 🎉" if empty (correct), or real bill rows.

- [ ] **Step 4: Commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "feat: dynamic bills panel with status toggle and monthly totals"
```

---

## Task 6: Sync Button + Last Synced Time

**Files:**
- Modify: `frontend/app.js` — add `doSync()` and sync status display

- [ ] **Step 1: Add `doSync()` to `app.js`**

```javascript
async function doSync() {
  const btn = document.getElementById('sync-btn');
  const status = document.getElementById('sync-status');
  if (!btn) return;

  btn.textContent = '↻ Syncing…';
  btn.disabled = true;
  if (status) status.textContent = '';

  try {
    await triggerSync();
    showToast('Sync complete!');
    // Reload data
    await Promise.all([loadEmails(true), loadAccounts(), loadBills()]);
    if (status) status.textContent = 'Last sync: ' + new Date().toLocaleTimeString('en-MY', { hour:'2-digit', minute:'2-digit', hour12:true });
  } catch (err) {
    showToast('Sync failed: ' + err.message);
    if (status) status.textContent = 'Sync failed';
  } finally {
    btn.textContent = '↻ Sync';
    btn.disabled = false;
  }
}
```

- [ ] **Step 2: Show last-synced time from accounts data on load**

Add this call inside `loadAccounts()` after setting `accountsData`:

```javascript
// Show last sync time from most recent account
const lastSynced = accountsData
  .map(a => a.last_synced)
  .filter(Boolean)
  .sort()
  .pop();
const status = document.getElementById('sync-status');
if (status && lastSynced) {
  status.textContent = 'Last sync: ' + new Date(lastSynced).toLocaleTimeString('en-MY', { hour:'2-digit', minute:'2-digit', hour12:true });
}
```

- [ ] **Step 3: Verify — click Sync button → spinner state, POST fires, data refreshes**

Open Network tab → click Sync → confirm `POST /api/sync/trigger` fires.
On completion: toast shows "Sync complete!" and email list refreshes.

- [ ] **Step 4: Commit**

```bash
git add frontend/app.js
git commit -m "feat: sync button with loading state and last-synced display"
```

---

## Task 7: Error Handling + Auth Reconnect Prompt

**Files:**
- Modify: `frontend/app.js` — add error utilities and reconnect prompt

- [ ] **Step 1: Add `showApiError()` and `showReconnectPrompt()` to `app.js`**

```javascript
function showApiError(err) {
  const msg = err?.message || 'Unknown error';
  if (err?.status === 401 || err?.status === 403) {
    showReconnectPrompt();
  } else {
    showToast('Error: ' + msg);
  }
}

function showReconnectPrompt() {
  // Show a non-dismissible banner if auth fails
  const existing = document.getElementById('reconnect-banner');
  if (existing) return;

  const banner = document.createElement('div');
  banner.id = 'reconnect-banner';
  banner.style.cssText = `
    position:fixed;top:48px;left:0;right:0;z-index:500;
    background:var(--coral);color:#fff;padding:10px 16px;
    font-size:13px;font-weight:500;display:flex;align-items:center;
    justify-content:space-between;gap:12px;
  `;
  banner.innerHTML = `
    <span>⚠️ Account authentication expired. Reconnect to continue syncing.</span>
    <div style="display:flex;gap:8px">
      <a href="/api/accounts/connect/gmail"
         style="background:#fff;color:var(--coral);padding:4px 12px;border-radius:6px;font-weight:700;text-decoration:none;font-size:12px">
        Reconnect Gmail
      </a>
      <a href="/api/accounts/connect/outlook"
         style="background:#fff;color:var(--coral);padding:4px 12px;border-radius:6px;font-weight:700;text-decoration:none;font-size:12px">
        Reconnect Outlook
      </a>
      <button onclick="document.getElementById('reconnect-banner').remove()"
              style="background:rgba(255,255,255,.2);border:none;color:#fff;padding:4px 8px;border-radius:6px;cursor:pointer;font-size:12px">
        ✕
      </button>
    </div>`;
  document.body.appendChild(banner);
}
```

- [ ] **Step 2: Wrap `loadEmails` initial call in try/catch that shows the reconnect prompt on 401**

In `loadEmails`, the catch block already calls `showApiError(err)` — this is sufficient since `showApiError` delegates to `showReconnectPrompt` on 401/403.

- [ ] **Step 3: Verify error state — test by temporarily changing API URL to a bad port**

In `app.js`, temporarily change `const API = ''` to `const API = 'http://localhost:9999'`.
Reload → toast should say "Error: Failed to fetch".
Restore `API = ''`.

- [ ] **Step 4: Commit**

```bash
git add frontend/app.js
git commit -m "feat: error handling, API error toasts, auth reconnect banner"
```

---

## Task 8: DOMContentLoaded Init + Final Wiring

**Files:**
- Modify: `frontend/app.js` — add the init function that bootstraps everything

- [ ] **Step 1: Add `init()` at the bottom of `app.js`**

```javascript
// ── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupInfiniteScroll();
  await Promise.all([
    loadAccounts(),
    loadEmails(true),
    loadBills(),
  ]);
});
```

- [ ] **Step 2: Verify full load sequence in browser**

1. Open `http://localhost:3001`
2. Network tab shows: `GET /api/accounts`, `GET /api/emails?limit=50&offset=0`, `GET /api/bills?status=unpaid`, `GET /api/bills?status=overdue` — all return 200
3. Email list renders (or shows "No emails found" if DB is empty)
4. Accounts panel renders with connect links
5. Bills panel renders
6. Sidebar folder clicks reload email list with correct category filter
7. Search input debounces and fires new API request
8. Scroll to bottom of email list triggers another `GET /api/emails?offset=50`
9. Click email row → detail pane shows, `PATCH /api/emails/:id/read` fires
10. Sync button → POST fires, data refreshes

- [ ] **Step 3: Remove the now-unused static `EMAILS` array from `index.html` (if any remnant)**

Search for `const EMAILS = [` in `index.html` — it should already be gone from Task 1 Step 3. Confirm it's absent.

- [ ] **Step 4: Final commit**

```bash
git add frontend/index.html frontend/app.js
git commit -m "feat: wire InboxMY frontend to live backend API (Plan 2 complete)"
```

---

## Checklist Summary

- [ ] Task 1: API client foundation + `<script src="app.js">` in index.html
- [ ] Task 2: Email list with API fetch, state, infinite scroll, filters
- [ ] Task 3: Email detail with decrypted body, smart card, auto-mark-read
- [ ] Task 4: Accounts panel with real data + connect links
- [ ] Task 5: Bills panel with unpaid/overdue, status toggle, totals
- [ ] Task 6: Sync button with loading state + last-synced time
- [ ] Task 7: Error handling + reconnect prompt for auth failures
- [ ] Task 8: DOMContentLoaded init + end-to-end verification

---

## Key Invariants (Do Not Break)

1. **No bundler, no build step** — `app.js` is plain ES2020 loaded via `<script src>`. No `import/export`.
2. **Same-origin API** — `API = ''` (empty string), all fetch calls use relative paths. Do not hardcode `localhost:3001`.
3. **CSS untouched** — do not modify any `<style>` content. All classes already exist.
4. **Lang switch preserved** — `setLang()`, `LABELS`, `showToast()`, `openCompose()` etc. stay in the inline `<script>` in `index.html`.
5. **XSS safety** — always use `escHtml()` when inserting user-provided text into `innerHTML`. Email body is trusted (it came from the local encrypted DB) so can be rendered as HTML.
6. **onclick= attributes** — functions called by HTML `onclick=` must be in global scope (no `const` in a block). All functions in `app.js` should be declared with `function` at top level.
