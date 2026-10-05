from __future__ import annotations

import pytest

from uina_screen_mcp.browser import _discover_page_roots, read_page_semantics
from uina_screen_mcp.ia2 import _role_name


def test_page_root_ambiguous_is_unavailable() -> None:
    with pytest.raises(RuntimeError, match="page_root_ambiguous"):
        read_page_semantics(1, None, {"pageRoots": [{"id": "a"}, {"id": "b"}]})


def test_no_root_does_not_return_browser_chrome() -> None:
    with pytest.raises(RuntimeError, match="no accessible page root"):
        read_page_semantics(1, None, {})


def test_page_source_and_scope_are_explicit() -> None:
    result = read_page_semantics(1, None, {"source": "browser_msaa_ia2", "pageRoots": [{"id": "page", "role": "document"}]})
    assert result["source"] == "browser_msaa_ia2"
    assert result["scope"] == "page"


def test_ia2_unknown_role_and_scroll_are_truthful() -> None:
    assert _role_name(0x7FFF) == "unknown"
    result = read_page_semantics(1, None, {"source": "browser_msaa_ia2", "pageRoots": [{"id": "page", "role": "document"}]})
    assert result["elements"] == [{"id": "page", "parentId": None, "role": "document", "scroll": {"horizontal": None, "vertical": None}}]


class FakeControl:
    def __init__(self, runtime_id: tuple[int, ...], class_name: str = "", children: list["FakeControl"] | None = None) -> None:
        self._runtime_id = runtime_id
        self.ClassName = class_name
        self._children = children or []

    def GetRuntimeId(self) -> tuple[int, ...]:
        return self._runtime_id

    def GetChildren(self) -> list["FakeControl"]:
        return list(self._children)


def test_browser_discovery_uses_runtime_id_and_keeps_wrappers_alive() -> None:
    page = FakeControl((3,), "Chrome_RenderWidgetHostHWND")
    # Every call returns fresh wrappers for the same runtime ids, reproducing
    # uiautomation's behavior without relying on Python id reuse timing.
    class FreshChildren(FakeControl):
        def GetChildren(self) -> list[FakeControl]:
            return [FakeControl((3,), "Chrome_RenderWidgetHostHWND")]

    root = FreshChildren((1,), "Chrome_WidgetWin_1", [page])
    assert _discover_page_roots(root)[0].ClassName == "Chrome_RenderWidgetHostHWND"


def test_browser_discovery_ignores_generic_document_nodes() -> None:
    chrome = FakeControl((2,), "Chrome_RenderWidgetHostHWND")
    generic = FakeControl((3,), "WebView")
    root = FakeControl((1,), "Chrome_WidgetWin_1", [generic, chrome])

    roots = _discover_page_roots(root)

    assert roots == [chrome]
