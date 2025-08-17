// admin.js – logic for the admin dashboard

let adminSecret = '';

async function apiGet(path) {
  const url = `${path}${path.includes('?') ? '&' : '?'}secret=${encodeURIComponent(adminSecret)}`;
  const res = await fetch(url);
  return res.json();
}

async function apiPost(path, body) {
  body = Object.assign({}, body, { secret: adminSecret });
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

function renderWithdrawals(list) {
  const container = document.getElementById('withdrawalsList');
  if (!list || list.length === 0) {
    container.innerHTML = '<p>No pending withdrawals.</p>';
    return;
  }
  let html = '<table><thead><tr><th>ID</th><th>User</th><th>To</th><th>Gross TON</th><th>Fee</th><th>Net</th><th>Status</th><th>Requested</th><th>Action</th></tr></thead><tbody>';
  for (const w of list) {
    html += `<tr><td>${w.id}</td><td>${w.userId}</td><td>${w.to}</td><td>${w.amountTon}</td><td>${w.feeTon}</td><td>${w.netTon}</td><td>${w.status}</td><td>${new Date(w.requestedAt).toLocaleString()}</td><td>`;
    if (w.status === 'pending') {
      html += `<button class="process" data-id="${w.id}">Process</button>`;
    }
    html += '</td></tr>';
  }
  html += '</tbody></table>';
  container.innerHTML = html;
  // Attach click handlers
  container.querySelectorAll('button.process').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const id = btn.getAttribute('data-id');
      btn.disabled = true;
      btn.textContent = 'Processing...';
      const res = await apiPost('/api/admin/withdrawals/process', { id });
      // Refresh list
      loadWithdrawals();
    });
  });
}

function renderMarkets(list) {
  const container = document.getElementById('marketsList');
  if (!list || list.length === 0) {
    container.innerHTML = '<p>No markets.</p>';
    return;
  }
  let html = '<table><thead><tr><th>ID</th><th>Asset</th><th>Strike</th><th>Status</th><th>Pools (above/below)</th><th>Bets</th><th>Expiry</th></tr></thead><tbody>';
  for (const m of list) {
    html += `<tr><td>${m.id}</td><td>${m.asset}</td><td>${m.strike}</td><td>${m.status}</td><td>${m.pools.above}/${m.pools.below}</td><td>${m.bets.length}</td><td>${new Date(m.expiry).toLocaleString()}</td></tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

function renderLedger(obj) {
  const container = document.getElementById('ledgerList');
  const entries = Object.entries(obj || {});
  if (entries.length === 0) {
    container.innerHTML = '<p>Ledger is empty.</p>';
    return;
  }
  let html = '<table><thead><tr><th>User</th><th>Balance TON</th></tr></thead><tbody>';
  for (const [uid, bal] of entries) {
    html += `<tr><td>${uid}</td><td>${bal}</td></tr>`;
  }
  html += '</tbody></table>';
  container.innerHTML = html;
}

async function loadWithdrawals() {
  const data = await apiGet('/api/admin/withdrawals');
  renderWithdrawals(data);
}

async function loadMarkets() {
  const data = await apiGet('/api/admin/markets');
  renderMarkets(data);
}

async function loadLedger() {
  const data = await apiGet('/api/admin/ledger');
  renderLedger(data);
}

function showAdmin() {
  document.getElementById('login').style.display = 'none';
  document.getElementById('adminContent').style.display = '';
  // Load initial data
  loadWithdrawals();
  loadMarkets();
  loadLedger();
}

// Handle login
document.getElementById('loginBtn').addEventListener('click', async () => {
  adminSecret = document.getElementById('secret').value.trim();
  if (!adminSecret) {
    document.getElementById('loginStatus').textContent = 'Secret is required';
    return;
  }
  try {
    // Attempt to fetch withdrawals to verify secret
    const res = await apiGet('/api/admin/withdrawals');
    if (Array.isArray(res)) {
      showAdmin();
    } else {
      document.getElementById('loginStatus').textContent = 'Invalid secret';
    }
  } catch (err) {
    document.getElementById('loginStatus').textContent = 'Error logging in';
  }
});