from __future__ import annotations

import base64
import binascii
from datetime import datetime, timezone
from typing import Any, Callable

from mcp.server.lowlevel import Server
from mcp.types import CallToolResult

from .contracts import aggregate_components, build_tools, validate_arguments
from .render import render_mcp
from .targets import TargetResolver
from .worker import QueryRunner


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _error_observation(kind: str, target: Any, code: str, message: str, stage: str) -> dict[str, Any]:
    now = _now()
    return {
        "kind": kind,
        "status": "failed",
        "error": {"code": code, "message": message, "stage": stage},
        "target": target,
        "startedAt": now,
        "completedAt": now,
        "warnings": [],
    }


def _error_stage(code: str) -> str:
    if code in {"invalid_arguments", "scope_requires_window", "target_not_found", "target_ambiguous", "stale_target", "invalid_region"}:
        return "resolve"
    if code in {"capture_unavailable", "capture_failed", "window_capture_failed", "cursor_not_supported"}:
        return "capture"
    if code in {"semantic_unavailable", "page_structure_unavailable"}:
        return "semantics"
    return "observe"


class ScreenService:
    """Own target refs and native query lifecycle for one MCP server session."""

    def __init__(
        self,
        runner: QueryRunner | Any | None = None,
        inventory_provider: Callable[[], Any] | None = None,
        default_max_dimension: int = 1920,
    ) -> None:
        self.runner = runner or QueryRunner()
        self.resolver = TargetResolver()
        self.inventory_provider = inventory_provider
        self.default_max_dimension = default_max_dimension

    async def _inventory_now(self) -> dict[str, Any]:
        if self.inventory_provider is not None:
            value = self.inventory_provider()
            value = await value if hasattr(value, "__await__") else value
            if not isinstance(value, dict):
                raise ValueError("target_inventory_failed: inventory provider returned no object")
            return value
        result = await self.runner.run("enumerate", {}, 5.0)
        if not result.get("ok"):
            error = result.get("error") or {}
            raise ValueError(f"{error.get('code', 'target_inventory_failed')}: {error.get('message', 'target enumeration failed')}")
        payload = result.get("payload")
        if not isinstance(payload, dict):
            raise ValueError("target_inventory_failed: worker returned no inventory")
        return payload

    async def call(self, name: str, args: dict[str, Any]) -> CallToolResult:
        try:
            normalized = validate_arguments(name, args)
        except ValueError as exc:
            return render_mcp(_error_observation(name.lower(), args.get("target"), "invalid_arguments", str(exc), "validation"))
        if name == "ListTargets":
            return await self._list_targets(normalized)
        if name not in {"Screenshot", "Snapshot"}:
            return render_mcp(_error_observation("unknown", None, "invalid_arguments", f"unknown tool {name}", "dispatch"))
        return await self._observe(name, normalized)

    async def _list_targets(self, args: dict[str, Any]) -> CallToolResult:
        started = _now()
        try:
            inventory = await self._inventory_now()
            kind = args.get("kind", "all")
            windows = list(inventory.get("windows", [])) if kind in {"all", "windows"} else []
            targets = {
                "displays": inventory.get("displays", []) if kind in {"all", "displays"} else [],
                "windows": windows,
                "virtualBounds": inventory.get("virtualBounds"),
            }
            for window in windows:
                if isinstance(window, dict):
                    try:
                        window["ref"] = self.resolver.remember_window(window)
                    except ValueError:
                        window["refUnavailable"] = "process creation identity unavailable"
            if args.get("app"):
                requested = str(args["app"]).casefold()
                targets["windows"] = [w for w in targets["windows"] if str(w.get("app", "")).casefold() == requested]
            if args.get("titleContains"):
                requested = str(args["titleContains"]).casefold()
                targets["windows"] = [w for w in targets["windows"] if requested in str(w.get("title", "")).casefold()]
            return render_mcp({"kind": "targets", "status": "ok", "target": {"kind": kind}, "startedAt": started, "completedAt": _now(), "targets": targets, "warnings": []})
        except Exception as exc:
            return render_mcp(_error_observation("targets", {"kind": args.get("kind", "all")}, "target_inventory_failed", str(exc), "enumerate"))

    async def _observe(self, name: str, args: dict[str, Any]) -> CallToolResult:
        started = _now()
        kind = "screenshot" if name == "Screenshot" else "snapshot"
        target_request = args["target"]
        observation: dict[str, Any] = {"kind": kind, "target": target_request, "startedAt": started, "warnings": []}
        try:
            inventory = await self._inventory_now()
            resolved = self.resolver.resolve(target_request, inventory)
            observation["target"] = {key: value for key, value in resolved.items() if key not in {"hwnd", "processCreatedAt"}}
            components: dict[str, dict[str, Any]] = {}
            include_image = name == "Screenshot" or args.get("includeImage", True)
            png: bytes | None = None
            if include_image:
                bounds = resolved.get("bounds")
                if not isinstance(bounds, list):
                    raise ValueError("capture_unavailable: target has no capture bounds")
                capture_payload = {"bounds": bounds, "maxDimension": args.get("maxDimension", self.default_max_dimension), "includeCursor": args.get("includeCursor", False)}
                if resolved.get("kind") == "window":
                    capture_payload.update({"hwnd": resolved.get("hwnd"), "captureMode": args.get("captureMode", "surface")})
                result = await self.runner.run("capture", capture_payload, 5.0)
                if result.get("ok") and isinstance(result.get("payload"), dict):
                    payload = result["payload"]
                    raw = payload.get("pngBase64")
                    image = payload.get("image")
                    try:
                        if not isinstance(image, dict) or image.get("status") != "ok" or image.get("valid") is not True:
                            raise ValueError("capture_failed: worker returned an invalid image component")
                        if not isinstance(raw, str) or not raw:
                            raise ValueError("capture_failed: worker returned no PNG bytes")
                        png = base64.b64decode(raw, validate=True)
                        if not png:
                            raise ValueError("capture_failed: worker returned an empty PNG")
                        components["image"] = image
                    except (ValueError, binascii.Error) as exc:
                        png = None
                        components["image"] = {"status": "failed", "valid": False, "errors": [{"code": "capture_failed", "message": str(exc)}]}
                    observation["image"] = components["image"]
                else:
                    error = result.get("error") or {"code": "capture_failed", "message": "capture returned no image"}
                    components["image"] = {"status": "failed", "valid": False, "errors": [error]}
                    observation["image"] = components["image"]
            else:
                components["image"] = {"status": "not_requested", "valid": False}
                observation["image"] = components["image"]

            if name == "Snapshot":
                semantics_operation = "page" if args.get("scope") == "page" else "semantics"
                if resolved.get("kind") not in {"window", "active_window"}:
                    if semantics_operation == "page":
                        raise ValueError("scope_requires_window: page scope requires one window target")
                    # Desktop/display/region targets have pixels but no HWND.
                    # Report the missing semantic component as partial instead of
                    # passing None into the native worker.
                    components["semantics"] = {
                        "status": "unavailable",
                        "valid": False,
                        "errors": [{
                            "code": "semantic_requires_window",
                            "message": "accessible semantics require a window target",
                        }],
                    }
                else:
                    result = await self.runner.run(semantics_operation, {"hwnd": resolved.get("hwnd"), "bounds": resolved.get("bounds"), "options": args}, 10.0)
                    if result.get("ok") and isinstance(result.get("payload"), dict):
                        components["semantics"] = {"status": "ok", "valid": True, **result["payload"]}
                    else:
                        error = result.get("error") or {"code": "semantic_unavailable", "message": "accessible tree unavailable"}
                        components["semantics"] = {"status": "unavailable", "valid": False, "errors": [error]}
                observation["semantics"] = components["semantics"]
            else:
                components["semantics"] = {"status": "not_requested", "valid": False}
            observation["status"] = aggregate_components(components)
            observation["completedAt"] = _now()
            return render_mcp(observation, png)
        except ValueError as exc:
            code = str(exc).split(":", 1)[0]
            return render_mcp(_error_observation(kind, observation.get("target"), code, str(exc), _error_stage(code)))
        except Exception as exc:
            return render_mcp(_error_observation(kind, observation.get("target"), "observation_failed", str(exc), "observe"))

    async def close(self) -> None:
        await self.runner.close()


def build_server(service: ScreenService | None = None) -> Server:
    owned_service = service or ScreenService()
    server = Server("uina-screen-mcp", version="0.1.0", instructions="This server only observes Windows displays and windows; it never operates the desktop.")
    server.screen_service = owned_service  # type: ignore[attr-defined]

    @server.list_tools()
    async def list_tools() -> list[Any]:
        return build_tools(owned_service.default_max_dimension)

    @server.call_tool(validate_input=False)
    async def call_tool(name: str, arguments: dict[str, Any]) -> CallToolResult:
        return await owned_service.call(name, arguments)

    return server
