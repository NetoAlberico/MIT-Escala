/*!
 * MIT License Gate — módulo de controle de acesso por token/assinatura.
 * -----------------------------------------------------------------------
 * Cole este arquivo em QUALQUER app "MIT" (repertório, cifras, etc.) e
 * inclua-o no index.html, logo ANTES do app.js do próprio app:
 *
 *   <script src="localforage.min.js"></script>
 *   <script src="mit-license.js"></script>   <-- adicionar esta linha
 *   <script src="app.js"></script>
 *
 * Ele bloqueia a tela com uma tela de login pedindo o token, valida a
 * assinatura (a mesma lógica usada em mit-license-admin.html), guarda o
 * token localmente (não precisa digitar de novo) e passa a checar a
 * validade sempre que o app é aberto — avisando antes de vencer e
 * bloqueando automaticamente quando vence.
 *
 * LIMITE DE DISPOSITIVOS: se o token foi gerado com um limite (ex: "até 4
 * dispositivos"), na hora de ATIVAR um token novo neste aparelho o app
 * conversa com o LICENSE_SERVER_URL configurado abaixo pra confirmar que
 * ainda há vaga. Isso só acontece uma vez, na ativação — depois disso o
 * aparelho já fica "lembrado" no servidor e o dia a dia continua 100%
 * offline (sem chamadas de rede). Sem configurar LICENSE_SERVER_URL, o
 * limite de dispositivos simplesmente não é aplicado (mas tudo o resto do
 * token — validade, tom, app vinculado — continua funcionando normalmente).
 *
 * IMPORTANTE: troque SECRET abaixo por uma chave só sua, e use A MESMA
 * chave no mit-license-admin.html (o gerador de token) e no license-server
 * (se for usar limite de dispositivos). Sem isso, os tokens gerados não vão
 * validar aqui.
 * -----------------------------------------------------------------------
 */
(function () {
  "use strict";

  /* ============================ CONFIGURAÇÃO ============================ */
  const CONFIG = {
    // Precisa ser IDÊNTICA à chave configurada no gerador (mit-license-admin.html).
    SECRET: "Torre-MIT-2026-3f8a1c9d-mit",

    // Identificador deste app. Use "any" para aceitar qualquer token MIT,
    // ou um slug específico (ex: "repertorio", "cifras", "vs") se você
    // quiser que os tokens gerados para um app não funcionem em outro.
    APP_ID: "escala",

    // URL do license-server (pasta license-server/ deste kit), só necessária
    // se você for usar o limite de dispositivos por token. Deixe "" (vazio)
    // pra desativar essa checagem — o resto do sistema de acesso continua
    // funcionando normalmente sem ela.
    LICENSE_SERVER_URL: "https://mit-license.gomesalberico.workers.dev",

    // Quantos dias antes do vencimento o aviso de renovação aparece.
    WARNING_DAYS: 5,

    // Chave usada no armazenamento local deste app.
    STORAGE_KEY: "mit_license_v1",
    USERNAME_KEY: "mit_license_username",
    DEVICE_ID_KEY: "mit_license_device_id",

    // Intervalo para reconferir a validade enquanto o app fica aberto.
    RECHECK_MS: 60 * 60 * 1000, // 1 hora
  };
  /* ======================================================================= */

  const APP_LABEL = document.title || "este aplicativo";

  /* ---------------------------- armazenamento ---------------------------- */
  // Usa o localforage já carregado pelos apps MIT; se não existir, cai para
  // localStorage, então este arquivo também funciona sozinho em apps novos.
  const db = window.localforage
    ? window.localforage
    : {
        getItem: (k) => Promise.resolve(JSON.parse(localStorage.getItem(k) || "null")),
        setItem: (k, v) => {
          localStorage.setItem(k, JSON.stringify(v));
          return Promise.resolve(v);
        },
        removeItem: (k) => {
          localStorage.removeItem(k);
          return Promise.resolve();
        },
      };

  async function loadStoredToken() {
    try {
      return await db.getItem(CONFIG.STORAGE_KEY);
    } catch (err) {
      return null;
    }
  }
  async function saveStoredToken(raw) {
    try {
      await db.setItem(CONFIG.STORAGE_KEY, raw);
    } catch (err) {
      console.error("MITLicense: falha ao salvar token localmente.", err);
    }
  }
  async function clearStoredToken() {
    try {
      await db.removeItem(CONFIG.STORAGE_KEY);
    } catch (err) {
      /* ignore */
    }
  }

  // Guardado só quando o login foi feito com usuário/senha (não quando foi
  // colado um token direto) — é o que permite a checagem periódica de
  // revogação em checkAccess().
  async function loadStoredUsername() {
    try {
      return await db.getItem(CONFIG.USERNAME_KEY);
    } catch (err) {
      return null;
    }
  }
  async function saveStoredUsername(username) {
    try {
      await db.setItem(CONFIG.USERNAME_KEY, username);
    } catch (err) {
      /* ignore */
    }
  }
  async function clearStoredUsername() {
    try {
      await db.removeItem(CONFIG.USERNAME_KEY);
    } catch (err) {
      /* ignore */
    }
  }

  // Identificador único deste aparelho/navegador — gerado uma vez e
  // guardado localmente. É o que o license-server usa para saber se está
  // vendo um dispositivo já conhecido ou um novo (contando pro limite).
  let cachedDeviceId = null;
  async function getDeviceId() {
    if (cachedDeviceId) return cachedDeviceId;
    try {
      let id = await db.getItem(CONFIG.DEVICE_ID_KEY);
      if (!id) {
        id = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : randomFallbackId();
        await db.setItem(CONFIG.DEVICE_ID_KEY, id);
      }
      cachedDeviceId = id;
      return id;
    } catch (err) {
      // Sem armazenamento disponível — usa um id só desta sessão (não ideal,
      // mas evita quebrar o app inteiro por causa disso).
      if (!cachedDeviceId) cachedDeviceId = randomFallbackId();
      return cachedDeviceId;
    }
  }
  function randomFallbackId() {
    return "dev-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  /* ------------------------------ criptografia ---------------------------- */
  function bytesToHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  function b64urlToStr(b64url) {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64url.length + 3) % 4);
    return decodeURIComponent(
      atob(b64)
        .split("")
        .map((c) => "%" + c.charCodeAt(0).toString(16).padStart(2, "0"))
        .join("")
    );
  }
  async function hmacHex(message, secret) {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
    ]);
    const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
    return bytesToHex(new Uint8Array(sig).slice(0, 12)); // 96 bits — suficiente pra este uso
  }

  function pad2(n) {
    return String(n).padStart(2, "0");
  }
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function fmtBR(isoDate) {
    const [y, m, d] = isoDate.split("-");
    return `${d}/${m}/${y}`;
  }
  const TYPE_LABEL = { Q: "Quinzenal", M: "Mensal", A: "Anual", D: "Por dias", P: "Por período" };

  /* Token = "MIT-" + base64url(payload) + "." + hmacHex(payload)
     payload v1 (antigo) = "1|cliente|appId|tipo|inicio|fim|nonce"
     payload v2 (com limite de dispositivos) = "...|nonce|maxDevices" */
  async function parseToken(rawInput) {
    const clean = (rawInput || "").trim().replace(/^MIT-/i, "");
    const dotIdx = clean.lastIndexOf(".");
    if (dotIdx === -1) return { ok: false, error: "Formato de token inválido." };
    const payloadB64 = clean.slice(0, dotIdx);
    const sig = clean.slice(dotIdx + 1).toLowerCase();

    let payloadStr;
    try {
      payloadStr = b64urlToStr(payloadB64);
    } catch (err) {
      return { ok: false, error: "Não foi possível ler este token." };
    }

    const parts = payloadStr.split("|");
    if (parts.length < 7) return { ok: false, error: "Token corrompido." };
    const [v, cEnc, appId, type, start, end, nonce, maxDevicesStr] = parts;

    let expectedSig;
    try {
      expectedSig = await hmacHex(payloadStr, CONFIG.SECRET);
    } catch (err) {
      return { ok: false, error: "Não foi possível validar o token neste navegador." };
    }
    if (expectedSig !== sig) return { ok: false, error: "Token inválido ou adulterado." };

    if (CONFIG.APP_ID !== "any" && appId !== "any" && appId !== CONFIG.APP_ID) {
      return { ok: false, error: `Este token não é válido para ${APP_LABEL}.` };
    }

    const maxDevices = v === "2" ? parseInt(maxDevicesStr, 10) || 0 : 0;

    return {
      ok: true,
      raw: clean,
      payload: { v, cliente: decodeURIComponent(cEnc), appId, type, start, end, nonce, maxDevices },
    };
  }

  function statusFor(payload) {
    const today = todayStr();
    if (today < payload.start) return { state: "not-started" };
    if (today > payload.end) return { state: "expired" };
    const daysLeft = Math.round((new Date(payload.end + "T00:00:00") - new Date(today + "T00:00:00")) / 86400000);
    if (daysLeft <= CONFIG.WARNING_DAYS) return { state: "warning", daysLeft };
    return { state: "valid", daysLeft };
  }

  // Confirma com o license-server que este aparelho pode usar este token —
  // só é chamado na hora de ATIVAR um token (não em toda checagem local).
  // Se LICENSE_SERVER_URL não estiver configurado, ou o token não tiver
  // limite de dispositivos, libera direto sem chamar rede nenhuma.
  async function checkDeviceLimit(payload, rawToken) {
    if (!CONFIG.LICENSE_SERVER_URL) return { ok: true };
    if (!payload.maxDevices) return { ok: true };

    const deviceId = await getDeviceId();
    try {
      const res = await fetch(`${CONFIG.LICENSE_SERVER_URL.replace(/\/+$/, "")}/activate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: rawToken, deviceId }),
      });
      const data = await res.json().catch(() => null);
      if (!data) return { ok: false, error: "Não foi possível confirmar a ativação (resposta inválida do servidor)." };
      if (!res.ok || !data.ok) {
        return { ok: false, error: data.error || "Este token não pôde ser ativado neste aparelho." };
      }
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "Não foi possível confirmar a ativação — verifique sua internet e tente de novo." };
    }
  }

  // Faz login com usuário/senha no license-server — devolve um token
  // assinado (mesmo formato de sempre) que o app passa a tratar exatamente
  // como um token colado manualmente, incluindo funcionar offline depois.
  async function loginWithPassword(username, password) {
    if (!CONFIG.LICENSE_SERVER_URL) {
      return { ok: false, error: "Login por usuário/senha não está configurado neste app." };
    }
    const deviceId = await getDeviceId();
    try {
      const res = await fetch(`${CONFIG.LICENSE_SERVER_URL.replace(/\/+$/, "")}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, deviceId }),
      });
      const data = await res.json().catch(() => null);
      if (!data) return { ok: false, error: "O servidor não respondeu corretamente." };
      if (!res.ok || !data.ok) return { ok: false, error: data.error || "Usuário ou senha incorretos." };
      return { ok: true, token: data.token, username: data.username };
    } catch (err) {
      return { ok: false, error: "Não foi possível conectar — verifique sua internet e tente de novo." };
    }
  }

  // Checagem leve e periódica (sem senha) pra saber se a conta continua
  // ativa no servidor — é o que permite REVOGAR alguém mesmo que o token
  // guardado localmente ainda pareça válido pela data. Falha de rede aqui
  // não bloqueia nada (o app continua funcionando offline normalmente).
  async function checkAccountStillActive(username) {
    if (!CONFIG.LICENSE_SERVER_URL || !username) return true;
    try {
      const res = await fetch(
        `${CONFIG.LICENSE_SERVER_URL.replace(/\/+$/, "")}/account-status?username=${encodeURIComponent(username)}`
      );
      const data = await res.json().catch(() => null);
      if (!data || !data.ok) return true; // resposta estranha — não bloqueia por causa disso
      return data.active !== false;
    } catch (err) {
      return true; // sem internet agora — não bloqueia o uso offline
    }
  }

  // Mesma ideia, mas pra token direto (colado manualmente, sem conta de
  // usuário) — permite revogar um token específico mesmo com a data de
  // validade ainda em dia, usando o "nonce" (identificador único dentro do
  // próprio token) como referência no license-server.
  async function checkTokenNotRevoked(nonce) {
    if (!CONFIG.LICENSE_SERVER_URL || !nonce) return true;
    try {
      const res = await fetch(
        `${CONFIG.LICENSE_SERVER_URL.replace(/\/+$/, "")}/token-status?nonce=${encodeURIComponent(nonce)}`
      );
      const data = await res.json().catch(() => null);
      if (!data || !data.ok) return true; // resposta estranha — não bloqueia por causa disso
      return data.revoked !== true;
    } catch (err) {
      return true; // sem internet agora — não bloqueia o uso offline
    }
  }

  /* --------------------------------- UI ----------------------------------- */
  function injectStylesOnce() {
    if (document.getElementById("mitlic-styles")) return;
    const style = document.createElement("style");
    style.id = "mitlic-styles";
    style.textContent = `
      .mitlic-overlay{position:fixed;inset:0;z-index:2147483000;background:#0b0d10;
        display:flex;align-items:center;justify-content:center;padding:24px;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
      .mitlic-card{width:100%;max-width:380px;background:#15181c;border:1px solid #262b31;
        border-radius:14px;padding:28px 26px;box-shadow:0 20px 60px rgba(0,0,0,0.45);}
      .mitlic-brand{display:flex;align-items:center;gap:10px;margin-bottom:18px;}
      .mitlic-brand img{width:28px;height:28px;border-radius:50%;flex-shrink:0;object-fit:contain;}
      .mitlic-brand span{color:#8a9099;font-size:12px;letter-spacing:.06em;text-transform:uppercase;font-weight:700;}
      .mitlic-title{color:#EDEBE2;font-size:19px;font-weight:800;margin:0 0 6px;}
      .mitlic-sub{color:#9aa0a8;font-size:13px;line-height:1.5;margin:0 0 20px;}
      .mitlic-sub b{color:#c7ccd1;}
      .mitlic-label{display:block;color:#9aa0a8;font-size:11.5px;font-weight:700;text-transform:uppercase;
        letter-spacing:.05em;margin-bottom:7px;}
      .mitlic-input{width:100%;box-sizing:border-box;background:#0f1114;border:1px solid #2c3138;color:#EDEBE2;
        padding:12px 13px;border-radius:9px;font-size:14px;font-family:'JetBrains Mono',ui-monospace,Menlo,Consolas,monospace;
        outline:none;letter-spacing:.02em;margin-bottom:14px;}
      .mitlic-input:last-of-type{margin-bottom:0;}
      .mitlic-input:focus{border-color:#4C8579;}
      .mitlic-error{color:#e0796a;font-size:12.5px;margin-top:10px;min-height:16px;}
      .mitlic-btn{width:100%;margin-top:16px;background:#4C8579;color:#fff;border:none;padding:12px;
        border-radius:9px;font-size:14px;font-weight:700;cursor:pointer;transition:background .15s;}
      .mitlic-btn:hover{background:#59987f;}
      .mitlic-btn:disabled{opacity:.6;cursor:default;}
      .mitlic-foot{margin-top:16px;color:#5c636b;font-size:11.5px;text-align:center;}
      .mitlic-foot a{color:#8a9099;text-decoration:underline;cursor:pointer;}

      .mitlic-banner{position:fixed;left:0;right:0;bottom:0;z-index:2147482000;
        background:#3a2f14;border-top:1px solid #5c4a1c;color:#f0d99a;
        font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
        font-size:13px;padding:10px 14px;display:flex;align-items:center;gap:12px;flex-wrap:wrap;
        justify-content:center;}
      .mitlic-banner b{color:#ffe9b8;}
      .mitlic-banner button{background:#f0d99a;color:#3a2f14;border:none;padding:6px 12px;border-radius:7px;
        font-size:12.5px;font-weight:700;cursor:pointer;}
      .mitlic-banner .mitlic-dismiss{background:transparent;color:#f0d99a;padding:4px 6px;font-weight:400;}

      .mitlic-fab{position:fixed;right:14px;bottom:14px;z-index:2147481000;width:34px;height:34px;
        border-radius:50%;background:#15181c;border:1px solid #2c3138;color:#8a9099;font-size:14px;
        display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:.55;}
      .mitlic-fab:hover{opacity:1;}
    `;
    document.head.appendChild(style);
  }

  let overlayEl = null;
  function showLoginOverlay(message) {
    if (overlayEl) {
      const err = overlayEl.querySelector(".mitlic-error");
      if (message) err.textContent = message;
      return;
    }
    injectStylesOnce();
    const hasServer = !!CONFIG.LICENSE_SERVER_URL;
    // Sem servidor configurado, só o modo de token faz sentido (não tem
    // como validar usuário/senha sem um lugar pra checar a senha).
    let mode = hasServer ? "account" : "token";

    overlayEl = document.createElement("div");
    overlayEl.className = "mitlic-overlay";
    overlayEl.innerHTML = `
      <div class="mitlic-card">
        <div class="mitlic-brand"><img src="icons/icon-64.png" alt="" onerror="this.style.display='none'"><span>MIT · Acesso</span></div>
        <p class="mitlic-title" data-role="mitlic-heading"></p>
        <p class="mitlic-sub" data-role="mitlic-sub"></p>

        <div data-role="mitlic-account-fields">
          <label class="mitlic-label">Usuário</label>
          <input type="text" class="mitlic-input" data-role="mitlic-username" autocomplete="username" autocapitalize="off" spellcheck="false" />
          <label class="mitlic-label">Senha</label>
          <input type="password" class="mitlic-input" data-role="mitlic-password" autocomplete="current-password" />
        </div>
        <div data-role="mitlic-token-fields" style="display:none;">
          <label class="mitlic-label">Token</label>
          <input type="text" class="mitlic-input" data-role="mitlic-input" placeholder="MIT-XXXXXXXX.XXXXXXXX" autocomplete="off" autocapitalize="off" spellcheck="false" />
        </div>

        <div class="mitlic-error" data-role="mitlic-error">${message ? escapeHtml(message) : ""}</div>
        <button class="mitlic-btn" data-role="mitlic-submit"></button>
        <p class="mitlic-foot" data-role="mitlic-foot"></p>
      </div>
    `;
    document.body.appendChild(overlayEl);

    const headingEl = overlayEl.querySelector('[data-role="mitlic-heading"]');
    const subEl = overlayEl.querySelector('[data-role="mitlic-sub"]');
    const accountFields = overlayEl.querySelector('[data-role="mitlic-account-fields"]');
    const tokenFields = overlayEl.querySelector('[data-role="mitlic-token-fields"]');
    const usernameInput = overlayEl.querySelector('[data-role="mitlic-username"]');
    const passwordInput = overlayEl.querySelector('[data-role="mitlic-password"]');
    const tokenInput = overlayEl.querySelector('[data-role="mitlic-input"]');
    const errEl = overlayEl.querySelector('[data-role="mitlic-error"]');
    const btn = overlayEl.querySelector('[data-role="mitlic-submit"]');
    const footEl = overlayEl.querySelector('[data-role="mitlic-foot"]');

    function renderMode() {
      const isAccount = mode === "account";
      accountFields.style.display = isAccount ? "block" : "none";
      tokenFields.style.display = isAccount ? "none" : "block";
      headingEl.textContent = isAccount ? "Entrar" : "Informe seu token de acesso";
      subEl.innerHTML = isAccount
        ? `Digite o usuário e a senha enviados para liberar <b>${escapeHtml(APP_LABEL)}</b>. Você só precisa fazer isso uma vez — o acesso fica salvo neste aparelho.`
        : `Digite o código de assinatura enviado para liberar <b>${escapeHtml(APP_LABEL)}</b>. Você só precisa fazer isso uma vez — o acesso fica salvo neste aparelho até vencer.`;
      btn.textContent = isAccount ? "Entrar" : "Ativar acesso";
      footEl.innerHTML = hasServer
        ? isAccount
          ? '<a data-role="mitlic-toggle-mode">Prefiro colar um token</a>'
          : '<a data-role="mitlic-toggle-mode">Prefiro entrar com usuário e senha</a>'
        : "Precisa de um token? Fale com quem gerencia sua assinatura.";
      const toggle = footEl.querySelector('[data-role="mitlic-toggle-mode"]');
      if (toggle) {
        toggle.addEventListener("click", (e) => {
          e.preventDefault();
          mode = isAccount ? "token" : "account";
          errEl.textContent = "";
          renderMode();
          setTimeout(() => (mode === "account" ? usernameInput : tokenInput).focus(), 30);
        });
      }
    }
    renderMode();

    async function applyValidToken(raw, status, payload) {
      await saveStoredToken(raw);
      hideOverlay();
      if (status.state === "warning") showRenewalBanner(status.daysLeft, payload.end);
      scheduleRecheck();
    }

    async function submitToken() {
      const value = tokenInput.value.trim();
      if (!value) {
        errEl.textContent = "Cole ou digite o token recebido.";
        return;
      }
      btn.disabled = true;
      btn.textContent = "Validando…";
      const result = await parseToken(value);
      if (!result.ok) {
        errEl.textContent = result.error;
        btn.disabled = false;
        renderMode();
        return;
      }
      const status = statusFor(result.payload);
      if (status.state === "expired") {
        errEl.textContent = `Este token venceu em ${fmtBR(result.payload.end)}. Peça um token novo.`;
        btn.disabled = false;
        renderMode();
        return;
      }
      if (status.state === "not-started") {
        errEl.textContent = `Este token só é válido a partir de ${fmtBR(result.payload.start)}.`;
        btn.disabled = false;
        renderMode();
        return;
      }

      // Ativação: só chama o license-server aqui (uma vez), não em toda
      // checagem local — depois disso o aparelho já fica reconhecido.
      btn.textContent = "Confirmando ativação…";
      const deviceCheck = await checkDeviceLimit(result.payload, result.raw);
      if (!deviceCheck.ok) {
        errEl.textContent = deviceCheck.error;
        btn.disabled = false;
        renderMode();
        return;
      }

      await clearStoredUsername();
      await applyValidToken(result.raw, status, result.payload);
    }

    async function submitAccount() {
      const username = usernameInput.value.trim();
      const password = passwordInput.value;
      if (!username || !password) {
        errEl.textContent = "Informe usuário e senha.";
        return;
      }
      btn.disabled = true;
      btn.textContent = "Entrando…";
      const login = await loginWithPassword(username, password);
      if (!login.ok) {
        errEl.textContent = login.error;
        btn.disabled = false;
        renderMode();
        return;
      }
      const result = await parseToken(login.token);
      if (!result.ok) {
        errEl.textContent = "Não foi possível validar o acesso recebido do servidor.";
        btn.disabled = false;
        renderMode();
        return;
      }
      const status = statusFor(result.payload);
      await saveStoredUsername(login.username);
      await applyValidToken(result.raw, status, result.payload);
    }

    function submit() {
      errEl.textContent = "";
      return mode === "account" ? submitAccount() : submitToken();
    }

    btn.addEventListener("click", submit);
    [usernameInput, passwordInput, tokenInput].forEach((el) => {
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") submit();
      });
    });
    setTimeout(() => (mode === "account" ? usernameInput : tokenInput).focus(), 50);
  }

  function hideOverlay() {
    if (overlayEl) {
      overlayEl.remove();
      overlayEl = null;
    }
  }

  let bannerEl = null;
  function showRenewalBanner(daysLeft, endIso) {
    injectStylesOnce();
    if (bannerEl) bannerEl.remove();
    bannerEl = document.createElement("div");
    bannerEl.className = "mitlic-banner";
    const dayWord = daysLeft === 1 ? "dia" : "dias";
    const msg =
      daysLeft <= 0
        ? `Seu acesso vence <b>hoje</b> (${fmtBR(endIso)}).`
        : `Seu acesso vence em <b>${daysLeft} ${dayWord}</b> (${fmtBR(endIso)}).`;
    bannerEl.innerHTML = `
      <span>${msg} Renove para não perder o acesso.</span>
      <button data-role="mitlic-renew-now">Renovar token</button>
      <button class="mitlic-dismiss" data-role="mitlic-dismiss">Agora não</button>
    `;
    document.body.appendChild(bannerEl);
    bannerEl.querySelector('[data-role="mitlic-renew-now"]').addEventListener("click", () => {
      bannerEl.remove();
      bannerEl = null;
      showLoginOverlay();
    });
    bannerEl.querySelector('[data-role="mitlic-dismiss"]').addEventListener("click", () => {
      bannerEl.remove();
      bannerEl = null;
    });
  }

  function showChangeTokenFab() {
    injectStylesOnce();
    if (document.querySelector(".mitlic-fab")) return;
    const fab = document.createElement("button");
    fab.className = "mitlic-fab";
    fab.title = "Trocar token de acesso";
    fab.textContent = "🔑";
    fab.addEventListener("click", () => showLoginOverlay());
    document.body.appendChild(fab);
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ------------------------------ ciclo de vida ---------------------------- */
  let recheckTimer = null;
  function scheduleRecheck() {
    if (recheckTimer) clearInterval(recheckTimer);
    recheckTimer = setInterval(checkAccess, CONFIG.RECHECK_MS);
  }

  // Checagem do dia a dia — 100% local/offline por padrão. O license-server
  // só é consultado em dois momentos: na ATIVAÇÃO (dentro do submit() da
  // tela de login) e, se o login foi feito com usuário/senha, numa
  // checagem leve e opcional aqui pra detectar revogação (sem exigir
  // internet — se estiver offline, essa parte é simplesmente pulada).
  async function checkAccess() {
    const stored = await loadStoredToken();
    if (!stored) {
      showLoginOverlay();
      return;
    }
    const result = await parseToken(stored);
    if (!result.ok) {
      await clearStoredToken();
      await clearStoredUsername();
      showLoginOverlay(result.error);
      return;
    }
    const status = statusFor(result.payload);
    if (status.state === "expired") {
      await clearStoredToken();
      await clearStoredUsername();
      showLoginOverlay(`Seu acesso venceu em ${fmtBR(result.payload.end)}. Informe um novo token para continuar.`);
      return;
    }
    if (status.state === "not-started") {
      await clearStoredToken();
      await clearStoredUsername();
      showLoginOverlay(`Este token só é válido a partir de ${fmtBR(result.payload.start)}.`);
      return;
    }

    const username = await loadStoredUsername();
    if (username) {
      const stillActive = await checkAccountStillActive(username);
      if (!stillActive) {
        await clearStoredToken();
        await clearStoredUsername();
        showLoginOverlay("Este acesso foi desativado. Fale com quem gerencia sua assinatura para receber um novo login.");
        return;
      }
    }

    const notRevoked = await checkTokenNotRevoked(result.payload.nonce);
    if (!notRevoked) {
      await clearStoredToken();
      await clearStoredUsername();
      showLoginOverlay("Este token foi revogado. Fale com quem gerencia sua assinatura para receber um novo acesso.");
      return;
    }

    hideOverlay();
    showChangeTokenFab();
    if (status.state === "warning") showRenewalBanner(status.daysLeft, result.payload.end);
  }

  function init() {
    injectStylesOnce();
    checkAccess();
    scheduleRecheck();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.MITLicense = {
    logout: async () => {
      await clearStoredToken();
      await clearStoredUsername();
      showLoginOverlay();
    },
    checkNow: checkAccess,
    TYPE_LABEL,
  };
})();
