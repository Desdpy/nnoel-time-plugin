"""Time plugin entry point.

Exposes the :class:`TimePlugin` instance as ``plugin`` so the registry's
``importlib.import_module("plugins.time.plugin")`` can pick it up.
All wiring (tool handler, custom router, system-prompt fragment, frontend
manifest) is colocated here so the backend half of the plugin is a
self-contained package at ``backend/plugins/time/``. The frontend half
lives at ``frontend/src/plugins/time/``; the two are paired by the
shared ``id = "time"``.
"""

from fastapi import APIRouter

from .timezones import _TIMEZONE_MAP
from .tool import SCHEMA, run

router = APIRouter()


@router.get("/timezones/locations")
def list_location_suggestions() -> dict[str, list[str]]:
    """List the location strings the time tool can resolve.

    Used by the Time panel's autocomplete to surface suggestions while the
    user is typing. Each entry is a single location string (country,
    continent, city, or alias) :func:`.timezones.resolve` understands.
    Returned sorted (case-insensitive) so the frontend can render without
    a second pass.
    """
    return {"locations": sorted(_TIMEZONE_MAP.keys(), key=str.lower)}


# System-prompt fragment for the time tool: the MUST-call rule and the
# two few-shot examples that teach the model the two argument shapes
# (no-arg "local time" and location-arg "time in <city>"). Kept verbatim
# from the original ``config.toml`` so the model's behaviour is unchanged.
SYSTEM_PROMPT = """\
2. For ANY time, date, or day question, you MUST call the get_local_time tool. Never invent a time, date, or day.

User: What time is it?
Nnoel: <|tool_call>call:get_local_time{}<tool_call|>
<|tool_response>response:get_local_time{value:<|"|>2026-06-19 17:55:50<|"|>}<tool_response|>
It is 5:55 PM on Friday here.

User: What time is it in Tokyo?
Nnoel: <|tool_call>call:get_local_time{location: <|"|>Tokyo<|"|>}<tool_call|>
<|tool_response>response:get_local_time{value:<|"|>2026-06-20 06:55:50 JST<|"|>}<tool_response|>
It is 6:55 AM on Saturday in Tokyo."""


class TimePlugin:
    """Backend half of the time plugin.

    Paired with the frontend half at ``frontend/src/plugins/time/index.ts``;
    the shared ``id = "time"`` and the ``panel_component = "timePanel"``
    hook the two sides together at runtime (frontend registry discovers
    the TSX at build time; backend registry imports this module at
    server start).
    """

    id = "time"
    tools = [{"schema": SCHEMA, "run": run}]
    router = router
    system_prompt = SYSTEM_PROMPT
    frontend = {
        "panel_component": "timePanel",
        "panel_spec": {
            "id": "time",
            "component": "timePanel",
            "title": "Time",
            "floating": {"width": 360, "height": 360},
        },
        "taskbar": {
            "id": "time",
            "label": "Time",
            "icon": "clock",
            "toolName": "get_local_time",
        },
    }


plugin = TimePlugin()
