from __future__ import annotations

from copy import deepcopy
from typing import Any, Literal

from jsonschema import Draft202012Validator
from mcp.types import Tool

JsonObject = dict[str, Any]
DEFAULT_MAX_DIMENSION = 1920
DEFAULT_MAX_NODES = 1200
DEFAULT_MAX_TEXT_CHARS = 500

LIST_TARGETS_DESCRIPTION = (
    "List displays and app windows for screenshots or semantic snapshots. Use when the target is unknown, an app has multiple windows, or a previous window ref expired. "
    "Returns display bounds and window refs, titles, apps, and states; it does not capture images, inspect UI trees, launch apps, or change focus. "
    "Reuse a returned ref within this server session; re-list after it expires. app matches the process/display name exactly, ignoring case; titleContains is a substring filter."
)
SCREENSHOT_DESCRIPTION = (
    "Capture a fast image of the desktop, display, region, or app window. Use for visual context; use Snapshot for text, controls, or scrolling state. "
    "No target means all displays; active_window selects the current foreground window once. Window capture defaults to surface (best-effort app rendering); "
    "visible explicitly captures screen pixels in the window bounds and may include occluders. Ambiguous app matches return candidates, never choose one silently. "
    "Does not launch, focus, restore, move, or interact. Region uses [left, top, right, bottom] in physical virtual-desktop pixels; negative origins are valid. "
    "Returns originalSize and outputSize; default uses a validated bounded long edge. maxDimension only downscales; set it to original for full resolution. "
    "Cursor inclusion is supported on desktop-pixel captures, not surface captures."
)
SNAPSHOT_DESCRIPTION = (
    "Inspect screenshot plus accessible text, controls, and scrolling state. Uses the same targets and capture modes as Screenshot; no target means all displays. "
    "Prefer a window target for focused app state. scope=page requires one browser window and reads its accessible page structure, not JavaScript DOM. "
    "includeImage=false reads semantics only. UIA/IA2 may be incomplete or unavailable. If any requested observation is usable, the result is normal with an explicit PARTIAL header for missing components; "
    "only invalid targets/requests or no usable observation are errors. Headers show source, failures, and truncation. Image sizing follows Screenshot, including maxDimension=original. "
    "maxNodes/maxTextChars can be raised or set to all; host output limits still apply. Element ids are local to this snapshot, not action handles. "
    "Does not click, type, scroll, launch, focus, restore, or move windows."
)

TARGET_SCHEMA: JsonObject = {
    "oneOf": [
        {"type": "object", "properties": {"kind": {"const": "desktop"}}, "required": ["kind"], "additionalProperties": False},
        {"type": "object", "properties": {"kind": {"const": "display"}, "id": {"type": "string", "minLength": 1}}, "required": ["kind", "id"], "additionalProperties": False},
        {"type": "object", "properties": {"kind": {"const": "region"}, "rect": {"type": "array", "items": {"type": "integer"}, "minItems": 4, "maxItems": 4}}, "required": ["kind", "rect"], "additionalProperties": False},
        {"type": "object", "properties": {"kind": {"const": "active_window"}}, "required": ["kind"], "additionalProperties": False},
        {
            "type": "object",
            "properties": {
                "kind": {"const": "window"}, "ref": {"type": "string", "minLength": 1},
                "match": {"type": "object", "properties": {"app": {"type": "string", "minLength": 1}, "titleContains": {"type": "string", "minLength": 1}}, "minProperties": 1, "additionalProperties": False},
            },
            "required": ["kind"], "oneOf": [{"required": ["ref"]}, {"required": ["match"]}], "additionalProperties": False,
        },
    ]
}

DIMENSION_SCHEMA = {"oneOf": [{"type": "integer", "minimum": 1}, {"const": "original"}]}
BUDGET_SCHEMA = {"oneOf": [{"type": "integer", "minimum": 1}, {"const": "all"}]}
LIST_SCHEMA: JsonObject = {
    "type": "object", "properties": {
        "kind": {"type": "string", "enum": ["all", "displays", "windows"], "default": "all"},
        "app": {"type": "string", "minLength": 1}, "titleContains": {"type": "string", "minLength": 1},
    }, "additionalProperties": False,
}

def observation_schema(kind: str | None = None) -> JsonObject:
    kind_schema: JsonObject = {"const": kind} if kind is not None else {"enum": ["targets", "screenshot", "snapshot"]}
    return {
        "type": "object",
        "properties": {
            "kind": kind_schema, "status": {"type": "string", "enum": ["ok", "partial", "failed"]},
            "error": {"type": ["object", "null"]}, "target": {"type": ["object", "array", "null"]},
            "startedAt": {"type": "string"}, "completedAt": {"type": "string"},
            "image": {"type": ["object", "null"]}, "semantics": {"type": ["object", "null"]},
            "targets": {"type": ["object", "null"]}, "warnings": {"type": "array"}, "diagnostics": {"type": "object"},
        },
        "required": ["kind", "status", "target", "startedAt", "completedAt", "warnings"],
        "additionalProperties": True,
    }


def _image_properties(default_max_dimension: int) -> JsonObject:
    return {
        "target": {"$ref": "#/$defs/Target", "default": {"kind": "desktop"}},
        "captureMode": {"type": "string", "enum": ["surface", "visible"], "default": "surface"},
        "includeCursor": {"type": "boolean", "default": False},
        "maxDimension": {**deepcopy(DIMENSION_SCHEMA), "default": default_max_dimension},
    }


def _tool_schema(properties: JsonObject) -> JsonObject:
    return {"type": "object", "$defs": {"Target": deepcopy(TARGET_SCHEMA)}, "properties": properties, "additionalProperties": False}


def build_tools(default_max_dimension: int = DEFAULT_MAX_DIMENSION) -> list[Tool]:
    if isinstance(default_max_dimension, bool) or not isinstance(default_max_dimension, int) or default_max_dimension < 1:
        raise ValueError("default_max_dimension must be a positive integer")
    screenshot_schema = _tool_schema(_image_properties(default_max_dimension))
    snapshot_properties = _image_properties(default_max_dimension)
    snapshot_properties.update({
        "includeImage": {"type": "boolean", "default": True},
        "scope": {"type": "string", "enum": ["window", "page"], "default": "window"},
        "maxNodes": {**deepcopy(BUDGET_SCHEMA), "default": DEFAULT_MAX_NODES},
        "maxTextChars": {**deepcopy(BUDGET_SCHEMA), "default": DEFAULT_MAX_TEXT_CHARS},
    })
    snapshot_schema = _tool_schema(snapshot_properties)
    tools = [
        Tool(name="ListTargets", description=LIST_TARGETS_DESCRIPTION, inputSchema=LIST_SCHEMA, outputSchema=observation_schema("targets")),
        Tool(name="Screenshot", description=SCREENSHOT_DESCRIPTION, inputSchema=screenshot_schema, outputSchema=observation_schema("screenshot")),
        Tool(name="Snapshot", description=SNAPSHOT_DESCRIPTION, inputSchema=snapshot_schema, outputSchema=observation_schema("snapshot")),
    ]
    for tool in tools:
        Draft202012Validator.check_schema(tool.inputSchema)
        Draft202012Validator.check_schema(tool.outputSchema or {})
    return tools


def _validate(tool_name: str, args: JsonObject, schema: JsonObject) -> JsonObject:
    if not isinstance(args, dict):
        raise ValueError("invalid_arguments: arguments must be an object")
    errors = sorted(Draft202012Validator(schema).iter_errors(args), key=lambda error: list(map(str, error.path)))
    if errors:
        error = errors[0]
        path = ".".join(map(str, error.absolute_path)) or "arguments"
        raise ValueError(f"invalid_arguments: {path}: {error.message}")
    result = deepcopy(args)
    if tool_name == "ListTargets":
        return result
    result.setdefault("target", {"kind": "desktop"})
    target_kind = result["target"]["kind"]
    if target_kind not in ("window", "active_window") and "captureMode" in args:
        raise ValueError("invalid_arguments: captureMode only applies to window targets")
    if tool_name == "Screenshot":
        result.setdefault("maxDimension", DEFAULT_MAX_DIMENSION)
        result.setdefault("includeCursor", False)
        if result.get("includeCursor") and target_kind in ("window", "active_window") and result.get("captureMode", "surface") == "surface":
            raise ValueError("invalid_arguments: captureMode=surface does not support cursor inclusion")
        return result
    result.setdefault("includeImage", True)
    result.setdefault("scope", "window")
    result.setdefault("maxDimension", DEFAULT_MAX_DIMENSION)
    result.setdefault("maxNodes", DEFAULT_MAX_NODES)
    result.setdefault("maxTextChars", DEFAULT_MAX_TEXT_CHARS)
    if result["scope"] == "page" and target_kind not in ("window", "active_window"):
        raise ValueError("scope_requires_window: page scope requires one window target")
    if result["includeImage"] is False and any(k in args for k in ("includeCursor", "maxDimension", "captureMode")):
        raise ValueError("invalid_arguments: image options cannot be used when includeImage is false")
    return result


def validate_arguments(tool_name: str, args: JsonObject) -> JsonObject:
    tools = {tool.name: tool for tool in build_tools()}
    if tool_name not in tools:
        raise ValueError(f"invalid_arguments: unknown tool {tool_name}")
    if tool_name == "ListTargets":
        result = _validate(tool_name, args, tools[tool_name].inputSchema)
        if result.get("kind", "all") == "displays" and any(k in result for k in ("app", "titleContains")):
            raise ValueError("invalid_arguments: app/titleContains cannot be combined with kind=displays")
        result.setdefault("kind", "all")
        return result
    return _validate(tool_name, args, tools[tool_name].inputSchema)


def aggregate_components(components: dict[str, JsonObject]) -> Literal["ok", "partial", "failed"]:
    requested = [component for component in components.values() if component.get("status") != "not_requested"]
    valid = [component for component in requested if component.get("valid") is True]
    if not valid:
        return "failed"
    if any(component.get("valid") is not True or component.get("status") != "ok" for component in requested):
        return "partial"
    return "ok"


