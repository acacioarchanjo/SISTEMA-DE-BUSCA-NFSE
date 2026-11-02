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

## 🗺️ Arquitetura e evolução

- [Arquitetura de robôs RPA fiscais (ISS e NFS-e)](docs/arquitetura-rpa-iss-nfse.md): rotina operacional, conectores por
  sistema municipal (Paulistana, DSF, GISS, SigISS, Betha, ABRASF), validação fiscal, orquestração em nuvem, resiliência,
  human-in-the-loop, catálogo de status, log de auditoria e roteiro a partir deste projeto.

---

## 🚀 Como rodar

Requisitos: **Node.js 22 ou mais novo** (22, 24 e 26 funcionam; o banco `better-sqlite3` 13 já vem compilado
para Windows, Linux e macOS, sem precisar de Visual Studio). O `.npmrc` do projeto (`ignore-scripts=true`)
impede que o npm 11 tente recompilá-lo.

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

### Windows: atalho na Área de Trabalho (sem janela preta)

Depois de rodar o `iniciar.bat` pela primeira vez, dê **duplo clique em `criar-atalho.bat`**. Ele cria o atalho
**"Buscador NFS-e"** (com ícone) na Área de Trabalho e no Menu Iniciar. O atalho usa o `abrir.vbs`, que:
- sobe o sistema **em segundo plano, sem janela preta**;
- abre o navegador assim que o painel está pronto;
- se o sistema já estiver aberto, só abre o painel no navegador;
- grava o registro do servidor em `data\logs\servidor.log` e avisa se o sistema não responder.

Para **fechar o sistema**, clique em **⏻ Encerrar** no canto do painel. Se mudar a pasta do sistema de lugar,
rode o `criar-atalho.bat` de novo. O `iniciar.bat` continua funcionando com a janela visível, o que é útil para ver erros.

### Cadastrar várias empresas de uma vez (em lote)

Em **Empresas → Importar em lote**:
1. selecione ou arraste vários `.pfx`/`.p12`, ou clique em **escolha uma pasta inteira**;
2. informe as senhas: uma por linha, **"Mesma senha para todos"**, ou uma **planilha de senhas** (CSV);
3. clique em **Validar**: cada certificado é aberto e aparece como *Nova empresa*, *Renovação*, *Já cadastrado*,
   *Cadastrado vence depois* ou com o erro (senha incorreta, vencido…);
4. clique em **Cadastrar**. Só os válidos são gravados. Na **renovação**, a empresa existente recebe o certificado novo
   e mantém notas, cursor NSU e razão social.

Planilha de senhas (Excel → "Salvar como CSV"), com o nome do arquivo (com ou sem `.pfx`) **ou** o CNPJ:

```
arquivo;senha
Padaria Bom Pao;pao123
11.222.333/0001-81;outraSenha
```

Pela linha de comando:

```bash
npm run cli -- importar-certificados C:\Certificados --senhas senhas.csv --simular
```
(sem `--simular` grava; `--senha X` vale para os que não estão na planilha)

### Prefeituras com webservice próprio (fase 2 do roteiro)

Alguns municípios ainda não enviam todas as notas ao ADN. Para esses, o sistema consulta o **webservice da prefeitura
no padrão ABRASF** (versões 1.00, 2.01, 2.02, 2.03 e 2.04), com o mesmo certificado A1 da empresa.

**No painel:** Empresas → ⋯ → **Prefeituras (webservice municipal)…**
1. Escolha um município já cadastrado ou **+ Cadastrar novo município**: código IBGE, nome, UF, versão ABRASF e
   **URL do webservice** (está no manual de integração da prefeitura). Se o manual pedir, ajuste as
   **opções avançadas** do envelope SOAP (versão SOAP, estilo, namespace, SOAPAction, período por emissão/competência).
2. Informe a inscrição municipal, se o município exigir, e clique em **Vincular**.
3. Clique em **Testar conexão**: o sistema faz uma consulta mínima e diz se URL, versão e certificado estão certos.
4. **Buscar agora**, ou deixe para o **Buscar todas**/agendamento diário, que passa a consultar também as prefeituras.

Como funciona:
- Consulta **notas prestadas** e **tomadas** (a versão 1.00 do padrão só permite prestadas), quebrando o período em
  janelas (30 dias por padrão) e seguindo a paginação. A primeira busca olha 90 dias para trás; as seguintes
  continuam de onde pararam, reconsultando os últimos 5 dias (`NFSE_MUNICIPAL_RETROATIVO_DIAS`, `NFSE_MUNICIPAL_SOBREPOSICAO_DIAS`).
- As notas entram no mesmo cadastro (origem *Prefeitura*), com **código de verificação**, passam pela **conferência
  fiscal** e aparecem nas exportações. Cancelamentos informados pela prefeitura marcam a nota e geram o `CAN-001` quando for o caso.
- Nova regra **`DUP-001`**: se a mesma prestação vier do ADN e da prefeitura (mesmo prestador, tomador, valor e dia),
  as duas notas recebem um alerta para não serem contadas em dobro.
- Erros da prefeitura entram no catálogo de status: *Portal indisponível* (com 3 tentativas), *Erro de autenticação*,
  *Dado inconsistente* (SOAP Fault, MensagemRetorno) e o novo **Mudança no serviço** (resposta em formato inesperado —
  versão ou URL errada). O trecho da resposta aparece no detalhe da execução.
- **Consulta assinada** (XMLDSig, RSA-SHA1/C14N com o A1): se a prefeitura recusar a consulta por falta de assinatura,
  o sistema assina, tenta de novo e passa a assinar sempre naquele município. Se recusar o SHA-1, tenta RSA-SHA256
  e guarda o algoritmo que funcionou.
- **Municípios com configuração pronta**: ao digitar o IBGE, versão, URL e envelope SOAP são preenchidos; se o cadastro
  existente for diferente, aparece **Aplicar configuração recomendada**. Disponível: **Campinas/SP** (3509502, ABRASF 2.03,
  sistema IMA: XML da consulta **sem namespace** e **sempre assinado**). Liste com `npm run cli -- municipio-recomendado`.
- Ainda **não suportado**: sistemas fora do padrão ABRASF (ex.: São Paulo/Paulistana, DSF, GISS) — próximas fases.

```bash
npm run cli -- perfis
npm run cli -- municipio 4205407 --nome Florianópolis --uf SC --perfil abrasf-2.02 --url https://... [--opcao soapVersao=1.2]
npm run cli -- vincular 11222333000181 4205407 --im 123456
npm run cli -- testar-prefeitura 11222333000181 4205407
npm run cli -- buscar-prefeitura [empresa] [--de 2026-01-01 --ate 2026-03-31]
```

### Conferência fiscal e auditoria (fase 1 do roteiro)

Depois de cada busca (ou importação), o sistema **confere as notas** contra regras nacionais do ISS e mostra o
resultado em **Conferência** (menu lateral), na coluna **Conf.** da lista de notas e no detalhe de cada nota:

| Regra | O que aponta | Severidade |
|---|---|---|
| `RET-001` | Serviço dos subitens do art. 6º, §2º, II da LC 116 prestado a PJ **sem ISS retido** | Bloqueante (para a tomadora) / Alerta (para a prestadora) |
| `RET-002` | ISS retido **sem** responsabilidade prevista na LC 116 (tomador PF, subitem fora da lista) | Alerta |
| `RET-004` | Retenção de prestador do Simples com alíquota fora de 2%–5% | Alerta |
| `RET-005` | ISS retido de prestador **MEI** | Alerta |
| `ALQ-001` / `ALQ-002` | Alíquota abaixo de 2% (LC 157) / acima de 5% | Alerta / Bloqueante |
| `CMP-001` | Nota emitida meses depois da competência | Informativa (Alerta se ≥ 3 meses) |
| `CAN-001` | Nota cancelada/substituída **depois** do mês de competência (pode exigir retificação) | Bloqueante |
| `DUP-001` | A mesma prestação veio do ADN **e** da prefeitura (possível contagem em dobro) | Alerta |

O robô **aponta, não decide**: cada divergência pode ser **ignorada com justificativa** (lei municipal, imunidade…)
ou reaberta, e isso fica registrado na auditoria. Se os dados da nota mudarem, as divergências são recalculadas.

**Resultado de cada busca** segue um catálogo de status (*Sucesso*, *Sucesso parcial*, *Sem movimento*,
*Erro de autenticação*, *Portal indisponível*, *Limite de consultas*, *Exige ação*…), com o **que fazer** em cada caso
(clique na execução para ver os detalhes).

**Log de auditoria**: cadastro/renovação/exclusão de empresas, cada execução, cada lote, cada validação e cada decisão
sobre divergências ficam num registro **somente de inclusão**, encadeado por hash (o banco bloqueia alterações e a
verificação detecta adulteração). Em **Execuções** há o botão **Verificar integridade** e a exportação em JSON.

```bash
npm run cli -- validar                 # confere todas as notas
npm run cli -- divergencias --regras   # catálogo de regras
npm run cli -- divergencias -s BLOQUEANTE
npm run cli -- auditoria verificar     # confere a cadeia de hash
npm run cli -- auditoria exportar -o auditoria.json
```

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
