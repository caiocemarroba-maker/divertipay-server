// Substitua sua função abrirConfig por esta:
async function abrirConfig(id) {
  const dev = aparelhosCache.find(a => a.id === id);
  if (!dev) return;

  deviceEmConfig = id;
  document.getElementById('config-nome-title').innerText = dev.nome;
  document.getElementById('inp-config-nome').value = dev.nome;
  document.getElementById('inp-config-mpid').value = dev.mp_user_id || '';
  
  // Exibe o token na tela
  const tokenDisplay = document.getElementById('config-token-display');
  tokenDisplay.innerText = dev.token;

  document.getElementById('modal-config').style.display = 'flex';
}

// Adicione esta nova função para o botão copiar funcionar:
function copiarTokenConfig() {
  const token = document.getElementById('config-token-display').innerText;
  if (!token) return;

  navigator.clipboard.writeText(token).then(() => {
    // Feedback visual simples
    const btn = event.target;
    const originalText = btn.innerText;
    btn.innerText = "✅ Copiado!";
    btn.style.color = "#22c55e";
    
    setTimeout(() => {
      btn.innerText = originalText;
      btn.style.color = "#f97316";
    }, 2000);
  }).catch(err => {
    alert("Erro ao copiar token: " + err);
  });
}
