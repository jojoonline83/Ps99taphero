import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const API_BASE           = 'https://ps99.biggamesapi.io/v1';
const HISTORY_FILE       = 'history.json';
const RESOLVED_CACHE_FILE = 'resolved_names.json';
const RETENTION_MS       = 95 * 60 * 1000;
const TOP_PAGES          = 5;    // 5 pages * 100 = Top 500 leagues
const PAGE_SIZE          = 100;
const LIST_CONCURRENCY   = 10;
const DETAIL_CONCURRENCY = 20;

// Leagues to always track even if they fall outside the Top 500.
const EXTRA_LEAGUE_NAMES = [];

// Leagues whose individual players are monitored for inactivity.
// Discord alerts fire when a player shows zero point gain.
const MONITOR_LEAGUE_NAMES = [];

const MONITOR_DIR        = '.github/monitor-data';
const MONITOR_HISTORY_FILE = `${MONITOR_DIR}/monitor_history.json`;
const MONITOR_STATE_FILE   = `${MONITOR_DIR}/monitor_alert_state.json`;

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

function isUnresolvedName(entry) {
    return entry.DisplayName === String(entry.UserID);
}

function buildLeagueFromDetail(detail, extra) {
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
        roster, ...(extra ? { Extra: true } : {}),
    };
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

// Manual test mode for Discord webhook validation.
if (process.env.TEST_DISCORD_ALERT === 'true') {
    await sendDiscordAlert('✅ Test alert from PS99 Tap Hero Tracker — if you can see this, Discord notifications are working correctly.');
    console.log('Test Discord alert sent (or logged, if unconfigured).');
    process.exit(0);
}

const startedAt = Date.now();

// 1. Fetch the Top 500 league summaries.
const pageNums = Array.from({ length: TOP_PAGES }, (_, i) => i + 1);
const pageResults = await mapWithConcurrency(pageNums, LIST_CONCURRENCY, async page => {
    const json = await fetchJson(`${API_BASE}/leagues?page=${page}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`);
    return json?.data?.leagues || [];
});
const summaries = pageResults.flat();

if (!summaries.length) {
    console.error('No league data returned — skipping this snapshot.');
    process.exit(0);
}

// 1b. Fetch standing-exception leagues outside the Top 500.
const trackedNamesLower = new Set(summaries.map(s => s.NameLower || s.Name.toLowerCase()));
const extraLeagues = [];
for (const extraName of EXTRA_LEAGUE_NAMES) {
    if (trackedNamesLower.has(extraName.toLowerCase())) continue;
    const detailJson = await fetchJson(`${API_BASE}/leagues/${encodeURIComponent(extraName)}`);
    const detail = detailJson?.data;
    if (!detail) {
        console.log(`Extra tracked league "${extraName}" not found — skipping.`);
        continue;
    }
    extraLeagues.push(buildLeagueFromDetail(detail, true));
}

function looksSuspicious(detail, summary) {
    return typeof summary.Points === 'number' && summary.Points > 0 && detail.Points < summary.Points * 0.9;
}

// 2. Fetch full roster + point-contribution detail for every league.
const rankedLeagues = await mapWithConcurrency(summaries, DETAIL_CONCURRENCY, async summary => {
    const detailJson = await fetchJson(`${API_BASE}/leagues/${encodeURIComponent(summary.Name)}`);
    let detail = detailJson?.data;

    if (detail && looksSuspicious(detail, summary)) {
        const retryJson = await fetchJson(`${API_BASE}/leagues/${encodeURIComponent(summary.Name)}`);
        const retryDetail = retryJson?.data;
        if (retryDetail && !looksSuspicious(retryDetail, summary)) {
            detail = retryDetail;
        } else {
            console.log(`Suspicious detail for "${summary.Name}" (list: ${summary.Points}, detail: ${detail.Points}) — keeping list-level Points.`);
            detail = null;
        }
    }

    if (!detail) {
        return {
            ID: summary.ID, Name: summary.Name, Points: summary.Points,
            Members: summary.Members, MemberCapacity: summary.MemberCapacity,
            roster: [],
        };
    }

    return buildLeagueFromDetail(detail, false);
});
const leagues = rankedLeagues.concat(extraLeagues);

// 3. Resolve numeric-fallback display names.
let resolvedCache = {};
if (existsSync(RESOLVED_CACHE_FILE)) {
    try { resolvedCache = JSON.parse(readFileSync(RESOLVED_CACHE_FILE, 'utf8')); } catch (_) { resolvedCache = {}; }
}

const needsResolve = new Set();
leagues.forEach(l => l.roster.forEach(p => {
    if (!isUnresolvedName(p)) return;
    if (resolvedCache[p.UserID]) { p.DisplayName = resolvedCache[p.UserID]; return; }
    needsResolve.add(p.UserID);
}));

if (needsResolve.size) {
    const resolved = await resolveUsernames([...needsResolve]);
    leagues.forEach(l => l.roster.forEach(p => {
        if (isUnresolvedName(p) && resolved[p.UserID]) p.DisplayName = resolved[p.UserID];
    }));
    Object.assign(resolvedCache, resolved);
    console.log(`Resolved ${Object.keys(resolved).length}/${needsResolve.size} display names (${Object.keys(resolvedCache).length} cached).`);
}
writeFileSync(RESOLVED_CACHE_FILE, JSON.stringify(resolvedCache));

// 4. Append snapshot and prune history.
let history = [];
if (existsSync(HISTORY_FILE)) {
    try { history = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')); } catch (_) { history = []; }
}

const now = Date.now();
history.push({ ts: now, leagues });
history = history.filter(entry => now - entry.ts <= RETENTION_MS);
writeFileSync(HISTORY_FILE, JSON.stringify(history));

const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Snapshot recorded: ${leagues.length} leagues with roster detail in ${elapsedSec}s, ${history.length} snapshots retained.`);

// 5. Player-level inactivity monitoring for MONITOR_LEAGUE_NAMES.
mkdirSync(MONITOR_DIR, { recursive: true });
const monitorLeagues = {};
for (const name of MONITOR_LEAGUE_NAMES) {
    const already = leagues.find(l => l.Name.toLowerCase() === name.toLowerCase());
    if (already) {
        monitorLeagues[name] = { roster: already.roster };
        continue;
    }
    const json = await fetchJson(`${API_BASE}/leagues/${encodeURIComponent(name)}`);
    const detail = json?.data;
    monitorLeagues[name] = detail ? { roster: buildLeagueFromDetail(detail, false).roster } : null;
}

let monitorHistory = [];
if (existsSync(MONITOR_HISTORY_FILE)) {
    try { monitorHistory = JSON.parse(readFileSync(MONITOR_HISTORY_FILE, 'utf8')); } catch (_) { monitorHistory = []; }
}
const pastMonitorHistory = monitorHistory.filter(entry => now - entry.ts <= RETENTION_MS);
monitorHistory = [...pastMonitorHistory, { ts: now, leagues: monitorLeagues }];
writeFileSync(MONITOR_HISTORY_FILE, JSON.stringify(monitorHistory));

function findMonitorSnapshotNear(msAgo, toleranceMs) {
    const targetTs = now - msAgo;
    const minAgeMs = msAgo / 2;
    let best = null, bestDiff = Infinity;
    for (const entry of pastMonitorHistory) {
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

const snap10 = findMonitorSnapshotNear(10 * 60_000, 11 * 60_000);
const snap30 = findMonitorSnapshotNear(30 * 60_000, 8  * 60_000);
const snap1h = findMonitorSnapshotNear(60 * 60_000, 12 * 60_000);

for (const name of MONITOR_LEAGUE_NAMES) {
    const currentRoster = monitorLeagues[name]?.roster;
    if (!currentRoster) continue;

    const findPast = (snap, userId) => snap?.leagues?.[name]?.roster?.find(p => p.UserID === userId)?.Points;

    for (const player of currentRoster) {
        const windows = [
            { label: '10m', snap: snap10 },
            { label: '30m', snap: snap30 },
            { label: '1h',  snap: snap1h },
        ];
        for (const w of windows) {
            if (!w.snap) continue;
            const past = findPast(w.snap, player.UserID);
            if (past == null) continue;

            const key = `${name}:${player.UserID}:${w.label}`;
            const isStalled = player.Points - past === 0;
            if (isStalled && !alertState[key]) {
                await sendDiscordAlert(`⚠️ **${player.DisplayName}** in **${name}** has earned 0 points over the last ${w.label} — possibly inactive (currently ${player.Points.toLocaleString()} pts).`);
                alertState[key] = true;
            } else if (!isStalled) {
                alertState[key] = false;
            }
        }
    }
}
writeFileSync(MONITOR_STATE_FILE, JSON.stringify(alertState));
