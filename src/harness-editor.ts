/**
 * Editor recolorido pro modo harness. Reusa o CustomEditor do Pi e só troca
 * o `borderColor` do EditorTheme — o knob de cor da borda do input.
 *
 * ponytail: precisa de smoke test ao vivo (não dá pra rodar o TUI do Pi aqui).
 * Se o CustomEditor não estiver exportado nesta versão do Pi, o badge aboveEditor
 * (sinal primário) continua funcionando sozinho — este é o reforço.
 */
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorFactory } from "@earendil-works/pi-coding-agent";
import type { EditorTheme } from "@earendil-works/pi-tui";

/**
 * Fábrica pra `ctx.ui.setEditorComponent(...)`. `tint` recolore a borda
 * (use ctx.ui.theme.fg("accent", s)). Passe `undefined` ao setEditorComponent
 * pra restaurar o editor padrão ao sair do modo.
 */
export function harnessEditorFactory(tint: (s: string) => string): EditorFactory {
	return (tui, theme: EditorTheme, keybindings) => {
		const tinted: EditorTheme = { ...theme, borderColor: (s: string) => tint(s) };
		return new CustomEditor(tui, tinted, keybindings);
	};
}
