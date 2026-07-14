#!/usr/bin/env -S uv run python
"""Codex PreToolUse guard for Chromium builds outside the remote wrapper."""

from __future__ import annotations

import json
import shlex
import sys
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

SHELL_SEPARATORS = frozenset({";", "&&", "||", "|", "&", "(", ")"})
BUILD_COMMANDS = frozenset({"gclient", "autoninja", "ninja"})
COMMAND_WRAPPERS = frozenset({"command", "exec", "nice", "nohup"})


def command_strings(value: Any) -> Iterable[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from command_strings(item)
    elif isinstance(value, list):
        for item in value:
            yield from command_strings(item)


def is_blocked(command: str) -> bool:
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()")
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError:
        return False
    segment: list[str] = []
    for token in (*tokens, ";"):
        if token in SHELL_SEPARATORS:
            if segment and is_blocked_segment(segment):
                return True
            segment = []
        else:
            segment.append(token)
    return False


def is_blocked_segment(tokens: Sequence[str]) -> bool:
    index = skip_assignments(tokens, 0)
    if index >= len(tokens):
        return False
    command = Path(tokens[index]).name
    index += 1
    if command == "env":
        while index < len(tokens) and (
            tokens[index].startswith("-") or "=" in tokens[index]
        ):
            index += 1
        return is_blocked_segment(tokens[index:])
    if command in COMMAND_WRAPPERS:
        return is_blocked_segment(tokens[index:])
    if command in BUILD_COMMANDS:
        return True
    if command == "gn":
        return index < len(tokens) and tokens[index] == "gen"
    if command == "ssh":
        remote = ssh_remote_command(tokens[index:])
        return bool(remote and is_blocked(remote))
    if command in {"bash", "sh"}:
        for option_index in range(index, len(tokens) - 1):
            option = tokens[option_index]
            if option == "-c" or (option.startswith("-") and "c" in option[1:]):
                return is_blocked(tokens[option_index + 1])
    return False


def skip_assignments(tokens: Sequence[str], index: int) -> int:
    while index < len(tokens):
        name, separator, _ = tokens[index].partition("=")
        if not separator or not name.replace("_", "a").isalnum() or name[0].isdigit():
            break
        index += 1
    return index


def ssh_remote_command(tokens: Sequence[str]) -> str:
    option_with_value = {
        "-b",
        "-c",
        "-D",
        "-E",
        "-F",
        "-i",
        "-J",
        "-l",
        "-m",
        "-o",
        "-p",
        "-S",
        "-W",
        "-w",
    }
    index = 0
    while index < len(tokens):
        token = tokens[index]
        if token == "--":
            index += 1
            break
        if not token.startswith("-"):
            break
        index += 2 if token in option_with_value else 1
    if index >= len(tokens):
        return ""
    return shlex.join(tokens[index + 1 :])


def parse_payload(argv: Sequence[str]) -> Iterable[str]:
    if argv:
        yield " ".join(argv)
        return
    raw = sys.stdin.read().strip()
    if not raw:
        return
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:
        yield raw
        return
    if not isinstance(payload, dict) or payload.get("tool_name") != "Bash":
        return
    tool_input = payload.get("tool_input")
    if not isinstance(tool_input, dict):
        return
    yield from command_strings(tool_input.get("command"))


def main(argv: Sequence[str] | None = None) -> int:
    commands = tuple(parse_payload(tuple(argv if argv is not None else sys.argv[1:])))
    if any(is_blocked(command) for command in commands):
        print(
            "Blocked Chromium build command. Use scripts/remote/build_install.py; "
            "local builds and bare-SSH builds are forbidden.",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
