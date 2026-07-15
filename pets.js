'use strict';

let collectionData = [];
let hatchingConfig = {};

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

const TOGGLE_URL = 'https://github.com/jojoonline83/Ps99taphero/actions/workflows/toggle-hatching.yml';

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

        const username = player.username || '';
        const isHatching = username && hatchingConfig[username] === true;
        const hatchBadge = username
            ? `<a href="${TOGGLE_URL}" target="_blank" class="${isHatching ? 'hatching-on' : 'hatching-off'}" title="Click to toggle hatching for ${esc(username)} via GitHub Actions">${isHatching ? '🥚 Hatching' : '🥚 Off'}</a>`
            : '';

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
                    <div style="flex:1">
                        <div style="display:flex;align-items:center;gap:10px">
                            <h2>${esc(player.displayName)}</h2>
                            ${hatchBadge}
                        </div>
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
    try {
        const res = await fetch(`.github/monitor-data/tracking_config.json?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) throw new Error();
        const cfg = await res.json();
        if (typeof cfg.hatching === 'object' && cfg.hatching !== null) {
            hatchingConfig = cfg.hatching;
        } else if (cfg.hatching === true) {
            hatchingConfig = { avocardorable99: true, jjlovegame99: true };
        } else {
            hatchingConfig = {};
        }
    } catch {
        hatchingConfig = {};
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
