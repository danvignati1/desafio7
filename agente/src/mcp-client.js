// Cliente MCP mínimo sobre fetch, escrito à mão de propósito.
//
// O agente precisa enxergar o `input_required` CRU: um cliente de SDK com callback de
// elicitation responderia a pergunta sozinho e a Task A2A nunca pausaria. Aqui o cliente só
// monta o envelope por request (sem sessão), manda e devolve o resultado como veio.
import { randomBytes } from "node:crypto";

export const PROTOCOLO = "2026-07-28";
export const CAPABILITIES = { elicitation: { form: {} } };
const CLIENT_INFO = { name: "agente-central-de-salas", version: "1.0.0" };

// Ids de JSON-RPC únicos por request: o retry de uma pausa NUNCA reaproveita o id anterior.
let contador = 0;
const novoId = () => `agente-${++contador}-${randomBytes(4).toString("hex")}`;

export class ErroMcp extends Error {
  constructor(erro, http) {
    super(erro?.message ?? "erro MCP");
    this.codigo = erro?.code;
    this.dados = erro?.data;
    this.http = http;
  }
}

export class ClienteMcp {
  constructor(url) {
    this.url = url;
  }

  /**
   * Um request MCP. Declara, em TODO request: versão, clientInfo, a capability de elicitation
   * em form mode e, quando houver, o traceparent (mesmo trace-id, span-id novo). Os headers
   * espelham o corpo (MCP-Protocol-Version, Mcp-Method e Mcp-Name).
   * Devolve { id, result }. Erro de protocolo vira ErroMcp.
   */
  async chamar(metodo, params, { nome, traceId } = {}) {
    const meta = {
      "io.modelcontextprotocol/protocolVersion": PROTOCOLO,
      "io.modelcontextprotocol/clientInfo": CLIENT_INFO,
      "io.modelcontextprotocol/clientCapabilities": CAPABILITIES,
    };
    if (traceId) meta.traceparent = `00-${traceId}-${randomBytes(8).toString("hex")}-01`;

    const id = novoId();
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": PROTOCOLO,
      "Mcp-Method": metodo,
    };
    if (nome) headers["Mcp-Name"] = nome;

    const resp = await fetch(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method: metodo, params: { ...params, _meta: meta } }),
    });
    const corpo = await resp.json().catch(() => ({}));
    if (corpo.error) throw new ErroMcp(corpo.error, resp.status);
    if (!corpo.result) throw new ErroMcp({ message: `resposta MCP inesperada (HTTP ${resp.status})` }, resp.status);
    return { id, result: corpo.result };
  }

  /** tools/list: as tools são descobertas em runtime, nunca hardcoded. */
  async listarTools(opcoes) {
    const { result } = await this.chamar("tools/list", {}, opcoes);
    return result.tools ?? [];
  }

  /** resources/read de um recurso; devolve o texto do primeiro conteúdo. */
  async lerRecurso(uri, opcoes) {
    const { result } = await this.chamar("resources/read", { uri }, { ...opcoes, nome: uri });
    return result.contents?.[0]?.text ?? "";
  }

  /** tools/call. `extra` leva inputResponses e requestState no retry de um MRTR. */
  chamarTool(nome, argumentos, extra = {}, opcoes) {
    return this.chamar("tools/call", { name: nome, arguments: argumentos, ...extra }, { ...opcoes, nome });
  }
}
