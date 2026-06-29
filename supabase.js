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
let players  = [];
let courts   = [];
let settings = { min_players: 2, max_players: 30, assignment_cycle: 0 }; // defaults; overridden from DB

// ── DATA FETCHERS ─────────────────────────────────────────
async function fetchPlayers() {
  const { data, error } = await db.from('players').select('*')
    .order('games_played', { ascending: true })
    .order('created_at',   { ascending: true });
  if (!error) players = data || [];
}

async function fetchCourts() {
  const { data, error } = await db.from('courts').select('*')
    .eq('is_active', true).order('created_at', { ascending: true });
  if (!error) courts = data || [];
}

async function fetchSettings() {
  const { data, error } = await db.from('settings').select('*');
  if (!error && data) {
    data.forEach(row => {
      if (row.key === 'min_players') settings.min_players = parseInt(row.value) || 2;
      if (row.key === 'max_players') settings.max_players = parseInt(row.value) || 30;
      if (row.key === 'assignment_cycle') settings.assignment_cycle = parseInt(row.value) || 0;
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

// ── AUTO-MATCH ALGORITHM ──────────────────────────────────
async function autoMatch(silent = false) {
  const { data: freshPlayers, error: pe } = await db.from('players').select('*');
  const { data: freshCourts, error: ce } = await db.from('courts').select('*').eq('is_active', true);
  
  if (pe || ce || !freshPlayers || !freshCourts) return false;

  const openCourt = freshCourts.find(c => !c.player_ids || c.player_ids.length < 4);
  if (!openCourt) {
    if (!silent) toast('No open courts.', 'warn');
    return false;
  }

  const activeCourtCount = freshCourts.length || 1;
  let assignmentCycle = 0;

  const { data: cycleRow } = await db
    .from('settings')
    .select('value')
    .eq('key', 'assignment_cycle')
    .single();

  if (cycleRow) {
    assignmentCycle = parseInt(cycleRow.value || 0);
  }

  let waiting = freshPlayers.filter(p => p.status === 'waiting');
  if (waiting.length < 4) return false;

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

  // Update master settings memory cache
  settings.assignment_cycle = assignmentCycle;

  await db
    .from('settings')
    .upsert({
      key: 'assignment_cycle',
      value: String(assignmentCycle)
    }, { onConflict: 'key' });

  await assignPlayersToCourt(
    openCourt.id,
    chosen.map(p => p.id),
    assignmentCycle
  );

  return true;
}

async function assignPlayersToCourt(courtId, playerIds, assignmentCycle) {
  const { error: ce } = await db
    .from('courts')
    .update({ player_ids: playerIds })
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
  const colors = {
    success: 'bg-pickle-900 border-pickle-700 text-pickle-300',
    warn:    'bg-yellow-950 border-yellow-800 text-yellow-300',
    error:   'bg-red-950  border-red-800    text-red-300',
  };
  const el = document.createElement('div');
  el.className = 'toast pointer-events-auto border rounded-xl px-4 py-2.5 text-sm font-medium shadow-xl ' + (colors[type] || colors.success);
  el.innerHTML = msg;
  const container = document.getElementById('toast-container');
  if (container) { container.appendChild(el); setTimeout(() => el.remove(), 3500); }
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
    @keyframes slide-up { from{transform:translateY(20px);opacity:0} to{transform:translateY(0);opacity:1} }
    .toast { animation: slide-up 0.3s ease; }
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