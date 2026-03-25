// frontend/app.js
// ── CONFIG ──────────────────────────────────────────────────────────────────
const API = '';  // same-origin: Express serves frontend at localhost:3001

// ── API CLIENT ───────────────────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  let res;
  try {
    res = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
  } catch (networkErr) {
    throw Object.assign(new Error('Network error: ' + networkErr.message), { status: 0 });
  }
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
  const p = new URLSearchParams();
  if (status) p.set('status', status);
  const qs = p.toString() ? '?' + p.toString() : '';
  return apiFetch('/api/bills' + qs);
}

async function updateBillStatus(id, status) {
  return apiFetch('/api/bills/' + id + '/status', {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
}

/**
 * Trigger a sync. Pass accountId to sync a specific account,
 * or omit / pass null to sync all connected accounts.
 */
async function triggerSync(accountId) {
  return apiFetch('/api/sync/trigger', {
    method: 'POST',
    body: JSON.stringify(accountId ? { accountId } : {}),
  });
}

// ── STATE ────────────────────────────────────────────────────────────────────
let currentFolder = 'inbox';
let currentFilter = 'all';
let currentSearch = '';
let currentAccountId = null;
let selectedEmailId = null;

let emailCache = [];
let emailOffset = 0;
let emailLoading = false;
let emailHasMore = true;

const FOLDER_CATEGORY = {
  inbox: null,
  bills: 'bill',
  govt: 'govt',
  receipts: 'receipt',
  work: 'work',
};

const FILTER_CATEGORY = {
  all: null,
  unread: null,
  bills: 'bill',
  govt: 'govt',
  receipts: 'receipt',
};

function buildEmailParams(offset = 0) {
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
  if (diff < 7 * 86_400_000) {
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  }
  return d.toLocaleDateString('en-MY', { day: 'numeric', month: 'short' });
}

function renderEmailRow(email) {
  const row = document.createElement('div');
  const isUnread = !email.is_read;
  const isSelected = email.id === selectedEmailId;
  row.className = 'email-row' + (isUnread ? ' unread' : '') + (isSelected ? ' selected' : '');
  row.id = 'row-' + email.id;

  const name = email.sender_name || email.sender || '?';
  const initial = name.charAt(0).toUpperCase();
  const avatarColors = { bill: '#c97a1a', govt: '#0d7a6e', receipt: '#5c48c9', work: '#2a6abf' };
  const color = avatarColors[email.category] || '#a89e94';

  const tagHtml = {
    bill:    '<div class="er-tag tag-bill">Bill</div>',
    govt:    '<div class="er-tag tag-govt">Govt</div>',
    receipt: '<div class="er-tag tag-shop">Receipt</div>',
    work:    '<div class="er-tag tag-work">Work</div>',
  }[email.category] || '';

  const time = email.received_at ? formatRelativeTime(email.received_at) : '';

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
    // KNOWN LIMITATION: if a full page arrives but few are unread,
    // emailHasMore stays true based on raw count — user must scroll to load more.
    let emails = currentFilter === 'unread'
      ? rawEmails.filter(e => !e.is_read)
      : rawEmails;

    emailCache = emailCache.concat(emails);
    emailOffset += rawEmails.length;
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
  document.getElementById('email-count').textContent =
    emailCache.length + (emailHasMore ? '+' : '') + ' emails';

  if (reset && emailCache.length === 0) {
    wrap.innerHTML = '<div style="padding:32px;text-align:center;color:var(--ink4);font-size:13px">No emails found</div>';
    return;
  }

  emails.forEach(email => wrap.appendChild(renderEmailRow(email)));
}

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

// Stub — fully implemented in Task 7
function showApiError(err) {
  showToast('Error: ' + (err && err.message ? err.message : 'Unknown error'));
}

// ── TASK 3: EMAIL DETAIL + MARK READ ─────────────────────────────────────────

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

function renderEmailDetail(email) {
  const name = email.sender_name || email.sender || '?';
  const initial = name.charAt(0).toUpperCase();
  const avatarColors = { bill: '#c97a1a', govt: '#0d7a6e', receipt: '#5c48c9', work: '#2a6abf' };
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

  // Body: render as HTML (came from trusted local encrypted DB)
  const bodyEl = document.getElementById('ed-body-content');
  if (email.body) {
    bodyEl.innerHTML = email.body;
  } else if (email.snippet) {
    bodyEl.innerHTML = `<p>${escHtml(email.snippet)}</p>`;
  } else {
    bodyEl.innerHTML = '<p style="color:var(--ink4)">No body content.</p>';
  }

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

// Stub — fully implemented in Task 7
function showReconnectPrompt() {
  showToast('Authentication expired. Please reconnect your account.');
}
