// server.js – Medicate (Auth + Barcode Resolve + Static)
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const db = require('./db'); // giữ nguyên file db.js của bạn (Postgres + SSL Render)

const app = express();
app.use(cors());
app.use(express.json());

// --- Health ---
app.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// --- Auth (giữ nguyên như trước) ---
app.post('/api/auth/register', async (req, res) => {
  try {
    const { email, password, name } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Missing email/password' });
    const hash = await bcrypt.hash(password, 10);
    const result = await db.query(
      'INSERT INTO users(email, password_hash, name) VALUES($1,$2,$3) RETURNING id,email,name',
      [email, hash, name || null]
    );
    res.json({ ok: true, user: result.rows[0] });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Register failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'Missing email/password' });
    const q = await db.query('SELECT id,email,name,password_hash FROM users WHERE email=$1 LIMIT 1', [email]);
    if (!q.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const u = q.rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ sub: u.id, email: u.email }, process.env.JWT_SECRET || 'dev_secret', { expiresIn: '7d' });
    res.json({ ok: true, token, user: { id: u.id, email: u.email, name: u.name } });
  } catch (e) {
    console.error(e); res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/me', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev_secret');
    const q = await db.query('SELECT id,email,name FROM users WHERE id=$1 LIMIT 1', [payload.sub]);
    if (!q.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ ok: true, user: q.rows[0] });
  } catch (e) {
    console.error(e); res.status(401).json({ error: 'Invalid token' });
  }
});

// --- Helpers cho Barcode ---
// Chuẩn hoá mã: giữ lại số, bỏ dấu cách...
// --- Helpers cho Barcode ---
function cleanProductName(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/\s*\|.*$/,'').replace(/\s*[-–—]\s*.+$/,'');
  s = s.replace(/\b(\d+(?:\s)?(mg|mcg|g|kg|ml|mL|IU)|hộp|vỉ|viên|ống|chai|tuýp|lọ|hủ)\b.*$/i,'');
  s = s.replace(/#\w+$/,'').replace(/\b(SKU|MÃ)\s*[:\-\w]+$/i,'');
  return s.replace(/\s{2,}/g,' ').trim();
}

function pickBest(items) {
  const counts = new Map();
  for (const it of items) {
    const name = cleanProductName(it.title || '');
    if (!name) continue;
    const key = name.toLowerCase();
    counts.set(key, { name, score: (counts.get(key)?.score || 0) + 1 });
  }
  let best = null;
  for (const v of counts.values()) {
    const penalty = Math.max(0, (v.name.length - 40) / 40);
    const sc = v.score - penalty;
    if (!best || sc > best._sc) best = { name: v.name, _sc: sc };
  }
  return best ? { name: best.name, alias: '' } : null;
}

// --- /api/barcode/resolve ---
app.get('/api/barcode/resolve', async (req, res) => {
  try {
    const code = String(req.query.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Missing code' });

    const key = process.env.GOOGLE_API_KEY;
    const cx  = process.env.GOOGLE_CSE_ID;
    if (!key || !cx) return res.status(500).json({ error: 'Missing GOOGLE_API_KEY/GOOGLE_CSE_ID' });

    const q   = encodeURIComponent(`${code} thuốc`);
    const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${q}`;

    const r = await fetch(url).catch(() => null);
    if (!r || !r.ok) return res.status(502).json({ error: 'Search API failed' });
    const data = await r.json().catch(() => null);
    const items = (data && data.items) ? data.items.slice(0, 8) : [];
    const mapped = items.map(it => ({ title: it.title, link: it.link, snippet: it.snippet }));
    const best = pickBest(mapped);
    if (!best) return res.status(404).json({ error: 'No candidate' });

    return res.json({ ok: true, provider: 'google', best, samples: mapped.slice(0, 3) });
  } catch (e) {
    console.error('resolve error', e);
    res.status(500).json({ error: 'Resolve failed' });
  }
});

function normalizeBarcode(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits;
}

// Kiểm tra mã "hợp lý" (EAN-8, 12, 13, 14...)
function isPlausibleBarcode(code) {
  return /^[0-9]{8,14}$/.test(code);
}

// Các bộ từ khoá / trọng số domain
const DOMAIN_WEIGHTS = [
  { host: 'nhathuoclongchau', weight: 40 },
  { host: 'nhathuocankhang',  weight: 35 },
  { host: 'pharmacity',       weight: 35 },
  { host: 'medigo',           weight: 30 },
  { host: 'centralpharmacy',  weight: 28 },
  { host: 'tiki.vn',          weight: 25 },
  { host: 'shopee.vn',        weight: 20 },
  { host: 'lazada.vn',        weight: 20 },
];

const FORM_WORDS   = ['viên', 'ống', 'siro', 'gói', 'chai', 'kem', 'thuốc nhỏ mắt', 'thuốc nhỏ mũi',
                      'viên nang', 'viên nén', 'hỗn dịch', 'dung dịch', 'xịt'];
const COMBO_WORDS  = ['combo', 'set', 'bộ', 'tặng', 'quà tặng', 'kèm', 'pack'];
const DOSAGE_RE    = /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|g|kg|ml|mL|iu|IU)\b/gi;
const STORE_WORDS  = ['nhà thuốc', 'nhathuoc', 'long châu', 'an khang', 'pharmacity',
                      'medigo', 'tiki', 'shopee', 'lazada', 'central pharmacy'];

// Làm sạch tiêu đề sản phẩm, giữ lại tên + hàm lượng + dạng bào chế
function cleanProductName(raw) {
  if (!raw) return '';
  let s = String(raw).trim();

  // Bỏ phần tagline cửa hàng sau "|" hoặc "-"
  s = s.replace(/\s*\|\s*[^|]+$/i, (m) => {
    const tail = m.replace(/^\s*\|\s*/, '').toLowerCase();
    return STORE_WORDS.some(w => tail.includes(w)) ? '' : m;
  });
  s = s.replace(/\s*-\s*[^-]+$/i, (m) => {
    const tail = m.replace(/^\s*-\s*/, '').toLowerCase();
    return STORE_WORDS.some(w => tail.includes(w)) ? '' : m;
  });

  // Bỏ SKU / Mã sản phẩm ở cuối
  s = s.replace(/\b(SKU|MÃ|Mã)\s*[:#]?\s*[\w-]+$/gi, '');

  // Bỏ thông tin đóng gói kiểu "hộp 10 vỉ x 10 viên", "chai 100ml"...
  s = s.replace(/\b(hộp|hop)\s+\d+.*$/i, '');
  s = s.replace(/\b(vỉ|vỉ)\s+\d+.*$/i, '');
  s = s.replace(/\b(gói|gói)\s+\d+.*$/i, '');
  s = s.replace(/\b(chai|lọ|lọ|tuýp|tuyp)\s+\d+.*$/i, '');

  // Dọn khoảng trắng / dấu thừa
  s = s.replace(/[|]/g, ' ');
  s = s.replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/[\s\-–—|.,:;]+$/g, '').trim();

  return s;
}

// Phân tích 1 candidate: tính điểm dựa trên domain, hàm lượng, dạng bào chế...
function analyseCandidate(it) {
  const title   = it.title   || '';
  const snippet = it.snippet || '';
  const link    = it.link    || '';

  const cleaned = cleanProductName(title);
  if (!cleaned) return null;

  let hostname = '';
  try {
    hostname = new URL(link).hostname.toLowerCase();
  } catch (_) {
    hostname = (link || '').toLowerCase();
  }

  let score = 0;

  // Domain uy tín được cộng điểm mạnh
  for (const d of DOMAIN_WEIGHTS) {
    if (hostname.includes(d.host)) {
      score += d.weight;
      break;
    }
  }

  const lowerTitle   = title.toLowerCase();
  const lowerSnippet = snippet.toLowerCase();

  // Có hàm lượng mg/ml trong tiêu đề hoặc snippet
  if (DOSAGE_RE.test(lowerTitle) || DOSAGE_RE.test(lowerSnippet)) {
    score += 30;
    DOSAGE_RE.lastIndex = 0;
  }

  // Có dạng bào chế
  if (FORM_WORDS.some(w => lowerTitle.includes(w))) score += 20;

  // Không phải combo / khuyến mãi
  if (!COMBO_WORDS.some(w => lowerTitle.includes(w))) score += 8;
  else score -= 15;

  // Snippet có chữ "thuốc" / "dược" → thêm chút điểm
  if (lowerSnippet.includes('thuốc') || lowerSnippet.includes('dược')) score += 5;

  // Độ dài tên hợp lý
  const len = cleaned.length;
  if (len >= 20 && len <= 80) score += 8;
  else score -= Math.abs(len - 50) / 10;

  return { ...it, cleaned, hostname, score };
}

// Gom nhóm theo tên đã làm sạch + chọn nhóm tốt nhất
function pickBest(items) {
  const groups = new Map(); // key = cleaned lower, value = { name, totalScore, count, maxScore, sample }

  for (const it of items) {
    const analysed = analyseCandidate(it);
    if (!analysed) continue;
    const key = analysed.cleaned.toLowerCase();
    const g = groups.get(key) || {
      name: analysed.cleaned,
      totalScore: 0,
      count: 0,
      maxScore: -Infinity,
      sample: null
    };
    g.totalScore += analysed.score;
    g.count += 1;
    if (analysed.score > g.maxScore) {
      g.maxScore = analysed.score;
      g.sample = analysed;
    }
    groups.set(key, g);
  }

  if (!groups.size) return null;

  const scoredGroups = Array.from(groups.values()).map(g => {
    // điểm cuối = điểm trung bình + bonus theo số lần xuất hiện
    const finalScore = g.totalScore / g.count + g.count * 3;
    return { ...g, finalScore };
  }).sort((a, b) => b.finalScore - a.finalScore);

  const best   = scoredGroups[0];
  const second = scoredGroups[1];

  // Ước lượng độ tin cậy dựa trên khoảng cách điểm với nhóm thứ 2
  let confidence;
  if (!second) {
    confidence = 0.96;
  } else {
    const diff = best.finalScore - second.finalScore;
    if (diff >= 20)      confidence = 0.97;
    else if (diff >= 10) confidence = 0.90;
    else if (diff >= 5)  confidence = 0.80;
    else                 confidence = 0.60;
  }

  // Trả về tên tốt nhất + kèm vài candidate để UI muốn thì hiển thị
  return {
    name: best.name,
    confidence,
    sampleUrl: best.sample?.link || null,
    candidates: scoredGroups.slice(0, 5).map(g => ({
      name: g.name,
      score: g.finalScore,
      sampleUrl: g.sample?.link || null
    }))
  };
}

// --- /api/barcode/resolve ---
app.get('/api/barcode/resolve', async (req, res) => {
  try {
    let code = String(req.query.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Missing code' });

    // Chuẩn hoá mã, chỉ giữ số
    code = normalizeBarcode(code);
    if (!isPlausibleBarcode(code)) {
      return res.status(400).json({ error: 'Invalid barcode format' });
    }

    const key = process.env.GOOGLE_API_KEY;
    const cx  = process.env.GOOGLE_CSE_ID;
    if (!key || !cx) {
      return res.status(500).json({ error: 'Missing GOOGLE_API_KEY/GOOGLE_CSE_ID' });
    }

    // Query: mã + chữ "thuốc" để Google ưu tiên sản phẩm thuốc
    const q   = encodeURIComponent(`${code} thuốc`);
    const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${q}`;

    const r = await fetch(url).catch(() => null);
    if (!r || !r.ok) {
      return res.status(502).json({ error: 'Search API failed' });
    }

    const data  = await r.json().catch(() => null);
    const items = (data && data.items) ? data.items.slice(0, 10) : [];
    if (!items.length) {
      return res.status(404).json({ error: 'No search result for this code' });
    }

    const mapped = items.map(it => ({
      title:   it.title   || '',
      link:    it.link    || '',
      snippet: it.snippet || ''
    }));

    const best = pickBest(mapped);
    if (!best) {
      return res.status(404).json({ error: 'Cannot infer product name' });
    }

    // Định dạng trả về vẫn giữ shape cũ để barcode.js không phải sửa:
    //   data.best.name, data.best.alias
    return res.json({
      ok: true,
      provider: 'google',
      code,
      best: {
        name:  best.name,
        alias: '',
        confidence: best.confidence,
        url:  best.sampleUrl || null
      },
      candidates: best.candidates
    });
  } catch (e) {
    console.error('resolve error', e);
    res.status(500).json({ error: 'Resolve failed' });
  }
});

// --- Static (nếu bạn phục vụ site tĩnh từ /public). Tùy dự án, giữ/ bỏ dòng này cho đúng đường dẫn build của bạn.
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on', PORT));
