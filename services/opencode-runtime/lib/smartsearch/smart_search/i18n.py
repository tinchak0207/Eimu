"""Local interface language. Search/provider text is never passed through this module."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from functools import lru_cache
import json
import locale
import os
from pathlib import Path
import re

LANGUAGE_KEY = "SMART_SEARCH_LANGUAGE"
_language = ContextVar("smart_search_language", default="en")


def normalize(value: str) -> str:
    text = str(value).strip().lower().replace("_", "-")
    if text == "auto":
        return "auto"
    if text == "zh" or text.startswith("zh-"):
        return "zh"
    if text == "en" or text.startswith("en-"):
        return "en"
    raise ValueError(tr("Language must be auto, zh, or en."))


def system_language() -> str:
    for key in ("LC_ALL", "LC_MESSAGES", "LANG"):
        if os.environ.get(key):
            return "zh" if os.environ[key].lower().startswith("zh") else "en"
    if os.name == "nt":
        try:
            import ctypes
            return "zh" if ctypes.windll.kernel32.GetUserDefaultUILanguage() & 0x3FF == 4 else "en"
        except (AttributeError, OSError):
            pass
    try:
        language = locale.getlocale()[0] or ""
    except (ValueError, TypeError):
        language = ""
    return "zh" if language.lower().startswith("zh") else "en"


def resolve(value: str = "auto") -> str:
    value = normalize(value)
    return system_language() if value == "auto" else value


def current_language() -> str:
    return _language.get()


@contextmanager
def use_language(value: str):
    token = _language.set(resolve(value))
    try:
        yield
    finally:
        _language.reset(token)


@lru_cache(maxsize=1)
def catalog() -> dict[str, list[str]]:
    return json.loads((Path(__file__).parent / "assets/i18n/messages.json").read_text(encoding="utf-8"))


def translate(source: str, language: str | None = None) -> str:
    pair = catalog().get(source)
    return pair[0 if (language or current_language()) == "zh" else 1] if pair else source


class Message(str):
    """Keep a status template so an async event can use the App's current language."""
    def __new__(cls, source: str, *args, deferred: bool = False):
        text = source if deferred else translate(source)
        displayed = args if deferred else tuple(value.render(current_language()) if isinstance(value, Message) else value for value in args)
        instance = super().__new__(cls, text.format(*displayed) if args else text)
        instance.source, instance.arguments = source, args
        return instance

    def __str__(self):
        # Exception.__str__ and existing result adapters retain the ownership marker.
        return self

    def render(self, language: str) -> str:
        text = translate(self.source, language)
        args = tuple(value.render(language) if isinstance(value, Message) else value for value in self.arguments)
        return text.format(*args) if args else text


def tr(source: str, *args) -> str:
    if isinstance(source, Message) and not args:
        return source
    return Message(source, *args)


def source_message(source: str, *args) -> str:
    """Mark owned diagnostic copy; keep its source text for internal classification."""
    if isinstance(source, Message) and not args:
        return source
    return Message(source, *args, deferred=True)


def render_messages(value, language: str | None = None):
    language = language or current_language()
    if isinstance(value, Message):
        return value.render(language)
    if isinstance(value, dict):
        return {key: render_messages(item, language) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [render_messages(item, language) for item in value]
    return value


def parser_error(message: str) -> str:
    """Translate argparse's own sentence templates, keeping argument values intact."""
    patterns = (
        (r"argument (.*?): (.*)", "argument {0}: {1}"),
        (r"unrecognized arguments: (.*)", "unrecognized arguments: {0}"),
        (r"the following arguments are required: (.*)", "the following arguments are required: {0}"),
        (r"invalid choice: (.*?) \(choose from (.*)\)", "invalid choice: {0} (choose from {1})"),
        (r"invalid (.*?) value: (.*)", "invalid {0} value: {1}"),
        (r"expected (\d+) arguments", "expected {0} arguments"),
        (r"ignored explicit argument (.*)", "ignored explicit argument {0}"),
        (r"not allowed with argument (.*)", "not allowed with argument {0}"),
    )
    for pattern, template in patterns:
        match = re.fullmatch(pattern, message, re.DOTALL)
        if match:
            values = list(match.groups())
            if template == "argument {0}: {1}":
                values[1] = parser_error(values[1])
            return tr(template, *values)
    return tr(message)
