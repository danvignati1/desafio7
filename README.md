# A Ponte: um agente A2A com MCP por dentro

Hill Valley Tech: cinco salas de reuniao expostas como **servidor MCP**, e a capacidade de reservar exposta como **agente A2A** que, por dentro, e host MCP.

```
cliente A2A ──JSON-RPC /a2a──▶ agente (7300) ──MCP Streamable HTTP /mcp──▶ servidor MCP (7301)
                               host MCP + servidor A2A                       tools + resource + MRTR
```

- `servidor-mcp/`: servidor MCP (SDK oficial `@modelcontextprotocol/server` 2.4.0, revisao `2026-07-28`). Node 20+, ESM, sem build.
- `agente/`: agente A2A v1.0 (binding JSON-RPC). Sem dependencias, sem LLM.
- `dados/`, `validador/`, `exemplos/`: do starter, intocados.

## Como rodar

Requisitos: Node.js 20+ e Python 3.10+ (so para o validador).

**1. Instalar** (a partir de um clone limpo):

```bash
npm ci --prefix servidor-mcp
```

O agente nao tem dependencias, entao nao precisa de `npm install`.

**2. Gerar o segredo do `requestState`.** Ele nunca fica no codigo nem no repositorio: cada pessoa gera o seu (minimo 32 bytes de aleatoriedade) e exporta no terminal do servidor MCP.

```bash
export REQUEST_STATE_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
```

**3. Terminal 1, servidor MCP** (porta `7301`, endpoint `/mcp`; o stderr mostra metodo, id e `traceparent` de cada request):

```bash
npm start --prefix servidor-mcp
```

**4. Terminal 2, agente** (porta `7300`, endpoint `/a2a`, card em `/.well-known/agent-card.json`):

```bash
npm start --prefix agente
```

**5. Terminal 3, validador** (com os dois processos recem-iniciados):

```bash
python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

Variaveis opcionais (os padroes sao os do enunciado): `MCP_PORT` (7301), `AGENT_PORT` (7300), `MCP_URL` (`http://localhost:7301/mcp`, usada pelo agente) e `AGENT_PUBLIC_URL` (URL publicada no card; por padrao vem do header `Host`).

Para reiniciar o servidor MCP no meio de um fluxo, exporte **a mesma** `REQUEST_STATE_SECRET`: o `requestState` continua valido porque o estado viaja nele, nao no servidor.

## Onde a ponte acontece

Tudo esta em [`agente/src/ponte.js`](agente/src/ponte.js). O ponto em que o `input_required` do MCP vira `TASK_STATE_INPUT_REQUIRED` e a funcao `tratarResultado()` (marcada com `>>> PONTE (MCP -> A2A)`): ela le a elicitation crua (o agente usa um cliente MCP proprio, sem callback de elicitation, justamente para enxergar o `input_required`), guarda o `requestState` em `task.pausa`, ligado aquela Task, e devolve a Task em `TASK_STATE_INPUT_REQUIRED` com a mensagem `alternativas: <ids na ordem do enum>`. O ponto em que o `requestState` volta para o servidor e `continuar()` (marcada com `>>> PONTE (A2A -> MCP)`): o `SendMessage` `escolha=<valor>` repete o `tools/call` original com um id de JSON-RPC novo (`novoId()` em [`agente/src/mcp-client.js`](agente/src/mcp-client.js) gera um por request), levando `inputResponses` com a mesma chave recebida e o `requestState` ecoado sem modificacao; `escolha=recusar` vira `action: decline` e a Task termina em `TASK_STATE_CANCELED`. O agente nunca abre o `requestState`, e `serializar()` usa lista branca de campos, entao ele nao aparece em nenhuma resposta A2A.

## Decisoes tecnicas

- **Protecao do `requestState`.** Selado com HMAC-SHA256 pelo `createRequestStateCodec` do proprio SDK (formato `v1.<payload>.<mac>`), com verificacao em tempo constante antes de o handler rodar (`ServerOptions.requestState.verify`). Adulteracao, expiracao ou outra chave dao `-32602`. O payload e legivel (assinado, nao cifrado) e carrega o pedido original (sala, intervalo e responsavel) e as alternativas oferecidas. A chave vem de `REQUEST_STATE_SECRET` (o servidor nao sobe sem ela ou com menos de 32 bytes).
- **Validade.** 10 minutos (faixa exigida: 5 a 30), contados a partir da emissao.
- **Servidor sem estado de MRTR.** No retry, o pedido e reconstruido so a partir do estado selado: os `arguments` reenviados pelo cliente sao ignorados, e a sala escolhida so vale se estiver entre as alternativas seladas. Um retry depois de reiniciar o processo funciona (testado com o mesmo segredo; com outro segredo, `-32602`).
- **Capability de elicitation.** O SDK confere, a partir do `_meta` de cada request, se o cliente declarou `elicitation.form` antes de aceitar um `input_required`; sem ela, responde `-32021` com `data.requiredCapabilities` e HTTP `400`. Nada e inferido de requests anteriores.
- **Estado das Tasks.** Em memoria no processo do agente (`Map` em `ponte.js`), por Task: estado, historico, artifacts e a pausa (`requestState`, chave da elicitation e alternativas). Duas Tasks pausadas ao mesmo tempo nao compartilham nada. Reiniciar o agente perde as Tasks, o que o enunciado aceita.
- **Reservas.** Em memoria no servidor MCP, carregadas de `dados/reservas.json` ao subir.
- **`traceparent`.** O agente extrai o trace-id do header `traceparent` do cliente A2A e o repete, com span-id novo, no `_meta` de todos os requests MCP daquela Task (`tools/list`, `resources/read` e `tools/call`, inclusive o retry). O servidor registra cada request no stderr: `[mcp] metodo=... id=... traceparent=...`.
- **Cliente MCP do agente escrito sobre `fetch`.** O cliente do SDK trataria o `input_required` por callback e fecharia o ciclo sem voltar ao cliente A2A. Por isso o agente usa um cliente minimo ([`agente/src/mcp-client.js`](agente/src/mcp-client.js)) que envia o envelope `_meta` e os headers `MCP-Protocol-Version`, `Mcp-Method` e `Mcp-Name` em todo request e devolve o resultado como veio. Ele continua falando com o servidor por HTTP, em outro processo.
- **Adaptador HTTP proprio no servidor.** O pacote `@modelcontextprotocol/node` nao tem versao `2.4.0` publicada no npm, entao `createMcpHandler(...).fetch` e ligado ao `node:http` em poucas linhas, que tambem registram o log do stderr.
- **Descoberta em runtime.** A cada Task o agente chama `tools/list` antes do primeiro `tools/call`, confere que `reservar_sala` existe e le o resource `politica://uso` para extrair a versao da politica (primeira linha), que vai para o artifact `reserva`.
- **Ordem das validacoes de erro.** sala, intervalo invertido, janela de uso, duracao. A janela e avaliada no relogio de Sao Paulo (-03:00).

## Saida do validador

Ultima execucao, com os dois processos recem-iniciados:

```
trace-id desta execucao: 7dec6534fe08610b9c64ea9f0294b39e
procure esse valor no stderr do servidor MCP para conferir a propagacao do traceparent.

PASS 01 tools/list traz as tres tools
PASS 02 toda tool tem inputSchema de objeto
PASS 03 listar_salas devolve structuredContent e o mesmo JSON em texto
PASS 04 _meta sem protocolVersion devolve -32602 e HTTP 400
PASS 05 _meta sem clientCapabilities devolve -32602 e HTTP 400
PASS 06 tool inexistente e recusada, por -32602 ou por isError
PASS 07 resources/read de politica://uso devolve a politica
PASS 08 resources/read de URI inexistente devolve -32602
PASS 09 sala inexistente devolve isError com a mensagem exata
PASS 10 fora da janela devolve isError com a mensagem exata
PASS 11 duracao acima de 2h devolve isError com a mensagem exata
PASS 12 intervalo invertido devolve isError com a mensagem exata
PASS 13 conflito devolve input_required com inputRequests e requestState
PASS 14 a elicitation e form mode e oferece as alternativas na ordem certa
PASS 15 conflito sem a capability elicitation devolve -32021 e HTTP 400
PASS 16 retry com inputResponses e requestState conclui a reserva
PASS 17 requestState adulterado e rejeitado com -32602
PASS 18 argumentos adulterados no retry nao tomam efeito
PASS 19 recusa conclui sem reservar e sem isError
PASS 20 conflito sem alternativa possivel devolve isError com a mensagem exata

PASS 21 agent card responde 200 no well-known com JSON
PASS 22 o card declara a interface JSON-RPC com url e versao 1.0
PASS 23 o card declara a skill reservar-sala
PASS 24 SendMessage com sala livre conclui a Task
PASS 25 o artifact chama reserva e traz a versao da politica
PASS 26 GetTask devolve id, contextId e estado corrente
PASS 27 SendMessage com sala ocupada pausa a Task
PASS 28 a Task pausada lista as alternativas na ordem certa
PASS 29 escolha fora do enum mantem a Task pausada
PASS 30 a continuacao conclui a Task na sala escolhida
PASS 31 SendMessage em Task terminal e recusado
PASS 32 a recusa termina a Task em CANCELED
PASS 33 duas Tasks pausadas ao mesmo tempo concluem cada uma com a sua reserva
PASS 34 nenhuma resposta A2A carrega o requestState
PASS 35 sala inexistente termina a Task em FAILED com a mensagem da tool
PASS 36 o agente e deterministico: o mesmo pedido produz a mesma pausa

resumo: 36 passaram, 0 falharam, de 36 verificacoes
```
