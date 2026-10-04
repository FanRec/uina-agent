from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from datetime import timedelta

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def run(args: argparse.Namespace) -> int:
    interpreter = args.python or sys.executable
    params = StdioServerParameters(command=interpreter, args=["-m", "uina_screen_mcp"], cwd=os.path.dirname(os.path.dirname(__file__)))
    async with stdio_client(params) as (read_stream, write_stream):
        async with ClientSession(read_stream, write_stream, read_timeout_seconds=timedelta(seconds=args.timeout)) as session:
            await session.initialize()
            if args.tool not in {tool.name for tool in (await session.list_tools()).tools}:
                print(f"tool not found: {args.tool}", file=sys.stderr)
                return 2
            if args.check_only and args.tool == "ListTargets":
                print("stdio handshake and tool discovery: ok")
                return 0
            result = await session.call_tool(args.tool, json.loads(args.args))
            status = "error" if result.isError else "ok"
            print(f"{args.tool}: {status}; contentBlocks={len(result.content)}; structured={result.structuredContent is not None}")
            return 1 if result.isError else 0


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--python")
    parser.add_argument("--tool", required=True)
    parser.add_argument("--args", default="{}")
    parser.add_argument("--check-only", action="store_true")
    parser.add_argument("--timeout", type=float, default=30)
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    raise SystemExit(main())
