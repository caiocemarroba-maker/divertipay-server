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

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Sem token' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ erro: 'Token invalido' }); }
}

app.get('/', (req, res) => res.json({ status: 'ok', projeto: 'DivertiPay' }));

app.get('/db-test', async (req, res) => {
  const [rows] = await db.query('SHOW TABLES');
  res.json({ tabelas: rows });
});

app.get('/db-columns', async (req, res) => {
  try {
    const [ap] = await db.query('SHOW COLUMNS FROM aparelhos');
    const [pg] = await db.query('SHOW COLUMNS FROM pagamentos');
    res.json({ aparelhos: ap, pagamentos: pg });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});


// ── MIGRAÇÃO AUTOMÁTICA ─────────────────────────────────────
async function adicionarColuna(tabela, coluna, definicao) {
  try {
    const [cols] = await db.query(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [tabela, coluna]
    );
    if (cols.length === 0) {
      await db.query(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
      console.log(`[DB] Coluna ${tabela}.${coluna} criada`);
    } else {
      console.log(`[DB] ${tabela}.${coluna} ja existe`);
    }
  } catch(e) {
    console.error(`[DB] Erro ao criar ${tabela}.${coluna}:`, e.message);
  }
}

async function migrarBanco() {
  await adicionarColuna('aparelhos',  'updated_at', 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
  await adicionarColuna('pagamentos', 'status',     "VARCHAR(20) DEFAULT 'confirmado'");
  await adicionarColuna('pagamentos', 'recolhido',  'TINYINT(1) DEFAULT 0');
  console.log('[DB] Migracao concluida');
}
migrarBanco();

// ── AUTH ─────────────────────────────────────────────────────

app.post('/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const [rows] = await db.query('SELECT * FROM clientes WHERE email = ?', [email]);
    if (!rows.length) return res.status(401).json({ erro: 'Email ou senha incorretos' });
    const ok = await bcrypt.compare(senha, rows[0].senha_hash);
    if (!ok) return res.status(401).json({ erro: 'Email ou senha incorretos' });
    if (rows[0].bloquear_vencer) {
      const expira = new Date(rows[0].plano_expira);
      if (expira < new Date()) {
        return res.status(403).json({ erro: 'Acesso bloqueado. Plano vencido. Entre em contato com o suporte.' });
      }
    }
    const token = jwt.sign(
      { id: rows[0].id, nome: rows[0].nome, email: rows[0].email },
      process.env.JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ token, nome: rows[0].nome, plano_expira: rows[0].plano_expira });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

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
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ erro: 'Email ja cadastrado' });
    res.status(500).json({ erro: e.message });
  }
});

app.get('/auth/me', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, nome, email, plano_expira, mensalidade_valor, mensalidade_dias, bloquear_vencer FROM clientes WHERE id = ?',
      [req.user.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Nao encontrado' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── DEVICES ──────────────────────────────────────────────────

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
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatorio' });
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

app.delete('/devices/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM pagamentos WHERE aparelho_id = ?', [req.params.id]);
    await db.query('DELETE FROM aparelhos WHERE id = ? AND cliente_id = ?', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── PAYMENTS ─────────────────────────────────────────────────

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

// ── MASTER ───────────────────────────────────────────────────

app.get('/master/clients', async (req, res) => {
  try {
    const [clientes] = await db.query(
      'SELECT id, nome, email, plano_expira, mensalidade_valor, mensalidade_dias, bloquear_vencer FROM clientes ORDER BY nome'
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

app.get('/master/client-token/:id', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, nome, email, plano_expira FROM clientes WHERE id = ?',
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Cliente nao encontrado' });
    const token = jwt.sign(
      { id: rows[0].id, nome: rows[0].nome, email: rows[0].email },
      process.env.JWT_SECRET, { expiresIn: '2h' }
    );
    res.json({ token, nome: rows[0].nome, plano_expira: rows[0].plano_expira });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/master/add-days', async (req, res) => {
  try {
    const { cliente_id, dias } = req.body;
    await db.query(
      'UPDATE clientes SET plano_expira = DATE_ADD(GREATEST(plano_expira, CURDATE()), INTERVAL ? DAY) WHERE id = ?',
      [dias, cliente_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/master/config-cliente', async (req, res) => {
  try {
    const { cliente_id, mensalidade_valor, mensalidade_dias, bloquear_vencer } = req.body;
    console.log('config-cliente recebido:', { cliente_id, mensalidade_valor, mensalidade_dias, bloquear_vencer });
    if (!cliente_id) return res.status(400).json({ erro: 'cliente_id obrigatorio' });
    await db.query(
      'UPDATE clientes SET mensalidade_valor = ?, mensalidade_dias = ?, bloquear_vencer = ? WHERE id = ?',
      [mensalidade_valor || 0, mensalidade_dias || 30, bloquear_vencer ? 1 : 0, cliente_id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('config-cliente ERRO:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ── WEBHOOK NOTEIRO (ESP) ─────────────────────────────────────

app.post('/webhook/esp32', async (req, res) => {
  try {
    const { token, tipo, valor } = req.body;
    const [aparelhos] = await db.query('SELECT * FROM aparelhos WHERE token = ?', [token]);
    if (!aparelhos.length) return res.status(404).json({ erro: 'Aparelho nao encontrado' });

    // FIX: status='confirmado' para aparecer corretamente no painel
    await db.query(
      'INSERT INTO pagamentos (aparelho_id, tipo, valor, status) VALUES (?, ?, ?, ?)',
      [aparelhos[0].id, tipo || 'noteiro', valor, 'confirmado']
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

// ── FILA DE PULSOS ────────────────────────────────────────────
const filaPulsos = {};

app.post('/devices/:id/pulse', auth, async (req, res) => {
  try {
    const { pulsos, valor } = req.body;
    if (!pulsos || pulsos < 1) return res.status(400).json({ erro: 'Pulsos invalido' });

    const [rows] = await db.query(
      'SELECT * FROM aparelhos WHERE id = ? AND cliente_id = ?',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Aparelho nao encontrado' });

    const token = rows[0].token;
    // Limpa fila anterior — evita acúmulo de comandos
    filaPulsos[token] = [];
    const cmdId = Date.now();
    filaPulsos[token].push({ pulsos, id: cmdId });
    console.log('Pulso enfileirado:', rows[0].nome, 'pulsos:', pulsos, 'valor:', valor);

    // FIX: salva o valor em R$ real (enviado pelo painel), nao a qtd de pulsos
    const valorReal = parseFloat(valor) || 0;
    await db.query(
      'INSERT INTO pagamentos (aparelho_id, tipo, valor, status) VALUES (?, ?, ?, ?)',
      [rows[0].id, 'pix', valorReal, 'confirmado']
    );

    res.json({ ok: true, cmdId });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Limpa fila de um aparelho (emergência)
app.delete('/devices/:id/fila', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT token FROM aparelhos WHERE id = ? AND cliente_id = ?', [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Aparelho nao encontrado' });
    filaPulsos[rows[0].token] = [];
    res.json({ ok: true, msg: 'Fila limpa' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── ESP POLLING ───────────────────────────────────────────────

app.get('/esp/comando', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ erro: 'Token obrigatorio' });
    // FIX: atualiza updated_at para o setInterval detectar offline corretamente
    await db.query('UPDATE aparelhos SET online = 1, updated_at = NOW() WHERE token = ?', [token]);
    const fila = filaPulsos[token];
    if (fila && fila.length > 0) {
      const cmd = fila.shift();
      console.log('Comando enviado ao ESP, pulsos:', cmd.pulsos);
      return res.json({ tem_comando: true, pulsos: cmd.pulsos, id: cmd.id });
    }
    res.json({ tem_comando: false });
  } catch (e) {
    console.error('[ESP/COMANDO ERRO]', e.message);
    res.status(500).json({ erro: e.message });
  }
});

app.post('/esp/confirmar', async (req, res) => {
  try {
    const { token } = req.body;
    await db.query('UPDATE aparelhos SET online = 1, updated_at = NOW() WHERE token = ?', [token]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Marca offline aparelhos sem heartbeat ha mais de 30s
setInterval(async () => {
  try {
    await db.query("UPDATE aparelhos SET online = 0 WHERE updated_at < NOW() - INTERVAL 30 SECOND OR updated_at IS NULL");
  } catch(e) {}
}, 15000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('DivertiPay rodando na porta ' + PORT));
