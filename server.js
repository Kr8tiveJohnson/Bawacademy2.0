require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');
const zlib = require('zlib');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'projects.json');
const REGISTRATIONS_FILE = path.join(__dirname, 'registrations.json');
const UPLOAD_DIR = path.join(__dirname, 'assets', 'projects');
const RECEIPTS_DIR = path.join(__dirname, 'assets', 'receipts');
const NOT_FOUND_PAGE = path.join(__dirname, '404.html');

// Ensure upload directories exist
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
if (!fs.existsSync(RECEIPTS_DIR)) {
  fs.mkdirSync(RECEIPTS_DIR, { recursive: true });
}

// MIME Types whitelist
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
};

// Sensitive files strictly prohibited from public web access
const SENSITIVE_FILES = new Set([
  'server.js',
  'projects.json',
  'registrations.json',
  'package.json',
  'package-lock.json',
  'render.yaml',
  'readme.md',
  '.env',
  '.env.example',
  '.gitignore'
]);

// Allowed HTTP methods
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']);

// ── In-Memory Rate Limiter (Anti-DDoS / Anti-Brute-Force) ──
const rateLimitMap = new Map();
const RATE_WINDOW_MS = 60 * 1000; // 60 seconds
const GENERAL_REQ_LIMIT = 160;     // max 160 requests/min
const API_WRITE_LIMIT = 40;        // max 40 POST/mutations per min

function getClientIP(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '127.0.0.1';
}

function checkRateLimit(ip, isWrite = false) {
  const now = Date.now();
  let record = rateLimitMap.get(ip);

  if (!record || now - record.startTime > RATE_WINDOW_MS) {
    record = { startTime: now, total: 1, writes: isWrite ? 1 : 0 };
    rateLimitMap.set(ip, record);
    return false;
  }

  record.total++;
  if (isWrite) record.writes++;

  if (isWrite && record.writes > API_WRITE_LIMIT) return true;
  if (record.total > GENERAL_REQ_LIMIT) return true;

  return false;
}

// Clean up stale rate-limit records every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now - record.startTime > RATE_WINDOW_MS * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// ── HTTP Security Headers (Defense-in-Depth) ──
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com blob:",
    "script-src-elem 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com blob:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: https: blob:",
    "media-src 'self' data: blob:",
    "connect-src 'self' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'self'",
    "form-action 'self' https://wa.me https://chat.whatsapp.com",
    "object-src 'none'"
  ].join('; '));
}

// ── 404 Response Helper ──
let cached404Html = null;
function get404Content() {
  if (!cached404Html) {
    try {
      if (fs.existsSync(NOT_FOUND_PAGE)) {
        cached404Html = fs.readFileSync(NOT_FOUND_PAGE, 'utf8');
      }
    } catch (e) {
      cached404Html = null;
    }
  }
  return cached404Html || `<!DOCTYPE html><html><head><title>404 Not Found</title></head><body style="background:#03140b;color:#f1f5f9;font-family:sans-serif;text-align:center;padding:50px;"><h1>404 - Not Found</h1><p>Resource restricted or moved.</p><p><a href="/" style="color:#e6b749;">Return Home</a></p></body></html>`;
}

function send404(res) {
  applySecurityHeaders(res);
  res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(get404Content());
}

// Helper to parse JSON body with payload size guard
function parseJsonBody(req, maxSize = 15 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let body = '';
    let exceeded = false;
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxSize) {
        exceeded = true;
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (exceeded) return;
      try {
        const parsed = body.trim() ? JSON.parse(body) : {};
        resolve(parsed);
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', err => reject(err));
  });
}

function sendCompressedJson(req, res, statusCode, data) {
  const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
  const acceptEncoding = (req && req.headers && req.headers['accept-encoding']) || '';

  if (acceptEncoding.includes('gzip') && jsonStr.length > 512) {
    zlib.gzip(Buffer.from(jsonStr, 'utf8'), (err, zipped) => {
      if (!err && zipped) {
        res.writeHead(statusCode, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Encoding': 'gzip',
          'Vary': 'Accept-Encoding'
        });
        res.end(zipped);
      } else {
        res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(jsonStr);
      }
    });
  } else {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(jsonStr);
  }
}

// --- Local File Storage Helpers ---
function readProjectsFromFile() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf8');
      return JSON.parse(data || '[]');
    }
  } catch (err) {
    console.error('[FileDB] Error reading projects.json:', err);
  }
  return [];
}

function writeProjectsToFile(projects) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(projects, null, 2), 'utf8');
  } catch (err) {
    console.error('[FileDB] Error writing projects.json:', err);
  }
}

function readRegistrationsFromFile() {
  try {
    if (fs.existsSync(REGISTRATIONS_FILE)) {
      const data = fs.readFileSync(REGISTRATIONS_FILE, 'utf8');
      return JSON.parse(data || '[]');
    }
  } catch (err) {
    console.error('[FileDB] Error reading registrations.json:', err);
  }
  return [];
}

function writeRegistrationsToFile(registrations) {
  try {
    fs.writeFileSync(REGISTRATIONS_FILE, JSON.stringify(registrations, null, 2), 'utf8');
  } catch (err) {
    console.error('[FileDB] Error writing registrations.json:', err);
  }
}

// --- MongoDB Atlas Connection ---
let dbClient = null;
let projectsCollection = null;
let registrationsCollection = null;
let isMongoConnected = false;
let cachedProjects = null;

async function initMongoDB() {
  let uri = process.env.MONGODB_URI;
  if (!uri || !uri.trim()) {
    console.log('[Database] ℹ️  No MONGODB_URI found in environment. Using local files.');
    cachedProjects = readProjectsFromFile();
    return;
  }

  // Automatically remove accidental < > brackets around passwords
  uri = uri.trim().replace(/<([^>]+)>/g, '$1');

  try {
    console.log('[Database] ⏳ Connecting to MongoDB Atlas...');
    dbClient = new MongoClient(uri, {
      serverSelectionTimeoutMS: 7000,
      connectTimeoutMS: 10000,
    });
    await dbClient.connect();
    const db = dbClient.db();
    projectsCollection = db.collection('projects');
    registrationsCollection = db.collection('registrations');
    isMongoConnected = true;
    console.log(`[Database] ✅ Connected to MongoDB Atlas! Database: "${db.databaseName}"`);

    // Ensure projects exist: Check current DB, fallback to 'test' DB, fallback to projects.json
    const count = await projectsCollection.countDocuments();
    if (count <= 1) {
      try {
        const testCol = dbClient.db('test').collection('projects');
        const testCount = await testCol.countDocuments();
        if (testCount > count) {
          console.log(`[Database] 📦 Syncing ${testCount} projects from test database to ${db.databaseName}...`);
          const testDocs = await testCol.find({}).toArray();
          const cleanDocs = testDocs.map(p => {
            const doc = { ...p };
            delete doc._id;
            return doc;
          });
          await projectsCollection.deleteMany({});
          await projectsCollection.insertMany(cleanDocs);
          writeProjectsToFile(cleanDocs);
          cachedProjects = cleanDocs;
          console.log(`[Database] ✅ Synced ${cleanDocs.length} projects to ${db.databaseName} and local cache.`);
        }
      } catch (err) {
        console.warn('[Database] Could not inspect test database:', err.message);
      }
    }

    // Populate in-memory project cache
    if (!cachedProjects || cachedProjects.length === 0) {
      try {
        const docs = await projectsCollection.find({}).toArray();
        if (docs.length > 0) {
          cachedProjects = docs.map(d => {
            const { _id, ...rest } = d;
            return { id: rest.id || (_id ? _id.toString() : 'proj-' + Date.now()), ...rest };
          });
        }
      } catch (e) {
        console.error('[Database] Failed to preload projects cache:', e.message);
      }
    }

    if (!cachedProjects || cachedProjects.length === 0) {
      cachedProjects = readProjectsFromFile();
    }
    console.log(`[Database] 🚀 Project cache warmed with ${cachedProjects.length} projects.`);

    // Sync registrations cache to local file on startup
    try {
      const regDocs = await registrationsCollection.find({}).sort({ registeredAt: -1 }).toArray();
      const cleanRegs = regDocs.map(d => {
        const { _id, ...rest } = d;
        return { id: rest.id || (_id ? _id.toString() : 'reg-' + Date.now()), ...rest };
      });
      writeRegistrationsToFile(cleanRegs);
      console.log(`[Database] 🚀 Registrations cache synced with ${cleanRegs.length} records.`);
    } catch (e) {
      console.warn('[Database] Could not pre-sync registrations file:', e.message);
    }
  } catch (err) {
    console.error('[Database] ❌ MongoDB Atlas connection error:', err.message);
    console.log('[Database] ⚠️  Falling back to local file storage.');
    isMongoConnected = false;
    cachedProjects = readProjectsFromFile();
  }
}

async function getProjects() {
  if (cachedProjects && cachedProjects.length > 0) {
    return cachedProjects;
  }
  if (isMongoConnected && projectsCollection) {
    try {
      const docs = await projectsCollection.find({}).toArray();
      cachedProjects = docs.map(d => {
        const { _id, ...rest } = d;
        return { id: rest.id || (_id ? _id.toString() : 'proj-' + Date.now()), ...rest };
      });
      return cachedProjects;
    } catch (err) {
      console.error('[Database] Failed to read from MongoDB Atlas, falling back to local file:', err.message);
    }
  }
  cachedProjects = readProjectsFromFile();
  return cachedProjects;
}

async function saveProjects(projectsList) {
  cachedProjects = projectsList;
  writeProjectsToFile(projectsList);

  if (isMongoConnected && projectsCollection) {
    try {
      await projectsCollection.deleteMany({});
      if (projectsList.length > 0) {
        const cleanDocs = projectsList.map(p => {
          const doc = { ...p };
          delete doc._id;
          return doc;
        });
        await projectsCollection.insertMany(cleanDocs);
      }
      return true;
    } catch (err) {
      console.error('[Database] Failed to save to MongoDB Atlas:', err.message);
      return false;
    }
  }
  return true;
}

async function getRegistrations() {
  let docs = [];
  if (isMongoConnected && registrationsCollection) {
    try {
      const mongoDocs = await registrationsCollection.find({}).sort({ registeredAt: -1 }).toArray();
      docs = mongoDocs.map(d => {
        const { _id, ...rest } = d;
        return { id: rest.id || (_id ? _id.toString() : 'reg-' + Date.now()), ...rest };
      });
    } catch (err) {
      console.error('[Database] Failed to read registrations from MongoDB:', err.message);
      docs = readRegistrationsFromFile();
    }
  } else {
    docs = readRegistrationsFromFile();
  }

  // Calculate dynamic referral counts for each unique code
  const refCountMap = {};
  docs.forEach(d => {
    if (d.referredBy && typeof d.referredBy === 'string') {
      const code = d.referredBy.trim().toUpperCase();
      refCountMap[code] = (refCountMap[code] || 0) + 1;
    }
  });

  return docs.map(d => ({
    ...d,
    referralCount: refCountMap[(d.uniqueCode || '').trim().toUpperCase()] || 0
  }));
}

async function findRegistrationByReference(ref) {
  if (!ref) return null;
  if (isMongoConnected && registrationsCollection) {
    try {
      const doc = await registrationsCollection.findOne({ reference: ref });
      if (doc) {
        const { _id, ...rest } = doc;
        return rest;
      }
    } catch (err) {
      console.error('[Database] Error finding registration:', err.message);
    }
  }
  const all = readRegistrationsFromFile();
  return all.find(r => r.reference === ref) || null;
}

async function findRegistrationByUniqueCode(code) {
  if (!code) return null;
  const clean = String(code).trim().toUpperCase();
  if (isMongoConnected && registrationsCollection) {
    try {
      const doc = await registrationsCollection.findOne({ uniqueCode: clean });
      if (doc) {
        const { _id, ...rest } = doc;
        return rest;
      }
    } catch (err) {
      console.error('[Database] Error finding registration by uniqueCode in MongoDB:', err.message);
    }
  }
  const all = readRegistrationsFromFile();
  return all.find(r => (r.uniqueCode || '').trim().toUpperCase() === clean) || null;
}

async function findRegistrationByEmail(email) {
  if (!email) return null;
  const clean = String(email).trim().toLowerCase();
  if (isMongoConnected && registrationsCollection) {
    try {
      const doc = await registrationsCollection.findOne({ email: clean });
      if (doc) {
        const { _id, ...rest } = doc;
        return rest;
      }
    } catch (err) {
      console.error('[Database] Error finding registration by email in MongoDB:', err.message);
    }
  }
  const all = readRegistrationsFromFile();
  return all.find(r => (r.email || '').trim().toLowerCase() === clean) || null;
}

async function findRegistrationById(identifier) {
  if (!identifier) return null;
  const clean = String(identifier).trim();
  const cleanUpper = clean.toUpperCase();
  const cleanLower = clean.toLowerCase();

  if (isMongoConnected && registrationsCollection) {
    try {
      const doc = await registrationsCollection.findOne({
        $or: [
          { id: clean },
          { reference: clean },
          { uniqueCode: cleanUpper },
          { email: cleanLower },
          { phone: clean }
        ]
      });
      if (doc) {
        const { _id, ...rest } = doc;
        return rest;
      }
    } catch (err) {
      console.error('[Database] Error finding registration by identifier in MongoDB:', err.message);
    }
  }
  const all = readRegistrationsFromFile();
  return all.find(r =>
    r.id === clean ||
    r.reference === clean ||
    (r.uniqueCode || '').toUpperCase() === cleanUpper ||
    (r.email || '').toLowerCase() === cleanLower ||
    (r.phone || '').trim() === clean
  ) || null;
}

async function generateNextUniqueCode() {
  const all = await getRegistrations();
  const numericCodes = all
    .map(r => {
      const m = (r.uniqueCode || '').match(/^BAW-(\d+)$/i);
      return m ? parseInt(m[1], 10) : null;
    })
    .filter(n => n !== null && n >= 200);

  let nextNum = numericCodes.length > 0 ? Math.max(...numericCodes) + 1 : 200;

  // Collision-free guard: ensure candidate code is strictly unused
  while (true) {
    const candidate = `BAW-${nextNum}`;
    const taken = await findRegistrationByUniqueCode(candidate);
    if (!taken) {
      return candidate;
    }
    nextNum++;
  }
}

async function getReferralsForCode(code) {
  if (!code) return [];
  const clean = code.trim().toUpperCase();
  if (isMongoConnected && registrationsCollection) {
    try {
      const docs = await registrationsCollection.find({ referredBy: clean }).sort({ registeredAt: -1 }).toArray();
      return docs.map(d => ({
        name: d.name,
        department: d.department,
        level: d.level,
        registeredAt: d.registeredAt
      }));
    } catch (err) {
      console.error('[Database] Error finding referrals in MongoDB:', err.message);
    }
  }
  const all = readRegistrationsFromFile();
  return all
    .filter(r => (r.referredBy || '').trim().toUpperCase() === clean)
    .map(d => ({
      name: d.name,
      department: d.department,
      level: d.level,
      registeredAt: d.registeredAt
    }));
}

async function saveRegistration(regDoc) {
  // Sync to local cache file
  const list = readRegistrationsFromFile();
  const existingIdx = list.findIndex(r => r.reference === regDoc.reference);
  if (existingIdx >= 0) {
    list[existingIdx] = regDoc;
  } else {
    list.unshift(regDoc);
  }
  writeRegistrationsToFile(list);

  if (isMongoConnected && registrationsCollection) {
    try {
      await registrationsCollection.updateOne(
        { reference: regDoc.reference },
        { $set: regDoc },
        { upsert: true }
      );
      return true;
    } catch (err) {
      console.error('[Database] Failed to save registration in MongoDB:', err.message);
      return false;
    }
  }
  return true;
}

async function updateRegistration(identifier, updateFields) {
  if (!identifier) return null;
  const clean = String(identifier).trim();
  const cleanUpper = clean.toUpperCase();

  // Update in local file cache
  const list = readRegistrationsFromFile();
  const idx = list.findIndex(r =>
    r.id === clean ||
    r.reference === clean ||
    (r.uniqueCode || '').toUpperCase() === cleanUpper
  );
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...updateFields };
    writeRegistrationsToFile(list);
  }

  // Update in MongoDB
  if (isMongoConnected && registrationsCollection) {
    try {
      await registrationsCollection.updateOne(
        {
          $or: [
            { id: clean },
            { reference: clean },
            { uniqueCode: cleanUpper }
          ]
        },
        { $set: updateFields }
      );
      const updated = await registrationsCollection.findOne({
        $or: [
          { id: clean },
          { reference: clean },
          { uniqueCode: cleanUpper }
        ]
      });
      if (updated) {
        const { _id, ...rest } = updated;
        return rest;
      }
    } catch (err) {
      console.error('[Database] Error updating registration in MongoDB:', err.message);
    }
  }
  return idx >= 0 ? list[idx] : null;
}

async function deleteRegistration(identifier) {
  if (!identifier) return false;
  const cleanId = String(identifier).trim();
  const cleanCode = cleanId.toUpperCase();

  // Local file removal
  const list = readRegistrationsFromFile();
  const filtered = list.filter(r => r.id !== cleanId && r.reference !== cleanId && (r.uniqueCode || '').toUpperCase() !== cleanCode);
  writeRegistrationsToFile(filtered);

  // MongoDB removal
  if (isMongoConnected && registrationsCollection) {
    try {
      await registrationsCollection.deleteMany({
        $or: [
          { id: cleanId },
          { reference: cleanId },
          { uniqueCode: cleanCode }
        ]
      });
      return true;
    } catch (err) {
      console.error('[Database] Failed to delete registration in MongoDB:', err.message);
      return false;
    }
  }
  return true;
}

async function clearAllRegistrations() {
  writeRegistrationsToFile([]);
  if (isMongoConnected && registrationsCollection) {
    try {
      await registrationsCollection.deleteMany({});
      return true;
    } catch (err) {
      console.error('[Database] Failed to clear all registrations in MongoDB:', err.message);
      return false;
    }
  }
  return true;
}

// ── HTTP Request Handler ──
const server = http.createServer(async (req, res) => {
  // Method verification
  if (!ALLOWED_METHODS.has(req.method)) {
    applySecurityHeaders(res);
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed');
    return;
  }

  // Rate Limiting check
  const clientIP = getClientIP(req);
  const isWriteMethod = req.method === 'POST' || req.method === 'DELETE';
  if (checkRateLimit(clientIP, isWriteMethod)) {
    applySecurityHeaders(res);
    res.writeHead(429, {
      'Content-Type': 'application/json',
      'Retry-After': '60'
    });
    res.end(JSON.stringify({ error: 'Too many requests. Please try again in 1 minute.' }));
    return;
  }

  // Apply Security Headers to all incoming requests
  applySecurityHeaders(res);

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Path decode and sanitization against null bytes and URL manipulation
  let rawUrl = req.url.split('?')[0];
  if (rawUrl.indexOf('\0') !== -1 || rawUrl.includes('%00')) {
    return send404(res);
  }

  let reqPath;
  try {
    reqPath = decodeURIComponent(rawUrl);
  } catch (e) {
    return send404(res);
  }

  // Explicit route for 404 test or direct view
  if (reqPath === '/404' || reqPath === '/404.html') {
    return send404(res);
  }

  // Database status endpoint
  if (reqPath === '/api/db-status' && req.method === 'GET') {
    const list = await getProjects();
    const regs = await getRegistrations();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connected: isMongoConnected,
      driver: isMongoConnected ? 'MongoDB Atlas' : 'Local Storage',
      projectCount: list.length,
      registrationCount: regs.length,
      hasUriConfigured: Boolean(process.env.MONGODB_URI && process.env.MONGODB_URI.trim()),
      feeNgn: parseInt(process.env.WORKSHOP_FEE_NGN) || 1500
    }));
    return;
  }

  // API Routes for Projects
  if (reqPath === '/api/projects') {
    if (req.method === 'GET') {
      try {
        const projects = await getProjects();
        sendCompressedJson(req, res, 200, projects);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to retrieve projects' }));
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const parsed = await parseJsonBody(req, 15 * 1024 * 1024);
        if (Array.isArray(parsed)) {
          await saveProjects(parsed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            count: parsed.length,
            storage: isMongoConnected ? 'MongoDB Atlas' : 'Local File'
          }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Expected array of projects' }));
        }
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Invalid JSON body' }));
      }
      return;
    }
  }

  // ── Generate Next Sequential Referral Code ──
  // Returns next BAW-200, BAW-201, etc. based on existing registrations
  if (reqPath === '/api/generate-code' && req.method === 'GET') {
    try {
      const nextCode = await generateNextUniqueCode();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: nextCode }));
    } catch (err) {
      console.error('[Generate Code Error]:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not generate code' }));
    }
    return;
  }

  // ── Ticket Lookup Endpoint (Search by Code, Email, Phone, or Reference) ──
  if (reqPath === '/api/ticket' && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const query = (
        urlObj.searchParams.get('code') ||
        urlObj.searchParams.get('query') ||
        urlObj.searchParams.get('email') ||
        urlObj.searchParams.get('ref') ||
        urlObj.searchParams.get('uniqueCode') ||
        ''
      ).trim();

      if (!query) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Search query (code, email, or reference) is required.' }));
        return;
      }

      const attendee = await findRegistrationById(query);
      if (!attendee) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Registration not found for the provided information.' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, registration: attendee }));
    } catch (err) {
      console.error('[Ticket Lookup Error]:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Failed to look up ticket.' }));
    }
    return;
  }

  // ── Admin: Batch / Bulk Attendee Import Endpoint ──
  if (reqPath === '/api/admin/registrations/batch' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req, 10 * 1024 * 1024);
      const items = Array.isArray(body) ? body : (body.attendees || []);
      if (!Array.isArray(items) || items.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Expected non-empty array of attendees.' }));
        return;
      }

      const results = [];
      const skipped = [];
      const feeNGN = parseInt(process.env.WORKSHOP_FEE_NGN) || 1500;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const name = String(item.name || '').trim();
        const email = String(item.email || '').trim().toLowerCase();
        if (!name) {
          skipped.push({ item, reason: 'Name is missing' });
          continue;
        }

        const finalEmail = email || `attendee_${Date.now()}_${i}@bawacademy.com`;

        // Check if already registered by email
        const existing = await findRegistrationByEmail(finalEmail);
        if (existing) {
          skipped.push({ item, reason: `Email ${finalEmail} already registered (Code: ${existing.uniqueCode})` });
          continue;
        }

        let code = (item.customCode || item.uniqueCode || '').trim().toUpperCase();
        if (!code) {
          code = await generateNextUniqueCode();
        } else {
          const taken = await findRegistrationByUniqueCode(code);
          if (taken) {
            code = await generateNextUniqueCode();
          }
        }

        const isChallenge = String(item.participateChallenge || '').trim().toLowerCase() === 'yes';

        const newAttendee = {
          id: `reg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          reference: `BAW-BULK-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
          uniqueCode: code,
          name: name,
          department: String(item.department || '').trim(),
          level: String(item.level || '100 Level').trim(),
          phone: String(item.phone || '').trim(),
          email: finalEmail,
          currentStatus: String(item.currentStatus || 'STUDENT').trim(),
          primaryGoal: String(item.primaryGoal || 'Acquire digital and business skills').trim(),
          qaQuestion: String(item.qaQuestion || '').trim(),
          participateChallenge: isChallenge ? 'Yes' : 'No',
          referredBy: String(item.referredBy || '').trim().toUpperCase(),
          receiptUrl: String(item.receiptUrl || 'Batch Verified via Kuda Bank Statement').trim(),
          amountPaid: feeNGN,
          paymentMethod: 'Batch Import Verification (KUDA: 2013539577)',
          bankDetails: {
            bank: 'KUDA',
            accountNumber: '2013539577',
            accountName: 'BAKARE FATIMOH OLASHUBOMI'
          },
          registeredAt: item.registeredAt || new Date().toISOString()
        };

        await saveRegistration(newAttendee);
        results.push(newAttendee);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        importedCount: results.length,
        skippedCount: skipped.length,
        imported: results,
        skipped: skipped
      }));
    } catch (err) {
      console.error('[Admin Batch Import Error]:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Batch import failed' }));
    }
    return;
  }

  // ── Admin: Manual Attendee Creation Endpoint ──
  if (reqPath === '/api/admin/registrations' && req.method === 'POST') {
    try {
      const body = await parseJsonBody(req, 1024 * 512);
      const {
        name,
        email,
        phone,
        department,
        level,
        currentStatus,
        primaryGoal,
        qaQuestion,
        participateChallenge,
        referredBy,
        receiptUrl,
        customCode
      } = body;

      if (!name || !email) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Attendee Name and Email are required.' }));
        return;
      }

      const cleanEmail = String(email).trim().toLowerCase();
      // Check if duplicate email
      const existing = await findRegistrationByEmail(cleanEmail);
      if (existing) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `An attendee with email "${cleanEmail}" is already registered (Code: ${existing.uniqueCode}, Name: ${existing.name}).` }));
        return;
      }

      let codeToAssign = (customCode || '').trim().toUpperCase();
      if (!codeToAssign) {
        codeToAssign = await generateNextUniqueCode();
      } else {
        const codeTaken = await findRegistrationByUniqueCode(codeToAssign);
        if (codeTaken) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Code ${codeToAssign} is already taken by ${codeTaken.name}.` }));
          return;
        }
      }

      const feeNGN = parseInt(process.env.WORKSHOP_FEE_NGN) || 1500;
      const isChallenge = String(participateChallenge || '').trim().toLowerCase() === 'yes';

      const newAttendee = {
        id: `reg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        reference: `BAW-MANUAL-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
        uniqueCode: codeToAssign,
        name: String(name || '').trim(),
        department: String(department || '').trim(),
        level: String(level || '100 Level').trim(),
        phone: String(phone || '').trim(),
        email: cleanEmail,
        currentStatus: String(currentStatus || 'STUDENT').trim(),
        primaryGoal: String(primaryGoal || 'Acquire digital and business skills').trim(),
        qaQuestion: String(qaQuestion || '').trim(),
        participateChallenge: isChallenge ? 'Yes' : 'No',
        referredBy: String(referredBy || '').trim().toUpperCase(),
        receiptUrl: String(receiptUrl || '').trim(),
        amountPaid: feeNGN,
        paymentMethod: 'Manual Admin Verification (KUDA: 2013539577)',
        bankDetails: {
          bank: 'KUDA',
          accountNumber: '2013539577',
          accountName: 'BAKARE FATIMOH OLASHUBOMI'
        },
        registeredAt: new Date().toISOString()
      };

      await saveRegistration(newAttendee);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, registration: newAttendee }));
    } catch (err) {
      console.error('[Admin Add Attendee Error]:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Failed to add attendee.' }));
    }
    return;
  }

  // ── Admin: Attendee Update Endpoint ──
  if (reqPath.startsWith('/api/admin/registrations/') && req.method === 'PUT') {
    try {
      const rawId = reqPath.slice('/api/admin/registrations/'.length);
      const id = decodeURIComponent(rawId).trim();
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Attendee ID or Code required.' }));
        return;
      }
      const body = await parseJsonBody(req, 1024 * 512);
      const updateData = {};
      if (body.name !== undefined) updateData.name = String(body.name).trim();
      if (body.email !== undefined) updateData.email = String(body.email).trim().toLowerCase();
      if (body.phone !== undefined) updateData.phone = String(body.phone).trim();
      if (body.department !== undefined) updateData.department = String(body.department).trim();
      if (body.level !== undefined) updateData.level = String(body.level).trim();
      if (body.currentStatus !== undefined) updateData.currentStatus = String(body.currentStatus).trim();
      if (body.primaryGoal !== undefined) updateData.primaryGoal = String(body.primaryGoal).trim();
      if (body.qaQuestion !== undefined) updateData.qaQuestion = String(body.qaQuestion).trim();
      if (body.participateChallenge !== undefined) updateData.participateChallenge = body.participateChallenge === 'Yes' ? 'Yes' : 'No';
      if (body.referredBy !== undefined) updateData.referredBy = String(body.referredBy).trim().toUpperCase();
      if (body.receiptUrl !== undefined) updateData.receiptUrl = String(body.receiptUrl).trim();

      const updated = await updateRegistration(id, updateData);
      if (!updated) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Attendee not found.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, registration: updated }));
    } catch (err) {
      console.error('[Admin Update Attendee Error]:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Failed to update attendee.' }));
    }
    return;
  }

  // ── Workshop Registrations Endpoints ──
  if (reqPath === '/api/registrations') {
    if (req.method === 'GET') {
      try {
        const list = await getRegistrations();
        sendCompressedJson(req, res, 200, list);
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to retrieve registrations' }));
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const body = await parseJsonBody(req, 1024 * 512);
        const {
          reference,
          name,
          department,
          level,
          phone,
          email,
          currentStatus,
          primaryGoal,
          qaQuestion,
          referredBy,
          receiptUrl
        } = body;

        if (!name || !email) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Full Name and Email are required.' }));
          return;
        }

        const cleanEmail = String(email || '').trim().toLowerCase();
        const cleanRef = String(reference || `BAW-KUDA-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`).trim();
        const cleanReceiptUrl = String(receiptUrl || '').trim();

        // 1. Check if user with this email is ALREADY registered
        // If so, update their receipt if missing and return their existing registration without creating duplicates
        const existingByEmail = cleanEmail ? await findRegistrationByEmail(cleanEmail) : null;
        if (existingByEmail) {
          if (cleanReceiptUrl && !existingByEmail.receiptUrl) {
            existingByEmail.receiptUrl = cleanReceiptUrl;
            await saveRegistration(existingByEmail);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, alreadyRegistered: true, registration: existingByEmail }));
          return;
        }

        // 2. Also check if reference was explicitly re-submitted by the same browser
        const existingByRef = await findRegistrationByReference(cleanRef);
        if (existingByRef) {
          if (cleanReceiptUrl && !existingByRef.receiptUrl) {
            existingByRef.receiptUrl = cleanReceiptUrl;
            await saveRegistration(existingByRef);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, alreadyRegistered: true, registration: existingByRef }));
          return;
        }

        // 3. Generate brand new, guaranteed unique sequential code on the server (ATOMIC & COLLISION-FREE)
        const assignedCode = await generateNextUniqueCode();

        const feeNGN = parseInt(process.env.WORKSHOP_FEE_NGN) || 1500;
        const cleanReferredBy = String(referredBy || '').trim().toUpperCase();
        let finalReferredBy = '';

        // Validate referrer strictly against the database (cannot refer self)
        if (cleanReferredBy && cleanReferredBy !== assignedCode) {
          const referrerDoc = await findRegistrationByUniqueCode(cleanReferredBy);
          if (referrerDoc && referrerDoc.participateChallenge === 'Yes') {
            finalReferredBy = referrerDoc.uniqueCode;
          }
        }

        const isOptedChallenge = String(body.participateChallenge || '').trim().toLowerCase() === 'yes';

        const regDoc = {
          id: `reg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
          reference: cleanRef,
          uniqueCode: assignedCode, // EVERY attendee receives their own guaranteed unique ticket pass code!
          name: String(name || '').trim(),
          department: String(department || '').trim(),
          level: String(level || '').trim(),
          phone: String(phone || '').trim(),
          email: cleanEmail,
          currentStatus: String(currentStatus || '').trim(),
          primaryGoal: String(primaryGoal || '').trim(),
          qaQuestion: String(qaQuestion || '').trim(),
          participateChallenge: isOptedChallenge ? 'Yes' : 'No',
          referredBy: finalReferredBy,
          receiptUrl: cleanReceiptUrl,
          amountPaid: feeNGN,
          paymentMethod: 'Direct Bank Transfer (KUDA: 2013539577)',
          bankDetails: {
            bank: 'KUDA',
            accountNumber: '2013539577',
            accountName: 'BAKARE FATIMOH OLASHUBOMI'
          },
          registeredAt: new Date().toISOString()
        };

        await saveRegistration(regDoc);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          registration: regDoc
        }));
      } catch (err) {
        console.error('[Save Registration Error]:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'Error processing registration' }));
      }
      return;
    }

    if (req.method === 'DELETE') {
      try {
        const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const id = (urlObj.searchParams.get('id') || urlObj.searchParams.get('reference') || urlObj.searchParams.get('code') || '').trim();
        const clearAll = urlObj.searchParams.get('clearAll') === 'true';

        if (clearAll) {
          await clearAllRegistrations();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: 'All registrations deleted successfully.' }));
          return;
        }

        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Registration ID or Reference required to delete.' }));
          return;
        }

        await deleteRegistration(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Registration deleted successfully.' }));
      } catch (err) {
        console.error('[Delete Registration Error]:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to delete registration.' }));
      }
      return;
    }
  }

  // DELETE /api/registrations/:id or /api/registrations/clear-all
  if (reqPath.startsWith('/api/registrations/') && req.method === 'DELETE') {
    try {
      const rawId = reqPath.slice('/api/registrations/'.length);
      const id = decodeURIComponent(rawId).trim();
      if (id === 'clear-all') {
        await clearAllRegistrations();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'All registrations cleared successfully.' }));
        return;
      }
      if (!id) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ID required to delete' }));
        return;
      }
      await deleteRegistration(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Registration deleted successfully.' }));
    } catch (err) {
      console.error('[Delete Registration Error]:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to delete registration.' }));
    }
    return;
  }

  // ── Database Referral Verification Endpoint ──
  if (reqPath === '/api/referrals/verify' && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const code = (urlObj.searchParams.get('code') || '').trim().toUpperCase();

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ valid: false, error: 'Referral code is required.' }));
        return;
      }

      const student = await findRegistrationByUniqueCode(code);
      if (!student) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ valid: false, error: 'Code not found in database.' }));
        return;
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        valid: true,
        registration: student,
        uniqueCode: student.uniqueCode,
        name: student.name,
        department: student.department || ''
      }));
    } catch (err) {
      console.error('[Referral Verify Error]:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid: false, error: 'Database query failed.' }));
    }
    return;
  }

  // ── Database Student Referral Stats Endpoint ──
  if (reqPath === '/api/referrals/stats' && req.method === 'GET') {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      const code = (urlObj.searchParams.get('code') || '').trim().toUpperCase();

      if (!code) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unique code is required.' }));
        return;
      }

      const student = await findRegistrationByUniqueCode(code);
      if (!student) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Student registration not found in database.' }));
        return;
      }

      const referrals = await getReferralsForCode(code);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        uniqueCode: student.uniqueCode,
        studentName: student.name,
        department: student.department || '',
        referralCount: referrals.length,
        referrals: referrals
      }));
    } catch (err) {
      console.error('[Referral Stats Error]:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Database query failed.' }));
    }
    return;
  }

  // Upload API route for saving attendee payment receipts
  if (reqPath === '/api/upload-receipt' && req.method === 'POST') {
    let body = '';
    const MAX_RECEIPT_SIZE = 15 * 1024 * 1024; // 15MB
    let exceeded = false;

    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_RECEIPT_SIZE) {
        exceeded = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Receipt file exceeds maximum permitted size of 15MB.' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (exceeded) return;
      try {
        const { filename, data } = JSON.parse(body);
        if (!filename || !data) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing filename or receipt data' }));
          return;
        }

        const ext = path.extname(filename).toLowerCase();
        const SAFE_RECEIPT_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.pdf']);
        if (!SAFE_RECEIPT_EXTS.has(ext)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid receipt file type. Allowed: JPG, PNG, WEBP, GIF, PDF' }));
          return;
        }

        const safeBaseName = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
        const cleanName = `receipt-${Date.now()}-${safeBaseName}${ext}`;
        const targetPath = path.join(RECEIPTS_DIR, cleanName);

        const base64Data = data.replace(/^data:[^;]+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        fs.writeFileSync(targetPath, buffer);
        const publicUrl = 'assets/receipts/' + cleanName;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, url: publicUrl, filename: cleanName }));
      } catch (err) {
        console.error('[Receipt Upload Error]:', err.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to process receipt upload' }));
      }
    });
    return;
  }

  // Upload API route for saving project image files directly to disk
  if (reqPath === '/api/upload' && req.method === 'POST') {
    let body = '';
    const MAX_UPLOAD_SIZE = 12 * 1024 * 1024; // 12MB
    let exceeded = false;

    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_UPLOAD_SIZE) {
        exceeded = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Image exceeds maximum permitted size of 12MB.' }));
        req.destroy();
      }
    });

    req.on('end', () => {
      if (exceeded) return;
      try {
        const { filename, data } = JSON.parse(body);
        if (!filename || !data) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing filename or base64 image data' }));
          return;
        }

        // Validate extension to only permit safe image types
        const ext = path.extname(filename).toLowerCase();
        const SAFE_IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
        if (!SAFE_IMAGE_EXTS.has(ext)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid image type. Allowed: jpg, png, webp, gif' }));
          return;
        }

        const safeBaseName = path.basename(filename, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
        const cleanName = `${Date.now()}-${safeBaseName}${ext}`;
        const targetPath = path.join(UPLOAD_DIR, cleanName);

        const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        fs.writeFileSync(targetPath, buffer);
        const publicUrl = 'assets/projects/' + cleanName;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, url: publicUrl }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to process image upload' }));
      }
    });
    return;
  }

  // ── Static File Serving & Source Code Access Blocker ──
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  // Normalize path and remove leading traversal segments
  const normalizedReqPath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  const baseName = path.basename(normalizedReqPath).toLowerCase();

  // 1. Block access to hidden files and dotfiles (e.g., /.env, /.git)
  if (baseName.startsWith('.') || normalizedReqPath.split(path.sep).some(p => p.startsWith('.'))) {
    return send404(res);
  }

  // 2. Block access to sensitive source code and backend configuration files
  if (SENSITIVE_FILES.has(baseName)) {
    return send404(res);
  }

  // 3. Block access to internal directories (node_modules, .git, etc.)
  if (normalizedReqPath.includes('node_modules') || normalizedReqPath.includes('.git')) {
    return send404(res);
  }

  // 4. Block access to all .js files EXCEPT designated public client scripts
  const ext = path.extname(normalizedReqPath).toLowerCase();
  const ALLOWED_JS_FILES = new Set(['script.js', 'qrcode.min.js', 'html2canvas.min.js', 'jspdf.umd.min.js']);
  if (ext === '.js' && !ALLOWED_JS_FILES.has(baseName)) {
    return send404(res);
  }

  // Resolve absolute path and enforce that it remains strictly inside the website root
  const resolvedPath = path.resolve(__dirname, '.' + normalizedReqPath);
  if (!resolvedPath.startsWith(__dirname)) {
    return send404(res);
  }

  // Check if file exists and is a regular file
  fs.stat(resolvedPath, (err, stats) => {
    if (err || !stats.isFile()) {
      return send404(res);
    }

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(resolvedPath).pipe(res);
  });
});

// Initialize MongoDB Atlas then launch server
initMongoDB().finally(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🛡️ Hardened & Secured Server running on port ${PORT}`);
    console.log(`🌐 Local access: http://localhost:${PORT}`);
  });
});
