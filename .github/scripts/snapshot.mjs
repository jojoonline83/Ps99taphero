import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const API_BASE           = 'https://ps99.biggamesapi.io';
const API_V1             = 'https://ps99.biggamesapi.io/v1';
const HISTORY_FILE        = 'history.json';
const LEAGUE_HISTORY_FILE    = 'league_history.json';
const TRANSCEND_HISTORY_FILE = 'transcend_history.json';
const COLLECTION_FILE     = 'collection.json';
const RESOLVED_CACHE_FILE = 'resolved_names.json';
const RETENTION_MS       = 95 * 60 * 1000;
const TOP_PAGES          = 5;
const PAGE_SIZE          = 100;
const LIST_CONCURRENCY   = 10;
const DETAIL_CONCURRENCY = 20;
const MAX_PLAYERS        = 5000;
const LEAGUE_TOP_PAGES   = 5;

// Players to always monitor for inactivity (by display name or UserID).
const MONITOR_PLAYER_NAMES = ['jojo8', 'javierplayz'];

// Pet collection tracking config.
const COLLECTION_TRACK = [
    { username: 'avocardorable99', watchPets: ['Samurai Kitsune'] },
    { username: 'jjlovegame99', watchPets: ['Samurai Kitsune'] },
];
const COLLECTION_STALL_TIERS = [20, 40, 60];


const MONITOR_DIR             = '.github/monitor-data';
const MONITOR_STATE_FILE      = `${MONITOR_DIR}/monitor_alert_state.json`;
const COLLECTION_STATE_FILE   = `${MONITOR_DIR}/collection_state.json`;
const AUTH_CALL_STATE_FILE    = `${MONITOR_DIR}/auth_call_state.json`;
const TRACKING_CONFIG_FILE    = `${MONITOR_DIR}/tracking_config.json`;

let trackingConfig = { hatching: {} };
if (existsSync(TRACKING_CONFIG_FILE)) {
    try {
        const raw = JSON.parse(readFileSync(TRACKING_CONFIG_FILE, 'utf8'));
        if (typeof raw.hatching === 'boolean') {
            const global = raw.hatching;
            trackingConfig.hatching = {};
            for (const t of COLLECTION_TRACK) trackingConfig.hatching[t.username] = global;
        } else {
            trackingConfig = raw;
        }
    } catch (_) {}
}
const activeHatchers = Object.entries(trackingConfig.hatching || {}).filter(([,v]) => v).map(([k]) => k);
console.log(`Hatching tracker: ${activeHatchers.length ? activeHatchers.join(', ') + ' ON' : 'ALL OFF — public endpoint only'}`);

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

// 1. Get active clan battle info to find the current battle key.
const battleInfo = await fetchJson(`${API_BASE}/api/activeClanBattle`);
const battleData = battleInfo?.data;
const battleConfigName = battleData?.configName;
const battleTitle = battleData?.configData?.Title || battleConfigName || 'Unknown';
console.log(`Active battle: "${battleTitle}" (configName: ${battleConfigName})`);

// 2. Fetch top clans from /api/clans.
const pageNums = Array.from({ length: TOP_PAGES }, (_, i) => i + 1);
const pageResults = await mapWithConcurrency(pageNums, LIST_CONCURRENCY, async page => {
    const json = await fetchJson(`${API_BASE}/api/clans?page=${page}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`);
    return json?.data || [];
});
const clanSummaries = pageResults.flat();

if (!clanSummaries.length) {
    console.error('No clan data returned — skipping this snapshot.');
    process.exit(0);
}
console.log(`Fetched ${clanSummaries.length} clan summaries.`);

// 3. Fetch detail for each clan to get individual player battle contributions.
let debuggedFirst = false;
const clanDetails = await mapWithConcurrency(clanSummaries, DETAIL_CONCURRENCY, async summary => {
    const name = summary.Name || summary.name;
    if (!name) return [];

    const detailJson = await fetchJson(`${API_BASE}/api/clan/${encodeURIComponent(name)}`);
    const detail = detailJson?.data;
    if (!detail) return [];

    if (!debuggedFirst) {
        debuggedFirst = true;
        const battleKeys = detail.Battles ? Object.keys(detail.Battles) : [];
        console.log(`Clan "${name}" battle keys: ${JSON.stringify(battleKeys)}`);
        if (battleConfigName && detail.Battles?.[battleConfigName]) {
            const b = detail.Battles[battleConfigName];
            console.log(`Active battle data: Points=${b.Points}, contributions=${b.PointContributions?.length || 0}`);
        }
    }

    // Extract battle points from the active battle
    const battleContribs = {};
    if (battleConfigName && detail.Battles?.[battleConfigName]) {
        const battle = detail.Battles[battleConfigName];
        (battle.PointContributions || []).forEach(c => {
            battleContribs[c.UserID] = c.Points;
        });
    }

    // Collect all members (Owner + Members list)
    const allMemberIds = new Set();
    const players = [];

    if (detail.Owner) {
        const uid = detail.Owner.UserID || detail.Owner;
        if (typeof uid === 'number') {
            allMemberIds.add(uid);
            players.push({
                UserID: uid,
                DisplayName: String(uid),
                Points: battleContribs[uid] ?? 0,
                Clan: name,
            });
        }
    }

    (detail.Members || []).forEach(m => {
        const uid = m.UserID || m;
        if (typeof uid !== 'number') return;
        if (allMemberIds.has(uid)) return;
        allMemberIds.add(uid);
        players.push({
            UserID: uid,
            DisplayName: String(uid),
            Points: battleContribs[uid] ?? 0,
            Clan: name,
        });
    });

    return players;
});

// 4. Flatten all players, deduplicate by UserID, sort by points desc, take top N.
const playerMap = new Map();
for (const roster of clanDetails) {
    for (const p of roster) {
        const existing = playerMap.get(p.UserID);
        if (!existing || p.Points > existing.Points) {
            playerMap.set(p.UserID, p);
        }
    }
}
let players = [...playerMap.values()]
    .sort((a, b) => b.Points - a.Points)
    .slice(0, MAX_PLAYERS);

const totalExtracted = playerMap.size;
console.log(`Extracted ${totalExtracted} players, keeping top ${players.length}.`);

// 5. Resolve display names via Roblox API.
let resolvedCache = {};
if (existsSync(RESOLVED_CACHE_FILE)) {
    try { resolvedCache = JSON.parse(readFileSync(RESOLVED_CACHE_FILE, 'utf8')); } catch (_) { resolvedCache = {}; }
}

const needsResolve = [];
players.forEach(p => {
    if (resolvedCache[p.UserID]) {
        p.DisplayName = resolvedCache[p.UserID];
    } else {
        needsResolve.push(p.UserID);
    }
});

if (needsResolve.length) {
    const resolved = await resolveUsernames(needsResolve);
    players.forEach(p => {
        if (resolved[p.UserID]) p.DisplayName = resolved[p.UserID];
    });
    Object.assign(resolvedCache, resolved);
    console.log(`Resolved ${Object.keys(resolved).length}/${needsResolve.length} display names (${Object.keys(resolvedCache).length} cached).`);
}

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
console.log(`Snapshot recorded: ${players.length} players in ${elapsedSec}s, ${history.length} snapshots retained.`);

// 6b. League Part 2 snapshot (uses /v1/leagues API).
async function snapshotLeagues() {
    const leaguePageNums = Array.from({ length: LEAGUE_TOP_PAGES }, (_, i) => i + 1);
    const leaguePageResults = await mapWithConcurrency(leaguePageNums, LIST_CONCURRENCY, async page => {
        const json = await fetchJson(`${API_V1}/leagues?page=${page}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`);
        return json?.data?.leagues || [];
    });
    const leagueSummaries = leaguePageResults.flat();
    if (!leagueSummaries.length) {
        console.log('League snapshot: no league data returned — skipping.');
        return;
    }

    const leagueDetails = await mapWithConcurrency(leagueSummaries, DETAIL_CONCURRENCY, async summary => {
        const detailJson = await fetchJson(`${API_V1}/leagues/${encodeURIComponent(summary.Name)}`);
        const detail = detailJson?.data;
        if (!detail) {
            return {
                ID: summary.ID, Name: summary.Name, Points: summary.Points,
                Members: summary.Members, MemberCapacity: summary.MemberCapacity, roster: [],
            };
        }
        const contribByUser = {};
        (detail.PointContributions || []).forEach(c => { contribByUser[c.UserID] = c.Points; });
        const roster = [];
        if (detail.Owner && detail.Owner.UserID) {
            roster.push({
                UserID: detail.Owner.UserID, DisplayName: detail.Owner.DisplayName,
                Points: contribByUser[detail.Owner.UserID] ?? 0, Role: 'Owner',
            });
        }
        (detail.Members || []).forEach(m => {
            roster.push({
                UserID: m.UserID, DisplayName: m.DisplayName,
                Points: contribByUser[m.UserID] ?? 0, Role: 'Member',
            });
        });
        return {
            ID: detail.ID, Name: detail.Name, Points: detail.Points,
            Members: roster.length, MemberCapacity: detail.MemberCapacity,
            Level: detail.Level, roster,
        };
    });

    // Resolve numeric-fallback display names.
    const leagueNeedsResolve = [];
    leagueDetails.forEach(l => l.roster.forEach(p => {
        if (p.DisplayName === String(p.UserID)) {
            if (resolvedCache[p.UserID]) { p.DisplayName = resolvedCache[p.UserID]; }
            else { leagueNeedsResolve.push(p.UserID); }
        }
    }));
    if (leagueNeedsResolve.length) {
        const resolved = await resolveUsernames([...new Set(leagueNeedsResolve)]);
        leagueDetails.forEach(l => l.roster.forEach(p => {
            if (p.DisplayName === String(p.UserID) && resolved[p.UserID]) p.DisplayName = resolved[p.UserID];
        }));
        Object.assign(resolvedCache, resolved);
        console.log(`League names resolved: ${Object.keys(resolved).length}/${leagueNeedsResolve.length}`);
    }

    let leagueHistory = [];
    if (existsSync(LEAGUE_HISTORY_FILE)) {
        try { leagueHistory = JSON.parse(readFileSync(LEAGUE_HISTORY_FILE, 'utf8')); } catch (_) { leagueHistory = []; }
    }
    leagueHistory.push({ ts: now, leagues: leagueDetails });
    leagueHistory = leagueHistory.filter(entry => now - entry.ts <= RETENTION_MS);
    writeFileSync(LEAGUE_HISTORY_FILE, JSON.stringify(leagueHistory));
    console.log(`League snapshot: ${leagueDetails.length} leagues, ${leagueHistory.length} snapshots retained.`);
}
await snapshotLeagues();

// 6c. Transcend individual player leaderboard — extracted from league rosters.
// Uses the league detail data already fetched above (500 leagues × up to 4 players
// = ~2000 individual players with their point contributions).
function buildTranscendFromLeagues() {
    let leagueHistory = [];
    if (existsSync(LEAGUE_HISTORY_FILE)) {
        try { leagueHistory = JSON.parse(readFileSync(LEAGUE_HISTORY_FILE, 'utf8')); } catch (_) { leagueHistory = []; }
    }
    const latestLeagues = leagueHistory.length ? leagueHistory[leagueHistory.length - 1].leagues : [];
    if (!latestLeagues.length) {
        console.log('Transcend snapshot: no league data available — skipping.');
        return;
    }

    const playerMap = new Map();
    for (const league of latestLeagues) {
        for (const p of (league.roster || [])) {
            const existing = playerMap.get(p.UserID);
            if (!existing || p.Points > existing.Points) {
                playerMap.set(p.UserID, {
                    UserID: p.UserID,
                    DisplayName: p.DisplayName || String(p.UserID),
                    Points: p.Points || 0,
                    Clan: league.Name || '—',
                });
            }
        }
    }

    const transcendPlayers = [...playerMap.values()]
        .sort((a, b) => b.Points - a.Points)
        .slice(0, 2000);

    let transcendHistory = [];
    if (existsSync(TRANSCEND_HISTORY_FILE)) {
        try { transcendHistory = JSON.parse(readFileSync(TRANSCEND_HISTORY_FILE, 'utf8')); } catch (_) { transcendHistory = []; }
    }
    transcendHistory.push({ ts: now, players: transcendPlayers });
    transcendHistory = transcendHistory.filter(entry => now - entry.ts <= RETENTION_MS);
    writeFileSync(TRANSCEND_HISTORY_FILE, JSON.stringify(transcendHistory));
    console.log(`Transcend snapshot: ${transcendPlayers.length} players from ${latestLeagues.length} leagues, ${transcendHistory.length} snapshots retained.`);
}
buildTranscendFromLeagues();

writeFileSync(RESOLVED_CACHE_FILE, JSON.stringify(resolvedCache));

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

// 8. Pet collection tracking.
async function resolveUsernameToId(username) {
    const url = 'https://users.roblox.com/v1/usernames/users';
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
                signal: AbortSignal.timeout(10000),
            });
            if (res.ok) {
                const json = await res.json();
                const user = json.data?.[0];
                if (user) return { id: user.id, displayName: user.displayName || user.name };
            }
        } catch (_) {}
        await new Promise(r => setTimeout(r, 500 * attempt));
    }
    return null;
}

async function fetchAuthenticatedInventory(token, forceRefresh = false) {
    const url = `${API_BASE}/v1/account/inventory${forceRefresh ? '?refresh=true' : ''}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { 'Authorization': `Bearer ${token}` },
                signal: AbortSignal.timeout(30000),
            });
            const text = await res.text();
            if (res.status === 401 || res.status === 403) {
                console.log(`  Auth inventory: ${res.status} — token expired or revoked`);
                return { items: null, reason: 'token_expired', refresh: null };
            }
            if (!res.ok) {
                console.log(`  Auth inventory: ${res.status} body: ${text.slice(0, 200)}`);
                if (attempt < 3) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
                return { items: null, reason: 'api_error', refresh: null };
            }
            let json;
            try { json = JSON.parse(text); } catch (_) {
                return { items: null, reason: 'api_error', refresh: null };
            }
            if (json.status !== 'ok' || !json.data) {
                return { items: null, reason: 'api_error', refresh: null };
            }
            const items = json.data.items;
            const refresh = json.data.refresh || null;
            if (!Array.isArray(items)) {
                console.log(`  Auth inventory: no items array. Keys: ${Object.keys(json.data || {})}`);
                return { items: null, reason: 'no_items', refresh };
            }
            if (refresh) {
                const consumed = refresh.consumedThisCall ? 'YES' : 'no';
                const skipped = refresh.skipped || 'n/a';
                console.log(`  Auth inventory: ${items.length} items | quota ${refresh.used}/${refresh.limit} | consumed: ${consumed} | skipped: ${skipped}`);
                if (refresh.quotaExhausted) {
                    console.log(`  ⚠ Quota exhausted — no more fresh snapshots until ${refresh.resetsAt}`);
                }
                if (refresh.nextRefreshEligibleAt) {
                    console.log(`  Next refresh eligible: ${refresh.nextRefreshEligibleAt}`);
                }
            } else {
                console.log(`  Auth inventory: ${items.length} items (no refresh info in response)`);
            }
            return { items, reason: null, refresh };
        } catch (err) {
            console.log(`  Auth inventory error: ${err.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
    return { items: null, reason: 'network_error', refresh: null };
}

async function fetchPlayerInventory(slug) {
    const url = `${API_BASE}/v1/players/${slug}?include=inventory`;
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
            const text = await res.text();
            if (!res.ok) {
                console.log(`  ${url} → ${res.status} body: ${text.slice(0, 200)}`);
                if (attempt < 3) { await new Promise(r => setTimeout(r, 1000 * attempt)); continue; }
                return { items: null, reason: 'player_not_found' };
            }
            let json;
            try { json = JSON.parse(text); } catch (_) {
                console.log(`  ${url} → invalid JSON`);
                return { items: null, reason: 'api_error' };
            }
            if (json.status !== 'ok' || !json.data) {
                console.log(`  ${url} → status: ${json.status}`);
                return { items: null, reason: 'api_error' };
            }
            const invView = json.data.views?.inventory;
            if (!invView || !invView.available) {
                const reason = invView?.reason || 'unknown';
                console.log(`  Inventory not available for ${slug}: ${reason}`);
                return { items: null, reason };
            }
            const items = invView.data?.items;
            if (!Array.isArray(items)) {
                console.log(`  Inventory data missing items array. Keys: ${Object.keys(invView.data || {})}`);
                return { items: null, reason: 'no_items' };
            }
            console.log(`  Fetched inventory: ${items.length} items (stale=${invView.isStale || false})`);
            return { items, reason: null };
        } catch (err) {
            console.log(`  ${url} → error: ${err.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 1000 * attempt));
        }
    }
    return { items: null, reason: 'network_error' };
}

function getTokenForUsername(username) {
    const envKey = `PS99_TOKEN_${username.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    return process.env[envKey] || null;
}

let authCallState = {};
if (existsSync(AUTH_CALL_STATE_FILE)) {
    try { authCallState = JSON.parse(readFileSync(AUTH_CALL_STATE_FILE, 'utf8')); } catch (_) { authCallState = {}; }
}

async function fetchCollection(userId, username) {
    const token = username ? getTokenForUsername(username) : null;
    const authKey = username || String(userId);
    const state = authCallState[authKey] || {};

    const isHatching = username && trackingConfig.hatching && trackingConfig.hatching[username];
    if (token && isHatching) {
        const now = Date.now();
        const quotaExhausted = state.quotaExhausted || false;
        const nextEligible = state.nextRefreshEligibleAt ? new Date(state.nextRefreshEligibleAt).getTime() : 0;
        const isEligible = !nextEligible || now >= nextEligible;

        if (quotaExhausted) {
            const resetsAt = state.resetsAt || 'midnight UTC';
            console.log(`  Quota exhausted (${state.used}/${state.limit}) — resets at ${resetsAt}, using public endpoint`);
        } else if (!isEligible) {
            const minsUntil = Math.round((nextEligible - now) / 60000);
            console.log(`  Next refresh in ~${minsUntil}min (${state.used}/${state.limit} used), using public endpoint`);
        } else {
            console.log(`  Requesting fresh snapshot (${state.used || 0}/${state.limit || '?'} used)...`);
            const authResult = await fetchAuthenticatedInventory(token, true);
            if (authResult.refresh) {
                authCallState[authKey] = {
                    lastCall: now,
                    used: authResult.refresh.used,
                    limit: authResult.refresh.limit,
                    quotaExhausted: authResult.refresh.quotaExhausted || false,
                    nextRefreshEligibleAt: authResult.refresh.nextRefreshEligibleAt || null,
                    resetsAt: authResult.refresh.resetsAt || null,
                    consumedThisCall: authResult.refresh.consumedThisCall || false,
                };
            } else {
                authCallState[authKey] = { lastCall: now };
            }
            if (authResult.items) return authResult;
            console.log(`  Auth failed (${authResult.reason}), falling back to public endpoint`);
        }
    }

    const result = await fetchPlayerInventory(userId);
    if (result.items) return result;
    if (username) {
        console.log(`  Retrying with username slug: ${username}`);
        const result2 = await fetchPlayerInventory(username);
        if (result2.items) return result2;
        return result2.reason !== 'player_not_found' ? result2 : result;
    }
    return result;
}

let collectionState = {};
if (existsSync(COLLECTION_STATE_FILE)) {
    try { collectionState = JSON.parse(readFileSync(COLLECTION_STATE_FILE, 'utf8')); } catch (_) { collectionState = {}; }
}

const collectionDisplay = [];

for (const track of COLLECTION_TRACK) {
    const user = await resolveUsernameToId(track.username);
    if (!user) {
        console.log(`Collection tracking: could not resolve username "${track.username}"`);
        continue;
    }
    const uid = String(user.id);
    const displayName = user.displayName;
    console.log(`Collection tracking: ${displayName} (${uid})`);

    const fetchResult = await fetchCollection(user.id, track.username);
    if (!fetchResult.items) {
        const reasonText = {
            no_recent_data: 'Linked but needs to open PS99 to refresh data',
            not_public: 'Inventory not set to public',
            player_not_found: 'Account not linked on db.biggames.io',
            token_expired: 'OAuth token expired — re-authorize via Exchange Token workflow',
        }[fetchResult.reason] || fetchResult.reason;
        console.log(`  Could not fetch inventory for ${displayName}: ${reasonText}`);
        collectionDisplay.push({
            username: track.username,
            displayName,
            userId: user.id,
            totalPets: 0,
            uniquePets: 0,
            diff: 0,
            watchPets: [],
            ts: now,
            status: reasonText,
        });
        continue;
    }
    const items = fetchResult.items;

    const pets = items.filter(i => i.class === 'Pet');
    const totalPets = pets.reduce((sum, p) => sum + (p.count || 1), 0);
    const uniquePets = pets.length;

    const watchSummary = [];
    for (const petName of (track.watchPets || [])) {
        const nameLower = petName.toLowerCase();
        const matches = pets.filter(p =>
            (p.displayName || '').toLowerCase().includes(nameLower) ||
            (p.id || '').toLowerCase().includes(nameLower)
        );
        const totalCount = matches.reduce((sum, p) => sum + (p.count || 1), 0);
        const variants = matches.map(p => {
            const tags = [];
            const rd = p.rawData || {};
            if (rd.sh) tags.push('Shiny');
            if (rd.pt === 1) tags.push('Golden');
            if (rd.pt === 2) tags.push('Rainbow');
            const label = tags.length ? ` (${tags.join(', ')})` : '';
            return { label: `${p.displayName || p.id}${label}`, count: p.count || 1 };
        });
        watchSummary.push({ name: petName, total: totalCount, variants });
        const variantText = variants.map(v => `${v.label} x${v.count}`).join(', ');
        console.log(`  ${petName}: ${totalCount} total — ${variantText || 'none found'}`);
    }

    console.log(`  Total pets: ${totalPets} (${uniquePets} unique entries)`);

    const prev = collectionState[uid];
    const prevTotal = prev?.totalPets || 0;
    const diff = prev ? totalPets - prevTotal : 0;

    collectionDisplay.push({
        username: track.username,
        displayName,
        userId: user.id,
        totalPets,
        uniquePets,
        diff,
        watchPets: watchSummary,
        ts: now,
    });

    const petLines = watchSummary.map(w => {
        const variantText = w.variants.map(v => `${v.label} x${v.count}`).join(', ');
        return `• ${w.name}: **${w.total}** (${variantText || 'none'})`;
    }).join('\n');

    if (prev) {
        const lastIncreaseTs = prev.lastIncreaseTs || prev.ts || now;
        const alertedTiers = prev.alertedTiers || [];

        if (diff > 0) {
            await sendDiscordAlert(
                `✅ **${displayName}** gained **${diff}** pets (now ${totalPets.toLocaleString()}).\n${petLines}`
            );
            collectionState[uid] = { lastIncreaseTs: now, totalPets, alertedTiers: [] };
        } else {
            const minutesSinceIncrease = (now - lastIncreaseTs) / 60000;
            const newAlertedTiers = [...alertedTiers];
            for (const tier of COLLECTION_STALL_TIERS) {
                if (minutesSinceIncrease >= tier && !alertedTiers.includes(tier)) {
                    const label = tier >= 60 ? `${tier / 60} hour` : `${tier} min`;
                    await sendDiscordAlert(
                        `🥚 **${displayName}** pet count unchanged at **${totalPets.toLocaleString()}** for the last ~${label} — hatching may be stuck.\n${petLines}`
                    );
                    newAlertedTiers.push(tier);
                }
            }
            collectionState[uid] = { lastIncreaseTs, totalPets, alertedTiers: newAlertedTiers };
        }
    } else {
        await sendDiscordAlert(
            `📦 Started tracking **${displayName}**'s collection: **${totalPets.toLocaleString()}** total pets.\n${petLines}`
        );
        collectionState[uid] = { lastIncreaseTs: now, totalPets, alertedTiers: [] };
    }
}
writeFileSync(COLLECTION_STATE_FILE, JSON.stringify(collectionState));
writeFileSync(AUTH_CALL_STATE_FILE, JSON.stringify(authCallState));
writeFileSync(COLLECTION_FILE, JSON.stringify(collectionDisplay));
