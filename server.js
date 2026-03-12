require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const mysql   = require('mysql2/promise');
const app     = express();

app.use(cors());
app.use(express.json());

// Conexão com o banco
const db = mysql.createPool({
  host:     process.env.DB_HOST,
  port:     process.env.DB_PORT,
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Criar tabelas automaticamente ao iniciar
async function criarTabelas() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      nome         VARCHAR(100) NOT NULL,
      email        VARCHAR(100) UNIQUE NOT NULL,
      senha_hash   VARCHAR(255) NOT NULL,
      plano_expira DATE,
      criado_em    DATETIME DEFAULT NOW()
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS aparelhos (
      id             INT AUTO_INCREMENT PRIMARY KEY,
      cliente_id     INT NOT NULL,
      nome           VARCHAR(100) NOT NULL,
      token          VARCHAR(64) UNIQUE NOT NULL,
      online         TINYINT(1) DEFAULT 0,
      noteiro_total  DECIMAL(10,2) DEFAULT 0,
      criado_em      DATETIME DEFAULT NOW(),
      FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS pagamentos (
      id           INT AUTO_INCREMENT PRIMARY KEY,
      aparelho_id  INT NOT NULL,
      tipo         ENUM('pix','cartao','noteiro') NOT NULL,
      valor        DECIMAL(10,2) NOT NULL,
      status       ENUM('confirmado','pendente') DEFAULT 'confirmado',
      recolhido    TINYINT(1) DEFAULT 0,
      criado_em    DATETIME DEFAULT NOW(),
      FOREIGN KEY (aparelho_id) REFERENCES aparelhos(id)
    )
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS mensalidades (
      id               INT AUTO_INCREMENT PRIMARY KEY,
      cliente_id       INT NOT NULL,
      valor            DECIMAL(10,2) NOT NULL,
      dias_adicionados INT DEFAULT 30,
      pago_em          DATETIME DEFAULT NOW(),
      FOREIGN KEY (cliente_id) REFERENCES clientes(id)
    )
  `);
  console.log('✅ Tabelas criadas/verificadas!');
}

// Rota de teste
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    projeto: 'DivertiPay',
    mensagem: 'Servidor funcionando!' 
  });
});

// Rota para testar banco
app.get('/db-test', async (req, res) => {
  const [rows] = await db.query('SHOW TABLES');
  res.json({ tabelas: rows });
});

// Webhook ESP8266
app.post('/webhook/esp32', (req, res) => {
  console.log('ESP recebido:', req.body);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log('DivertiPay rodando na porta', PORT);
  await criarTabelas();
});
```

Clique em **"Commit changes"**. O Railway vai fazer deploy automático em ~1 minuto.

---

### Depois do deploy — testar

Acesse no navegador:
```
https://seuapp.railway.app/db-test
