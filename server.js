const express = require('express');
const multer = require('multer');
const { Octokit } = require('@octokit/rest');
const crypto = require('crypto');
const mime = require('mime-types');

const app = express();

// --- KONFIGURASI GITHUB ---
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; 
const GITHUB_OWNER = 'USERNAME_GITHUB_KAMU'; // <--- GANTI DENGAN USERNAME KAMU
const GITHUB_REPO = 'NAMA_REPO_KAMU';       // <--- GANTI DENGAN NAMA REPO KAMU
const STORAGE_BRANCH = 'main'; 

const octokit = new Octokit({ auth: GITHUB_TOKEN });

app.use(express.json());

// Setup Multer
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB Limit

// ==========================================
// HELPER METADATA (DISIMPAN DI GITHUB)
// ==========================================
async function loadMetadata() {
  try {
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: 'metadata.json',
      ref: STORAGE_BRANCH
    });
    const content = Buffer.from(data.content, 'base64').toString('utf8');
    return JSON.parse(content);
  } catch (e) {
    // Jika file belum ada (404), kembalikan object kosong
    if (e.status === 404) return {};
    console.error('Error loading metadata:', e);
    return {};
  }
}

async function saveMetadata(metadata) {
  try {
    let sha = undefined;
    // Cek apakah file metadata.json sudah ada untuk mendapatkan SHA-nya
    try {
      const existing = await octokit.repos.getContent({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: 'metadata.json',
        ref: STORAGE_BRANCH
      });
      sha = existing.data.sha;
    } catch (e) {
      // File belum ada, biarkan sha undefined (GitHub akan buat baru)
    }

    await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER,
      repo: GITHUB_REPO,
      path: 'metadata.json',
      message: 'Update CDN metadata',
      content: Buffer.from(JSON.stringify(metadata, null, 2)).toString('base64'),
      branch: STORAGE_BRANCH,
      sha: sha 
    });
  } catch (e) {
    console.error('Error saving metadata:', e);
  }
}

// ==========================================
// 1. ROOT ENDPOINT (Cek Status)
// ==========================================
app.get('/', (req, res) => {
  res.send('CDN Vercel is Running! OK ✅');
});

// ==========================================
// 2. UPLOAD ENDPOINT
// ==========================================
app.post('/api/upload.php', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file' });
    
    const ext = path.extname(req.file.originalname).toLowerCase();
    const filename = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
    const token = crypto.randomBytes(32).toString('hex');
    const githubPath = `storage/${filename}`;
    
    // Upload file media ke GitHub
    await octokit.repos.createOrUpdateFileContents({
      owner: GITHUB_OWNER, 
      repo: GITHUB_REPO,
      path: githubPath, 
      message: `Upload: ${filename}`,
      content: req.file.buffer.toString('base64'), 
      branch: STORAGE_BRANCH
    });
    
    // Ambil metadata lama, tambahkan yang baru, lalu simpan kembali ke GitHub
    const metadata = await loadMetadata();
    metadata[token] = { 
      filename, 
      originalName: req.file.originalname, 
      type: ext.replace('.',''), 
      size: req.file.size, 
      uploadedAt: new Date().toISOString(), 
      githubPath 
    };
    await saveMetadata(metadata);
    
    res.json({ 
      success: true, 
      data: { 
        url: `https://ikyyapis-cloud-v1-extra.vercel.app/st-v2/ikyapis?type=${ext.replace('.','')}/token=${token}` 
      } 
    });
  } catch (err) {
    console.error('Upload Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// 3. ACCESS ENDPOINT
// ==========================================
app.get('/st-v2/ikyapis', async (req, res) => {
  try {
    // Parsing URL khusus untuk format: ?type=jpg/token=xxxxx
    const rawQuery = req.originalUrl.split('?')[1] || '';
    let type, token;
    
    if (rawQuery.includes('/token=')) {
      const parts = rawQuery.split('/token=');
      // parts[0] biasanya "type=jpg", ambil value setelah "=" pertama
      type = parts[0].split('=')[1]; 
      token = parts[1];
    } else {
      // Fallback ke query biasa: ?type=jpg&token=xxxxx
      type = req.query.type;
      token = req.query.token;
    }

    if (!type || !token) {
      return res.status(400).json({ message: 'Missing params' });
    }
    
    // Load metadata dari GitHub
    const meta = await loadMetadata();
    const fileData = meta[token];
    
    if (!fileData || fileData.type !== type) {
      return res.status(404).json({ message: 'Not found or invalid token' });
    }
    
    // Ambil konten file asli dari GitHub
    const { data } = await octokit.repos.getContent({
      owner: GITHUB_OWNER, 
      repo: GITHUB_REPO, 
      path: fileData.githubPath, 
      ref: STORAGE_BRANCH
    });
    
    const buffer = Buffer.from(data.content, 'base64');
    res.setHeader('Content-Type', mime.lookup(`.${type}`) || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000');
    res.send(buffer);
  } catch (err) {
    console.error('Access Error:', err);
    res.status(500).json({ error: err.message });
  }
});

// EXPORT APP UNTUK VERCEL
module.exports = app;
