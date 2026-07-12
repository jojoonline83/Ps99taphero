import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const API_BASE           = 'https://ps99.biggamesapi.io';
const HISTORY_FILE       = 'history.json';
const RESOLVED_CACHE_FILE = 'resolved_names.json';
const RETENTION_MS       = 95 * 60 * 1000;
const TOP_PAGES          = 5;
const PAGE_SIZE          = 100;
const LIST_CONCURRENCY   = 10;
const DETAIL_CONCURRENCY = 20;

// Players to always monitor for inactivity (by display name or UserID).
const MONITOR_PLAYER_NAMES = [];

const MONITOR_DIR        = '.github/monitor-data';
const MONITOR_STATE_FILE = `${MONITOR_DIR}/monitor_alert_state.json`;

function webhookUrls() {
    return (process.env.DISCORD_WEBHOOK_URL || '').split(',').map(s => s.trim()).filter(Boolean);
}

async function fetchJson(url, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
            if (res.ok) {
                const json = await res.json();
                if (json.status === 'ok') return json;
            }
        } catch (_) {}
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
    return null;
}

async function fetchRaw(url, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
            if (res.ok) return await res.json();
        } catch (_) {}
        if (i < attempts - 1) await new Promise(r => setTimeout(r, 500 * (i + 1)));
    }
    return null;
}

async function mapWithConcurrency(items, limit, fn) {
    const results = new Array(items.length);
    let idx = 0;
    async function worker() {
        while (idx < items.length) {
            const i = idx++;
            results[i] = await fn(items[i], i);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function isUnresolvedName(entry) {
    return entry.DisplayName === String(entry.UserID);
}

async function sendDiscordAlert(message) {
    const urls = webhookUrls();
    if (!urls.length) {
        console.log(`Discord webhook not configured — would have alerted: ${message}`);
        return;
    }
    for (const url of urls) {
        try {
            await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: message }),
                signal: AbortSignal.timeout(10000),
            });
        } catch (err) {
            console.log(`Discord alert failed for one webhook: ${err.message}`);
        }
    }
}

async function resolveUsernames(userIds) {
    const map = {};
    const ROBLOX_URL = 'https://users.roblox.com/v1/users';
    let failedBatches = 0;

    for (let i = 0; i < userIds.length; i += 100) {
        const batch = userIds.slice(i, i + 100);
        if (!batch.length) continue;

        let ok = false;
        for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
            try {
                const res = await fetch(ROBLOX_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ userIds: batch, excludeBannedUsers: false }),
                    signal: AbortSignal.timeout(10000),
                });
                if (res.ok) {
                    const json = await res.json();
                    const data = json.data || [];
                    if (data.length === 0) {
                        await new Promise(r => setTimeout(r, 1500 * attempt));
                    } else {
                        data.forEach(u => { map[u.id] = u.displayName || u.name; });
                        ok = true;
                    }
                } else if (res.status === 429) {
                    const retryAfter = Number(res.headers.get('retry-after')) || 0;
                    await new Promise(r => setTimeout(r, Math.max(retryAfter * 1000, 1500 * attempt)));
                } else {
                    await new Promise(r => setTimeout(r, 500 * attempt));
                }
            } catch (_) {
                await new Promise(r => setTimeout(r, 500 * attempt));
            }
        }
        if (!ok) failedBatches++;
        await new Promise(r => setTimeout(r, 500));
    }

    if (failedBatches) console.log(`resolveUsernames: ${failedBatches} batch(es) never succeeded after retries.`);
    return map;
}

if (process.env.TEST_DISCORD_ALERT === 'true') {
    await sendDiscordAlert('✅ Test alert from PS99 Tap Hero Player Tracker — if you can see this, Discord notifications are working correctly.');
    console.log('Test Discord alert sent (or logged, if unconfigured).');
    process.exit(0);
}

const startedAt = Date.now();

// 1. Get active clan battle info.
const battleInfo = await fetchJson(`${API_BASE}/api/activeClanBattle`);
const battleData = battleInfo?.data;
console.log(`Active battle keys: ${JSON.stringify(battleData ? Object.keys(battleData) : 'null')}`);
if (battleData?.configData) {
    console.log(`configData keys: ${JSON.stringify(Object.keys(battleData.configData))}`);
    console.log(`configData.Name: ${battleData.configData.Name}`);
    console.log(`configData sample: ${JSON.stringify(battleData.configData).slice(0, 400)}`);
}

// 2. Fetch top clans — try multiple API paths.
let clanSummaries = [];

// Try /api/clans (no status wrapper)
const apiClansRaw = await fetchRaw(`${API_BASE}/api/clans?page=1&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`);
console.log(`/api/clans raw keys: ${JSON.stringify(apiClansRaw ? Object.keys(apiClansRaw) : 'null')}`);
if (apiClansRaw) console.log(`/api/clans sample: ${JSON.stringify(apiClansRaw).slice(0, 400)}`);

// Try /v1/clans (with status:'ok' wrapper)
const v1ClansRaw = await fetchRaw(`${API_BASE}/v1/clans?page=1&pageSize=10&sort=Points&sortOrder=desc`);
console.log(`/v1/clans raw keys: ${JSON.stringify(v1ClansRaw ? Object.keys(v1ClansRaw) : 'null')}`);
if (v1ClansRaw) console.log(`/v1/clans sample: ${JSON.stringify(v1ClansRaw).slice(0, 400)}`);

// Try /api/clanBattle endpoint
const clanBattleRaw = await fetchRaw(`${API_BASE}/api/clanBattle`);
console.log(`/api/clanBattle raw: ${JSON.stringify(clanBattleRaw).slice(0, 400)}`);

// Try /api/activeClanBattle/leaderboard
const battleLbRaw = await fetchRaw(`${API_BASE}/api/activeClanBattle/leaderboard`);
console.log(`/api/activeClanBattle/leaderboard: ${JSON.stringify(battleLbRaw).slice(0, 400)}`);

// Try /api/clans without query params
const apiClansPlain = await fetchRaw(`${API_BASE}/api/clans`);
console.log(`/api/clans (no params) keys: ${JSON.stringify(apiClansPlain ? Object.keys(apiClansPlain) : 'null')}`);
if (apiClansPlain?.data) {
    const d = apiClansPlain.data;
    if (Array.isArray(d)) {
        console.log(`/api/clans data is array[${d.length}], first: ${JSON.stringify(d[0]).slice(0, 200)}`);
    } else {
        console.log(`/api/clans data keys: ${JSON.stringify(Object.keys(d))}`);
        console.log(`/api/clans data sample: ${JSON.stringify(d).slice(0, 300)}`);
    }
}

// Determine which source to use for clan list
function extractClans(json) {
    if (!json) return [];
    if (json.status === 'ok' && json.data) {
        if (Array.isArray(json.data)) return json.data;
        if (Array.isArray(json.data.clans)) return json.data.clans;
    }
    if (Array.isArray(json.data)) return json.data;
    if (Array.isArray(json)) return json;
    return [];
}

// Try to get full page set from whichever endpoint works
let workingEndpoint = null;
if (extractClans(apiClansRaw).length) workingEndpoint = '/api/clans';
else if (extractClans(v1ClansRaw).length) workingEndpoint = '/v1/clans';
else if (extractClans(apiClansPlain).length) workingEndpoint = '/api/clans-plain';

if (workingEndpoint === '/api/clans' || workingEndpoint === '/v1/clans') {
    const base = workingEndpoint === '/api/clans' ? `${API_BASE}/api/clans` : `${API_BASE}/v1/clans`;
    const fetcher = workingEndpoint === '/api/clans' ? fetchRaw : fetchJson;
    const pageNums = Array.from({ length: TOP_PAGES }, (_, i) => i + 1);
    const pageResults = await mapWithConcurrency(pageNums, LIST_CONCURRENCY, async page => {
        const json = await fetcher(`${base}?page=${page}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`);
        return extractClans(json);
    });
    clanSummaries = pageResults.flat();
} else if (workingEndpoint === '/api/clans-plain') {
    clanSummaries = extractClans(apiClansPlain);
}

console.log(`Working endpoint: ${workingEndpoint || 'NONE'}, clans found: ${clanSummaries.length}`);

if (!clanSummaries.length) {
    console.error('No clan data from any endpoint — skipping this snapshot.');
    process.exit(0);
}
console.log(`Fetched ${clanSummaries.length} clan summaries. First: ${JSON.stringify(clanSummaries[0]).slice(0, 200)}`);

// 3. Fetch detail for each clan to get individual player battle contributions.
let debuggedFirst = false;
const clanDetails = await mapWithConcurrency(clanSummaries, DETAIL_CONCURRENCY, async summary => {
    const name = summary.Name || summary.name;
    if (!name) return [];

    // Try both /api/clan/ and /v1/clans/ paths
    let detail = null;
    let detailJson = await fetchJson(`${API_BASE}/v1/clans/${encodeURIComponent(name)}`);
    if (detailJson?.data) {
        detail = detailJson.data;
    } else {
        const raw = await fetchRaw(`${API_BASE}/api/clan/${encodeURIComponent(name)}`);
        if (raw?.data) detail = raw.data;
        else if (raw && !raw.status) detail = raw;
    }
    if (!detail) return [];

    if (!debuggedFirst) {
        debuggedFirst = true;
        const keys = Object.keys(detail);
        console.log(`Clan detail keys: ${JSON.stringify(keys)}`);
        console.log(`BattleContributions: ${JSON.stringify(detail.BattleContributions?.slice?.(0, 2))}`);
        console.log(`PointContributions: ${JSON.stringify(detail.PointContributions?.slice?.(0, 2))}`);
        console.log(`Battles: ${JSON.stringify(detail.Battles)?.slice(0, 300)}`);
        console.log(`Battle: ${JSON.stringify(detail.Battle)?.slice(0, 300)}`);
        console.log(`Members sample: ${JSON.stringify(detail.Members?.slice?.(0, 1))?.slice(0, 200)}`);
    }

    // Extract individual players with their battle points
    const battleContribs = {};
    const contribSource = detail.BattleContributions || detail.PointContributions || detail.Battle?.Contributions || [];
    (Array.isArray(contribSource) ? contribSource : []).forEach(c => {
        battleContribs[c.UserID] = c.Points;
    });

    const players = [];
    // Owner
    if (detail.Owner && detail.Owner.UserID) {
        players.push({
            UserID: detail.Owner.UserID,
            DisplayName: detail.Owner.DisplayName,
            Points: battleContribs[detail.Owner.UserID] ?? 0,
            Clan: name,
        });
    }
    // Members
    (detail.Members || []).forEach(m => {
        if (!m.UserID) return;
        players.push({
            UserID: m.UserID,
            DisplayName: m.DisplayName,
            Points: battleContribs[m.UserID] ?? 0,
            Clan: name,
        });
    });
    // Deputies / other roles
    (detail.Deputies || []).forEach(m => {
        if (!m.UserID) return;
        players.push({
            UserID: m.UserID,
            DisplayName: m.DisplayName,
            Points: battleContribs[m.UserID] ?? 0,
            Clan: name,
        });
    });
    return players;
});

// 4. Flatten all players, deduplicate by UserID, sort by points desc.
const playerMap = new Map();
for (const roster of clanDetails) {
    for (const p of roster) {
        const existing = playerMap.get(p.UserID);
        if (!existing || p.Points > existing.Points) {
            playerMap.set(p.UserID, p);
        }
    }
}
let players = [...playerMap.values()].sort((a, b) => b.Points - a.Points);
console.log(`Extracted ${players.length} individual players from ${clanSummaries.length} clans.`);

// 5. Resolve numeric-fallback display names.
let resolvedCache = {};
if (existsSync(RESOLVED_CACHE_FILE)) {
    try { resolvedCache = JSON.parse(readFileSync(RESOLVED_CACHE_FILE, 'utf8')); } catch (_) { resolvedCache = {}; }
}

const needsResolve = new Set();
players.forEach(p => {
    if (!isUnresolvedName(p)) return;
    if (resolvedCache[p.UserID]) { p.DisplayName = resolvedCache[p.UserID]; return; }
    needsResolve.add(p.UserID);
});

if (needsResolve.size) {
    const resolved = await resolveUsernames([...needsResolve]);
    players.forEach(p => {
        if (isUnresolvedName(p) && resolved[p.UserID]) p.DisplayName = resolved[p.UserID];
    });
    Object.assign(resolvedCache, resolved);
    console.log(`Resolved ${Object.keys(resolved).length}/${needsResolve.size} display names (${Object.keys(resolvedCache).length} cached).`);
}
writeFileSync(RESOLVED_CACHE_FILE, JSON.stringify(resolvedCache));

// 6. Append snapshot and prune history.
let history = [];
if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { history = []; }
}

const now = Date.now();
history.push({ ts: now, players });
history = history.filter(entry => now - entry.ts <= RETENTION_MS);
writeFileSync(HISTORY_FILE, JSON.stringify(history));

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Snapshot recorded: ${players.length} individual players in ${elapsedSec}s, ${history.length} snapshots retained.`);

// 7. Player-level inactivity monitoring.
mkdirSync(MONITOR_DIR, { recursive: true });

function findSnapshotNear(msAgo, toleranceMs) {
    const targetTs = now - msAgo;
    const minAgeMs = msAgo / 2;
    const pastHistory = history.filter(e => e.ts < now);
    let best = null, bestDiff = Infinity;
    for (const entry of pastHistory) {
        if (now - entry.ts < minAgeMs) continue;
        const diff = Math.abs(entry.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    return best && bestDiff <= toleranceMs ? best : null;
}

let alertState = {};
if (existsSync(MONITOR_STATE_FILE)) {
    try { alertState = JSON.parse(readFileSync(MONITOR_STATE_FILE, 'utf8')); } catch (_) { alertState = {}; }
}

const snap10 = findSnapshotNear(10 * 60_000, 11 * 60_000);
const snap30 = findSnapshotNear(30 * 60_000, 8  * 60_000);
const snap1h = findSnapshotNear(60 * 60_000, 12 * 60_000);

const monitorSet = new Set(MONITOR_PLAYER_NAMES.map(n => n.toLowerCase()));
const monitoredPlayers = monitorSet.size
    ? players.filter(p => monitorSet.has(p.DisplayName.toLowerCase()) || monitorSet.has(String(p.UserID)))
    : [];

for (const player of monitoredPlayers) {
    const windows = [
        { label: '10m', snap: snap10 },
        { label: '30m', snap: snap30 },
        { label: '1h',  snap: snap1h },
    ];
    for (const w of windows) {
        if (!w.snap) continue;
        const past = w.snap.players?.find(p => p.UserID === player.UserID)?.Points;
        if (past == null) continue;

        const key = `${player.UserID}:${w.label}`;
        const isStalled = player.Points - past === 0;
        if (isStalled && !alertState[key]) {
            await sendDiscordAlert(`⚠️ **${player.DisplayName}** has earned 0 points over the last ${w.label} — possibly inactive (currently ${player.Points.toLocaleString()} pts, clan: ${player.Clan}).`);
            alertState[key] = true;
        } else if (!isStalled) {
            alertState[key] = false;
        }
    }
}
writeFileSync(MONITOR_STATE_FILE, JSON.stringify(alertState));
