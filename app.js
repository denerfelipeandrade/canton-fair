"use strict";
// Canton Fair — caderno de stands offline.
// Tudo fica no próprio celular (IndexedDB). Backup/restauração por arquivo .zip.

// ---------- utilidades ----------
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () =>
  self.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const norm = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const fmtDate = (t) => {
  const d = new Date(t);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" }) + " " +
    d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
};
const ls = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch { /* sem storage */ } },
};

let toastTimer;
function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

// ---------- esquema dos campos (um lugar só: formulário, detalhe, busca e planilha) ----------
const STATUS = [
  ["prioridade", "🔥 Prioridade", "hot"],
  ["interessante", "👍 Interessante", "ok"],
  ["talvez", "🤔 Talvez", ""],
  ["descartado", "✖ Descartado", ""],
];
const statusOf = (k) => STATUS.find((s) => s[0] === k);

const KINDS = { cartao: "Cartão", produto: "Produto", catalogo: "Catálogo", stand: "Stand" };

const SECTIONS = [
  {
    id: "stand", title: "Stand",
    fields: [
      { k: "company", label: "Empresa / fornecedor", ph: "Ex.: Ningbo Sunshine Co." },
      { k: "booth", label: "Nº do stand", ph: "Ex.: 11.2 A15", half: true },
      { k: "phase", label: "Fase", type: "select", options: ["", "Fase 1", "Fase 2", "Fase 3"], half: true },
      { k: "category", label: "Categoria", ph: "Ex.: Utilidades domésticas" },
      { k: "products", label: "Produtos de interesse", type: "textarea", ph: "Modelos, códigos, especificações, cores…" },
    ],
  },
  {
    id: "eval", title: "Minha avaliação", rating: true,
    fields: [
      { k: "liked", label: "O que eu gostei", type: "textarea", ph: "Qualidade, acabamento, preço, atendimento…" },
      { k: "concerns", label: "Pontos de atenção", type: "textarea", ph: "Dúvidas, riscos, o que não gostei" },
      { k: "nextStep", label: "Próximo passo", ph: "Ex.: pedir cotação de 500 un + amostra" },
      { k: "tags", label: "Tags (separe por vírgula)", ph: "Ex.: cozinha, presente, revenda" },
    ],
  },
  {
    id: "contact", title: "Contato",
    fields: [
      { k: "contactName", label: "Nome", half: true },
      { k: "role", label: "Cargo", half: true },
      { k: "whatsapp", label: "WhatsApp", type: "tel", half: true },
      { k: "phone", label: "Telefone", type: "tel", half: true },
      { k: "wechat", label: "WeChat ID", half: true },
      { k: "email", label: "E-mail", type: "email", half: true },
      { k: "website", label: "Site / loja Alibaba", type: "url" },
    ],
  },
  {
    id: "terms", title: "Condições comerciais",
    fields: [
      { k: "price", label: "Preço", ph: "Ex.: 2,50 / un", half: true },
      { k: "currency", label: "Moeda", type: "select", options: ["USD", "CNY", "BRL", "EUR"], half: true },
      { k: "moq", label: "Pedido mínimo (MOQ)", ph: "Ex.: 500 un", half: true },
      { k: "leadTime", label: "Prazo de produção", ph: "Ex.: 30 dias", half: true },
      { k: "payment", label: "Condição de pagamento", list: "pay-opts", ph: "Ex.: 30% sinal / 70% antes do embarque" },
      { k: "incoterm", label: "Incoterm", type: "select", options: ["", "FOB", "EXW", "CIF", "CFR", "DAP", "DDP"], half: true },
      { k: "port", label: "Porto", ph: "Ex.: Ningbo", half: true },
      { k: "samples", label: "Amostra", type: "select", half: true,
        options: ["", "Grátis", "Grátis, frete por minha conta", "Paga", "Paga, reembolsada no pedido", "Não oferece"] },
      { k: "oem", label: "Aceita OEM / minha marca", type: "select", options: ["", "Sim", "Não", "A confirmar"], half: true },
      { k: "certifications", label: "Certificações", ph: "Ex.: CE, FCC, RoHS, INMETRO" },
    ],
  },
];
const ALL_FIELDS = SECTIONS.flatMap((s) => s.fields);
const PAY_OPTS = [
  "30% sinal / 70% antes do embarque (T/T)",
  "30% sinal / 70% contra cópia do B/L (T/T)",
  "100% antecipado (T/T)",
  "Carta de crédito (L/C) à vista",
  "Alibaba Trade Assurance",
  "PayPal / cartão (amostras)",
];

const fieldText = (s, k) => (k === "tags" ? (s.tags || []).join(", ") : s[k] ?? "");
const isEmptyRecord = (s) => !ALL_FIELDS.some((f) => f.k !== "currency" && String(fieldText(s, f.k)).trim()) && !s.rating && !s.status;

// ---------- banco de dados (IndexedDB) ----------
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = t.onabort = () => rej(t.error); });
let dbPromise;
function db() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const r = indexedDB.open("cantonfair", 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        d.createObjectStore("suppliers", { keyPath: "id" });
        d.createObjectStore("photos", { keyPath: "id" }).createIndex("supplierId", "supplierId");
      };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  return dbPromise;
}
const os = async (store, mode = "readonly") => (await db()).transaction(store, mode).objectStore(store);
const getAll = async (store) => reqP((await os(store)).getAll());
const getOne = async (store, id) => reqP((await os(store)).get(id));
const countKey = async (store, id) => reqP((await os(store)).count(id));
async function putOne(store, obj) {
  const o = await os(store, "readwrite");
  o.put(obj);
  return txDone(o.transaction);
}
async function delOne(store, id) {
  const o = await os(store, "readwrite");
  o.delete(id);
  return txDone(o.transaction);
}
async function photosOf(supplierId) {
  const list = await reqP((await os("photos")).index("supplierId").getAll(supplierId));
  return list.sort((a, b) => a.createdAt - b.createdAt);
}
async function deleteSupplier(id) {
  const t = (await db()).transaction(["suppliers", "photos"], "readwrite");
  t.objectStore("suppliers").delete(id);
  const keys = await reqP(t.objectStore("photos").index("supplierId").getAllKeys(id));
  keys.forEach((k) => t.objectStore("photos").delete(k));
  return txDone(t);
}
function coverOf(photos) {
  const p = photos.find((x) => x.kind === "produto") || photos.find((x) => x.kind === "stand") || photos[0];
  return p ? p.thumb : "";
}
let persistAsked = false;
function requestPersist() {
  if (persistAsked) return;
  persistAsked = true;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
}

// ---------- fotos: reduz no celular antes de guardar ----------
function loadImg(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("Não consegui ler a imagem"));
    img.src = src;
  });
}
function scaled(img, max) {
  const w = img.naturalWidth, h = img.naturalHeight;
  const s = Math.min(1, max / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w * s));
  c.height = Math.max(1, Math.round(h * s));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c;
}
const toBlob = (c, q) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error("Falha ao comprimir foto"))), "image/jpeg", q));
async function processPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImg(url);
    const full = await toBlob(scaled(img, 1600), 0.8);
    const thumb = scaled(img, 320).toDataURL("image/jpeg", 0.7);
    // ArrayBuffer em vez de Blob: mais robusto no IndexedDB do Safari antigo.
    return { data: await full.arrayBuffer(), type: "image/jpeg", thumb };
  } finally {
    URL.revokeObjectURL(url);
  }
}
let objectUrls = [];
function photoUrl(p) {
  const u = URL.createObjectURL(new Blob([p.data], { type: p.type || "image/jpeg" }));
  objectUrls.push(u);
  return u;
}
function revokeUrls() {
  objectUrls.forEach((u) => URL.revokeObjectURL(u));
  objectUrls = [];
}

// ---------- roteamento ----------
const view = $("#view");
let renderId = 0;
let leaving = null; // função a rodar antes de sair da tela atual (ex.: salvar formulário)

function setChrome({ title, back = null, fab = false }) {
  $("#title").textContent = title;
  document.title = title;
  const b = $("#back");
  b.hidden = !back;
  b.onclick = () => { if (back) location.hash = back; };
  $("#fab").hidden = !fab;
}

const ROUTES = [
  [/^#\/?$/, listView],
  [/^#\/new$/, (alive) => formView(null, alive)],
  [/^#\/edit\/(.+)$/, formView],
  [/^#\/s\/(.+)$/, detailView],
  [/^#\/backup$/, backupView],
];

async function render() {
  const id = ++renderId;
  if (leaving) {
    const fn = leaving;
    leaving = null;
    flushOnHide = null;
    try { await fn(); } catch (e) { console.error(e); toast("Erro ao salvar: " + e.message, 4000); }
  }
  if (id !== renderId) return;
  revokeUrls();
  window.scrollTo(0, 0);
  const h = location.hash || "#/";
  const alive = () => id === renderId;
  for (const [re, fn] of ROUTES) {
    const m = h.match(re);
    if (m) {
      try {
        await fn(...m.slice(1).map(decodeURIComponent), alive);
      } catch (e) {
        console.error(e);
        if (alive()) view.innerHTML = `<div class="empty"><b>Algo deu errado</b>${esc(e.message)}</div>`;
      }
      return;
    }
  }
  location.hash = "#/";
}

// ---------- lista + busca ----------
const listState = { q: "", status: "", phase: "", sort: "recent" };

async function listView(alive) {
  const all = await getAll("suppliers");
  if (!alive()) return;
  setChrome({ title: `Canton Fair · ${all.length} stand${all.length === 1 ? "" : "s"}`, fab: true });

  const last = Number(ls.get("cf.lastBackup") || 0);
  const lastChange = all.reduce((m, s) => Math.max(m, s.updatedAt || 0), 0);
  const needsBackup = all.length >= 3 && lastChange > last && Date.now() - last > 12 * 3600e3;

  if (!all.length) {
    view.innerHTML = `<div class="empty"><b>Nenhum stand ainda</b>
      Toque em <b style="display:inline">＋</b> no stand que gostar: foto do cartão, nº do stand, nota e o que achou.<br><br>
      Funciona sem internet — tudo fica salvo neste celular.</div>`;
    return;
  }

  const chip = (group, value, label) =>
    `<button class="chip${listState[group] === value ? " on" : ""}" data-g="${group}" data-v="${esc(value)}">${esc(label)}</button>`;
  view.innerHTML = `
    ${needsBackup ? `<a class="warn" href="#/backup" style="display:block;text-decoration:none">⚠️ Você tem registros sem backup. Toque aqui e salve um .zip — se perder o celular, perde tudo.</a>` : ""}
    <div class="search">
      <input id="q" type="search" placeholder="Buscar empresa, produto, stand, tag…" value="${esc(listState.q)}" autocomplete="off">
      <select id="sort" style="width:auto" aria-label="Ordenar">
        <option value="recent">Recentes</option>
        <option value="rating">Melhor nota</option>
        <option value="company">Empresa A–Z</option>
        <option value="booth">Nº do stand</option>
      </select>
    </div>
    <div class="chips">${chip("status", "", "Todos")}${STATUS.map(([k, l]) => chip("status", k, l)).join("")}</div>
    <div class="chips">${chip("phase", "", "Todas as fases")}${["Fase 1", "Fase 2", "Fase 3"].map((p) => chip("phase", p, p)).join("")}</div>
    <div class="count" id="count"></div>
    <div class="list" id="items"></div>`;
  $("#sort").value = listState.sort;

  const update = () => {
    const terms = norm(listState.q).split(/\s+/).filter(Boolean);
    let rows = all.filter((s) => {
      if (listState.status && s.status !== listState.status) return false;
      if (listState.phase && s.phase !== listState.phase) return false;
      if (!terms.length) return true;
      const hay = norm(ALL_FIELDS.map((f) => fieldText(s, f.k)).join(" "));
      return terms.every((t) => hay.includes(t));
    });
    const by = {
      recent: (a, b) => b.createdAt - a.createdAt,
      rating: (a, b) => (b.rating || 0) - (a.rating || 0) || b.createdAt - a.createdAt,
      company: (a, b) => (a.company || "").localeCompare(b.company || "", "pt-BR"),
      booth: (a, b) => (a.booth || "").localeCompare(b.booth || "", "pt-BR", { numeric: true }),
    }[listState.sort];
    rows = rows.sort(by);
    $("#count").textContent = rows.length === all.length ? `${rows.length} registros` : `${rows.length} de ${all.length}`;
    $("#items").innerHTML = rows.map(itemHTML).join("") || `<div class="empty">Nada encontrado.</div>`;
  };
  update();

  $("#q").addEventListener("input", (e) => { listState.q = e.target.value; update(); });
  $("#sort").addEventListener("change", (e) => { listState.sort = e.target.value; update(); });
  $$(".chip", view).forEach((c) =>
    c.addEventListener("click", () => {
      listState[c.dataset.g] = c.dataset.v;
      $$(`.chip[data-g="${c.dataset.g}"]`, view).forEach((x) => x.classList.toggle("on", x === c));
      update();
    })
  );
}

const stars = (n) => (n ? `<span class="stars">${"★".repeat(n)}${"☆".repeat(5 - n)}</span>` : "");
function statusBadge(k) {
  const s = statusOf(k);
  return s ? `<span class="badge ${s[2]}">${esc(s[1])}</span>` : "";
}
function itemHTML(s) {
  const meta = [s.booth, s.phase, s.category].filter(Boolean).join(" · ");
  const price = s.price ? `${s.currency || ""} ${s.price}`.trim() : "";
  const terms = [price, s.moq && "MOQ " + s.moq].filter(Boolean).join(" · ");
  const dim = s.status === "descartado" ? ' style="opacity:.55"' : "";
  return `<a class="item" href="#/s/${encodeURIComponent(s.id)}"${dim}>
    ${s.coverThumb ? `<img class="thumb" src="${esc(s.coverThumb)}" alt="">` : `<div class="thumb">📦</div>`}
    <div class="body">
      <div class="name">${esc(s.company || "Stand sem nome")}</div>
      <div class="meta">${esc(meta || fmtDate(s.createdAt))}</div>
      <div class="meta">${stars(s.rating)} ${statusBadge(s.status)} ${esc(terms)}</div>
      ${s.liked ? `<div class="liked">💬 ${esc(s.liked)}</div>` : ""}
    </div></a>`;
}

// ---------- formulário (salva sozinho a cada alteração) ----------
function fieldHTML(f, rec) {
  const v = String(fieldText(rec, f.k));
  const id = "f_" + f.k;
  let input;
  if (f.type === "select") {
    const opts = v && !f.options.includes(v) ? [...f.options, v] : f.options;
    input = `<select id="${id}" name="${f.k}">${opts
      .map((o) => `<option value="${esc(o)}"${o === v ? " selected" : ""}>${esc(o || "—")}</option>`).join("")}</select>`;
  } else if (f.type === "textarea") {
    input = `<textarea id="${id}" name="${f.k}" placeholder="${esc(f.ph || "")}">${esc(v)}</textarea>`;
  } else {
    const t = f.type || "text";
    const extra = t === "url" ? ' inputmode="url" autocapitalize="off"' : t === "email" ? ' autocapitalize="off"' : "";
    input = `<input id="${id}" name="${f.k}" type="${t === "url" ? "text" : t}"${extra} value="${esc(v)}"
      placeholder="${esc(f.ph || "")}"${f.list ? ` list="${f.list}"` : ""} autocomplete="off">`;
  }
  return `<div><label for="${id}">${esc(f.label)}</label>${input}</div>`;
}
function fieldsHTML(fields, rec) {
  let out = "";
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.half && fields[i + 1] && fields[i + 1].half) {
      out += `<div class="row">${fieldHTML(f, rec)}${fieldHTML(fields[i + 1], rec)}</div>`;
      i++;
    } else out += fieldHTML(f, rec);
  }
  return out;
}

async function formView(id, alive) {
  let rec = id ? await getOne("suppliers", id) : null;
  if (id && !rec) { location.hash = "#/"; return; }
  let persisted = !!rec;
  rec = rec || { id: uid(), createdAt: Date.now(), rating: 0, status: "", currency: "USD", photoCount: 0, coverThumb: "" };
  let photos = persisted ? await photosOf(rec.id) : [];
  if (!alive()) return;

  setChrome({ title: persisted ? "Editar stand" : "Novo stand", back: persisted ? `#/s/${encodeURIComponent(rec.id)}` : "#/" });

  const photoBtn = (kind, icon, label, opts = 'capture="environment"') =>
    `<label class="photo-btn"><span>${icon}</span>${label}<input type="file" accept="image/*" ${opts} data-kind="${kind}"></label>`;

  view.innerHTML = `
    <form id="form" autocomplete="off" onsubmit="return false">
      <fieldset><legend>Fotos</legend>
        <div class="photo-actions">
          ${photoBtn("cartao", "📇", "Cartão")}
          ${photoBtn("produto", "📦", "Produto")}
          ${photoBtn("catalogo", "🏷️", "Preços")}
          ${photoBtn("produto", "🖼️", "Galeria", "multiple")}
        </div>
        <div class="photos" id="photos"></div>
      </fieldset>
      ${SECTIONS.map((s) => `<fieldset><legend>${esc(s.title)}</legend>
        ${s.rating ? `
          <label>Nota</label>
          <div class="rating" id="rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-r="${n}" aria-label="${n} estrela${n > 1 ? "s" : ""}">★</button>`).join("")}</div>
          <label>Status</label>
          <div class="seg">${STATUS.map(([k, l]) => `<input type="radio" name="status" id="st_${k}" value="${k}"${rec.status === k ? " checked" : ""}><label for="st_${k}">${esc(l)}</label>`).join("")}</div>` : ""}
        ${fieldsHTML(s.fields, rec)}
      </fieldset>`).join("")}
      <datalist id="pay-opts">${PAY_OPTS.map((o) => `<option value="${esc(o)}">`).join("")}</datalist>
      <div class="actions">
        ${persisted ? `<button type="button" class="btn danger" id="del" style="flex:0 0 auto">Excluir</button>` : ""}
        <button type="button" class="btn primary" id="done">✓ Salvar</button>
      </div>
      <p class="note" style="text-align:center">Tudo é salvo automaticamente enquanto você digita.</p>
    </form>`;

  const form = $("#form");
  const paintRating = () => $$("#rating button").forEach((b) => b.classList.toggle("on", Number(b.dataset.r) <= (rec.rating || 0)));
  const paintPhotos = () => {
    $("#photos").innerHTML = photos.map((p) => `<div class="photo">
        <img src="${esc(p.thumb)}" alt=""><span class="tag">${esc(KINDS[p.kind] || "")}</span>
        <button type="button" class="del" data-id="${esc(p.id)}" aria-label="Remover foto">✕</button></div>`).join("");
  };
  paintRating();
  paintPhotos();

  const collect = () => {
    for (const f of ALL_FIELDS) {
      const v = (form.elements[f.k].value || "").trim();
      if (f.k === "tags") rec.tags = v.split(",").map((t) => t.trim()).filter(Boolean);
      else rec[f.k] = v;
    }
    const st = form.querySelector('input[name="status"]:checked');
    rec.status = st ? st.value : "";
  };

  // Salvamentos em fila, para nunca gravarem fora de ordem.
  let chain = Promise.resolve();
  let timer = null;
  let dirty = false;
  const saveNow = () => {
    clearTimeout(timer);
    timer = null;
    if (!dirty) return chain;
    dirty = false;
    collect();
    if (!persisted && isEmptyRecord(rec) && !photos.length) return chain;
    chain = chain.then(async () => {
      rec.updatedAt = Date.now();
      rec.photoCount = photos.length;
      rec.coverThumb = coverOf(photos);
      await putOne("suppliers", rec);
      if (!persisted) {
        persisted = true;
        requestPersist();
        // Se o iOS recarregar o app ao abrir a câmera, voltamos para este registro.
        if (alive()) history.replaceState(null, "", "#/edit/" + encodeURIComponent(rec.id));
      }
    });
    return chain;
  };
  const scheduleSave = () => { dirty = true; clearTimeout(timer); timer = setTimeout(saveNow, 500); };
  form.addEventListener("input", scheduleSave);
  form.addEventListener("change", scheduleSave);

  $("#rating").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const r = Number(b.dataset.r);
    rec.rating = rec.rating === r ? 0 : r;
    paintRating();
    dirty = true;
    saveNow();
  });

  $$('input[type="file"]', form).forEach((inp) =>
    inp.addEventListener("change", async (e) => {
      e.stopPropagation();
      const files = [...inp.files];
      inp.value = "";
      for (const file of files) {
        toast("Processando foto…", 10000);
        try {
          const p = await processPhoto(file);
          const photo = { id: uid(), supplierId: rec.id, kind: inp.dataset.kind, createdAt: Date.now(), ...p };
          await putOne("photos", photo);
          photos.push(photo);
          dirty = true;
          await saveNow();
          if (alive()) paintPhotos();
          toast("Foto salva ✓");
        } catch (err) {
          console.error(err);
          toast("Erro na foto: " + err.message, 4000);
        }
      }
    })
  );

  $("#photos").addEventListener("click", async (e) => {
    const b = e.target.closest(".del");
    if (!b || !confirm("Remover esta foto?")) return;
    await delOne("photos", b.dataset.id);
    photos = photos.filter((p) => p.id !== b.dataset.id);
    paintPhotos();
    dirty = true;
    saveNow();
  });

  $("#done").addEventListener("click", async () => {
    await saveNow();
    if (!persisted) { location.hash = "#/"; return; }
    toast("Salvo ✓");
    location.hash = "#/s/" + encodeURIComponent(rec.id);
  });

  const del = $("#del");
  if (del) del.addEventListener("click", async () => {
    if (!confirm("Excluir este stand e todas as fotos dele?")) return;
    clearTimeout(timer);
    dirty = false;
    leaving = null;
    flushOnHide = null;
    await chain;
    await deleteSupplier(rec.id);
    persisted = false;
    toast("Excluído");
    location.hash = "#/";
  });

  leaving = () => saveNow();
  flushOnHide = () => { saveNow(); };
}

// Ao trocar de app / bloquear a tela, grava o que estiver pendente.
let flushOnHide = null;
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && flushOnHide) flushOnHide();
});
window.addEventListener("pagehide", () => { if (flushOnHide) flushOnHide(); });

// ---------- detalhe ----------
const digits = (s) => String(s || "").replace(/\D/g, "");
function waNumber(s) {
  let d = digits(s);
  if (d.startsWith("00")) d = d.slice(2);
  if (/^1\d{10}$/.test(d)) d = "86" + d; // celular chinês sem DDI
  return d;
}
const withProto = (u) => (/^https?:\/\//i.test(u) ? u : "https://" + u);

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement("textarea");
    t.value = text;
    document.body.appendChild(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  toast("Copiado ✓");
}

function summaryText(s) {
  const lines = [
    `🏢 ${s.company || "Stand sem nome"}`,
    [s.booth && `Stand ${s.booth}`, s.phase, s.category].filter(Boolean).join(" · "),
    s.rating ? "⭐".repeat(s.rating) : "",
    s.liked && `👍 ${s.liked}`,
    s.concerns && `⚠️ ${s.concerns}`,
    s.products && `📦 ${s.products}`,
    s.price && `💲 ${s.currency || ""} ${s.price}`.trim(),
    s.moq && `MOQ: ${s.moq}`,
    s.payment && `Pagamento: ${s.payment}`,
    (s.incoterm || s.port) && `Incoterm: ${[s.incoterm, s.port].filter(Boolean).join(" ")}`,
    s.leadTime && `Prazo: ${s.leadTime}`,
    s.samples && `Amostra: ${s.samples}`,
    s.certifications && `Certificações: ${s.certifications}`,
    (s.contactName || s.role) && `👤 ${[s.contactName, s.role].filter(Boolean).join(" — ")}`,
    s.whatsapp && `WhatsApp: ${s.whatsapp}`,
    s.phone && `Tel: ${s.phone}`,
    s.wechat && `WeChat: ${s.wechat}`,
    s.email && `E-mail: ${s.email}`,
    s.website && `Site: ${s.website}`,
    s.nextStep && `➡️ ${s.nextStep}`,
  ];
  return lines.filter(Boolean).join("\n");
}

async function detailView(id, alive) {
  const s = await getOne("suppliers", id);
  if (!s) { location.hash = "#/"; return; }
  const photos = await photosOf(id);
  if (!alive()) return;
  setChrome({ title: s.company || "Stand sem nome", back: "#/" });

  const kv = (fields) => {
    const rows = fields
      .filter((f) => f.k !== "currency" && String(fieldText(s, f.k)).trim())
      .map((f) => {
        let v = String(fieldText(s, f.k));
        if (f.k === "price") v = `${s.currency || ""} ${v}`.trim();
        return `<dt>${esc(f.label)}</dt><dd class="pre">${esc(v)}</dd>`;
      });
    return rows.length ? `<dl class="kv">${rows.join("")}</dl>` : "";
  };
  const section = (sec) => {
    const body = kv(sec.fields.filter((f) => !["company", "booth", "phase", "category"].includes(f.k)));
    return body ? `<div class="card"><h2>${esc(sec.title)}</h2>${body}</div>` : "";
  };

  const wa = waNumber(s.whatsapp || s.phone);
  const quick = [
    wa && `<a class="btn" href="https://wa.me/${wa}" target="_blank" rel="noopener">💬 WhatsApp</a>`,
    s.phone && `<a class="btn" href="tel:${esc(s.phone.replace(/[^\d+]/g, ""))}">📞 Ligar</a>`,
    s.wechat && `<button class="btn" id="copy-wechat">🟩 Copiar WeChat</button>`,
    s.email && `<a class="btn" href="mailto:${esc(s.email)}">✉️ E-mail</a>`,
    s.website && `<a class="btn" href="${esc(withProto(s.website))}" target="_blank" rel="noopener">🌐 Site</a>`,
  ].filter(Boolean);

  view.innerHTML = `
    ${photos.length ? `<div class="hero">${photos.map((p) => `<img src="${photoUrl(p)}" alt="${esc(KINDS[p.kind] || "")}">`).join("")}</div>` : ""}
    <div class="card">
      <div style="font-size:20px;font-weight:700">${esc(s.company || "Stand sem nome")}</div>
      <div class="note">${esc([s.booth && "Stand " + s.booth, s.phase, s.category].filter(Boolean).join(" · "))}</div>
      <div style="margin-top:6px">${stars(s.rating)} ${statusBadge(s.status)}</div>
    </div>
    ${quick.length ? `<div class="quick">${quick.join("")}</div>` : ""}
    ${SECTIONS.map(section).join("")}
    <p class="note">Registrado em ${esc(fmtDate(s.createdAt))}${s.updatedAt && s.updatedAt - s.createdAt > 60e3 ? ` · editado em ${esc(fmtDate(s.updatedAt))}` : ""} · ${photos.length} foto(s)</p>
    <div class="btn-grid" style="grid-template-columns:1fr 1fr">
      <a class="btn primary" href="#/edit/${encodeURIComponent(s.id)}">✏️ Editar</a>
      <button class="btn" id="share">📤 Compartilhar</button>
    </div>`;

  $$(".hero img", view).forEach((img) =>
    img.addEventListener("click", () => {
      const v = document.createElement("div");
      v.className = "viewer";
      v.innerHTML = `<img src="${img.src}" alt="">`;
      v.addEventListener("click", () => v.remove());
      document.body.appendChild(v);
    })
  );
  const cw = $("#copy-wechat");
  if (cw) cw.addEventListener("click", () => copyText(s.wechat));
  $("#share").addEventListener("click", async () => {
    const text = summaryText(s);
    if (navigator.share) {
      try { await navigator.share({ title: s.company || "Stand", text }); return; }
      catch (e) { if (e.name === "AbortError") return; }
    }
    copyText(text);
  });
}

// ---------- ZIP (sem compressão: fotos JPEG já são comprimidas) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}
class ZipWriter {
  constructor() { this.blob = new Blob([]); this.parts = []; this.central = []; this.offset = 0; this.count = 0; }
  add(name, data) {
    const enc = new TextEncoder();
    const bytes = typeof data === "string" ? enc.encode(data) : new Uint8Array(data);
    const nameB = enc.encode(name);
    const crc = crc32(bytes);
    const { time, date } = dosDateTime(new Date());
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
    h.setUint16(8, 0, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, bytes.length, true); h.setUint32(22, bytes.length, true);
    h.setUint16(26, nameB.length, true); h.setUint16(28, 0, true);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
    c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, bytes.length, true); c.setUint32(24, bytes.length, true);
    c.setUint16(28, nameB.length, true); c.setUint32(42, this.offset, true);
    this.parts.push(h.buffer, nameB, bytes);
    this.central.push(c.buffer, nameB);
    this.offset += 30 + nameB.length + bytes.length;
    this.count++;
    // Junta em Blob de tempos em tempos para o navegador poder tirar da memória.
    if (this.parts.length >= 60) this.flush();
  }
  flush() { this.blob = new Blob([this.blob, ...this.parts]); this.parts = []; }
  finish() {
    this.flush();
    const cdSize = this.central.reduce((n, b) => n + b.byteLength, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, this.count, true); e.setUint16(10, this.count, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, this.offset, true);
    return new Blob([this.blob, ...this.central, e.buffer], { type: "application/zip" });
  }
}
async function readZip(file) {
  const tailLen = Math.min(file.size, 65557);
  const tail = new DataView(await file.slice(file.size - tailLen).arrayBuffer());
  let p = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.getUint32(i, true) === 0x06054b50) { p = i; break; }
  if (p < 0) throw new Error("O arquivo não é um .zip válido");
  const n = tail.getUint16(p + 10, true), cdSize = tail.getUint32(p + 12, true), cdOff = tail.getUint32(p + 16, true);
  const cd = new DataView(await file.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const dec = new TextDecoder();
  const entries = new Map();
  for (let i = 0, o = 0; i < n; i++) {
    if (cd.getUint32(o, true) !== 0x02014b50) throw new Error("Zip corrompido");
    const nl = cd.getUint16(o + 28, true), el = cd.getUint16(o + 30, true), cl = cd.getUint16(o + 32, true);
    entries.set(dec.decode(new Uint8Array(cd.buffer, o + 46, nl)), {
      method: cd.getUint16(o + 10, true), size: cd.getUint32(o + 20, true), lho: cd.getUint32(o + 42, true),
    });
    o += 46 + nl + el + cl;
  }
  return {
    async read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.method !== 0) throw new Error("Este zip foi recompactado. Use o arquivo original gerado pelo app.");
      const lh = new DataView(await file.slice(e.lho, e.lho + 30).arrayBuffer());
      const start = e.lho + 30 + lh.getUint16(26, true) + lh.getUint16(28, true);
      return file.slice(start, start + e.size).arrayBuffer();
    },
  };
}

// ---------- exportação ----------
function csvOf(suppliers) {
  const cols = [
    ["Registrado em", (s) => fmtDate(s.createdAt)],
    ...ALL_FIELDS.map((f) => [f.label, (s) => fieldText(s, f.k)]),
    ["Nota", (s) => s.rating || ""],
    ["Status", (s) => (statusOf(s.status) || [, ""])[1]],
    ["Fotos", (s) => s.photoCount || 0],
  ];
  const q = (v) => {
    v = String(v ?? "");
    if (/^[=+\-@]/.test(v)) v = " " + v; // evita o Excel tratar "+86…" como fórmula
    return /[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  // ";" é o separador que o Excel em português abre direto.
  return "﻿" + [cols.map((c) => q(c[0])).join(";"), ...suppliers.map((s) => cols.map((c) => q(c[1](s))).join(";"))].join("\r\n");
}

function reportHTML(suppliers, photosBy) {
  const block = (s, i) => {
    const rows = ALL_FIELDS.filter((f) => !["company", "currency"].includes(f.k) && String(fieldText(s, f.k)).trim())
      .map((f) => {
        let v = String(fieldText(s, f.k));
        if (f.k === "price") v = `${s.currency || ""} ${v}`.trim();
        return `<tr><th>${esc(f.label)}</th><td>${esc(v).replace(/\n/g, "<br>")}</td></tr>`;
      }).join("");
    const imgs = (photosBy.get(s.id) || [])
      .map((p) => `<a href="${esc(p.file)}" target="_blank"><img src="${esc(p.file)}" alt="${esc(KINDS[p.kind] || "")}" loading="lazy"></a>`).join("");
    const st = statusOf(s.status);
    return `<section class="s"><h2>${i + 1}. ${esc(s.company || "Stand sem nome")}
      <small>${s.rating ? "★".repeat(s.rating) + "☆".repeat(5 - s.rating) : ""} ${st ? esc(st[1]) : ""}</small></h2>
      <p class="m">Registrado em ${esc(fmtDate(s.createdAt))}</p><table>${rows}</table><div class="g">${imgs}</div></section>`;
  };
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Canton Fair — relatório</title><style>
body{font:15px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;max-width:980px;margin:0 auto;padding:16px;color:#1d1b19;background:#f6f4f1}
h1{color:#be1e2d}.s{background:#fff;border:1px solid #e4dfd8;border-radius:12px;padding:12px 16px;margin:14px 0}
h2{margin:0 0 4px;font-size:19px}h2 small{color:#e0a21a;font-size:14px;margin-left:8px}.m{color:#6b665f;margin:0 0 8px;font-size:13px}
table{border-collapse:collapse;width:100%}th{text-align:left;color:#6b665f;font-weight:500;width:32%;vertical-align:top;padding:3px 8px 3px 0}td{padding:3px 0}
.g{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.g img{height:150px;border-radius:8px}
#f{width:100%;padding:10px 12px;font:inherit;border:1px solid #ccc;border-radius:10px}
@media print{#f{display:none}.s{break-inside:avoid}.g img{height:110px}}
</style></head><body><h1>Canton Fair — ${suppliers.length} stands</h1>
<p>Exportado em ${esc(fmtDate(Date.now()))}. A planilha está em <b>planilha.csv</b> e as fotos na pasta <b>fotos</b>.</p>
<input id="f" type="search" placeholder="Filtrar por empresa, produto, tag…">
${suppliers.map(block).join("")}
<script>document.getElementById("f").oninput=function(e){var q=e.target.value.toLowerCase();document.querySelectorAll(".s").forEach(function(s){s.style.display=s.textContent.toLowerCase().indexOf(q)>-1?"":"none"})}<\/script>
</body></html>`;
}

const slug = (s) => norm(s).replace(/[^a-z0-9.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
const stamp = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
};

async function shareOrDownload(blob, name) {
  const file = new File([blob], name, { type: blob.type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return true; }
    catch (e) { if (e.name === "AbortError") return false; }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
  return true;
}

async function buildBackupZip(onProgress = () => {}) {
  const suppliers = (await getAll("suppliers")).sort((a, b) => a.createdAt - b.createdAt);
  const zip = new ZipWriter();
  const photoMeta = [];
  const photosBy = new Map();
  for (let i = 0; i < suppliers.length; i++) {
    const s = suppliers[i];
    const folder = `fotos/${String(i + 1).padStart(3, "0")}_${slug([s.booth, s.company].filter(Boolean).join(" ")) || "stand"}`;
    const list = [];
    (await photosOf(s.id)).forEach((p, j) => {
      const file = `${folder}/${String(j + 1).padStart(2, "0")}_${p.kind || "foto"}.jpg`;
      zip.add(file, p.data);
      const m = { id: p.id, supplierId: p.supplierId, kind: p.kind, type: p.type, createdAt: p.createdAt, thumb: p.thumb, file };
      photoMeta.push(m);
      list.push(m);
    });
    photosBy.set(s.id, list);
    onProgress(i + 1, suppliers.length);
  }
  zip.add("planilha.csv", csvOf(suppliers));
  zip.add("relatorio.html", reportHTML(suppliers, photosBy));
  zip.add("dados.json", JSON.stringify({ app: "canton-fair", version: 1, exportedAt: Date.now(), suppliers, photos: photoMeta }));
  return { blob: zip.finish(), suppliers: suppliers.length, photos: photoMeta.length };
}

async function restoreBackupZip(file) {
  const z = await readZip(file);
  const buf = await z.read("dados.json");
  if (!buf) throw new Error("Este .zip não é um backup do app (falta dados.json)");
  const data = JSON.parse(new TextDecoder().decode(buf));
  if (data.app !== "canton-fair") throw new Error("Este .zip não é um backup do app");
  let ns = 0, np = 0;
  for (const s of data.suppliers || []) {
    const cur = await getOne("suppliers", s.id);
    if (!cur || (s.updatedAt || 0) > (cur.updatedAt || 0)) { await putOne("suppliers", s); ns++; }
  }
  for (const m of data.photos || []) {
    if (await countKey("photos", m.id)) continue;
    const bin = await z.read(m.file);
    if (!bin) continue;
    await putOne("photos", { id: m.id, supplierId: m.supplierId, kind: m.kind, type: m.type || "image/jpeg", createdAt: m.createdAt, thumb: m.thumb, data: bin });
    np++;
  }
  // Recalcula capa e contagem (fotos de dois aparelhos podem ter se juntado).
  for (const s of data.suppliers || []) {
    const cur = await getOne("suppliers", s.id);
    const ph = await photosOf(s.id);
    if (cur && (cur.photoCount !== ph.length || cur.coverThumb !== coverOf(ph))) {
      cur.photoCount = ph.length;
      cur.coverThumb = coverOf(ph);
      await putOne("suppliers", cur);
    }
  }
  return { ns, np };
}

// ---------- tela de backup ----------
async function backupView(alive) {
  const suppliers = await getAll("suppliers");
  let est = null, persisted = null;
  try { est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch { /* ignora */ }
  try { persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch { /* ignora */ }
  if (!alive()) return;
  setChrome({ title: "Backup e exportação", back: "#/" });
  const photos = suppliers.reduce((n, s) => n + (s.photoCount || 0), 0);
  const last = Number(ls.get("cf.lastBackup") || 0);
  const mb = (b) => (b / 1048576).toFixed(0) + " MB";

  view.innerHTML = `
    <div class="card"><h2>Neste celular</h2>
      <dl class="kv">
        <dt>Stands</dt><dd>${suppliers.length}</dd>
        <dt>Fotos</dt><dd>${photos}</dd>
        ${est ? `<dt>Espaço usado</dt><dd>${mb(est.usage || 0)} de ${mb(est.quota || 0)}</dd>` : ""}
        <dt>Último backup</dt><dd>${last ? esc(fmtDate(last)) : "nunca"}</dd>
        ${persisted === false ? `<dt>Armazenamento</dt><dd>não garantido pelo navegador — faça backup com frequência</dd>` : ""}
      </dl>
    </div>
    <div class="btn-grid">
      <button class="btn primary" id="zip">📦 Backup completo (.zip)</button>
      <p class="note" style="margin:-4px 2px 6px">Fotos organizadas por stand + planilha + relatório que abre no computador. Mande para você mesmo no WhatsApp/e-mail ou salve no Drive/Arquivos.</p>
      <button class="btn" id="csv">📊 Só a planilha (Excel)</button>
      <label class="btn" style="margin:0">♻️ Restaurar / juntar um backup
        <input type="file" id="restore" accept=".zip,application/zip" hidden></label>
      <p class="note" style="margin:-4px 2px 6px">Restaurar não apaga nada: junta os registros do arquivo com os deste celular. Serve também para juntar o que você e um colega registraram.</p>
    </div>`;

  $("#zip").addEventListener("click", async (e) => {
    const b = e.currentTarget;
    b.disabled = true;
    try {
      const r = await buildBackupZip((i, n) => { b.textContent = `Gerando… ${i}/${n}`; });
      const ok = await shareOrDownload(r.blob, `canton-fair_${stamp()}.zip`);
      if (ok) { ls.set("cf.lastBackup", Date.now()); toast(`Backup: ${r.suppliers} stands, ${r.photos} fotos ✓`, 3500); }
    } catch (err) {
      console.error(err);
      toast("Erro no backup: " + err.message, 5000);
    } finally {
      b.disabled = false;
      b.textContent = "📦 Backup completo (.zip)";
    }
  });
  $("#csv").addEventListener("click", async () => {
    const list = (await getAll("suppliers")).sort((a, b) => a.createdAt - b.createdAt);
    await shareOrDownload(new Blob([csvOf(list)], { type: "text/csv" }), `canton-fair_${stamp()}.csv`);
  });
  $("#restore").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    toast("Restaurando…", 30000);
    try {
      const { ns, np } = await restoreBackupZip(f);
      toast(`Restaurado: ${ns} stands e ${np} fotos ✓`, 4000);
      render();
    } catch (err) {
      console.error(err);
      toast("Erro: " + err.message, 5000);
    }
  });
}

// ---------- início ----------
window.addEventListener("hashchange", render);
render();
if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  navigator.serviceWorker.register("sw.js").catch((e) => console.warn("SW:", e));
}
