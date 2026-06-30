/**
 * Watcher do feature run — observa `.harness/runs/<id>/` e dispara onChange (debounced)
 * quando os ficheiros mudam, pro re-render ao vivo (docs/03-tui.md §3 "Live"). Combina
 * fs.watch (imediato) + poll de assinatura (mtimes) como fallback portável, e só emite
 * quando a assinatura realmente muda (evita redraws à toa).
 *
 * IO/timing — não é unit-testado; a lógica de assinatura é determinística e simples.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runDir } from "./handoff.ts";

export interface Watcher {
	close(): void;
}

const SIG_FILES = ["plan.json", "status.json", "feature-run.json", "progress_log.jsonl", "validation/delivery/record.json"];

/** Assinatura barata do run: mtimes dos ficheiros-chave + do dir handoffs. */
export function runSignature(cwd: string, featureId: string): string {
	const dir = runDir(cwd, featureId);
	let sig = "";
	for (const f of [...SIG_FILES, "handoffs"]) {
		try {
			sig += `${f}:${fs.statSync(path.join(dir, f)).mtimeMs};`;
		} catch {
			// ausente — entra na assinatura como vazio (mudança quando aparecer)
		}
	}
	return sig;
}

/**
 * Observa o run; chama onChange (debounced) só quando a assinatura muda. `close()` para tudo.
 * A assinatura inicial é capturada no start — então a 1ª emissão é da 1ª mudança real
 * (o caller faz o render inicial à parte).
 */
export function watchRun(cwd: string, featureId: string, onChange: () => void, opts: { debounceMs?: number; pollMs?: number } = {}): Watcher {
	const dir = runDir(cwd, featureId);
	const debounceMs = opts.debounceMs ?? 150;
	const pollMs = opts.pollMs ?? 1500;
	let lastSig = runSignature(cwd, featureId);
	let timer: ReturnType<typeof setTimeout> | undefined;
	let closed = false;

	const fire = (): void => {
		if (closed) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			if (closed) return;
			const sig = runSignature(cwd, featureId);
			if (sig !== lastSig) {
				lastSig = sig;
				onChange();
			}
		}, debounceMs);
	};

	const watchers: fs.FSWatcher[] = [];
	const tryWatch = (p: string, recursive: boolean): void => {
		try {
			watchers.push(fs.watch(p, { recursive }, fire));
		} catch {
			// dir inexistente / recursive não suportado — o poll cobre
		}
	};
	tryWatch(dir, true);
	tryWatch(path.join(dir, "handoffs"), false);
	const interval = setInterval(fire, pollMs);

	return {
		close() {
			closed = true;
			if (timer) clearTimeout(timer);
			clearInterval(interval);
			for (const w of watchers) {
				try {
					w.close();
				} catch {
					// já fechado
				}
			}
		},
	};
}
