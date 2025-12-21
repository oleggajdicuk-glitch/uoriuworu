const express = require('express');
const path = require('path');
const axios = require('axios');
const { spawn } = require('child_process');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ⚙️ ВСТАВ СВОЇ ДАНІ!
const TWITCH_CLIENT_ID = 'llel3d12hhsa02jebd4v7uwxz2iqfp';
const TWITCH_CLIENT_SECRET = '006x37pk4fjmxpdwl9llg5w2bg7act';

// Шлях до yt-dlp.exe
const ytdlpPath = path.join(__dirname, 'yt-dlp.exe');

// Папка для завантажених відео
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) {
  fs.mkdirSync(DOWNLOADS_DIR);
}

// ======= ТОКЕН =======
let appAccessToken = null;
let tokenExpiresAt = 0;

async function getAppAccessToken() {
  const now = Date.now();
  if (appAccessToken && now < tokenExpiresAt - 60_000) {
    return appAccessToken;
  }

  const resp = await axios.post('https://id.twitch.tv/oauth2/token', null, {
    params: {
      client_id: TWITCH_CLIENT_ID,
      client_secret: TWITCH_CLIENT_SECRET,
      grant_type: 'client_credentials'
    }
  });

  appAccessToken = resp.data.access_token;
  const expiresInMs = resp.data.expires_in * 1000;
  tokenExpiresAt = now + expiresInMs;
  return appAccessToken;
}

// Витягнути ID з URL
function extractClipId(url) {
  const m1 = url.match(/twitch\.tv\/\w+\/clip\/([\w-]+)/);
  if (m1) return m1[1];
  const m2 = url.match(/clips\.twitch\.tv\/([\w-]+)/);
  if (m2) return m2[1];
  return null;
}

function extractVideoId(url) {
  const m = url.match(/twitch\.tv\/videos\/(\d+)/);
  return m ? m[1] : null;
}

// ======= ЗАПИТИ ДО TWITCH API =======
async function fetchClipInfo(clipId, token) {
  const resp = await axios.get('https://api.twitch.tv/helix/clips', {
    params: { id: clipId },
    headers: {
      'Client-Id': TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`
    }
  });

  if (!resp.data.data.length) {
    throw new Error('Clip not found');
  }

  const clip = resp.data.data[0];

  return {
    type: 'clip',
    title: clip.title,
    author: clip.creator_name,
    broadcaster: clip.broadcaster_name,
    date: new Date(clip.created_at).toLocaleDateString('uk-UA'),
    duration: '0:30',
    description: `Кліп від ${clip.creator_name}`,
    view_count: clip.view_count,
    thumbnail_url: clip.thumbnail_url,
    qualities: [
      { name: '1080p60', size: '45 MB' },
      { name: '720p60', size: '28 MB' },
      { name: '480p', size: '12 MB' },
      { name: '360p', size: '6 MB' }
    ]
  };
}

async function fetchVodInfo(videoId, token) {
  const resp = await axios.get('https://api.twitch.tv/helix/videos', {
    params: { id: videoId },
    headers: {
      'Client-Id': TWITCH_CLIENT_ID,
      'Authorization': `Bearer ${token}`
    }
  });

  if (!resp.data.data.length) {
    throw new Error('VOD not found');
  }

  const v = resp.data.data[0];

  return {
    type: 'vod',
    title: v.title,
    author: v.user_name,
    broadcaster: v.user_name,
    date: new Date(v.created_at).toLocaleDateString('uk-UA'),
    duration: v.duration,
    description: v.description || `Запис стріму від ${v.user_name}`,
    view_count: v.view_count,
    thumbnail_url: v.thumbnail_url,
    qualities: [
      { name: '1080p', size: '2.5 GB' },
      { name: '720p', size: '1.2 GB' },
      { name: '480p', size: '600 MB' },
      { name: '360p', size: '250 MB' }
    ]
  };
}

// ======= MIDDLEWARE =======
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// health‑check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

// ======= /api/analyze =======
app.post('/api/analyze', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url || !url.includes('twitch.tv')) {
      return res.status(400).json({ success: false, error: 'Введи правильний Twitch URL' });
    }

    const token = await getAppAccessToken();

    const clipId = extractClipId(url);
    const videoId = extractVideoId(url);

    let data;
    if (clipId) {
      data = await fetchClipInfo(clipId, token);
    } else if (videoId) {
      data = await fetchVodInfo(videoId, token);
    } else {
      return res.status(400).json({ success: false, error: 'Не вдалось розпізнати, це кліп чи VOD' });
    }

    res.json({ success: true, data });
  } catch (e) {
    console.error(e);
    res.status(500).json({ success: false, error: 'Помилка при запиті до Twitch' });
  }
});

// ======= /api/download – РЕАЛЬНЕ ЗАВАНТАЖЕННЯ через yt-dlp =======
app.post('/api/download', async (req, res) => {
  const { url, quality } = req.body;
  if (!url || !quality) {
    return res.status(400).json({ success: false, error: 'Потрібні url та quality' });
  }

  const timestamp = Date.now();
  const outputFile = path.join(DOWNLOADS_DIR, `twitch_${timestamp}.mp4`);

  let formatFilter = 'best';
  if (quality.includes('1080')) formatFilter = 'best[height<=1080]';
  else if (quality.includes('720')) formatFilter = 'best[height<=720]';
  else if (quality.includes('480')) formatFilter = 'best[height<=480]';
  else if (quality.includes('360')) formatFilter = 'best[height<=360]';

  const ytdlp = spawn(ytdlpPath, [
    '-f', formatFilter,
    '-o', outputFile,
    url
  ]);

  let errorOutput = '';

  ytdlp.stderr.on('data', (data) => {
    errorOutput += data.toString();
    console.log('[yt-dlp]', data.toString());
  });

  ytdlp.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp error:', errorOutput);
      return res.status(500).json({ 
        success: false, 
        error: 'Не вдалось завантажити відео з Twitch' 
      });
    }

    if (fs.existsSync(outputFile)) {
      res.download(outputFile, `twitch_video_${quality}.mp4`, (err) => {
        if (err) console.error(err);
        // Видаляємо файл після завантаження
        fs.unlinkSync(outputFile);
      });
    } else {
      res.status(500).json({ success: false, error: 'Файл не знайдено' });
    }
  });
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log('🚀 Server on http://localhost:' + PORT);
});
