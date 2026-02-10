"""Best-effort sanitizers for model-produced JS macros.

Goal: reduce common syntax failures in WPS taskpane execution environment
(`new Function(...)`) by removing TS/ESM-only syntax and normalizing
non-ASCII punctuation that sometimes appears in LLM outputs.

This is intentionally conservative: it should only remove clearly-invalid
syntax, and avoid rewriting semantics-heavy code.
"""

from __future__ import annotations

import re
from typing import List, Tuple


_FULLWIDTH_MAP = {
    # Curly / CJK quotes -> ASCII quotes
    "\u201c": '"',  # “
    "\u201d": '"',  # ”
    "\u201e": '"',  # „
    "\u201f": '"',  # ‟
    "\u00ab": '"',  # «
    "\u00bb": '"',  # »
    "\u300c": '"',  # 「
    "\u300d": '"',  # 」
    "\u300e": '"',  # 『
    "\u300f": '"',  # 』
    "\u301d": '"',  # 〝
    "\u301e": '"',  # 〞
    "\u301f": '"',  # 〟
    "\u2018": "'",  # ‘
    "\u2019": "'",  # ’
    "\u201a": "'",  # ‚
    "\u201b": "'",  # ‛
    "\u2039": "'",  # ‹
    "\u203a": "'",  # ›
    "\uff02": '"',  # fullwidth quotation mark
    "\uff07": "'",  # fullwidth apostrophe

    # Fullwidth/CJK punctuation -> ASCII
    "\uff08": "(",  # （
    "\uff09": ")",  # ）
    "\u3010": "[",  # 【
    "\u3011": "]",  # 】
    "\uff3b": "[",  # ［
    "\uff3d": "]",  # ］
    "\uff5b": "{",  # ｛
    "\uff5d": "}",  # ｝
    "\uff0c": ",",  # ，
    "\u3001": ",",  # 、 (ideographic comma)
    "\uff1b": ";",  # ；
    "\uff1a": ":",  # ：
    "\uff1d": "=",  # ＝
    "\uff0b": "+",  # ＋
    "\uff0d": "-",  # －
    "\uff0a": "*",  # ＊
    "\uff0f": "/",  # ／
    "\uff01": "!",  # ！
    "\uff1f": "?",  # ？
    "\uff0e": ".",  # ．
    "\u3002": ".",  # 。 (ideographic period)
    "\u2013": "-",  # en dash
    "\u2014": "-",  # em dash
    "\u2212": "-",  # minus sign

    # Spaces
    "\u3000": " ",  # ideographic space
    "\u00a0": " ",  # nbsp
}


def normalize_unicode_punctuation(code: str) -> Tuple[str, bool, List[str]]:
    out = str(code or "")
    notes: List[str] = []
    before = out
    # Remove BOM + common zero-width chars.
    out = (
        out.replace("\ufeff", "")
        .replace("\u200b", "")
        .replace("\u200c", "")
        .replace("\u200d", "")
        .replace("\u2060", "")
        .replace("\u200e", "")
        .replace("\u200f", "")
        .replace("\u202a", "")
        .replace("\u202b", "")
        .replace("\u202c", "")
        .replace("\u202d", "")
        .replace("\u202e", "")
        .replace("\u2066", "")
        .replace("\u2067", "")
        .replace("\u2068", "")
        .replace("\u2069", "")
        .replace("\u00ad", "")
        .replace("\u2028", "\n")
        .replace("\u2029", "\n")
    )
    changed = out != before
    if changed:
        notes.append("removed zero-width/BOM/line-separator characters")

    if any(ch in out for ch in _FULLWIDTH_MAP):
        out2 = "".join(_FULLWIDTH_MAP.get(ch, ch) for ch in out)
        if out2 != out:
            out = out2
            changed = True
            notes.append("normalized curly quotes/fullwidth punctuation")

    return out, changed, notes


def escape_unescaped_newlines_in_strings(code: str) -> Tuple[str, bool, List[str]]:
    """Escape literal newlines inside single/double-quoted strings.

    LLMs sometimes emit multi-line string literals like:
      var s = 'line1
      line2';
    which is a SyntaxError in JS. This pass converts such newlines into `\\n`.
    It's best-effort and only targets obviously-invalid cases.
    """

    src = str(code or "")
    out: List[str] = []
    notes: List[str] = []
    changed = False

    mode = "normal"  # normal | single | double | line_comment | block_comment | template
    i = 0
    n = len(src)

    while i < n:
        ch = src[i]
        nxt = src[i + 1] if i + 1 < n else ""

        if mode == "normal":
            if ch == "'" and (nxt != "'"):
                mode = "single"
                out.append(ch)
                i += 1
                continue
            if ch == '"':
                mode = "double"
                out.append(ch)
                i += 1
                continue
            if ch == "`":
                mode = "template"
                out.append(ch)
                i += 1
                continue
            if ch == "/" and nxt == "/":
                mode = "line_comment"
                out.append(ch)
                out.append(nxt)
                i += 2
                continue
            if ch == "/" and nxt == "*":
                mode = "block_comment"
                out.append(ch)
                out.append(nxt)
                i += 2
                continue
            out.append(ch)
            i += 1
            continue

        if mode in ("single", "double"):
            if ch == "\\":
                out.append(ch)
                if i + 1 < n:
                    out.append(src[i + 1])
                    i += 2
                else:
                    i += 1
                continue

            if ch == "\r" or ch == "\n":
                # Replace literal newlines inside quotes with `\n`.
                changed = True
                if not notes:
                    notes.append("escaped literal newlines inside string literals")
                out.append("\\n")
                if ch == "\r" and nxt == "\n":
                    i += 2
                else:
                    i += 1
                continue

            if mode == "single" and ch == "'":
                mode = "normal"
            elif mode == "double" and ch == '"':
                mode = "normal"

            out.append(ch)
            i += 1
            continue

        if mode == "line_comment":
            out.append(ch)
            i += 1
            if ch == "\n":
                mode = "normal"
            continue

        if mode == "block_comment":
            out.append(ch)
            if ch == "*" and nxt == "/":
                out.append(nxt)
                i += 2
                mode = "normal"
            else:
                i += 1
            continue

        # template literal: allow newlines, but still track closing backtick.
        if mode == "template":
            out.append(ch)
            i += 1
            if ch == "\\" and i < n:
                out.append(src[i])
                i += 1
                continue
            if ch == "`":
                mode = "normal"
            continue

    return "".join(out), changed, notes


def normalize_stray_backslash_newline_tokens(code: str) -> Tuple[str, bool, List[str]]:
    """Convert stray `\\n`/`\\r` tokens *outside* strings/comments into real newlines.

    Some LLMs occasionally emit backslash-newline sequences as if they were layout tokens in code:
      var arr = ['a', '',\\n 'b'];
    That is invalid JS (SyntaxError) unless it's inside a string/regex/template literal.

    We keep this conservative:
    - only run outside strings/comments/templates (best-effort)
    - only when context looks like "layout", not regex literals (heuristic)
    """

    src = str(code or "")
    if "\\n" not in src and "\\r" not in src:
        return src, False, []

    out: List[str] = []
    notes: List[str] = []
    changed = False

    mode = "normal"  # normal | single | double | line_comment | block_comment | template
    template_expr_depth = 0

    def peek_prev_non_space() -> str:
        for c in reversed(out):
            if c not in (" ", "\t", "\r", "\n"):
                return c
        return ""

    def peek_next_non_space(i: int) -> Tuple[str, int]:
        j = i
        while j < len(src):
            c = src[j]
            if c not in (" ", "\t", "\r", "\n"):
                return c, j
            j += 1
        return "", len(src)

    i = 0
    n = len(src)
    while i < n:
        ch = src[i]
        nxt = src[i + 1] if i + 1 < n else ""

        if mode == "line_comment":
            out.append(ch)
            if ch == "\n":
                mode = "normal"
            i += 1
            continue

        if mode == "block_comment":
            out.append(ch)
            if ch == "*" and nxt == "/":
                out.append(nxt)
                i += 2
                mode = "normal"
            else:
                i += 1
            continue

        if mode == "single":
            out.append(ch)
            if ch == "\\":
                if i + 1 < n:
                    out.append(src[i + 1])
                    i += 2
                else:
                    i += 1
                continue
            if ch == "'":
                mode = "normal"
            i += 1
            continue

        if mode == "double":
            out.append(ch)
            if ch == "\\":
                if i + 1 < n:
                    out.append(src[i + 1])
                    i += 2
                else:
                    i += 1
                continue
            if ch == '"':
                mode = "normal"
            i += 1
            continue

        if mode == "template":
            out.append(ch)
            if ch == "\\":
                if i + 1 < n:
                    out.append(src[i + 1])
                    i += 2
                else:
                    i += 1
                continue
            if ch == "`":
                mode = "normal"
                i += 1
                continue
            if ch == "$" and nxt == "{":
                out.append(nxt)
                i += 2
                mode = "normal"
                template_expr_depth = 1
                continue
            i += 1
            continue

        # normal (incl template expression blocks)
        if template_expr_depth > 0:
            out.append(ch)
            if ch == "{":
                template_expr_depth += 1
            elif ch == "}":
                template_expr_depth -= 1
            if template_expr_depth == 0:
                mode = "template"
            i += 1
            continue

        if ch == "/" and nxt == "/":
            out.append(ch)
            out.append(nxt)
            i += 2
            mode = "line_comment"
            continue
        if ch == "/" and nxt == "*":
            out.append(ch)
            out.append(nxt)
            i += 2
            mode = "block_comment"
            continue
        if ch == "'":
            out.append(ch)
            i += 1
            mode = "single"
            continue
        if ch == '"':
            out.append(ch)
            i += 1
            mode = "double"
            continue
        if ch == "`":
            out.append(ch)
            i += 1
            mode = "template"
            continue

        if ch == "\\" and (nxt == "n" or nxt == "r"):
            prev = peek_prev_non_space()
            nn, nn_i = peek_next_non_space(i + 2)

            # Regex literal heuristic: do not touch patterns like `/\\n/`.
            if prev == "/" or nn == "/":
                out.append(ch)
                i += 1
                continue

            prev_ok = (prev == "") or (prev in ",;]})'\"")
            next_ok = (
                (nn == "")
                or (nn in "'\"[]{}()")
                or bool(re.match(r"[A-Za-z0-9_$]", nn))
                or (nn == "\\" and nn_i + 1 < n and src[nn_i + 1] in ("n", "r"))
            )
            if prev_ok and next_ok:
                out.append("\n")
                i += 2  # consume \ + n/r
                changed = True
                if not notes:
                    notes.append("normalized stray \\\\n/\\\\r tokens outside strings")
                continue

        out.append(ch)
        i += 1

    return "".join(out), changed, notes


def strip_redundant_window_bid_assignment(code: str) -> Tuple[str, bool, List[str]]:
    """
    Some model outputs redundantly do `var BID = window.BID;` (or let/const).

    In our TaskPane macro runtime, `BID` is already injected as a global variable. The redundant assignment
    can break execution if `window.BID` is not present in the host JS engine, or if the model runs this code
    in an environment where `window` exists but does not carry our helper facade.

    We strip the standalone assignment line to reduce deterministic failures.
    """
    src = str(code or "")
    out = re.sub(
        r"(?m)^\s*(?:var|let|const)\s+BID\s*=\s*window\.BID\s*;\s*$",
        " ",
        src,
    )
    if out == src:
        return src, False, []
    return out, True, ["stripped redundant `var BID = window.BID;`"]


def strip_ts_esm_syntax(code: str) -> Tuple[str, bool, List[str]]:
    out = str(code or "")
    notes: List[str] = []
    changed = False

    # Remove import blocks (best-effort; handles multiline imports).
    if re.search(r"^\s*import\b", out, flags=re.MULTILINE):
        lines = out.splitlines()
        kept: List[str] = []
        skipping = False
        for line in lines:
            if not skipping and re.match(r"^\s*import\b", line):
                skipping = True
                changed = True
                continue
            if skipping:
                ends_stmt = bool(re.search(r";\s*$", line))
                has_from = bool(re.search(r"\bfrom\s+['\"][^'\"]+['\"]\s*;?\s*$", line))
                is_bare = bool(re.match(r"^\s*import\s+['\"][^'\"]+['\"]\s*;?\s*$", line))
                is_dyn = bool(re.match(r"^\s*import\s*\(.+\)\s*;?\s*$", line))
                if ends_stmt or has_from or is_bare or is_dyn:
                    skipping = False
                continue
            kept.append(line)
        out = "\n".join(kept)
        notes.append("removed import statements")

    # Remove export list blocks; strip export keywords.
    if re.search(r"^\s*export\s+", out, flags=re.MULTILINE):
        out2 = out
        if re.search(r"^\s*export\s*\{", out2, flags=re.MULTILINE):
            lines = out2.splitlines()
            kept = []
            skipping = False
            for line in lines:
                if not skipping and re.match(r"^\s*export\s*\{", line):
                    skipping = True
                    changed = True
                    continue
                if skipping:
                    if re.search(r"\}\s*(from\s+['\"][^'\"]+['\"])?\s*;?\s*$", line):
                        skipping = False
                    continue
                kept.append(line)
            out2 = "\n".join(kept)
            notes.append("removed export list statements")

        out2 = re.sub(r"^\s*export\s+default\s+", "", out2, flags=re.MULTILINE)
        out2 = re.sub(
            r"^\s*export\s+(?=(async\s+)?(function|const|let|var|class)\b)",
            "",
            out2,
            flags=re.MULTILINE,
        )
        if out2 != out:
            out = out2
            changed = True
            notes.append("stripped export keywords")

    # Remove TS declaration-only lines/blocks.
    patterns = [
        (r"^\s*interface\s+\w+.*$", "removed interface declarations"),
        (r"^\s*type\s+\w+\s*=.*$", "removed type aliases"),
        (r"^\s*declare\s+.*$", "removed declare statements"),
        (r"^\s*namespace\s+\w+.*$", "removed namespace statements"),
    ]
    for pat, note in patterns:
        if re.search(pat, out, flags=re.MULTILINE):
            out2 = re.sub(pat, "", out, flags=re.MULTILINE)
            if out2 != out:
                out = out2
                changed = True
                notes.append(note)

    # Remove enum blocks (best-effort).
    if re.search(r"^\s*enum\s+\w+\s*\{", out, flags=re.MULTILINE):
        lines = out.splitlines()
        kept = []
        skipping = False
        brace = 0
        for line in lines:
            if not skipping and re.match(r"^\s*enum\s+\w+\s*\{", line):
                skipping = True
                brace = 0
                changed = True
                notes.append("removed enum declarations")
            if skipping:
                brace += line.count("{")
                brace -= line.count("}")
                if brace <= 0 and "}" in line:
                    skipping = False
                continue
            kept.append(line)
        out = "\n".join(kept)

    # Non-null assertion: foo!.bar -> foo.bar
    out2 = re.sub(r"([A-Za-z_$][\w$]*)!\s*(?=[\.\[\(])", r"\1", out)
    if out2 != out:
        out = out2
        changed = True
        notes.append("removed non-null assertions")

    # `as Type` assertions.
    out2 = re.sub(r"\s+as\s+[A-Za-z_$][\w$<>, \t\[\]\|&]+", "", out)
    if out2 != out:
        out = out2
        changed = True
        notes.append('removed "as Type" assertions')

    # `satisfies Type` operator.
    out2 = re.sub(r"\s+satisfies\s+[A-Za-z_$][\w$<>, \t\[\]\|&]+", "", out)
    if out2 != out:
        out = out2
        changed = True
        notes.append("removed satisfies operator")

    # Variable annotations: `const x: any =` -> `const x =`
    out2 = re.sub(r"\b(const|let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[^=;\n]+=", r"\1 \2 =", out)
    if out2 != out:
        out = out2
        changed = True
        notes.append("stripped variable type annotations")

    # `let x: any;` -> `let x;`
    out2 = re.sub(r"\b(let|var)\s+([A-Za-z_$][\w$]*)\s*:\s*[^;,\n]+;", r"\1 \2;", out)
    if out2 != out:
        out = out2
        changed = True
        notes.append("stripped var/let declaration type annotations")

    # `const x: any;` -> `let x;`
    out2 = re.sub(r"\bconst\s+([A-Za-z_$][\w$]*)\s*:\s*[^;,\n]+;", r"let \1;", out)
    if out2 != out:
        out = out2
        changed = True
        notes.append("converted const declarations without initializer")

    # Param annotations (conservative): `(a: string, b: number)` -> `(a, b)`
    #
    # IMPORTANT: do NOT use a broad `[^,)\n]+` matcher here, or it will corrupt
    # legitimate JS object literals like `{ data: ['Q1', 1] }` by stripping the `: ['Q1'`.
    # Only strip when the "type" looks like a TS type expression (identifiers/generics/[]/|/&)
    # and is immediately followed by `,` / `)` / `=` (default value).
    ts_type = r"[A-Za-z_$][\w$<>, \t\[\]\|&]*"
    out2 = re.sub(
        rf"([\(\,])\s*([A-Za-z_$][\w$]*)\s*:\s*{ts_type}\s*(?=(\s*(?:,|\)|=)))",
        r"\1 \2",
        out,
    )
    if out2 != out:
        out = out2
        changed = True
        notes.append("stripped parameter type annotations")

    # Optional params: `a?: string` -> `a`
    out2 = re.sub(
        rf"([\(\,])\s*([A-Za-z_$][\w$]*)\s*\?\s*:\s*{ts_type}\s*(?=(\s*(?:,|\)|=)))",
        r"\1 \2",
        out,
    )
    if out2 != out:
        out = out2
        changed = True
        notes.append("stripped optional parameter annotations")

    # Destructured param annotations: `({a}: any)` -> `({a})`
    out2 = re.sub(r"([\}\]])\s*:\s*[^,\)\n]+(?=[,\)])", r"\1", out)
    if out2 != out:
        out = out2
        changed = True
        notes.append("stripped destructured parameter annotations")

    # Return type annotations.
    out2 = re.sub(r"\)\s*:\s*\{[\s\S]*?\}\s*(?=\{|=>)", ") ", out)
    out2 = re.sub(r"\)\s*:\s*\[[\s\S]*?\]\s*(?=\{|=>)", ") ", out2)
    out2 = re.sub(r"\)\s*:\s*[^=\n{]+\s*(?=\{|=>)", ") ", out2)
    if out2 != out:
        out = out2
        changed = True
        notes.append("stripped return type annotations")

    # Cleanup empty lines.
    out2 = re.sub(r"\n{3,}", "\n\n", out).strip()
    if out2 != out:
        out = out2
        changed = True

    return out, changed, list(dict.fromkeys(notes))


def looks_like_wps_js_macro(code: str) -> bool:
    s = str(code or "").strip()
    if not s:
        return False
    # Heuristic: most WPS macros touch app/window/BID or define+invoke a function.
    if "app." in s or "window.Application" in s or "WPS.GetApplication" in s or "BID." in s:
        return True
    if "function " in s and "(" in s and ")" in s:
        return True
    return False


def sanitize_wps_js(code: str) -> Tuple[str, List[str]]:
    """Return (sanitized_code, notes)."""
    out = str(code or "")
    notes: List[str] = []
    out, _, n1 = normalize_unicode_punctuation(out)
    notes.extend(n1)
    out, _, n2 = strip_ts_esm_syntax(out)
    notes.extend(n2)
    out, _, n3 = escape_unescaped_newlines_in_strings(out)
    notes.extend(n3)
    out, _, n4 = normalize_stray_backslash_newline_tokens(out)
    notes.extend(n4)
    out, _, n5 = strip_redundant_window_bid_assignment(out)
    notes.extend(n5)
    # WPS embedded engines are often ES5-only: avoid `let`/`const` parse errors early.
    # This is a conservative token replacement (does not aim to transpile full ES6).
    out2 = re.sub(r"(?<![\w$])(?:let|const)(?=\s+[A-Za-z_$\u4e00-\u9fa5])", "var", out)
    if out2 != out:
        out = out2
        notes.append("downgraded let/const to var")
    # Deduplicate notes.
    notes = list(dict.fromkeys([n for n in notes if n]))
    return out, notes
