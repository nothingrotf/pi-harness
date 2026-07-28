/**
 * Preflight de portas — torna visível, no INÍCIO do run, o conflito que hoje só aparece como um
 * gate vermelho enigmático horas depois.
 *
 * O incidente, repetido: outro projeto na mesma máquina segura a porta que um serviço declarado
 * precisa (`belavista-minio` em :9000, `spice-target` postgres/redis em 5434/6380). O serviço do
 * repo nunca liga, e a suíte falha com um erro que não menciona porta nenhuma — um MinIO alheio
 * responde 403 em vez de recusar a conexão. Nas runs reais: 14 menções de colisão de porta e 25 de
 * "gate rodou sem os serviços", cada uma delas abortando o review inteiro antes dos três eixos
 * (§0 do harness-code-review aborta em gate vermelho).
 *
 * `services.yaml` já declara `port:` por serviço. Aqui só lemos isso e perguntamos ao SO quem está
 * escutando — nada é iniciado, parado ou adivinhado. O julgamento ("é meu ou é de outro projeto?")
 * fica com o modelo, que tem os `notes`/`healthcheck` do serviço; o determinismo é ter o FATO.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface ServicePort {
	service: string;
	port: number;
}

export function servicesYamlPath(cwd: string): string {
	return path.join(cwd, ".harness", "profile", "services.yaml");
}

/**
 * Extrai `<serviço> → port` do bloco `services:` do services.yaml.
 *
 * Parse por indentação, sem dependência de YAML: o arquivo é autorado pelo harness-setup num
 * formato fixo (`services:` → chave do serviço em 2 espaços → campos em 4). Robusto o bastante
 * para o que precisa (nome + porta) e imune a comentários e campos livres em volta.
 */
export function parseServicePorts(yaml: string): ServicePort[] {
	const out: ServicePort[] = [];
	let inServices = false;
	let current: string | undefined;
	for (const raw of yaml.split("\n")) {
		const line = raw.replace(/\s+$/, "");
		if (!line.trim() || line.trim().startsWith("#")) continue;
		if (/^services:\s*$/.test(line)) {
			inServices = true;
			current = undefined;
			continue;
		}
		if (/^[A-Za-z_][\w-]*:/.test(line)) {
			// outra chave de topo → saiu do bloco services
			inServices = false;
			current = undefined;
			continue;
		}
		if (!inServices) continue;
		const svc = /^ {2}([A-Za-z_][\w-]*):\s*$/.exec(line);
		if (svc) {
			current = svc[1];
			continue;
		}
		const port = /^ {4}port:\s*"?(\d{2,5})"?\s*(?:#.*)?$/.exec(line);
		if (port && current) out.push({ service: current, port: Number(port[1]) });
	}
	return out;
}

export function readServicePorts(cwd: string): ServicePort[] {
	try {
		return parseServicePorts(fs.readFileSync(servicesYamlPath(cwd), "utf8"));
	} catch {
		return [];
	}
}

export interface PortStatus extends ServicePort {
	/** true se ALGUÉM está escutando nessa porta TCP agora. */
	listening: boolean;
	/** comando do processo que escuta (ex.: "com.docke", "node") — vazio quando livre/indeterminado. */
	owner?: string;
}

/** Quem escuta cada porta TCP, via lsof. Sem lsof / erro → mapa vazio (nunca lança). */
export function portListeners(ports: number[]): Map<number, string> {
	const found = new Map<number, string>();
	if (ports.length === 0) return found;
	try {
		const spec = ports.map((p) => `-iTCP:${p}`).join(" ");
		const out = execFileSync("bash", ["-c", `lsof -nP ${spec} -sTCP:LISTEN -FcPn 2>/dev/null || true`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 });
		let cmd = "";
		for (const line of out.split("\n")) {
			if (line.startsWith("c")) cmd = line.slice(1).trim();
			else if (line.startsWith("n")) {
				const m = /:(\d{2,5})$/.exec(line.slice(1).trim());
				if (m) {
					const p = Number(m[1]);
					if (ports.includes(p) && !found.has(p)) found.set(p, cmd);
				}
			}
		}
	} catch {
		/* sem lsof (ou negado): degrada pra "não sei", nunca falha o run */
	}
	return found;
}

/** Estado de cada porta declarada no services.yaml. */
export function preflightPorts(cwd: string): PortStatus[] {
	const declared = readServicePorts(cwd);
	const listeners = portListeners(declared.map((d) => d.port));
	return declared.map((d) => ({ ...d, listening: listeners.has(d.port), owner: listeners.get(d.port) }));
}

/** Duas ou mais entradas do services.yaml apontando pra MESMA porta — erro de autoria. */
export function duplicatePorts(ports: ServicePort[]): number[] {
	const seen = new Map<number, number>();
	for (const p of ports) seen.set(p.port, (seen.get(p.port) ?? 0) + 1);
	return [...seen.entries()].filter(([, n]) => n > 1).map(([p]) => p);
}

/** Linha única pro log/notify. `undefined` quando não há nada a dizer. */
export function preflightSummary(statuses: PortStatus[]): string | undefined {
	if (statuses.length === 0) return undefined;
	const busy = statuses.filter((s) => s.listening);
	if (busy.length === 0) return `ports: all ${statuses.length} declared service ports are free (nothing started yet)`;
	return `ports in use: ${busy.map((s) => `${s.service}:${s.port}${s.owner ? ` (${s.owner})` : ""}`).join(", ")}`;
}
