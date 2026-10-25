require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'projects.json');
const REGISTRATIONS_FILE = path.join(__dirname, 'registrations.json');
const UPLOAD_DIR = path.join(__dirname, 'assets', 'projects');
const NOT_FOUND_PAGE = path.join(__dirname, '404.html');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
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
const ALLOWED_METHODS = new Set(['GET', 'POST', 'DELETE', 'HEAD', 'OPTIONS']);

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

async function initMongoDB() {
  let uri = process.env.MONGODB_URI;
  if (!uri || !uri.trim()) {
    console.log('[Database] ℹ️  No MONGODB_URI found in environment. Using local files.');
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

    // Check if initial seeding of projects is needed
    const count = await projectsCollection.countDocuments();
    if (count === 0) {
      console.log('[Database] 📦 Seeding initial project data into MongoDB Atlas...');
      const local = readProjectsFromFile();
      if (local && local.length > 0) {
        await projectsCollection.insertMany(local);
        console.log(`[Database] ✅ Seeded ${local.length} projects into MongoDB Atlas.`);
      }
    }
  } catch (err) {
    console.error('[Database] ❌ MongoDB Atlas connection error:', err.message);
    console.log('[Database] ⚠️  Falling back to local file storage.');
    isMongoConnected = false;
  }
}

async function getProjects() {
  if (isMongoConnected && projectsCollection) {
    try {
      const docs = await projectsCollection.find({}).toArray();
      return docs.map(d => {
        const { _id, ...rest } = d;
        return { id: rest.id || (_id ? _id.toString() : 'proj-' + Date.now()), ...rest };
      });
    } catch (err) {
      console.error('[Database] Failed to read from MongoDB Atlas, falling back to local file:', err.message);
    }
  }
  return readProjectsFromFile();
}

async function saveProjects(projectsList) {
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
  const clean = code.trim().toUpperCase();
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(projects));
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
      const all = await getRegistrations();
      // Extract all numeric codes in BAW-NNN format (200+)
      const numericCodes = all
        .map(r => {
          const m = (r.uniqueCode || '').match(/^BAW-(\d+)$/i);
          return m ? parseInt(m[1], 10) : null;
        })
        .filter(n => n !== null && n >= 200);
      const nextNum = numericCodes.length > 0 ? Math.max(...numericCodes) + 1 : 200;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: `BAW-${nextNum}` }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Could not generate code' }));
    }
    return;
  }

  // ── Workshop Registrations Endpoints ──
  if (reqPath === '/api/registrations') {
    if (req.method === 'GET') {
      try {
        const list = await getRegistrations();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(list));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to retrieve registrations' }));
      }
      return;
    }

    if (req.method === 'POST') {
      try {
        const body = await parseJsonBody(req, 1024 * 128);
        const {
          reference,
          uniqueCode,
          name,
          department,
          level,
          phone,
          email,
          currentStatus,
          primaryGoal,
          qaQuestion,
          referredBy
        } = body;

        if (!uniqueCode || !name || !email) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unique Code, Name, and Email are required.' }));
          return;
        }

        const cleanUniqueCode = String(uniqueCode).trim().toUpperCase();
        const cleanRef = String(reference || `BAW-TRF-${Date.now()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`).trim();

        // Check if already registered by unique code or reference
        const existingByCode = await findRegistrationByUniqueCode(cleanUniqueCode);
        if (existingByCode) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, alreadyRegistered: true, registration: existingByCode }));
          return;
        }

        const existingByRef = await findRegistrationByReference(cleanRef);
        if (existingByRef) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, alreadyRegistered: true, registration: existingByRef }));
          return;
        }

        const feeNGN = parseInt(process.env.WORKSHOP_FEE_NGN) || 1500;
        const cleanReferredBy = String(referredBy || '').trim().toUpperCase();
        let finalReferredBy = '';

        // Validate referrer strictly against the database
        if (cleanReferredBy && cleanReferredBy !== cleanUniqueCode) {
          const referrerDoc = await findRegistrationByUniqueCode(cleanReferredBy);
          if (referrerDoc && referrerDoc.participateChallenge === 'Yes') {
            finalReferredBy = referrerDoc.uniqueCode;
          }
        }

        const isOptedChallenge = String(body.participateChallenge || '').trim().toLowerCase() === 'yes';

        const regDoc = {
          id: `reg-${Date.now()}`,
          reference: cleanRef,
          uniqueCode: isOptedChallenge ? cleanUniqueCode : '',
          name: String(name || '').trim(),
          department: String(department || '').trim(),
          level: String(level || '').trim(),
          phone: String(phone || '').trim(),
          email: String(email || '').trim().toLowerCase(),
          currentStatus: String(currentStatus || '').trim(),
          primaryGoal: String(primaryGoal || '').trim(),
          qaQuestion: String(qaQuestion || '').trim(),
          participateChallenge: isOptedChallenge ? 'Yes' : 'No',
          referredBy: finalReferredBy,
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
