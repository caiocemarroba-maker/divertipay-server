require('dotenv').config();
const express = require('express');
const axios   = require('axios');
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

// ── MIGRAÇÃO AUTOMÁTICA ──────────────────────────────────────
async function adicionarColuna(tabela, coluna, definicao) {
  try {
    const [cols] = await db.query(
      'SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
      [tabela, coluna]
    );
    if (cols.length === 0) {
      await db.query(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${definicao}`);
      console.log(`[DB] Coluna ${tabela}.${coluna} criada`);
    }
  } catch(e) {
    console.error(`[DB] Erro ao criar ${tabela}.${coluna}:`, e.message);
  }
}

async function migrarBanco() {
  await adicionarColuna('aparelhos', 'updated_at',   'TIMESTAMP NULL DEFAULT NULL');
  await adicionarColuna('aparelhos', 'mp_store_id',  'VARCHAR(64) DEFAULT NULL');
  await adicionarColuna('aparelhos', 'mp_pos_id',    'VARCHAR(64) DEFAULT NULL');
  await adicionarColuna('aparelhos', 'valor_pulso',  'DECIMAL(10,2) DEFAULT 1.00');
  await adicionarColuna('pagamentos', 'status',      "VARCHAR(30) DEFAULT 'confirmado'");
  try { await db.query("ALTER TABLE pagamentos MODIFY COLUMN status VARCHAR(30) DEFAULT 'confirmado'"); } catch(e) {}
  await adicionarColuna('pagamentos', 'recolhido',   'TINYINT(1) DEFAULT 0');
  await adicionarColuna('pagamentos', 'mp_payment_id', 'VARCHAR(64) DEFAULT NULL');
  await adicionarColuna('pagamentos', 'mp_extornado',  'TINYINT(1) DEFAULT 0');
  await adicionarColuna('fila_pulsos', 'pagamento_id', 'INT DEFAULT NULL');
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS fila_pulsos (
        id          INT AUTO_INCREMENT PRIMARY KEY,
        aparelho_id INT NOT NULL,
        pulsos      INT NOT NULL DEFAULT 1,
        pagamento_id INT DEFAULT NULL,
        criado_em   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_aparelho (aparelho_id)
      )
    `);
    console.log('[DB] Tabela fila_pulsos OK');
  } catch(e) {
    console.error('[DB] Erro fila_pulsos:', e.message);
  }
  // Limpa fila antiga ao iniciar (evita pulsos de deploy anterior)
  try {
    await db.query('DELETE FROM fila_pulsos WHERE criado_em < NOW() - INTERVAL 5 MINUTE');
    console.log('[DB] Fila antiga limpa no boot');
  } catch(e) {}
  console.log('[DB] Migracao concluida');
}
migrarBanco();

// ── ROTAS BÁSICAS ────────────────────────────────────────────

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

app.get('/debug/aparelhos', async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, nome, online, updated_at, NOW() as agora, TIMESTAMPDIFF(SECOND, updated_at, NOW()) as seg_atras FROM aparelhos'
    );
    const [fila] = await db.query('SELECT * FROM fila_pulsos');
    res.json({ aparelhos: rows, fila_pulsos: fila });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

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
      'SELECT id, nome, token, mp_user_id, mp_store_id, mp_pos_id, valor_pulso, online, noteiro_total FROM aparelhos WHERE cliente_id = ?',
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

// Vincular mp_store_id, mp_pos_id ao aparelho (identificacao do caixa no MP)
app.post("/admin/aparelho/:id/mp-store", async (req, res) => {
  try {
    const { mp_store_id, mp_pos_id } = req.body;
    if (!mp_pos_id) return res.status(400).json({ erro: "mp_pos_id obrigatorio" });
    await db.query(
      "UPDATE aparelhos SET mp_store_id = ?, mp_pos_id = ? WHERE id = ?",
      [mp_store_id || null, mp_pos_id, req.params.id]
    );
    const [rows] = await db.query("SELECT id, nome, mp_store_id, mp_pos_id, valor_pulso FROM aparelhos WHERE id = ?", [req.params.id]);
    res.json({ ok: true, aparelho: rows[0] });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.delete('/devices/:id', auth, async (req, res) => {
  try {
    await db.query('DELETE FROM fila_pulsos WHERE aparelho_id = ?', [req.params.id]);
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

// ── MASTER ────────────────────────────────────────────────────

app.get('/master/clients', async (req, res) => {
  try {
    const [clientes] = await db.query(
      'SELECT id, nome, email, plano_expira, mensalidade_valor, mensalidade_dias, bloquear_vencer FROM clientes ORDER BY nome'
    );
    for (const c of clientes) {
      const [aparelhos] = await db.query(
        'SELECT id, nome, token, mp_user_id, mp_store_id, mp_pos_id, valor_pulso, online, noteiro_total FROM aparelhos WHERE cliente_id = ?',
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
    if (!cliente_id) return res.status(400).json({ erro: 'cliente_id obrigatorio' });
    await db.query(
      'UPDATE clientes SET mensalidade_valor = ?, mensalidade_dias = ?, bloquear_vencer = ? WHERE id = ?',
      [mensalidade_valor || 0, mensalidade_dias || 30, bloquear_vencer ? 1 : 0, cliente_id]
    );
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── WEBHOOK NOTEIRO (ESP) ─────────────────────────────────────

app.post('/webhook/esp32', async (req, res) => {
  try {
    const { token, tipo, valor } = req.body;
    const [aparelhos] = await db.query('SELECT * FROM aparelhos WHERE token = ?', [token]);
    if (!aparelhos.length) return res.status(404).json({ erro: 'Aparelho nao encontrado' });
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

// ── FILA DE PULSOS (no banco — sobrevive a redeploy) ──────────

app.post('/devices/:id/pulse', auth, async (req, res) => {
  try {
    const { pulsos, valor } = req.body;
    const qtd = parseInt(pulsos) || 1;
    if (qtd < 1 || qtd > 99) return res.status(400).json({ erro: 'Pulsos invalido (1-99)' });

    const [rows] = await db.query(
      'SELECT * FROM aparelhos WHERE id = ? AND cliente_id = ?',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Aparelho nao encontrado' });

    // Limpa fila pendente antes de adicionar novo comando
    await db.query('DELETE FROM fila_pulsos WHERE aparelho_id = ?', [rows[0].id]);
    await db.query('INSERT INTO fila_pulsos (aparelho_id, pulsos) VALUES (?, ?)', [rows[0].id, qtd]);

    // Registra pagamento com valor real em R$
    const valorReal = parseFloat(valor) || 0;
    if (valorReal > 0) {
      await db.query(
        'INSERT INTO pagamentos (aparelho_id, tipo, valor, status) VALUES (?, ?, ?, ?)',
        [rows[0].id, 'pix', valorReal, 'confirmado']
      );
    }

    console.log(`[Pulse] ${rows[0].nome} → ${qtd} pulsos, R$${valorReal}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('[Pulse ERRO]', e.message);
    res.status(500).json({ erro: e.message });
  }
});

app.delete('/devices/:id/fila', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id FROM aparelhos WHERE id = ? AND cliente_id = ?', [req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ erro: 'Aparelho nao encontrado' });
    await db.query('DELETE FROM fila_pulsos WHERE aparelho_id = ?', [rows[0].id]);
    res.json({ ok: true, msg: 'Fila limpa' });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── ESP POLLING ───────────────────────────────────────────────

app.get('/esp/comando', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ erro: 'Token obrigatorio' });

    // Atualiza heartbeat — marca online
    const [upd] = await db.query(
      'UPDATE aparelhos SET online = 1, updated_at = NOW() WHERE token = ?', [token]
    );
    if (upd.affectedRows === 0) {
      return res.status(404).json({ erro: 'Token nao encontrado' });
    }

    // Busca aparelho e fila
    const [aparelho] = await db.query('SELECT id, nome FROM aparelhos WHERE token = ?', [token]);
    if (!aparelho.length) return res.json({ tem_comando: false });

    const [fila] = await db.query(
      'SELECT * FROM fila_pulsos WHERE aparelho_id = ? ORDER BY id ASC LIMIT 1',
      [aparelho[0].id]
    );

    if (fila.length > 0) {
      const cmd = fila[0];
      // Remove da fila ANTES de responder — evita disparar duas vezes
      await db.query('DELETE FROM fila_pulsos WHERE id = ?', [cmd.id]);
      console.log(`[ESP] ${aparelho[0].nome} → ${cmd.pulsos} pulsos`);
      return res.json({ tem_comando: true, pulsos: cmd.pulsos, id: cmd.id });
    }

    res.json({ tem_comando: false });
  } catch (e) {
    console.error('[ESP/COMANDO ERRO]', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ── DELETAR PAGAMENTO ─────────────────────────────────────────
app.delete('/payments/:id', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT p.id FROM pagamentos p JOIN aparelhos a ON a.id = p.aparelho_id JOIN clientes c ON c.id = a.cliente_id WHERE p.id = ? AND c.id = ?',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Pagamento não encontrado' });
    await db.query('DELETE FROM pagamentos WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── EXTORNAR PAGAMENTO ────────────────────────────────────────
app.post('/payments/:id/extornar', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT p.* FROM pagamentos p JOIN aparelhos a ON a.id = p.aparelho_id JOIN clientes c ON c.id = a.cliente_id WHERE p.id = ? AND c.id = ?',
      [req.params.id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ erro: 'Pagamento não encontrado' });
    const pag = rows[0];
    if (pag.mp_extornado) return res.status(400).json({ erro: 'Já extornado' });
    if (!pag.mp_payment_id) return res.status(400).json({ erro: 'Sem ID de pagamento MP' });
    const mpToken = process.env.MP_ACCESS_TOKEN;
    await extornarMP(pag.mp_payment_id, mpToken);
    await db.query("UPDATE pagamentos SET status='extornado', mp_extornado=1 WHERE id=?", [pag.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.post('/esp/confirmar', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ erro: 'Token obrigatorio' });
    await db.query('UPDATE aparelhos SET online = 1, updated_at = NOW() WHERE token = ?', [token]);

    // Confirma pagamento MP pendente desse aparelho (se houver)
    const [ap] = await db.query('SELECT id FROM aparelhos WHERE token = ?', [token]);
    if (ap.length) {
      await db.query(
        "UPDATE pagamentos SET status = 'confirmado' WHERE aparelho_id = ? AND status = 'pendente'",
        [ap[0].id]
      );
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// ── WEBHOOK MERCADO PAGO ──────────────────────────────────────

app.post('/webhook/mercadopago', async (req, res) => {
  console.log('[MP RAW] query:', JSON.stringify(req.query), 'body:', JSON.stringify(req.body));
  try {
    const xSignature = req.headers['x-signature'] || '';
    const xRequestId = req.headers['x-request-id'] || '';
    // IPN manda topic=payment&id=X na query, webhook manda data.id
    const dataId     = req.query['id'] || req.query['data.id'] || req.body?.data?.id || '';

    // Valida assinatura (apenas em pagamentos reais - live_mode true)
    const secret = process.env.MP_WEBHOOK_SECRET || '';
    const isLive = req.body?.live_mode === true;
    if (secret && xSignature && isLive) {
      const ts = xSignature.split(',').find(p => p.startsWith('ts='))?.split('=')[1] || '';
      const v1 = xSignature.split(',').find(p => p.startsWith('v1='))?.split('=')[1] || '';
      const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts}`;
      const hash = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
      if (v1 && hash !== v1) {
        console.warn('[MP] Assinatura invalida');
        return res.sendStatus(401);
      }
    }

    // IPN manda topic=payment na query, webhook manda type no body
    const tipo = req.query?.topic || req.body?.type || '';
    console.log('[MP Webhook] tipo:', tipo, 'id:', dataId);

    if (!tipo || !dataId) return res.sendStatus(200);

    const mpToken = process.env.MP_ACCESS_TOKEN;
    if (!mpToken) return res.sendStatus(500);

    let pg = null;

    if (tipo === 'merchant_order') {
      // merchant_order: busca a order e extrai o pagamento aprovado
      const orderResp = await axios.get(`https://api.mercadolibre.com/merchant_orders/${dataId}?access_token=${mpToken}`);
      const order = orderResp.data;
      console.log('[MP Order] status:', order.order_status, 'collector:', order.collector?.id, 'ext_ref:', order.external_reference, 'app_id:', order.application_id, 'client_id:', order.client_id);
      if (order.order_status !== 'paid') {
        console.log('[MP Order] nao paga ainda, ignorando');
        return res.sendStatus(200);
      }
      const pagAprovado = (order.payments || []).find(p => p.status === 'approved');
      if (!pagAprovado) {
        console.log('[MP Order] sem pagamento aprovado');
        return res.sendStatus(200);
      }
      // collector.id = ID do vendedor MP = mp_store_id no banco
      const collectorId = order.collector?.id?.toString() || null;
      pg = {
        id:                 pagAprovado.id,
        status:             'approved',
        transaction_amount: pagAprovado.total_paid_amount || pagAprovado.transaction_amount,
        pos_id:             order.pos_id?.toString() || null,
        store_id:           collectorId,
        external_reference: order.external_reference,
      };
    } else if (tipo === 'payment') {
      const mpResp = await axios.get(`https://api.mercadopago.com/v1/payments/${dataId}`, {
        headers: { Authorization: `Bearer ${mpToken}` }
      });
      pg = mpResp.data;
    } else {
      return res.sendStatus(200);
    }

    if (!pg || pg.status !== 'approved') {
      console.log('[MP] Nao aprovado:', pg?.status);
      return res.sendStatus(200);
    }

    const valor   = parseFloat(pg.transaction_amount) || 0;
    const posId   = pg.pos_id?.toString() || null;
    const storeId = pg.store_id?.toString() || null;

    console.log('[MP] Aprovado! valor:', valor, 'pos_id:', posId, 'store_id:', storeId);

    // Encontra aparelho pelo mp_pos_id (caixa especifico) — fallback store_id
    let aparelho = null;
    if (posId) {
      const [rows] = await db.query("SELECT * FROM aparelhos WHERE mp_pos_id = ?", [posId]);
      if (rows.length) aparelho = rows[0];
    }
    if (!aparelho && storeId) {
      const [rows] = await db.query("SELECT * FROM aparelhos WHERE mp_store_id = ?", [storeId]);
      if (rows.length) aparelho = rows[0];
    }
    if (!aparelho) {
      console.warn("[MP] Aparelho nao encontrado para pos_id:", posId, "store_id:", storeId);
      return res.sendStatus(200);
    }

    // Aparelho offline → extorna imediatamente
    if (!aparelho.online) {
      console.warn('[MP] Aparelho offline — extornando');
      await extornarMP(dataId, mpToken);
      return res.sendStatus(200);
    }

    // Calcula pulsos
    const valorPulso = parseFloat(aparelho.valor_pulso) || 1;
    const qtdPulsos  = Math.max(1, Math.round(valor / valorPulso));

    // Salva pagamento como pendente
    const [ins] = await db.query(
      'INSERT INTO pagamentos (aparelho_id, tipo, valor, status, mp_payment_id) VALUES (?, ?, ?, ?, ?)',
      [aparelho.id, 'pix', valor, 'pendente', dataId]
    );
    const pagamentoId = ins.insertId;

    // Enfileira pulsos
    await db.query('DELETE FROM fila_pulsos WHERE aparelho_id = ?', [aparelho.id]);
    await db.query(
      'INSERT INTO fila_pulsos (aparelho_id, pulsos, pagamento_id) VALUES (?, ?, ?)',
      [aparelho.id, qtdPulsos, pagamentoId]
    );

    console.log(`[MP] ${aparelho.nome} → ${qtdPulsos} pulsos (pag #${pagamentoId})`);

    // Timeout 20s — se ESP não confirmar, extorna
    setTimeout(async () => {
      try {
        const [pgs] = await db.query('SELECT status FROM pagamentos WHERE id = ?', [pagamentoId]);
        if (pgs.length && pgs[0].status === 'pendente') {
          console.warn(`[MP] Timeout! Pag #${pagamentoId} sem confirmacao — extornando`);
          await db.query('DELETE FROM fila_pulsos WHERE aparelho_id = ?', [aparelho.id]);
          await db.query("UPDATE pagamentos SET status = 'extornado', mp_extornado = 1 WHERE id = ?", [pagamentoId]);
          await extornarMP(dataId, mpToken);
        }
      } catch(e) { console.error('[MP Timeout ERRO]', e.message); }
    }, 20000);

    res.sendStatus(200);
  } catch(e) {
    console.error('[MP Webhook ERRO]', e.message);
    res.sendStatus(500);
  }
});

async function extornarMP(mpPaymentId, mpToken) {
  try {
    await axios.post(`https://api.mercadopago.com/v1/payments/${mpPaymentId}/refunds`, {}, {
      headers: { Authorization: `Bearer ${mpToken}` }
    });
    console.log('[MP] Extorno OK:', mpPaymentId);
  } catch(e) { console.error('[MP Extorno ERRO]', e.message); }
}

// Marca offline aparelhos sem heartbeat há mais de 35s
setInterval(async () => {
  try {
    await db.query(
      'UPDATE aparelhos SET online = 0 WHERE updated_at IS NOT NULL AND updated_at < NOW() - INTERVAL 35 SECOND'
    );
  } catch(e) {}
}, 15000);

// Limpa fila com mais de 10 minutos (segurança)
setInterval(async () => {
  try {
    await db.query('DELETE FROM fila_pulsos WHERE criado_em < NOW() - INTERVAL 10 MINUTE');
  } catch(e) {}
}, 60000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('DivertiPay rodando na porta ' + PORT));
