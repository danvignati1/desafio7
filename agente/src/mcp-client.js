// Cliente MCP do agente, sobre o SDK oficial `@modelcontextprotocol/client` (revisão 2026-07-28).
//
// O ponto de atenção é o MRTR: com o padrão do SDK (`autoFulfill: true`) o cliente responderia
// a elicitation sozinho, por callback, e o ciclo fecharia sem voltar ao cliente A2A: a Task
// nunca pausaria. Por isso o cliente roda em MODO MANUAL: `autoFulfill: false` no cliente e
// `allowInputRequired: true` na chamada, e o `input_required` chega CRU ao agente.
//
// `callTool()` não serve nesse caminho (ele exige `structuredContent` e rejeita o
// `input_required`), então o tools/call vai por `client.request()` com `withInputRequired()`,
// que é o caminho documentado pelo SDK para o modo manual.
import { randomBytes } from "node:crypto";
import {
  Client,
  StreamableHTTPClientTransport,
  specTypeSchemas,
  withInputRequired,
} from "@modelcontextprotocol/client";

export const PROTOCOLO = "2026-07-28";
const CALL_TOOL_RESULT = withInputRequired(specTypeSchemas.CallToolResult);

export class ErroMcp extends Error {
  constructor(erro) {
    super(erro?.message ?? "erro MCP");
    this.codigo = erro?.code;
    this.dados = erro?.data;
  }
}

/** Erros do SDK (JSON-RPC ou HTTP) viram ErroMcp, sem nunca carregar o requestState. */
function traduzir(e) {
  if (typeof e?.code === "number") return new ErroMcp({ code: e.code, message: e.message, data: e.data });
  try {
    const corpo = JSON.parse(e?.data?.text ?? "");
    if (corpo?.error) return new ErroMcp(corpo.error);
  } catch {
    /* corpo não era JSON-RPC */
  }
  return e;
}

export class ClienteMcp {
  constructor(url) {
    this.url = url;
    this.conectando = undefined;
    this.client = undefined;
  }

  /**
   * Um único objeto cliente vivo entre chamadas (é só o objeto, sem estado de protocolo):
   * cada request leva o próprio envelope `_meta` com versão e capabilities, e a versão é
   * fixada na revisão 2026-07-28. A capability declarada é a elicitation em form mode.
   */
  async conectar() {
    this.conectando ??= (async () => {
      const client = new Client(
        { name: "agente-central-de-salas", version: "1.0.0" },
        {
          capabilities: { elicitation: { form: {} } },
          inputRequired: { autoFulfill: false },
          versionNegotiation: { mode: { pin: PROTOCOLO } },
        },
      );
      await client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
      this.client = client;
    })().catch((e) => {
      this.conectando = undefined; // permite tentar de novo no próximo request
      throw e;
    });
    await this.conectando;
    return this.client;
  }

  /** traceparent com o MESMO trace-id da Task e span-id novo a cada request. */
  static meta(traceId) {
    return traceId ? { traceparent: `00-${traceId}-${randomBytes(8).toString("hex")}-01` } : undefined;
  }

  /** tools/list: as tools são descobertas em runtime, nunca hardcoded. */
  async listarTools({ traceId } = {}) {
    try {
      const client = await this.conectar();
      const { tools } = await client.listTools({ _meta: ClienteMcp.meta(traceId) });
      return tools ?? [];
    } catch (e) {
      throw traduzir(e);
    }
  }

  /** resources/read; devolve o texto do primeiro conteúdo. */
  async lerRecurso(uri, { traceId } = {}) {
    try {
      const client = await this.conectar();
      const r = await client.readResource({ uri, _meta: ClienteMcp.meta(traceId) });
      return r.contents?.[0]?.text ?? "";
    } catch (e) {
      throw traduzir(e);
    }
  }

  /**
   * tools/call em modo manual. `extra` leva `inputResponses` e `requestState` no retry de um
   * MRTR; cada chamada é um request novo do SDK, com id de JSON-RPC novo.
   * Devolve { result }: o resultado completo, ou o `input_required` cru.
   */
  async chamarTool(nome, argumentos, extra = {}, { traceId } = {}) {
    try {
      const client = await this.conectar();
      const result = await client.request(
        {
          method: "tools/call",
          params: { name: nome, arguments: argumentos, ...extra, _meta: ClienteMcp.meta(traceId) },
        },
        CALL_TOOL_RESULT,
        { allowInputRequired: true },
      );
      return { result };
    } catch (e) {
      throw traduzir(e);
    }
  }
}
