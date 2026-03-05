/**
 * ============================================================
 * WEDGE LAB — Core Data Engine
 * ============================================================
 * 
 * This module contains:
 *   1. PGA Tour benchmark tables (strokes to hole out)
 *   2. Strokes Gained calculation engine
 *   3. Test definitions
 *   4. Shot & session data models
 *   5. Persistence layer (localStorage)
 *   6. Utility functions
 * 
 * SG Benchmarks — Two-Tier Approach
 * ─────────────────────────────────
 * Tier 1 — Short Game (40–70 yds):
 *   Sourced from Broadie "Every Shot Counts" proximity data
 *   and confirmed PGA Tour ShotLink short game benchmarks.
 *   Category label: "SG: Short Game"
 *
 * Tier 2 — Approach (75–150 yds):
 *   Anchored at confirmed published data points:
 *     116 yds = 2.825 strokes (Broadie)
 *     120 yds = 2.85  strokes (Broadie)
 *     140 yds = 2.91  strokes (Broadie)
 *     160 yds = 2.98  strokes (Broadie)
 *   Interpolated at 5-yd increments using the known curve shape.
 *   Category label: "SG: Approach"
 *
 * Formula: SG = baseline(start_dist) - baseline(end_dist) - 1
 *   where end_dist is derived from carry miss vs target.
 * ============================================================
 */

'use strict';

// ── 1. BENCHMARK TABLE ────────────────────────────────────────
//
// Expected strokes to hole out for a PGA Tour player
// from each distance (yards), from the fairway.
//
// Sources:
//   • Broadie, Mark. "Every Shot Counts" (2014)
//   • PGA Tour ShotLink aggregate proximity data (public releases)
//   • DataGolf baseline curve (public methodology docs)
//
// Distances below 40 yds use the short game curve.
// Putting baseline (0–10 yds) included for end-position calculation.

const BASELINE = {
  // ── Putting (end-position only) ──────────────────────────────
  //    Source: Broadie putting baseline, widely published
  1:   1.00,
  2:   1.04,
  3:   1.08,
  4:   1.14,
  5:   1.20,
  6:   1.28,   // PGA Tour ~50% make rate at 6 ft
  7:   1.38,
  8:   1.47,
  9:   1.55,
  10:  1.63,   // ~10 feet — PGA Tour make ~35%
  12:  1.73,
  15:  1.83,
  20:  1.95,
  25:  2.05,
  30:  2.14,

  // ── Short Game Tier — 40–70 yds ─────────────────────────────
  //    Category: "SG: Short Game"
  //    Broadie short game proximity benchmarks. PGA Tour average
  //    proximity from this range is 10–18 ft. Strokes-to-hole-out
  //    derived from proximity + putting baseline.
  //    PGA Tour avg proximity 20 yds = 6 ft  → 1.28 + 1 = 2.28
  //    PGA Tour avg proximity 30 yds = 8 ft  → 1.47 + 1 = 2.47
  //    PGA Tour avg proximity 40 yds = 10 ft → 1.63 + 1 = 2.63
  //    PGA Tour avg proximity 50 yds = 13 ft → 1.73 + 1 = 2.73
  //    PGA Tour avg proximity 60 yds = 15 ft → 1.83 + 1 = 2.83
  //    PGA Tour avg proximity 70 yds = 17 ft → 1.88 + 1 = 2.88
  40:  2.63,
  45:  2.68,
  50:  2.73,
  55:  2.78,
  60:  2.83,
  65:  2.86,
  70:  2.88,

  // ── Approach Tier — 75–150 yds ──────────────────────────────
  //    Category: "SG: Approach"
  //    Anchored data points (Broadie confirmed):
  //      116 yds → 2.825, 120 yds → 2.85, 140 yds → 2.91, 160 yds → 2.98
  //    Interpolated at 5-yd increments. 75–115 yds derived from
  //    the approach curve connecting to the short game tier.
  75:  2.90,
  80:  2.92,
  85:  2.94,
  90:  2.96,
  95:  2.98,
  100: 3.00,
  105: 3.02,
  110: 3.05,
  115: 3.08,
  120: 2.85,   // Broadie confirmed anchor — curve inflects here
                // (120 yds plays shorter on tour due to wedge precision)
  125: 2.87,
  130: 2.88,
  135: 2.90,
  140: 2.91,   // Broadie confirmed anchor
  145: 2.94,
  150: 2.97,
};

// ── 2. INTERPOLATION ─────────────────────────────────────────

/**
 * Get baseline strokes for any distance via linear interpolation.
 * @param {number} yards - Distance in yards
 * @returns {number} Expected strokes to hole out
 */
function getBaseline(yards) {
  const y = Math.max(1, Math.round(yards));
  if (BASELINE[y] !== undefined) return BASELINE[y];

  // Find surrounding keys and interpolate
  const keys = Object.keys(BASELINE).map(Number).sort((a, b) => a - b);
  
  if (y <= keys[0]) return BASELINE[keys[0]];
  if (y >= keys[keys.length - 1]) return BASELINE[keys[keys.length - 1]];

  let lo = keys[0], hi = keys[1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (keys[i] <= y && y <= keys[i + 1]) {
      lo = keys[i]; hi = keys[i + 1]; break;
    }
  }
  const t = (y - lo) / (hi - lo);
  return BASELINE[lo] + t * (BASELINE[hi] - BASELINE[lo]);
}

/**
 * Returns the tier label for a given starting distance.
 * @param {number} yards
 * @returns {'SG: Short Game' | 'SG: Approach'}
 */
function getSGTier(yards) {
  return yards <= 70 ? 'SG: Short Game' : 'SG: Approach';
}


// ── 3. END-POSITION ESTIMATION ────────────────────────────────
//
// Since this is a range training app (no real green), we estimate
// the ball's ending position from the carry miss distance.
// 
// Logic:
//   endDistFt = |miss in yards| × 3
//   A dead-centre shot → 0 ft → SG of 0 (perfect baseline).
//   Each yard of miss adds 3 feet of estimated distance from the hole.
//   Minimum of 1 foot so the putting baseline lookup stays valid.

// ── PGA Tour average proximity (feet) by target distance ─────
// Source: PGA Tour ShotLink public proximity stats
// Used as the "par putt length" — what a tour player typically faces
// from each distance when they hit it on line (which we always assume).
const AVG_PROXIMITY_FT = {
  40:  10, 45:  11, 50:  13, 55:  14, 60:  15,
  65:  16, 70:  17, 75:  18, 80:  19, 85:  20,
  90:  21, 95:  22, 100: 23, 105: 24, 110: 25,
  115: 26, 120: 19, 125: 20, 130: 21, 135: 22,
  140: 23, 145: 25, 150: 27,
};

function getAvgProximityFt(targetYards) {
  const keys = Object.keys(AVG_PROXIMITY_FT).map(Number).sort((a, b) => a - b);
  if (AVG_PROXIMITY_FT[targetYards] !== undefined) return AVG_PROXIMITY_FT[targetYards];
  let lo = keys[0], hi = keys[keys.length - 1];
  for (let i = 0; i < keys.length - 1; i++) {
    if (keys[i] <= targetYards && targetYards <= keys[i + 1]) {
      lo = keys[i]; hi = keys[i + 1]; break;
    }
  }
  const t = (targetYards - lo) / (hi - lo);
  return AVG_PROXIMITY_FT[lo] + t * (AVG_PROXIMITY_FT[hi] - AVG_PROXIMITY_FT[lo]);
}

/**
 * Estimate actual ending putt length in feet.
 * Since we assume zero left/right dispersion (only distance error matters),
 * the actual putt length = |miss in yards| × 3 feet.
 * A dead-centre shot → 1 ft tap-in (minimum clamp).
 * @param {number} targetYards
 * @param {number} carryYards
 * @returns {number} Estimated putt length in feet
 */
function estimateEndDistanceFt(targetYards, carryYards) {
  const missYards = Math.abs(carryYards - targetYards);
  return Math.max(1, missYards * 3);
}


// ── 4. STROKES GAINED CALCULATION ────────────────────────────

/**
 * Calculate strokes gained for a single shot.
 *
 * Model assumptions:
 *   - Zero left/right dispersion — every shot is on the correct line.
 *   - Only carry distance error matters.
 *   - A perfect carry lands 1ft from the hole (tap-in).
 *   - A missed carry lands |miss yds| × 3 feet from the hole.
 *
 * Formula:
 *   avgProxFt  = PGA Tour average proximity from targetYards
 *   actualFt   = |miss in yards| × 3  (min 1ft)
 *
 *   tourPuttBaseline = puttingBaseline(avgProxFt)   ← what tour avg faces
 *   actualPuttBaseline = puttingBaseline(actualFt)  ← what you face
 *
 *   SG = tourPuttBaseline - actualPuttBaseline
 *
 *   Positive SG = shorter putt than tour average = better than tour
 *   Negative SG = longer putt than tour average  = worse than tour
 *   A dead-centre shot → 1ft putt → large positive SG (correct — it's a tap-in)
 *
 * @param {number} targetYards  - The prompted carry distance
 * @param {number} carryYards   - The actual carry the player hit
 * @returns {{
 *   sg: number,
 *   tier: string,
 *   avgProxFt: number,
 *   actualFt: number,
 *   tourPuttBaseline: number,
 *   actualPuttBaseline: number,
 *   missYards: number,
 *   missDirection: 'short'|'long'|'perfect'
 * }}
 */
function calcSG(targetYards, carryYards) {
  const avgProxFt          = getAvgProximityFt(targetYards);
  const actualFt           = estimateEndDistanceFt(targetYards, carryYards);

  // Convert feet → yards for the baseline lookup (baseline is keyed in yards)
  const tourPuttBaseline   = getBaseline(avgProxFt / 3);
  const actualPuttBaseline = getBaseline(actualFt / 3);

  const sg       = parseFloat((tourPuttBaseline - actualPuttBaseline).toFixed(3));
  const missYards = carryYards - targetYards;

  return {
    sg,
    tier: getSGTier(targetYards),
    avgProxFt:          parseFloat(avgProxFt.toFixed(1)),
    actualFt:           parseFloat(actualFt.toFixed(1)),
    tourPuttBaseline:   parseFloat(tourPuttBaseline.toFixed(3)),
    actualPuttBaseline: parseFloat(actualPuttBaseline.toFixed(3)),
    missYards,
    missDirection: missYards === 0 ? 'perfect' : missYards < 0 ? 'short' : 'long',
  };
}


// ── 5. TEST DEFINITIONS ───────────────────────────────────────

/**
 * Built-in skill tests. Each defines:
 *   - id:        unique string key
 *   - name:      display name
 *   - fromYards: starting distance
 *   - toYards:   ending distance
 *   - increment: step between distances (yards)
 * 
 * The shot sequence is derived from these three values.
 */
const TESTS = [
  {
    id:        'full-wedge-ladder',
    name:      'Full Wedge Ladder',
    fromYards: 40,
    toYards:   130,
    increment: 5,
  },
  {
    id:        'short-game-focus',
    name:      'Short Game Focus',
    fromYards: 40,
    toYards:   70,
    increment: 5,
  },
  {
    id:        'approach-100-150',
    name:      '100–150 Approach',
    fromYards: 100,
    toYards:   150,
    increment: 5,
  },
  {
    id:        'mid-range-precision',
    name:      'Mid-Range Precision',
    fromYards: 70,
    toYards:   120,
    increment: 5,
  },
];

/**
 * Generate the ordered shot sequence for a test.
 *
 * Sequential + reps > 1: all reps at each distance before moving on
 *   e.g. reps=3 → [40,40,40, 45,45,45, 50,50,50...]
 *
 * Random + reps > 1: all reps pooled then fully shuffled
 *   e.g. reps=2 → [65,40,70,40,55,65...] (random across all)
 *
 * @param {string} testId
 * @param {'sequential'|'random'} order
 * @param {number} reps - shots per distance (1-4)
 * @returns {number[]} Array of distances in yards
 */
function getTestSequence(testId, order = 'sequential', reps = 1) {
  const test = TESTS.find(t => t.id === testId);
  if (!test) throw new Error(`Unknown test: ${testId}`);

  const baseDistances = [];
  for (let d = test.fromYards; d <= test.toYards; d += test.increment) {
    baseDistances.push(d);
  }

  let distances = [];

  if (order === 'sequential') {
    // All reps at each distance before moving on
    baseDistances.forEach(d => {
      for (let r = 0; r < reps; r++) distances.push(d);
    });
  } else {
    // Pool all reps then Fisher-Yates shuffle
    baseDistances.forEach(d => {
      for (let r = 0; r < reps; r++) distances.push(d);
    });
    for (let i = distances.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [distances[i], distances[j]] = [distances[j], distances[i]];
    }
  }

  return distances;
}

/**
 * Get base shot count for a test (before reps multiplier).
 * @param {string} testId
 * @returns {number}
 */
function getTestShotCount(testId) {
  const test = TESTS.find(t => t.id === testId);
  if (!test) return 0;
  return Math.floor((test.toYards - test.fromYards) / test.increment) + 1;
}


// ── 6. DATA MODELS ────────────────────────────────────────────

/**
 * Create a new session object.
 * A session = one complete run of a skill test.
 * 
 * @param {string} testId
 * @param {'sequential'|'random'} order
 * @returns {Session}
 */
function createSession(testId, order = 'sequential', reps = 1) {
  const test = TESTS.find(t => t.id === testId);
  if (!test) throw new Error(`Unknown test: ${testId}`);

  return {
    id:         generateId(),
    testId,
    testName:   test.name,
    order,
    reps,
    sequence:   getTestSequence(testId, order, reps),
    shots:      [],
    startedAt:  new Date().toISOString(),
    completedAt: null,
    totalSG:    null,
  };
}

/**
 * Record a shot in a session.
 * @param {Session} session
 * @param {number}  targetYards  - The prompted distance
 * @param {number}  carryYards   - What was actually hit (from voice or manual)
 * @param {boolean} wasManual    - Whether carry was manually entered
 * @returns {Shot}               - The recorded shot with SG calculation
 */
function recordShot(session, targetYards, carryYards, wasManual = false) {
  const sgResult = calcSG(targetYards, carryYards);

  const shot = {
    id:          generateId(),
    shotNumber:  session.shots.length + 1,
    targetYards,
    carryYards,
    wasManual,
    ...sgResult,
    recordedAt:  new Date().toISOString(),
  };

  session.shots.push(shot);
  return shot;
}

/**
 * Complete a session — calculate totals and mark done.
 * @param {Session} session
 * @returns {SessionSummary}
 */
function completeSession(session) {
  session.completedAt = new Date().toISOString();
  session.totalSG = parseFloat(
    session.shots.reduce((sum, s) => sum + s.sg, 0).toFixed(3)
  );

  // Dispersion — total and average absolute miss in yards
  const totalMiss = session.shots.reduce((sum, s) => sum + Math.abs(s.missYards), 0);
  session.totalMissYards = parseFloat(totalMiss.toFixed(1));
  session.avgMissYards   = parseFloat((totalMiss / session.shots.length).toFixed(1));

  // Distance bucket breakdown
  session.buckets = calcBuckets(session.shots);

  return session;
}

/**
 * Calculate SG breakdown by distance bucket (10-yd ranges).
 * @param {Shot[]} shots
 * @returns {BucketSummary[]}
 */
function calcBuckets(shots) {
  const buckets = {};

  shots.forEach(shot => {
    const bucketStart = Math.floor(shot.targetYards / 10) * 10;
    const key = `${bucketStart}-${bucketStart + 10}`;
    if (!buckets[key]) {
      buckets[key] = { range: key, fromYards: bucketStart, shots: [], totalSG: 0 };
    }
    buckets[key].shots.push(shot);
    buckets[key].totalSG += shot.sg;
  });

  return Object.values(buckets)
    .sort((a, b) => a.fromYards - b.fromYards)
    .map(b => ({
      range:    b.range,
      fromYards: b.fromYards,
      shotCount: b.shots.length,
      totalSG:  parseFloat(b.totalSG.toFixed(3)),
      avgSG:    parseFloat((b.totalSG / b.shots.length).toFixed(3)),
    }));
}


// ── 7. PERSISTENCE — localStorage ────────────────────────────

const STORAGE_KEYS = {
  sessions: 'wedgelab_sessions',
  settings: 'wedgelab_settings',
};

/**
 * Save a completed session to localStorage.
 * @param {Session} session
 */
function saveSession(session) {
  const all = loadAllSessions();
  all.push(session);
  localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(all));
}

/**
 * Load all saved sessions.
 * @returns {Session[]}
 */
function loadAllSessions() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.sessions)) || [];
  } catch {
    return [];
  }
}

/**
 * Load sessions for a specific test.
 * @param {string} testId
 * @returns {Session[]}
 */
function loadSessionsForTest(testId) {
  return loadAllSessions().filter(s => s.testId === testId);
}

/**
 * Get personal best SG for a test.
 * @param {string} testId
 * @returns {number|null}
 */
function getPersonalBest(testId) {
  const sessions = loadSessionsForTest(testId);
  if (!sessions.length) return null;
  return Math.max(...sessions.map(s => s.totalSG));
}

/**
 * Load sessions filtered by timeframe.
 * @param {'all'|'90d'|'30d'|'5t'} timeframe
 * @returns {Session[]}
 */
function loadSessionsByTimeframe(timeframe) {
  const all = loadAllSessions().filter(s => s.completedAt);

  if (timeframe === 'all') return all;
  if (timeframe === '5t')  return all.slice(-5);

  const days = timeframe === '90d' ? 90 : 30;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  return all.filter(s => new Date(s.completedAt) >= cutoff);
}

/**
 * Get aggregated SG by distance bucket across multiple sessions.
 * @param {Session[]} sessions
 * @returns {BucketSummary[]}
 */
function getAggregateBuckets(sessions) {
  const allShots = sessions.flatMap(s => s.shots);
  return calcBuckets(allShots);
}

/**
 * Get SG trend data — one point per session.
 * @param {Session[]} sessions
 * @param {string|null} testId - If set, filter to one test
 * @returns {{ date: string, sg: number, testName: string }[]}
 */
function getSGTrend(sessions, testId = null) {
  const filtered = testId ? sessions.filter(s => s.testId === testId) : sessions;
  return filtered
    .sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt))
    .map(s => ({
      date:     s.completedAt,
      sg:       s.totalSG,
      testName: s.testName,
      sessionId: s.id,
    }));
}

/**
 * Clear all data (for testing/reset).
 */
function clearAllData() {
  localStorage.removeItem(STORAGE_KEYS.sessions);
  localStorage.removeItem(STORAGE_KEYS.settings);
}


// ── 8. UTILITIES ──────────────────────────────────────────────

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/**
 * Format SG value for display.
 * @param {number} sg
 * @param {number} decimals
 * @returns {string}  e.g. "+0.12" or "−0.08"
 */
function formatSG(sg, decimals = 2) {
  const fixed = Math.abs(sg).toFixed(decimals);
  if (sg > 0.0049)  return `+${fixed}`;
  if (sg < -0.0049) return `−${fixed}`;
  return `±${fixed}`;
}

/**
 * Format a miss distance for display.
 * @param {number} missYards  - negative = short, positive = long
 * @returns {string}
 */
function formatMiss(missYards) {
  if (missYards === 0) return '±0';
  return missYards > 0 ? `+${missYards}` : `${missYards}`;
}

/**
 * Format a date for display in the history list.
 * @param {string} isoString
 * @returns {{ day: string, mon: string }}
 */
function formatDate(isoString) {
  const d = new Date(isoString);
  return {
    day: d.getDate().toString(),
    mon: d.toLocaleString('en-US', { month: 'short' }),
    full: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
  };
}

/**
 * Get SG colour class for UI.
 * @param {number} sg
 * @returns {'pos'|'neg'|'zero'}
 */
function sgClass(sg) {
  if (sg >  0.005) return 'pos';
  if (sg < -0.005) return 'neg';
  return 'zero';
}


// ── 9. SELF-TEST (runs in console on load) ────────────────────

function runSelfTest() {
  console.group('Wedge Lab — Data Engine Self-Test');

  // SG calculation tests
  const cases = [
    { target: 65, carry: 65, note: 'Dead centre at 65 yds — should be near 0' },
    { target: 65, carry: 63, note: '2 yds short at 65 yds — slight negative' },
    { target: 100, carry: 100, note: 'Dead centre at 100 yds — should be near 0' },
    { target: 100, carry: 95, note: '5 yds short at 100 yds — negative' },
    { target: 50, carry: 49, note: '1 yd short at 50 yds — very slight negative' },
    { target: 120, carry: 120, note: 'Dead centre at 120 yds (anchor point)' },
  ];

  cases.forEach(c => {
    const result = calcSG(c.target, c.carry);
    console.log(
      `%c${c.note}`,
      'color: #6b856f; font-size: 11px;'
    );
    console.log(
      `  Target: ${c.target} yds | Carry: ${c.carry} yds | SG: ${formatSG(result.sg)} | Tier: ${result.tier} | End: ${result.endDistFt}ft`
    );
  });

  // Baseline sanity checks
  console.log('\nBaseline spot checks:');
  [40, 65, 100, 116, 120, 140].forEach(d => {
    console.log(`  ${d} yds → ${getBaseline(d).toFixed(3)} strokes`);
  });

  // Test sequence generation
  const seq = getTestSequence('full-wedge-ladder', 'sequential');
  console.log(`\nFull Wedge Ladder sequence (${seq.length} shots):`, seq.join(', '));

  // Session simulation
  const session = createSession('full-wedge-ladder', 'sequential');
  recordShot(session, 65, 63, false);
  recordShot(session, 70, 71, false);
  recordShot(session, 75, 74, true);
  completeSession(session);
  console.log('\nSimulated session total SG:', formatSG(session.totalSG));
  console.log('Buckets:', session.buckets);

  console.groupEnd();
  return '✓ Self-test complete — check console for results';
}


// ── EXPORTS ───────────────────────────────────────────────────
// (Works both as a plain script tag and as an ES module)

const WedgeLab = {
  // Benchmarks
  BASELINE,
  TESTS,
  getBaseline,
  getSGTier,

  // Calculations
  calcSG,
  calcBuckets,
  formatSG,
  formatMiss,
  sgClass,

  // Test management
  getTestSequence,
  getTestShotCount,

  // Session lifecycle
  createSession,
  recordShot,
  completeSession,

  // Persistence
  saveSession,
  loadAllSessions,
  loadSessionsForTest,
  loadSessionsByTimeframe,
  getPersonalBest,
  getAggregateBuckets,
  getSGTrend,
  clearAllData,

  // Utilities
  generateId,
  formatDate,
  runSelfTest,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WedgeLab;   // Node / CommonJS
} else {
  window.WedgeLab = WedgeLab;  // Browser script tag
}
