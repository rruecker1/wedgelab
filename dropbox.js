'use strict';

/**
 * ============================================================
 * WEDGELAB — Dropbox CSV Helper
 * ============================================================
 * Uses OAuth refresh token flow — never expires.
 * ============================================================
 */

const fetch = require('node-fetch');

const DROPBOX_FOLDER = '';

// ── Credentials ───────────────────────────────────────────────
const DROPBOX_APP_KEY       = process.env.DROPBOX_APP_KEY;
const DROPBOX_APP_SECRET    = process.env.DROPBOX_APP_SECRET;
const DROPBOX_REFRESH_TOKEN = process.env.DROPBOX_REFRESH_TOKEN;

// ── Token cache ───────────────────────────────────────────────
let _accessToken   = null;
let _tokenExpiresAt = 0;

async function getAccessToken() {
  // Return cached token if still valid (with 5 min buffer)
  if (_accessToken && Date.now() < _tokenExpiresAt - 300_000) {
    return _accessToken;
  }

  const res = await fetch('https://api.dropbox.com/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: DROPBOX_REFRESH_TOKEN,
      client_id:     DROPBOX_APP_KEY,
      client_secret: DROPBOX_APP_SECRET,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Dropbox token refresh failed: ${err}`);
  }

  const data = await res.json();
  _accessToken    = data.access_token;
  _tokenExpiresAt = Date.now() + (data.expires_in * 1000);

  console.log('Dropbox token refreshed — expires in', data.expires_in, 'seconds');
  return _accessToken;
}

// ── Low-level Dropbox API calls ───────────────────────────────

async function dbxDownload(path) {
  const token = await getAccessToken();
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      'Authorization':   `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path }),
    },
  });

  if (res.status === 409) {
    const body = await res.json();
    if (body.error_summary && body.error_summary.includes('not_found')) {
      return '';
    }
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dropbox download failed (${res.status}): ${body}`);
  }

  return res.text();
}

async function dbxUpload(path, content) {
  const token = await getAccessToken();
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      'Authorization':   `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({
        path,
        mode:       'overwrite',
        autorename: false,
        mute:       true,
      }),
      'Content-Type': 'application/octet-stream',
    },
    body: content,
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Dropbox upload failed (${res.status}): ${body}`);
  }

  return res.json();
}

// ── CSV helpers ───────────────────────────────────────────────

/**
 * Escape a single CSV field value.
 * Wraps in quotes if it contains commas, quotes, or newlines.
 */
function escapeField(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Convert an array of objects to CSV rows string.
 * Does NOT include a header row — caller manages that.
 * @param {object[]} rows
 * @param {string[]} columns - ordered list of keys to include
 * @returns {string}
 */
function rowsToCSV(rows, columns) {
  return rows
    .map(row => columns.map(col => escapeField(row[col])).join(','))
    .join('\n');
}

/**
 * Parse CSV string into array of objects.
 * First line is treated as the header row.
 * @param {string} csv
 * @returns {object[]}
 */
function parseCSV(csv) {
  const lines = csv.trim().split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const values = splitCSVLine(line);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = values[i] ?? ''; });
    return obj;
  });
}

/**
 * Split a single CSV line respecting quoted fields.
 */
function splitCSVLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      fields.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ── Public API ────────────────────────────────────────────────

/**
 * Read a CSV file from Dropbox.
 * Returns parsed rows as array of objects.
 * Returns [] if file doesn't exist yet.
 * @param {string} filename  e.g. 'shortgame.csv'
 * @returns {Promise<object[]>}
 */
async function readCSV(filename) {
  const path = `${DROPBOX_FOLDER}/${filename}`;
  const raw = await dbxDownload(path);
  if (!raw) return [];
  return parseCSV(raw);
}

/**
 * Append rows to a CSV file on Dropbox.
 * Creates the file with a header row if it doesn't exist yet.
 * @param {string}   filename
 * @param {object[]} rows
 * @param {string[]} columns  - ordered column names (also used as header)
 */
async function appendCSV(filename, rows, columns) {
  const path = `${DROPBOX_FOLDER}/${filename}`;

  // Download existing content
  const existing = await dbxDownload(path);

  let content;
  if (!existing) {
    // New file — write header + rows
    const header = columns.join(',');
    const body   = rowsToCSV(rows, columns);
    content = `${header}\n${body}\n`;
  } else {
    // Append rows (no header)
    const body = rowsToCSV(rows, columns);
    content = existing.trimEnd() + '\n' + body + '\n';
  }

  await dbxUpload(path, content);
}

/**
 * Overwrite a CSV file entirely.
 * @param {string}   filename
 * @param {object[]} rows
 * @param {string[]} columns
 */
async function writeCSV(filename, rows, columns) {
  const path = `${DROPBOX_FOLDER}/${filename}`;
  const header = columns.join(',');
  const body   = rowsToCSV(rows, columns);
  const content = `${header}\n${body}\n`;
  await dbxUpload(path, content);
}

/**
 * Read a JSON file from Dropbox.
 * Returns null if file doesn't exist.
 * @param {string} filename
 * @returns {Promise<any>}
 */
async function readJSON(filename) {
  const path = `${DROPBOX_FOLDER}/${filename}`;
  const raw = await dbxDownload(path);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Write a JSON file to Dropbox (full overwrite).
 * @param {string} filename
 * @param {any} data
 */
async function writeJSON(filename, data) {
  const path = `${DROPBOX_FOLDER}/${filename}`;
  await dbxUpload(path, JSON.stringify(data, null, 2));
}

module.exports = { readCSV, appendCSV, writeCSV, readJSON, writeJSON, parseCSV, rowsToCSV };