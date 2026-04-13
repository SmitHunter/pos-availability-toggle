/**
 * POS Availability Toggle - Cloudflare Worker
 *
 * Handles two things:
 *   1. HTTP route: GET /toggle/:storeId - confirmation page, POST to confirm
 *   2. Cron trigger: nightly re-offline for all stores (DELETE→INSERT cycle)
 *
 * Secrets (set via `wrangler secret put`):
 *   REDCAT_USERNAME
 *   REDCAT_PASSWORD
 *   ADMIN_KEY
 *   TEAMS_WEBHOOK
 */

const API_URL = "https://sunrisedonuts.redcatcloud.com.au/api/v1";
const PLU_CODE = 1600;
const STORES = {
  2:  "Test HQ",
  8:  "Riverside",
  42: "Highland",
  56: "Southport",
  15: "Westgate",
  40: "Bayside",
  18: "Lakeview",
  50: "Parkside",
  9: "Greenfield",
  13: "Brookhaven",
  22: "Hillcrest",
  58: "Newbridge",
  24: "Crossroads",
  57: "Meadowvale",
  16: "Central",
  61: "Coastline",
  59: "Plaza",
  60: "Market St",
};

// ── API helpers ──────────────────────────────────────────────────────────

async function login(username, password) {
  const resp = await fetch(`${API_URL}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, psw: password, auth_type: "U" }),
  });
  if (!resp.ok) throw new Error(`Login failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.token) throw new Error("No token in login response");
  return data.token;
}

function apiHeaders(token) {
  return { "X-Redcat-Authtoken": token, "Content-Type": "application/json" };
}

async function insertRule(token, storeId, pluCode, exportMenus = true) {
  const resp = await fetch(`${API_URL}/pluavailabilityrules`, {
    method: "POST",
    headers: apiHeaders(token),
    body: JSON.stringify({
      Action: "INSERT",
      StoreID: storeId,
      PLUCode: pluCode,
      Reason: "Out of Stock",
      ExportMenus: exportMenus,
    }),
  });
  if (!resp.ok) throw new Error(`INSERT failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.success || !data.data) throw new Error(`INSERT failed: ${JSON.stringify(data)}`);
  return data.data[0]?.ID ?? null;
}

async function deleteRule(token, ruleId, exportMenus = true) {
  const resp = await fetch(`${API_URL}/pluavailabilityrules`, {
    method: "DELETE",
    headers: apiHeaders(token),
    body: JSON.stringify({ IDs: [ruleId], ExportMenus: exportMenus }),
  });
  if (!resp.ok) throw new Error(`DELETE failed: ${resp.status}`);
  const data = await resp.json();
  if (!data.success) throw new Error(`DELETE failed: ${JSON.stringify(data)}`);
}

// ── Toggle logic (POS button press) ─────────────────────────────────────

async function toggleStore(username, password, storeId) {
  const token = await login(username, password);

  // INSERT to resolve the rule ID (idempotent)
  const ruleId = await insertRule(token, storeId, PLU_CODE);
  if (!ruleId) throw new Error("Could not resolve rule ID");

  // DELETE to bring item online
  await deleteRule(token, ruleId);

  return { success: true, storeId, ruleId };
}

// ── Re-offline logic (nightly cron) ─────────────────────────────────────

async function reofflineStore(token, storeId, kvStore) {
  // 1. INSERT to get rule ID (no export)
  const ruleId = await insertRule(token, storeId, PLU_CODE, false);
  if (!ruleId) throw new Error(`No rule ID for store ${storeId}`);

  // 2. DELETE without export
  await deleteRule(token, ruleId, false);

  // 3. Fresh INSERT with export to trigger third-party updates
  const newRuleId = await insertRule(token, storeId, PLU_CODE, true);

  // Update live status
  await kvStore.put(`status:${storeId}`, "offline");
  return newRuleId;
}

async function reofflineAll(username, password, kvStore) {
  const token = await login(username, password);
  const results = [];

  for (const storeId of Object.keys(STORES).map(Number)) {
    try {
      const ruleId = await reofflineStore(token, storeId, kvStore);
      results.push({ storeId, status: "ok", ruleId });
    } catch (e) {
      results.push({ storeId, status: "failed", error: e.message });
    }
  }
  return results;
}

// ── Audit logging ───────────────────────────────────────────────────────

async function logAudit(kvStore, entry) {
  const key = `log:${entry.timestamp}:${entry.storeId}`;
  await kvStore.put(key, JSON.stringify(entry), { expirationTtl: 60 * 60 * 24 * 90 }); // keep 90 days
}

async function getAuditLogs(kvStore, limit = 1000) {
  const list = await kvStore.list({ prefix: "log:", limit });
  const values = await Promise.all(list.keys.map(k => kvStore.get(k.name)));
  return values.filter(Boolean).map(v => JSON.parse(v)).reverse(); // newest first
}

// ── Security helpers ────────────────────────────────────────────────────

function secureHeaders(extra = {}) {
  return {
    "Content-Type": "text/html;charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; " +
      "img-src 'self' data:; " +
      "script-src 'unsafe-inline'; " +
      "connect-src 'self'; " +
      "frame-ancestors 'none';",
    ...extra,
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function timingSafeEqual(a, b) {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) {
    // Burn time to avoid length-based timing leak, then return false
    await crypto.subtle.timingSafeEqual(aBytes, new Uint8Array(aBytes.byteLength));
    return false;
  }
  return await crypto.subtle.timingSafeEqual(aBytes, bBytes);
}

async function checkAdminRateLimit(env, ip) {
  const key = `ratelimit:admin:${ip}`;
  const raw = await env.AUDIT_LOG.get(key);
  const attempts = raw ? parseInt(raw, 10) : 0;
  if (attempts >= 10) {
    return new Response("Too many attempts. Try again in 15 minutes.", {
      status: 429,
      headers: { "Retry-After": "900", "Content-Type": "text/plain" },
    });
  }
  await env.AUDIT_LOG.put(key, String(attempts + 1), { expirationTtl: 900 });
  return null;
}

async function verifyAdminRequest(request, env, url) {
  // 1. Valid session cookie - authorized immediately, no rate limit needed
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)admin_session=([^;]+)/);
  if (cookieMatch) {
    const sessionKey = decodeURIComponent(cookieMatch[1]);
    if (await timingSafeEqual(sessionKey, env.ADMIN_KEY)) {
      return null; // authorized
    }
  }

  // 2. A password was submitted - rate limit only on actual attempts
  const paramKey = url.searchParams.get("key");
  if (paramKey !== null) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const kvKey = `ratelimit:admin:${ip}`;
    const raw = await env.AUDIT_LOG.get(kvKey);
    const attempts = raw ? parseInt(raw, 10) : 0;
    if (attempts >= 10) {
      return new Response("Too many login attempts. Try again in 15 minutes.", {
        status: 429,
        headers: { "Retry-After": "900", "Content-Type": "text/plain" },
      });
    }
    if (await timingSafeEqual(paramKey, env.ADMIN_KEY)) {
      // Correct - redirect to strip key from URL and set session cookie
      const cleanUrl = new URL(url.toString());
      cleanUrl.searchParams.delete("key");
      return new Response(null, {
        status: 302,
        headers: {
          "Location": cleanUrl.toString(),
          "Set-Cookie":
            `admin_session=${encodeURIComponent(env.ADMIN_KEY)}; ` +
            `Max-Age=3600; Path=/admin; HttpOnly; Secure; SameSite=Strict`,
        },
      });
    }
    // Wrong password - increment counter, fall through to show login form with error
    await env.AUDIT_LOG.put(kvKey, String(attempts + 1), { expirationTtl: 900 });
  }
  // 3. No valid auth - show login form
  const destination = url.pathname;
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${FONT_LINK}
  <title>Admin Login</title>
  <style>
    ${BASE_STYLES}
    h1 { color: #F97316; }
    .input-wrap { margin-top: 20px; }
    input[type=password] {
      width: 100%; padding: 13px 16px;
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 10px; color: #fff; font-size: 16px;
      outline: none; transition: border-color 150ms;
      box-sizing: border-box;
    }
    input[type=password]:focus { border-color: rgba(243,156,18,0.5); }
    .btn-login {
      display: block; width: 100%; margin-top: 12px;
      padding: 14px; background: #F97316; color: #fff;
      border: none; border-radius: 10px; font-size: 16px;
      font-weight: 700; cursor: pointer; transition: background 150ms;
      -webkit-tap-highlight-color: transparent;
    }
    .btn-login:hover { background: #e8691a; }
    .error-msg { color: #e74c3c; font-size: 14px; margin-top: 10px; }
  </style>
</head>
<body>
  ${NOISE_TAG}
  <div class="card">
    <div class="icon"><img src="/logo.png" alt="Sunrise Donuts"></div>
    <h1>Admin Login</h1>
    <p>Enter the admin password to continue.</p>
    ${paramKey !== null ? '<p class="error-msg">Incorrect password. Try again.</p>' : ''}
    <form method="GET" action="${destination}" class="input-wrap">
      <input type="password" name="key" placeholder="Password" autofocus autocomplete="current-password">
      <button type="submit" class="btn-login">Sign In</button>
    </form>
  </div>
</body>
</html>`,
    { status: 401, headers: secureHeaders() }
  );
}

// ── Teams notifications ─────────────────────────────────────────────────

async function sendTeamsAlert(env, title, message, isError = false) {
  const color = isError ? "FF0000" : "27ae60";
  try {
    await fetch(env.TEAMS_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        themeColor: color,
        summary: title,
        sections: [{
          activityTitle: title,
          text: message,
          markdown: true,
        }],
      }),
    });
  } catch (e) {
    console.error("Teams webhook failed:", e.message);
  }
}

// ── HTML helpers ────────────────────────────────────────────────────────

const NOISE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0"><filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/><feColorMatrix type="saturate" values="0"/><feBlend in="SourceGraphic" mode="multiply" result="blend"/><feComponentTransfer><feFuncA type="linear" slope="0.08"/></feComponentTransfer></filter></svg>`;

const FONT_LINK = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&display=swap" rel="stylesheet">`;

const BASE_STYLES = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #F1F0DE;
    color: #fff;
    display: flex;
    justify-content: center;
    align-items: flex-start;
    padding: 16px 0;
    min-height: 100vh;
    position: relative;
  }
  body::after {
    content: "";
    position: fixed;
    inset: 0;
    filter: url(#grain);
    pointer-events: none;
    z-index: 1;
  }
  @keyframes cardIn {
    from { opacity: 0; transform: translateY(12px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
  @keyframes float {
    0%, 100% { transform: translateY(0); }
    50% { transform: translateY(-6px); }
  }
  .card {
    position: relative;
    z-index: 2;
    background: radial-gradient(ellipse at 50% 0%, #1e2d4a 0%, #162038 50%, #111a2e 100%);
    border: 1px solid rgba(243, 156, 18, 0.1);
    border-radius: 20px;
    padding: 28px 32px;
    text-align: center;
    width: 100%;
    max-width: 420px;
    margin: 0 16px;
    box-shadow:
      0 4px 24px rgba(243, 156, 18, 0.08),
      0 8px 48px rgba(0, 0, 0, 0.4),
      inset 0 1px 0 rgba(255, 255, 255, 0.04);
    animation: cardIn 400ms ease both;
  }
  @media (max-width: 480px) {
    .card { padding: 20px 16px; border-radius: 16px; }
  }
  .icon {
    margin-bottom: 8px;
    display: block;
    text-align: center;
    animation: none;
  }
  .icon img {
    width: 120px;
    height: auto;
  }
  h1 { font-family: 'Syne', system-ui, sans-serif; font-weight: 700; margin-bottom: 6px; font-size: 20px; }
  h2 { font-family: 'Syne', system-ui, sans-serif; font-weight: 700; }
  p { color: #9ca3b8; font-size: 14px; line-height: 1.4; }
`;

const NOISE_TAG = '<div style="display:none">' + NOISE_SVG + '</div>';

function confirmPage(storeName, storeId) {
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${FONT_LINK}
  <title>Confirm - ${storeName}</title>
  <style>
    ${BASE_STYLES}
    h1 { color: #f39c12; }
    .store-name {
      color: #9ca3b8;
      font-family: 'Syne', system-ui, sans-serif;
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      margin-bottom: 6px;
    }
    .btn {
      display: block;
      width: 100%;
      min-height: 48px;
      margin-top: 10px;
      padding: 12px 24px;
      color: #fff;
      border: none;
      border-radius: 12px;
      font-size: 18px;
      font-weight: 600;
      cursor: pointer;
      transition: all 150ms ease;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .btn-yes { background: #27ae60; position: relative; }
    .btn-yes:hover { background: #2ecc71; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(39,174,96,0.3); }
    .btn-yes:active { background: #1e8449; transform: translateY(0); }
    .btn-yes.loading {
      pointer-events: none;
      background: #1e8449;
      color: transparent;
    }
    .btn-yes.loading::after {
      content: "";
      position: absolute;
      top: 50%; left: 50%;
      width: 22px; height: 22px;
      margin: -11px 0 0 -11px;
      border: 3px solid rgba(255,255,255,0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 600ms linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    @keyframes checkPop {
      0% { transform: scale(0); opacity: 0; }
      50% { transform: scale(1.2); }
      100% { transform: scale(1); opacity: 1; }
    }
    .btn-close {
      background: transparent; margin-top: 8px;
      color: #9ca3b8;
      border: 1px solid rgba(156, 163, 184, 0.25);
    }
    .btn-close:hover { color: #fff; border-color: rgba(255, 255, 255, 0.3); background: rgba(255,255,255,0.04); }
    .btn-close:active { background: rgba(255,255,255,0.06); }
    .buttons { margin-top: 14px; }
    .result-state { display: none; }
    .result-state .result-icon {
      font-size: 56px;
      animation: checkPop 400ms ease both;
    }
    .result-state h2 {
      color: #27ae60;
      font-size: 22px;
      margin: 12px 0 8px;
      animation: fadeIn 300ms ease 150ms both;
    }
    .result-state p {
      animation: fadeIn 300ms ease 250ms both;
    }
    .result-state .btn-close {
      animation: fadeIn 300ms ease 350ms both;
    }
    .error-state h2 { color: #e74c3c; }
  </style>
</head>
<body>
  ${NOISE_TAG}
  <div class="card">
    <div id="confirm-state">
      <div class="icon"><img src="/logo.png" alt="Sunrise Donuts"></div>
      <div class="store-name">${storeName}</div>
      <h1>Make Daily Special Available?</h1>
      <p>This will make the item available for ordering. It will automatically go offline again at midnight.</p>
      <div class="buttons">
        <button type="button" id="yes-btn" class="btn btn-yes" onclick="doToggle()">Yes, Make Available</button>
        <a href="/toggle" class="btn btn-close" style="text-decoration:none;text-align:center;">Back</a>
      </div>
    </div>
    <div id="success-state" class="result-state">
      <div class="result-icon">&#10004;</div>
      <h2>Item is now AVAILABLE!</h2>
      <p>${storeName} - Daily Special is online.<br>Will be made inactive at 12:00 AM.</p>
      <button class="btn btn-close" style="margin-top:24px;" onclick="window.open('','_self').close();">Close</button>
    </div>
    <div id="error-state" class="result-state error-state">
      <div class="result-icon">&#10060;</div>
      <h2>Something went wrong</h2>
      <p id="error-msg">Contact IT.</p>
      <button class="btn btn-close" style="margin-top:24px;" onclick="window.open('','_self').close();">Close</button>
    </div>
  </div>
  <script>
    function doToggle() {
      var btn = document.getElementById('yes-btn');
      btn.classList.add('loading');
      btn.textContent = '';

      fetch(window.location.pathname, { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          document.getElementById('confirm-state').style.display = 'none';
          if (data.success) {
            document.getElementById('success-state').style.display = 'block';
          } else if (data.rateLimited) {
            document.getElementById('error-state').querySelector('h2').textContent = 'Already Active';
            document.getElementById('error-msg').textContent = data.error || 'Try again soon.';
            document.getElementById('error-state').style.display = 'block';
          } else {
            document.getElementById('error-msg').textContent = data.error || 'Contact IT.';
            document.getElementById('error-state').style.display = 'block';
          }
        })
        .catch(function() {
          document.getElementById('confirm-state').style.display = 'none';
          document.getElementById('error-msg').textContent = 'Contact IT.';
          document.getElementById('error-state').style.display = 'block';
        });
    }
  </script>
</body>
</html>`,
    { status: 200, headers: secureHeaders() }
  );
}

function resultPage(title, message, isError = false) {
  const color = isError ? "#e74c3c" : "#27ae60";
  const icon = isError ? "&#10060;" : "&#10004;";
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${FONT_LINK}
  <title>${title}</title>
  <style>
    ${BASE_STYLES}
    h1 { color: ${color}; }
    .icon { animation: fadeIn 300ms ease both; }
    h1 { animation: fadeIn 300ms ease 100ms both; }
    p { animation: fadeIn 300ms ease 200ms both; }
    .btn-close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 56px;
      margin-top: 24px;
      padding: 16px 24px;
      background: transparent;
      color: #9ca3b8;
      border: 1px solid rgba(156, 163, 184, 0.25);
      border-radius: 12px;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      transition: all 150ms ease;
      animation: fadeIn 300ms ease 300ms both;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .btn-close:hover { color: #fff; border-color: rgba(255, 255, 255, 0.3); background: rgba(255,255,255,0.04); }
  </style>
</head>
<body>
  ${NOISE_TAG}
  <div class="card">
    <div class="icon">${icon}</div>
    <h1>${title}</h1>
    <p>${message}</p>
    <button class="btn-close" onclick="window.open('','_self').close();">Close</button>
  </div>
</body>
</html>`,
    { status: isError ? 500 : 200, headers: secureHeaders() }
  );
}

async function storePickerPage(kvStore) {
  const storeEntries = Object.entries(STORES)
    .filter(([id]) => id !== "2");

  // Load live status for all displayed stores in parallel
  const statusValues = await Promise.all(
    storeEntries.map(([id]) => kvStore.get(`status:${id}`))
  );
  const liveSet = new Set(
    storeEntries
      .filter((_, i) => statusValues[i] === "online")
      .map(([id]) => id)
  );

  const storeButtons = storeEntries
    .map(([id, name], i) => {
      const dot = liveSet.has(id) ? '<span class="live-dot"></span>' : '';
      return `<a href="/toggle/${id}" class="store-btn" style="animation-delay:${150 + i * 50}ms">${dot}${escapeHtml(name)}</a>`;
    })
    .join("\n      ");

  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${FONT_LINK}
  <title>Select Your Store</title>
  <style>
    ${BASE_STYLES}
    .card { max-width: 720px; }
    h1 { color: #f39c12; margin-bottom: 4px; }
    @media (max-width: 600px) { .stores { grid-template-columns: repeat(2, 1fr); } }
    @media (max-width: 380px) { .stores { grid-template-columns: 1fr; } }
    .store-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 44px;
      margin-top: 0;
      padding: 10px 8px;
      background: rgba(30, 58, 95, 0.5);
      color: #fff;
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-left: 3px solid transparent;
      border-radius: 10px;
      font-size: 16px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      text-align: center;
      transition: all 150ms ease;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      animation: fadeIn 300ms ease both;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .store-btn:hover {
      background: rgba(40, 72, 115, 0.6);
      border-left: 3px solid #F97316;
      box-shadow: 0 4px 16px rgba(0,0,0,0.25);
      transform: translateY(-1px);
    }
    .store-btn:active {
      background: rgba(35, 62, 100, 0.7);
      transform: translateY(0);
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    }
    .stores { margin-top: 12px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
    .live-dot {
      display: inline-block;
      width: 8px; height: 8px;
      background: #27ae60;
      border-radius: 50%;
      margin-right: 6px;
      box-shadow: 0 0 6px rgba(39,174,96,0.8);
      flex-shrink: 0;
    }
    .admin-bar { display: flex; justify-content: flex-end; margin-bottom: 4px; }
    .admin-link {
      font-size: 11px;
      color: rgba(156,163,184,0.4);
      text-decoration: none;
      padding: 3px 8px;
      border-radius: 6px;
      transition: color 150ms;
    }
    .admin-link:hover { color: #9ca3b8; }
    .btn-close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 44px;
      margin-top: 12px;
      padding: 10px 24px;
      background: transparent;
      color: #9ca3b8;
      border: 1px solid rgba(156, 163, 184, 0.25);
      border-radius: 10px;
      font-size: 15px;
      font-weight: 500;
      cursor: pointer;
      transition: all 150ms ease;
      animation: fadeIn 300ms ease ${150 + storeEntries.length * 50 + 50}ms both;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .btn-close:hover { color: #fff; border-color: rgba(255, 255, 255, 0.3); background: rgba(255,255,255,0.04); }
  </style>
</head>
<body>
  ${NOISE_TAG}
  <div class="card">
    <div class="admin-bar"><a href="/admin" class="admin-link">⚙ Admin</a></div>
    <div class="icon"><img src="/logo.png" alt="Sunrise Donuts"></div>
    <h1>Daily Special</h1>
    <p>Select your store to make the Daily Special available.</p>
    <div class="stores">
      ${storeButtons}
    </div>
    <button class="btn-close" onclick="window.open('','_self').close();">Close</button>
  </div>
</body>
</html>`,
    { status: 200, headers: secureHeaders() }
  );
}

function adminPage(logs, storeStatuses) {
  // Build store cards HTML (all stores including Test HQ)
  const storeCards = Object.entries(STORES).map(([id, name]) => {
    const isLive = storeStatuses[id] === "online";
    const badge = isLive
      ? '<span class="status-badge live">&#9679; LIVE</span>'
      : '<span class="status-badge offline">&#9679; OFFLINE</span>';
    return `<div class="store-card" id="sc-${id}">
      <div class="store-card-info">
        <span class="store-card-name">${escapeHtml(name)}</span>
        ${badge}
      </div>
      <div class="store-card-actions">
        <button class="btn-activate" onclick="activateSingle(${id}, this)"${isLive ? ' disabled' : ''}>Activate</button>
        <button class="btn-reoffline" onclick="reofflineSingle(${id}, this)"${!isLive ? ' disabled' : ''}>Re-offline</button>
      </div>
    </div>`;
  }).join("\n");

  // Build log rows and collect unique stores/actions for filters
  const storeNames = [...new Set(logs.map(l => escapeHtml(l.storeName || String(l.storeId))))].sort();
  const actionMap = { toggle_online: "Made Available", cron_reoffline: "Cron Re-offline", admin_reoffline: "Admin Re-offline", admin_toggle_online: "Admin Activate" };
  const storeOptions = storeNames.map(s => `<option value="${s}">${s}</option>`).join("");

  const logRows = logs.length === 0
    ? '<tr><td colspan="4" style="text-align:center;color:#555;padding:24px;">No logs yet.</td></tr>'
    : logs.map((l) => {
      const date = new Date(l.timestamp);
      const timeStr = date.toLocaleString("en-AU", { timeZone: "Australia/Melbourne", hour12: true });
      const ok = l.success ? "&#9679;" : "&#9679;";
      const okColor = l.success ? "#27ae60" : "#e74c3c";
      const action = actionMap[l.action] || l.action;
      const store = escapeHtml(l.storeName || String(l.storeId));
      return `<tr data-store="${store}" data-action="${l.action}">
        <td>${timeStr}</td>
        <td>${store}</td>
        <td>${action}</td>
        <td><span style="color:${okColor}">${ok}</span></td>
      </tr>`;
    }).join("");

  // Embed log data for CSV export
  const csvData = JSON.stringify(logs.map(l => ({
    time: new Date(l.timestamp).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", hour12: true }),
    store: l.storeName || String(l.storeId),
    action: actionMap[l.action] || l.action,
    status: l.success ? "OK" : "FAILED",
  })));

  // Analytics: per-store activation counts from existing logs
  const toggleLogs = logs.filter(l => l.action === "toggle_online" || l.action === "admin_toggle_online");
  const nowMs = Date.now();
  const analytics = Object.entries(STORES).map(([id, name]) => {
    const sl = toggleLogs.filter(l => String(l.storeId) === id);
    const lastLog = sl[0]; // logs already newest-first
    return {
      id, name,
      total: sl.length,
      week: sl.filter(l => nowMs - new Date(l.timestamp).getTime() < 7 * 864e5).length,
      month: sl.filter(l => nowMs - new Date(l.timestamp).getTime() < 30 * 864e5).length,
      last: lastLog ? new Date(lastLog.timestamp).toLocaleString("en-AU", { timeZone: "Australia/Melbourne", hour12: true }) : "Never",
    };
  }).sort((a, b) => b.total - a.total);

  const analyticsRows = analytics.map(r =>
    `<tr><td>${escapeHtml(r.name)}</td><td>${r.total}</td><td>${r.week}</td><td>${r.month}</td><td style="font-size:11px;">${escapeHtml(r.last)}</td></tr>`
  ).join("");
  const analyticsData = JSON.stringify(analytics.map(r => ({ store: r.name, total: r.total, week: r.week, month: r.month, last: r.last })));

  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${FONT_LINK}
  <title>Admin Panel</title>
  <style>
    ${BASE_STYLES}
    body { align-items: flex-start; padding: 12px 0; }
    .card { max-width: 960px; padding: 18px 24px; }
    .admin-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 12px;
    }
    .admin-header h1 { margin-bottom: 0; color: #F97316; font-size: 20px; }
    .back-link {
      font-size: 12px; color: #9ca3b8; text-decoration: none;
      padding: 5px 10px; border: 1px solid rgba(156,163,184,0.2);
      border-radius: 8px; transition: all 150ms;
    }
    .back-link:hover { color: #fff; border-color: rgba(255,255,255,0.3); }
    .tabs { display: flex; gap: 4px; margin-bottom: 12px; border-bottom: 1px solid rgba(255,255,255,0.06); }
    .tab {
      padding: 6px 16px; background: none; border: none; border-bottom: 2px solid transparent;
      color: #9ca3b8; font-size: 13px; font-weight: 600; cursor: pointer;
      transition: all 150ms; margin-bottom: -1px;
    }
    .tab.active { color: #F97316; border-bottom-color: #F97316; }
    .tab:hover:not(.active) { color: #fff; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .stores-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
      gap: 8px;
      margin-bottom: 10px;
    }
    .store-card {
      background: rgba(255,255,255,0.03);
      border: 1px solid rgba(255,255,255,0.06);
      border-radius: 8px;
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .store-card-info { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
    .store-card-name { font-size: 13px; font-weight: 600; }
    .status-badge { font-size: 10px; font-weight: 700; white-space: nowrap; }
    .status-badge.live { color: #27ae60; }
    .status-badge.offline { color: #555; }
    .store-card-actions { display: flex; gap: 6px; }
    .btn-activate {
      flex: 1; padding: 5px 0; background: rgba(249,115,22,0.12);
      border: 1px solid rgba(249,115,22,0.25); border-radius: 6px;
      color: #F97316; font-size: 11px; font-weight: 600; cursor: pointer;
      transition: all 150ms; -webkit-tap-highlight-color: transparent;
    }
    .btn-activate:hover { background: rgba(249,115,22,0.22); }
    .btn-activate:disabled { opacity: 0.35; cursor: default; }
    .btn-reoffline {
      flex: 1; padding: 5px 0; background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08); border-radius: 6px;
      color: #9ca3b8; font-size: 11px; font-weight: 600; cursor: pointer;
      transition: all 150ms; -webkit-tap-highlight-color: transparent;
    }
    .btn-reoffline:hover { background: rgba(255,255,255,0.08); color: #fff; }
    .btn-reoffline:disabled { opacity: 0.35; cursor: default; }
    .btn-reoffline-all {
      width: 100%; padding: 10px; background: rgba(231,76,60,0.15);
      border: 1px solid rgba(231,76,60,0.3); border-radius: 8px;
      color: #e74c3c; font-size: 13px; font-weight: 600; cursor: pointer;
      transition: all 150ms; margin-top: 2px;
    }
    .btn-reoffline-all:hover { background: rgba(231,76,60,0.25); }
    .filters {
      display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
      margin-bottom: 10px;
    }
    .filters select {
      background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.1);
      border-radius: 8px; color: #ccc; padding: 7px 12px; font-size: 13px; cursor: pointer;
    }
    .btn-csv {
      padding: 7px 14px; background: rgba(243,156,18,0.15);
      border: 1px solid rgba(243,156,18,0.3); border-radius: 8px;
      color: #f39c12; font-size: 13px; font-weight: 600; cursor: pointer;
      transition: all 150ms; margin-left: auto;
    }
    .btn-csv:hover { background: rgba(243,156,18,0.25); }
    table { width: 100%; border-collapse: collapse; }
    th {
      font-family: 'Syne', system-ui, sans-serif; text-align: center;
      padding: 7px 10px; color: #9ca3b8; font-size: 11px;
      text-transform: uppercase; letter-spacing: 0.1em;
      border-bottom: 1px solid rgba(255,255,255,0.06);
    }
    td { padding: 7px 10px; font-size: 13px; color: #ccc; border-bottom: 1px solid rgba(255,255,255,0.03); text-align: center; }
    tr:hover td { background: rgba(255,255,255,0.02); }
    tr.hidden { display: none; }
  </style>
</head>
<body>
  ${NOISE_TAG}
  <div class="card">
    <div class="admin-header">
      <h1>&#9881; Admin Panel</h1>
      <a href="/toggle" class="back-link">&#8592; Store Picker</a>
    </div>

    <div class="tabs">
      <button class="tab active" onclick="switchTab('stores', this)">Stores</button>
      <button class="tab" onclick="switchTab('logs', this)">Audit Log</button>
      <button class="tab" onclick="switchTab('analytics', this)">Analytics</button>
    </div>

    <div id="tab-stores" class="tab-content active">
      <div class="stores-grid">
        ${storeCards}
      </div>
      <button class="btn-reoffline-all" onclick="showReofflineConfirm()">
        Re-offline All Stores
      </button>
    </div>

    <div id="reoffline-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;display:none;align-items:center;justify-content:center;">
      <div style="background:#1e2d4a;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:28px 32px;max-width:340px;width:90%;text-align:center;">
        <p style="color:#fff;font-size:15px;font-weight:600;margin:0 0 6px;">Re-offline All Stores?</p>
        <p style="color:#9ca3b8;font-size:13px;margin:0 0 20px;">This will push all stores offline immediately.</p>
        <div style="display:flex;gap:10px;">
          <button id="reoffline-cancel-btn" onclick="cancelReofflineConfirm()" style="flex:1;padding:10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:8px;color:#ccc;font-size:13px;font-weight:600;cursor:pointer;">Cancel</button>
          <button id="reoffline-confirm-btn" disabled onclick="executeReofflineAll()" style="flex:1;padding:10px;background:rgba(231,76,60,0.2);border:1px solid rgba(231,76,60,0.4);border-radius:8px;color:#e74c3c;font-size:13px;font-weight:600;cursor:pointer;opacity:0.5;">Confirm (<span id="reoffline-countdown">5</span>)</button>
        </div>
      </div>
    </div>

    <div id="tab-logs" class="tab-content">
      <div class="filters">
        <select id="filter-store" onchange="filterLogs()">
          <option value="">All stores</option>
          ${storeOptions}
        </select>
        <select id="filter-action" onchange="filterLogs()">
          <option value="">All actions</option>
          <option value="toggle_online">Made Available</option>
          <option value="admin_toggle_online">Admin Activate</option>
          <option value="cron_reoffline">Cron Re-offline</option>
          <option value="admin_reoffline">Admin Re-offline</option>
        </select>
        <button class="btn-csv" onclick="exportCSV()">&#8595; Export CSV</button>
      </div>
      <table id="log-table">
        <thead>
          <tr><th>Time</th><th>Store</th><th>Action</th><th>Status</th></tr>
        </thead>
        <tbody>
          ${logRows}
        </tbody>
      </table>
    </div>

    <div id="tab-analytics" class="tab-content">
      <div class="filters">
        <button class="btn-csv" onclick="exportAnalyticsCSV()">&#8595; Export CSV</button>
      </div>
      <table id="analytics-table">
        <thead>
          <tr><th>Store</th><th>Total</th><th>This Week</th><th>This Month</th><th>Last Activated</th></tr>
        </thead>
        <tbody>
          ${analyticsRows}
        </tbody>
      </table>
    </div>
  </div>
  <script>
    var CSV_DATA = ${csvData};
    var ANALYTICS_DATA = ${analyticsData};

    function switchTab(name, btn) {
      document.querySelectorAll('.tab-content').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      document.getElementById('tab-' + name).classList.add('active');
      btn.classList.add('active');
    }

    function filterLogs() {
      var store = document.getElementById('filter-store').value;
      var action = document.getElementById('filter-action').value;
      document.querySelectorAll('#log-table tbody tr').forEach(function(row) {
        var storeMatch = !store || row.dataset.store === store;
        var actionMatch = !action || row.dataset.action === action;
        row.classList.toggle('hidden', !(storeMatch && actionMatch));
      });
    }

    function exportCSV() {
      var headers = ['Time','Store','Action','Status'];
      var rows = CSV_DATA.map(function(r) {
        return [r.time, r.store, r.action, r.status, r.ip].map(function(v) {
          return '"' + String(v).replace(/"/g, '""') + '"';
        }).join(',');
      });
      var csv = [headers.join(',')].concat(rows).join('\\n');
      var a = document.createElement('a');
      a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
      a.download = 'audit-log-' + new Date().toISOString().slice(0,10) + '.csv';
      a.click();
    }

    function exportAnalyticsCSV() {
      var headers = ['Store','Total','This Week','This Month','Last Activated'];
      var rows = ANALYTICS_DATA.map(function(r) {
        return [r.store, r.total, r.week, r.month, r.last].map(function(v) {
          return '"' + String(v).replace(/"/g, '""') + '"';
        }).join(',');
      });
      var csv = [headers.join(',')].concat(rows).join('\\n');
      var a = document.createElement('a');
      a.href = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv);
      a.download = 'analytics-' + new Date().toISOString().slice(0,10) + '.csv';
      a.click();
    }

    function reofflineSingle(storeId, btn) {
      btn.disabled = true;
      btn.textContent = 'Working...';
      fetch('/admin/reoffline/' + storeId, { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) {
            btn.textContent = 'Re-offline';
            var card = document.getElementById('sc-' + storeId);
            var badge = card.querySelector('.status-badge');
            badge.className = 'status-badge offline';
            badge.innerHTML = '&#9679; OFFLINE';
            var actBtn = card.querySelector('.btn-activate');
            if (actBtn) { actBtn.disabled = false; }
          } else {
            btn.textContent = 'Failed';
            btn.disabled = false;
          }
        })
        .catch(function() {
          btn.textContent = 'Error';
          btn.disabled = false;
        });
    }

    function activateSingle(storeId, btn) {
      btn.disabled = true;
      btn.textContent = 'Working...';
      fetch('/admin/activate/' + storeId, { method: 'POST' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success) {
            btn.textContent = 'Activate';
            var card = document.getElementById('sc-' + storeId);
            var badge = card.querySelector('.status-badge');
            badge.className = 'status-badge live';
            badge.innerHTML = '&#9679; LIVE';
            var reoffBtn = card.querySelector('.btn-reoffline');
            if (reoffBtn) { reoffBtn.disabled = false; }
          } else {
            btn.textContent = 'Failed';
            btn.disabled = false;
          }
        })
        .catch(function() {
          btn.textContent = 'Error';
          btn.disabled = false;
        });
    }

    var _reofflineTimer = null;
    function showReofflineConfirm() {
      var modal = document.getElementById('reoffline-modal');
      modal.style.display = 'flex';
      var countdown = 5;
      var countEl = document.getElementById('reoffline-countdown');
      var confirmBtn = document.getElementById('reoffline-confirm-btn');
      countEl.textContent = countdown;
      confirmBtn.disabled = true;
      confirmBtn.style.opacity = '0.5';
      confirmBtn.textContent = 'Confirm (' + countdown + ')';
      _reofflineTimer = setInterval(function() {
        countdown--;
        if (countdown > 0) {
          confirmBtn.textContent = 'Confirm (' + countdown + ')';
        } else {
          clearInterval(_reofflineTimer);
          confirmBtn.disabled = false;
          confirmBtn.style.opacity = '1';
          confirmBtn.textContent = 'Confirm';
        }
      }, 1000);
    }
    function cancelReofflineConfirm() {
      clearInterval(_reofflineTimer);
      document.getElementById('reoffline-modal').style.display = 'none';
    }
    function executeReofflineAll() {
      clearInterval(_reofflineTimer);
      document.getElementById('reoffline-modal').style.display = 'none';
      window.location = '/admin/reoffline';
    }
  </script>
</body>
</html>`,
    { status: 200, headers: secureHeaders() }
  );
}

function closedPage() {
  return new Response(
    `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${FONT_LINK}
  <title>All done!</title>
  <style>
    ${BASE_STYLES}
    h1 { color: #F97316; }
    .btn-close {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
      min-height: 56px;
      margin-top: 24px;
      padding: 16px 24px;
      background: transparent;
      color: #9ca3b8;
      border: 1px solid rgba(156, 163, 184, 0.25);
      border-radius: 12px;
      font-size: 16px;
      font-weight: 500;
      cursor: pointer;
      transition: all 150ms ease;
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    .btn-close:hover { color: #fff; border-color: rgba(255, 255, 255, 0.3); background: rgba(255,255,255,0.04); }
    .btn-close:disabled {
      cursor: default;
      color: #555;
      border-color: rgba(85, 85, 85, 0.25);
    }
  </style>
</head>
<body>
  ${NOISE_TAG}
  <div class="card">
    <div class="icon"><img src="/logo.png" alt="Sunrise Donuts"></div>
    <h1>All done!</h1>
    <p>You can close this tab.</p>
    <button class="btn-close" id="close-btn" onclick="window.open('','_self').close(); var b=document.getElementById('close-btn'); b.disabled=true; b.textContent='Tab can be closed';">Close</button>
  </div>
</body>
</html>`,
    { status: 200, headers: secureHeaders() }
  );
}

// ── Request handler ─────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Serve logo from KV
    if (path === "/logo.png") {
      const logo = await env.AUDIT_LOG.get("logo.png", { type: "arrayBuffer" });
      if (logo) {
        return new Response(logo, {
          headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000" },
        });
      }
    }

    // Closed page: server-rendered "you can close this tab" page
    if (path === "/closed") {
      return closedPage();
    }

    // Admin dashboard
    if (path === "/admin") {
      const authResult = await verifyAdminRequest(request, env, url);
      if (authResult !== null) return authResult;
      const [logs, statusPairs] = await Promise.all([
        getAuditLogs(env.AUDIT_LOG),
        Promise.all(Object.keys(STORES).map(async (id) => [id, await env.AUDIT_LOG.get(`status:${id}`)])),
      ]);
      return adminPage(logs, Object.fromEntries(statusPairs));
    }

    // Admin route: per-store re-offline
    const adminStoreMatch = path.match(/^\/admin\/reoffline\/(\d+)$/);
    if (adminStoreMatch) {
      const authResult = await verifyAdminRequest(request, env, url);
      if (authResult !== null) return authResult;
      const sid = parseInt(adminStoreMatch[1], 10);
      if (!STORES[sid]) {
        return new Response(JSON.stringify({ error: "Unknown store" }), { status: 404, headers: { "Content-Type": "application/json" } });
      }
      try {
        const token = await login(env.REDCAT_USERNAME, env.REDCAT_PASSWORD);
        await reofflineStore(token, sid, env.AUDIT_LOG);
        await logAudit(env.AUDIT_LOG, {
          timestamp: new Date().toISOString(),
          action: "admin_reoffline",
          storeId: sid,
          storeName: STORES[sid],
          ip: request.headers.get("CF-Connecting-IP") || "unknown",
          success: true,
        });
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        console.error("Admin reoffline error store", sid, ":", e.message);
        return new Response(JSON.stringify({ success: false, error: "Re-offline failed. Contact IT." }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // Admin route: activate a single store
    const adminActivateMatch = path.match(/^\/admin\/activate\/(\d+)$/);
    if (adminActivateMatch) {
      const authResult = await verifyAdminRequest(request, env, url);
      if (authResult !== null) return authResult;
      const sid = parseInt(adminActivateMatch[1], 10);
      if (!STORES[sid]) {
        return new Response(JSON.stringify({ error: "Unknown store" }), { status: 404, headers: { "Content-Type": "application/json" } });
      }
      try {
        await toggleStore(env.REDCAT_USERNAME, env.REDCAT_PASSWORD, sid);
        await env.AUDIT_LOG.put(`status:${sid}`, "online");
        const timestamp = new Date().toISOString();
        await logAudit(env.AUDIT_LOG, {
          timestamp,
          action: "admin_toggle_online",
          storeId: sid,
          storeName: STORES[sid],
          ip: request.headers.get("CF-Connecting-IP") || "unknown",
          success: true,
        });
        await sendTeamsAlert(env, `\u{1F369} Daily Special - Activated by Admin`, `**${STORES[sid]}** was made available via the admin panel.\n\nIt will go offline again at midnight.`, "#F97316");
        return new Response(JSON.stringify({ success: true }), { headers: { "Content-Type": "application/json" } });
      } catch (e) {
        console.error("Admin activate error store", sid, ":", e.message);
        return new Response(JSON.stringify({ success: false, error: "Activation failed. Contact IT." }), { status: 500, headers: { "Content-Type": "application/json" } });
      }
    }

    // Legacy redirect: /admin/logs → /admin
    if (path === "/admin/logs") {
      return new Response(null, { status: 302, headers: { "Location": "/admin" } });
    }

    // Admin route: manually trigger re-offline for all stores
    if (path === "/admin/reoffline") {
      const authResult = await verifyAdminRequest(request, env, url);
      if (authResult !== null) return authResult;
      try {
        const results = await reofflineAll(env.REDCAT_USERNAME, env.REDCAT_PASSWORD, env.AUDIT_LOG);
        const failures = results.filter((r) => r.status === "failed");
        const summary = results.map((r) =>
          `${escapeHtml(STORES[r.storeId] || String(r.storeId))}: ${r.status === "ok" ? "OK" : "FAILED - " + escapeHtml(r.error || "")}`
        ).join("<br>");
        const title = failures.length === 0 ? "All Stores Re-offlined" : "Re-offline Complete (with errors)";
        return resultPage(title, summary, failures.length > 0);
      } catch (e) {
        return resultPage("Re-offline Failed", e.message, true);
      }
    }

    // Store picker: /toggle
    if (path === "/toggle" || path === "/toggle/") {
      return storePickerPage(env.AUDIT_LOG);
    }

    // Match /toggle/:storeId
    const match = path.match(/^\/toggle\/(\d+)$/);
    if (!match) {
      return resultPage("Not Found", "Use /toggle to select a store.", true);
    }

    const storeId = parseInt(match[1], 10);
    const storeName = STORES[storeId];
    if (!storeName) {
      return resultPage("Unknown Store", `Store ${storeId} is not configured.`, true);
    }

    // GET = show confirmation page, POST = do the toggle via fetch API (returns JSON)
    if (request.method === "POST") {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const timestamp = new Date().toISOString();

      // Rate limit: 1 toggle per store per 5 minutes
      const cooldownKey = `cooldown:${storeId}`;
      const lastToggle = await env.AUDIT_LOG.get(cooldownKey);
      if (lastToggle) {
        const elapsed = Date.now() - parseInt(lastToggle, 10);
        const remaining = Math.ceil((300000 - elapsed) / 60000);
        return new Response(JSON.stringify({
          success: false,
          error: `Already toggled recently. Try again in ${remaining} minute${remaining === 1 ? "" : "s"}.`,
          rateLimited: true,
        }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        });
      }

      try {
        await toggleStore(env.REDCAT_USERNAME, env.REDCAT_PASSWORD, storeId);
        await env.AUDIT_LOG.put(cooldownKey, Date.now().toString(), { expirationTtl: 300 });
        await env.AUDIT_LOG.put(`status:${storeId}`, "online");
        await logAudit(env.AUDIT_LOG, {
          timestamp,
          action: "toggle_online",
          storeId,
          storeName,
          ip,
          success: true,
        });
        await sendTeamsAlert(
          env,
          "🍩 Daily Special - Now Available",
          `**${storeName}** made the Daily Special available.\n\nIt will go offline again at midnight.`
        );
        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        await logAudit(env.AUDIT_LOG, {
          timestamp,
          action: "toggle_online",
          storeId,
          storeName,
          ip,
          success: false,
          error: e.message,
        });
        console.error("Toggle error store", storeId, ":", e.message);
        return new Response(JSON.stringify({ success: false, error: "An error occurred. Please contact IT." }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return confirmPage(storeName, storeId);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      console.log("Cron triggered: re-offlining all stores");
      const timestamp = new Date().toISOString();
      try {
        const results = await reofflineAll(env.REDCAT_USERNAME, env.REDCAT_PASSWORD, env.AUDIT_LOG);
        const failures = results.filter((r) => r.status === "failed");
        console.log(`Re-offline complete: ${results.length - failures.length}/${results.length} succeeded`);
        await logAudit(env.AUDIT_LOG, {
          timestamp,
          action: "cron_reoffline",
          storeId: "all",
          storeName: "All Stores",
          ip: "cron",
          success: failures.length === 0,
          details: results.map((r) => `${STORES[r.storeId] || r.storeId}: ${r.status}`).join(", "),
        });
        if (failures.length > 0) {
          console.error("Failed stores:", JSON.stringify(failures));
          const failedNames = failures.map((f) => STORES[f.storeId] || f.storeId).join(", ");
          await sendTeamsAlert(
            env,
            "⚠️ Daily Special - Re-offline Partial Failure",
            `The midnight re-offline completed but **${failures.length} store(s) failed**: ${failedNames}\n\nCheck logs: [View audit logs](https://pos-toggle.example.workers.dev/admin/logs)`,
            true
          );
        }
      } catch (e) {
        console.error("Cron FATAL error:", e.message);
        await sendTeamsAlert(
          env,
          "🚨 Daily Special - Re-offline FAILED",
          `The midnight re-offline **completely failed**: ${e.message}\n\nAll stores may still be available. Manual re-offline needed: [Trigger now](https://pos-toggle.example.workers.dev/admin/reoffline)`,
          true
        );
        await logAudit(env.AUDIT_LOG, {
          timestamp,
          action: "cron_reoffline",
          storeId: "all",
          storeName: "All Stores",
          ip: "cron",
          success: false,
          error: e.message,
        });
      }
    })());
  },
};
