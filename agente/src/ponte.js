// A PONTE: onde o estado do MCP (requestState) e o estado do A2A (Task) se encontram.
//
//  MCP -> A2A  `tratarResultado()`: o `input_required` cru do servidor MCP vira
//              TASK_STATE_INPUT_REQUIRED. A pergunta sobe ao cliente A2A como a linha
//              "alternativas: ...", e o `requestState` fica guardado em `task.pausa`,
//              ligado àquela Task e a nenhuma outra.
//  A2A -> MCP  `continuar()`: o SendMessage "escolha=<valor>" repete o tools/call original com
//              id novo, levando `inputResponses` (mesma chave) e o `requestState` ecoado
//              sem modificação.
//
// O agente traduz protocolo, não domínio: conflito, política e alternativas são do servidor MCP.
// O `requestState` é opaco aqui (guardar e ecoar) e nunca sai em nenhuma resposta A2A.
import { randomBytes } from "node:crypto";
import { ClienteMcp, ErroMcp } from "./mcp-client.js";

const MCP_URL = process.env.MCP_URL ?? "http://localhost:7301/mcp";
const cliente = new ClienteMcp(MCP_URL);

const TERMINAIS = new Set(["TASK_STATE_COMPLETED", "TASK_STATE_CANCELED", "TASK_STATE_FAILED"]);
const id = (prefixo) => `${prefixo}-${randomBytes(6).toString("hex")}`;

/** Erro de JSON-RPC do binding A2A. */
export class ErroA2A extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
const TASK_NAO_ENCONTRADA = -32001;
const OPERACAO_NAO_SUPORTADA = -32004;
const PARAMS_INVALIDOS = -32602;

// Estado das Tasks: em memória, por Task. `pausa` é interno (requestState) e nunca é serializado.
const tasks = new Map();

// --- Task ------------------------------------------------------------------------------
function textoDe(mensagem) {
  return (mensagem?.parts ?? []).map((p) => p.text ?? "").join("");
}

function mensagemDoAgente(task, texto) {
  return {
    messageId: id("msg"),
    role: "ROLE_AGENT",
    parts: [{ text: texto }],
    taskId: task.id,
    contextId: task.contextId,
  };
}

/** Transição de estado. Estado terminal é definitivo: nunca sai dele. */
function mudarEstado(task, estado, texto) {
  if (TERMINAIS.has(task.estado)) throw new Error(`Task ${task.id} ja esta em ${task.estado}`);
  task.estado = estado;
  task.mensagem = texto === undefined ? undefined : mensagemDoAgente(task, texto);
  if (task.mensagem) task.historico.push(task.mensagem);
}

/** Vista A2A da Task. Lista branca de campos: `pausa` e o requestState jamais entram aqui. */
function serializar(task) {
  const status = { state: task.estado, timestamp: new Date().toISOString() };
  if (task.mensagem) status.message = task.mensagem;
  return {
    id: task.id,
    contextId: task.contextId,
    status,
    history: task.historico,
    artifacts: task.artefatos,
  };
}

// --- pedido em formato fixo ------------------------------------------------------------
const PEDIDO = /^\s*reservar\s+sala=(\S+)\s+inicio=(\S+)\s+fim=(\S+)\s+responsavel=(.+?)\s*$/;

function lerPedido(texto) {
  const m = PEDIDO.exec(texto);
  return m ? { sala: m[1], inicio: m[2], fim: m[3], responsavel: m[4] } : undefined;
}

// --- resultado do MCP -> estado da Task --------------------------------------------------
const textoDoResultado = (r) => (r.content ?? []).map((c) => c.text ?? "").join(" ");

/** Lê as alternativas do enum (ou const) da elicitation, na ordem em que vieram. */
function lerOpcoes(pedidoElicitacao) {
  const campo = pedidoElicitacao?.params?.requestedSchema?.properties?.sala ?? {};
  return campo.enum ?? ("const" in campo ? [campo.const] : []);
}

function tratarResultado(task, resultado) {
  // >>> PONTE (MCP -> A2A): input_required vira Task interrompida, com o requestState guardado.
  if (resultado.resultType === "input_required") {
    const [chave] = Object.keys(resultado.inputRequests ?? {});
    const opcoes = lerOpcoes(resultado.inputRequests?.[chave]);
    if (!chave || typeof resultado.requestState !== "string" || opcoes.length === 0) {
      return mudarEstado(task, "TASK_STATE_FAILED", "Resposta input_required invalida do servidor MCP");
    }
    task.pausa = { chave, requestState: resultado.requestState, opcoes };
    return mudarEstado(task, "TASK_STATE_INPUT_REQUIRED", `alternativas: ${opcoes.join(", ")}`);
  }

  task.pausa = undefined;
  if (resultado.isError) return mudarEstado(task, "TASK_STATE_FAILED", textoDoResultado(resultado));

  const dados = resultado.structuredContent ?? {};
  if (dados.reservado === false) {
    return mudarEstado(task, "TASK_STATE_CANCELED", `Reserva nao realizada: ${dados.motivo ?? "recusada"}.`);
  }
  task.artefatos.push({
    artifactId: id("art"),
    name: "reserva",
    parts: [
      {
        text: JSON.stringify({
          reserva: dados.reserva,
          sala: dados.sala,
          inicio: dados.inicio,
          fim: dados.fim,
          responsavel: dados.responsavel,
          politica: task.politica,
        }),
      },
    ],
  });
  return mudarEstado(task, "TASK_STATE_COMPLETED", `Reserva ${dados.reserva} confirmada na ${dados.sala}.`);
}

/** Qualquer falha de protocolo MCP termina a Task em FAILED, sem vazar o requestState. */
function falhaMcp(task, e) {
  if (e instanceof ErroMcp) {
    return mudarEstado(task, "TASK_STATE_FAILED", `Erro do servidor MCP (${e.codigo}): ${e.message}`);
  }
  return mudarEstado(task, "TASK_STATE_FAILED", `Falha ao falar com o servidor MCP: ${e.message}`);
}

// --- fluxos ----------------------------------------------------------------------------
async function iniciar(task, pedido) {
  const opcoes = { traceId: task.traceId };
  try {
    // Descoberta em runtime: tools/list antes da primeira chamada, nada de lista fixa.
    const tools = await cliente.listarTools(opcoes);
    if (!tools.some((t) => t.name === "reservar_sala")) {
      return mudarEstado(task, "TASK_STATE_FAILED", "O servidor MCP nao expoe a tool reservar_sala");
    }
    // O resource da política é escolha da aplicação: o agente o lê e guarda a versão.
    const politica = await cliente.lerRecurso("politica://uso", opcoes);
    task.politica = /^versao:\s*(\S+)/m.exec(politica)?.[1] ?? "desconhecida";

    const { result } = await cliente.chamarTool("reservar_sala", pedido, {}, opcoes);
    tratarResultado(task, result);
  } catch (e) {
    falhaMcp(task, e);
  }
}

async function continuar(task, texto) {
  const escolha = /^\s*escolha=(\S+)\s*$/.exec(texto)?.[1];
  const { chave, requestState, opcoes } = task.pausa;
  const repetir = () => mudarEstado(task, "TASK_STATE_INPUT_REQUIRED", `alternativas: ${opcoes.join(", ")}`);

  if (!escolha || (escolha !== "recusar" && !opcoes.includes(escolha))) return repetir();

  const resposta =
    escolha === "recusar" ? { action: "decline" } : { action: "accept", content: { sala: escolha } };
  const traceOpcoes = { traceId: task.traceId };

  mudarEstado(task, "TASK_STATE_WORKING");
  try {
    // >>> PONTE (A2A -> MCP): o mesmo tools/call, com id NOVO (o cliente gera um por request),
    // inputResponses com a mesma chave que veio no inputRequests e o requestState intacto.
    const { result } = await cliente.chamarTool(
      "reservar_sala",
      task.pedido,
      { inputResponses: { [chave]: resposta }, requestState },
      traceOpcoes,
    );
    tratarResultado(task, result);
  } catch (e) {
    falhaMcp(task, e);
  }
}

// --- métodos A2A -------------------------------------------------------------------------
export async function enviarMensagem(params, { traceId }) {
  const mensagem = params?.message;
  const texto = textoDe(mensagem);
  if (!mensagem || mensagem.role !== "ROLE_USER" || !texto) {
    throw new ErroA2A(PARAMS_INVALIDOS, "message com role ROLE_USER e uma parte de texto e obrigatoria");
  }

  // Continuação de uma Task existente.
  if (mensagem.taskId) {
    const task = tasks.get(mensagem.taskId);
    if (!task) throw new ErroA2A(TASK_NAO_ENCONTRADA, `Task nao encontrada: ${mensagem.taskId}`);
    if (TERMINAIS.has(task.estado)) {
      throw new ErroA2A(OPERACAO_NAO_SUPORTADA, `Task ${task.id} esta em ${task.estado} e nao aceita novas mensagens`);
    }
    if (task.estado !== "TASK_STATE_INPUT_REQUIRED" || !task.pausa) {
      throw new ErroA2A(OPERACAO_NAO_SUPORTADA, `Task ${task.id} nao esta aguardando entrada`);
    }
    if (traceId) task.traceId = traceId;
    task.historico.push({ ...mensagem, contextId: task.contextId });
    await continuar(task, texto);
    return { task: serializar(task) };
  }

  // Task nova: id e contextId próprios.
  const task = {
    id: id("task"),
    contextId: id("ctx"),
    estado: "TASK_STATE_SUBMITTED",
    historico: [],
    artefatos: [],
    traceId,
  };
  tasks.set(task.id, task);
  task.historico.push({ ...mensagem, taskId: undefined });

  const pedido = lerPedido(texto);
  if (!pedido) {
    mudarEstado(
      task,
      "TASK_STATE_FAILED",
      "Pedido invalido: use reservar sala=<id> inicio=<iso8601> fim=<iso8601> responsavel=<nome>",
    );
    return { task: serializar(task) };
  }
  task.pedido = pedido;
  mudarEstado(task, "TASK_STATE_WORKING");
  await iniciar(task, pedido);
  return { task: serializar(task) };
}

export function obterTask(params) {
  const task = tasks.get(params?.id);
  if (!task) throw new ErroA2A(TASK_NAO_ENCONTRADA, `Task nao encontrada: ${params?.id}`);
  return { task: serializar(task) };
}
