# Canton Fair — caderno de stands

App de celular (PWA) para registrar os stands visitados na Canton Fair.
**Funciona sem internet**: tudo fica salvo no próprio aparelho.
Não tem nenhuma dependência externa, nem fonte ou biblioteca de CDN
(muitos serviços do Google e de CDNs são bloqueados na China).

**Abrir no celular:** https://denerfelipeandrade.github.io/canton-fair/

## O que faz

- **Fotos** com um toque: cartão de visita, produto, tabela de preços ou da galeria.
  São reduzidas para 1600px antes de salvar (≈200–400 KB cada).
- **Stand**: empresa, nº do stand (ex.: 11.2 A15), fase, categoria, produtos.
- **Avaliação**: nota de 1 a 5 estrelas, status (🔥 Prioridade, 👍 Interessante, 🤔 Talvez, ✖ Descartado),
  o que gostei, pontos de atenção, próximo passo e tags.
- **Contato**: nome, cargo, WhatsApp, telefone, WeChat, e-mail e site.
  No detalhe tem botões para abrir o WhatsApp (número chinês ganha +86 automaticamente),
  ligar, mandar e-mail e copiar o WeChat.
- **Condições comerciais**: preço e moeda, MOQ, prazo, pagamento (com sugestões T/T 30/70, L/C…),
  Incoterm, porto, amostra, OEM e certificações.
- **Busca** em todos os campos (ignora acentos), filtros por status e por fase, ordenação por nota, empresa ou nº do stand.
- **Salva sozinho** enquanto você digita. Se o celular recarregar o app ao abrir a câmera, o registro não se perde.
- **Backup .zip** (botão ⇅): fotos organizadas em pastas por stand, `planilha.csv` (abre direto no Excel)
  e `relatorio.html`, que abre no computador com tudo e as fotos, com filtro de busca.
  O mesmo .zip serve para **restaurar** ou **juntar** registros de dois celulares.

## Como colocar no celular

O app precisa ser servido por **HTTPS** uma vez. Depois disso, o service worker guarda tudo
e ele abre offline.

1. O app é publicado pelo GitHub Pages (branch `gh-pages`) em https://denerfelipeandrade.github.io/canton-fair/
2. Abra o link no celular **com internet** (de preferência antes de entrar na China, ou pelo roaming/eSIM).
3. Instale na tela inicial:
   - iPhone (Safari): Compartilhar → *Adicionar à Tela de Início*.
   - Android (Chrome): menu ⋮ → *Instalar app*.
4. Abra pelo ícone e cadastre um stand de teste, para confirmar que a câmera funciona.

## Cuidados

- Os dados ficam **só neste celular**. Faça o **backup .zip todo fim de dia** e mande para você mesmo
  (WhatsApp, e-mail, Drive). O app avisa quando há registros sem backup.
- No iPhone, use sempre o app instalado na tela inicial (o armazenamento do app é separado do Safari).
- Não use aba anônima: os dados são apagados quando ela fecha.

## Desenvolvimento

Sem build: são HTML, CSS e JS puros. Para rodar localmente:

```bash
python3 -m http.server 8000   # abra http://localhost:8000
```

Teste ponta a ponta (Chromium com tela de celular: cria, busca, faz backup, apaga e restaura):

```bash
NODE_PATH=$(npm root -g) node tests/e2e.cjs
```

Ao mudar qualquer arquivo do app, incremente `VERSION` em `sw.js`. Só assim os celulares baixam a versão nova.
