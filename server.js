'use strict';

/**
 * ============================================================
 * WEDGELAB — Express Server
 * ============================================================
 * 
 * Routes:
 * 
 *   Static
 *     GET  /                        → challenge-setup.html
 *     GET  /distance                → distance-setup.html  (future)
 * 
 *   Short Game API
 *     POST /api/shortgame/round     → save a completed round
 *     GET  /api/shortgame/history   → all rounds (with timeframe filter)
 *     GET  /api/shortgame/round/:id → single round detail
 * 
 *   Distance Challenge API
 *     POST /api/distance/session    → save a completed session
 *     GET  /api/distance/history    → all sessions
 *     GET  /api/distance/session/:id→ single session detail
 * 
 * CSV files on Dropbox:
 *   shortgame_rounds.csv   — one row per round (summary)
 *   shortgame_shots.csv    — one row per shot
 *   distance_sessions.csv  — one row per session (summary)
 *   distance_shots.csv     — one row per shot
 * ============================================================
 */

require('dotenv').config();

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { readCSV, appendCSV, readJSON, writeJSON } = require('./dropbox');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Root redirect ─────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Health check ──────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ============================================================
// CUSTOM TESTS + HIDDEN TESTS (stored as JSON on Dropbox)
// ============================================================

app.get('/api/distance/custom-tests', async (req, res) => {
  try {
    const tests = await readJSON('wedgelab_custom_tests.json');
    res.json({ tests: tests || [] });
  } catch (err) {
    res.json({ tests: [] });
  }
});

app.post('/api/distance/custom-tests', async (req, res) => {
  try {
    await writeJSON('wedgelab_custom_tests.json', req.body.tests || []);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/distance/hidden-tests', async (req, res) => {
  try {
    const hidden = await readJSON('wedgelab_hidden_tests.json');
    res.json({ hidden: hidden || [] });
  } catch (err) {
    res.json({ hidden: [] });
  }
});

app.post('/api/distance/hidden-tests', async (req, res) => {
  try {
    await writeJSON('wedgelab_hidden_tests.json', req.body.hidden || []);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// SHORT GAME API
// ============================================================

// CSV column schemas
const SHORTGAME_ROUND_COLS = [
  'round_id', 'date', 'challenge', 'order',
  'total_shots', 'up_and_down_pct', 'avg_proximity_ft', 'avg_putts', 'total_strokes',
];

const SHORTGAME_SHOT_COLS = [
  'round_id', 'date', 'shot_number', 'shot_type', 'pin_position',
  'proximity_ft', 'putts', 'miss_direction', 'result',
];

/**
 * POST /api/shortgame/round
 * 
 * Body:
 * {
 *   challenge: 'Full Round',
 *   order: 'sequential' | 'random',
 *   shots: [
 *     {
 *       shot_type: 'Fairway Chip',
 *       pin_position: 'Short' | 'Middle' | 'Long',
 *       proximity_ft: 6,
 *       putts: 1,
 *       miss_direction: 'short' | 'long' | 'right' | 'left' | ... | 'on_target'
 *     },
 *     ...
 *   ]
 * }
 */
app.post('/api/shortgame/round', async (req, res) => {
  try {
    const { challenge, order, shots } = req.body;

    if (!challenge || !Array.isArray(shots) || shots.length === 0) {
      return res.status(400).json({ error: 'challenge and shots[] are required' });
    }

    const round_id  = generateId();
    const date      = new Date().toISOString();

    // Calculate round summary stats
    const upAndDowns   = shots.filter(s => s.putts <= 1).length;
    const upAndDownPct = Math.round((upAndDowns / shots.length) * 100);
    const avgProx      = avg(shots.map(s => Number(s.proximity_ft)));
    const avgPutts     = avg(shots.map(s => Number(s.putts)));
    const totalStrokes = shots.length + shots.reduce((sum, s) => sum + Number(s.putts), 0);

    // Build round summary row
    const roundRow = {
      round_id,
      date,
      challenge,
      order:             order || 'sequential',
      total_shots:       shots.length,
      up_and_down_pct:   upAndDownPct,
      avg_proximity_ft:  avgProx.toFixed(1),
      avg_putts:         avgPutts.toFixed(2),
      total_strokes:     totalStrokes,
    };

    // Build shot rows
    const shotRows = shots.map((s, i) => ({
      round_id,
      date,
      shot_number:    i + 1,
      shot_type:      s.shot_type,
      pin_position:   s.pin_position,
      proximity_ft:   s.proximity_ft,
      putts:          s.putts,
      miss_direction: s.miss_direction || 'on_target',
      result:         s.putts <= 1 ? 'up' : 'down',
    }));

    // Save to Dropbox
    await Promise.all([
      appendCSV('shortgame_rounds.csv', [roundRow], SHORTGAME_ROUND_COLS),
      appendCSV('shortgame_shots.csv',  shotRows,   SHORTGAME_SHOT_COLS),
    ]);

    res.json({ round_id, up_and_down_pct: upAndDownPct, total_strokes: totalStrokes });

  } catch (err) {
    console.error('POST /api/shortgame/round error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/shortgame/history
 * Query params:
 *   timeframe: '5' | 'month' | '6month' | 'all'  (default: 'all')
 *   challenge: 'Full Round' | ...                  (optional filter)
 */
app.get('/api/shortgame/history', async (req, res) => {
  try {
    const { timeframe = 'all', challenge } = req.query;

    let rounds = await readCSV('shortgame_rounds.csv');

    // Filter by challenge if specified
    if (challenge) {
      rounds = rounds.filter(r => r.challenge === challenge);
    }

    // Filter by timeframe
    rounds = filterByTimeframe(rounds, timeframe, 'date');

    // Parse numeric fields
    rounds = rounds.map(r => ({
      ...r,
      up_and_down_pct:  Number(r.up_and_down_pct),
      avg_proximity_ft: Number(r.avg_proximity_ft),
      avg_putts:        Number(r.avg_putts),
      total_strokes:    Number(r.total_strokes),
      total_shots:      Number(r.total_shots),
    }));

    res.json({ rounds });

  } catch (err) {
    console.error('GET /api/shortgame/history error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/shortgame/round/:id
 * Returns the round summary + all shots for that round.
 */
app.get('/api/shortgame/round/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const [rounds, shots] = await Promise.all([
      readCSV('shortgame_rounds.csv'),
      readCSV('shortgame_shots.csv'),
    ]);

    const round = rounds.find(r => r.round_id === id);
    if (!round) return res.status(404).json({ error: 'Round not found' });

    const roundShots = shots
      .filter(s => s.round_id === id)
      .map(s => ({
        ...s,
        shot_number:  Number(s.shot_number),
        proximity_ft: Number(s.proximity_ft),
        putts:        Number(s.putts),
      }))
      .sort((a, b) => a.shot_number - b.shot_number);

    res.json({
      round: {
        ...round,
        up_and_down_pct:  Number(round.up_and_down_pct),
        avg_proximity_ft: Number(round.avg_proximity_ft),
        avg_putts:        Number(round.avg_putts),
        total_strokes:    Number(round.total_strokes),
        total_shots:      Number(round.total_shots),
      },
      shots: roundShots,
    });

  } catch (err) {
    console.error('GET /api/shortgame/round/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Short game stats endpoint (for history page) ──────────────
/**
 * GET /api/shortgame/stats
 * Returns aggregated stats + miss breakdown for the history page.
 * Query params: timeframe, challenge (same as /history)
 */
app.get('/api/shortgame/stats', async (req, res) => {
  try {
    const { timeframe = 'all', challenge } = req.query;

    let [rounds, shots] = await Promise.all([
      readCSV('shortgame_rounds.csv'),
      readCSV('shortgame_shots.csv'),
    ]);

    if (challenge) {
      rounds = rounds.filter(r => r.challenge === challenge);
      const roundIds = new Set(rounds.map(r => r.round_id));
      shots = shots.filter(s => roundIds.has(s.round_id));
    }

    rounds = filterByTimeframe(rounds, timeframe, 'date');
    const roundIds = new Set(rounds.map(r => r.round_id));
    shots  = shots.filter(s => roundIds.has(s.round_id));

    if (rounds.length === 0) {
      return res.json({ rounds: 0, avg_ud_pct: null, avg_proximity_ft: null, avg_putts: null, miss_breakdown: {} });
    }

    const avgUD   = avg(rounds.map(r => Number(r.up_and_down_pct)));
    const avgProx = avg(rounds.map(r => Number(r.avg_proximity_ft)));
    const avgPutt = avg(rounds.map(r => Number(r.avg_putts)));

    // Miss direction breakdown
    const missCounts = {};
    shots.forEach(s => {
      const dir = s.miss_direction || 'on_target';
      missCounts[dir] = (missCounts[dir] || 0) + 1;
    });

    // U&D breakdown by shot type + pin
    const udByType = {};
    shots.forEach(s => {
      const key = `${s.shot_type}|${s.pin_position}`;
      if (!udByType[key]) udByType[key] = { made: 0, total: 0 };
      udByType[key].total++;
      if (s.result === 'up') udByType[key].made++;
    });

    const udGrid = Object.entries(udByType).map(([key, v]) => {
      const [shot_type, pin_position] = key.split('|');
      return {
        shot_type,
        pin_position,
        pct: Math.round((v.made / v.total) * 100),
        made: v.made,
        total: v.total,
      };
    });

    res.json({
      rounds:           rounds.length,
      avg_ud_pct:       Math.round(avgUD),
      avg_proximity_ft: parseFloat(avgProx.toFixed(1)),
      avg_putts:        parseFloat(avgPutt.toFixed(2)),
      miss_breakdown:   missCounts,
      ud_grid:          udGrid,
    });

  } catch (err) {
    console.error('GET /api/shortgame/stats error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// DISTANCE CHALLENGE API
// ============================================================
//
// Single flat CSV — one row per shot, session_id groups them.
// Schema: session_id, date, test_name, test_id, order, reps, shot_number,
//         target_yards, carry_yards, miss_yards, sg, was_manual
// ─────────────────────────────────────────────────────────────

const DISTANCE_SHOT_COLS = [
  'session_id', 'date', 'test_name', 'test_id', 'order', 'reps', 'shot_number',
  'target_yards', 'carry_yards', 'miss_yards', 'sg', 'was_manual',
];

/**
 * POST /api/distance/session
 * Body: completed session object from WedgeLab engine (completeSession())
 */
app.post('/api/distance/session', async (req, res) => {
  try {
    const session = req.body;

    if (!session.testId || !Array.isArray(session.shots)) {
      return res.status(400).json({ error: 'testId and shots[] are required' });
    }

    const session_id = session.id || generateId();
    const date       = session.completedAt || new Date().toISOString();

    const shotRows = session.shots.map(s => ({
      session_id,
      date,
      test_name:    session.testName,
      test_id:      session.testId,
      order:        session.order,
      reps:         session.reps || 1,
      shot_number:  s.shotNumber,
      target_yards: s.targetYards,
      carry_yards:  s.carryYards,
      miss_yards:   s.missYards,
      sg:           s.sg,
      was_manual:   s.wasManual ? 'true' : 'false',
    }));

    await appendCSV('wedgelab_distance.csv', shotRows, DISTANCE_SHOT_COLS);

    // Calculate session summary to return to client
    const totalSG      = parseFloat(session.shots.reduce((sum, s) => sum + s.sg, 0).toFixed(3));
    const avgMiss      = parseFloat((session.shots.reduce((sum, s) => sum + Math.abs(s.missYards), 0) / session.shots.length).toFixed(1));

    res.json({ session_id, total_sg: totalSG, avg_miss_yards: avgMiss });

  } catch (err) {
    console.error('POST /api/distance/session error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/distance/history
 * Returns sessions (grouped) with summary stats.
 * Query params:
 *   timeframe: '5' | 'month' | '6month' | 'all'
 *   test_id:   filter by test
 */
app.get('/api/distance/history', async (req, res) => {
  try {
    const { timeframe = 'all', test_id } = req.query;

    let shots = await readCSV('wedgelab_distance.csv');

    if (test_id) shots = shots.filter(s => s.test_id === test_id);

    // Group shots into sessions
    const sessionMap = {};
    shots.forEach(s => {
      const id = s.session_id;
      if (!sessionMap[id]) {
        sessionMap[id] = {
          id,
          completedAt: s.date,
          testName:    s.test_name,
          testId:      s.test_id,
          order:       s.order,
          shots:       [],
        };
      }
      sessionMap[id].shots.push({
        shotNumber:    Number(s.shot_number),
        targetYards:   Number(s.target_yards),
        carryYards:    Number(s.carry_yards),
        missYards:     Number(s.miss_yards),
        sg:            Number(s.sg),
        wasManual:     s.was_manual === 'true',
        missDirection: Number(s.miss_yards) === 0 ? 'perfect' : Number(s.miss_yards) < 0 ? 'short' : 'long',
      });
    });

    // Build session summaries
    let sessions = Object.values(sessionMap).map(s => {
      const sgs    = s.shots.map(sh => sh.sg);
      const misses = s.shots.map(sh => Math.abs(sh.missYards));
      const totalSG  = parseFloat(sgs.reduce((a, b) => a + b, 0).toFixed(3));
      const avgMiss  = parseFloat((misses.reduce((a, b) => a + b, 0) / misses.length).toFixed(1));
      return {
        id:             s.id,
        completedAt:    s.completedAt,
        testName:       s.testName,
        testId:         s.testId,
        order:          s.order,
        shots:          s.shots,
        totalSG,
        avgMissYards:   avgMiss,
        totalMissYards: parseFloat(misses.reduce((a, b) => a + b, 0).toFixed(1)),
      };
    });

    // Sort by date, then apply timeframe filter
    sessions.sort((a, b) => new Date(a.completedAt) - new Date(b.completedAt));
    sessions = filterByTimeframe(sessions, timeframe, 'completedAt');

    res.json({ sessions });

  } catch (err) {
    console.error('GET /api/distance/history error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/distance/session/:id
 * Returns all shots for a single session.
 */
app.get('/api/distance/session/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const allShots = await readCSV('wedgelab_distance.csv');
    const shots = allShots
      .filter(s => s.session_id === id)
      .map(s => ({
        id:           `${s.session_id}_${s.shot_number}`,
        shotNumber:   Number(s.shot_number),
        targetYards:  Number(s.target_yards),
        carryYards:   Number(s.carry_yards),
        missYards:    Number(s.miss_yards),
        sg:           Number(s.sg),
        wasManual:    s.was_manual === 'true',
        missDirection: Number(s.miss_yards) === 0 ? 'perfect' : Number(s.miss_yards) < 0 ? 'short' : 'long',
        recordedAt:   s.date,
      }))
      .sort((a, b) => a.shotNumber - b.shotNumber);

    if (!shots.length) return res.status(404).json({ error: 'Session not found' });

    const sgs     = shots.map(s => s.sg);
    const misses  = shots.map(s => Math.abs(s.missYards));
    const totalSG = parseFloat(sgs.reduce((a, b) => a + b, 0).toFixed(3));
    const avgMiss = parseFloat((misses.reduce((a, b) => a + b, 0) / misses.length).toFixed(1));

    const firstRaw = (await readCSV('wedgelab_distance.csv')).find(s => s.session_id === id);

    res.json({
      session: {
        id,
        completedAt:    firstRaw?.date,
        testName:       firstRaw?.test_name,
        testId:         firstRaw?.test_id,
        order:          firstRaw?.order,
        shot_count:     shots.length,
        totalSG,
        avgMissYards:   avgMiss,
        totalMissYards: parseFloat(misses.reduce((a, b) => a + b, 0).toFixed(1)),
      },
      shots,
    });

  } catch (err) {
    console.error('GET /api/distance/session/:id error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ============================================================
// UTILITIES
// ============================================================

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * Filter an array of objects by timeframe.
 * @param {object[]} rows
 * @param {'5'|'month'|'6month'|'all'} timeframe
 * @param {string} dateField - key containing ISO date string
 */
function filterByTimeframe(rows, timeframe, dateField) {
  if (timeframe === 'all') return rows;

  if (timeframe === '5') {
    return rows.slice(-5);
  }

  const now    = new Date();
  const cutoff = new Date();

  if (timeframe === 'month') {
    cutoff.setMonth(now.getMonth() - 1);
  } else if (timeframe === '6month') {
    cutoff.setMonth(now.getMonth() - 6);
  }

  return rows.filter(r => new Date(r[dateField]) >= cutoff);
}


// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`WedgeLab running on port ${PORT}`);
  if (!process.env.DROPBOX_APP_KEY) {
    console.warn('⚠  DROPBOX_APP_KEY not set — Dropbox calls will fail');
  }
});
