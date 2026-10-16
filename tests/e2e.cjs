// Teste ponta a ponta no Chromium com tela de celular:
// cria stand com foto -> busca -> detalhe -> backup .zip -> apaga tudo -> restaura.
// Uso: NODE_PATH=$(npm root -g) node tests/e2e.cjs
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };

function serve() {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/\/$/, "/index.html"));
    if (!p.startsWith(ROOT) || !fs.existsSync(p)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
    fs.createReadStream(p).pipe(res);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function assert(cond, msg) {
  if (!cond) throw new Error("FALHOU: " + msg);
  console.log("  ✓", msg);
}

(async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(fs.existsSync("/opt/pw-browsers/chromium") ? { executablePath: "/opt/pw-browsers/chromium" } : {});
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  page.on("dialog", (d) => d.accept());
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cf-e2e-"));

  try {
    await page.goto(base);
    await page.waitForSelector(".empty");
    assert(await page.isVisible("text=Nenhum stand ainda"), "lista vazia na primeira abertura");

    // foto de teste gerada no próprio navegador (4000x3000 para testar a redução)
    const b64 = await page.evaluate(() => {
      const c = document.createElement("canvas");
      c.width = 4000; c.height = 3000;
      const g = c.getContext("2d");
      g.fillStyle = "#c33"; g.fillRect(0, 0, 4000, 3000);
      g.fillStyle = "#fff"; g.font = "400px sans-serif"; g.fillText("CARTÃO", 600, 1600);
      return c.toDataURL("image/jpeg", 0.95).split(",")[1];
    });
    const img = { name: "cartao.jpg", mimeType: "image/jpeg", buffer: Buffer.from(b64, "base64") };

    // --- novo stand ---
    await page.click("#fab");
    await page.waitForSelector("#form");
    await page.setInputFiles('input[data-kind="cartao"]', img);
    await page.waitForSelector("#photos .photo");
    assert(/#\/edit\//.test(page.url()), "primeira foto já grava o registro (URL vira #/edit/…)");
    await page.fill("#f_company", "Ningbo Sunshine Houseware");
    await page.fill("#f_booth", "11.2 A15");
    await page.selectOption("#f_phase", "Fase 2");
    await page.click('#rating button[data-r="4"]');
    await page.click('label[for="st_prioridade"]');
    await page.fill("#f_liked", "Panelas com acabamento ótimo; aceitam logo");
    await page.fill("#f_whatsapp", "138 1234 5678");
    await page.fill("#f_price", "3,20 / un");
    await page.fill("#f_moq", "500 un");
    await page.fill("#f_payment", "30% sinal / 70% antes do embarque (T/T)");
    await page.fill("#f_tags", "cozinha, revenda");
    await page.click("#done");
    await page.waitForSelector(".hero img");
    assert(await page.isVisible("text=Ningbo Sunshine Houseware"), "detalhe mostra a empresa");
    const wa = await page.getAttribute('a[href^="https://wa.me/"]', "href");
    assert(wa === "https://wa.me/8613812345678", "WhatsApp chinês ganha DDI 86: " + wa);
    const dims = await page.evaluate(() => { const i = document.querySelector(".hero img"); return [i.naturalWidth, i.naturalHeight]; });
    assert(dims[0] === 1600 && dims[1] === 1200, "foto reduzida para 1600px: " + dims);

    // --- recarregar e conferir persistência ---
    await page.reload();
    await page.waitForSelector(".hero img");
    assert(await page.isVisible("text=500 un"), "dados persistem após recarregar");

    // --- segundo stand rápido, só texto ---
    await page.goto(base + "#/new");
    await page.waitForSelector("#form");
    await page.fill("#f_company", "Shenzhen Bright LED");
    await page.fill("#f_category", "Iluminação");
    await page.click('label[for="st_descartado"]');
    await page.click("#done");
    await page.waitForSelector(".card");

    // --- lista, busca e filtros ---
    await page.goto(base + "#/");
    await page.waitForSelector(".item");
    assert((await page.$$(".item")).length === 2, "lista com 2 stands");
    await page.fill("#q", "panela");
    assert((await page.$$(".item")).length === 1, "busca sem acento acha 'Panelas'");
    await page.fill("#q", "revenda");
    assert((await page.$$(".item")).length === 1, "busca por tag");
    await page.fill("#q", "");
    await page.click('.chip[data-v="descartado"]');
    assert((await page.$$(".item")).length === 1 && (await page.isVisible("text=Shenzhen Bright LED")), "filtro por status");
    await page.click('.chip[data-g="status"][data-v=""]');

    // --- editar sem mudar nada não altera data de edição ---
    const before = await page.evaluate(() => new Promise((r) => {
      const q = indexedDB.open("cantonfair"); q.onsuccess = () => {
        const g = q.result.transaction("suppliers").objectStore("suppliers").getAll();
        g.onsuccess = () => r(g.result.map((s) => [s.id, s.updatedAt]));
      };
    }));
    await page.goto(base + "#/edit/" + encodeURIComponent(before[0][0]));
    await page.waitForSelector("#form");
    await page.click("#done");
    await page.waitForSelector(".card");
    const after = await page.evaluate((id) => new Promise((r) => {
      const q = indexedDB.open("cantonfair"); q.onsuccess = () => {
        const g = q.result.transaction("suppliers").objectStore("suppliers").get(id);
        g.onsuccess = () => r(g.result.updatedAt);
      };
    }), before[0][0]);
    assert(after === before[0][1], "abrir e salvar sem mudanças não altera o registro");

    // --- backup ---
    await page.goto(base + "#/backup");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#zip")]);
    const zipPath = path.join(tmp, dl.suggestedFilename());
    await dl.saveAs(zipPath);
    const listing = JSON.parse(execFileSync("python3", ["-c", `
import zipfile, json, sys
z = zipfile.ZipFile(sys.argv[1]); bad = z.testzip()
print(json.dumps({"bad": bad, "names": z.namelist(), "csv": z.read("planilha.csv").decode("utf-8-sig")}))`, zipPath]).toString());
    assert(listing.bad === null, "zip íntegro (CRC conferido pelo Python)");
    assert(listing.names.some((n) => /^fotos\/001_11\.2_a15_ningbo_sunshine_houseware\/01_cartao\.jpg$/.test(n)), "fotos organizadas por stand");
    assert(["planilha.csv", "relatorio.html", "dados.json"].every((n) => listing.names.includes(n)), "zip contém planilha, relatório e dados");
    assert(listing.csv.split("\r\n")[0].includes("Empresa / fornecedor;Nº do stand"), "planilha com cabeçalho em português e ';'");
    assert(listing.csv.includes("Panelas com acabamento ótimo"), "planilha com as anotações");

    // --- apagar tudo e restaurar ---
    await page.evaluate(() => new Promise((r) => { const q = indexedDB.deleteDatabase("cantonfair"); q.onsuccess = q.onerror = q.onblocked = () => r(); }));
    await page.goto(base + "#/");
    await page.reload();
    await page.waitForSelector(".empty");
    assert(await page.isVisible("text=Nenhum stand ainda"), "banco apagado");
    await page.goto(base + "#/backup");
    await page.waitForSelector("#restore", { state: "attached" });
    await page.setInputFiles("#restore", zipPath);
    await page.waitForSelector("text=Restaurado: 2 stands e 1 fotos");
    assert(true, "restauração informa 2 stands e 1 foto");
    await page.goto(base + "#/");
    await page.waitForSelector(".item");
    assert((await page.$$(".item")).length === 2, "lista volta com 2 stands");
    await page.click("text=Ningbo Sunshine Houseware");
    await page.waitForSelector(".hero img");
    assert(await page.isVisible("text=Panelas com acabamento ótimo; aceitam logo"), "foto e anotações restauradas");

    // restaurar de novo não duplica
    await page.goto(base + "#/backup");
    await page.waitForSelector("#restore", { state: "attached" });
    await page.setInputFiles("#restore", zipPath);
    await page.waitForSelector("text=Restaurado: 0 stands e 0 fotos");
    assert(true, "restaurar o mesmo backup duas vezes não duplica");

    assert(errors.length === 0, "nenhum erro no console" + (errors.length ? ": " + errors.join(" | ") : ""));
    console.log("\nTODOS OS TESTES PASSARAM");
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exit(1); });
