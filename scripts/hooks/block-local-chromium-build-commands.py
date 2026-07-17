#!/usr/bin/env -S uv run python
"""Codex PreToolUse guard for Chromium builds outside the remote wrapper."""

from __future__ import annotations

import json
import re
import shlex
import sys
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

SHELL_SEPARATORS = frozenset({";", "&&", "||", "|", "&", "(", ")"})
REDIRECTION_TOKENS = frozenset({"<", ">", ">>", "<<", "<<<"})
SHELL_COMMANDS = frozenset({"bash", "sh", "dash", "zsh"})
COMMAND_WRAPPERS = frozenset({"command", "exec", "nice", "nohup", "time"})
READ_ONLY_GCLIENT_COMMANDS = frozenset({"revinfo", "root", "status"})
READ_ONLY_GN_COMMANDS = frozenset({"desc", "help", "ls", "path", "refs"})
READ_ONLY_NINJA_TOOLS = frozenset(
    {"commands", "compdb", "deps", "list", "missingdeps", "query", "rules", "targets"}
)
ASSIGNMENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*=")


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
    """Return whether a shell command can invoke a forbidden local build."""
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=";&|()<>")
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError:
        return True

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
    arguments = tokens[index + 1 :]
    if command == "env":
        next_index = env_command_index(arguments)
        return next_index is None or is_blocked_segment(arguments[next_index:])
    if command in COMMAND_WRAPPERS:
        next_index = wrapper_command_index(command, arguments)
        return next_index is None or is_blocked_segment(arguments[next_index:])
    if command == "gclient":
        return gclient_builds(arguments)
    if command == "gn":
        return gn_builds(arguments)
    if command in {"autoninja", "ninja"}:
        return ninja_builds(arguments)
    if command == "ssh":
        remote = ssh_remote_command(arguments)
        return remote is None or bool(remote and is_blocked(remote))
    if command in SHELL_COMMANDS:
        return shell_builds(arguments)
    return False


def skip_assignments(tokens: Sequence[str], index: int) -> int:
    while index < len(tokens) and ASSIGNMENT.fullmatch(tokens[index]):
        index += 1
    return index


def env_command_index(arguments: Sequence[str]) -> int | None:
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--":
            return index + 1
        if argument in {"-C", "--chdir", "-u", "--unset"}:
            if index + 1 >= len(arguments):
                return None
            index += 2
            continue
        if argument.startswith(("-C", "--chdir=", "-u", "--unset=")):
            index += 1
            continue
        if argument.startswith("-") or ASSIGNMENT.fullmatch(argument):
            index += 1
            continue
        return index
    return None


def wrapper_command_index(wrapper: str, arguments: Sequence[str]) -> int | None:
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--":
            return index + 1
        if argument in REDIRECTION_TOKENS:
            if index + 1 >= len(arguments):
                return None
            index += 2
            continue
        if wrapper == "nice" and argument in {"-n", "--adjustment"}:
            if index + 1 >= len(arguments):
                return None
            index += 2
            continue
        if wrapper == "time" and argument in {"-f", "--format", "-o", "--output"}:
            if index + 1 >= len(arguments):
                return None
            index += 2
            continue
        if wrapper == "exec" and argument == "-a":
            if index + 1 >= len(arguments):
                return None
            index += 2
            continue
        if argument.startswith("-"):
            index += 1
            continue
        return index
    return None


def gclient_builds(arguments: Sequence[str]) -> bool:
    subcommand = first_subcommand(arguments)
    return subcommand is None or subcommand not in READ_ONLY_GCLIENT_COMMANDS


def gn_builds(arguments: Sequence[str]) -> bool:
    subcommand = first_subcommand(arguments)
    if subcommand == "args":
        return "--list" not in arguments
    return subcommand not in READ_ONLY_GN_COMMANDS


def ninja_builds(arguments: Sequence[str]) -> bool:
    index = 0
    dry_run = False
    tool: str | None = None
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--":
            break
        if argument in {"-C", "-d", "-f", "-j", "-k", "-l", "-m", "-w"}:
            if index + 1 >= len(arguments):
                return True
            index += 2
            continue
        if argument in {"-n", "--dry-run"}:
            dry_run = True
            index += 1
            continue
        if argument in {"-t", "--tool"}:
            if index + 1 >= len(arguments):
                return True
            tool = arguments[index + 1]
            index += 2
            continue
        if argument.startswith("--tool="):
            tool = argument.removeprefix("--tool=")
            index += 1
            continue
        if argument.startswith("-"):
            index += 1
            continue
        index += 1

    if tool is not None:
        return tool not in READ_ONLY_NINJA_TOOLS
    return not dry_run


def first_subcommand(arguments: Sequence[str]) -> str | None:
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--":
            return arguments[index + 1] if index + 1 < len(arguments) else None
        if argument in {"--args", "--root", "--script-executable"}:
            if index + 1 >= len(arguments):
                return None
            index += 2
            continue
        if argument.startswith("-"):
            index += 1
            continue
        return argument
    return None


def shell_builds(arguments: Sequence[str]) -> bool:
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--":
            return True
        if argument == "-c" or (argument.startswith("-") and "c" in argument[1:]):
            if index + 1 >= len(arguments):
                return True
            return is_blocked(arguments[index + 1])
        if argument == "-s" or (argument.startswith("-") and "s" in argument[1:]):
            return True
        if argument in REDIRECTION_TOKENS:
            return True
        if argument.startswith("-"):
            index += 1
            continue
        return True
    return True


def ssh_remote_command(arguments: Sequence[str]) -> str | None:
    options_with_value = frozenset(
        {
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
    )
    index = 0
    while index < len(arguments):
        argument = arguments[index]
        if argument == "--":
            index += 1
            break
        if not argument.startswith("-"):
            break
        if argument in options_with_value:
            if index + 1 >= len(arguments):
                return None
            index += 2
            continue
        index += 1
    if index >= len(arguments):
        return ""

    remote_arguments = arguments[index + 1 :]
    if any(argument in REDIRECTION_TOKENS for argument in remote_arguments):
        return None
    return " ".join(remote_arguments)


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
            "Blocked Chromium build command. Use "
            "scripts/remote/provider/build.py; local builds and bare-SSH builds "
            "are forbidden.",
            file=sys.stderr,
        )
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
