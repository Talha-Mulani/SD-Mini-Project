// Active-Active GeoCache Regional Storefront & Live Cache Inspector
// Runs on all regional storefronts (mumbai.html, frankfurt.html, virginia.html)

const PRODUCTS = [
  { sku: 'ps5-pro', name: 'PlayStation 5 Pro', price: 699.99, emoji: '🎮', stock: 15 },
  { sku: 'iphone-16', name: 'iPhone 16 Pro Max', price: 1199.00, emoji: '📱', stock: 25 },
  { sku: 'nike-sneaker', name: 'Nike Air Max Flash', price: 159.50, emoji: '👟', stock: 40 },
  { sku: 'sony-wh1000', name: 'Sony WH-1000XM5 ANC', price: 349.99, emoji: '🎧', stock: 18 }
];

let currentUser = 'alice';
let cart = [];
const activityLog = [];

const $ = id => document.getElementById(id);
const money = val => `$${Number(val).toFixed(2)}`;

function switchUser(user) {
  currentUser = user;
  loadCartForUser();
  $('activeUserLabel').textContent = user.toUpperCase();
  logActivity(`Switched active user to ${user.toUpperCase()}`, 'info');
  // Auto-fill query cache input with user's cart
  $('cacheKeyInput').value = `cart:${currentUser}`;
  queryCache();
}

function logActivity(text, type = 'write') {
  const time = new Date().toLocaleTimeString();
  activityLog.unshift({ text, type, time });
  if (activityLog.length > 20) activityLog.pop();
  renderActivityFeed();
}

function renderActivityFeed() {
  const container = $('activityFeed');
  if (!container) return;
  if (!activityLog.length) {
    container.innerHTML = '<p class="muted" style="padding:10px;font-size:12px;">No regional events recorded yet.</p>';
    return;
  }
  container.innerHTML = activityLog.map(a => `
    <div class="activity-item ${a.type}">
      <span>${a.text}</span>
      <span style="font-family:var(--font-mono);font-size:10px;color:var(--text-muted);">${a.time}</span>
    </div>
  `).join('');
}

function renderProducts() {
  const container = $('productsGrid');
  if (!container) return;
  container.innerHTML = PRODUCTS.map(p => `
    <div class="product-card">
      <div class="product-top">
        <div class="product-emoji">${p.emoji}</div>
        <div>
          <div class="product-title">${p.name}</div>
          <div class="product-price">${money(p.price)}</div>
        </div>
      </div>
      <div>
        <div class="stock-badge ${p.stock < 10 ? 'low' : ''}">
          ⚡ ${p.stock} units available in ${REGION.toUpperCase()}
        </div>
        <div class="btn-row">
          <button class="primary" onclick="addToCart('${p.sku}')">🛒 Add to Cart</button>
          <button class="secondary" onclick="reserveStock('${p.sku}')">📦 Reserve 1 (CRDT)</button>
        </div>
      </div>
    </div>
  `).join('');
}

function renderCart() {
  const container = $('cartItems');
  if (!container) return;
  if (!cart.length) {
    container.innerHTML = '<p class="muted" style="font-size:13px;padding:8px 0;">Cart is empty. Add a flash-sale item above!</p>';
    $('cartTotal').textContent = '$0.00';
    $('checkoutBtn').disabled = true;
    return;
  }

  const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  $('cartTotal').textContent = money(total);
  $('checkoutBtn').disabled = false;

  container.innerHTML = cart.map(item => `
    <div class="cart-item-row">
      <div>
        <span style="font-weight:700;">${item.name}</span>
        <span style="color:var(--text-muted);font-size:12px;margin-left:6px;">× ${item.qty}</span>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <span style="font-weight:700;">${money(item.price * item.qty)}</span>
        <button class="secondary" style="padding:2px 8px;font-size:11px;" onclick="removeFromCart('${item.sku}')">✕</button>
      </div>
    </div>
  `).join('');
}

async function loadCartForUser() {
  cart = [];
  try {
    const res = await fetch(`/api/records/cart:${currentUser}?region=${REGION}`);
    if (res.ok) {
      const data = await res.json();
      if (data.value && Array.isArray(data.value.items)) {
        cart = data.value.items;
      }
    }
  } catch {}
  renderCart();
}

async function addToCart(sku) {
  const product = PRODUCTS.find(p => p.sku === sku);
  const existing = cart.find(p => p.sku === sku);
  if (existing) {
    existing.qty++;
  } else {
    cart.push({ sku: product.sku, name: product.name, price: product.price, qty: 1 });
  }

  const key = `cart:${currentUser}`;
  const payload = {
    customer: currentUser,
    items: cart.map(({ sku, name, price, qty }) => ({ sku, name, price, qty })),
    updatedIn: REGION,
    updatedAt: new Date().toISOString()
  };

  $('noticeBanner').innerHTML = `⏳ Saving cart to <b>${REGION.toUpperCase()}</b> local cache...`;

  try {
    const start = performance.now();
    const res = await fetch(`/api/records/${encodeURIComponent(key)}?region=${REGION}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: payload, dataType: 'or_set' })
    });
    const duration = (performance.now() - start).toFixed(1);
    const result = await res.json();

    $('noticeBanner').innerHTML = `✅ <b>Cart Updated!</b> Saved locally in <b>${result.acceptedBy.toUpperCase()}</b> in <b>${duration}ms</b>. Asynchronously queued for peer regions.`;
    logActivity(`Added ${product.name} to ${key} (${duration}ms)`, 'write');
    renderCart();

    // Auto-refresh the cache query box
    $('cacheKeyInput').value = key;
    queryCache();
  } catch (err) {
    $('noticeBanner').innerHTML = `❌ Error: ${err.message}`;
  }
}

async function removeFromCart(sku) {
  cart = cart.filter(item => item.sku !== sku);
  const key = `cart:${currentUser}`;
  const payload = {
    customer: currentUser,
    items: cart,
    updatedIn: REGION,
    updatedAt: new Date().toISOString()
  };

  try {
    await fetch(`/api/records/${encodeURIComponent(key)}?region=${REGION}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: payload, dataType: 'or_set' })
    });
    logActivity(`Removed item from ${key}`, 'write');
    renderCart();
    $('cacheKeyInput').value = key;
    queryCache();
  } catch {}
}

async function reserveStock(sku) {
  const product = PRODUCTS.find(p => p.sku === sku);
  const key = `inventory:${sku}`;

  $('noticeBanner').innerHTML = `⏳ Reserving 1 unit of <b>${product.name}</b> via PN-Counter CRDT...`;

  const payload = {
    type: 'pn_counter',
    sku,
    P: { [REGION]: 1 },
    N: {},
    reservedIn: REGION,
    reservedBy: currentUser
  };

  try {
    const start = performance.now();
    const res = await fetch(`/api/records/${encodeURIComponent(key)}?region=${REGION}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: payload, dataType: 'pn_counter' })
    });
    const duration = (performance.now() - start).toFixed(1);
    const data = await res.json();

    if (product.stock > 0) product.stock--;
    renderProducts();

    $('noticeBanner').innerHTML = `📦 <b>Stock Reserved!</b> 1 unit of ${product.name} reserved in <b>${REGION.toUpperCase()}</b> in <b>${duration}ms</b> (PN-Counter CRDT). No overselling!`;
    logActivity(`Reserved 1x ${product.name} on ${key} (${duration}ms)`, 'write');

    $('cacheKeyInput').value = key;
    queryCache();
  } catch (err) {
    $('noticeBanner').innerHTML = `❌ Stock reservation failed: ${err.message}`;
  }
}

async function checkout() {
  if (!cart.length) return;
  const orderId = `GC-${REGION.slice(0,3).toUpperCase()}-${Date.now().toString().slice(-6)}`;
  const key = `order:${orderId}`;
  const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);

  const orderPayload = {
    orderId,
    customer: currentUser,
    items: [...cart],
    total,
    status: 'PAID',
    placedIn: REGION,
    placedAt: new Date().toISOString()
  };

  $('noticeBanner').innerHTML = `⏳ Placing order <b>${orderId}</b> in <b>${REGION.toUpperCase()}</b>...`;

  try {
    const start = performance.now();
    const res = await fetch(`/api/records/${encodeURIComponent(key)}?region=${REGION}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: orderPayload, dataType: 'lww' })
    });
    const duration = (performance.now() - start).toFixed(1);
    const data = await res.json();

    $('noticeBanner').innerHTML = `🎉 <b>Order Placed!</b> Order <b>${orderId}</b> (${money(total)}) confirmed in <b>${duration}ms</b>. Replicating globally!`;
    logActivity(`Order ${orderId} placed by ${currentUser.toUpperCase()} (${money(total)})`, 'order');

    // Clear cart
    cart = [];
    await fetch(`/api/records/cart:${currentUser}?region=${REGION}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ value: { customer: currentUser, items: [] }, dataType: 'or_set' })
    });

    renderCart();
    $('cacheKeyInput').value = key;
    queryCache();
  } catch (err) {
    $('noticeBanner').innerHTML = `❌ Order failed: ${err.message}`;
  }
}

// ---------------- EASY CACHE INSPECTION TOOL ----------------
async function queryCache(customKey) {
  const key = customKey || $('cacheKeyInput').value.trim();
  if (!key) return;

  const resultContainer = $('cacheResult');
  resultContainer.innerHTML = '<p class="muted" style="font-size:12px;">Querying regional cache hierarchy...</p>';

  const startTime = performance.now();
  try {
    const res = await fetch(`/api/records/${encodeURIComponent(key)}?region=${REGION}`);
    const latency = (performance.now() - startTime).toFixed(1);

    if (!res.ok) {
      resultContainer.innerHTML = `
        <div style="color:var(--text-muted);font-size:13px;padding:12px 0;">
          ❌ Key <code>${key}</code> not found in <b>${REGION.toUpperCase()}</b> cache.
        </div>
      `;
      return;
    }

    const data = await res.json();
    const source = data.source || 'redis';
    let tierBadge = '';
    if (source === 'l1') {
      tierBadge = '<span class="tier-tag tier-l1">⚡ L1 In-Memory Cache (0.1ms)</span>';
    } else if (source === 'redis') {
      tierBadge = '<span class="tier-tag tier-redis">🔵 L2 Regional Redis (1.4ms)</span>';
    } else {
      tierBadge = '<span class="tier-tag tier-db">🟣 PostgreSQL Durable Store</span>';
    }

    const xfetchBadge = data.xfetchTriggered
      ? '<span class="stock-badge" style="background:var(--accent-glow);color:var(--accent);">🛡️ XFetch Early Renewal</span>'
      : '';

    // Render Clean Human-Readable Card (No Raw JSON unless toggled)
    let humanSummary = '';
    const val = data.value || {};

    if (val.items && Array.isArray(val.items)) {
      // Shopping Cart or Order
      humanSummary = `
        <div style="margin:8px 0;font-size:13px;">
          <b>Customer:</b> <span style="color:var(--accent);">${val.customer || 'Unknown'}</span> | 
          <b>Items Count:</b> ${val.items.length} item(s)
          ${val.status ? `| <b>Status:</b> <span class="stock-badge">${val.status}</span>` : ''}
          ${val.total ? `| <b>Total:</b> <b>${money(val.total)}</b>` : ''}
        </div>
        <div style="background:#131b26;border-radius:6px;padding:8px;margin-top:6px;">
          ${val.items.map(it => `<div style="font-size:12px;padding:3px 0;">• ${it.name || it.sku} × ${it.qty || 1} (${money((it.price || 0) * (it.qty || 1))})</div>`).join('')}
        </div>
      `;
    } else if (val.type === 'pn_counter' || data.data_type === 'pn_counter') {
      // PN-Counter
      humanSummary = `
        <div style="margin:8px 0;font-size:13px;">
          <b>CRDT Type:</b> PN-Counter (Positive-Negative Counter)<br>
          <b>Resolved Balance:</b> <span style="font-size:16px;font-weight:800;color:var(--green);">${val.value !== undefined ? val.value : 'Active'}</span> units
        </div>
      `;
    } else {
      humanSummary = `
        <div style="margin:8px 0;font-size:13px;">
          ${Object.entries(val).map(([k, v]) => `<div><b>${k}:</b> <span style="color:#bae6fd;">${typeof v === 'object' ? JSON.stringify(v) : v}</span></div>`).join('')}
        </div>
      `;
    }

    resultContainer.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <div style="display:flex;align-items:center;gap:8px;">
          ${tierBadge}
          ${xfetchBadge}
          <span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">${latency}ms fetch</span>
        </div>
        <span style="font-size:11px;background:#1e293b;padding:2px 8px;border-radius:4px;color:var(--accent);">
          Origin: <b>${(data.origin_region || data.originRegion || REGION).toUpperCase()}</b>
        </span>
      </div>

      <div style="margin-top:10px;">
        <span style="font-size:11px;font-weight:700;color:var(--text-muted);text-transform:uppercase;">Cache Key:</span>
        <code style="color:#38bdf8;font-size:13px;margin-left:6px;">${data.key || key}</code>
      </div>

      ${humanSummary}

      <div style="margin-top:10px;font-size:11px;color:var(--text-muted);display:flex;justify-content:space-between;">
        <span>HLC Clock: <code>${data.hlc_time || data.version || '0'}:${data.hlc_count || '0'}</code></span>
        <a href="javascript:void(0)" onclick="$('rawJson_${key.replace(/[^a-zA-Z0-9]/g, '')}').style.display = $('rawJson_${key.replace(/[^a-zA-Z0-9]/g, '')}').style.display === 'none' ? 'block' : 'none'" style="color:var(--accent);text-decoration:underline;">[Toggle Raw JSON]</a>
      </div>
      <pre id="rawJson_${key.replace(/[^a-zA-Z0-9]/g, '')}" style="display:none;margin-top:8px;font-size:11px;background:#05070a;border:1px solid #1e293b;padding:8px;border-radius:6px;">${JSON.stringify(data, null, 2)}</pre>
    `;
  } catch (err) {
    resultContainer.innerHTML = `<p style="color:var(--red);font-size:12px;">Query failed: ${err.message}</p>`;
  }
}

// ---------------- LIVE TELEMETRY RADAR ----------------
async function pollRegionalTelemetry() {
  try {
    const res = await fetch(`/api/records/health-check-probe?region=${REGION}`).catch(() => null);
    // Fetch direct regional health via gateway topology
    const topoRes = await fetch('/api/topology');
    if (topoRes.ok) {
      const topo = await topoRes.json();
      const myNode = topo.regions && topo.regions[REGION];
      if (myNode && myNode.details) {
        const d = myNode.details;
        const ob = d.outbox || {};
        const cb = d.circuitBreakers || {};
        const m = d.metrics || {};

        $('telemetryLatency').textContent = `${myNode.latencyMs || 1}ms`;
        
        const pendingCount = ob.pending || 0;
        $('telemetryPending').textContent = `${pendingCount}`;
        $('telemetryPending').style.color = pendingCount > 0 ? 'var(--yellow)' : 'var(--green)';

        $('telemetryDelivered').textContent = `${ob.delivered || 0}`;

        // Circuit breaker summary
        const cbStates = Object.entries(cb).map(([p, info]) => {
          const color = info.state === 'CLOSED' ? 'var(--green)' : 'var(--red)';
          return `<span style="color:${color};font-weight:700;">${p.slice(0,3).toUpperCase()}:${info.state}</span>`;
        }).join(' · ');
        $('telemetryCB').innerHTML = cbStates || '<span style="color:var(--green)">ALL HEALTHY</span>';
      }
    }
  } catch {}
}

// Initialization
document.addEventListener('DOMContentLoaded', () => {
  renderProducts();
  loadCartForUser();
  $('cacheKeyInput').value = `cart:${currentUser}`;
  queryCache();
  setInterval(pollRegionalTelemetry, 2000);
  pollRegionalTelemetry();
});
