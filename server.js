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

// Ligação ao Banco de Dados (Railway)
const db = mysql.createPool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Fila temporária para comandos enviados pelo painel
const filaPulsos = {};

// Middleware de Proteção
function auth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ erro: 'Sem token' });
  const token = authHeader.split(' ')[1];
  try { 
    req.user = jwt.verify(token, process.env.JWT_SECRET); 
    next(); 
  } catch { 
    res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' }); 
  }
}

// --- ROTAS DE LOGIN ---
app.post('/auth/login', async (req, res) => {
  try {
    const { email, senha } = req.body;
    const [rows] = await db.query('SELECT * FROM clientes WHERE email = ?', [email]);
    if (rows.length === 0) return res.status(401).json({ erro: 'Utilizador não encontrado' });
    
    const user = rows[0];
    const senhaOk = await bcrypt.compare(senha, user.senha_hash);
    if (!senhaOk) return res.status(401).json({ erro: 'Senha incorreta' });

    const token = jwt.sign({ id: user.id, nome: user.nome }, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, nome: user.nome });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/auth/me', auth, async (req, res) => {
  try {
    const [rows] = await db.query('SELECT id, nome, email FROM clientes WHERE id = ?', [req.user.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// --- ROTAS DE APARELHOS ---
app.get('/devices', auth, async (req, res) => {
  try {
    const [rows] = await db.query(
      'SELECT id, nome, token, mp_user_id, online, updated_at FROM aparelhos WHERE cliente_id = ?',
      [req.user.id]
    );

    const agora = new Date();
    const aparelhosComStatusReal = rows.map(dev => {
      const ultimaAtividade = new Date(dev.updated_at);
      const diferencaSegundos = (agora - ultimaAtividade) / 1000;
      
      // CORREÇÃO: Se não houver sinal há mais de 15s, aparece Offline no painel
      return {
        ...dev,
        online: (dev.online === 1 && diferencaSegundos < 15) ? 1 : 0
      };
    });

    res.json(aparelhosComStatusReal);
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/devices/:id/pulse', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { pulsos } = req.body;
    const [rows] = await db.query('SELECT token FROM aparelhos WHERE id = ? AND cliente_id = ?', [id, req.user.id]);
    
    if (rows.length === 0) return res.status(404).json({ erro: 'Aparelho não encontrado' });
    
    const token = rows[0].token;
    if (!filaPulsos[token]) filaPulsos[token] = [];
    
    filaPulsos[token].push({ id: Date.now(), pulsos: parseInt(pulsos) });
    
    // Regista o histórico
    await db.query('INSERT INTO pagamentos (aparelho_id, tipo, valor) VALUES (?, "pix", ?)', [id, pulsos]);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// --- ROTA DE COMUNICAÇÃO COM O ESP8266 ---
app.get('/esp/comando', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).send("Falta token");

    // Marca o aparelho como ativo agora
    await db.query('UPDATE aparelhos SET online = 1, updated_at = NOW() WHERE token = ?', [token]);

    const fila = filaPulsos[token];
    if (fila && fila.length > 0) {
      const proximoComando = fila.shift();
      return res.json({ tem_comando: true, pulsos: proximoComando.pulsos, id: proximoComando.id });
    }
    res.json({ tem_comando: false });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DivertiPay Backend Rodando na porta ${PORT}`));
