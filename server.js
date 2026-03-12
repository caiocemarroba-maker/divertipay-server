require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = express();

app.use(cors());
app.use(express.json());

const db = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// ── Middleware de autenticação ──
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Sem token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ erro: 'Token inválido' });
  }
}

// ── Rotas públicas ──
app.get('/', (req, res) => {
  res.json({ status: 'ok', projeto: 'DivertiPay' });
});

app.get('/db-test', async (req, res) => {
  const [rows] = await db.query('SHOW TABLES');
  res.json({ tabelas: rows });
});

// ── LOGIN ──
app.post('/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const [rows] = await db.query('SELECT * FROM clientes WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(401).json({ erro: 'Email ou senha incorretos' });
    const cliente = rows[0];
    const ok = await bcrypt.compare(senha, cliente.senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Email ou senha incorretos' });
    const token = jwt.sign(
      { id: cliente.id, nome: cliente.nome, email: cliente.email },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );
    res.json({ token, nome: cliente.nome, plano_expira: cliente.plano_expira });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── CADASTRO (usado pelo master para criar clientes) ──
app.post('/auth/cadastro', async (req, res) => {
  try {
    const { nome, email, senha } = req.body;
    const hash = await bcrypt.hash(senha, 10);
    const expira = new Date();
    expira.setDate(expira.getDate() + 30);
    await db.query(
      'INSERT INTO clientes (nome, email, senha_hash, plano_expira) VALUES (?, ?, ?, ?)',
      [nome, email, hash, expira]
    );
    res.json({ ok: true, mensagem: 'Cliente criado com 30 dias de plano!' });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ erro: 'Email já cadastrado' });
    res.status(500).json({ erro: e.message });
  }
});

// ── APARELHOS ──
app.get('/devices', auth, async (req, res) => {
  const [rows] = await db.query('SELECT * FROM aparelhos WHERE cliente_id = ?', [req.user.id]);
  res.json(rows);
});

app.put('/devices/:id/name', auth, async (req, res) => {
  await db.query('UPDATE aparelhos SET nome = ? WHERE id = ? AND cliente_id = ?',
    [req.body.nome, req.params.id, req.user.id]);
  res.json({ ok: true });
});

// ── PAGAMENTOS ──
app.get('/payments', auth, async (req, res) => {
  const { from, to } = req.query;
  const [rows] = await db.query(`
    SELECT p.*, a.nome as aparelho_nome
    FROM pagamentos p
    JOIN aparelhos a ON p.aparelho_id = a.id
    WHERE a.cliente_id = ?
    AND DATE(p.criado_em) BETWEEN ? AND ?
    ORDER BY p.criado_em DESC
  `, [req.user.id, from || '2000-01-01', to || '2099-12-31']);
  res.json(rows);
});

// ── WEBHOOK ESP8266 ──
app.post('/webhook/esp32', async (req, res) => {
  try {
    const { token, tipo, valor } = req.body;
    const [aparelhos] = await db.query('SELECT * FROM aparelhos WHERE token = ?', [token]);
    if (aparelhos.length === 0) return res.status(404).json({ erro: 'Aparelho não encontrado' });
    const aparelho = aparelhos[0];
    await db.query(
      'INSERT INTO pagamentos (aparelho_id, tipo, valor) VALUES (?, ?, ?)',
      [aparelho.id, tipo, valor]
    );
    if (tipo === 'noteiro') {
      await db.query('UPDATE aparelhos SET noteiro_total = noteiro_total + ? WHERE id = ?',
        [valor, aparelho.id]);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('DivertiPay rodando na porta', PORT);
});
