const express = require('express');
const multer = require('multer');
const axios = require('axios');
const crypto = require('crypto');
const mime = require('mime-types');
const path = require('path');

const app = express();
app.use(express.json());

// --- KONFIGURASI GITHUB ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; 
const GITHUB_OWNER = 'IkyyPacarKaylaImupp'; 
const GITHUB_REPO = 'cdnku';       
const STORAGE_BRANCH = 'main'; 
const METADATA_PATH = 'metadata.json';

// Setup Multer
const upload = multer({ 
  storage: multer.memoryStorage(), 
  limits: { fileSize: 50 * 1024 * 1024 } 
});

// ==========================================
// HELPER: METADATA DI GITHUB
// ==========================================
async function getMetadata() {
  try {
    const res = await axios.get(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${METADATA_PATH}`,
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
    );
    return {
      data: JSON.parse(Buffer.from(res.data.content, 'base64').toString()),
      sha: res.data.sha
    };
  } catch (err) {
    if (err.response?.status === 404) return { data: {}, sha: null };
    throw err;
  }
}

async function saveMetadata(newData, sha) {
  const content = Buffer.from(JSON.stringify(newData, null, 2)).toString('base64');
  await axios.put(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${METADATA_PATH}`,
    { message: 'Update CDN metadata', content, sha, branch: STORAGE_BRANCH },
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
  );
}

// ==========================================
// 1. ROOT ENDPOINT
// ==========================================
app.get('/', (req, res) => {
  res.send('CDN Vercel Streaming Mode OK ✅');
});

// ==========================================
// 2. UPLOAD ENDPOINT
// ==========================================
app.post('/api/upload.php', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file' });
    
    const ext = path.extname(req.file.originalname).toLowerCase().replace('.', '');
    const filename = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}.${ext}`;
    const token = crypto.randomBytes(32).toString('hex');
    const githubPath = `storage/${filename}`;
    
    // Upload file ke GitHub
    await axios.put(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${githubPath}`,
      {
        message: `Upload: ${filename}`,
        content: req.file.buffer.toString('base64'),
        branch: STORAGE_BRANCH
      },
      { headers: { Authorization: `Bearer ${GITHUB_TOKEN}` } }
    );
    
    // Simpan metadata
    const { data: meta, sha } = await getMetadata();
    meta[token] = { 
      filename, originalName: req.file.originalname, 
      type: ext, size: req.file.size, 
      uploadedAt: new Date().toISOString(), githubPath 
    };
    await saveMetadata(meta, sha);
    
    const baseUrl = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
    
    res.json({ 
      success: true, 
      data: { 
        url: `${baseUrl}/st-v2/ikyapis?type=${ext}/token=${token}` 
      } 
    });
  } catch (err) {
    console.error('Upload Error:', err.response?.data || err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 3. ACCESS ENDPOINT (DIRECT STREAMING)
// ==========================================
app.get('/st-v2/ikyapis', async (req, res) => {
  try {
    // Parsing URL (Handle Vercel Encoding %2F)
    let type, token;
    const queryStr = req.url.split('?')[1] || '';
    
    if (queryStr.includes('/token=') || queryStr.includes('%2Ftoken=')) {
      const separator = queryStr.includes('%2Ftoken=') ? '%2Ftoken=' : '/token=';
      const parts = queryStr.split(separator);
      const typePart = parts[0];
      type = typePart.includes('=') ? typePart.split('=')[1] : typePart;
      token = parts[1];
    } else {
      type = req.query.type;
      token = req.query.token;
    }

    if (!type || !token) {
      return res.status(400).json({ 
        message: 'Missing params', 
        debug: { receivedUrl: req.url } 
      });
    }
    
    // Cek metadata
    const { data: meta } = await getMetadata();
    const fileData = meta[token];
    
    if (!fileData || fileData.type !== type) {
      return res.status(404).json({ message: 'Not found or invalid token' });
    }
    
    // STREAMING LANGSUNG DARI RAW GITHUB
    // Gunakan responseType: 'stream' agar tidak membebani memory Vercel
    const rawUrl = `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${STORAGE_BRANCH}/${fileData.githubPath}`;
    
    const response = await axios.get(rawUrl, { 
      responseType: 'stream',
      timeout: 30000 // Timeout 30 detik biar gak nunggu selamanya
    });

    // Set Header sebelum pipe
    res.setHeader('Content-Type', mime.lookup(`.${type}`) || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.setHeader('X-Powered-By', 'IkyyCDN'); // Biar keliatan custom
    
    // Pipe stream dari GitHub langsung ke Client
    // Ini kuncinya: data mengalir real-time tanpa disimpan di memory server
    response.data.pipe(res);
    
    // Handle error saat streaming putus di tengah jalan
    response.data.on('error', (err) => {
      console.error('Stream error:', err.message);
      if (!res.headersSent) res.status(502).end('Stream interrupted');
    });

  } catch (err) {
    console.error('Access Error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

module.exports = app;
