const express = require('express');
const multer = require('multer');
const { Octokit } = require('@octokit/rest');
const crypto = require('crypto');
const mime = require('mime-types');
const fs = require('fs');
const path = require('path');

const app = express();

// --- KONFIGURASI GITHUB ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; 
const GITHUB_OWNER = 'IkyyPacarKaylaImupp'; // <--- GANTI
const GITHUB_REPO = 'cdnku';       // <--- GANTI
const STORAGE_BRANCH = 'main'; 

const octokit = new Octokit({ auth: GITHUB_TOKEN });

app.use(express.json());

// Setup Multer
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// Helper Metadata
const METADATA_FILE = 'metadata.json';
function loadMetadata() {
  try { if (fs.existsSync(METADATA_FILE)) return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8')); } catch(e){}
  return {};
}
function saveMetadata(m) {
  try { fs.writeFileSync(METADATA_FILE, JSON.stringify(m, null, 2)); } catch(e){}
}

// 1. ROOT ENDPOINT (Cek Status)
app.get('/', (req, res) => {
  res.send('CDN Vercel is Running! OK ✅');
});

// 2. UPLOAD ENDPOINT
app.post('/api/upload.php', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file' });
    
    const ext = path.extname(req.file.originalname).toLowerCase();
    const filename = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
    const token = crypto.randomBytes(32).toString('hex');
    const githubPath = `storage/${filename}`;
    
    await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER, repo: GITHUB_REPO,
      path: githubPath, message: `Upload: ${filename}`,
      content: req.file.buffer.toString('base64'), branch: STORAGE_BRANCH
    });
    
    const metadata = loadMetadata();
    metadata[token] = { 
      filename, originalName: req.file.originalname, 
      type: ext.replace('.',''), size: req.file.size, 
      uploadedAt: new Date().toISOString(), githubPath 
    };
    saveMetadata(metadata);
    
    res.json({ 
      success: true, 
      data: { 
        url: `https://ikyyapis-cloud-v1-extra.vercel.app/st-v2/ikyapis?type=${ext.replace('.','')}/token=${token}` 
      } 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. ACCESS ENDPOINT
app.get('/st-v2/ikyapis', async (req, res) => {
  try {
    let { type, token } = req.query;
    if (type && type.includes('/token=')) {
      const parts = type.split('/token='); 
      type = parts[0]; 
      token = parts[1];
    }
    if (!type || !token) return res.status(400).json({ message: 'Missing params' });
    
    const meta = loadMetadata();
    const fileData = meta[token];
    if (!fileData || fileData.type !== type) return res.status(404).json({ message: 'Not found' });
    
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER, repo: GITHUB_REPO, 
      path: fileData.githubPath, ref: STORAGE_BRANCH
    });
    
    const buffer = Buffer.from(data.content, 'base64');
    res.setHeader('Content-Type', mime.lookup(`.${type}`) || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// EXPORT APP UNTUK VERCEL
// JANGAN PAKAI app.listen() DI VERCEL!
module.exports = app;
