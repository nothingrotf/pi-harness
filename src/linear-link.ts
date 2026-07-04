/**
 * Linear/Jira issue-link extractor — porte fiel do `extractLinkedIssueMetadata` do
 * droid (doc `09-linear-integration.md` §4.1), estendido com um scan conservador de
 * chaves "cruas" no nome da branch e nos subjects dos commits (droid-style scrape:
 * branch + commits + corpo do PR).
 *
 * Usado pela skill `harness-deliver` no ship gate: dado o estado do git/PR, resolve
 * qual issue do Linear (ou Jira) está vinculada ao PR, para montar o corpo e alimentar
 * a analytics. Lógica PURA (sem git/gh/IO) — o CLI no fim só lê stdin e imprime JSON.
 *
 * Autoridade das fontes:
 *  - URLs `linear.app/<ws>/issue/<ID>` → Linear (autoritativo).
 *  - URLs `<site>/browse/<KEY>` com KEY `^[A-Z][A-Z0-9_]*-\d+$` → Jira (autoritativo).
 *  - Chaves cruas (`ENG-123`) em branch/commit subject → Linear CANDIDATO (a convenção
 *    de branch do Linear é `user/eng-123-slug`). Ambíguo com Jira sem a URL `/browse/`,
 *    por isso é candidato — a skill confirma antes de usar.
 */

export interface LinkedIssueInput {
	/** Corpo do PR (scrapeado por URLs, igual ao droid). */
	prBody?: string;
	/** Nome da branch (ex.: `gabriel/eng-123-fix-foo`) — scan de chave crua. */
	branch?: string;
	/** Subjects de commit (1ª linha) — scan de chave crua. */
	commits?: string[];
	/** Feature id do harness (ex.: `work-on-linear-issue-adm-84-...`) — encoda a issue → scan de chave crua. */
	featureId?: string;
	/** Params explícitos (do caller), igual ao droid. */
	linkedTicketUrls?: string[];
	linearIssueIds?: string[];
	jiraIssueKeys?: string[];
}

export interface LinkedIssueMetadata {
	/** IDs de issue do Linear (ex.: `ENG-123`), deduplicados. */
	linearIssueIds: string[];
	/** Keys de issue do Jira (ex.: `PROJ-45`), deduplicados. */
	jiraIssueKeys: string[];
	/** URLs canônicas (`origin+pathname`) dos tickets linkados. */
	linkedTicketUrls: string[];
	/** Chaves cruas achadas em branch/commit que NÃO viraram link autoritativo — a skill confirma. */
	candidateKeys: string[];
}

const TICKET_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
const BARE_KEY = /\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})\b/g;
const URL_RE = /https?:\/\/[^\s<>)\]]+/g;
const TRAILING_PUNCT = /[.,;:!?]+$/;

/** Tokens comuns que casam `XXX-\d+` mas NÃO são issue keys (evita falso-positivo no scan cru). */
const NON_ISSUE_PREFIXES = new Set([
	"UTF", "SHA", "BASE", "ISO", "RFC", "IPV", "MD", "CVE", "ES", "EC", "AES", "PBKDF2",
	"RC", "STEP", "ISSUE", "X86", "ARM", "GPT", "HTTP", "TCP", "UDP", "PART", "PHASE", "FIX", "WP",
]);

/** Prefixo passível de ser team key: ≥2 letras no início — `v2-1`, `q3-2024` e afins (letra única
 * + dígitos) não são issue keys. Lowercase É aceite: branches/feature ids normalizam pra minúsculas
 * (`user/eng-123-slug` → ENG-123). */
function plausibleTeamPrefix(raw: string): boolean {
	return /^[A-Za-z]{2,}/.test(raw);
}

/** Normaliza uma URL para `origin+pathname` (sem query/fragment/pontuação final). `undefined` se não parseável. */
function canonicalUrl(raw: string): { canonical: string; url: URL } | undefined {
	const stripped = raw.replace(TRAILING_PUNCT, "");
	if (!URL.canParse(stripped)) return undefined;
	const url = new URL(stripped);
	return { canonical: `${url.origin}${url.pathname}`, url };
}

/** Scan de chaves cruas (`ENG-123`) num texto livre. Retorna keys UPPER deduplicadas, filtrando ruído. */
export function scanBareKeys(text: string | undefined): string[] {
	if (!text) return [];
	const out = new Set<string>();
	for (const m of text.matchAll(BARE_KEY)) {
		if (!plausibleTeamPrefix(m[1])) continue;
		const prefix = m[1].toUpperCase();
		if (NON_ISSUE_PREFIXES.has(prefix)) continue;
		out.add(`${prefix}-${m[2]}`);
	}
	return [...out];
}

/**
 * Porte do `extractLinkedIssueMetadata` do droid + scan de branch/commits.
 * Linear via `linear.app/.../issue/<ID>`; Jira via `.../browse/<KEY>`.
 */
export function extractLinkedIssueMetadata(input: LinkedIssueInput): LinkedIssueMetadata {
	const linearIds = new Set<string>(input.linearIssueIds ?? []);
	const jiraKeys = new Set<string>(input.jiraIssueKeys ?? []);
	const urls = new Set<string>();
	const candidates = new Set<string>();

	// Params explícitos: normaliza as URLs fornecidas pelo caller.
	for (const raw of input.linkedTicketUrls ?? []) {
		const c = canonicalUrl(raw);
		if (c) urls.add(c.canonical);
	}

	// Scrape do corpo do PR por URLs (autoritativo p/ Linear vs Jira).
	for (const raw of input.prBody?.match(URL_RE) ?? []) {
		const c = canonicalUrl(raw);
		if (!c) continue;
		const parts = c.url.pathname.split("/").filter(Boolean);

		const issueIdx = parts.findIndex((p) => p.toLowerCase() === "issue");
		const linearId = c.url.hostname === "linear.app" && issueIdx >= 0 ? parts[issueIdx + 1] : undefined;
		if (linearId) {
			linearIds.add(linearId.toUpperCase());
			urls.add(c.canonical);
			continue;
		}

		const browseIdx = parts.findIndex((p) => p.toLowerCase() === "browse");
		const key = browseIdx >= 0 ? parts[browseIdx + 1] : undefined;
		if (key && TICKET_KEY.test(key)) {
			jiraKeys.add(key);
			urls.add(c.canonical);
		}
	}

	// Scan cru de branch + commit subjects + feature id → candidatos Linear (convenção
	// `user/eng-123-slug` na branch; `work-on-linear-issue-adm-84-...` no feature id do harness).
	for (const key of [...scanBareKeys(input.branch), ...scanBareKeys(input.featureId), ...input.commits?.flatMap((c) => scanBareKeys(c)) ?? []]) {
		if (linearIds.has(key) || jiraKeys.has(key)) continue;
		candidates.add(key);
	}

	return {
		linearIssueIds: [...linearIds],
		jiraIssueKeys: [...jiraKeys],
		linkedTicketUrls: [...urls],
		candidateKeys: [...candidates],
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI: lê um JSON `LinkedIssueInput` de stdin e imprime `LinkedIssueMetadata`.
// Uso (na skill harness-deliver):
//   printf '%s' "$JSON" | node --experimental-strip-types src/linear-link.ts
// onde $JSON = { branch, commits: [...], prBody }.

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
	const raw = (await readStdin()).trim();
	let input: LinkedIssueInput = {};
	if (raw) {
		try {
			input = JSON.parse(raw) as LinkedIssueInput;
		} catch {
			process.stderr.write("linear-link: stdin não é JSON válido\n");
			process.exit(2);
		}
	}
	process.stdout.write(`${JSON.stringify(extractLinkedIssueMetadata(input), null, 2)}\n`);
}

// Só roda como CLI quando invocado direto (não em import/test).
if (import.meta.url === `file://${process.argv[1]}`) {
	void main();
}
