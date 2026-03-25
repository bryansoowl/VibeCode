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
