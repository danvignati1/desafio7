// Agente A2A v1.0 (binding JSON-RPC sobre HTTP): Agent Card, SendMessage e GetTask.
// Por dentro ele é host MCP (ver ponte.js); por fora, um servidor A2A opaco, sem LLM.
import { createServer } from "node:http";
import { ErroA2A, enviarMensagem, obterTask } from "./ponte.js";

const PORTA = Number(process.env.AGENT_PORT ?? 7300);

function agentCard(host) {
  return {
    name: "Central de Salas",
    description: "Reserva salas de reuniao da Hill Valley Tech.",
    provider: { organization: "Hill Valley Tech", url: "https://hillvalley.example" },
    version: "1.0.0",
    supportedInterfaces: [
      { url: process.env.AGENT_PUBLIC_URL ?? `http://${host}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
    ],
    capabilities: { streaming: false, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "reservar-sala",
        name: "Reservar sala",
        description: "Reserva uma sala em um intervalo. Se houver conflito, pergunta qual alternativa usar.",
        tags: ["salas", "agenda"],
        inputModes: ["text/plain"],
        outputModes: ["text/plain"],
        examples: [
          "reservar sala=sala-garagem inicio=2026-11-03T14:00:00-03:00 fim=2026-11-03T15:00:00-03:00 responsavel=Marty",
        ],
      },
    ],
  };
}

/** trace-id do header traceparent do cliente A2A (formato W3C), se válido. */
function traceIdDe(cabecalho) {
  return /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/.exec(cabecalho ?? "")?.[1];
}

const METODOS = {
  SendMessage: (params, ctx) => enviarMensagem(params, ctx),
  GetTask: (params) => obterTask(params),
};

async function tratarRpc(corpo, ctx) {
  const id = corpo?.id ?? null;
  if (corpo?.jsonrpc !== "2.0" || typeof corpo?.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } };
  }
  const metodo = METODOS[corpo.method];
  if (!metodo) return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${corpo.method}` } };
  try {
    return { jsonrpc: "2.0", id, result: await metodo(corpo.params, ctx) };
  } catch (e) {
    if (e instanceof ErroA2A) return { jsonrpc: "2.0", id, error: { code: e.code, message: e.message } };
    console.error(`[agente] erro interno em ${corpo.method}: ${e?.stack ?? e}`);
    return { jsonrpc: "2.0", id, error: { code: -32603, message: "Internal error" } };
  }
}

function responder(res, status, objeto) {
  const texto = JSON.stringify(objeto);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(texto) });
  res.end(texto);
}

const http = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${PORTA}`}`);

  if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
    return responder(res, 200, agentCard(req.headers.host ?? `localhost:${PORTA}`));
  }

  if (req.method === "POST" && url.pathname === "/a2a") {
    const partes = [];
    for await (const p of req) partes.push(p);
    let corpo;
    try {
      corpo = JSON.parse(Buffer.concat(partes).toString("utf8"));
    } catch {
      return responder(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    const traceId = traceIdDe(req.headers.traceparent);
    console.error(`[agente] metodo=${corpo?.method ?? "?"} id=${corpo?.id ?? "-"} traceparent=${req.headers.traceparent ?? "-"}`);
    return responder(res, 200, await tratarRpc(corpo, { traceId }));
  }

  res.writeHead(404).end();
});

http.listen(PORTA, () => {
  console.error(`[agente] A2A ouvindo em http://localhost:${PORTA}/a2a (MCP em ${process.env.MCP_URL ?? "http://localhost:7301/mcp"})`);
});

for (const sinal of ["SIGINT", "SIGTERM"]) process.on(sinal, () => http.close(() => process.exit(0)));
