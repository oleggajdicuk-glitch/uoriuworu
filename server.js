// server.js

const express = require('express');
const cors = require('cors');
const path = require('path');
const { spawn } = require('child_process');

const app = express();

// ==== базові налаштування ====
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// статичний фронтенд (папка public з index.html)
app.use(express.static(path.join(__dirname, 'public')));

// порт для Render / Fly
const PORT = process.env.PORT || 3000;

// імʼя програми yt-dlp (ставиться через `pip install yt-dlp` в Build Command)
const YTDLP = 'yt-dlp';

// ===== helper: аналіз Twitch‑посилання через yt-dlp =====
function analyzeTwitch(url) {
  return new Promise((resolve, reject) => {
    const args = [
      '-J',           // JSON meta
      '--no-warnings',
      url,
    ];

    const child = spawn(YTDLP, args);

    let json = '';
    let err = '';

    child.stdout.on('data', (d) => {
      json += d.toString();
    });

    child.stderr.on('data', (d) => {
      err += d.toString();
      console.error('[yt-dlp analyze stderr]', d.toString());
    });

    child.on('error', (e) => {
      console.error('[yt-dlp analyze error]', e);
      reject(e);
    });

    child.on('close', (code) => {
      if (code !== 0) {
        return reject(
          new Error('yt-dlp exited with code ' + code + ' ' + err)
        );
      }
      try {
        const data = JSON.parse(json);
        resolve(data);
      } catch (e) {
        reject(e);
      }
    });
  });
}

// ===== helper: сформувати список якостей =====
function extractQualities(infoJson) {
  // yt-dlp повертає або `formats`, або один формат
  const formats = infoJson.formats || [];
  const qualities = [];

  for (const f of formats) {
    if (!f.height && !f.abr) continue;

    let name = '';
    if (f.vcodec && f.vcodec !== 'none') {
      name = `${f.height || ''}p`;
      if (f.fps) name += `@${f.fps}fps`;
    } else if (f.acodec && f.acodec !== 'none') {
      name = 'Audio';
    } else {
      continue;
    }

    const sizeMb = f.filesize || f.filesize_approx || 0;
    const sizeStr = sizeMb
      ? (sizeMb / 1024 / 1024).toFixed(1) + ' MB'
      : 'розмір невідомий';

    qualities.push({
      id: f.format_id,
      name,
      size: sizeStr,
    });
  }

  // якщо порожньо – хоча б один best
  if (!qualities.length) {
    qualities.push({
      id: 'best',
      name: 'best',
      size: 'невідомо',
    });
  }

  return qualities;
}

// ===== /api/analyze =====
app.post('/api/analyze', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'No URL',
      });
    }

    const info = await analyzeTwitch(url);

    const data = {
      title: info.title || '',
      author:
        (info.uploader || info.channel || info.author || '').toString(),
      broadcaster: info.channel || '',
      date: info.upload_date || info.release_date || '',
      duration: info.duration
        ? Math.round(info.duration) + ' сек.'
        : '',
      description: info.description || '',
      qualities: extractQualities(info),
    };

    res.json({ success: true, data });
  } catch (e) {
    console.error('/api/analyze error', e);
    res.status(500).json({
      success: false,
      error: 'Analyze failed: ' + e.message,
    });
  }
});

// ===== helper: запуск yt-dlp для завантаження =====
function streamDownload(url, formatId, res) {
  const args = [
    '-f',
    formatId || 'best',
    '-o',
    '-',       // виводити в stdout
    url,
  ];

  const child = spawn(YTDLP, args);

  child.stdout.on('data', (chunk) => {
    res.write(chunk);
  });

  child.stderr.on('data', (d) => {
    console.error('[yt-dlp download stderr]', d.toString());
  });

  child.on('error', (err) => {
    console.error('[yt-dlp download error]', err);
    if (!res.headersSent) {
      res.status(500).end('Download error');
    } else {
      res.end();
    }
  });

  child.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp exited with code', code);
      if (!res.headersSent) {
        res.status(500).end('yt-dlp failed with code ' + code);
      } else {
        res.end();
      }
    } else {
      res.end();
    }
  });
}

// ===== /api/download =====
app.post('/api/download', (req, res) => {
  try {
    const { url, quality } = req.body || {};

    if (!url || typeof url !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'No URL',
      });
    }

    const formatId = quality || 'best';

    // заголовки для завантаження файлу
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="twitch_${formatId}.mp4"`
    );

    streamDownload(url, formatId, res);
  } catch (e) {
    console.error('/api/download error', e);
    if (!res.headersSent) {
      res.status(500).end('Download error: ' + e.message);
    } else {
      res.end();
    }
  }
});

// ===== все решта віддаємо index.html (SPA) =====
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== старт сервера =====
app.listen(PORT, () => {
  console.log('🚀 Server on http://localhost:' + PORT);
});

