import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";

/**
 * Show a selection dialog with descriptions. Falls back to the plain select dialog
 * (labels only) outside TUI mode (e.g. RPC).
 */
export async function pickFromList(
  ctx: ExtensionContext,
  title: string,
  items: SelectItem[],
  helpText = "↑↓ navigate • enter select • esc cancel",
): Promise<string | null> {
  if (items.length === 0) return null;

  if (ctx.mode !== "tui") {
    const choice = await ctx.ui.select(title, items.map((item) => item.label));
    if (choice === undefined) return null;
    return items.find((item) => item.label === choice)?.value ?? null;
  }

  return await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

    const selectList = new SelectList(items, Math.min(items.length, 12), {
      selectedPrefix: (t) => theme.fg("accent", t),
      selectedText: (t) => theme.fg("accent", t),
      description: (t) => theme.fg("muted", t),
      scrollInfo: (t) => theme.fg("dim", t),
      noMatch: (t) => theme.fg("warning", t),
    });
    selectList.onSelect = (item) => done(item.value);
    selectList.onCancel = () => done(null);
    container.addChild(selectList);

    container.addChild(new Text(theme.fg("dim", helpText), 1, 0));
    container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        selectList.handleInput(data);
        tui.requestRender();
      },
    };
  });
}
