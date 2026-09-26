export type GutterMode = "scrollbar" | "timeline";
export type GutterThumbStyle = "slim" | "block" | "wide";

export interface GutterAction {
	mode: GutterMode;
	style?: GutterThumbStyle;
	message: string;
}

const THUMB_STYLES: readonly GutterThumbStyle[] = ["slim", "block", "wide"];
const GUTTER_MODES: readonly GutterMode[] = ["scrollbar", "timeline"];
const STYLE_LABEL: Record<GutterThumbStyle, string> = {
	slim: "纤细优雅 ( ▐)", block: "单列方块 ( █)", wide: "双列宽方块 (██)",
};
const MODE_LABEL: Record<GutterMode, string> = {
	scrollbar: "视口比例滚动条 (Scrollbar)", timeline: "时间线轮次轨 (Timeline)",
};

function isThumbStyle(value: string | undefined): value is GutterThumbStyle {
	return (THUMB_STYLES as readonly (string | undefined)[]).includes(value);
}

function isGutterMode(value: string | undefined): value is GutterMode {
	return (GUTTER_MODES as readonly (string | undefined)[]).includes(value);
}

export function resolveGutterAction(arg: string | undefined, currentMode: GutterMode): GutterAction {
	const [first, second] = arg?.trim().toLowerCase().split(/\s+/) ?? [];
	if (isThumbStyle(first)) return { mode: "scrollbar", style: first, message: `已切换滚动条滑块样式为: ${STYLE_LABEL[first]}` };
	if (isGutterMode(first)) {
		const style = first === "scrollbar" && isThumbStyle(second) ? second : undefined;
		return { mode: first, style, message: `已切换右侧导航轨为: ${MODE_LABEL[first]}${second ? ` [${second}]` : ""}` };
	}
	const next: GutterMode = currentMode === "scrollbar" ? "timeline" : "scrollbar";
	return { mode: next, message: `已切换右侧导航轨为: ${MODE_LABEL[next]}` };
}
