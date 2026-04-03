// frontend/app.js
// Auth check — redirect to /auth if not logged in
(async function checkAuth() {
  try {
    const res = await fetch('/auth/me')
    if (!res.ok) {
      window.location.href = '/auth'
      return
    }
    const { user } = await res.json()
    const avatar = document.getElementById('tb-avatar')
    const pdName = document.getElementById('pd-user-name')
    const pdEmail = document.getElementById('pd-user-email')
    if (avatar) avatar.textContent = (user.email || 'U').charAt(0).toUpperCase()
    if (pdEmail) pdEmail.textContent = user.email
    if (pdName) pdName.textContent = user.email.split('@')[0]
  } catch {
    window.location.href = '/auth'
  }
})()

async function handleSignOut() {
  await fetch('/auth/logout', { method: 'POST' })
  window.location.href = '/auth'
}

function toggleProfileMenu() {
  document.getElementById('profile-dropdown').classList.toggle('open')
}
document.addEventListener('click', e => {
  const wrap = document.querySelector('.profile-wrap')
  if (wrap && !wrap.contains(e.target)) {
    document.getElementById('profile-dropdown')?.classList.remove('open')
  }
})

// ── CONFIG ──────────────────────────────────────────────────────────────────
const API = '';  // same-origin: Express serves frontend at localhost:3001

// ── UNREAD BADGES ─────────────────────────────────────────────────────────────
let unreadCounts = {
  total_unread: 0,
  bills: 0, govt: 0, receipts: 0, work: 0,
  important: 0, promotions: 0, snoozed: 0,
  sent: 0, draft: 0, spam: 0, archived: 0,
}

// Tracks in-flight mark-read requests — prevents optimistic update races
const pendingReadRequests = new Map()  // emailId → boolean (target is_read)

function renderUnreadBadges(counts = unreadCounts) {
  const set = (id, n) => {
    const el = document.getElementById(id)
    if (!el) return
    el.textContent = n > 0 ? (n > 99 ? '99+' : String(n)) : ''
    if (id === 'unread-badge') el.style.display = n > 0 ? '' : 'none'
  }
  set('unread-badge',     counts.total_unread)
  set('badge-bills',      counts.bills)
  set('badge-govt',       counts.govt)
  set('badge-receipts',   counts.receipts)
  set('badge-work',       counts.work)
  set('badge-important',  counts.important)
  set('badge-promotions', counts.promotions)
  set('badge-snoozed',    counts.snoozed)
  set('badge-sent',       counts.sent)
  set('badge-draft',      counts.draft)
  set('badge-spam',       counts.spam)
  set('badge-archived',   counts.archived)
}

async function refreshUnreadCounts() {
  try {
    const data = await apiFetch('/api/emails/unread-counts')
    unreadCounts = data
    renderUnreadBadges()
  } catch { /* silent — stale counts better than broken UI */ }
}

async function markEmailRead(emailId, isRead) {
  // Find email in cache
  const email = emailCache.find(e => e.id === emailId)
  if (!email) return
  if (email.is_read === isRead) return  // already in target state

  // Rapid-click guard: if same target already in flight, skip duplicate
  if (pendingReadRequests.has(emailId) && pendingReadRequests.get(emailId) === isRead) return

  const delta = isRead ? -1 : +1
  const prev = email.is_read  // save for revert

  // ── Optimistic update ──────────────────────────────────────────────────────
  email.is_read = isRead
  const rowEl = document.getElementById('row-' + emailId)
  if (rowEl) {
    const updated = renderEmailRow(email)
    rowEl.replaceWith(updated)
  }

  const optimistic = { ...unreadCounts }
  optimistic.total_unread = Math.max(0, optimistic.total_unread + delta)
  if (email.category === 'bill')    optimistic.bills      = Math.max(0, optimistic.bills      + delta)
  if (email.category === 'govt')    optimistic.govt       = Math.max(0, optimistic.govt       + delta)
  if (email.category === 'receipt') optimistic.receipts   = Math.max(0, optimistic.receipts   + delta)
  if (email.category === 'work')    optimistic.work       = Math.max(0, optimistic.work       + delta)
  if (email.is_important)           optimistic.important  = Math.max(0, optimistic.important  + delta)
  if (email.tab === 'promotions')   optimistic.promotions = Math.max(0, optimistic.promotions + delta)
  if (email.folder === 'sent')      optimistic.sent       = Math.max(0, optimistic.sent       + delta)
  if (email.folder === 'draft')     optimistic.draft      = Math.max(0, optimistic.draft      + delta)
  if (email.folder === 'spam')      optimistic.spam       = Math.max(0, optimistic.spam       + delta)
  if (email.folder === 'archive')   optimistic.archived   = Math.max(0, optimistic.archived   + delta)
  renderUnreadBadges(optimistic)

  pendingReadRequests.set(emailId, isRead)

  // ── API call ───────────────────────────────────────────────────────────────
  try {
    const result = await apiFetch(`/api/emails/${emailId}/read`, {
      method: 'PATCH',
      body: JSON.stringify({ is_read: isRead }),
    })
    // Reconcile with authoritative counts from server
    unreadCounts = result.counts
    renderUnreadBadges()
  } catch (err) {
    // Revert optimistic update
    email.is_read = prev
    const revertEl = document.getElementById('row-' + emailId)
    if (revertEl) {
      const reverted = renderEmailRow(email)
      revertEl.replaceWith(reverted)
    }
    refreshUnreadCounts()
    showToast('Failed to update read status')
  } finally {
    pendingReadRequests.delete(emailId)
  }
}

// ── EMAIL NOTIFICATIONS (Web Notifications API) ──────────────────────────────
// In-memory set — deduplicates within the current session.
const _notifiedEmailIds = new Set()

async function showEmailNotifications(emails) {
  if (!Array.isArray(emails) || emails.length === 0) return
  // Request permission if not yet decided
  if (Notification.permission === 'default') {
    await Notification.requestPermission()
  }
  if (Notification.permission !== 'granted') return

  const fresh = emails.filter(e => e && e.id && !_notifiedEmailIds.has(e.id))
  if (fresh.length === 0) return
  fresh.forEach(e => _notifiedEmailIds.add(e.id))

  if (fresh.length <= 3) {
    fresh.forEach(e => {
      new Notification(e.senderName || e.sender || 'New email', {
        body: (e.subject || '(no subject)').slice(0, 100),
        silent: false,
      })
    })
  } else {
    new Notification('InboxMY', {
      body: `${fresh.length} new emails arrived`,
      silent: false,
    })
  }
}

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

async function fetchEmails({ category, folder, tab, important, accountId, accountIds, search, unread, dateFrom, dateTo, limit = 50, offset = 0 } = {}) {
  const p = new URLSearchParams();
  if (category)   p.set('category', category);
  if (folder)     p.set('folder', folder);
  if (tab)        p.set('tab', tab);
  if (important)  p.set('important', '1');
  if (accountId)  p.set('accountId', accountId);
  if (accountIds) p.set('accountIds', accountIds);
  if (search)     p.set('search', search);
  if (unread)     p.set('unread', '1');
  if (dateFrom)   p.set('dateFrom', dateFrom);
  if (dateTo)     p.set('dateTo', dateTo);
  p.set('limit', limit);
  p.set('offset', offset);
  return apiFetch('/api/emails?' + p);
}

async function fetchEmail(id) {
  return apiFetch('/api/emails/' + id);
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
let currentDateFrom   = null;   // 'YYYY-MM-DD' or null
let currentDateTo     = null;   // 'YYYY-MM-DD' or null
let currentAccountIds = [];     // [] = all accounts
let selectedEmailId = null;

let emailCache = [];
let emailOffset = 0;
let emailLoading = false;
let emailHasMore = true;

let userLabels = []     // [{ id, name, color, count }]
let currentLabelId = null  // active label filter

async function loadLabels() {
  try {
    userLabels = await apiFetch('/api/labels')
    renderLabelsSidebar()
  } catch { /* silent */ }
}

function renderLabelsSidebar() {
  const wrap = document.getElementById('sb-labels-section')
  if (!wrap) return
  if (userLabels.length === 0) { wrap.style.display = 'none'; return }
  wrap.style.display = ''
  const list = document.getElementById('sb-labels-list')
  if (!list) return
  list.innerHTML = userLabels.map(l => `
    <div class="sb-item sb-label-item${currentLabelId === l.id ? ' active' : ''}"
         onclick="setLabelFolder('${l.id}', this)"
         data-label-id="${l.id}">
      <span class="sb-label-dot" style="background:${escHtml(l.color)}"></span>
      <span class="sb-label-name">${escHtml(l.name)}</span>
      ${l.count > 0 ? `<span class="sb-badge">${l.count}</span>` : ''}
    </div>
  `).join('')
}

function setLabelFolder(labelId, el) {
  currentLabelId = labelId
  currentFolder = 'label'
  currentFilter = 'all'
  currentDateFrom = null
  currentDateTo = null
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'))
  if (el) el.classList.add('active')
  const label = userLabels.find(l => l.id === labelId)
  document.getElementById('folder-title').textContent = label ? label.name : 'Label'
  loadEmails(true)
}

// Maps sidebar folder names to API query params.
// 'inbox'   → folder=inbox (backend auto-excludes promotions)
// 'allmail' → no params = every email, no filter
const FOLDER_PARAMS = {
  inbox:      { folder: 'inbox' },
  allmail:    {},
  bills:      { category: 'bill' },
  govt:       { category: 'govt' },
  receipts:   { category: 'receipt' },
  work:       { category: 'work' },
  important:  { important: '1' },
  promotions: { tab: 'promotions' },
  sent:       { folder: 'sent' },
  draft:      { folder: 'draft' },
  spam:       { folder: 'spam' },
  focused:    { folder: 'inbox', tab: 'primary' },
  snoozed:    { snoozed: '1' },
};

function buildEmailParams(offset = 0) {
  let folderParams = FOLDER_PARAMS[currentFolder] || { folder: 'inbox' };
  // Label folder is a special case — use labelId param instead of folderParams
  if (currentFolder === 'label' && currentLabelId) {
    folderParams = { labelId: currentLabelId }
  }
  const params = {
    ...folderParams,
    search: currentSearch || undefined,
    unread: currentFilter === 'unread' || undefined,
    limit: 50,
    offset,
  };
  // accountIds takes precedence over accountId (sidebar single-account filter)
  if (currentAccountIds.length > 0) {
    params.accountIds = currentAccountIds.join(',');
  } else if (currentAccountId) {
    params.accountId = currentAccountId;
  }
  if (currentDateFrom) params.dateFrom = currentDateFrom;
  if (currentDateTo)   params.dateTo   = currentDateTo;
  return params;
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

// ── SENDER LOGO ───────────────────────────────────────────────────────────────
const _logoCache = new Map(); // domain → 'loaded' | 'failed'

function extractSenderDomain(sender) {
  const m = sender && sender.match(/@([\w.-]+)/);
  return m ? m[1].toLowerCase() : null;
}

function tryLoadLogo(avatarEl, domain) {
  if (!domain) return;
  if (_logoCache.get(domain) === 'failed') return;
  if (_logoCache.get(domain) === 'loaded') {
    // Already know it works — apply immediately from cache
    _applyLogo(avatarEl, domain);
    return;
  }

  // Google's favicon service is reliable and returns a proper icon for known brands
  const url = 'https://www.google.com/s2/favicons?domain=' + domain + '&sz=64';
  const img = new Image();
  img.onload = () => {
    // Google always returns 200 but may return a 16px grey globe for unknown domains.
    // Check rendered size — a 16x16 source image means it's the generic fallback.
    if (img.naturalWidth <= 16 && img.naturalHeight <= 16) {
      _logoCache.set(domain, 'failed');
      return;
    }
    _logoCache.set(domain, 'loaded');
    _applyLogo(avatarEl, domain);
  };
  img.onerror = () => { _logoCache.set(domain, 'failed'); };
  img.src = url;
}

function _applyLogo(avatarEl, domain) {
  const url = 'https://www.google.com/s2/favicons?domain=' + domain + '&sz=64';
  avatarEl.style.background = '#fff';
  avatarEl.style.border = '1px solid rgba(26,22,18,.1)';
  avatarEl.style.padding = '6px';
  avatarEl.textContent = '';
  const img = document.createElement('img');
  img.src = url;
  img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
  img.alt = '';
  avatarEl.appendChild(img);
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
  row.addEventListener('contextmenu', (e) => {
    openCtxMenu(e, email.id, {
      id: email.id,
      is_read: email.is_read,
      sender: email.sender,
      sender_name: email.sender_name,
      folder: email.folder,
      labels: email.labels || [],
    })
  })
  // Try to replace letter avatar with sender logo
  const domain = extractSenderDomain(email.sender);
  if (domain) tryLoadLogo(row.querySelector('.er-avatar'), domain);
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

    emailCache = emailCache.concat(rawEmails);
    emailOffset += rawEmails.length;
    emailHasMore = rawEmails.length >= data.limit;

    renderList(rawEmails, reset);
  } catch (err) {
    showApiError(err);
  } finally {
    emailLoading = false;
  }
}

function renderList(emails, reset = false) {
  const wrap = document.getElementById('el-items');
  const count = emailCache.length;
  document.getElementById('email-count').textContent =
    count + (emailHasMore ? '+' : '') + ' email' + (count !== 1 ? 's' : '');

  if (reset && emailCache.length === 0) {
    wrap.innerHTML = '<div style="padding:32px;text-align:center;color:var(--ink4);font-size:13px">No emails found</div>';
    return;
  }

  emails.forEach(email => wrap.appendChild(renderEmailRow(email)));
}

function setFolder(f, el) {
  currentDateFrom = null;
  currentDateTo   = null;
  // currentAccountIds intentionally NOT reset — account pills persist across folders
  currentFolder = f;
  currentFilter = 'all';
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  const titles = {
    inbox: 'Inbox', allmail: 'All Mail', bills: 'Bills', govt: 'Government',
    receipts: 'Receipts', work: 'Work', important: 'Important',
    promotions: 'Promotions', sent: 'Sent', draft: 'Drafts', spam: 'Spam',
    focused: 'Focused', snoozed: 'Snoozed',
  };
  document.getElementById('folder-title').textContent = titles[f] || f;
  document.querySelectorAll('.el-filter').forEach(i => i.classList.remove('active'));
  document.getElementById('filter-all').classList.add('active');
  document.querySelectorAll('.el-date-pill').forEach(i => i.classList.remove('active'));
  const customPanel = document.getElementById('custom-date-panel');
  if (customPanel) customPanel.style.display = 'none';
  const customPill = document.getElementById('date-custom');
  if (customPill) customPill.textContent = 'Custom ▾';
  updateClearFiltersVisibility();
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

function updateClearFiltersVisibility() {
  const link = document.getElementById('clear-filters-link');
  if (!link) return;
  const active = currentDateFrom || currentDateTo || currentAccountIds.length > 0;
  link.style.display = active ? '' : 'none';
}

function clearFilters() {
  currentDateFrom   = null;
  currentDateTo     = null;
  currentAccountIds = [];
  document.querySelectorAll('.el-date-pill').forEach(i => i.classList.remove('active'));
  const customPanel = document.getElementById('custom-date-panel');
  if (customPanel) customPanel.style.display = 'none';
  const customPill = document.getElementById('date-custom');
  if (customPill) customPill.textContent = 'Custom ▾';
  renderAccountPills();
  updateClearFiltersVisibility();
  loadEmails(true);
}

function setDatePreset(preset, el) {
  // Clicking an active preset clears it
  if (el.classList.contains('active')) {
    currentDateFrom = null;
    currentDateTo   = null;
    el.classList.remove('active');
    updateClearFiltersVisibility();
    loadEmails(true);
    return;
  }
  // Deactivate all date pills (only one preset at a time)
  document.querySelectorAll('.el-date-pill').forEach(i => i.classList.remove('active'));
  el.classList.add('active');

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  const today = fmt(now);

  if (preset === 'today') {
    currentDateFrom = today;
    currentDateTo   = today;
  } else if (preset === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - 7);
    currentDateFrom = fmt(d);
    currentDateTo   = today;
  } else if (preset === 'month') {
    const d = new Date(now); d.setMonth(d.getMonth() - 1);
    currentDateFrom = fmt(d);
    currentDateTo   = today;
  } else if (preset === '3month') {
    const d = new Date(now); d.setMonth(d.getMonth() - 3);
    currentDateFrom = fmt(d);
    currentDateTo   = today;
  }

  const customPanel = document.getElementById('custom-date-panel');
  if (customPanel) customPanel.style.display = 'none';
  const customPill = document.getElementById('date-custom');
  if (customPill) customPill.textContent = 'Custom ▾';

  updateClearFiltersVisibility();
  loadEmails(true);
}

function toggleCustomDatePicker() {
  const panel = document.getElementById('custom-date-panel');
  const pill  = document.getElementById('date-custom');
  if (!panel) return;

  const isOpen = panel.style.display !== 'none';

  // If open AND a custom range is active, clicking '✕' clears it
  if (isOpen && (currentDateFrom || currentDateTo)) {
    currentDateFrom = null;
    currentDateTo   = null;
    panel.style.display = 'none';
    if (pill) pill.textContent = 'Custom ▾';
    document.querySelectorAll('.el-date-pill').forEach(i => i.classList.remove('active'));
    updateClearFiltersVisibility();
    loadEmails(true);
    return;
  }

  panel.style.display = isOpen ? 'none' : '';
}

function applyCustomDates() {
  const fromVal = document.getElementById('date-from-input')?.value;
  const toVal   = document.getElementById('date-to-input')?.value;

  currentDateFrom = fromVal || null;
  currentDateTo   = toVal   || null;

  const panel = document.getElementById('custom-date-panel');
  const pill  = document.getElementById('date-custom');

  document.querySelectorAll('.el-date-pill').forEach(i => i.classList.remove('active'));

  if (currentDateFrom || currentDateTo) {
    if (pill) { pill.textContent = 'Custom ✕'; pill.classList.add('active'); }
  } else {
    if (pill) pill.textContent = 'Custom ▾';
  }

  if (panel) panel.style.display = 'none';
  updateClearFiltersVisibility();
  loadEmails(true);
}

function renderAccountPills() {
  const container = document.getElementById('el-acct-pills');
  if (!container) return;
  container.innerHTML = '';

  // Hide pills when only 0 or 1 account is connected (no value in filtering)
  if (accountsData.length <= 1) return;

  accountsData.forEach(acct => {
    const label = (acct.label || acct.email || '').slice(0, 20);
    const isActive = currentAccountIds.includes(acct.id);

    const pill = document.createElement('div');
    pill.className = 'el-filter' + (isActive ? ' active' : '');
    pill.title = acct.email || '';
    pill.textContent = label;
    pill.onclick = () => toggleAccountPill(acct.id, pill);
    container.appendChild(pill);
  });
}

function toggleAccountPill(accountId, el) {
  const idx = currentAccountIds.indexOf(accountId);
  if (idx === -1) {
    currentAccountIds.push(accountId);
    el.classList.add('active');
  } else {
    currentAccountIds.splice(idx, 1);
    el.classList.remove('active');
  }
  updateClearFiltersVisibility();
  loadEmails(true);
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

function showApiError(err) {
  const msg = err?.message || 'Unknown error';
  if (err?.status === 401 || err?.status === 403) {
    showReconnectPrompt();
  } else {
    showToast('Error: ' + msg);
  }
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

    // Mark read via unified function (optimistic + server reconcile)
    if (!email.is_read) {
      markEmailRead(id, true)
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
  // Reset to letter avatar first (in case previous email had a logo applied)
  av.style.background = color;
  av.style.border = '';
  av.style.padding = '';
  av.textContent = initial;
  // Try to replace with sender logo
  const domain = extractSenderDomain(email.sender);
  if (domain) tryLoadLogo(av, domain);

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

  // Body: render inside sandboxed iframe so email CSS/fonts can't leak into the app
  const bodyEl = document.getElementById('ed-body-content');
  bodyEl.innerHTML = '';
  if (email.body) {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-same-origin allow-popups allow-popups-to-escape-sandbox');
    // Inject base reset so email HTML renders cleanly regardless of its own styles
    const baseStyle = `
      html,body{margin:0;padding:0}
      body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;
           font-size:14px;line-height:1.65;color:#3d3530;overflow-x:hidden}
      img{max-width:100%!important;height:auto!important}
      table{max-width:100%!important}
      a{color:#e8402a}
      *{box-sizing:border-box}
    `;
    iframe.srcdoc = `<!DOCTYPE html><html><head><meta charset="UTF-8">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>${baseStyle}</style></head><body>${email.body}</body></html>`;
    bodyEl.appendChild(iframe);
    // Auto-size iframe height to its content so the outer .ed-body scrolls (not the iframe)
    iframe.addEventListener('load', () => {
      try {
        const h = iframe.contentDocument.documentElement.scrollHeight;
        iframe.style.height = Math.max(h, 200) + 'px';
      } catch(e) {}
    });
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

function showReconnectPrompt() {
  // Only show one banner at a time
  const existing = document.getElementById('reconnect-banner');
  if (existing) return;

  const banner = document.createElement('div');
  banner.id = 'reconnect-banner';
  banner.style.cssText = [
    'position:fixed', 'top:48px', 'left:0', 'right:0', 'z-index:500',
    'background:var(--coral)', 'color:#fff', 'padding:10px 16px',
    'font-size:13px', 'font-weight:500', 'display:flex', 'align-items:center',
    'justify-content:space-between', 'gap:12px',
  ].join(';');
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

// ── ACCOUNTS ─────────────────────────────────────────────────────────────────
let accountsData = [];

async function loadAccounts() {
  try {
    const data = await fetchAccounts();
    accountsData = data.accounts || [];

    // Show last sync time from most recently synced account
    const lastSynced = accountsData
      .map(a => a.last_synced)
      .filter(Boolean)
      .sort()
      .pop();
    const status = document.getElementById('sync-status');
    if (status && lastSynced) {
      status.textContent = 'Last sync: ' + new Date(lastSynced).toLocaleTimeString('en-MY', {
        hour: '2-digit', minute: '2-digit', hour12: true
      });
    }

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
    const providerColors = { gmail: '#4285f4', outlook: '#0078d4' };
    const color = providerColors[acct.provider] || 'var(--purple)';

    const el = document.createElement('div');
    el.className = 'sb-account';
    el.onclick = function() { setAccount(acct.id, this); };
    el.innerHTML = `
      <div class="acct-dot" style="background:${color}"></div>
      <div class="acct-name" title="${escHtml(acct.email)}">${escHtml(acct.label || acct.email)}</div>
      <div class="acct-count" id="acct-count-${escHtml(acct.id)}">—</div>`;
    list.appendChild(el);
  });

  // Hide connect links if already at 6 accounts
  const connectDiv = document.getElementById('accounts-connect');
  if (connectDiv) connectDiv.style.display = accountsData.length >= 6 ? 'none' : '';

  renderAccountPills();
}

// ── BILLS PANEL ───────────────────────────────────────────────────────────────
function renderOverdueBanner(bills) {
  const banner = document.getElementById('overdue-banner')
  if (!banner) return
  const overdue = bills.filter(b => b.status === 'overdue')
  if (!overdue.length || sessionStorage.getItem('overdue-banner-dismissed')) {
    banner.style.display = 'none'
    return
  }
  const n = overdue.length
  const total = overdue.reduce((sum, b) => sum + (b.amount_rm || 0), 0)
  const text = n === 1
    ? `You have <strong>1</strong> overdue bill — <strong>${escHtml(overdue[0].biller)}</strong>`
    : `You have <strong>${n}</strong> overdue bills`
  const totalStr = total > 0 ? ` — Total <strong>RM${total.toFixed(2)}</strong>` : ''
  document.getElementById('overdue-banner-text').innerHTML = text + totalStr
  banner.style.display = 'flex'
}

function dismissOverdueBanner() {
  sessionStorage.setItem('overdue-banner-dismissed', '1')
  const banner = document.getElementById('overdue-banner')
  if (banner) banner.style.display = 'none'
}

async function loadBills() {
  try {
    // Fetch unpaid + overdue bills, and all receipts (Shopee/Lazada orders)
    const [unpaid, overdue, receipts] = await Promise.all([
      fetchBills('unpaid'),
      fetchBills('overdue'),
      fetchBills(),  // all statuses — filter for receipt billers client-side
    ]);
    const bills = [...(overdue.bills || []), ...(unpaid.bills || [])];
    const orders = (receipts.bills || []).filter(b =>
      b.biller && /shopee|lazada/i.test(b.biller)
    );
    renderBillsPanel(bills, orders);
    renderOverdueBanner(bills);
  } catch (err) {
    const list = document.getElementById('bills-list');
    if (list) list.innerHTML = '<div style="color:var(--coral);font-size:12px">Failed to load bills</div>';
    renderOverdueBanner([]);
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
    el.setAttribute('data-bill-id', bill.id)
    el.title = 'Click to open email';
    el.innerHTML = `
      <div class="bi-icon">${getBillerIcon(bill.biller)}</div>
      <div class="bi-info">
        <div class="bi-name">${escHtml(bill.biller || 'Unknown')}</div>
        <div class="bi-due">${dueText}</div>
      </div>
      <div style="display:flex;flex-direction:column;align-items:flex-end;gap:5px;flex-shrink:0">
        <div class="bi-amt${isOverdue ? ' urgent' : ''}">RM${amt.toFixed(2)}</div>
        <button class="bi-pay-btn">✓ Paid</button>
      </div>`;

    // Click bill row → open related email
    el.onclick = () => {
      if (bill.email_id) selectEmail(bill.email_id);
    };

    // "✓ Paid" button → mark paid (stops propagation so row click doesn't fire)
    el.querySelector('.bi-pay-btn').addEventListener('click', e => {
      e.stopPropagation();
      updateBillStatus(bill.id, 'paid')
        .then(() => { showToast('Marked as paid!'); loadBills(); })
        .catch(err => showApiError(err));
    });

    list.appendChild(el);
  });

  document.getElementById('bills-total-amt').textContent = 'RM' + total.toFixed(2);
  document.getElementById('bills-overdue-count').textContent = String(overdueCount);
}

// ── PROGRESS OVERLAY ──────────────────────────────────────────────────────────
function showProgress(msg, sub) {
  document.getElementById('progress-msg').textContent = msg || 'Working…';
  document.getElementById('progress-sub').textContent = sub || 'Please wait';
  document.getElementById('progress-overlay').classList.add('show');
}
function hideProgress() {
  document.getElementById('progress-overlay').classList.remove('show');
}

// ── SYNC ──────────────────────────────────────────────────────────────────────
async function doSync() {
  const btn = document.getElementById('sync-btn');
  const status = document.getElementById('sync-status');
  if (!btn) return;

  btn.textContent = '↻ Syncing…';
  btn.disabled = true;
  if (status) status.textContent = '';
  showProgress('Syncing emails…', 'Fetching new messages from your accounts');

  try {
    const syncResult = await triggerSync();
    if (syncResult.added > 0 && Array.isArray(syncResult.emails)) {
      showEmailNotifications(syncResult.emails);
    }
    // Reload all data panels
    await Promise.all([loadEmails(true), loadAccounts(), loadBills(), refreshUnreadCounts()]);
    if (status) {
      status.textContent = 'Last sync: ' + new Date().toLocaleTimeString('en-MY', {
        hour: '2-digit', minute: '2-digit', hour12: true
      });
    }
    showToast('Sync complete!');
  } catch (err) {
    showToast('Sync failed: ' + (err.message || 'Unknown error'));
    if (status) status.textContent = 'Sync failed';
  } finally {
    btn.textContent = '↻ Sync';
    btn.disabled = false;
    hideProgress();
  }
}

// ── SETTINGS MODAL ───────────────────────────────────────────────────────────
async function loadAISettings() {
  // Only run if window.inboxmy is available (Electron context)
  if (!window.inboxmy) return

  const key = await window.inboxmy.getGeminiKey()
  const statusEl = document.getElementById('gemini-key-status')
  if (key) {
    // Key exists — show masked status
    if (statusEl) { statusEl.textContent = '✓ Key saved'; statusEl.className = 'key-status saved' }
  } else {
    if (statusEl) { statusEl.textContent = ''; statusEl.className = 'key-status' }
  }

  const autoLaunch = await window.inboxmy.getAutoLaunch()
  const toggle = document.getElementById('auto-launch-toggle')
  if (toggle) toggle.checked = !!autoLaunch
}

async function saveGeminiKeySetting() {
  if (!window.inboxmy) return
  const input = document.getElementById('gemini-key-input')
  const statusEl = document.getElementById('gemini-key-status')
  if (!input || !input.value.trim()) { showToast('Please enter a Gemini API key'); return }

  const result = await window.inboxmy.saveGeminiKey(input.value.trim())
  if (result && result.ok) {
    input.value = ''
    if (statusEl) { statusEl.textContent = '✓ Key saved'; statusEl.className = 'key-status saved' }
    showToast('Gemini key saved!')
  } else {
    if (statusEl) { statusEl.textContent = '✗ Failed to save'; statusEl.className = 'key-status error' }
    showToast('Failed to save key')
  }
}

async function toggleAutoLaunch(enabled) {
  if (!window.inboxmy) return
  await window.inboxmy.setAutoLaunch(enabled)
  showToast(enabled ? 'InboxMY will launch at Windows startup' : 'Auto-launch disabled')
}

async function loadNotifSettings() {
  if (!window.inboxmy) return
  const enabled = await window.inboxmy.getNotifPref().catch(() => true)
  const toggle = document.getElementById('notif-toggle')
  const offLabel = document.getElementById('notif-off-label')
  if (toggle) toggle.checked = enabled
  if (offLabel) offLabel.style.display = enabled ? 'none' : ''
}

async function handleNotifToggle(enabled) {
  if (!window.inboxmy) return
  await window.inboxmy.setNotifPref(enabled)
  const offLabel = document.getElementById('notif-off-label')
  if (offLabel) offLabel.style.display = enabled ? 'none' : ''
}

function openSettings() {
  document.getElementById('profile-dropdown').classList.remove('open');
  renderSettingsAccounts();
  loadAISettings()
  loadNotifSettings()
  document.getElementById('settings-modal').classList.add('open');
}
function closeSettings() {
  document.getElementById('settings-modal').classList.remove('open');
}

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
      if (e.key === 'Enter') { e.preventDefault(); doSave(); }
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

// ── CONFIRM MODAL ─────────────────────────────────────────────────────────────
let _confirmedAction = null;

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
async function runConfirmedAction() {
  if (!_confirmedAction) return;
  const btn = document.getElementById('confirm-submit');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  try {
    await _confirmedAction();
    // action may already close the modal (e.g. resync/wipe), but safe to call again
    closeConfirm();
  } catch (err) {
    showToast('Error: ' + (err.message || 'Unknown error'));
    hideProgress();
    btn.disabled = false;
    btn.textContent = 'Delete';
  }
}

function confirmResync(accountId, label) {
  openConfirm(
    `This will delete all synced emails for <strong>${escHtml(label)}</strong> and re-fetch everything on the next sync. Your actual email account is not affected.`,
    async () => {
      closeConfirm();
      showProgress('Deleting emails…', `Clearing data for ${label}`);
      try {
        await apiFetch('/api/accounts/' + accountId + '/emails', { method: 'DELETE' });
        showProgress('Re-syncing…', 'Fetching fresh messages from your account');
        await triggerSync(accountId);
        await Promise.all([loadEmails(true), loadAccounts(), loadBills(), refreshUnreadCounts()]);
        renderSettingsAccounts();
        showToast('Re-sync complete!');
      } finally {
        hideProgress();
      }
    }
  );
}

function confirmWipeAll() {
  openConfirm(
    'This will permanently delete <strong>all synced emails and bills</strong> from this device across every connected account. Your actual email accounts are not affected. The next sync will re-fetch everything.',
    async () => {
      closeConfirm();
      showProgress('Deleting all email data…', 'This may take a moment');
      try {
        await apiFetch('/api/emails', { method: 'DELETE' });
        emailCache = []; emailOffset = 0; emailHasMore = false;
        document.getElementById('el-items').innerHTML =
          '<div style="padding:32px;text-align:center;color:var(--ink4);font-size:13px">No emails found</div>';
        document.getElementById('email-count').textContent = '0 emails';
        document.getElementById('ed-empty').style.display = '';
        document.getElementById('ed-content').style.display = 'none';
        await Promise.all([loadAccounts(), loadBills(), refreshUnreadCounts()]);
        renderSettingsAccounts();
        showToast('All email data deleted.');
      } finally {
        hideProgress();
      }
    }
  );
}

// ── Electron IPC handlers (only active in Electron context) ──────────────
if (window.inboxmy) {
  // Receive live bill data from the background scheduler
  window.inboxmy.onBillAlert(function(data) {
    if (data && Array.isArray(data.overdue)) {
      renderOverdueBanner(data.overdue.map(b => ({ ...b, status: 'overdue' })))
    }
  })

  // Background sync completed — silently refresh email list + badges
  window.inboxmy.onSyncComplete(function() {
    loadEmails(true)
    refreshUnreadCounts()
  })

  window.inboxmy.onNewEmails(({ emails }) => {
    refreshUnreadCounts()
    if (emails) showEmailNotifications(emails)
  })

  // Deep link: toast click → navigate to specific bill
  window.inboxmy.onNavigateToBill(function(billId) {
    // Switch to bills folder
    const billsFolder = document.getElementById('folder-bills')
    if (billsFolder) setFolder('bills', billsFolder)

    // Highlight and scroll to the bill after a short delay to allow re-render
    setTimeout(function() {
      const billEl = document.querySelector(`[data-bill-id="${billId}"]`)
      if (billEl) {
        billEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
        billEl.classList.add('highlight')
        setTimeout(() => billEl.classList.remove('highlight'), 2000)
      }
    }, 300)
  })
}

// ── BACKGROUND SYNC POLL ─────────────────────────────────────────────────────
async function refreshFocusedBadge() {
  try {
    const data = await apiFetch('/api/emails?folder=inbox&tab=primary&unread=1&limit=1')
    const el = document.getElementById('badge-focused')
    if (el) el.textContent = data.total > 0 ? (data.total > 99 ? '99+' : data.total) : ''
  } catch { /* silent */ }
}

async function promptNewLabel() {
  const name = prompt('Label name:')
  if (!name || !name.trim()) return
  try {
    await apiFetch('/api/labels', { method: 'POST', body: JSON.stringify({ name: name.trim() }) })
    await loadLabels()
  } catch (e) {
    showToast('Could not create label: ' + (e?.message || 'Unknown error'))
  }
}

// Silently syncs every 60 seconds and refreshes the email list if new emails
// were added. Uses Gmail History API on the backend so it's cheap (1 API call
// per poll when nothing is new).
async function backgroundSyncPoll() {
  try {
    const result = await triggerSync();
    if (result.added > 0 && Array.isArray(result.emails)) {
      showEmailNotifications(result.emails);
    }
    loadEmails(true);
    refreshUnreadCounts();
  } catch { /* non-critical — ignore failures */ }
}

// ── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupInfiniteScroll();
  await Promise.all([
    loadAccounts(),
    loadEmails(true),
    loadBills(),
    refreshUnreadCounts(),
  ]);
  loadLabels()
  refreshFocusedBadge()

  // Request notification permission early so it's ready when emails arrive
  if (Notification.permission === 'default') Notification.requestPermission()

  // Start background poll — 60 s interval for near-real-time inbox updates
  setInterval(backgroundSyncPoll, 60_000);
});

// ── CONTEXT MENU ─────────────────────────────────────────────────────────────
let ctxEmailId = null
let ctxEmailData = null  // { id, is_read, sender, sender_name, folder, labels }

function closeCtxMenu() {
  const menu = document.getElementById('ctx-menu')
  if (menu) menu.style.display = 'none'
  ctxEmailId = null
  ctxEmailData = null
}

document.addEventListener('click', (e) => {
  if (!document.getElementById('ctx-menu')?.contains(e.target)) closeCtxMenu()
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeCtxMenu()
})
document.getElementById('el-items')?.addEventListener('scroll', closeCtxMenu)

function openCtxMenu(e, emailId, emailData) {
  e.preventDefault()
  ctxEmailId = emailId
  ctxEmailData = emailData

  const markReadEl   = document.getElementById('ctx-mark-read')
  const markUnreadEl = document.getElementById('ctx-mark-unread')
  if (markReadEl)   markReadEl.style.display   = emailData.is_read ? 'none' : ''
  if (markUnreadEl) markUnreadEl.style.display = emailData.is_read ? '' : 'none'

  // Find from sender
  const senderEl = document.getElementById('ctx-find-sender')
  if (senderEl) senderEl.textContent = `🔍 Find emails from ${emailData.sender_name || emailData.sender}`

  // Populate label submenu
  renderCtxLabelList()

  const menu = document.getElementById('ctx-menu')
  menu.style.display = 'block'

  // Position — keep within viewport
  const menuW = 220, menuH = 340
  let x = e.clientX, y = e.clientY
  if (x + menuW > window.innerWidth)  x = window.innerWidth - menuW - 8
  if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8
  menu.style.left = x + 'px'
  menu.style.top  = y + 'px'
}

function renderCtxLabelList() {
  const list = document.getElementById('ctx-labels-list')
  if (!list || !ctxEmailData) return
  const emailLabels = ctxEmailData.labels || []
  const assignedIds = new Set(emailLabels.map(l => l.id))
  list.innerHTML = userLabels.map(l => `
    <div class="ctx-item" onclick="ctxToggleLabel('${l.id}')">
      <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${escHtml(l.color)};margin-right:8px"></span>
      ${escHtml(l.name)}
      ${assignedIds.has(l.id) ? ' ✓' : ''}
    </div>
  `).join('')
}

async function ctxAction(action) {
  if (!ctxEmailId) return
  const id = ctxEmailId
  const data = ctxEmailData
  closeCtxMenu()

  if (action === 'reply' || action === 'reply-all' || action === 'forward') {
    if (typeof openCompose === 'function') {
      openCompose({ mode: action, emailId: id })
    } else {
      showToast('Compose coming soon')
    }
    return
  }

  if (action === 'archive') {
    await apiFetch(`/api/emails/${id}/folder`, { method: 'PATCH', body: JSON.stringify({ folder: 'archive' }) })
    removeEmailFromList(id)
    return
  }

  if (action === 'delete') {
    await apiFetch(`/api/emails/${id}/folder`, { method: 'PATCH', body: JSON.stringify({ folder: 'trash' }) })
    removeEmailFromList(id)
    return
  }

  if (action === 'mark-read') {
    closeCtxMenu()
    markEmailRead(id, true)
    return
  }

  if (action === 'mark-unread') {
    closeCtxMenu()
    markEmailRead(id, false)
    return
  }

  if (action === 'find-sender') {
    const searchInput = document.getElementById('search-input')
    if (searchInput) {
      searchInput.value = data.sender
      filterEmails(data.sender)
    }
    return
  }
}

function removeEmailFromList(id) {
  const row = document.getElementById('row-' + id)
  if (row) row.remove()
  emailCache = emailCache.filter(e => e.id !== id)
  const countEl = document.getElementById('email-count')
  if (countEl) countEl.textContent = emailCache.length + (emailHasMore ? '+' : '') + ' email' + (emailCache.length !== 1 ? 's' : '')
}

async function ctxMoveTo(folder) {
  if (!ctxEmailId) return
  const id = ctxEmailId
  closeCtxMenu()
  await apiFetch(`/api/emails/${id}/folder`, { method: 'PATCH', body: JSON.stringify({ folder }) })
  removeEmailFromList(id)
}

async function ctxToggleLabel(labelId) {
  if (!ctxEmailId || !ctxEmailData) return
  const id = ctxEmailId
  const assignedIds = new Set((ctxEmailData.labels || []).map(l => l.id))
  if (assignedIds.has(labelId)) {
    await apiFetch(`/api/emails/${id}/labels/${labelId}`, { method: 'DELETE' })
    ctxEmailData.labels = (ctxEmailData.labels || []).filter(l => l.id !== labelId)
  } else {
    await apiFetch(`/api/emails/${id}/labels/${labelId}`, { method: 'POST' })
    const label = userLabels.find(l => l.id === labelId)
    if (label) ctxEmailData.labels = [...(ctxEmailData.labels || []), label]
  }
  renderCtxLabelList()
  await loadLabels()  // refresh sidebar counts
}

function ctxNewLabel() {
  const wrap = document.getElementById('ctx-new-label-wrap')
  if (wrap) { wrap.style.display = ''; document.getElementById('ctx-new-label-input')?.focus() }
}

async function ctxCreateAndAssignLabel() {
  const input = document.getElementById('ctx-new-label-input')
  const name = input?.value?.trim()
  if (!name) return
  try {
    const label = await apiFetch('/api/labels', { method: 'POST', body: JSON.stringify({ name }) })
    await apiFetch(`/api/emails/${ctxEmailId}/labels/${label.id}`, { method: 'POST' })
    if (input) input.value = ''
    const wrap = document.getElementById('ctx-new-label-wrap')
    if (wrap) wrap.style.display = 'none'
    await loadLabels()
  } catch (e) {
    showToast('Could not create label: ' + (e?.message || 'error'))
  }
}

function ctxSnoozePreset(preset) {
  if (!ctxEmailId) return
  const now = new Date()
  let until

  if (preset === 'later-today') {
    until = Date.now() + 3 * 60 * 60 * 1000
  } else if (preset === 'tomorrow') {
    const d = new Date(now); d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0)
    until = d.getTime()
  } else if (preset === 'weekend') {
    const d = new Date(now)
    const daysToSat = (6 - d.getDay() + 7) % 7 || 7
    d.setDate(d.getDate() + daysToSat); d.setHours(9, 0, 0, 0)
    until = d.getTime()
  } else if (preset === 'next-week') {
    const d = new Date(now)
    const daysToMon = (1 - d.getDay() + 7) % 7 || 7
    d.setDate(d.getDate() + daysToMon); d.setHours(9, 0, 0, 0)
    until = d.getTime()
  }

  const id = ctxEmailId
  closeCtxMenu()
  apiFetch(`/api/emails/${id}/snooze`, { method: 'PATCH', body: JSON.stringify({ until }) })
    .then(() => { removeEmailFromList(id); refreshUnreadCounts() })
    .catch(e => showToast('Snooze failed: ' + e.message))
}

function ctxSnoozeCustom() {
  const wrap = document.getElementById('ctx-snooze-custom-wrap')
  if (wrap) { wrap.style.display = ''; document.getElementById('ctx-snooze-datetime')?.focus() }
}

async function ctxSnoozeApplyCustom() {
  const input = document.getElementById('ctx-snooze-datetime')
  if (!input || !input.value) return
  const until = new Date(input.value).getTime()
  if (isNaN(until) || until <= Date.now()) { showToast('Please pick a future date/time'); return }
  const id = ctxEmailId
  closeCtxMenu()
  try {
    await apiFetch(`/api/emails/${id}/snooze`, { method: 'PATCH', body: JSON.stringify({ until }) })
    removeEmailFromList(id)
    refreshUnreadCounts()
  } catch (e) {
    showToast('Snooze failed: ' + e.message)
  }
}
