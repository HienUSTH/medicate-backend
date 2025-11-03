// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const pool = require('./db');

const app = express();
app.use(cors());
app.use(express.json());

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { fullname, email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ message: 'Thiếu email hoặc mật khẩu' });
    }
    const exist = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
    if (exist.rows.length > 0) {
      return res.status(400).json({ message: 'Email đã tồn tại' });
    }
    const hash = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO users(fullname, email, password_hash) VALUES ($1,$2,$3)',
      [fullname || '', email, hash]
    );
    return res.json({ message: 'Đăng ký thành công' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email=$1', [email]);
    if (result.rows.length === 0) {
      return res.status(400).json({ message: 'Sai email hoặc mật khẩu' });
    }
    const user = result.rows[0];
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(400).json({ message: 'Sai email hoặc mật khẩu' });
    }
    const token = jwt.sign(
      { id: user.id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );
    return res.json({ message: 'Đăng nhập thành công', token });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: 'Lỗi server' });
  }
});

// route test bảo vệ
app.get('/api/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ message: 'Không có token' });
  const token = auth.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return res.json(decoded);
  } catch (err) {
    return res.status(401).json({ message: 'Token không hợp lệ' });
  }
});

app.listen(process.env.PORT, () => {
  console.log('Server chạy cổng', process.env.PORT);
});
