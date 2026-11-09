// Servidor MCP da Central de Salas (Streamable HTTP, revisão 2026-07-28, sem sessão).
//
// Ciclo de MRTR da tool `reservar_sala`: o servidor nunca pergunta nada ao cliente no meio
// da execução. Num conflito ele TERMINA a resposta com `resultType: input_required`,
// devolvendo a elicitation e um `requestState` selado (HMAC) que carrega tudo o que é
// preciso para reconstruir o pedido. O cliente volta com um request novo, e é o
// `requestState` (verificado) que manda, nunca os argumentos reenviados.
import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import {
  McpServer,
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  ProtocolError,
  ProtocolErrorCode,
} from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import {
  POLITICA_TEXTO,
  POLITICA_VERSAO,
  SALAS,
  alternativas,
  conflitos,
  criarReserva,
  ERROS,
  validar,
} from "./dominio.js";

const PORTA = Number(process.env.MCP_PORT ?? 7301);
const CAMINHO = "/mcp";
const CHAVE_ELICITATION = "escolha_de_sala";
const TTL_REQUEST_STATE_S = 600; // 10 min: dentro da faixa de 5 a 30 min exigida

// --- segredo do requestState: sempre do ambiente, nunca do código -----------------------
const segredo = process.env.REQUEST_STATE_SECRET ?? "";
if (Buffer.byteLength(segredo) < 32) {
  console.error(
    "REQUEST_STATE_SECRET ausente ou com menos de 32 bytes.\n" +
      'Gere: export REQUEST_STATE_SECRET="$(python3 -c \'import secrets; print(secrets.token_hex(32))\')"',
  );
  process.exit(1);
}
const codec = createRequestStateCodec({ key: segredo, ttlSeconds: TTL_REQUEST_STATE_S });

// --- schemas ---------------------------------------------------------------------------
const intervaloShape = {
  sala: z.string().describe("id da sala, ex.: sala-garagem"),
  inicio: z.string().describe("ISO 8601 com offset"),
  fim: z.string().describe("ISO 8601 com offset"),
};
const reservaShape = { ...intervaloShape, responsavel: z.string() };

const SalaOut = z.object({
  id: z.string(),
  nome: z.string(),
  capacidade: z.number().int(),
  recursos: z.array(z.string()),
});
const ListaDeSalas = z.object({ salas: z.array(SalaOut) });
const Disponibilidade = z.object({
  sala: z.string(),
  livre: z.boolean(),
  conflitos: z.array(
    z.object({ id: z.string(), inicio: z.string(), fim: z.string(), responsavel: z.string() }),
  ),
});
const opt = (s) => s.nullable().default(null);
const ReservaOut = z.object({
  reserva: opt(z.string()),
  reservado: z.boolean().default(true),
  sala: opt(z.string()),
  inicio: opt(z.string()),
  fim: opt(z.string()),
  responsavel: opt(z.string()),
  politica: opt(z.string()),
  motivo: opt(z.string()),
});

// --- helpers de resultado --------------------------------------------------------------
const completo = (dados) => ({
  content: [{ type: "text", text: JSON.stringify(dados, null, 2) }],
  structuredContent: dados,
});
const falha = (mensagem) => ({ isError: true, content: [{ type: "text", text: mensagem }] });

function fazerReserva({ sala, inicio, fim, responsavel }) {
  const id = criarReserva({ sala, inicio, fim, responsavel });
  return completo({
    reserva: id,
    reservado: true,
    sala,
    inicio,
    fim,
    responsavel,
    politica: POLITICA_VERSAO,
    motivo: null,
  });
}

const recusado = () =>
  completo({
    reserva: null,
    reservado: false,
    sala: null,
    inicio: null,
    fim: null,
    responsavel: null,
    politica: null,
    motivo: "recusado",
  });

/** Pergunta qual alternativa usar: termina a resposta como input_required (nada fica no servidor). */
async function pedirEscolha(ctx, pedido, opcoes) {
  const requestState = await codec.mint({ tool: "reservar_sala", pedido, alternativas: opcoes }, ctx);
  return inputRequired({
    inputRequests: {
      [CHAVE_ELICITATION]: inputRequired.elicit({
        message: "A sala pedida esta ocupada nesse intervalo. Escolha uma alternativa.",
        requestedSchema: {
          type: "object",
          properties: {
            sala: { type: "string", title: "Sala", description: "Sala alternativa escolhida", enum: opcoes },
          },
          required: ["sala"],
        },
      }),
    },
    requestState,
  });
}

async function reservarSala(args, ctx) {
  const selado = ctx.mcpReq.requestState();

  // Retry: o estado já foi verificado pelo seam (HMAC + expiração). Os argumentos que o
  // cliente reenviou NÃO são confiáveis, então o pedido vem só do que foi selado.
  if (selado) {
    if (selado.tool !== "reservar_sala") throw new ProtocolError(ProtocolErrorCode.InvalidParams, "Invalid or expired requestState");
    const { pedido, alternativas: opcoes } = selado;
    const resposta = inputResponse(ctx.mcpReq.inputResponses, CHAVE_ELICITATION);

    if (resposta.kind === "elicit" && (resposta.action === "decline" || resposta.action === "cancel")) {
      return recusado();
    }
    if (resposta.kind === "elicit" && resposta.action === "accept") {
      const escolhida = resposta.content?.sala;
      if (typeof escolhida === "string" && opcoes.includes(escolhida)) {
        const v = validar({ ...pedido, sala: escolhida });
        if (v.erro) return falha(v.erro);
        if (conflitos(escolhida, v.ini, v.fim).length > 0) return falha(ERROS.semAlternativas);
        return fazerReserva({ ...pedido, sala: escolhida });
      }
    }
    // Resposta ausente, malformada ou fora do enum: pergunta de novo, com o estado selado.
    return pedirEscolha(ctx, pedido, opcoes);
  }

  // Primeira rodada.
  const v = validar(args);
  if (v.erro) return falha(v.erro);
  if (conflitos(args.sala, v.ini, v.fim).length === 0) return fazerReserva(args);

  const opcoes = alternativas(v.sala, v.ini, v.fim);
  if (opcoes.length === 0) return falha(ERROS.semAlternativas);
  // A capability de elicitation em form mode é checada pelo SDK a partir do `_meta` deste
  // request: sem ela, a resposta é -32021 com HTTP 400.
  return pedirEscolha(ctx, args, opcoes);
}

function criarMcpServer() {
  const server = new McpServer(
    { name: "central-de-salas", version: "1.0.0" },
    { requestState: { verify: (estado, ctx) => codec.verify(estado, ctx) } },
  );

  server.registerTool(
    "listar_salas",
    {
      description: "Lista todas as salas com capacidade e recursos.",
      inputSchema: z.object({}),
      outputSchema: ListaDeSalas,
    },
    async () => completo({ salas: SALAS }),
  );

  server.registerTool(
    "consultar_disponibilidade",
    {
      description: "Diz se uma sala esta livre no intervalo, e quais reservas conflitam.",
      inputSchema: z.object(intervaloShape),
      outputSchema: Disponibilidade,
    },
    async (args) => {
      const v = validar(args);
      if (v.erro) return falha(v.erro);
      const lista = conflitos(args.sala, v.ini, v.fim).map(({ id, inicio, fim, responsavel }) => ({
        id,
        inicio,
        fim,
        responsavel,
      }));
      return completo({ sala: args.sala, livre: lista.length === 0, conflitos: lista });
    },
  );

  server.registerTool(
    "reservar_sala",
    {
      description: "Reserva uma sala. Se o intervalo estiver ocupado, pergunta qual alternativa usar.",
      inputSchema: z.object(reservaShape),
      outputSchema: ReservaOut,
    },
    reservarSala,
  );

  server.registerResource(
    "politica-de-uso",
    "politica://uso",
    { title: "Politica de uso das salas", mimeType: "text/markdown" },
    async (uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/markdown", text: POLITICA_TEXTO }],
    }),
  );

  return server;
}

// --- HTTP: um endpoint, sem sessão ------------------------------------------------------
const handler = createMcpHandler(() => criarMcpServer(), {
  legacy: "reject",
  responseMode: "json",
  onerror: (e) => console.error(`[mcp] erro: ${e?.message ?? e}`),
});

/** Log de cada request no stderr: método, id e traceparent (quando vier no `_meta`). */
function registrar(corpo) {
  const msgs = Array.isArray(corpo) ? corpo : [corpo];
  for (const m of msgs) {
    const tp = m?.params?._meta?.traceparent ?? "-";
    const alvo = m?.params?.name ?? m?.params?.uri;
    console.error(
      `[mcp] metodo=${m?.method ?? "?"} id=${m?.id ?? "-"}${alvo ? ` alvo=${alvo}` : ""} traceparent=${tp}`,
    );
  }
}

// O adaptador oficial liga o `fetch` do handler ao node:http. O log entra por um clone do
// request, então o corpo continua intacto para o handler.
const comLog = {
  fetch: async (request, opcoes) => {
    if (request.method === "POST") {
      try {
        registrar(await request.clone().json());
      } catch {
        console.error("[mcp] corpo nao e JSON valido");
      }
    }
    return handler.fetch(request, opcoes);
  },
};
const noNode = toNodeHandler(comLog, { onerror: (e) => console.error(`[mcp] falha inesperada: ${e?.stack ?? e}`) });

const http = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  if (pathname !== CAMINHO) {
    res.writeHead(404).end();
    return;
  }
  noNode(req, res);
});

http.listen(PORTA, () => {
  console.error(`[mcp] central-de-salas ouvindo em http://localhost:${PORTA}${CAMINHO}`);
});

for (const sinal of ["SIGINT", "SIGTERM"]) {
  process.on(sinal, () => {
    handler.close().finally(() => http.close(() => process.exit(0)));
  });
}
