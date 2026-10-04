from __future__ import annotations

import asyncio

from mcp.server.stdio import stdio_server

from .server import build_server


async def _run() -> None:
    server = build_server()
    async with stdio_server() as (read_stream, write_stream):
        try:
            await server.run(read_stream, write_stream, server.create_initialization_options())
        finally:
            # The low-level Server owns the protocol streams; service cleanup is
            # explicit so workers cannot outlive an orderly stdio shutdown.
            await server.screen_service.close()  # type: ignore[attr-defined]


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
