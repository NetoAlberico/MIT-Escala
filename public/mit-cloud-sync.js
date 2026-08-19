/**
 * ============================================================================
 * MIT Cloud Sync — módulo do lado do cliente
 * ----------------------------------------------------------------------------
 * Inclua este arquivo em qualquer app da suíte (Letras, Cifras, Escala...)
 * pra ligar aquele app na nuvem: ele abre o WebSocket, escuta as atualizações
 * em tempo real, e expõe funções simples de CRUD que já avisam os outros
 * dispositivos conectados automaticamente.
 *
 * Como usar (exemplo dentro de um app):
 *
 *   <script src="mit-cloud-sync.js"
 *           data-worker-url="https://mit-cloud-sync.SEU-SUBDOMINIO.workers.dev">
 *   </script>
 *
 *   // depois de ter o token (o mesmo já usado pelo mit-license.js) e a
 *   // lista escolhida:
 *   await MitCloudSync.conectar({ token: meuToken, listaId: 'abc-123' });
 *
 *   MitCloudSync.on('item_salvo', (evento) => {
 *     // alguém (você mesmo em outro aparelho, ou outro membro da lista)
 *     // salvou uma música/repertório/cifra — atualize a tela aqui.
 *     console.log('Item atualizado:', evento.item);
 *   });
 *
 *   await MitCloudSync.salvarItem({ tipo: 'musica', dados: minhaMusica });
 * ============================================================================
 */
(function (global) {
  "use strict";

  const scriptAtual = document.currentScript;
  const CHAVE_URL_SALVA = "mit_cloud_sync_worker_url";
  let WORKER_URL =
    localStorage.getItem(CHAVE_URL_SALVA) ||
    (scriptAtual && scriptAtual.getAttribute("data-worker-url")) ||
    "";

  /** Define (e salva) o endereço do Worker em tempo de execução — use isso
   *  quando o endereço não for fixo no HTML (ex.: uma tela de configuração
   *  onde o usuário cola a URL do seu próprio deploy). */
  function definirServidor(url) {
    WORKER_URL = (url || "").replace(/\/+$/, ""); // tira barra no final, se tiver
    try { localStorage.setItem(CHAVE_URL_SALVA, WORKER_URL); } catch (e) { /* ignora */ }
  }

  function obterServidor() {
    return WORKER_URL;
  }

  let ws = null;
  let tokenAtual = null;
  let listaIdAtual = null;
  let intervaloReconexao = 1000; // cresce a cada tentativa (backoff exponencial)
  let timerReconexao = null;
  let fechadoPeloUsuario = false;

  const ouvintes = {}; // { "item_salvo": [callback1, callback2], ... }

  function emitir(evento, dados) {
    (ouvintes[evento] || []).forEach((cb) => {
      try { cb(dados); } catch (e) { console.error("Erro num listener de", evento, e); }
    });
  }

  /** Escuta um tipo de evento vindo do servidor.
   *  Eventos possíveis: 'item_salvo', 'item_excluido', 'membro_adicionado',
   *  'membro_removido', 'conectado', 'desconectado', 'erro'. */
  function on(evento, callback) {
    (ouvintes[evento] = ouvintes[evento] || []).push(callback);
  }

  function off(evento, callback) {
    if (!ouvintes[evento]) return;
    ouvintes[evento] = ouvintes[evento].filter((cb) => cb !== callback);
  }

  /* ------------------------------- REST (CRUD) ------------------------------- */

  async function chamarApi(caminho, opcoes) {
    const resposta = await fetch(WORKER_URL + caminho, {
      ...opcoes,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokenAtual,
        ...(opcoes && opcoes.headers),
      },
    });
    const corpo = await resposta.json().catch(() => ({}));
    if (!resposta.ok) throw new Error(corpo.erro || `Erro ${resposta.status}`);
    return corpo;
  }

  function criarLista(nome) {
    return chamarApi("/api/listas", { method: "POST", body: JSON.stringify({ nome }) });
  }

  function minhasListas() {
    return chamarApi("/api/listas", { method: "GET" });
  }

  function adicionarMembro(listaId, usuario) {
    return chamarApi(`/api/listas/${listaId}/membros`, {
      method: "POST",
      body: JSON.stringify({ usuario }),
    });
  }

  function listarMembros(listaId) {
    return chamarApi(`/api/listas/${listaId}/membros`, { method: "GET" });
  }

  function removerMembro(listaId, usuario) {
    return chamarApi(`/api/listas/${listaId}/membros/${encodeURIComponent(usuario)}`, { method: "DELETE" });
  }

  function listarItens(listaId, tipo) {
    const query = tipo ? `?tipo=${encodeURIComponent(tipo)}` : "";
    return chamarApi(`/api/listas/${listaId}/itens${query}`, { method: "GET" });
  }

  /** Cria OU atualiza um item (se `dados.id` já existir, atualiza; senão, cria).
   *  Depois de salvar no banco, o servidor avisa todo mundo conectado —
   *  inclusive você mesmo em outra aba/aparelho — via WebSocket. */
  function salvarItem({ id, tipo, dados }) {
    if (!listaIdAtual) throw new Error("Conecte-se a uma lista antes de salvar itens (MitCloudSync.conectar).");
    return chamarApi(`/api/listas/${listaIdAtual}/itens`, {
      method: "POST",
      body: JSON.stringify({ id, tipo, dados }),
    });
  }

  function excluirItem(itemId) {
    if (!listaIdAtual) throw new Error("Conecte-se a uma lista antes de excluir itens.");
    return chamarApi(`/api/listas/${listaIdAtual}/itens/${itemId}`, { method: "DELETE" });
  }

  /* ------------------------------- WebSocket ------------------------------- */

  function urlWebSocket(listaId, token) {
    const base = WORKER_URL.replace(/^http/, "ws"); // https:// -> wss://
    return `${base}/ws?lista=${encodeURIComponent(listaId)}&token=${encodeURIComponent(token)}`;
  }

  function conectarWebSocket() {
    ws = new WebSocket(urlWebSocket(listaIdAtual, tokenAtual));

    ws.addEventListener("open", () => {
      intervaloReconexao = 1000; // reseta o backoff ao conectar com sucesso
      emitir("conectado", {});
    });

    ws.addEventListener("message", (ev) => {
      if (ev.data === "pong") return;
      let evento;
      try {
        evento = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      // repassa o evento pro app que estiver ouvindo (ex.: 'item_salvo')
      emitir(evento.tipo, evento);
    });

    ws.addEventListener("close", () => {
      emitir("desconectado", {});
      if (!fechadoPeloUsuario) agendarReconexao();
    });

    ws.addEventListener("error", () => {
      emitir("erro", {});
      try { ws.close(); } catch (e) { /* ignora */ }
    });
  }

  function agendarReconexao() {
    clearTimeout(timerReconexao);
    timerReconexao = setTimeout(() => {
      conectarWebSocket();
      // backoff exponencial, limitado a 30s entre tentativas
      intervaloReconexao = Math.min(intervaloReconexao * 2, 30000);
    }, intervaloReconexao);
  }

  // mantém a conexão viva atrás de proxies/CDNs que derrubam WebSockets
  // ociosos depois de um tempo sem tráfego
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send("ping");
  }, 25000);

  /** Define o token pra usar nas chamadas de API (criar lista, listar
   *  membros, etc.) — separado de conectar() porque essas ações acontecem
   *  ANTES de qualquer lista existir/estar escolhida, então não faz
   *  sentido abrir um WebSocket ainda (isso só acontece em conectar()). */
  function definirToken(token) {
    tokenAtual = token;
  }

  /** Conecta a uma lista específica — chame isso uma vez, ao carregar o app
   *  (depois que o usuário já tiver um token válido e tiver escolhido a
   *  lista, ex.: guardada no localStorage da última vez). */
  async function conectar({ token, listaId }) {
    tokenAtual = token;
    listaIdAtual = listaId;
    fechadoPeloUsuario = false;
    if (ws) { try { ws.close(); } catch (e) {} }
    conectarWebSocket();
  }

  function desconectar() {
    fechadoPeloUsuario = true;
    clearTimeout(timerReconexao);
    if (ws) ws.close();
  }

  global.MitCloudSync = {
    on,
    off,
    conectar,
    desconectar,
    definirServidor,
    obterServidor,
    definirToken,
    criarLista,
    minhasListas,
    adicionarMembro,
    listarMembros,
    removerMembro,
    listarItens,
    salvarItem,
    excluirItem,
  };
})(window);
