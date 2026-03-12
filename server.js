require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const mysql   = require('mysql2/promise');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const app     = express();

app.use(cors());
app.use(express.json());

const db = mysql.createPool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// ── Auth middleware ──
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Sem token' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ erro: 'Token inválido' }); }
}

// ── Status ──
app.get('/', (req, res) => res.json({ status: 'ok', projeto: 'DivertiPay' }));

app.get('/db-test', async (req, res) => {
  const [rows] = await db.query('SHOW TABLES');
  res.json({ tabelas: rows });
});

// ── LOGIN ──
app.post('/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const [rows] = await db.query('SELECT * FROM clientes WHERE email = ?', [email]);
    if (!rows.length) return res.status(401).json({ erro: 'Email ou senha incorretos' });
    const ok = await bcrypt.compare(senha, rows[0].senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Email ou senha incorretos' });
    const token = jwt.sign(
      { id: rows[0].id, nome: rows[0].nome, email: rows[0].email },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ token, nome: rows[0].nome, plano_expira: rows[0].plano_expira });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── CADASTRO (master cria cliente) ──
app.post('/auth/cadastro', async (req, res) => {
  try {
    const { nome, email, senha } = req.body;
    if (!nome || !email || !senha) return res.status(400).json({ erro: 'Preencha todos os campos' });
    const hash   = await bcrypt.hash(senha, 10);
    const expira = new Date();
    expira.setDate(expira.getDate() + 30);
    await db.query(
      'INSERT INTO clientes (nome, email, senha_hash, plano_expira) VALUES (?, ?, ?, ?)',
      [nome, email, hash, expira]
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ erro: 'Email já cadastrado' });
    res.status(500).json({ erro: e.message });
  }
});

// ── ME (dados do cliente logado) ──
app.get('/auth/me', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, nome, email, plano_expira, mensalidade_valor, mensalidade_dias FROM clientes WHERE id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Não encontrado' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── APARELHOS ──
app.get('/devices', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, nome, token, mp_user_id, online, noteiro_total FROM aparelhos WHERE cliente_id = ?',
      [req.user.id]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/devices', auth, async (req, res) => {
  try {
    const { nome, mp_user_id } = req.body;
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório' });
    const token = crypto.randomBytes(16).toString('hex');
    await db.query(
      'INSERT INTO aparelhos (cliente_id, nome, token, mp_user_id) VALUES (?, ?, ?, ?)',
      [req.user.id, nome, token, mp_user_id || null]
    );
    res.json({ ok: true, token });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/devices/:id/name', auth, async (req, res) => {
  try {
    await db.query(
      'UPDATE aparelhos SET nome = ? WHERE id = ? AND cliente_id = ?',
      [req.body.nome, req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.put('/devices/:id/mpid', auth, async (req, res) => {
  try {
    await db.query('UPDATE aparelhos SET mp_user_id = ? WHERE id = ?',
      [req.body.mp_user_id, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── PAGAMENTOS ──
app.get('/payments', auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const [rows] = await db.query(`
      SELECT p.*, a.nome AS aparelho_nome
      FROM pagamentos p
      JOIN aparelhos a ON p.aparelho_id = a.id
      WHERE a.cliente_id = ?
        AND DATE(p.criado_em) BETWEEN ? AND ?
      ORDER BY p.criado_em DESC
    `, [req.user.id, from || '2000-01-01', to || '2099-12-31']);
    res.json(rows);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── MASTER — listar clientes ──
app.get('/master/clients', async (req, res) => {
  try {
    const [clientes] = await db.query(
      'SELECT id, nome, email, plano_expira, mensalidade_valor, mensalidade_dias FROM clientes ORDER BY nome'
    );
    for (const c of clientes) {
      const [aparelhos] = await db.query(
        'SELECT id, nome, token, mp_user_id, online, noteiro_total FROM aparelhos WHERE cliente_id = ?',
        [c.id]
      );
      c.aparelhos = aparelhos;
    }
    res.json(clientes);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── MASTER — token temporário para acessar painel do cliente ──
app.get('/master/client-token/:id', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, nome, email, plano_expira, mensalidade_valor, mensalidade_dias FROM clientes WHERE id = ?',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Cliente não encontrado' });
    const token = jwt.sign(
      { id: rows[0].id, nome: rows[0].nome, email: rows[0].email },
      process.env.JWT_SECRET, { expiresIn: '2h' }
    );
    res.json({ token, nome: rows[0].nome, plano_expira: rows[0].plano_expira });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── MASTER — adicionar dias ao plano ──
app.post('/master/add-days', async (req, res) => {
  try {
    const { cliente_id, dias } = req.body;
    await db.query(
      `UPDATE clientes
       SET plano_expira = DATE_ADD(GREATEST(plano_expira, CURDATE()), INTERVAL ? DAY)
       WHERE id = ?`,
      [dias, cliente_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── MASTER — configurar mensalidade do cliente ──
app.post('/master/config-cliente', async (req, res) => {
  try {
    const { cliente_id, mensalidade_valor, mensalidade_dias } = req.body;
    await db.query(
      'UPDATE clientes SET mensalidade_valor = ?, mensalidade_dias = ? WHERE id = ?',
      [mensalidade_valor || 0, mensalidade_dias || 30, cliente_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── WEBHOOK ESP8266 ──
app.post('/webhook/esp32', async (req, res) => {
  try {
    const { token, tipo, valor } = req.body;
    const [aparelhos] = await db.query('SELECT * FROM aparelhos WHERE token = ?', [token]);
    if (!aparelhos.length) return res.status(404).json({ erro: 'Aparelho não encontrado' });
    await db.query(
      'INSERT INTO pagamentos (aparelho_id, tipo, valor) VALUES (?, ?, ?)',
      [aparelhos[0].id, tipo || 'pix', valor]
    );
    if (tipo === 'noteiro') {
      await db.query(
        'UPDATE aparelhos SET noteiro_total = noteiro_total + ? WHERE id = ?',
        [valor, aparelhos[0].id]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── START + migrations seguras ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('DivertiPay rodando na porta', PORT);
  const migrations = [
    `ALTER TABLE aparelhos ADD COLUMN mp_user_id VARCHAR(100) NULL`,
    `ALTER TABLE clientes ADD COLUMN mensalidade_valor DECIMAL(10,2) DEFAULT 0`,
    `ALTER TABLE clientes ADD COLUMN mensalidade_dias INT DEFAULT 30`,
  ];
  for (const sql of migrations) {
    try { await db.query(sql); }
    catch (e) { /* coluna já existe, ok */ }
  }
  console.log('Migrations ok.');
});