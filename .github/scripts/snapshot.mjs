import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const API_BASE       = 'https://ps99.biggamesapi.io/v1';
const HISTORY_FILE   = 'history.json';
const RETENTION_MS   = 95 * 60 * 1000; // ~95 minutes
const TOP_PAGES      = 1;    // Tap Hero leaderboard — fetch top 100
const PAGE_SIZE      = 100;

// The competition category for the current Tap Hero event.
// Update this if the competition ID changes each season/event.
const COMPETITION_CATEGORY = 'TapBattle';

// Players to monitor for inactivity — Discord alerts fire when any of
// these players show zero point gain across the check windows.
// Add Roblox UserIDs (as numbers) for the players you want monitored.
const MONITORED_PLAYERS = [];

// Discord webhook URLs — comma-separated to broadcast to multiple channels.
// Set via GitHub Actions secret: DISCORD_WEBHOOK_URL
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
        if (!ok) console.log(`resolveUsernames: batch starting at index ${i} never succeeded.`);
        await new Promise(r => setTimeout(r, 500));
    }
    return map;
}

// Manual test mode for Discord webhook validation.
if (process.env.TEST_DISCORD_ALERT === 'true') {
    await sendDiscordAlert('✅ Test alert from PS99 Tap Hero Tracker — if you can see this, Discord notifications are working correctly.');
    console.log('Test Discord alert sent (or logged, if unconfigured).');
    process.exit(0);
}

const startedAt = Date.now();

// 1. Fetch the Tap Hero competition leaderboard.
const players = [];
for (let page = 1; page <= TOP_PAGES; page++) {
    const json = await fetchJson(`${API_BASE}/leaderboard/${COMPETITION_CATEGORY}?page=${page}&pageSize=${PAGE_SIZE}&sort=Points&sortOrder=desc`);
    const entries = json?.data || [];
    if (Array.isArray(entries)) {
        entries.forEach((entry, idx) => {
            players.push({
                UserID: entry.UserID || entry.userId || entry.OwnerID,
                DisplayName: entry.DisplayName || entry.displayName || String(entry.UserID || entry.userId || entry.OwnerID),
                Points: entry.Points || entry.points || 0,
                Rank: (page - 1) * PAGE_SIZE + idx + 1,
            });
        });
    }
}

if (!players.length) {
    console.error('No leaderboard data returned — skipping this snapshot.');
    process.exit(0);
}

// 2. Resolve any numeric-fallback display names.
let resolvedCache = {};
const RESOLVED_CACHE_FILE = 'resolved_names.json';
if (existsSync(RESOLVED_CACHE_FILE)) {
    try { resolvedCache = JSON.parse(readFileSync(RESOLVED_CACHE_FILE, 'utf8')); } catch (_) { resolvedCache = {}; }
}

const needsResolve = [];
for (const p of players) {
    if (resolvedCache[p.UserID]) {
        p.DisplayName = resolvedCache[p.UserID];
    } else if (p.DisplayName === String(p.UserID)) {
        needsResolve.push(p.UserID);
    }
}

if (needsResolve.length) {
    const resolved = await resolveUsernames([...new Set(needsResolve)]);
    for (const p of players) {
        if (p.DisplayName === String(p.UserID) && resolved[p.UserID]) {
            p.DisplayName = resolved[p.UserID];
        }
    }
    Object.assign(resolvedCache, resolved);
    console.log(`Resolved ${Object.keys(resolved).length}/${needsResolve.length} display names (${Object.keys(resolvedCache).length} cached).`);
}
writeFileSync(RESOLVED_CACHE_FILE, JSON.stringify(resolvedCache));

// 3. Append snapshot and prune history.
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

// 4. Inactivity monitoring — check if monitored players have gained 0 points.
mkdirSync(MONITOR_DIR, { recursive: true });

let alertState = {};
if (existsSync(MONITOR_STATE_FILE)) {
    try { alertState = JSON.parse(readFileSync(MONITOR_STATE_FILE, 'utf8')); } catch (_) { alertState = {}; }
}

const pastHistory = history.filter(entry => entry.ts < now);

function findSnapshotNear(msAgo, toleranceMs) {
    const targetTs = now - msAgo;
    const minAgeMs = msAgo / 2;
    let best = null, bestDiff = Infinity;
    for (const entry of pastHistory) {
        if (now - entry.ts < minAgeMs) continue;
        const diff = Math.abs(entry.ts - targetTs);
        if (diff < bestDiff) { bestDiff = diff; best = entry; }
    }
    return best && bestDiff <= toleranceMs ? best : null;
}

function findPlayerInSnapshot(snap, userId) {
    return snap?.players?.find(p => p.UserID === userId);
}

const snap10 = findSnapshotNear(10 * 60_000, 11 * 60_000);
const snap30 = findSnapshotNear(30 * 60_000, 8  * 60_000);
const snap1h = findSnapshotNear(60 * 60_000, 12 * 60_000);

// Check ALL players in the leaderboard for inactivity (not just MONITORED_PLAYERS).
// If MONITORED_PLAYERS is non-empty, only those are checked; otherwise check everyone.
const playersToCheck = MONITORED_PLAYERS.length
    ? players.filter(p => MONITORED_PLAYERS.includes(p.UserID))
    : players;

for (const player of playersToCheck) {
    const windows = [
        { label: '10m', snap: snap10 },
        { label: '30m', snap: snap30 },
        { label: '1h',  snap: snap1h },
    ];
    for (const w of windows) {
        if (!w.snap) continue;
        const past = findPlayerInSnapshot(w.snap, player.UserID);
        if (!past) continue;

        const key = `${player.UserID}:${w.label}`;
        const isStalled = player.Points - past.Points === 0;
        if (isStalled && !alertState[key]) {
            await sendDiscordAlert(
                `⚠️ **${player.DisplayName}** (Rank #${player.Rank}) has earned 0 points over the last ${w.label} — possibly inactive (currently ${player.Points.toLocaleString()} pts).`
            );
            alertState[key] = true;
        } else if (!isStalled) {
            alertState[key] = false;
        }
    }
}

writeFileSync(MONITOR_STATE_FILE, JSON.stringify(alertState));
console.log(`Monitor check complete. Checked ${playersToCheck.length} players across available windows.`);
