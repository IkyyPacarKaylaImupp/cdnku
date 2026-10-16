const express = require('express');
const multer = require('multer');
const { Octokit } = require('@octokit/rest');
const crypto = require('crypto');
const mime = require('mime-types');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Konfigurasi GitHub
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // Token dari environment variable
const GITHUB_OWNER = process.env.GITHUB_OWNER; // Username GitHub
const GITHUB_REPO = process.env.GITHUB_REPO;   // Nama repository
const STORAGE_BRANCH = 'main'; // Branch untuk menyimpan file

// Inisialisasi Octokit
const octokit = new Octokit({
  auth: GITHUB_TOKEN
});

// Middleware
app.use(express.json());
app.use(express.static('public'));

// Setup multer untuk handle upload
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

// Generate random token
function generateToken(length = 64) {
  return crypto.randomBytes(length).toString('hex');
}

// Simpan metadata file ke JSON (opsional, untuk tracking)
const METADATA_FILE = 'metadata.json';

function loadMetadata() {
  try {
    if (fs.existsSync(METADATA_FILE)) {
      const data = fs.readFileSync(METADATA_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (e) {
    console.error('Error loading metadata:', e);
  }
  return {};
}

function saveMetadata(metadata) {
  try {
    fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
  } catch (e) {
    console.error('Error saving metadata:', e);
  }
}

// Endpoint Upload
app.post('/api/upload.php', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No file uploaded'
      });
    }

    const file = req.file;
    const originalName = file.originalname;
    const ext = path.extname(originalName).toLowerCase();
    
    // Generate unique filename dan token
    const timestamp = Date.now();
    const randomStr = crypto.randomBytes(8).toString('hex');
    const filename = `${timestamp}_${randomStr}${ext}`;
    const token = generateToken(32);
    
    // Path di GitHub
    const githubPath = `storage/${filename}`;
    
    console.log(`Uploading ${originalName} to GitHub as ${githubPath}`);
    
    // Upload ke GitHub
    try {
      await octokit.repos.createOrUpdateFileContents({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: githubPath,
        message: `Upload: ${originalName}`,
        content: file.buffer.toString('base64'),
        branch: STORAGE_BRANCH
      });
      
      console.log(`Successfully uploaded to GitHub`);
    } catch (githubError) {
      console.error('GitHub upload error:', githubError);
      return res.status(500).json({
        success: false,
        message: 'Failed to upload to GitHub',
        error: githubError.message
      });
    }
    
    // Simpan metadata
    const metadata = loadMetadata();
    metadata[token] = {
      filename: filename,
      originalName: originalName,
      type: ext.replace('.', ''),
      size: file.size,
      uploadedAt: new Date().toISOString(),
      githubPath: githubPath
    };
    saveMetadata(metadata);
    
    // Generate URL akses
    const accessUrl = `/st-v2/ikyapis?type=${ext.replace('.', '')}/token=${token}`;
    
    res.json({
      success: true,
      message: 'File uploaded successfully',
      data: {
        filename: filename,
        originalName: originalName,
        type: ext.replace('.', ''),
        size: file.size,
        token: token,
        url: accessUrl,
        fullUrl: `https://${process.env.DOMAIN || 'localhost:' + PORT}${accessUrl}`
      }
    });
    
  } catch (error) {
    console.error('Upload error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Endpoint Akses File
app.get('/st-v2/ikyapis', async (req, res) => {
  try {
    const queryType = req.query.type;
    const queryToken = req.query.token;
    
    if (!queryType || !queryToken) {
      return res.status(400).json({
        success: false,
        message: 'Missing type or token parameter'
      });
    }
    
    // Parse type dan token dari query
    // Format: ?type=.mp4/token=randomtoken
    // Atau bisa juga: ?type=mp4&token=randomtoken
    let type, token;
    
    if (queryType.includes('/token=')) {
      const parts = queryType.split('/token=');
      type = parts[0].replace('.', '');
      token = parts[1];
    } else {
      type = queryType.replace('.', '');
      token = queryToken;
    }
    
    // Load metadata
    const metadata = loadMetadata();
    const fileData = metadata[token];
    
    if (!fileData) {
      return res.status(404).json({
        success: false,
        message: 'File not found or invalid token'
      });
    }
    
    // Verifikasi type match
    if (fileData.type !== type) {
      return res.status(400).json({
        success: false,
        message: 'Type mismatch'
      });
    }
    
    console.log(`Serving file: ${fileData.githubPath}`);
    
    // Ambil file dari GitHub
    try {
      const response = await octokit.repos.getContent({
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        path: fileData.githubPath,
        ref: STORAGE_BRANCH
      });
      
      const content = response.data.content;
      const buffer = Buffer.from(content, 'base64');
      
      // Set content type berdasarkan ekstensi
      const mimeType = mime.lookup(`.${type}`) || 'application/octet-stream';
      
      res.setHeader('Content-Type', mimeType);
      res.setHeader('Content-Disposition', `inline; filename="${fileData.originalName}"`);
      res.setHeader('Cache-Control', 'public, max-age=31536000');
      
      res.send(buffer);
      
    } catch (githubError) {
      console.error('GitHub fetch error:', githubError);
      return res.status(404).json({
        success: false,
        message: 'File not found on GitHub',
        error: githubError.message
      });
    }
    
  } catch (error) {
    console.error('Access error:', error);
    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString()
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`CDN Server running on port ${PORT}`);
  console.log(`GitHub Owner: ${GITHUB_OWNER}`);
  console.log(`GitHub Repo: ${GITHUB_REPO}`);
});

module.exports = app;
