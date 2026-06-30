/**
 * Live store do run card (cap. 09) — pi-free, testável. Um snapshot por feature em memória que
 * o watcher atualiza e que o renderer da mensagem custom (run-card-view.ts) lê a cada ciclo do
 * TUI. É o canal que faz o cartão no transcript "ticar" ao vivo sem reenviar a mensagem: o
 * watcher escreve aqui + dispara um render (via setStatus), e o componente relê o snapshot.
 */
import type { ControlModel } from "./control-model.ts";

const store = new Map<string, ControlModel | null>();

/** Publica/atualiza o snapshot vivo de um feature run. */
export function setRunModel(featureId: string, model: ControlModel | null): void {
	store.set(featureId, model);
}

/** Lê o snapshot vivo (null se ainda não publicado ou sem plan). */
export function getRunModel(featureId: string): ControlModel | null {
	return store.get(featureId) ?? null;
}

/** Esquece um feature run (ao sair do modo). */
export function clearRunModel(featureId: string): void {
	store.delete(featureId);
}
