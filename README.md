# 🔎 Buscador NFS-e (edição educacional)

Um robô **100% local** que baixa automaticamente as **NFS-e (Notas Fiscais de Serviço eletrônicas)** do **Padrão Nacional** (nfse.gov.br), autenticando com o **certificado digital A1** da empresa — sem depender de portal manual, sem mensalidade e sem enviar nada pra nuvem.

> 📚 **Material didático da mentoria [Família TributárIA](https://instagram.com/franklim.contador)** — por **Franklim Paixão**, o contador que ensina contadores.
> Esta é uma versão **aberta e simplificada**, feita pra você **entender como funciona** a automação de documentos fiscais na prática. Não é um produto comercial.

---

## 🎯 O que este projeto te ensina

- 🔐 **Autenticação com certificado A1 (mTLS)** — como usar um `.pfx` pra falar direto com a API do governo, sem senha de portal.
- 🛰️ **ADN (Ambiente de Dados Nacional)** — o serviço de *distribuição por NSU* da Receita: como iterar em lotes até baixar tudo, com **cursor persistente** (pega só o que ainda não veio).
- 🧾 **Parsing de XML fiscal** — extrair prestador, tomador, valores, ISS e **retenções federais** (PIS/COFINS/CSLL/IRRF/INSS) direto do XML da NFS-e.
- 🗄️ **Armazenamento local seguro** — SQLite + certificados cifrados em disco (AES-256-GCM). LGPD-friendly.
- 🖥️ **Painel web local** — um dashboard em Node puro (sem framework) pra cadastrar empresas, disparar buscas e conferir as notas.
- 📦 **Exportação** — gera ZIP de XMLs organizados + planilha, pronto pra importar em sistemas contábeis.

---

## 🧩 Como funciona (arquitetura)

```
  Certificado A1 (.pfx)
        │  (cifrado em disco com AES-256-GCM)
        ▼
  Cliente mTLS  ──►  API ADN da Receita  ──►  lotes de XML (por NSU)
        │                                          │
        │                                          ▼
        │                                    Parser de XML  ──►  metadados
        ▼                                          │
   Cursor NSU  ◄── avança sempre ──────────────────┘
        │
        ▼
   SQLite local  ◄──►  Painel web (localhost:3000)  ──►  Exportar ZIP/CSV
```

| Pasta / arquivo | O que tem |
|---|---|
| `src/adn/cliente.js` | Cliente HTTPS mTLS (certificado A1) para o ADN e a API SEFIN, com retry e detecção de consumo indevido |
| `src/adn/distribuicao.js` | Loop de distribuição por NSU com cursor persistente e gravação em transação por lote |
| `src/nfse/parser.js` | Parser do XML da NFS-e nacional e dos eventos (cancelamento, substituição…) |
| `src/nfse/armazenamento.js` | XMLs em disco: `data/xml/{CNPJ}/{AAAA-MM}/{chave}.xml` |
| `src/crypto/` | Cofre AES-256-GCM, leitura do `.pfx` (CNPJ pelo OID ICP-Brasil) e cadastro de empresas |
| `src/db/` | SQLite: `empresas`, `cursor_nsu`, `documentos`, `eventos` e `execucoes` |
| `src/portal/conciliacao.js` | (experimental) Lista as chaves no Emissor Nacional e baixa as que faltam |
| `src/exportador/` | ZIP (XMLs + planilha), CSV no padrão pt-BR e DANFSe simplificado em PDF com QR Code |
| `src/server/` | Painel web local em Node puro: API JSON e front-end em `public/` |
| `src/cli/` | Linha de comando para tudo o que o painel faz, e mais |
| `src/agendador.js` | Busca diária e conciliação mensal (node-cron) |
| `tests/` | 24 testes automatizados (`npm test`), incluindo um servidor mTLS falso que simula o ADN |

---

## 🚀 Como rodar

Requisitos: **Node.js 22 ou mais novo** (22, 24 e 26 funcionam; o banco `better-sqlite3` 13 já vem compilado
para Windows, Linux e macOS, sem precisar de Visual Studio).

```bash
# 1) instalar dependências
npm install

# 2) configurar
cp .env.example .env          # no Windows: copy .env.example .env
# gere a chave de criptografia e cole em NFSE_MASTER_KEY no .env:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 3) (opcional) criar o banco
npm run init-db

# 4) subir o painel
npm start
# abre em http://127.0.0.1:3000
```

No painel: **Empresas → + Nova empresa** → faça upload do certificado **A1 (.pfx)** com a senha (o CNPJ é lido
do próprio certificado). Depois clique em **▶ Buscar** pra baixar as NFS-e. Acompanhe na aba **Execuções**.

> 💡 Precisa de um **certificado A1 válido** de uma empresa pra testar de verdade (é ele que autentica na Receita).
> O certificado nunca sai do seu computador.

> 🔑 **Guarde a `NFSE_MASTER_KEY`.** Sem ela não dá pra decifrar os certificados salvos; seria preciso cadastrá-los de novo.

### Windows: duplo clique

Depois de instalar o Node.js (versão 22 ou mais nova), dê **duplo clique em `iniciar.bat`**. Ele:
1. confere se o Node está instalado (versão 22 ou mais nova);
2. roda `npm install` na primeira vez, ou de novo se a instalação estiver incompleta;
3. cria o `.env` e gera a `NFSE_MASTER_KEY` automaticamente (**faça backup do `.env`**);
4. abre o navegador no painel e sobe o sistema.

Para encerrar, feche a janela preta ou aperte `Ctrl+C`.

### Windows: busca automática diária

1. Rode o `iniciar.bat` uma vez e cadastre as empresas.
2. Dê **duplo clique em `agendar-busca-diaria.bat`**, informe o horário (padrão 03:00) e pronto: ele cria a tarefa
   **"Buscador NFS-e - busca diaria"** no Agendador de Tarefas do Windows.
3. Todo dia, nesse horário, o `busca-diaria.bat` busca as notas de **todas as empresas ativas**, sem precisar do
   painel aberto. O resultado fica em `data\logs\busca-AAAA-MM-DD.log` (logs com mais de 90 dias são apagados).

- O computador precisa estar ligado e com o usuário conectado no horário.
- Se alguma empresa falhar, a tarefa termina com código 1 ("Último resultado" no Agendador).
- Para remover: `agendar-busca-diaria.bat remover`.

### Windows: exportar as notas do mês

Dê **duplo clique em `exportar-mes.bat`** e responda as perguntas:
1. o mês de competência (padrão: mês anterior);
2. a empresa (id ou CNPJ, ou Enter para todas);
3. se quer o PDF de cada nota.

O ZIP vai para a pasta `exportacoes\` (ex.: `nfse-2026-03.zip`), com os XMLs organizados por
empresa/emitidas/recebidas e a `planilha-nfse.csv`, e a pasta abre sozinha no Explorer.
A pasta `exportacoes/` fica fora do Git, porque contém dados de clientes.

### Windows: backup dos dados

Dê **duplo clique em `backup-dados.bat`**. Ele pergunta a pasta de destino (padrão: `backups\` no projeto;
pode ser um pendrive, HD externo ou pasta sincronizada com a nuvem) e se inclui o `.env`.

- O ZIP (`backup-nfse-AAAA-MM-DD_HHMMSS.zip`) leva o banco, os XMLs, os logs e o `.env` com a `NFSE_MASTER_KEY`.
- Pode rodar **com o painel aberto**: o banco é copiado pela API de backup do SQLite, então a cópia sai consistente.
- Ficam os **10 backups mais recentes** na pasta de destino.
- Para **restaurar**, use o `restaurar-backup.bat` (abaixo). O `LEIA-ME.txt` dentro do ZIP explica também como fazer à mão.
- Para backup automático, agende `backup-dados.bat auto` no Agendador de Tarefas (roda sem perguntas e salva em `backups\`).
- ⚠️ O backup tem dados de clientes e a chave que decifra os certificados: guarde em local protegido.

### Windows: restaurar um backup

1. Feche o painel (janela do `iniciar.bat`).
2. Dê **duplo clique em `restaurar-backup.bat`** e escolha o número do backup da pasta `backups\`,
   ou **arraste um backup `.zip`** (de um pendrive, por exemplo) para cima do `.bat`.
3. Confira o resumo e digite **SIM**.

- **Nada é apagado:** a pasta `data` e o `.env` atuais são guardados como `data-antes-restauracao-<data>` e
  `.env.antes-restauracao-<data>`. Depois de conferir que está tudo certo, você pode apagá-los.
- Se algo falhar no meio (ZIP corrompido, banco inválido, arquivo em uso), **tudo volta como estava**.
- O `.bat` recusa restaurar com o painel aberto.
- Depois de restaurar, ele confere se a chave do `.env` abre os certificados. Se o backup foi feito sem o `.env`,
  coloque a `NFSE_MASTER_KEY` da época do backup ou cadastre os certificados de novo.

### Windows: atualizar o sistema

Feche o painel e dê **duplo clique em `atualizar.bat`**. Ele:
1. confere se o painel está fechado;
2. compara a versão instalada com a do GitHub e, se já estiver atualizado, não faz nada;
3. faz um **backup automático** dos dados (se o backup falhar, a atualização é cancelada);
4. baixa a versão nova: usa `git pull` se a pasta veio do `git clone`, ou baixa o ZIP do GitHub;
5. copia só os arquivos do sistema, **sem tocar em `data`, `backups`, `exportacoes` e `.env`**;
6. roda o `npm install` e testa se o sistema abre.

Precisa de internet e do Windows 10 ou mais novo (usa o PowerShell para baixar e descompactar).

### Linha de comando

```bash
npm run cli -- empresas                                  # lista empresas
npm run cli -- certificado cert.pfx -s SENHA             # só mostra os dados do certificado
npm run cli -- adicionar cert.pfx -s SENHA               # cadastra/atualiza empresa
npm run cli -- buscar                                    # busca todas as empresas ativas
npm run cli -- buscar 11222333000181                     # busca uma empresa (id ou CNPJ)
npm run cli -- cursor 1 0                                # volta o cursor NSU (rebaixa tudo)
npm run cli -- importar 1 ./pasta-com-xmls               # importa XMLs já baixados (notas e eventos)
npm run cli -- exportar --mes 2026-03 --pdf               # ZIP do mês com XMLs + planilha + PDFs
npm run cli -- exportar --csv -e 1 -o marco.csv          # só a planilha
npm run cli -- conciliar 1 --de 2026-03-01 --ate 2026-03-31       # (experimental) confere com o portal
npm run cli -- agendar                                   # fica rodando conforme NFSE_ADN_CRON
npm run cli -- backup --destino E:\Backups               # ZIP com banco, XMLs, logs e .env
npm run cli -- backups                                   # lista os backups de ./backups
npm run cli -- restaurar 1 --sim                         # restaura o backup nº 1 (sem --sim só mostra o resumo)
```

### Como a busca funciona

1. O `.pfx` é decifrado em memória e convertido para PEM (evita o erro do OpenSSL 3 com PFX antigos RC2/3DES).
2. `GET https://adn.nfse.gov.br/contribuintes/DFe/{NSU}?cnpjConsulta={CNPJ}&lote=true` com mTLS.
3. Cada item do `LoteDFe` vem em base64 + GZip: o robô descompacta, identifica se é **NFS-e** ou **evento** e grava.
4. Documentos e cursor são gravados **na mesma transação**: se cair no meio, recomeça do último lote salvo.
5. Repete até não vir NSU novo. Há uma pausa entre lotes e um limite de lotes por execução.
6. Se o governo responder **HTTP 429 / consumo indevido**, a empresa fica **travada** por `NFSE_ADN_TRAVA_MIN`
   minutos (dá pra destravar no painel). Falhas de rede e 5xx têm retry com espera exponencial.
7. O papel da empresa (emitida, recebida ou intermediário) vem da comparação do CNPJ com prestador, tomador
   e intermediário. Eventos de cancelamento ou substituição marcam a nota, mesmo que cheguem antes dela.

### Segurança do painel

- Escuta só em `127.0.0.1`, recusa `Host` diferente de localhost (contra DNS rebinding) e exige o cabeçalho
  `X-Buscador` em POST/PATCH/DELETE (contra CSRF).
- A API nunca devolve o certificado nem a senha. Os XMLs ficam em `data/` (ignorado pelo Git).

### O que foi validado e o que depende do ambiente real

- ✅ Testado automaticamente: cofre, leitura de certificado com OID ICP-Brasil, parser, eventos, laço de NSU
  (idempotência, trava e retomada), mTLS contra um servidor local, exportações e a API do painel.
- ⚠️ **Depende de certificado real:** a resposta do ADN de produção. O cliente aceita variações de maiúsculas
  e minúsculas nos campos do JSON (`LoteDFe`, `NSU`, `ArquivoXml`…). Se algo vier diferente, rode com
  `NFSE_DEBUG=1` para ver as respostas brutas.
- 🧪 **Conciliação via portal é experimental:** o Emissor Nacional é HTML, não uma API, e pode mudar sem aviso.
  O ADN continua sendo a fonte principal.
- 📄 O PDF gerado é um **DANFSe simplificado** para conferência. Não substitui o DANFSe oficial do portal.

---

## ⚠️ Avisos importantes

- **Uso educacional.** O objetivo é ensinar a técnica. Teste com dados de que você tenha autorização.
- **LGPD:** certificados e notas são dados sensíveis. Este projeto guarda tudo **localmente e cifrado**, e o `.gitignore` impede que `data/` (certificados e XMLs) vá parar no Git. **Nunca** faça commit de certificado ou nota de cliente.
- Fala com a **API oficial do governo** — respeite os limites (o código já tem retry e trava anti-`656`).

---

## 📖 Licença

[MIT](LICENSE) — © 2026 Franklim Paixão · Família TributárIA. Use, estude, modifique. Se te ajudou, marca o [@franklim.contador](https://instagram.com/franklim.contador). 🙌
