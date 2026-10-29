/**
 * 测试用 TerminalUIContext 桩：W4 起 terminal 是可选 facet，无头 surface 不再伪造；
 * 需要终端契约的测试显式装配这个桩，并按需覆盖单个方法。
 */

import type { Component, OverlayHandle, TerminalUIContext } from "../../../src/extensions/ui-contract.js";

const NOOP_HANDLE: OverlayHandle = {
	hide() {},
	setHidden() {},
	requestRender() {},
	isHidden: () => true,
	focus() {},
	unfocus() {},
	isFocused: () => false,
};

const noopComponent: Component = { render: () => [] };

export function createTerminalStub(overrides: Partial<TerminalUIContext> = {}): TerminalUIContext {
	return {
		setWidget: () => {},
		setHeader: () => {},
		setFooter: () => {},
		showOverlay: () => NOOP_HANDLE,
		openGutter: () => false,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		registerMessageRenderer: () => () => {},
		registerToolRenderer: () => () => {},
		registerMarkdownTransformer: () => () => {},
		...overrides,
	};
}

export { noopComponent };
