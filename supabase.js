// ════════════════════════════════════════════════════════════
// supabase.js — API credentials + shared state & utilities
// Used by both index.html (players) and admin.html (admin)
// ════════════════════════════════════════════════════════════

// ┌─────────────────────────────────────────────────────────┐
// │  FILL IN YOUR SUPABASE CREDENTIALS BELOW               │
// └─────────────────────────────────────────────────────────┘
const SUPABASE_URL   = window.SUPABASE_URL || localStorage.getItem('SUPABASE_URL') || '';
const SUPABASE_ANON  = window.SUPABASE_ANON || localStorage.getItem('SUPABASE_ANON') || '';
const ADMIN_PASSWORD = window.ADMIN_PASSWORD || localStorage.getItem('ADMIN_PASSWORD') || '';

// ── DB SCHEMA ─────────────────────────────────────────────
// players:
//   id           uuid        pk default gen_random_uuid()
//   name         text        not null
//   games_played int         default 0
//   status       text        default 'waiting'   -- 'waiting' | 'playing'
//   created_at   timestamptz default now()
//
// courts:
//   id           uuid        pk default gen_random_uuid()
//   name         text        not null
//   player_ids   uuid[]      default '{}'
//   is_active    boolean     default true
//   created_at   timestamptz default now()
//
// settings:                  ← used for min/max player limits
//   key          text        pk
//   value        text
//
//   INSERT INTO settings (key,value) VALUES ('min_players','2'),('max_players','30');
//
// Enable Realtime on players, courts, and settings in Supabase!

const { createClient } = supabase;
const db = createClient(SUPABASE_URL, SUPABASE_ANON);

// ── SHARED STATE ──────────────────────────────────────────
let players  = [];
let courts   = [];
let settings = { min_players: 2, max_players: 30 }; // defaults; overridden from DB

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
    });
  }
}

// ── SHARED HELPERS ────────────────────────────────────────
function getPlayer(id) { return players.find(p => p.id === id); }

// Returns next 4 player IDs in deterministic priority order:
// 0-game players first (by join time), then fewest games (by join time)
function getNextFourIds(waitingPool) {
  const sorted = [...waitingPool].sort((a, b) => {
    if (a.games_played !== b.games_played) return a.games_played - b.games_played;
    return new Date(a.created_at) - new Date(b.created_at);
  });
  return sorted.slice(0, 4).map(p => p.id);
}

// ── AUTO-MATCH ALGORITHM ──────────────────────────────────
//
//  TIER 1 — 0-game players ALWAYS first (pure random among them).
//  TIER 2 — Exponential decay: weight = 0.2 ^ (games - minG)
//           minG+0 = 100%, +1 = 20%, +2 = 4%, +3 = 0.8%
//  TIER 3 — Tiebreak by earliest join time (up to +10% bonus).
//
//  silent=true  → auto-triggered (suppresses spinner, different toast)
//  silent=false → manual "Force Now" button press
//
async function autoMatch(silent) {
  if (silent === undefined) silent = false;

  const openCourt = courts.find(c => !c.player_ids || c.player_ids.length < 4);
  if (!openCourt) {
    if (!silent) toast('No open courts available!', 'warn');
    return false;
  }

  const waiting = players.filter(p => p.status === 'waiting');
  if (waiting.length < 4) {
    if (!silent) toast('Need at least 4 waiting players (have ' + waiting.length + ').', 'warn');
    return false;
  }

  if (!silent) setLoading('auto-match-btn', true);

  function weightedPick(pool) {
    const total = pool.reduce((s, p) => s + p.weight, 0);
    let rng = Math.random() * total;
    for (const p of pool) { rng -= p.weight; if (rng <= 0) return p; }
    return pool[pool.length - 1];
  }

  const picked = [];
  let pool = [...waiting];

  for (let i = 0; i < 4; i++) {
    const fresh = pool.filter(p => p.games_played === 0);
    let weighted;
    if (fresh.length > 0) {
      weighted = fresh.map(p => ({ ...p, weight: 1 }));
    } else {
      const minG     = Math.min(...pool.map(p => p.games_played));
      const earliest = Math.min(...pool.map(p => new Date(p.created_at).getTime()));
      weighted = pool.map(p => {
        const gameWeight = Math.pow(0.2, p.games_played - minG);
        const ageSecs    = (new Date(p.created_at).getTime() - earliest) / 1000;
        const ageBonus   = 1 + Math.max(0, 1 - ageSecs / 3600) * 0.1;
        return { ...p, weight: gameWeight * ageBonus };
      });
    }
    const chosen = weightedPick(weighted);
    picked.push(chosen);
    pool = pool.filter(p => p.id !== chosen.id);
  }

  await assignPlayersToCourt(openCourt.id, picked.map(p => p.id));

  const names = picked.map(p => p.name).join(', ');
  const stEl  = document.getElementById('automatch-status');
  if (stEl) stEl.textContent = 'Last match: ' + names + ' \u2192 ' + openCourt.name;

  if (!silent) {
    setLoading('auto-match-btn', false);
    toast('Matched! ' + names + ' \u2192 ' + openCourt.name, 'success');
  } else {
    toast('\u26A1 Auto-matched \u2192 ' + openCourt.name + ': ' + names, 'success');
  }
  return true;
}

async function assignPlayersToCourt(courtId, playerIds) {
  const { error: ce } = await db.from('courts').update({ player_ids: playerIds }).eq('id', courtId);
  if (ce) { toast('Error assigning to court.', 'error'); return false; }
  const { error: pe } = await db.from('players').update({ status: 'playing' }).in('id', playerIds);
  if (pe) { toast('Error updating player status.', 'error'); return false; }
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
    @keyframes pop-in { from{transform:scale(0.88);opacity:0} to{transform:scale(1);opacity:1} }
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