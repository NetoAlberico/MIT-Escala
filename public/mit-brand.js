/*!
 * mit-brand.js — Módulo de marca do cliente (white-label), reutilizável em todos os apps MIT.
 *
 * Como usar em um projeto:
 * 1. Copie este arquivo para public/mit-brand.js
 * 2. No <head> ou fim do <body> do index.html, inclua:
 *      <script src="mit-brand.js"
 *              data-default-name="Nome do App"
 *              data-default-sub="Configure o nome da sua produtora, igreja ou empresa"
 *              data-storage-key="mit_brand_v1"></script>
 * 3. No cabeçalho do app, adicione estes 4 elementos onde a marca deve aparecer:
 *      <span id="mitBrandLogoWrap">
 *        <img id="mitBrandLogoImg" alt="Logo" hidden>
 *        <span id="mitBrandLogoFallback"></span>
 *      </span>
 *      <span id="mitBrandName"></span>
 *      <span id="mitBrandSub"></span>
 * 4. Adicione um botão em qualquer lugar do cabeçalho:
 *      <button type="button" onclick="MitBrand.open()">🏷️ Marca</button>
 *
 * Tudo é salvo apenas no navegador do usuário (localStorage) — nenhuma logo ou
 * nome é enviado para qualquer servidor.
 */
(function () {
  "use strict";

  var scriptEl = document.currentScript;
  var STORAGE_KEY = (scriptEl && scriptEl.getAttribute("data-storage-key")) || "mit_brand_v1";
  var DEFAULT_NAME = (scriptEl && scriptEl.getAttribute("data-default-name")) || "Sua Produtora / Igreja";
  var DEFAULT_SUB = (scriptEl && scriptEl.getAttribute("data-default-sub")) || "Configure o nome do seu evento aqui";

  var brand = { name: "", sub: "", logo: "" };

  function loadBrand() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) brand = JSON.parse(raw);
    } catch (e) { /* ignora storage corrompido */ }
  }

  function saveToStorage() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(brand)); } catch (e) { /* storage indisponível */ }
  }

  function initials(name) {
    var n = (name || DEFAULT_NAME).trim();
    var parts = n.split(/\s+/).filter(Boolean).slice(0, 2);
    var ini = parts.map(function (w) { return w[0]; }).join("").toUpperCase();
    return ini || "SP";
  }

  function renderBrand() {
    var nameEl = document.getElementById("mitBrandName");
    var subEl = document.getElementById("mitBrandSub");
    var img = document.getElementById("mitBrandLogoImg");
    var fallback = document.getElementById("mitBrandLogoFallback");

    if (nameEl) nameEl.textContent = brand.name || DEFAULT_NAME;
    if (subEl) subEl.textContent = brand.sub || DEFAULT_SUB;

    if (img && fallback) {
      if (brand.logo) {
        img.src = brand.logo;
        img.style.display = "block";
        fallback.style.display = "none";
      } else {
        img.style.display = "none";
        fallback.style.display = "flex";
        fallback.textContent = initials(brand.name);
      }
    }
  }

  function injectStyles() {
    if (document.getElementById("mitBrandStyles")) return;
    var css = [
      "#mitBrandOverlay{position:fixed;inset:0;background:rgba(6,7,10,.72);backdrop-filter:blur(2px);display:none;align-items:center;justify-content:center;z-index:9999;font-family:Inter,Arial,sans-serif;}",
      "#mitBrandOverlay.mit-show{display:flex;}",
      "#mitBrandOverlay .mit-card{width:420px;max-width:92vw;max-height:88vh;overflow:auto;background:#20242c;border:1px solid #40444f;border-radius:10px;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.5);color:#e9e6df;}",
      "#mitBrandOverlay h3{font-weight:800;font-size:16px;margin:0;}",
      "#mitBrandOverlay .mit-field-label{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:.08em;color:#8b8f99;margin-bottom:4px;font-family:'IBM Plex Mono',monospace;}",
      "#mitBrandOverlay input[type=text]{width:100%;background:#1c1f26;border:1px solid #40444f;color:#e9e6df;border-radius:5px;padding:7px 9px;font-size:13px;margin-bottom:12px;box-sizing:border-box;}",
      "#mitBrandOverlay input[type=file]{display:block !important;width:100%;background:#1c1f26;border:1px solid #40444f;color:#e9e6df;border-radius:5px;padding:7px 9px;font-size:13px;margin-bottom:12px;box-sizing:border-box;}",
      "#mitBrandOverlay .mit-btn{border-radius:6px;padding:8px 14px;font-size:13px;font-weight:600;border:1px solid #40444f;cursor:pointer;}",
      "#mitBrandOverlay .mit-btn-primary{background:#9c8cf0;color:#161225;border-color:#9c8cf0;}",
      "#mitBrandOverlay .mit-btn-ghost{background:#20242c;color:#e9e6df;}",
      "#mitBrandOverlay .mit-btn-danger{background:#d9484f;color:#2a0a0c;border-color:#d9484f;}",
      "#mitBrandOverlay .mit-close{background:none;border:none;color:#8b8f99;font-size:18px;cursor:pointer;line-height:1;}",
      "#mitBrandOverlay .mit-note{font-size:10px;font-family:'IBM Plex Mono',monospace;color:#5b5f6a;margin-bottom:12px;line-height:1.5;}",
      "#mitBrandLogoWrap{display:inline-flex;align-items:center;justify-content:center;overflow:hidden;}",
      "#mitBrandLogoImg{width:100%;height:100%;object-fit:cover;}"
    ].join("\n");
    var style = document.createElement("style");
    style.id = "mitBrandStyles";
    style.textContent = css;
    document.head.appendChild(style);
  }

  function injectModal() {
    if (document.getElementById("mitBrandOverlay")) return;
    var html =
      '<div id="mitBrandOverlay">' +
      '  <div class="mit-card">' +
      '    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
      '      <h3>🏷️ Configurar Marca do Cliente</h3>' +
      '      <button type="button" class="mit-close" onclick="MitBrand.close()">×</button>' +
      '    </div>' +
      '    <label class="mit-field-label">Nome da Produtora / Igreja / Empresa</label>' +
      '    <input type="text" id="mitBrandInputName" placeholder="Ex: Igreja Vida Nova">' +
      '    <label class="mit-field-label">Subtítulo (Evento, Turnê, Culto...)</label>' +
      '    <input type="text" id="mitBrandInputSub" placeholder="Ex: Turnê Verão 2026">' +
      '    <label class="mit-field-label">Logo (opcional)</label>' +
      '    <input type="file" id="mitBrandInputLogo" accept="image/*">' +
      '    <p class="mit-note">A logo e o nome ficam salvos apenas neste navegador (localStorage) — nada é enviado a servidor algum.</p>' +
      '    <div style="display:flex;justify-content:space-between;gap:8px;">' +
      '      <button type="button" class="mit-btn mit-btn-danger" onclick="MitBrand.reset()">↺ Restaurar padrão</button>' +
      '      <div style="display:flex;gap:8px;">' +
      '        <button type="button" class="mit-btn mit-btn-ghost" onclick="MitBrand.close()">Cancelar</button>' +
      '        <button type="button" class="mit-btn mit-btn-primary" onclick="MitBrand.save()">Salvar</button>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '</div>';
    document.body.insertAdjacentHTML("beforeend", html);
  }

  function open() {
    injectStyles();
    injectModal();
    document.getElementById("mitBrandInputName").value = brand.name || "";
    document.getElementById("mitBrandInputSub").value = brand.sub || "";
    document.getElementById("mitBrandInputLogo").value = "";
    document.getElementById("mitBrandOverlay").classList.add("mit-show");
  }

  function close() {
    var el = document.getElementById("mitBrandOverlay");
    if (el) el.classList.remove("mit-show");
  }

  function save() {
    brand.name = document.getElementById("mitBrandInputName").value.trim();
    brand.sub = document.getElementById("mitBrandInputSub").value.trim();
    var file = document.getElementById("mitBrandInputLogo").files[0];
    function finish() {
      saveToStorage();
      renderBrand();
      close();
    }
    if (file) {
      var reader = new FileReader();
      reader.onload = function (e) { brand.logo = e.target.result; finish(); };
      reader.readAsDataURL(file);
    } else {
      finish();
    }
  }

  function reset() {
    if (!confirm("Restaurar a marca para o padrão (remove nome, subtítulo e logo salvos neste navegador)?")) return;
    brand = { name: "", sub: "", logo: "" };
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
    renderBrand();
    close();
  }

  window.MitBrand = { open: open, close: close, save: save, reset: reset, render: renderBrand };

  function init() {
    injectStyles();
    loadBrand();
    renderBrand();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
