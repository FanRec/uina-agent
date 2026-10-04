from __future__ import annotations

import asyncio
from datetime import timedelta
from pathlib import Path

import pytest
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


@pytest.mark.asyncio
async def test_stdio_lists_exact_contracts() -> None:
    root = Path(__file__).parents[1]
    params = StdioServerParameters(command=str(root / ".venv" / "Scripts" / "python.exe"), args=["-m", "uina_screen_mcp"], cwd=str(root))
    async with stdio_client(params) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream, read_timeout_seconds=timedelta(seconds=5)) as session:
            await session.initialize()
            result = await session.list_tools()
            assert [tool.name for tool in result.tools] == ["ListTargets", "Screenshot", "Snapshot"]
