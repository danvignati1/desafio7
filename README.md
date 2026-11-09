# A Ponte: um agente A2A com MCP por dentro

Hill Valley Tech: cinco salas de reunião expostas como **servidor MCP**, e a capacidade de reservar exposta como **agente A2A** que, por dentro, é host MCP.

```
cliente A2A ──JSON-RPC /a2a──▶ agente (7300) ──MCP Streamable HTTP /mcp──▶ servidor MCP (7301)
                               host MCP + servidor A2A                       tools + resource + MRTR
```

- `servidor-mcp/`: servidor MCP (SDK oficial `@modelcontextprotocol/server` 2.4.0, revisão `2026-07-28`). Node 20+, ESM, sem build.
- `agente/`: agente A2A v1.0 (binding JSON-RPC). Cliente MCP com o SDK oficial `@modelcontextprotocol/client` 2.4.0. Sem LLM.
- `dados/`, `validador/`, `exemplos/`: do starter, intocados.

## Como rodar

Requisitos: Node.js 20+ e Python 3.10+ (só para o validador).

**1. Instalar** (a partir de um clone limpo):

```bash
npm ci --prefix servidor-mcp
npm ci --prefix agente
```

**2. Gerar o segredo do `requestState`.** Ele nunca fica no código nem no repositório: cada pessoa gera o seu (mínimo de 32 bytes de aleatoriedade) e exporta no terminal do servidor MCP.

```bash
export REQUEST_STATE_SECRET="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
```

**3. Terminal 1, servidor MCP** (porta `7301`, endpoint `/mcp`; o stderr mostra método, id e `traceparent` de cada request):

```bash
npm start --prefix servidor-mcp
```

**4. Terminal 2, agente** (porta `7300`, endpoint `/a2a`, card em `/.well-known/agent-card.json`):

```bash
npm start --prefix agente
```

**5. Terminal 3, validador** (com os dois processos recém-iniciados):

```bash
python3 validador/validar.py --agente http://localhost:7300 --mcp http://localhost:7301
```

Variáveis opcionais (os padrões são os do enunciado): `MCP_PORT` (7301), `AGENT_PORT` (7300), `MCP_URL` (`http://localhost:7301/mcp`, usada pelo agente) e `AGENT_PUBLIC_URL` (URL publicada no card; por padrão vem do header `Host`).

Para reiniciar o servidor MCP no meio de um fluxo, exporte **a mesma** `REQUEST_STATE_SECRET`: o `requestState` continua válido porque o estado viaja nele, não no servidor.

## Onde a ponte acontece

Tudo está em [`agente/src/ponte.js`](agente/src/ponte.js). O ponto em que o `input_required` do MCP vira `TASK_STATE_INPUT_REQUIRED` é a função `tratarResultado()` (marcada com `>>> PONTE (MCP -> A2A)`): ela lê a elicitation crua (o cliente MCP do SDK roda em modo manual, com `autoFulfill: false`, justamente para o agente enxergar o `input_required`), guarda o `requestState` em `task.pausa`, ligado àquela Task, e devolve a Task em `TASK_STATE_INPUT_REQUIRED` com a mensagem `alternativas: <ids na ordem do enum>`. O ponto em que o `requestState` volta para o servidor é `continuar()` (marcada com `>>> PONTE (A2A -> MCP)`): o `SendMessage` `escolha=<valor>` repete o `tools/call` original com um id de JSON-RPC novo (cada chamada de `chamarTool()` em [`agente/src/mcp-client.js`](agente/src/mcp-client.js) é um request novo do SDK), levando `inputResponses` com a mesma chave recebida e o `requestState` ecoado sem modificação; `escolha=recusar` vira `action: decline` e a Task termina em `TASK_STATE_CANCELED`. O agente nunca abre o `requestState`, e `serializar()` usa lista branca de campos, então ele não aparece em nenhuma resposta A2A.

## Decisões técnicas

- **Proteção do `requestState`.** Selado com HMAC-SHA256 pelo `createRequestStateCodec` do próprio SDK (formato `v1.<payload>.<mac>`), com verificação em tempo constante antes de o handler rodar (`ServerOptions.requestState.verify`). Adulteração, expiração ou outra chave dão `-32602`. O payload é legível (assinado, não cifrado) e carrega o pedido original (sala, intervalo e responsável) e as alternativas oferecidas. A chave vem de `REQUEST_STATE_SECRET` (o servidor não sobe sem ela ou com menos de 32 bytes).
- **Validade.** 10 minutos (faixa exigida: 5 a 30), contados a partir da emissão.
- **Servidor sem estado de MRTR.** No retry, o pedido é reconstruído só a partir do estado selado: os `arguments` reenviados pelo cliente são ignorados, e a sala escolhida só vale se estiver entre as alternativas seladas. Um retry depois de reiniciar o processo funciona (testado com o mesmo segredo; com outro segredo, `-32602`).
- **Capability de elicitation.** O SDK confere, a partir do `_meta` de cada request, se o cliente declarou `elicitation.form` antes de aceitar um `input_required`; sem ela, responde `-32021` com `data.requiredCapabilities` e HTTP `400`. Nada é inferido de requests anteriores.
- **Estado das Tasks.** Em memória no processo do agente (`Map` em `ponte.js`), por Task: estado, histórico, artifacts e a pausa (`requestState`, chave da elicitation e alternativas). Duas Tasks pausadas ao mesmo tempo não compartilham nada. Reiniciar o agente perde as Tasks, o que o enunciado aceita.
- **Reservas.** Em memória no servidor MCP, carregadas de `dados/reservas.json` ao subir.
- **`traceparent`.** O agente extrai o trace-id do header `traceparent` do cliente A2A e o repete, com span-id novo, no `_meta` de todos os requests MCP daquela Task (`tools/list`, `resources/read` e `tools/call`, inclusive o retry). O servidor registra cada request no stderr: `[mcp] metodo=... id=... traceparent=...`.
- **Cliente MCP do agente em modo manual.** O agente usa o SDK oficial `@modelcontextprotocol/client` com `inputRequired: { autoFulfill: false }` e `allowInputRequired: true` na chamada. Com o padrão do SDK (`autoFulfill: true`) o cliente responderia a elicitation por callback e o ciclo fecharia sem voltar ao cliente A2A, e a Task nunca pausaria. O `callTool()` não serve nesse caminho, porque exige `structuredContent` e rejeita o `input_required`; o `tools/call` vai por `client.request()` com `withInputRequired()`, o caminho documentado pelo SDK para o modo manual ([`agente/src/mcp-client.js`](agente/src/mcp-client.js)). A versão é fixada em `2026-07-28` (`versionNegotiation: { mode: { pin } }`): sem isso o cliente começaria com o `initialize` da era 2025 e o servidor, só modern, o recusaria. O SDK envia o envelope `_meta` e os headers `MCP-Protocol-Version`, `Mcp-Method` e `Mcp-Name` em todo request. O agente só acrescenta o `traceparent` (mesmo trace-id, span-id novo). Nenhuma limitação do SDK impediu algum item do enunciado.
- **Adaptador HTTP próprio no servidor.** O pacote `@modelcontextprotocol/node` não tem versão `2.4.0` publicada no npm, então `createMcpHandler(...).fetch` é ligado ao `node:http` em poucas linhas, que também registram o log do stderr.
- **Descoberta em runtime.** A cada Task o agente chama `tools/list` antes do primeiro `tools/call`, confere que `reservar_sala` existe e lê o resource `politica://uso` para extrair a versão da política (primeira linha), que vai para o artifact `reserva`.
- **Ordem das validações de erro.** Sala, intervalo invertido, janela de uso, duração. A janela é avaliada no relógio de São Paulo (-03:00).

## Saída do validador

Última execução, com os dois processos recém-iniciados:

```
trace-id desta execucao: 15b506b93c4fe31814f8696d6a84d510
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
