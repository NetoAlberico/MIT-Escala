/**
 * ============================================================================
 * MIT Cloud Bridge — ponte entre o armazenamento local de um app e a nuvem
 * ----------------------------------------------------------------------------
 * Fica em cima do mit-cloud-sync.js (que cuida da conexão/WebSocket em si) e
 * resolve o "de-para" entre o jeito que CADA app guarda seus dados
 * localmente (SONGS, CIFRAS, o que for) e o formato genérico que o servidor
 * entende (tipo + dados).
 *
 * Filosofia: o app continua funcionando 100% local, exatamente como hoje,
 * mesmo sem nunca ter configurado a nuvem. A nuvem é sempre um "a mais":
 *   - Se NÃO estiver conectado: salvar/editar/excluir só mexe no
 *     armazenamento local, igual sempre foi.
 *   - Se ESTIVER conectado: salvar/editar/excluir local TAMBÉM manda pra
 *     nuvem (que aí espalha pra outros aparelhos/membros da lista); e
 *     quando ALGO chega da nuvem (de outro aparelho), o app atualiza o
 *     armazenamento local e a tela na hora.
 *
 * Como usar dentro de um app (ex.: mit-repertorio-app):
 *
 *   MitCloudBridge.registrarTipo('musica', {
 *     obterTodos: () => SONGS,                      // array local atual
 *     obterPorId: (id) => SONGS.find(s => s.id===id),
 *     aoReceberDaNuvem: async (dadosDoItem) => {     // outro aparelho salvou
 *       const existente = SONGS.find(s => s.id === dadosDoItem.id);
 *       if (existente) Object.assign(existente, dadosDoItem);
 *       else SONGS.push(dadosDoItem);
 *       await persistSongs();
 *       renderDatabaseList();
 *     },
 *     aoExcluirDaNuvem: async (itemId) => {
 *       SONGS = SONGS.filter(s => s.id !== itemId);
 *       await persistSongs();
 *       renderDatabaseList();
 *     },
 *   });
 *
 *   // depois de salvar uma música LOCALMENTE (dentro da função que já
 *   // existe hoje), só acrescente esta linha:
 *   MitCloudBridge.publicar('musica', novaMusica);
 *
 *   // e no lugar que exclui:
 *   MitCloudBridge.excluir('musica', song.id);
 *
 *   // pra ligar a conexão em si (ex.: num botão "Sincronizar com a Nuvem"):
 *   await MitCloudBridge.conectar({ token, listaId });
 * ============================================================================
 */
(function (global) {
  "use strict";

  const CHAVE_ULTIMA_LISTA = "mit_cloud_bridge_ultima_lista";

  const tiposRegistrados = {}; // { 'musica': { obterTodos, obterPorId, aoReceberDaNuvem, aoExcluirDaNuvem } }
  let listaAtualId = null;
  let statusAtual = "desconectado"; // 'desconectado' | 'conectando' | 'conectado' | 'erro'

  const ouvintesDeStatus = [];
  function emitirStatus(novoStatus) {
    statusAtual = novoStatus;
    ouvintesDeStatus.forEach((cb) => {
      try { cb(novoStatus); } catch (e) { console.error(e); }
    });
  }

  /** Cadastra como um tipo de dado local (ex.: 'musica') se conecta com a
   *  nuvem — veja o exemplo de uso no comentário no topo do arquivo. */
  function registrarTipo(tipo, adaptador) {
    tiposRegistrados[tipo] = adaptador;
  }

  /** true se está conectado agora e pronto pra publicar/receber. */
  function conectado() {
    return statusAtual === "conectado";
  }

  function status() {
    return statusAtual;
  }

  function onStatus(callback) {
    ouvintesDeStatus.push(callback);
  }

  /** Conecta numa lista (ex.: ao abrir o app, se já houver uma lista salva
   *  da última vez, ou quando o usuário escolhe uma no menu). Faz também a
   *  primeira sincronização: puxa o que já existe na nuvem e mescla com o
   *  que já está salvo localmente (a nuvem "ganha" em caso de item com o
   *  mesmo id, por ser a versão mais recente vinda de outro aparelho). */
  async function conectar({ token, listaId }) {
    if (!global.MitCloudSync || !global.MitCloudSync.obterServidor()) {
      emitirStatus("erro");
      return { ok: false, erro: "MIT Cloud Sync não está configurado (falta a URL do servidor)." };
    }

    listaAtualId = listaId;
    try { localStorage.setItem(CHAVE_ULTIMA_LISTA, listaId); } catch (e) { /* ignora */ }

    emitirStatus("conectando");

    global.MitCloudSync.on("conectado", () => emitirStatus("conectado"));
    global.MitCloudSync.on("desconectado", () => emitirStatus("conectando"));
    global.MitCloudSync.on("erro", () => emitirStatus("erro"));
    global.MitCloudSync.on("item_salvo", (evento) => {
      const adaptador = tiposRegistrados[evento.item.tipo];
      if (adaptador && adaptador.aoReceberDaNuvem) adaptador.aoReceberDaNuvem(evento.item.dados);
    });
    global.MitCloudSync.on("item_excluido", (evento) => {
      // o evento não carrega o tipo (o servidor só sabe o id) — avisa
      // TODOS os tipos registrados, cada um decide se aquele id é dele
      // (um `obterPorId` que não encontra nada é barato de checar).
      Object.values(tiposRegistrados).forEach((adaptador) => {
        if (adaptador.obterPorId && adaptador.obterPorId(evento.itemId) && adaptador.aoExcluirDaNuvem) {
          adaptador.aoExcluirDaNuvem(evento.itemId);
        }
      });
    });

    await global.MitCloudSync.conectar({ token, listaId });

    // primeira sincronização: puxa cada tipo registrado e mescla
    await Promise.all(
      Object.keys(tiposRegistrados).map(async (tipo) => {
        try {
          const { itens } = await global.MitCloudSync.listarItens(listaId, tipo);
          const adaptador = tiposRegistrados[tipo];
          for (const item of itens) {
            if (adaptador.aoReceberDaNuvem) await adaptador.aoReceberDaNuvem(item.dados);
          }
        } catch (e) {
          console.error(`Falha ao sincronizar itens do tipo "${tipo}":`, e);
        }
      })
    );

    return { ok: true };
  }

  function desconectar() {
    listaAtualId = null;
    global.MitCloudSync && global.MitCloudSync.desconectar();
    emitirStatus("desconectado");
  }

  /** Chama isso logo depois de salvar um item localmente — se estiver
   *  conectado, ele também sobe pra nuvem; se não estiver, não faz nada
   *  (o item já está salvo localmente, só isso mesmo). */
  async function publicar(tipo, dados) {
    if (!conectado() || !listaAtualId) return;
    try {
      await global.MitCloudSync.salvarItem({ id: dados.id, tipo, dados });
    } catch (e) {
      console.error(`Falha ao publicar item do tipo "${tipo}" na nuvem:`, e);
    }
  }

  /** Idem, mas pra quando um item é excluído localmente. */
  async function excluir(tipo, itemId) {
    if (!conectado() || !listaAtualId) return;
    try {
      await global.MitCloudSync.excluirItem(itemId);
    } catch (e) {
      console.error(`Falha ao excluir item do tipo "${tipo}" na nuvem:`, e);
    }
  }

  function ultimaListaSalva() {
    try { return localStorage.getItem(CHAVE_ULTIMA_LISTA); } catch (e) { return null; }
  }

  global.MitCloudBridge = {
    registrarTipo,
    conectar,
    desconectar,
    conectado,
    status,
    onStatus,
    publicar,
    excluir,
    ultimaListaSalva,
  };
})(window);
