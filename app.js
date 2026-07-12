'use strict';

let historyData = [];

let ui = {
    currentPlayer: null,
};

function esc(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str ?? ''));
    return d.innerHTML;
}

function fmt(n) {
    return (Number(n) || 0).toLocaleString();
}

function latestSnapshot() {
    return historyData.length ? historyData[historyData.length - 1] : null;
}

function topPlayers() {
    return latestSnapshot()?.players || [];
}

// ── Toast ──────────────────────────────────
let toastTimer = null;
function toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

// ── Navigation ─────────────────────────────
function showLeaderboard() {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('leaderboard-view').classList.add('active');
    ui.currentPlayer = null;
    renderLeaderboard();
}

function showPlayerDetail(userId) {
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('player-detail-view').classList.add('active');
    ui.currentPlayer = userId;
    renderPlayerDetail();
}

// ── Delta Helpers ──────────────────────────
function findSnapshotNear(msAgo, toleranceMs) {
    if (historyData.length < 2) return null;
    const latest = historyData[historyData.length - 1];
    const targetTs = latest.ts - msAgo;
    const minAgeMs = msAgo / 2;
    let best = null, bestDiff = Infinity;
    for (const entry of historyData) {
        if (entry === latest) continue;
        if (latest.ts - entry.ts < minAgeMs) continue;
        const diff = Math.abs(entry.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    return best && bestDiff <= toleranceMs ? best : null;
}

function playerDelta(userId, currentPoints, windowMs, toleranceMs) {
    const snap = findSnapshotNear(windowMs, toleranceMs);
    if (!snap) return { text: '—', cls: '' };

    const past = snap.players?.find(p => p.UserID === userId);
    if (!past) return { text: '—', cls: '' };

    const delta = currentPoints - past.Points;
    const sign = delta >= 0 ? '+' : '−';
    const cls = delta > 0 ? 'delta-positive' : (delta < 0 ? 'delta-negative' : 'delta-zero');
    return { text: `${sign}${fmt(Math.abs(delta))}`, cls };
}

// ── Leaderboard Rendering ──────────────────
function renderLeaderboard() {
    const badge = document.getElementById('event-status-badge');
    const snap = latestSnapshot();
    badge.innerHTML = snap
        ? `<span class="status-pill status-active">⚡ Updated ${new Date(snap.ts).toLocaleTimeString()}</span>`
        : '';

    const list = topPlayers();
    const tbody = document.getElementById('leaderboard-tbody');

    if (!list.length) {
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--text-muted)">
          No data yet — waiting for first snapshot from GitHub Actions.
        </td></tr>`;
        return;
    }

    tbody.innerHTML = list.map((p, idx) => {
        const d10 = playerDelta(p.UserID, p.Points, 10 * 60_000, 11 * 60_000);
        const d30 = playerDelta(p.UserID, p.Points, 30 * 60_000, 8  * 60_000);
        const d1h = playerDelta(p.UserID, p.Points, 60 * 60_000, 12 * 60_000);
        return `
      <tr class="clickable-row" onclick="showPlayerDetail(${p.UserID})">
        <td class="player-rank">${idx + 1}</td>
        <td class="player-name">${esc(p.DisplayName)}</td>
        <td class="player-points">${fmt(p.Points)}</td>
        <td class="${d10.cls}">${d10.text}</td>
        <td class="${d30.cls}">${d30.text}</td>
        <td class="${d1h.cls}">${d1h.text}</td>
      </tr>`;
    }).join('');
}

// ── Player Detail Rendering ────────────────
function renderPlayerDetail() {
    const player = topPlayers().find(p => p.UserID === ui.currentPlayer);
    if (!player) {
        document.getElementById('player-detail-name').textContent = 'Player not found';
        return;
    }

    document.getElementById('player-detail-color-bar').style.background = '#f59e0b';
    document.getElementById('player-detail-name').textContent = player.DisplayName;
    document.getElementById('player-detail-sub').textContent = `User ID: ${player.UserID}`;
    document.getElementById('pd-rank').textContent = `#${player.Rank}`;
    document.getElementById('pd-pts').textContent = fmt(player.Points);

    const d10 = playerDelta(player.UserID, player.Points, 10 * 60_000, 11 * 60_000);
    const d30 = playerDelta(player.UserID, player.Points, 30 * 60_000, 8  * 60_000);
    const d1h = playerDelta(player.UserID, player.Points, 60 * 60_000, 12 * 60_000);

    const el10 = document.getElementById('pd-delta-10m');
    const el30 = document.getElementById('pd-delta-30m');
    const el1h = document.getElementById('pd-delta-1h');
    el10.textContent = d10.text; el10.className = `stat-value ${d10.cls}`;
    el30.textContent = d30.text; el30.className = `stat-value ${d30.cls}`;
    el1h.textContent = d1h.text; el1h.className = `stat-value ${d1h.cls}`;

    // Point history table from all snapshots
    const tbody = document.getElementById('history-tbody');
    const entries = [];
    for (let i = historyData.length - 1; i >= 0; i--) {
        const snap = historyData[i];
        const p = snap.players?.find(x => x.UserID === ui.currentPlayer);
        if (!p) continue;
        const prev = i > 0 ? historyData[i - 1]?.players?.find(x => x.UserID === ui.currentPlayer) : null;
        const delta = prev ? p.Points - prev.Points : null;
        entries.push({ ts: snap.ts, points: p.Points, delta });
    }

    tbody.innerHTML = entries.length
        ? entries.map(e => {
            const time = new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            const deltaText = e.delta === null ? '—' : (e.delta >= 0 ? `+${fmt(e.delta)}` : `−${fmt(Math.abs(e.delta))}`);
            const cls = e.delta === null ? '' : (e.delta > 0 ? 'delta-positive' : (e.delta < 0 ? 'delta-negative' : 'delta-zero'));
            return `<tr><td>${time}</td><td class="player-points">${fmt(e.points)}</td><td class="${cls}">${deltaText}</td></tr>`;
          }).join('')
        : `<tr><td colspan="3" style="text-align:center;padding:32px;color:var(--text-muted)">No history yet.</td></tr>`;
}

// ── Data Loading ───────────────────────────
async function loadHistory() {
    const res = await fetch(`history.json?t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) historyData = await res.json();
}

async function refreshAll({ silent = false } = {}) {
    const btn = document.getElementById('refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Loading…'; }

    try {
        await loadHistory();
        if (!ui.currentPlayer) {
            renderLeaderboard();
        } else {
            renderPlayerDetail();
        }
        if (!silent) toast(`Loaded ${fmt(topPlayers().length)} players`, 'success');
    } catch (err) {
        if (!silent) toast(err.message || 'Failed to refresh', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🔄 Refresh'; }
    }
}

// ── Event Listeners ────────────────────────
document.getElementById('back-btn').addEventListener('click', showLeaderboard);
document.getElementById('refresh-btn').addEventListener('click', () => refreshAll({ silent: false }));

// Auto-refresh every 10 minutes (matches snapshot cadence).
setInterval(() => refreshAll({ silent: true }), 10 * 60_000);

// Bootstrap
renderLeaderboard();
refreshAll({ silent: false });
