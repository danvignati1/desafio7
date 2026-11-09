// Domínio das salas: dados em memória, política de uso e regra de alternativas.
// Deliberadamente simples: o foco do desafio é o protocolo, não o negócio.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DADOS = process.env.DADOS_DIR ? resolve(process.env.DADOS_DIR) : resolve(RAIZ, "dados");

export const SALAS = JSON.parse(readFileSync(resolve(DADOS, "salas.json"), "utf8"));
export const POLITICA_TEXTO = readFileSync(resolve(DADOS, "politica-de-uso.md"), "utf8");
export const POLITICA_VERSAO = POLITICA_TEXTO.split("\n", 1)[0].replace(/^versao:\s*/, "").trim();

// Reservas só em memória: nascem do JSON do starter e crescem durante a execução.
const reservas = JSON.parse(readFileSync(resolve(DADOS, "reservas.json"), "utf8"));

export const ERROS = {
  sala: (id) => `Sala inexistente: ${id}`,
  janela: "Fora da janela de uso: a politica permite reservas entre 08:00 e 20:00",
  duracao: "Duracao acima do limite: a politica permite no maximo 2 horas",
  intervalo: "Intervalo invalido: fim deve ser posterior a inicio",
  semAlternativas: "Sem alternativas disponiveis no intervalo",
};

const JANELA_INICIO_MIN = 8 * 60;
const JANELA_FIM_MIN = 20 * 60;
const DURACAO_MAX_MS = 2 * 60 * 60 * 1000;
const OFFSET_SP_MS = -3 * 60 * 60 * 1000; // horário de São Paulo (-03:00), fixo pela política

export function buscarSala(id) {
  return SALAS.find((s) => s.id === id);
}

export function listarReservas() {
  return reservas;
}

/** Minutos desde a meia-noite e a data (yyyy-mm-dd) de um instante, no relógio de São Paulo. */
function relogioSP(ms) {
  const d = new Date(ms + OFFSET_SP_MS);
  return { minutos: d.getUTCHours() * 60 + d.getUTCMinutes(), dia: d.toISOString().slice(0, 10) };
}

/**
 * Valida sala + intervalo + política, na ordem: sala, intervalo, janela, duração.
 * Devolve { erro } com a mensagem exata, ou { sala, ini, fim } em milissegundos.
 */
export function validar({ sala, inicio, fim }) {
  const registro = buscarSala(sala);
  if (!registro) return { erro: ERROS.sala(sala) };

  const ini = Date.parse(inicio);
  const fi = Date.parse(fim);
  if (Number.isNaN(ini) || Number.isNaN(fi) || fi <= ini) return { erro: ERROS.intervalo };

  const a = relogioSP(ini);
  const b = relogioSP(fi);
  const dentro =
    a.dia === b.dia &&
    a.minutos >= JANELA_INICIO_MIN &&
    a.minutos <= JANELA_FIM_MIN &&
    b.minutos >= JANELA_INICIO_MIN &&
    b.minutos <= JANELA_FIM_MIN;
  if (!dentro) return { erro: ERROS.janela };
  if (fi - ini > DURACAO_MAX_MS) return { erro: ERROS.duracao };

  return { sala: registro, ini, fim: fi };
}

/** Reservas da sala que se sobrepõem ao intervalo [ini, fim). */
export function conflitos(salaId, ini, fim) {
  return reservas.filter(
    (r) => r.sala === salaId && Date.parse(r.inicio) < fim && ini < Date.parse(r.fim),
  );
}

/**
 * Salas livres no intervalo com capacidade >= à da sala pedida (exceto ela mesma),
 * por capacidade crescente e, em empate, por id; no máximo três.
 */
export function alternativas(sala, ini, fim) {
  return SALAS.filter(
    (s) => s.id !== sala.id && s.capacidade >= sala.capacidade && conflitos(s.id, ini, fim).length === 0,
  )
    .sort((x, y) => x.capacidade - y.capacidade || x.id.localeCompare(y.id))
    .slice(0, 3)
    .map((s) => s.id);
}

export function criarReserva({ sala, inicio, fim, responsavel }) {
  const id = `res-${String(reservas.length + 1).padStart(4, "0")}`;
  reservas.push({ id, sala, inicio, fim, responsavel });
  return id;
}
