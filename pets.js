'use strict';

const REPO_OWNER = 'jojoonline83';
const REPO_NAME = 'Ps99taphero';
const CONFIG_PATH = '.github/monitor-data/tracking_config.json';
const GH_API = 'https://api.github.com';

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

function getToken() { return localStorage.getItem('ps99_gh_token') || ''; }

function showSetup() {
    document.getElementById('setup-overlay').classList.add('show');
    document.getElementById('token-input').value = '';
    document.getElementById('setup-error').style.display = 'none';
    document.getElementById('token-input').focus();
}

function hideSetup() {
    document.getElementById('setup-overlay').classList.remove('show');
}

async function saveToken() {
    const input = document.getElementById('token-input');
    const errorEl = document.getElementById('setup-error');
    const saveBtn = document.getElementById('save-btn');
    const token = input.value.trim();

    if (!token) {
        errorEl.textContent = 'Please paste your token';
        errorEl.style.display = 'block';
        return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'Verifying...';
    errorEl.style.display = 'none';

    try {
        const res = await fetch(`${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${CONFIG_PATH}`, {
            headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' },
        });
        if (res.status === 401 || res.status === 403) throw new Error('Token rejected — check permissions');
        if (res.status === 404) throw new Error('Token needs Contents read/write access');
        if (!res.ok) throw new Error(`GitHub error ${res.status}`);

        localStorage.setItem('ps99_gh_token', token);
        updateSettingsBtn();
        hideSetup();
        toast('Connected to GitHub', 'success');
    } catch (err) {
        errorEl.textContent = err.message;
        errorEl.style.display = 'block';
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Connect';
    }
}

function updateSettingsBtn() {
    const btn = document.getElementById('settings-btn');
    if (!btn) return;
    const has = !!getToken();
    btn.classList.toggle('connected', has);
    btn.title = has ? 'Connected — click to update token' : 'Set up GitHub connection';
}

async function toggleHatching(username) {
    if (!getToken()) {
        showSetup();
        return;
    }

    const sw = document.querySelector(`[data-hatch="${username}"]`);
    if (sw) { sw.disabled = true; }

    try {
        const getRes = await fetch(`${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${CONFIG_PATH}`, {
            headers: { 'Authorization': `token ${getToken()}`, 'Accept': 'application/vnd.github.v3+json' },
        });
        if (getRes.status === 401) {
            localStorage.removeItem('ps99_gh_token');
            updateSettingsBtn();
            toast('Token expired — reconnect via gear icon', 'error');
            return;
        }
        if (!getRes.ok) throw new Error(`GitHub error ${getRes.status}`);

        const fileData = await getRes.json();
        const content = JSON.parse(atob(fileData.content));
        if (typeof content.hatching !== 'object' || content.hatching === null) content.hatching = {};

        const newState = !content.hatching[username];
        content.hatching[username] = newState;

        const putRes = await fetch(`${GH_API}/repos/${REPO_OWNER}/${REPO_NAME}/contents/${CONFIG_PATH}`, {
            method: 'PUT',
            headers: {
                'Authorization': `token ${getToken()}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                message: `chore: toggle hatching for ${username} to ${newState}`,
                content: btoa(JSON.stringify(content)),
                sha: fileData.sha,
            }),
        });
        if (!putRes.ok) {
            const err = await putRes.json().catch(() => ({}));
            throw new Error(err.message || `Update failed (${putRes.status})`);
        }

        hatchingConfig[username] = newState;
        toast(`${newState ? 'Hatching ON' : 'Hatching OFF'} for ${username}`, 'success');
    } catch (err) {
        toast(err.message, 'error');
    }
    renderPlayers();
}

window.toggleHatching = toggleHatching;
window.showSetup = showSetup;
window.hideSetup = hideSetup;
window.saveToken = saveToken;

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
        const isOn = username && hatchingConfig[username] === true;
        const toggle = username
            ? `<div class="hatch-toggle">
                   <button class="hatch-switch ${isOn ? 'on' : ''}" data-hatch="${esc(username)}" onclick="toggleHatching('${esc(username)}')" title="Toggle hatching refresh"></button>
                   <span class="hatch-label ${isOn ? 'on' : ''}">${isOn ? 'Hatching' : 'Off'}</span>
               </div>`
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
            ? `<div style="background:#2d1b00;border:1px solid #b45309;color:#fbbf24;padding:8px 12px;border-radius:6px;margin-bottom:12px;font-size:13px">${esc(player.status)}</div>`
            : '';

        return `
            <div class="player-card">
                <div class="player-card-header">
                    <div class="team-detail-color-bar" style="background:var(--accent);width:6px;height:48px;border-radius:3px;flex-shrink:0"></div>
                    <div style="flex:1">
                        <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
                            <h2>${esc(player.displayName)}</h2>
                            ${toggle}
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
        const res = await fetch(`${CONFIG_PATH}?t=${Date.now()}`, { signal: AbortSignal.timeout(10000) });
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

updateSettingsBtn();
document.getElementById('refresh-btn').addEventListener('click', () => refreshAll({ silent: false }));
document.getElementById('setup-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) hideSetup();
});
setInterval(() => refreshAll({ silent: true }), 10 * 60_000);
refreshAll({ silent: false });
