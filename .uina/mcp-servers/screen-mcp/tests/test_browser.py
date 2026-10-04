from __future__ import annotations

import pytest

from uina_screen_mcp.browser import read_page_semantics
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
