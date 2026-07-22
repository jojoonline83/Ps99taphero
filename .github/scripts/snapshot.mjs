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
// League pages are now fetched dynamically until empty (no fixed limit).

// Extra players to always include in the transcend leaderboard even if their
// league is outside the top 500.  Fetched individually via /v1/leagues/players/:userId.
// fallbackPts is used when the API returns stale or no data.
// minPts: if the API returns a score LOWER than this, override with minPts (handles API lag).
// leagueName: fetch this league directly to find the player's contribution points.
const EXTRA_TRACKED_PLAYERS = [
    { userId: 3543344398, name: 'JavierPlayz', fallbackPts: 38, leagueName: 'jj02' },
    { userId: 3079452920, name: 'Jojo8', minPts: 37 },
];

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

// Shared state used by both league/transcend and tap hero sections.
const now = Date.now();
let resolvedCache = {};
if (existsSync(RESOLVED_CACHE_FILE)) {
    try { resolvedCache = JSON.parse(readFileSync(RESOLVED_CACHE_FILE, 'utf8')); } catch (_) { resolvedCache = {}; }
}

// 0. Pre-fetch extra tracked players FIRST (before heavy bulk fetches exhaust rate limit).
const prefetchedExtraPlayers = await mapWithConcurrency(EXTRA_TRACKED_PLAYERS, 3, async entry => {
    const userId = entry.userId;
    const json = await fetchJson(`${API_V1}/leagues/players/${userId}`);
    if (!json) { console.log(`  Pre-fetch player ${userId}: API returned null`); return null; }
    const d = json.data;
    if (!d) { console.log(`  Pre-fetch player ${userId}: no data field, keys=${Object.keys(json)}`); return null; }
    if (d.UserID) { console.log(`  Pre-fetch player ${userId}: OK — ${d.DisplayName}, ${d.Points} pts`); return d; }
    if (Array.isArray(d) && d[0]?.UserID) { console.log(`  Pre-fetch player ${userId}: OK (array)`); return d[0]; }
    console.log(`  Pre-fetch player ${userId}: unexpected format, keys=${Object.keys(d)}`);
    return null;
});
console.log(`Pre-fetched ${prefetchedExtraPlayers.filter(Boolean).length}/${EXTRA_TRACKED_PLAYERS.length} extra tracked players.`);

// 0b. League + Transcend snapshot — run BEFORE heavy tap hero fetch to avoid rate limits.
async function snapshotLeagues() {
    // Fetch ALL league pages until we get an empty response.
    // This ensures every league (and every player) is captured regardless of league size.
    const leagueSummaries = [];
    const BATCH_SIZE = 10;
    let page = 1;
    let done = false;
    while (!done) {
        const batchPages = Array.from({ length: BATCH_SIZE }, (_, i) => page + i);
        const batchResults = await mapWithConcurrency(batchPages, LIST_CONCURRENCY, async p => {
            const json = await fetchJson(`${API_V1}/leagues?page=${p}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`);
            return json?.data?.leagues || [];
        });
        for (const pageResult of batchResults) {
            if (!pageResult.length) { done = true; break; }
            leagueSummaries.push(...pageResult);
        }
        page += BATCH_SIZE;
        if (page > 200) break; // safety cap
    }
    console.log(`Fetched ${leagueSummaries.length} league summaries (${page - 1} pages scanned).`);
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

async function buildTranscendFromLeagues() {
    let leagueHistory = [];
    if (existsSync(LEAGUE_HISTORY_FILE)) {
        try { leagueHistory = JSON.parse(readFileSync(LEAGUE_HISTORY_FILE, 'utf8')); } catch (_) { leagueHistory = []; }
    }
    if (!leagueHistory.length) {
        console.log('Transcend snapshot: no league data available — skipping.');
        return;
    }

    const bestRosterByLeague = new Map();
    for (let i = leagueHistory.length - 1; i >= 0; i--) {
        for (const league of leagueHistory[i].leagues) {
            if (bestRosterByLeague.has(league.Name)) continue;
            if (league.roster && league.roster.length > 0) {
                bestRosterByLeague.set(league.Name, league);
            }
        }
    }

    const playerMap = new Map();
    for (const [, league] of bestRosterByLeague) {
        for (const p of league.roster) {
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

    // Try multiple endpoints to find ALL Transcend players (including solo players not in any league).
    const TRANSCEND_ENDPOINTS = [
        { label: 'leagues/players (paginated)', base: `${API_V1}/leagues/players`, paginated: true },
        { label: 'transcend/players', url: `${API_V1}/transcend/players` },
        { label: 'leaderboard/transcend', url: `${API_V1}/leaderboard/transcend` },
        { label: 'leaderboard/Transcend', url: `${API_V1}/leaderboard/Transcend` },
        { label: 'events/transcend/leaderboard', url: `${API_V1}/events/transcend/leaderboard` },
        { label: 'leagues/leaderboard', url: `${API_V1}/leagues/leaderboard` },
        { label: 'activeLeagueBattle', url: `${API_BASE}/api/activeLeagueBattle` },
    ];

    let globalAdded = 0;
    let bestEndpointLabel = '';

    // Try non-paginated endpoints first (might return all players at once).
    for (const ep of TRANSCEND_ENDPOINTS) {
        if (ep.paginated) continue;
        const json = await fetchJson(ep.url, 2);
        if (!json) { console.log(`  Endpoint ${ep.label}: null`); continue; }
        const raw = json.data;
        if (!raw) { console.log(`  Endpoint ${ep.label}: no data field (keys: ${Object.keys(json).join(',')})`); continue; }
        // Try to extract player array from various response shapes.
        let players = [];
        if (Array.isArray(raw)) players = raw;
        else if (raw.players && Array.isArray(raw.players)) players = raw.players;
        else if (raw.leaderboard && Array.isArray(raw.leaderboard)) players = raw.leaderboard;
        else if (raw.data && Array.isArray(raw.data)) players = raw.data;

        if (players.length) {
            console.log(`  Endpoint ${ep.label}: found ${players.length} entries! Sample: ${JSON.stringify(players[0]).slice(0, 200)}`);
            let added = 0;
            for (const p of players) {
                const userId = p.UserID || p.userId || p.user_id;
                if (!userId) continue;
                const pts = p.Points ?? p.points ?? p.Score ?? p.score ?? 0;
                const existing = playerMap.get(userId);
                if (!existing || pts > existing.Points) {
                    const league = p.League || p.LeagueName || p.Clan;
                    playerMap.set(userId, {
                        UserID: userId,
                        DisplayName: p.DisplayName || p.displayName || resolvedCache[userId] || String(userId),
                        Points: pts,
                        Clan: typeof league === 'object' ? (league?.Name || '—') : (league || '—'),
                    });
                    if (!existing) added++;
                }
            }
            if (added > globalAdded) { globalAdded = added; bestEndpointLabel = ep.label; }
        } else {
            console.log(`  Endpoint ${ep.label}: data exists but no player array (type: ${typeof raw}, keys: ${Object.keys(raw).join(',')})`);
        }
    }

    // Helper: extract league name from string or object.
    function leagueName(val) {
        if (!val) return '—';
        if (typeof val === 'string') return val;
        if (typeof val === 'object' && val.Name) return val.Name;
        return '—';
    }

    // Always run paginated /v1/leagues/players (known to work, covers league members + some solo).
    const globalPlayerPages = Array.from({ length: 50 }, (_, i) => i + 1);
    const globalPageResults = await mapWithConcurrency(globalPlayerPages, LIST_CONCURRENCY, async page => {
        const json = await fetchJson(`${API_V1}/leagues/players?page=${page}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`);
        if (!json?.data) return [];
        const arr = Array.isArray(json.data) ? json.data : (json.data.players || json.data.data || []);
        return Array.isArray(arr) ? arr : [];
    });
    let paginatedAdded = 0;
    let paginatedTotal = 0;
    const paginatedNeedResolve = [];
    for (const page of globalPageResults) {
        for (const p of page) {
            if (!p || !p.UserID) continue;
            paginatedTotal++;
            const existing = playerMap.get(p.UserID);
            const pts = p.Points || 0;
            if (!existing || pts > existing.Points) {
                const displayName = p.DisplayName || resolvedCache[p.UserID] || String(p.UserID);
                playerMap.set(p.UserID, {
                    UserID: p.UserID,
                    DisplayName: displayName,
                    Points: pts,
                    Clan: leagueName(p.League || p.LeagueName),
                });
                if (!existing) {
                    paginatedAdded++;
                    if (displayName === String(p.UserID) && !resolvedCache[p.UserID]) {
                        paginatedNeedResolve.push(p.UserID);
                    }
                }
            }
        }
    }

    // Resolve display names for players found via paginated endpoint.
    if (paginatedNeedResolve.length) {
        const resolved = await resolveUsernames(paginatedNeedResolve);
        for (const [id, name] of Object.entries(resolved)) {
            const numId = Number(id);
            if (playerMap.has(numId)) playerMap.get(numId).DisplayName = name;
        }
        Object.assign(resolvedCache, resolved);
        console.log(`Transcend: resolved ${Object.keys(resolved).length}/${paginatedNeedResolve.length} paginated player names.`);
    }

    globalAdded += paginatedAdded;
    console.log(`Transcend: paginated /leagues/players returned ${paginatedTotal} entries, ${paginatedAdded} new players added.`);
    if (bestEndpointLabel) console.log(`Transcend: best discovery endpoint was "${bestEndpointLabel}".`);
    console.log(`Transcend: total ${globalAdded} player(s) added from global endpoints.`);

    // Use pre-fetched extra tracked players + fallback for those still missing.
    // Also enforce minPts for players already in the map (handles API lag).
    const extraFetched = prefetchedExtraPlayers;
    let extraCount = 0;
    let extraFromGlobal = 0;
    const extraNeedResolve = [];
    for (let i = 0; i < EXTRA_TRACKED_PLAYERS.length; i++) {
        const entry = EXTRA_TRACKED_PLAYERS[i];
        const userId = entry.userId;

        // If already captured, enforce minPts floor and fix display name.
        if (playerMap.has(userId)) {
            extraFromGlobal++;
            const existing = playerMap.get(userId);
            if (entry.minPts && existing.Points < entry.minPts) {
                console.log(`  Enforcing minPts for ${userId}: API=${existing.Points} → ${entry.minPts}`);
                existing.Points = entry.minPts;
            }
            if (!existing.DisplayName || existing.DisplayName === String(userId)) {
                existing.DisplayName = resolvedCache[userId] || entry.name || String(userId);
            }
            continue;
        }
        const p = extraFetched[i];
        if (!p || !p.UserID) continue;
        let displayName = p.DisplayName || resolvedCache[p.UserID] || null;
        if (!displayName || displayName === String(p.UserID)) {
            extraNeedResolve.push(p.UserID);
            displayName = resolvedCache[p.UserID] || String(p.UserID);
        }
        const pts = Math.max(p.Points || 0, entry.minPts || 0);
        playerMap.set(p.UserID, {
            UserID: p.UserID,
            DisplayName: displayName,
            Points: pts,
            Clan: leagueName(p.League || p.LeagueName),
        });
        extraCount++;
    }

    // Cross-check: for players already found, also fetch their league directly to get the
    // freshest PointContributions score (the /leagues/players/:id endpoint can lag by 1-2 pts).
    const needCrossCheck = EXTRA_TRACKED_PLAYERS.filter(e => e.leagueName && playerMap.has(e.userId));
    for (const entry of needCrossCheck) {
        const leagueJson = await fetchJson(`${API_V1}/leagues/${encodeURIComponent(entry.leagueName)}`);
        const detail = leagueJson?.data;
        if (!detail) continue;
        const contribs = {};
        (detail.PointContributions || []).forEach(c => { contribs[c.UserID] = c.Points; });
        const leaguePts = contribs[entry.userId] || 0;
        const current = playerMap.get(entry.userId);
        if (leaguePts > current.Points) {
            console.log(`  Cross-check ${entry.userId}: league "${entry.leagueName}" has ${leaguePts} pts (was ${current.Points}) — upgrading`);
            current.Points = leaguePts;
        }
        if (!current.Clan || current.Clan === '—') {
            current.Clan = detail.Name || entry.leagueName;
        }
        // Also add ALL other members from this league (covers teammates not in top league pages).
        const allMembers = [];
        if (detail.Owner?.UserID) allMembers.push(detail.Owner);
        (detail.Members || []).forEach(m => allMembers.push(m));
        let leagueMatesAdded = 0;
        for (const m of allMembers) {
            if (!m.UserID || playerMap.has(m.UserID)) continue;
            const mPts = contribs[m.UserID] || 0;
            const rawName = m.DisplayName && m.DisplayName !== String(m.UserID) ? m.DisplayName : null;
            const mName = rawName || resolvedCache[m.UserID] || String(m.UserID);
            playerMap.set(m.UserID, { UserID: m.UserID, DisplayName: mName, Points: mPts, Clan: detail.Name || entry.leagueName });
            leagueMatesAdded++;
        }
        if (leagueMatesAdded) console.log(`  Cross-check: added ${leagueMatesAdded} teammate(s) from league "${entry.leagueName}"`);
    }

    // Secondary fallback: fetch league directly by name, then try alt endpoints, then use fallback.
    const stillMissing = EXTRA_TRACKED_PLAYERS.filter(e => !playerMap.has(e.userId));
    if (stillMissing.length) {
        console.log(`Transcend: ${stillMissing.length} extra player(s) still missing — trying direct league fetch + secondary endpoints...`);
        for (const entry of stillMissing) {
            const userId = entry.userId;
            let found = false;

            // Try fetching the player's league directly by name.
            if (entry.leagueName) {
                const leagueJson = await fetchJson(`${API_V1}/leagues/${encodeURIComponent(entry.leagueName)}`);
                const detail = leagueJson?.data;
                if (detail) {
                    const contribs = {};
                    (detail.PointContributions || []).forEach(c => { contribs[c.UserID] = c.Points; });
                    const allMembers = [];
                    if (detail.Owner?.UserID) allMembers.push(detail.Owner);
                    (detail.Members || []).forEach(m => allMembers.push(m));
                    const member = allMembers.find(m => m.UserID === userId);
                    // Add ALL members from this league (not just the tracked player).
                    for (const m of allMembers) {
                        if (playerMap.has(m.UserID)) continue;
                        const mPts = m.UserID === userId ? Math.max(contribs[m.UserID] || 0, entry.minPts || 0) : (contribs[m.UserID] || 0);
                        const rawName = m.DisplayName && m.DisplayName !== String(m.UserID) ? m.DisplayName : null;
                        const mName = rawName || resolvedCache[m.UserID] || (m.UserID === userId ? entry.name : null) || String(m.UserID);
                        playerMap.set(m.UserID, { UserID: m.UserID, DisplayName: mName, Points: mPts, Clan: detail.Name || entry.leagueName });
                    }
                    if (playerMap.has(userId)) {
                        const added = playerMap.get(userId);
                        console.log(`  Found ${userId} via direct league "${entry.leagueName}": ${added.DisplayName}, ${added.Points} pts (+ ${allMembers.length - 1} teammates)`);
                        found = true;
                        extraCount++;
                    } else {
                        console.log(`  League "${entry.leagueName}" fetched (${allMembers.length} members) but ${userId} not found in roster.`);
                    }
                } else {
                    console.log(`  League "${entry.leagueName}" fetch returned null.`);
                }
            }

            if (!found) {
                const altEndpoints = [
                    `${API_V1}/leaderboard/players/${userId}`,
                    `${API_V1}/players/${userId}`,
                ];
                for (const url of altEndpoints) {
                    const json = await fetchJson(url, 2);
                    if (json?.data) {
                        const d = Array.isArray(json.data) ? json.data[0] : json.data;
                        if (d?.UserID || d?.Points !== undefined) {
                            const displayName = d.DisplayName || resolvedCache[userId] || entry.name || String(userId);
                            playerMap.set(userId, {
                                UserID: userId,
                                DisplayName: displayName,
                                Points: d.Points || 0,
                                Clan: leagueName(d.League || d.LeagueName),
                            });
                            console.log(`  Found ${userId} via alt endpoint: ${displayName}, ${d.Points} pts`);
                            found = true;
                            extraCount++;
                            break;
                        }
                    }
                }
            }

            if (!found) {
                const displayName = resolvedCache[userId] || entry.name || null;
                const pts = entry.fallbackPts ?? 0;
                if (displayName) {
                    playerMap.set(userId, { UserID: userId, DisplayName: displayName, Points: pts, Clan: entry.leagueName || '—' });
                    console.log(`  Added ${userId} (${displayName}) with ${pts} pts (fallback).`);
                    extraCount++;
                } else {
                    extraNeedResolve.push(userId);
                }
            }
        }
    }

    if (extraNeedResolve.length) {
        const resolved = await resolveUsernames(extraNeedResolve);
        for (const [id, name] of Object.entries(resolved)) {
            const numId = Number(id);
            if (playerMap.has(numId)) {
                playerMap.get(numId).DisplayName = name;
            } else {
                const entry = EXTRA_TRACKED_PLAYERS.find(e => e.userId === numId);
                const pts = entry?.fallbackPts ?? 0;
                playerMap.set(numId, { UserID: numId, DisplayName: name, Points: pts, Clan: '—' });
                extraCount++;
            }
        }
        Object.assign(resolvedCache, resolved);
    }
    const totalMissing = EXTRA_TRACKED_PLAYERS.filter(e => !playerMap.has(e.userId)).length;
    console.log(`Transcend: extra tracked players — ${extraCount} from API, ${extraFromGlobal} from global pages, ${totalMissing} still missing.`);

    // Prevent score regression: if an extra tracked player's score dropped vs the previous
    // snapshot (API outage / rate limit returning fallbackPts), keep the previous score.
    let transcendHistory = [];
    if (existsSync(TRANSCEND_HISTORY_FILE)) {
        try { transcendHistory = JSON.parse(readFileSync(TRANSCEND_HISTORY_FILE, 'utf8')); } catch (_) { transcendHistory = []; }
    }
    if (transcendHistory.length) {
        const prevSnap = transcendHistory[transcendHistory.length - 1];
        for (const entry of EXTRA_TRACKED_PLAYERS) {
            const cur = playerMap.get(entry.userId);
            if (!cur) continue;
            const prev = prevSnap.players?.find(p => p.UserID === entry.userId);
            if (prev && prev.Points > cur.Points) {
                console.log(`  Score guard: ${entry.name || entry.userId} would drop ${prev.Points} → ${cur.Points} — keeping ${prev.Points}`);
                cur.Points = prev.Points;
            }
        }
    }

    // Final resolve pass: fix any remaining numeric display names.
    const transcendNeedResolve = [];
    for (const [uid, p] of playerMap) {
        if (resolvedCache[uid]) {
            p.DisplayName = resolvedCache[uid];
        } else if (!p.DisplayName || p.DisplayName === String(uid)) {
            transcendNeedResolve.push(uid);
        }
    }
    if (transcendNeedResolve.length) {
        const resolved = await resolveUsernames(transcendNeedResolve);
        for (const [id, name] of Object.entries(resolved)) {
            const entry = playerMap.get(Number(id));
            if (entry) entry.DisplayName = name;
        }
        Object.assign(resolvedCache, resolved);
        console.log(`Transcend: final resolve pass fixed ${Object.keys(resolved).length}/${transcendNeedResolve.length} names.`);
    }

    const transcendPlayers = [...playerMap.values()]
        .sort((a, b) => b.Points - a.Points)
        .slice(0, 5000);

    transcendHistory.push({ ts: now, players: transcendPlayers });
    transcendHistory = transcendHistory.filter(entry => now - entry.ts <= RETENTION_MS);
    writeFileSync(TRANSCEND_HISTORY_FILE, JSON.stringify(transcendHistory));
    console.log(`Transcend snapshot: ${transcendPlayers.length} players from ${bestRosterByLeague.size} leagues, ${transcendHistory.length} snapshots retained.`);

    // Transcend inactivity alert: fire Discord alert if monitored players gained 0 pts in 30m.
    if (transcendHistory.length >= 2) {
        const latest = transcendHistory[transcendHistory.length - 1];
        const targetTs = latest.ts - 30 * 60_000;
        let compareSnap = null, bestDiff = Infinity;
        for (const snap of transcendHistory) {
            if (snap === latest) continue;
            if (latest.ts - snap.ts < 15 * 60_000) continue;
            const diff = Math.abs(snap.ts - targetTs);
            if (diff < bestDiff) { bestDiff = diff; compareSnap = snap; }
        }
        if (compareSnap && bestDiff <= 10 * 60_000) {
            mkdirSync(MONITOR_DIR, { recursive: true });
            const TRANSCEND_ALERT_FILE = `${MONITOR_DIR}/transcend_alert_state.json`;
            let tAlertState = {};
            if (existsSync(TRANSCEND_ALERT_FILE)) {
                try { tAlertState = JSON.parse(readFileSync(TRANSCEND_ALERT_FILE, 'utf8')); } catch (_) { tAlertState = {}; }
            }

            for (const entry of EXTRA_TRACKED_PLAYERS) {
                const current = latest.players.find(p => p.UserID === entry.userId);
                const past = compareSnap.players?.find(p => p.UserID === entry.userId);
                if (!current || !past) continue;

                const delta = current.Points - past.Points;
                const key = `${entry.userId}:30m`;
                const name = current.DisplayName || entry.name || String(entry.userId);

                if (delta === 0 && !tAlertState[key]) {
                    await sendDiscordAlert(`⚠️ **${name}** (Transcend) has gained 0 points in the last ~30 minutes — possibly inactive (${current.Points} pts, league: ${current.Clan}).`);
                    tAlertState[key] = true;
                    console.log(`Transcend alert: ${name} stalled at ${current.Points} pts.`);
                } else if (delta > 0) {
                    tAlertState[key] = false;
                }
            }
            writeFileSync(TRANSCEND_ALERT_FILE, JSON.stringify(tAlertState));
        } else {
            console.log('Transcend alert: not enough history for 30m comparison yet.');
        }
    }
}
await buildTranscendFromLeagues();

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

history.push({ ts: now, players });
history = history.filter(entry => now - entry.ts <= RETENTION_MS);
writeFileSync(HISTORY_FILE, JSON.stringify(history));

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Snapshot recorded: ${players.length} players in ${elapsedSec}s, ${history.length} snapshots retained.`);

// 6b. (League + Transcend already done above before tap hero to avoid rate limits)
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
