'use strict';

let collectionData = [];

function esc(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str ?? ''));
    return d.innerHTML;
}

function fmt(n) { return (Number(n) || 0).toLocaleString(); }

let toastTimer = null;
function toast(msg, type = 'success') {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.className = `toast ${type} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function renderPlayers() {
    const badge = document.getElementById('pet-status-badge');
    const container = document.getElementById('players-container');

    if (!collectionData.length) {
        container.innerHTML = '<div class="no-data">No collection data yet — waiting for first snapshot from GitHub Actions.</div>';
        badge.innerHTML = '';
        return;
    }

    const latestTs = Math.max(...collectionData.map(p => p.ts));
    badge.innerHTML = `<span class="status-pill status-active">Updated ${new Date(latestTs).toLocaleTimeString()}</span>`;

    container.innerHTML = collectionData.map(player => {
        const diffClass = player.diff > 0 ? 'positive' : 'zero';
        const diffText = player.diff > 0 ? `+${fmt(player.diff)}` : player.diff === 0 ? '0' : fmt(player.diff);

        const watchPetsSections = (player.watchPets || []).map(wp => {
            const variantRows = wp.variants.length
                ? wp.variants.map(v =>
                    `<div class="variant-row">
                        <span class="variant-name">${esc(v.label)}</span>
                        <span class="variant-count">x${fmt(v.count)}</span>
                    </div>`
                ).join('')
                : '<div class="variant-row"><span class="variant-name" style="color:var(--text-muted)">None found</span></div>';

            return `
                <div class="watch-pet-section">
                    <div class="watch-pet-title">${esc(wp.name)} — ${fmt(wp.total)} total</div>
                    ${variantRows}
                </div>`;
        }).join('');

        const statusBanner = player.status
            ? `<div style="background:#2d1b00;border:1px solid #b45309;color:#fbbf24;padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:13px">⚠️ ${esc(player.status)}</div>`
            : '';

        return `
            <div class="player-card">
                <div class="player-card-header">
                    <div class="team-detail-color-bar" style="background:var(--accent);width:6px;height:48px;border-radius:3px;flex-shrink:0"></div>
                    <div>
                        <h2>${esc(player.displayName)}</h2>
                        <span class="uid">User ID: ${player.userId}</span>
                    </div>
                </div>
                ${statusBanner}
                <div class="pet-stats">
                    <div class="pet-stat">
                        <span class="pet-stat-value">${fmt(player.totalPets)}</span>
                        <span class="pet-stat-label">Total Pets</span>
                    </div>
                    <div class="pet-stat">
                        <span class="pet-stat-value">${fmt(player.uniquePets)}</span>
                        <span class="pet-stat-label">Unique Entries</span>
                    </div>
                    <div class="pet-stat">
                        <span class="pet-stat-value ${diffClass}">${diffText}</span>
                        <span class="pet-stat-label">Change</span>
                    </div>
                    <div class="pet-stat">
                        <span class="pet-stat-value" style="font-size:14px">${new Date(player.ts).toLocaleTimeString()}</span>
                        <span class="pet-stat-label">Last Updated</span>
                    </div>
                </div>
                ${watchPetsSections}
            </div>`;
    }).join('');
}

async function loadCollection() {
    const res = await fetch(`collection.json?t=${Date.now()}`, { signal: AbortSignal.timeout(30000) });
    if (res.ok) {
        const raw = await res.json();
        if (Array.isArray(raw)) collectionData = raw;
    }
}

async function loadHatchingStatus() {
    const badge = document.getElementById('hatching-badge');
    if (!badge) return;
    try {
        const res = await fetch(`.github/monitor-data/tracking_config.json?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error();
        const cfg = await res.json();
        const on = cfg.hatching === true;
        const toggleUrl = 'https://github.com/jojoonline83/Ps99taphero/actions/workflows/toggle-hatching.yml';
        badge.innerHTML = `<a href="${toggleUrl}" target="_blank" class="${on ? 'hatching-on' : 'hatching-off'}" title="Click to toggle hatching tracker via GitHub Actions">${on ? '🥚 Hatching ON' : '🥚 Hatching OFF'}</a>`;
    } catch {
        badge.innerHTML = '';
    }
}

async function refreshAll({ silent = false } = {}) {
    const btn = document.getElementById('refresh-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading...'; }
    try {
        await Promise.all([loadCollection(), loadHatchingStatus()]);
        renderPlayers();
        if (!silent) toast(`Loaded ${collectionData.length} player(s)`, 'success');
    } catch (err) {
        if (!silent) toast(err.message || 'Failed to refresh', 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Refresh'; }
    }
}

document.getElementById('refresh-btn').addEventListener('click', () => refreshAll({ silent: false }));
setInterval(() => refreshAll({ silent: true }), 10 * 60_000);
refreshAll({ silent: false });
