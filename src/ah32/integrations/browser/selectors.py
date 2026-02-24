"""Selector utilities.

Convention:
- CSS: default (e.g. ".btn.primary", "#submit")
- XPath: prefix with "xpath=" or start with "//" / "(//"
- Text: prefix with "text=" (Playwright text engine)
"""

from __future__ import annotations

from enum import StrEnum


class SelectorKind(StrEnum):
    css = "css"
    xpath = "xpath"
    text = "text"


def normalize_selector(raw: str) -> tuple[str, SelectorKind]:
    selector = str(raw or "").strip()
    if not selector:
        raise ValueError("selector is empty")

    lowered = selector.lower()
    if lowered.startswith("css="):
        return selector[4:], SelectorKind.css
    if lowered.startswith("xpath="):
        return f"xpath={selector[6:]}", SelectorKind.xpath
    if lowered.startswith("text="):
        return f"text={selector[5:]}", SelectorKind.text
    if lowered.startswith("text:"):
        return f"text={selector[5:]}", SelectorKind.text

    # Heuristic: looks like XPath.
    if selector.startswith("//") or selector.startswith("(//"):
        return f"xpath={selector}", SelectorKind.xpath

    # Default: CSS selector (Playwright default engine).
    return selector, SelectorKind.css

