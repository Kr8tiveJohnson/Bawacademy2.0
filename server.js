require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'projects.json');
const UPLOAD_DIR = path.join(__dirname, 'assets', 'projects');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

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

// --- MongoDB Atlas Connection ---
let dbClient = null;
let projectsCollection = null;
let isMongoConnected = false;

async function initMongoDB() {
  let uri = process.env.MONGODB_URI;
  if (!uri || !uri.trim()) {
    console.log('[Database] ℹ️  No MONGODB_URI found in environment. Using local projects.json file.');
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
    isMongoConnected = true;
    console.log(`[Database] ✅ Connected to MongoDB Atlas! Database: "${db.databaseName}"`);

    // Check if initial seeding is needed
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
    console.log('[Database] ⚠️  Falling back to local projects.json file storage.');
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
  // Always update local file as a local cache/fallback
  writeProjectsToFile(projectsList);

  if (isMongoConnected && projectsCollection) {
    try {
      await projectsCollection.deleteMany({});
      if (projectsList.length > 0) {
        // Strip out existing _id fields before insert to avoid duplicate key issues
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

const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  let reqPath = decodeURI(req.url.split('?')[0]);

  // Database status endpoint
  if (reqPath === '/api/db-status' && req.method === 'GET') {
    const list = await getProjects();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connected: isMongoConnected,
      driver: isMongoConnected ? 'MongoDB Atlas' : 'Local File (projects.json)',
      projectCount: list.length,
      hasUriConfigured: Boolean(process.env.MONGODB_URI && process.env.MONGODB_URI.trim())
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
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 50 * 1024 * 1024) { // 50MB limit
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Payload too large' }));
          req.destroy();
        }
      });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body);
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
          res.end(JSON.stringify({ error: 'Invalid JSON body: ' + err.message }));
        }
      });
      return;
    }
  }

  // Upload API route for saving project image files directly to disk (optional)
  if (reqPath === '/api/upload' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 50 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        const { filename, data } = JSON.parse(body);
        if (!filename || !data) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing filename or data' }));
          return;
        }

        const cleanName = Date.now() + '-' + filename.replace(/[^a-zA-Z0-9.-]/g, '_');
        const targetPath = path.join(UPLOAD_DIR, cleanName);

        const base64Data = data.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        fs.writeFileSync(targetPath, buffer);
        const publicUrl = 'assets/projects/' + cleanName;

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, url: publicUrl }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to process upload' }));
      }
    });
    return;
  }

  // Static File Serving
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
  const filePath = path.join(__dirname, reqPath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

// Initialize MongoDB then start server
initMongoDB().finally(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server listening on port ${PORT}`);
    console.log(`🌐 Local access: http://localhost:${PORT}`);
  });
});
