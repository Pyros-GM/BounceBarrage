# /// script
# requires-python = ">=3.10"
# dependencies = ["mcp>=1.2"]
# ///
"""
Godot MCP server.

Bridges an MCP client (Claude Desktop, Claude Code, ...) to the Godot editor.
The Godot side is the `addons/godot_mcp` editor plugin, which listens on
127.0.0.1:6550 and speaks newline-delimited JSON.

Run:  uv run godot_mcp_server.py      (or: pip install mcp && python godot_mcp_server.py)

Environment variables:
  GODOT_MCP_HOST   default 127.0.0.1
  GODOT_MCP_PORT   default 6550
  GODOT_MCP_TOKEN  optional; must match the project setting godot_mcp/auth_token
"""

from __future__ import annotations

import asyncio
import base64
import itertools
import json
import os
from typing import Any

try:  # mcp >= 2.0
    from mcp.server.mcpserver import Image, MCPServer as _Server
    from mcp.server.mcpserver.exceptions import ToolError as _ToolError
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as _Server, Image  # type: ignore
    from mcp.server.fastmcp.exceptions import ToolError as _ToolError  # type: ignore

HOST = os.environ.get("GODOT_MCP_HOST", "127.0.0.1")
PORT = int(os.environ.get("GODOT_MCP_PORT", "6550"))
TOKEN = os.environ.get("GODOT_MCP_TOKEN", "")
TIMEOUT = float(os.environ.get("GODOT_MCP_TIMEOUT", "30"))


class GodotError(_ToolError):
    """Errors whose message should reach the model (bad path, editor not running, ...)."""


class GodotConnection:
    """One persistent TCP connection to the editor plugin, reconnecting on demand."""

    def __init__(self) -> None:
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._lock = asyncio.Lock()
        self._ids = itertools.count(1)

    async def _connect(self) -> None:
        try:
            self._reader, self._writer = await asyncio.wait_for(
                asyncio.open_connection(HOST, PORT, limit=64 * 1024 * 1024), timeout=5
            )
        except (OSError, asyncio.TimeoutError) as e:
            raise GodotError(
                f"Can't reach the Godot editor at {HOST}:{PORT}. Make sure the project is open in "
                "Godot and the 'Godot MCP' plugin is enabled (Project > Project Settings > Plugins)."
            ) from e
        if TOKEN:
            await self._roundtrip("auth", {"token": TOKEN})

    async def _close(self) -> None:
        if self._writer:
            self._writer.close()
        self._reader = self._writer = None

    async def _roundtrip(self, command: str, params: dict) -> Any:
        assert self._reader and self._writer
        req_id = next(self._ids)
        msg = json.dumps({"id": req_id, "command": command, "params": params}) + "\n"
        self._writer.write(msg.encode())
        await self._writer.drain()
        while True:
            line = await asyncio.wait_for(self._reader.readline(), timeout=TIMEOUT)
            if not line:
                raise ConnectionError("Godot closed the connection")
            resp = json.loads(line)
            if resp.get("id") == req_id:
                break
        if not resp.get("ok"):
            raise GodotError(resp.get("error", "Unknown error from Godot"))
        return resp.get("result")

    async def call(self, command: str, **params: Any) -> Any:
        params = {k: v for k, v in params.items() if v is not None}
        async with self._lock:
            for attempt in range(2):
                if self._writer is None:
                    await self._connect()
                try:
                    return await self._roundtrip(command, params)
                except GodotError:
                    raise
                except asyncio.TimeoutError as e:
                    await self._close()
                    raise GodotError(f"Godot didn't answer '{command}' within {TIMEOUT:.0f}s.") from e
                except (ConnectionError, OSError):
                    await self._close()
                    if attempt == 1:
                        raise GodotError("Lost connection to the Godot editor.")


godot = GodotConnection()

mcp = _Server(
    "godot",
    instructions=(
        "Tools for the Godot 4 editor (4.5+, built for 4.7). Node paths are relative to the open "
        "scene's root ('.' is the root, 'Player/Sprite2D' a descendant). Property values are JSON: "
        "vectors as [x, y] or {\"x\":..,\"y\":..}, colours as '#rrggbb' or [r,g,b,a], resources as "
        "'res://...' paths, or any Godot literal string like 'Vector3(1, 2, 3)'. Scene edits go through "
        "the editor's undo history; call save_scene to persist them. After writing scripts, check "
        "script_errors in the result. Use get_class_info when unsure about a class's properties."
    ),
)


def _fmt(result: Any) -> str:
    return result if isinstance(result, str) else json.dumps(result, indent=2)


# ---------------------------------------------------------------- project / editor

@mcp.tool()
async def get_editor_state() -> str:
    """Godot version, project name/path, main scene, open scenes, edited scene, selection and whether the game is running. Good first call."""
    return _fmt(await godot.call("get_editor_state"))


@mcp.tool()
async def get_project_settings(prefix: str | None = None) -> str:
    """Read project settings. Without a prefix returns only settings changed from defaults; with a prefix (e.g. 'display/window', 'input/') returns all matching."""
    return _fmt(await godot.call("get_project_settings", prefix=prefix))


@mcp.tool()
async def set_project_setting(name: str, value: Any) -> str:
    """Set and save a project setting, e.g. name='application/run/main_scene', value='res://main.tscn'."""
    return _fmt(await godot.call("set_project_setting", name=name, value=value))


@mcp.tool()
async def get_class_info(class_name: str) -> str:
    """List editor properties, methods and signals of a Godot class (e.g. 'CharacterBody2D', 'AreaLight3D'), straight from this engine build."""
    return _fmt(await godot.call("get_class_info", class_name=class_name))


# ---------------------------------------------------------------- scene inspection

@mcp.tool()
async def get_scene_tree(path: str | None = None, max_depth: int = -1) -> str:
    """Node hierarchy of the scene open in the editor (names, types, scripts, instanced sub-scenes). Optionally start at `path` and limit depth."""
    return _fmt(await godot.call("get_scene_tree", path=path, max_depth=max_depth))


@mcp.tool()
async def get_node(path: str = ".", only_changed: bool = True) -> str:
    """Details of one node: properties (non-default only unless only_changed=False), children, groups and saved signal connections."""
    return _fmt(await godot.call("get_node", path=path, only_changed=only_changed))


# ---------------------------------------------------------------- scene editing

@mcp.tool()
async def add_node(
    parent: str = ".",
    type: str | None = None,
    name: str | None = None,
    properties: dict[str, Any] | None = None,
    scene: str | None = None,
) -> str:
    """Add a node under `parent`. Give a node `type` (built-in class or script class_name) OR a `scene` path to instance. Optional initial `properties`."""
    return _fmt(await godot.call("add_node", parent=parent, type=type, name=name, properties=properties, scene=scene))


@mcp.tool()
async def set_properties(path: str, properties: dict[str, Any]) -> str:
    """Set one or more properties on a node, e.g. {"position": [100, 200], "modulate": "#ff0000", "texture": "res://icon.svg"}. Sub-properties like "position:x" work too."""
    return _fmt(await godot.call("set_properties", path=path, properties=properties))


@mcp.tool()
async def delete_node(path: str) -> str:
    """Delete a node (and its children) from the open scene."""
    return _fmt(await godot.call("delete_node", path=path))


@mcp.tool()
async def rename_node(path: str, new_name: str) -> str:
    """Rename a node."""
    return _fmt(await godot.call("rename_node", path=path, new_name=new_name))


@mcp.tool()
async def move_node(path: str, new_parent: str | None = None, index: int | None = None) -> str:
    """Reparent a node and/or change its position among siblings."""
    return _fmt(await godot.call("move_node", path=path, new_parent=new_parent, index=index))


@mcp.tool()
async def duplicate_node(path: str, new_name: str | None = None) -> str:
    """Duplicate a node (with children) next to the original."""
    return _fmt(await godot.call("duplicate_node", path=path, new_name=new_name))


@mcp.tool()
async def attach_script(path: str, script_path: str) -> str:
    """Attach an existing script file to a node (empty script_path detaches). Create the file first with write_file."""
    return _fmt(await godot.call("attach_script", path=path, script_path=script_path))


@mcp.tool()
async def connect_signal(from_node: str, signal: str, to_node: str, method: str) -> str:
    """Create a persistent (saved-in-scene) signal connection, e.g. Button 'pressed' -> '.' '_on_button_pressed'."""
    return _fmt(await godot.call("connect_signal", **{"from": from_node, "to": to_node}, signal=signal, method=method))


@mcp.tool()
async def select_nodes(paths: list[str]) -> str:
    """Select nodes in the editor (and show a single one in the Inspector) so the user can see them."""
    return _fmt(await godot.call("select_nodes", paths=paths))


# ---------------------------------------------------------------- scenes

@mcp.tool()
async def open_scene(path: str) -> str:
    """Open a scene file in the editor, e.g. 'res://scenes/main.tscn'."""
    return _fmt(await godot.call("open_scene", path=path))


@mcp.tool()
async def save_scene(path: str | None = None) -> str:
    """Save the edited scene (or 'save as' to `path`)."""
    return _fmt(await godot.call("save_scene", path=path))


@mcp.tool()
async def save_all_scenes() -> str:
    """Save every open scene."""
    return _fmt(await godot.call("save_all_scenes"))


@mcp.tool()
async def create_scene(path: str, root_type: str = "Node2D", root_name: str | None = None, open: bool = True, overwrite: bool = False) -> str:
    """Create a new .tscn with the given root node type and (by default) open it."""
    return _fmt(await godot.call("create_scene", path=path, root_type=root_type, root_name=root_name, open=open, overwrite=overwrite))


# ---------------------------------------------------------------- running

@mcp.tool()
async def run_project(scene: str = "main") -> str:
    """Run the game: scene='main' (main scene), 'current' (edited scene) or a res:// scene path."""
    return _fmt(await godot.call("run_project", scene=scene))


@mcp.tool()
async def stop_project() -> str:
    """Stop the running game."""
    return _fmt(await godot.call("stop_project"))


# ---------------------------------------------------------------- logs

@mcp.tool()
async def get_output_panel(max_chars: int = 20000) -> str:
    """Text of the editor's Output panel, including prints and errors from the running game."""
    return _fmt(await godot.call("get_output_panel", max_chars=max_chars))


@mcp.tool()
async def get_editor_log(since: int = 0, limit: int = 200, errors_only: bool = False) -> str:
    """Structured editor-side log entries (prints, errors with file/line, script parse errors) captured since the plugin loaded. Use `since` with last_seq to page."""
    return _fmt(await godot.call("get_editor_log", since=since, limit=limit, errors_only=errors_only))


@mcp.tool()
async def get_game_log(lines: int = 200) -> str:
    """Tail of the game's log file (user://logs/godot.log) from the current or last run."""
    return _fmt(await godot.call("get_game_log", lines=lines))


# ---------------------------------------------------------------- files & scripts

@mcp.tool()
async def list_files(dir: str = "res://", extensions: list[str] | None = None, recursive: bool = True) -> str:
    """List project files, optionally filtered by extension, e.g. extensions=['gd','tscn']."""
    return _fmt(await godot.call("list_files", dir=dir, extensions=extensions, recursive=recursive))


@mcp.tool()
async def read_file(path: str) -> str:
    """Read a text file from the project (res://...), e.g. a script, scene or shader."""
    return _fmt(await godot.call("read_file", path=path))


@mcp.tool()
async def write_file(path: str, content: str) -> str:
    """Create or overwrite a text file in the project. For .gd files the editor reloads the script and returns any `script_errors`."""
    return _fmt(await godot.call("write_file", path=path, content=content))


@mcp.tool()
async def validate_script(path: str | None = None, source: str | None = None) -> str:
    """Compile a GDScript (file path or raw source) without saving and return any parse errors."""
    return _fmt(await godot.call("validate_script", path=path, source=source))


@mcp.tool()
async def execute_editor_script(code: str) -> str:
    """Run GDScript inside the editor (as the body of a function). Available: `scene_root` (edited scene root), `undo_redo` (EditorUndoRedoManager), `EditorInterface`, all engine singletons. Use `return` to send back a value; print() output is captured. Powerful — prefer the dedicated tools for routine edits."""
    return _fmt(await godot.call("execute_editor_script", code=code))


@mcp.tool()
async def screenshot(viewport: str = "editor", max_width: int = 1280) -> Image:
    """Screenshot of the editor: viewport='editor' (whole window), '2d' or '3d' (the scene viewports)."""
    result = await godot.call("screenshot", viewport=viewport, max_width=max_width)
    return Image(data=base64.b64decode(result["png_base64"]), format="png")


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
