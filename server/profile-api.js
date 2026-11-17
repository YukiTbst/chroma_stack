#!/usr/bin/env node
/* ChromaStack calibration-profile API. Zero dependencies (Node >= 18).
   Each profile is one JSON file under DATA_DIR/profiles. The browser keeps
   only the active-profile pointer; all calibration data lives here so phone
   and desktop share the same set.

   Env:
     PORT      listen port (default 8124, bind 127.0.0.1 only)
     DATA_DIR  storage root (default <DATA_DIR>)

   Routes (nginx strips the /chromastack/api prefix):
     GET    /health
     GET    /profiles            -> { profiles: [meta...] }
     POST   /profiles            { name, data? }        -> 201 profile
     GET    /profiles/:id        -> profile
     PUT    /profiles/:id        { name?, data? }       -> profile
     DELETE /profiles/:id        -> { ok: true }
*/
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8124);
const DATA_DIR = process.env.DATA_DIR || '<DATA_DIR>';
const PROFILE_DIR = path.join(DATA_DIR, 'profiles');
const MAX_BODY = 2 * 1024 * 1024; // 2 MB per request is far above any calibration set
const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

fs.mkdirSync(PROFILE_DIR, { recursive: true });

function emptyData() {
  return { calibrations: {}, lutTdOverrides: {}, lutHexOverrides: {} };
}

function sanitizeData(input) {
  const src = input && typeof input === 'object' ? input : {};
  const out = emptyData();
  for (const field of Object.keys(out)) {
    const v = src[field];
    if (v && typeof v === 'object' && !Array.isArray(v)) out[field] = v;
  }
  return out;
}

function validName(name) {
  return typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= 40;
}

function profilePath(id) {
  return path.join(PROFILE_DIR, id + '.json');
}

function readProfile(id) {
  try {
    const raw = fs.readFileSync(profilePath(id), 'utf8');
    const p = JSON.parse(raw);
    if (!p || p.id !== id) return null;
    return p;
  } catch (e) {
    return null;
  }
}

function writeProfile(p) {
  // Atomic replace: a crash mid-write must never corrupt an existing profile.
  const tmp = profilePath(p.id) + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(p));
  fs.renameSync(tmp, profilePath(p.id));
}

function listProfiles() {
  const out = [];
  for (const file of fs.readdirSync(PROFILE_DIR)) {
    if (!file.endsWith('.json')) continue;
    const p = readProfile(file.slice(0, -5));
    if (p) out.push({ id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt });
  }
  out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id));
  return out;
}

function newId() {
  return 'p-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch (e) { reject(new Error('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'OPTIONS') { send(res, 204, {}); return; }

    if (parts[0] === 'health' && req.method === 'GET') {
      send(res, 200, { ok: true, profiles: listProfiles().length });
      return;
    }

    if (parts[0] === 'profiles' && parts.length === 1) {
      if (req.method === 'GET') { send(res, 200, { profiles: listProfiles() }); return; }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (!validName(body.name)) { send(res, 400, { error: 'name 必须是 1–40 个字符' }); return; }
        const now = Date.now();
        const p = {
          id: newId(), name: body.name.trim(),
          createdAt: now, updatedAt: now,
          data: sanitizeData(body.data)
        };
        writeProfile(p);
        send(res, 201, p);
        return;
      }
    }

    if (parts[0] === 'profiles' && parts.length === 2 && ID_RE.test(parts[1])) {
      const id = parts[1];
      const existing = readProfile(id);
      if (req.method === 'GET') {
        if (!existing) { send(res, 404, { error: 'profile 不存在' }); return; }
        send(res, 200, existing);
        return;
      }
      if (req.method === 'PUT') {
        if (!existing) { send(res, 404, { error: 'profile 不存在' }); return; }
        const body = await readBody(req);
        if (body.name !== undefined && !validName(body.name)) { send(res, 400, { error: 'name 必须是 1–40 个字符' }); return; }
        if (body.name !== undefined) existing.name = body.name.trim();
        if (body.data !== undefined) existing.data = sanitizeData(body.data);
        existing.updatedAt = Date.now();
        writeProfile(existing);
        send(res, 200, existing);
        return;
      }
      if (req.method === 'DELETE') {
        if (!existing) { send(res, 404, { error: 'profile 不存在' }); return; }
        fs.unlinkSync(profilePath(id));
        send(res, 200, { ok: true });
        return;
      }
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    const msg = String(e && e.message || e);
    const status = msg === 'body too large' ? 413 : msg === 'invalid JSON' ? 400 : 500;
    if (!res.headersSent) send(res, status, { error: msg });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`chromastack profile api listening on 127.0.0.1:${PORT}, data=${DATA_DIR}`);
});