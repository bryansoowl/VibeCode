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

async function fetchEmails({ category, folder, tab, important, accountId, search, unread, limit = 50, offset = 0 } = {}) {
  const p = new URLSearchParams();
  if (category)  p.set('category', category);
  if (folder)    p.set('folder', folder);
  if (tab)       p.set('tab', tab);
  if (important) p.set('important', '1');
  if (accountId) p.set('accountId', accountId);
  if (search)    p.set('search', search);
  if (unread)    p.set('unread', '1');
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
};

function buildEmailParams(offset = 0) {
  const folderParams = FOLDER_PARAMS[currentFolder] || { folder: 'inbox' };
  return {
    ...folderParams,
    accountId: currentAccountId || undefined,
    search: currentSearch || undefined,
    unread: currentFilter === 'unread' || undefined,
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
  currentFolder = f;
  currentFilter = 'all';
  document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');
  const titles = {
    inbox: 'Inbox', allmail: 'All Mail', bills: 'Bills', govt: 'Government',
    receipts: 'Receipts', work: 'Work', important: 'Important',
    promotions: 'Promotions', sent: 'Sent', draft: 'Drafts', spam: 'Spam',
  };
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
      // Decrement inbox unread badge
      const badge = document.getElementById('badge-inbox');
      if (badge) {
        const curr = parseInt(badge.textContent) || 0;
        if (curr > 1) badge.textContent = String(curr - 1);
        else badge.textContent = '';
      }
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
    ? `You have <strong>1</strong> overdue bill — <strong>${overdue[0].biller}</strong>`
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

// ── CATEGORY BADGES ───────────────────────────────────────────────────────────
async function loadCategoryBadges() {
  try {
    const [inboxUnread, bills, govt, receipts, work, important, promotions, sent, draft, spam] = await Promise.all([
      fetchEmails({ folder: 'inbox',   unread: true, limit: 1, offset: 0 }),  // inbox unread (excl. promos)
      fetchEmails({ category: 'bill',               limit: 1, offset: 0 }),
      fetchEmails({ category: 'govt',               limit: 1, offset: 0 }),
      fetchEmails({ category: 'receipt',            limit: 1, offset: 0 }),
      fetchEmails({ category: 'work',               limit: 1, offset: 0 }),
      fetchEmails({ important: '1',                 limit: 1, offset: 0 }),
      fetchEmails({ tab: 'promotions',              limit: 1, offset: 0 }),
      fetchEmails({ folder: 'sent',                 limit: 1, offset: 0 }),
      fetchEmails({ folder: 'draft',                limit: 1, offset: 0 }),
      fetchEmails({ folder: 'spam',                 limit: 1, offset: 0 }),
    ]);
    const set = (id, n) => {
      const el = document.getElementById(id);
      if (el) el.textContent = n > 0 ? String(n) : '';
    };
    set('badge-inbox',      inboxUnread.total ?? 0);
    set('badge-bills',      bills.total       ?? 0);
    set('badge-govt',       govt.total        ?? 0);
    set('badge-receipts',   receipts.total    ?? 0);
    set('badge-work',       work.total        ?? 0);
    set('badge-important',  important.total   ?? 0);
    set('badge-promotions', promotions.total  ?? 0);
    set('badge-sent',       sent.total        ?? 0);
    set('badge-draft',      draft.total       ?? 0);
    set('badge-spam',       spam.total        ?? 0);
    // All Mail badge: total across every folder (no badge shown — count is just informational)
    // Intentionally not setting badge-allmail to avoid a huge unmanageable number
  } catch { /* badges are non-critical */ }
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
    await triggerSync();
    // Reload all data panels
    await Promise.all([loadEmails(true), loadAccounts(), loadBills(), loadCategoryBadges()]);
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
function openSettings() {
  document.getElementById('profile-dropdown').classList.remove('open');
  renderSettingsAccounts();
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
        await Promise.all([loadEmails(true), loadAccounts(), loadBills(), loadCategoryBadges()]);
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
        await Promise.all([loadAccounts(), loadBills(), loadCategoryBadges()]);
        renderSettingsAccounts();
        showToast('All email data deleted.');
      } finally {
        hideProgress();
      }
    }
  );
}

// ── INIT ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupInfiniteScroll();
  await Promise.all([
    loadAccounts(),
    loadEmails(true),
    loadBills(),
    loadCategoryBadges(),
  ]);
});
