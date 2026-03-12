require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const app     = express();

app.use(cors());
app.use(express.json());

// Rota de teste — confirma que o servidor está no ar
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    projeto: 'DivertiPay',
    mensagem: 'Servidor funcionando!' 
  });
});

// Webhook do ESP8266 (vamos expandir depois)
app.post('/webhook/esp32', (req, res) => {
  console.log('ESP recebido:', req.body);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('DivertiPay rodando na porta', PORT);
});
