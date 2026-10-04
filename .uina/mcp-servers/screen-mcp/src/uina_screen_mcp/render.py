from __future__ import annotations

import base64
from typing import Any

from mcp.types import CallToolResult, ImageContent, TextContent

from jsonschema import Draft202012Validator

from .contracts import JsonObject, observation_schema


def _format_rect(value: Any) -> str:
    if isinstance(value, (list, tuple)) and len(value) == 4:
        return "[" + ", ".join(str(part) for part in value) + "]"
    return "unknown"


def observation_text(observation: JsonObject) -> str:
    status = str(observation.get("status", "failed")).upper()
    lines = [f"Observation: {status}"]
    target = observation.get("target")
    if isinstance(target, dict):
        lines.append("Target: " + ", ".join(f"{k}={v}" for k, v in target.items() if v is not None))
    elif target is not None:
        lines.append(f"Target: {target}")
    image = observation.get("image")
    if isinstance(image, dict):
        fields = [f"Image: {str(image.get('status', 'unknown')).upper()}"]
        for key in ("surface", "bounds", "originalSize", "outputSize", "source"):
            if key in image and image[key] is not None:
                value = _format_rect(image[key]) if key == "bounds" else image[key]
                fields.append(f"{key}={value}")
        if image.get("clipped"):
            fields.append("clipped=true")
        lines.append(" · ".join(fields))
    semantics = observation.get("semantics")
    if isinstance(semantics, dict):
        fields = [f"Semantics: {str(semantics.get('status', 'unknown')).upper()}"]
        for key in ("scope", "source", "nodesVisited", "nodesReturned", "nodeTruncated", "textTruncated"):
            if key in semantics:
                fields.append(f"{key}={semantics[key]}")
        lines.append(" · ".join(fields))
        for item in semantics.get("elements", []):
            if not isinstance(item, dict):
                continue
            fields = [str(item.get("id", "element")), str(item.get("role", "unknown"))]
            for key in ("name", "bounds", "value"):
                if item.get(key) is not None:
                    value = _format_rect(item[key]) if key == "bounds" else item[key]
                    fields.append(f"{key}={value}")
            lines.append("  " + " · ".join(fields))
    for warning in observation.get("warnings", []):
        if isinstance(warning, dict):
            lines.append(f"Warning: {warning.get('code', 'warning')} — {warning.get('message', '')}".rstrip())
        else:
            lines.append(f"Warning: {warning}")
    for component_name in ("image", "semantics"):
        component = observation.get(component_name)
        if isinstance(component, dict):
            for error in component.get("errors", []):
                if isinstance(error, dict):
                    lines.append(f"{component_name.title()} {error.get('code', 'error')}: {error.get('message', '')}".rstrip())
    error = observation.get("error")
    if isinstance(error, dict):
        lines.append(f"Error: {error.get('code', 'failed')} — {error.get('message', '')}".rstrip())
        if error.get("nextAction"):
            lines.append(f"Next: {error['nextAction']}")
    if status == "PARTIAL":
        lines.append("The usable observation is retained; missing or truncated requested components are identified above.")
    return "\n".join(lines)


def render_mcp(observation: JsonObject, png: bytes | None = None) -> CallToolResult:
    Draft202012Validator(observation_schema()).validate(observation)
    content: list[Any] = [TextContent(type="text", text=observation_text(observation))]
    if png is not None:
        content.append(ImageContent(type="image", data=base64.b64encode(png).decode("ascii"), mimeType="image/png"))
    return CallToolResult(content=content, structuredContent=observation, isError=observation.get("status") == "failed")
