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

| Pasta | O que tem |
|---|---|
| `src/adn/` | Cliente mTLS + loop de distribuição por NSU (o coração) |
| `src/nfse/` | Parser do XML da NFS-e nacional |
| `src/crypto/` | Cofre (cifra o `.pfx`) + leitura do certificado |
| `src/db/` | SQLite (empresas, documentos, cursor) |
| `src/portal/` | Descobridor de chaves via portal (conciliação) |
| `src/exportador/` | ZIP pro Domínio/Onvio + DANFSe em PDF |
| `src/server/` | Painel web local (Node puro, sem framework) |

---

## 🚀 Como rodar

Requisitos: **Node.js 20+**.

```bash
# 1) instalar dependências
npm install

# 2) configurar
cp .env.example .env
# gere a chave de criptografia e cole em NFSE_MASTER_KEY no .env:
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# 3) subir o painel
npm start
# abre em http://localhost:3000
```

No painel: **Empresas → + Nova empresa** → informe o CNPJ e faça upload do certificado **A1 (.pfx)** com a senha. Depois clique em **▶ Buscar** pra baixar as NFS-e.

> 💡 Precisa de um **certificado A1 válido** de uma empresa pra testar de verdade (é ele que autentica na Receita). O certificado nunca sai do seu computador.

---

## ⚠️ Avisos importantes

- **Uso educacional.** O objetivo é ensinar a técnica. Teste com dados de que você tenha autorização.
- **LGPD:** certificados e notas são dados sensíveis. Este projeto guarda tudo **localmente e cifrado**, e o `.gitignore` impede que `data/` (certificados e XMLs) vá parar no Git. **Nunca** faça commit de certificado ou nota de cliente.
- Fala com a **API oficial do governo** — respeite os limites (o código já tem retry e trava anti-`656`).

---

## 📖 Licença

[MIT](LICENSE) — © 2026 Franklim Paixão · Família TributárIA. Use, estude, modifique. Se te ajudou, marca o [@franklim.contador](https://instagram.com/franklim.contador). 🙌
