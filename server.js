// server.js – backend riêng cho barcode, không dùng DB

require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 10000;

// Middlewares
app.use(cors());
app.use(express.json());

// ===== Helpers cho barcode =====

// Chuẩn hoá mã: chỉ giữ số
function normalizeBarcode(raw) {
  return String(raw || '').replace(/\D/g, '');
}

// Kiểm tra mã có "hợp lý" không (8–14 chữ số)
function isPlausibleBarcode(code) {
  return /^[0-9]{8,14}$/.test(code);
}

// Một ít trọng số domain & từ khoá
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

const FORM_WORDS  = ['viên', 'ống', 'siro', 'gói', 'chai', 'kem',
  'thuốc nhỏ mắt', 'thuốc nhỏ mũi', 'viên nang', 'viên nén',
  'hỗn dịch', 'dung dịch', 'xịt'];

const COMBO_WORDS = ['combo', 'set', 'bộ', 'tặng', 'quà tặng', 'kèm', 'pack'];

const DOSAGE_RE   = /\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|µg|g|kg|ml|mL|iu|IU)\b/gi;

const STORE_WORDS = ['nhà thuốc', 'nhathuoc', 'long châu', 'an khang',
  'pharmacity', 'medigo', 'tiki', 'shopee', 'lazada', 'central pharmacy'];

// Làm sạch tiêu đề sản phẩm: giữ lại tên + hàm lượng + dạng, bỏ đuôi quảng cáo
function cleanProductName(raw) {
  if (!raw) return '';
  let s = String(raw).trim();

  // Bỏ phần sau dấu | nếu là tên cửa hàng
  s = s.replace(/\s*\|\s*[^|]+$/i, (m) => {
    const tail = m.replace(/^\s*\|\s*/, '').toLowerCase();
    return STORE_WORDS.some(w => tail.includes(w)) ? '' : m;
  });

  // Bỏ phần sau dấu - nếu là tên cửa hàng
  s = s.replace(/\s*-\s*[^-]+$/i, (m) => {
    const tail = m.replace(/^\s*-\s*/, '').toLowerCase();
    return STORE_WORDS.some(w => tail.includes(w)) ? '' : m;
  });

  // Bỏ SKU / Mã ở cuối
  s = s.replace(/\b(SKU|MÃ|Mã)\s*[:#]?\s*[\w-]+$/gi, '');

  // Bỏ thông tin đóng gói kiểu "hộp 10 vỉ x 10 viên"...
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

// Phân tích 1 candidate (1 kết quả search)
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

  // Domain uy tín
  for (const d of DOMAIN_WEIGHTS) {
    if (hostname.includes(d.host)) {
      score += d.weight;
      break;
    }
  }

  const lowerTitle   = title.toLowerCase();
  const lowerSnippet = snippet.toLowerCase();

  // Có hàm lượng mg/ml
  if (DOSAGE_RE.test(lowerTitle) || DOSAGE_RE.test(lowerSnippet)) {
    score += 30;
    DOSAGE_RE.lastIndex = 0;
  }

  // Có dạng bào chế
  if (FORM_WORDS.some(w => lowerTitle.includes(w))) score += 20;

  // Không phải combo
  if (!COMBO_WORDS.some(w => lowerTitle.includes(w))) score += 8;
  else score -= 15;

  // Snippet có chữ thuốc / dược
  if (lowerSnippet.includes('thuốc') || lowerSnippet.includes('dược')) score += 5;

  // Độ dài tên
  const len = cleaned.length;
  if (len >= 20 && len <= 80) score += 8;
  else score -= Math.abs(len - 50) / 10;

  return { ...it, cleaned, hostname, score };
}

// Gom nhóm theo tên sạch, chọn nhóm tốt nhất
function pickBest(items) {
  const groups = new Map();

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
    const finalScore = g.totalScore / g.count + g.count * 3;
    return { ...g, finalScore };
  }).sort((a, b) => b.finalScore - a.finalScore);

  const best   = scoredGroups[0];
  const second = scoredGroups[1];

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

// ===== ROUTES =====

// Route test cho dễ check
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'medicate-barcode' });
});

// API chính: resolve barcode -> tên thuốc
app.get('/api/barcode/resolve', async (req, res) => {
  try {
    let code = String(req.query.code || '').trim();
    if (!code) return res.status(400).json({ error: 'Missing code' });

    code = normalizeBarcode(code);
    if (!isPlausibleBarcode(code)) {
      return res.status(400).json({ error: 'Invalid barcode format' });
    }

    const key = process.env.GOOGLE_API_KEY;
    const cx  = process.env.GOOGLE_CSE_ID;
    if (!key || !cx) {
      return res.status(500).json({ error: 'Missing GOOGLE_API_KEY/GOOGLE_CSE_ID' });
    }

    const q   = encodeURIComponent(`${code} thuốc`);
    const url = `https://www.googleapis.com/customsearch/v1?key=${key}&cx=${cx}&q=${q}`;

    const r = await fetch(url);
    if (!r.ok) {
      return res.status(502).json({ error: 'Search API failed' });
    }

    const data  = await r.json();
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

    return res.json({
      ok: true,
      provider: 'google',
      code,
      best: {
        name: best.name,
        alias: '',
        confidence: best.confidence,
        url: best.sampleUrl || null
      },
      candidates: best.candidates
    });
  } catch (e) {
    console.error('resolve error', e);
    res.status(500).json({ error: 'Resolve failed' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Medicate barcode server listening on port ${PORT}`);
});
