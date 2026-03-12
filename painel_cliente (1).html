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

// Fila de pulsos em memória
const filaPulsos = {};

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ erro: 'Sem token' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { res.status(401).json({ erro: 'Token invalido' }); }
}

// --- ROTAS DE DISPOSITIVOS ---

app.get('/devices', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, nome, token, mp_user_id, online, updated_at FROM aparelhos WHERE cliente_id = ?',
      [req.user.id]
    );

    // LÓGICA DE STATUS REAL-TIME
    const agora = new Date();
    const aparelhosProcessados = rows.map(dev => {
      const ultimaVez = new Date(dev.updated_at);
      const diferencaSegundos = (agora - ultimaVez) / 1000;
      
      // Se não enviou sinal há mais de 10 segundos, força offline
      return {
        ...dev,
        online: (dev.online === 1 && diferencaSegundos < 10) ? 1 : 0
      };
    });

    res.json(aparelhosProcessados);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/devices', auth, async (req, res) => {
  try {
    const { nome } = req.body;
    const token = crypto.randomBytes(16).toString('hex');
    await db.query(
      'INSERT INTO aparelhos (cliente_id, nome, token) VALUES (?, ?, ?)',
      [req.user.id, nome, token]
    );
    res.json({ ok: true, token });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Enviar pulso do painel para o ESP
app.post('/devices/:id/pulse', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { pulsos } = req.body;
    const [rows] = await db.query('SELECT token FROM aparelhos WHERE id = ? AND cliente_id = ?', [id, req.user.id]);
    
    if (rows.length === 0) return res.status(404).json({ erro: 'Aparelho não encontrado' });
    
    const token = rows[0].token;
    if (!filaPulsos[token]) filaPulsos[token] = [];
    
    const cmdId = Date.now();
    filaPulsos[token].push({ id: cmdId, pulsos: parseInt(pulsos) });

    // Registra como pagamento do tipo 'painel'
    await db.query(
      'INSERT INTO pagamentos (aparelho_id, tipo, valor) VALUES (?, ?, ?)',
      [id, 'pix', pulsos]
    );

    res.json({ ok: true, cmdId });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// --- ROTAS DO ESP (POLLING) ---

app.get('/esp/comando', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ erro: 'Token obrigatorio' });

    // Atualiza o timestamp de atividade e marca online
    await db.query('UPDATE aparelhos SET online = 1, updated_at = NOW() WHERE token = ?', [token]);

    const fila = filaPulsos[token];
    if (fila && fila.length > 0) {
      const cmd = fila.shift();
      return res.json({ tem_comando: true, pulsos: cmd.pulsos, id: cmd.id });
    }
    res.json({ tem_comando: false });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/esp/confirmar', async (req, res) => {
  try {
    const { token } = req.body;
    await db.query('UPDATE aparelhos SET online = 1, updated_at = NOW() WHERE token = ?', [token]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Rota para o noteiro reportar nota
app.post('/webhook/esp32', async (req, res) => {
    try {
      const { token, valor } = req.body;
      const [rows] = await db.query('SELECT id FROM aparelhos WHERE token = ?', [token]);
      if (rows.length === 0) return res.status(404).json({ erro: 'Aparelho invalido' });
      
      await db.query(
        'INSERT INTO pagamentos (aparelho_id, tipo, valor) VALUES (?, "noteiro", ?)',
        [rows[0].id, valor]
      );
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ erro: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
