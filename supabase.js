// ════════════════════════════════════════════════════════════
// supabase.js — API credentials + shared state & utilities
// Used by both index.html (players) and admin.html (admin)
// ════════════════════════════════════════════════════════════

// ┌─────────────────────────────────────────────────────────┐
// │   PUBLIC SUPABASE CREDENTIALS                           │
// └─────────────────────────────────────────────────────────┘
window.SUPABASE_URL = "https://szwnummygksldjufnhdt.supabase.co"; 
window.SUPABASE_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN6d251bW15Z2tzbGRqdWZuaGR0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyMTgzNzgsImV4cCI6MjA5NTc5NDM3OH0.GkCiJPxWvlXxPN5BtcABRQnGCc3A1wfK2T2_EH74Py4";

// Initialize the database connection only ONCE here
const db = supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON);

// ── SHARED STATE ──────────────────────────────────────────
let players          = [];
let courts           = [];
let settings         = { min_players: 12, max_players: 0, assignment_cycle: 0 }; // max 0 = no limit
let assignmentCounter = 0;  // kept in sync with settings.assignment_cycle
let currentClubId    = null; // set at login (admin) or session join (player)

// Pair history: "sortedId1:sortedId2" → number of times those two were teammates.
// Loaded from DB on init, persisted after each court assignment.
let pairHistory = {};

// ── CLUB CONTEXT ──────────────────────────────────────────
// Admin path: resolves from Supabase auth user id.
// Player path: resolves from the stored session (set in requireSession).
async function initClubContext() {
  const { data: { user } } = await db.auth.getUser();
  if (user) { currentClubId = user.id; return; }
  const stored = getStoredSession();
  if (stored?.clubId) currentClubId = stored.clubId;
}

// ── CLUB FILTER HELPER ────────────────────────────────────
// When club_id is set, scope the query to that club.
// When null (legacy data or session without club_id), fetch all rows so
// the app still works before the data migration is run.
function withClub(query) {
  return currentClubId ? query.eq('club_id', currentClubId) : query;
}

// ── DATA FETCHERS ─────────────────────────────────────────
async function fetchPlayers() {
  const { data, error } = await withClub(
    db.from('players').select('*')
      .order('games_played', { ascending: true })
      .order('created_at',   { ascending: true })
  );
  if (!error) players = data || [];
}

async function fetchCourts() {
  const { data, error } = await withClub(
    db.from('courts').select('*').eq('is_active', true)
      .order('created_at', { ascending: true })
  );
  if (!error) courts = data || [];
}

async function fetchSettings() {
  const { data, error } = await withClub(db.from('settings').select('*'));
  if (!error && data) {
    data.forEach(row => {
      if (row.key === 'min_players') settings.min_players = parseInt(row.value) || 12;
      if (row.key === 'max_players') settings.max_players = parseInt(row.value) ?? 0; // 0 = no limit
      if (row.key === 'assignment_cycle') {
        settings.assignment_cycle = parseInt(row.value) || 0;
        assignmentCounter = settings.assignment_cycle;
      }
      if (row.key === 'pair_history') {
        try { pairHistory = JSON.parse(row.value) || {}; } catch { pairHistory = {}; }
      }
    });
  }
}

// ── SHARED HELPERS ────────────────────────────────────────
function getPlayer(id) { return players.find(p => p.id === id); }

// Skill level order — used for adjacent-level fallback matching
const LEVEL_ORDER = ['novice', 'beginner', 'intermediate', 'advanced'];

// Picks 4 players from a pre-sorted pool, preferring same-level matches.
// Falls back to adjacent levels (e.g. beginner+intermediate), then any mix.
function selectFourByLevel(sortedPool) {
  // 1. Strict same-level: pick first level that has 4+ players
  for (const level of LEVEL_ORDER) {
    const group = sortedPool.filter(p => p.skill_level === level);
    if (group.length >= 4) return group.slice(0, 4);
  }

  // 2. Adjacent levels: novice+beginner, beginner+intermediate, intermediate+advanced
  for (let i = 0; i < LEVEL_ORDER.length - 1; i++) {
    const group = sortedPool.filter(p =>
      p.skill_level === LEVEL_ORDER[i] || p.skill_level === LEVEL_ORDER[i + 1]
    );
    if (group.length >= 4) return group.slice(0, 4);
  }

  // 3. Full fallback — any mix (avoids everyone waiting forever)
  return sortedPool.slice(0, 4);
}

// Returns next 4 player IDs in deterministic priority order:
function getNextFourIds(waitingPool) {
  if (!waitingPool || waitingPool.length < 4) return [];

  const activeCourtCount = courts.length || 1;
  const assignmentCycle = settings.assignment_cycle || 0;

  // 1. Anti-back-to-back filter
  let eligible = waitingPool.filter(p => {
    const lastCycle = p.last_assignment_cycle || 0;
    return (assignmentCycle - lastCycle >= activeCourtCount);
  });

  // Fallback if there are not enough players who haven't played recently
  let usedFallback = false;
  if (eligible.length < 4) {
    eligible = [...waitingPool];
    usedFallback = true;
  }

  // 2. Deterministic Sort (Matches autoMatch sorting completely)
  eligible.sort((a, b) => {
    if (usedFallback) {
      const cycleA = a.last_assignment_cycle || 0;
      const cycleB = b.last_assignment_cycle || 0;
      if (cycleA !== cycleB) return cycleA - cycleB; // Longest sitting player first
    }

    if (a.games_played !== b.games_played) {
      return a.games_played - b.games_played;
    }

    const timeA = new Date(a.created_at).getTime();
    const timeB = new Date(b.created_at).getTime();
    return timeA - timeB; // Earliest registration time wins tiebreaker
  });

  return selectFourByLevel(eligible).map(p => p.id);
}

// ── PLAYER REGISTRATION ───────────────────────────────────
function medianGamesPlayed() {
  if (!players.length) return 0;
  const sorted = [...players].map(p => p.games_played || 0).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : Math.floor((sorted[mid - 1] + sorted[mid]) / 2);
}

async function registerNewPlayer(name, skillLevel) {
  const median = medianGamesPlayed();
  const { error } = await db.from('players').insert({
    name,
    skill_level: skillLevel,
    status: 'waiting',
    games_played: median,
    club_id: currentClubId,
  });
  return error;
}

// ── REST WINDOW ────────────────────────────────────────────
function restWindowSize() {
  return courts.length || 1;
}

function isResting(player) {
  if (!player.games_played) return false; // never played — never resting
  // last_assignment_cycle is set directly by autoMatch's local assignmentCycle variable
  // (not the in-memory assignmentCounter which can be stale). More reliable.
  const ref = player.last_assignment_cycle || player.finished_at_assignment || 0;
  return (assignmentCounter - ref) < restWindowSize();
}

async function finishPlayers(playerIds, winnerIds = []) {
  const cycle = assignmentCounter;
  const { data: ps, error: selectErr } = await db.from('players').select('*').in('id', playerIds);
  if (selectErr) { toast('Could not load players for finish: ' + selectErr.message, 'error'); return; }
  if (!ps || !ps.length) return;

  for (const p of ps) {
    const gamesPlayed = parseInt(p.games_played, 10) || 0;
    const updateData = {
      status: 'waiting',
      games_played: gamesPlayed + 1,
    };
    if ('finished_at_assignment' in p) updateData.finished_at_assignment = cycle;
    if (winnerIds.includes(p.id) && 'wins' in p) {
      updateData.wins = (parseInt(p.wins, 10) || 0) + 1;
    }
    const { error } = await db.from('players').update(updateData).eq('id', p.id);
    if (error) toast('Error updating player ' + p.name + ': ' + error.message, 'error');
  }
}

// ── SESSION CODE ───────────────────────────────────────────
function generateSessionCode() {
  const chars  = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // no O or I
  const digits = '23456789';                  // no 0 or 1
  let code = '';
  for (let i = 0; i < 3; i++) code += chars[Math.floor(Math.random() * chars.length)];
  code += '-';
  for (let i = 0; i < 4; i++) code += digits[Math.floor(Math.random() * digits.length)];
  return code;
}

async function validateSessionCode(rawCode) {
  const code = rawCode.trim().toUpperCase().replace(/\s/g, '');
  const { data, error } = await db.from('sessions')
    .select('*').eq('code', code).eq('is_active', true).maybeSingle();
  if (error || !data) return { valid: false, reason: 'Invalid or inactive session code.' };
  if (data.expires_at && new Date(data.expires_at) < new Date()) {
    return { valid: false, reason: 'This session code has expired.' };
  }
  return { valid: true, sessionId: data.id, label: data.label, clubId: data.club_id };
}

// ── SESSION STORAGE ────────────────────────────────────────
const SESSION_KEY = 'picklequeue_session';

function storeSession(data) {
  localStorage.setItem(SESSION_KEY, JSON.stringify(data));
}

function getStoredSession() {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY)); } catch { return null; }
}

function clearStoredSession() {
  localStorage.removeItem(SESSION_KEY);
}

async function requireSession() {
  const stored = getStoredSession();
  if (!stored?.code) { window.location.href = 'index.html'; return null; }
  try {
    const result = await validateSessionCode(stored.code);
    if (!result.valid) { clearStoredSession(); window.location.href = 'index.html'; return null; }
    currentClubId = result.clubId; // set club context for this player's session
    return stored;
  } catch { window.location.href = 'index.html'; return null; }
}

// ── SETTINGS HELPER ───────────────────────────────────────
// Safer than upsert — avoids needing a composite unique constraint.
async function upsertSetting(key, value) {
  const row = { key, value };
  if (currentClubId) row.club_id = currentClubId;

  // Single atomic INSERT … ON CONFLICT (key) DO UPDATE.
  // Avoids the race between a failed UPDATE and a conflicting INSERT.
  const { error } = await db.from('settings').upsert(row, { onConflict: 'key' });
  if (!error) return;

  // If the upsert is blocked by RLS on an old NULL-club_id row,
  // fall back to a plain UPDATE by key which the DB will allow.
  await db.from('settings').update({ value }).eq('key', key);
}

// ── AUTO-MATCH ALGORITHM ──────────────────────────────────
async function autoMatch(silent = false) {
  const { data: freshPlayers, error: pe } = await withClub(db.from('players').select('*'));
  const { data: freshCourts, error: ce } = await withClub(db.from('courts').select('*').eq('is_active', true));
  
  if (pe || ce) {
    if (!silent) toast('Auto-match error: could not read database.', 'error');
    return false;
  }
  if (!freshPlayers || !freshCourts) return false;

  const openCourt = freshCourts.find(c => !c.player_ids || c.player_ids.length < 4);
  if (!openCourt) {
    if (!silent) toast('No open courts available.', 'warn');
    return false;
  }

  const activeCourtCount = freshCourts.length || 1;
  let assignmentCycle = 0;

  const { data: cycleRow } = await withClub(
    db.from('settings').select('value').eq('key', 'assignment_cycle')
  ).maybeSingle();

  if (cycleRow) {
    assignmentCycle = parseInt(cycleRow.value || 0);
  }

  let waiting = freshPlayers.filter(p => p.status === 'waiting');
  if (waiting.length < 4) {
    if (!silent) toast('Not enough players waiting — need at least 4.', 'warn');
    return false;
  }

  // 1. Anti-back-to-back filter
  let eligible = waiting.filter(p => {
    const lastCycle = p.last_assignment_cycle || 0;
    return (assignmentCycle - lastCycle >= activeCourtCount);
  });

  // Fallback if there are not enough players who haven't played recently
  let usedFallback = false;
  if (eligible.length < 4) {
    eligible = waiting;
    usedFallback = true;
  }

  // 2. Safe, stable sorting logic (No random values)
  eligible.sort((a, b) => {
    if (usedFallback) {
      const cycleA = a.last_assignment_cycle || 0;
      const cycleB = b.last_assignment_cycle || 0;
      if (cycleA !== cycleB) return cycleA - cycleB;
    }

    if (a.games_played !== b.games_played) {
      return a.games_played - b.games_played;
    }

    const timeA = new Date(a.created_at).getTime();
    const timeB = new Date(b.created_at).getTime();
    return timeA - timeB;
  });

  const chosen = selectFourByLevel(eligible);
  assignmentCycle++;

  // Keep all counters in sync
  settings.assignment_cycle = assignmentCycle;
  assignmentCounter = assignmentCycle;

  await upsertSetting('assignment_cycle', String(assignmentCycle));

  await assignPlayersToCourt(
    openCourt.id,
    chosen.map(p => p.id),
    assignmentCycle
  );

  return true;
}

// ── PAIR HISTORY HELPERS ──────────────────────────────────
// Canonical key for any two player IDs (order-independent).
function pairKey(a, b) { return [a, b].sort().join(':'); }

function getPairCount(a, b) { return pairHistory[pairKey(a, b)] || 0; }

// Given 4 player IDs, return the split [[teamA_id1, teamA_id2], [teamB_id1, teamB_id2]]
// that minimises the maximum number of times either pair has played together.
function getBestPairing(ids) {
  const combos = [
    [[ids[0], ids[1]], [ids[2], ids[3]]],
    [[ids[0], ids[2]], [ids[1], ids[3]]],
    [[ids[0], ids[3]], [ids[1], ids[2]]],
  ];
  const score = ([a, b]) =>
    Math.max(getPairCount(a[0], a[1]), getPairCount(b[0], b[1])) * 1000
    + getPairCount(a[0], a[1]) + getPairCount(b[0], b[1]);
  return combos.reduce((best, c) => score(c) < score(best) ? c : best, combos[0]);
}

async function resetPairHistory() {
  pairHistory = {};
  await upsertSetting('pair_history', '{}');
}

async function assignPlayersToCourt(courtId, playerIds, assignmentCycle) {
  // Determine the teammate split that avoids over-repeating the same pairs.
  let orderedIds = playerIds;
  if (playerIds.length === 4) {
    const [teamA, teamB] = getBestPairing(playerIds);
    orderedIds = [...teamA, ...teamB];
    // Record this pairing in history
    const kA = pairKey(teamA[0], teamA[1]);
    const kB = pairKey(teamB[0], teamB[1]);
    pairHistory[kA] = (pairHistory[kA] || 0) + 1;
    pairHistory[kB] = (pairHistory[kB] || 0) + 1;
    // Persist asynchronously — don't block court assignment on a settings write
    upsertSetting('pair_history', JSON.stringify(pairHistory));
  }

  const { error: ce } = await db
    .from('courts')
    .update({ player_ids: orderedIds })
    .eq('id', courtId);

  if (ce) {
    toast('Court update failed.', 'error');
    return false;
  }

  const { error: pe } = await db
    .from('players')
    .update({
      status: 'playing',
      last_assignment_cycle: assignmentCycle
    })
    .in('id', playerIds);

  if (pe) {
    toast('Player update failed.', 'error');
    return false;
  }

  return true;
}

// ── UI UTILITIES ──────────────────────────────────────────
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function setLoading(id, on) {
  const btn = document.getElementById(id);
  if (!btn) return;
  if (on)  { btn.dataset.origText = btn.innerHTML; btn.innerHTML = '<span class="spinner"></span>'; btn.disabled = true; }
  else     { btn.innerHTML = btn.dataset.origText || btn.innerHTML; btn.disabled = false; }
}

function toast(msg, type) {
  type = type || 'success';
  const cfg = {
    success: { icon: '✓', accent: '#22c544', bg: 'rgba(13,40,18,0.97)', border: 'rgba(34,197,68,0.35)',  text: '#86ef9a', iconBg: 'rgba(34,197,68,0.15)',  label: 'Success' },
    warn:    { icon: '⚠', accent: '#eab308', bg: 'rgba(30,22,4,0.97)',  border: 'rgba(234,179,8,0.35)',  text: '#fde047', iconBg: 'rgba(234,179,8,0.15)',  label: 'Notice'  },
    error:   { icon: '✕', accent: '#ef4444', bg: 'rgba(30,8,8,0.97)',   border: 'rgba(239,68,68,0.35)',  text: '#fca5a5', iconBg: 'rgba(239,68,68,0.15)',  label: 'Error'   },
  };
  const c = cfg[type] || cfg.success;

  const el = document.createElement('div');
  el.setAttribute('role', 'alert');
  el.style.cssText = `
    pointer-events:auto; display:flex; align-items:flex-start; gap:10px;
    padding:12px 12px 14px 12px; border-radius:14px;
    border:1px solid ${c.border}; background:${c.bg};
    backdrop-filter:blur(16px); -webkit-backdrop-filter:blur(16px);
    box-shadow:0 12px 40px rgba(0,0,0,0.5),0 2px 8px rgba(0,0,0,0.3),inset 0 1px 0 rgba(255,255,255,0.04);
    max-width:300px; min-width:220px; position:relative; overflow:hidden;
    animation:toast-in .38s cubic-bezier(.34,1.56,.64,1) forwards;
  `;

  const iconEl = document.createElement('div');
  iconEl.style.cssText = `
    width:30px; height:30px; border-radius:8px; flex-shrink:0;
    background:${c.iconBg}; color:${c.accent};
    display:flex; align-items:center; justify-content:center;
    font-size:14px; font-weight:900; margin-top:1px;
  `;
  iconEl.textContent = c.icon;

  const body = document.createElement('div');
  body.style.cssText = 'flex:1; min-width:0; padding-top:2px;';
  body.innerHTML = `
    <div style="font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:${c.accent};opacity:.8;margin-bottom:2px;">${c.label}</div>
    <div style="font-size:13px;font-weight:500;color:${c.text};line-height:1.45;">${msg}</div>
  `;

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = `
    flex-shrink:0; background:none; border:none; cursor:pointer; padding:2px 2px 0 0;
    font-size:18px; line-height:1; color:rgba(255,255,255,0.25); transition:color .15s;
  `;
  closeBtn.onmouseenter = () => { closeBtn.style.color = 'rgba(255,255,255,0.7)'; };
  closeBtn.onmouseleave = () => { closeBtn.style.color = 'rgba(255,255,255,0.25)'; };

  const bar = document.createElement('div');
  bar.style.cssText = `
    position:absolute; bottom:0; left:0; height:3px;
    background:${c.accent}; opacity:0.5; border-radius:0 0 0 14px;
    animation:toast-bar 3.5s linear forwards;
  `;

  el.appendChild(iconEl);
  el.appendChild(body);
  el.appendChild(closeBtn);
  el.appendChild(bar);

  const container = document.getElementById('toast-container');
  if (!container) return;
  container.appendChild(el);

  const dismiss = () => {
    clearTimeout(timer);
    el.style.animation = 'toast-out .28s ease forwards';
    setTimeout(() => el.remove(), 280);
  };
  closeBtn.addEventListener('click', dismiss);
  const timer = setTimeout(dismiss, 3500);
}

// Shared CSS injected into <head> by each page on load
function injectSharedStyles() {
  const style = document.createElement('style');
  style.textContent = `
    * { font-family: 'DM Sans', sans-serif; }
    body {
      background-color: #0d1a0d;
      background-image:
        radial-gradient(ellipse at 20% 0%,  rgba(34,197,68,0.12) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 100%, rgba(34,197,68,0.08) 0%, transparent 50%);
      min-height: 100vh;
    }
    .display-font { font-family: 'Bebas Neue', cursive; }
    .court-card {
      background-image:
        linear-gradient(rgba(34,197,68,0.06) 1px, transparent 1px),
        linear-gradient(90deg, rgba(34,197,68,0.06) 1px, transparent 1px);
      background-size: 24px 24px;
    }
    @keyframes pulse-dot { 0%,100%{opacity:1} 50%{opacity:.4} }
    .live-dot { animation: pulse-dot 1.5s ease-in-out infinite; }
    @keyframes toast-in  { from{transform:translateX(110%) scale(.92);opacity:0} to{transform:translateX(0) scale(1);opacity:1} }
    @keyframes toast-out { from{transform:translateX(0);opacity:1;max-height:120px;margin-bottom:0} to{transform:translateX(110%);opacity:0;max-height:0;margin-bottom:-8px} }
    @keyframes toast-bar { from{width:100%} to{width:0%} }
    .waitlist-row:hover { background: rgba(34,197,68,0.06); }
    ::-webkit-scrollbar { width: 6px; }
    ::-webkit-scrollbar-track { background: #0d1a0d; }
    ::-webkit-scrollbar-thumb { background: #166528; border-radius: 3px; }
    .input-glow:focus { outline: none; box-shadow: 0 0 0 2px rgba(34,197,68,0.5); }
    .spinner { border:2px solid rgba(34,197,68,0.2); border-top-color:#22c544; border-radius:50%; width:16px; height:16px; animation:spin .6s linear infinite; display:inline-block; }
    @keyframes spin { to{transform:rotate(360deg)} }
    @keyframes glow-pulse {
      0%,100% { box-shadow: 0 0 0 0 rgba(34,197,68,0.25); }
      50%      { box-shadow: 0 0 0 8px rgba(34,197,68,0); }
    }
    .up-next-banner { animation: glow-pulse 2.8s ease-in-out infinite; }
    .up-next-player { animation: pop-in 0.35s ease forwards; }
    @keyframes shine { 0%{transform:translateX(-120%)} 60%{transform:translateX(120%)} 100%{transform:translateX(120%)} }
    .shine-sweep::after {
      content:''; position:absolute; inset:0;
      background: linear-gradient(105deg, transparent 40%, rgba(34,197,68,0.08) 50%, transparent 60%);
      animation: shine 4s ease-in-out infinite; pointer-events:none;
    }
    @keyframes badge-blink { 0%,100%{opacity:1} 50%{opacity:0.5} }
    .on-deck-badge { animation: badge-blink 1.2s ease-in-out infinite; }
  `;
  document.head.appendChild(style);
}