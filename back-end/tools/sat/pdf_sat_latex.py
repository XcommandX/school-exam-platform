"""Conservative, evidence-based Markdown/LaTeX rendering of editable PDF lines.

This maintenance helper has no PDF dependency.  It consumes the text and spans
already extracted by the converter.  It never guesses a missing exponent or
radical: a baseline ``x2`` remains ``x2`` and receives a review warning.  Actual
raised/lowered glyphs and Unicode superscripts/subscripts are unambiguous source
evidence.  Formula pictures are neither created nor returned by this module.
"""
from __future__ import annotations

from collections import Counter
import re
import unicodedata


_SUPER = dict(zip("⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ", "0123456789+-=()ni"))
_SUB = dict(zip("₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ", "0123456789+-=()aehijklmnoprstuvx"))
_SYMBOLS = {
    "−": "-", "–": "-", "＋": "+", "＝": "=", "×": r"\times ",
    "⋅": r"\cdot ", "·": r"\cdot ", "÷": r"\div ", "≤": r"\le ",
    "≥": r"\ge ", "<": r"\lt ", ">": r"\gt ",
    "≠": r"\ne ", "≈": r"\approx ", "≡": r"\equiv ",
    "±": r"\pm ", "∓": r"\mp ", "∞": r"\infty ", "∠": r"\angle ",
    "△": r"\triangle ", "Δ": r"\Delta ", "π": r"\pi ", "θ": r"\theta ",
    "α": r"\alpha ", "β": r"\beta ", "γ": r"\gamma ", "δ": r"\delta ",
    "λ": r"\lambda ", "μ": r"\mu ", "σ": r"\sigma ", "Σ": r"\Sigma ",
    "∑": r"\sum ", "∏": r"\prod ", "∈": r"\in ", "∉": r"\notin ",
    "⊂": r"\subset ", "⊆": r"\subseteq ", "∪": r"\cup ", "∩": r"\cap ",
    "∅": r"\varnothing ", "∥": r"\parallel ", "⊥": r"\perp ",
    "→": r"\to ", "↔": r"\leftrightarrow ", "∴": r"\therefore ",
    "∵": r"\because ", "∗": r"\ast ", "′": "'", "″": "''",
    "％": r"\%", "%": r"\%", "°": r"^{\circ}", "∘": r"^{\circ}",
}
_FUNCTIONS = {"sin", "cos", "tan", "sec", "csc", "cot", "arcsin", "arccos",
              "arctan", "log", "ln", "sqrt", "min", "max", "lim", "exp"}
_SAFE_COMMANDS = _FUNCTIONS | {"frac", "dfrac", "tfrac", "mathrm", "text", "left", "right",
    "cdot", "times", "div", "lt", "gt", "le", "leq", "ge", "geq", "ne", "neq", "approx",
    "pi", "theta", "alpha", "beta", "gamma", "delta", "lambda", "mu", "sigma",
    "Delta", "Sigma", "pm", "mp", "infty", "angle", "triangle", "circ", "surd",
    "sum", "prod", "in", "notin", "subset", "subseteq", "cup", "cap", "varnothing",
    "parallel", "perp", "to", "leftrightarrow", "therefore", "because", "ast"}
_UNITS = {"cm", "mm", "km", "kg", "mL", "ml", "mg", "ft"}
_PROSE_WORDS = {"a", "A", "I", "an", "as", "at", "be", "by", "do", "for", "if",
                "in", "is", "it", "of", "on", "or", "so", "to", "up", "we",
                "no", "he", "my", "me", "us", "go"}
_NUMBER = r"(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)"
_TOKEN = re.compile(
    r"\\[A-Za-z]+|" + _NUMBER + r"|[A-Za-z]+|[\u0370-\u03ff]|"
    r"[⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁼⁽⁾ⁿⁱ₀₁₂₃₄₅₆₇₈₉₊₋₌₍₎ₐₑₕᵢⱼₖₗₘₙₒₚᵣₛₜᵤᵥₓ]+|"
    r"[=+\-−–*/^_{}()\[\]|<>:.,%％°∘√∛∜＋＝×⋅·÷≤≥≠≈≡±∓∞∠△∑∏∈∉⊂⊆∪∩∅∥⊥→↔∴∵∗′″]"
)
_MATH_SIGNALS = re.compile(r"[=+\-−–*/^_{}|<>%％°∘√∛∜＋＝×⋅·÷≤≥≠≈≡±∓∞∠△∑∏∈∉⊂⊆∪∩∅∥⊥→↔]|\\[A-Za-z]+|[\u0370-\u03ff]")


def _normal_space(text):
    return re.sub(r"\s+", " ", text.replace("\u00ad", "")).strip()


def _span_text(event):
    """Reconstruct source-proven scripts; return text, italic words and warnings."""
    raw = str(event.get("text", ""))
    spans = [s for s in event.get("spans", []) if s.get("text")]
    warnings = []
    italic = set()
    if not spans:
        return raw, italic, warnings
    joined = "".join(str(s["text"]) for s in spans)
    if _normal_space(joined) != _normal_space(raw):
        return raw, italic, ["source_span_text_mismatch"]
    for span in spans:
        if int(span.get("flags", 0)) & 2 or "italic" in span.get("font", "").lower():
            italic.update(re.findall(r"\b[A-Za-z]{1,4}\b", span["text"]))
    weighted_baselines = Counter()
    for span in spans:
        if span.get("origin") and not (int(span.get("flags", 0)) & 1):
            weighted_baselines[round(float(span["origin"][1]), 1)] += len(span["text"].strip())
    baseline = weighted_baselines.most_common(1)[0][0] if weighted_baselines else None
    sizes = Counter()
    for span in spans:
        if baseline is not None and span.get("origin") and abs(span["origin"][1] - baseline) < 1:
            sizes[float(span.get("size", 0))] += len(span["text"].strip())
    base_size = sizes.most_common(1)[0][0] if sizes else 0
    result = []
    previous = None
    script_kind = None
    script_parts = []

    def flush_script():
        nonlocal script_kind, script_parts
        if script_parts:
            result.append(script_kind + "{" + "".join(script_parts).strip() + "}")
        script_kind, script_parts = None, []

    for span in spans:
        value = str(span["text"])
        size = float(span.get("size", 0))
        origin = span.get("origin")
        offset = (float(origin[1]) - baseline) if origin and baseline is not None else 0
        flags = int(span.get("flags", 0))
        # Font-family ascenders vary: use baselines, not top of bounding boxes.
        shifted = abs(offset) >= max(1.4, base_size * .13)
        small = base_size > 0 and 0 < size <= base_size * .90
        script = None
        script_text = value.strip()
        # A small footnote word or a raised punctuation mark is not an exponent.
        if result and shifted and (small or flags & 1) and re.fullmatch(r"[\dA-Za-z+\-−=()/., ]{1,24}", script_text):
            if re.search(r"[\dA-Za-z)}\]]\s*$", "".join(result)):
                script = "^" if offset < 0 else "_"
        if script:
            if script_kind and script_kind != script:
                flush_script()
            script_kind = script
            script_parts.append(script_text)
        else:
            flush_script()
            result.append(value)
        if previous and previous.get("bbox") and span.get("bbox"):
            a, b = previous["bbox"], span["bbox"]
            overlap_x = min(a[2], b[2]) - max(a[0], b[0])
            overlap_y = min(a[3], b[3]) - max(a[1], b[1])
            if overlap_x > max(1.8, min(a[2] - a[0], b[2] - b[0]) * .35) and overlap_y > min(a[3] - a[1], b[3] - b[1]) * .5:
                warnings.append("source_overlapping_spans")
        previous = span
    flush_script()
    return "".join(result), italic, warnings


def _scripts(text):
    for mapping, marker in ((_SUPER, "^"), (_SUB, "_")):
        pattern = "[" + re.escape("".join(mapping)) + "]+"
        text = re.sub(pattern, lambda m: marker + "{" + "".join(mapping[c] for c in m[0]) + "}", text)
    return text


def _balanced_end(text, start):
    pairs = {"(": ")", "[": "]", "{": "}"}
    if start >= len(text) or text[start] not in pairs:
        return None
    stack = []
    for pos in range(start, len(text)):
        char = text[pos]
        if char in pairs:
            stack.append(pairs[char])
        elif char in ")]}":
            if not stack or stack.pop() != char:
                return None
            if not stack:
                return pos + 1
    return None


def _radicals(text, warnings):
    result, index = [], 0
    while index < len(text):
        char = text[index]
        if char not in "√∛∜":
            result.append(char)
            index += 1
            continue
        root = "" if char == "√" else "[3]" if char == "∛" else "[4]"
        index += 1
        while index < len(text) and text[index].isspace():
            index += 1
        end = _balanced_end(text, index)
        if end:
            body = text[index + 1:end - 1]
        else:
            atom = re.match(r"(?:\d+(?:\.\d+)?|[A-Za-zα-ωΑ-Ω])(?:[\^_]{[^}]*})?", text[index:])
            if not atom:
                warnings.append("source_formula_ambiguous:radical_extent")
                result.append(r"\surd ")
                continue
            end = index + len(atom[0])
            body = atom[0]
            if end < len(text) and re.match(r"[A-Za-z0-9]", text[end]):
                warnings.append("source_formula_ambiguous:radical_extent")
        result.append(r"\sqrt" + root + "{" + _radicals(body, warnings) + "}")
        index = end
    return "".join(result)


def _literal_braces(text, warnings):
    """Distinguish printed braces from LaTeX argument braces without adding any."""
    result, index = [], 0
    arities = {"frac": 2, "dfrac": 2, "tfrac": 2, "sqrt": 1, "mathrm": 1,
               "text": 1, "textbackslash": 1, "textasciicircum": 1}
    while index < len(text):
        char = text[index]
        command = re.match(r"\\([A-Za-z]+)", text[index:]) if char == "\\" else None
        if command:
            name = command[1]
            result.append(command[0])
            index += len(command[0])
            for _ in range(arities.get(name, 0)):
                gap = re.match(r"\s*", text[index:])[0]
                start = index + len(gap)
                end = _balanced_end(text, start) if start < len(text) and text[start] == "{" else None
                if end is None:
                    break
                result.append(gap + text[start:end])
                index = end
            continue
        if char in "^_":
            next_index = index + 1
            if next_index < len(text) and text[next_index] == "{":
                end = _balanced_end(text, next_index)
                if end:
                    result.append(text[index:end])
                    index = end
                    continue
            if next_index >= len(text) or text[next_index] in "{}^_":
                result.append(r"\text{\textasciicircum{}}" if char == "^" else r"\_")
                warnings.append("source_formula_ambiguous:literal_script_marker")
                index += 1
                continue
        if char in "{}":
            result.append("\\" + char)
            warnings.append("source_formula_ambiguous:literal_brace")
        else:
            result.append(char)
        index += 1
    return "".join(result)


def _latex(text, warnings):
    text = _scripts(_normal_space(text))
    # These are warnings, not automatic repairs.  The PDF can itself have lost
    # superscripts, as in x2, p47 or a widely spaced baseline "x    2".
    if re.search(r"(?<![A-Za-z\\])[A-Za-z]\s*\d", text):
        warnings.append("source_formula_ambiguous:baseline_variable_digit")
    def command_literal(match):
        if match[1] in _SAFE_COMMANDS:
            return match[0]
        warnings.append("source_formula_ambiguous:unsupported_command")
        return r"\text{\textbackslash{}" + match[1] + "}"
    text = re.sub(r"\\([A-Za-z]+)", command_literal, text)
    text = _literal_braces(text, warnings)
    text = _radicals(text, warnings)
    text = "".join(_SYMBOLS.get(c, c) for c in text)
    text = re.sub(r"(?<![A-Za-z\\])(" + "|".join(sorted(_FUNCTIONS - {"sqrt"}, key=len, reverse=True)) + r")(?![A-Za-z])", r"\\\1 ", text)
    # Explicit slash fractions have known operands.  Do not infer a larger
    # denominator: a/bx remains a/bx rather than guessing a/(bx).
    text = re.sub(r"(?<![\w.])(-?\d+(?:\.\d+)?)\s*/\s*(\d+(?:\.\d+)?)(?![\w.])",
                  lambda m: r"\frac{" + m[1] + "}{" + m[2] + "}", text)
    text = re.sub(r"(?<![A-Za-z\\])(" + "|".join(sorted(_UNITS, key=len, reverse=True)) + r")(?![A-Za-z])", r"\\mathrm{\1}", text)
    text = re.sub(r"\s*([=+<>])\s*", r"\1", text)
    text = re.sub(r"\s+", " ", text).strip()
    # A degree token without a base still renders visibly; do not invent one.
    if text.startswith(r"^{\circ}"):
        text = r"\circ " + text[len(r"^{\circ}"):]
        warnings.append("source_formula_ambiguous:detached_degree")
    return text.strip()


def _word_is_math(word, italic, section, neighbours):
    if word in _FUNCTIONS or word in _UNITS:
        return True
    if word in italic:
        return True
    if len(word) == 1:
        if word in ("a", "A", "I"):
            return bool(re.search(r"[=+*/^_<>−×≤≥]", neighbours) or
                        (section == "math" and word == "a" and re.search(r"\ba\s+is\b", neighbours)))
        return section == "math" or bool(re.search(r"[=+*/^_<>−×≤≥()]", neighbours))
    if word.isupper() and 2 <= len(word) <= 4:
        return section == "math"
    if word.lower() in _PROSE_WORDS:
        return False
    # xy-plane, polynomial products, or function variables.  Never interpret
    # arbitrary English words as strings of variables.
    return section == "math" and (word in {"xy", "xyz", "ab", "bc", "ac"} or
                                   bool(re.fullmatch(r"[a-z]{2}", word)))


def _escape_prose(text):
    text = text.replace("$", r"\$")
    text = text.replace("_", r"\_")
    # Literal source < and > must not turn into HTML in the Markdown renderer.
    return text.replace("<", "&lt;").replace(">", "&gt;")


def render_line(event, section="math"):
    """Return ``(markdown, warning_codes, formula_count)`` for one source line.

    Input spans may carry PyMuPDF ``text/font/flags/size/origin/bbox`` fields.
    A purely mathematical line is display LaTeX; formula runs in prose are
    inline LaTeX.  Bare prose numbers remain prose, while numeric-only options
    become display LaTeX.  Unknown or damaged notation is retained and flagged.
    The function does not certify source mathematical correctness.
    """
    text, italic, warnings = _span_text(event)
    text = _normal_space(_scripts(text))
    if not text:
        return "", list(dict.fromkeys(warnings)), 0
    if "\ufffd" in text or any(unicodedata.category(c) == "Co" for c in text):
        warnings.append("source_formula_ambiguous:unmapped_glyph")
    if re.search(r"\b[A-Za-z]\d+(?:centimeters|meters|inches|feet)\b", text):
        warnings.append("source_formula_ambiguous:fused_formula_and_unit")
    # Currency remains prose (including optional thousands separators), never a
    # math delimiter.  Keep its numeric token out of adjacent mathematical runs.
    currency = [(m.start(), m.end()) for m in re.finditer(r"\$\s*" + _NUMBER, text)]
    blanks = [(m.start(), m.end()) for m in re.finditer(r"_{2,}", text)]
    tokens = list(_TOKEN.finditer(text))
    candidates = []
    run = []

    def flush():
        nonlocal run
        if run:
            candidates.append(run)
            run = []

    for match in tokens:
        word = match[0]
        start, end = match.span()
        if any(a <= start < b for a, b in currency + blanks):
            flush()
            continue
        previous_end = run[-1].end() if run else start
        gap = text[previous_end:start]
        if gap.strip():
            flush()
        if word.startswith("\\") and word[1:] not in _SAFE_COMMANDS:
            warnings.append("source_formula_ambiguous:unsupported_command")
        is_word = re.fullmatch(r"[A-Za-z]+", word)
        neighbours = text[max(0, start - 2):min(len(text), end + 2)]
        neighbours = re.sub(r"_{2,}", " ", neighbours)
        if any(0 <= start - blank_end <= 2 for _, blank_end in blanks):
            neighbours = neighbours.replace("_", " ")
        if word == "a" and re.match(r"\s+is\b", text[end:]):
            neighbours += " a is"
        active_italic = italic
        # An italic variable elsewhere in the line does not make the article
        # in "a constant" mathematical.  Source PDFs commonly mix both.
        if word == "a" and re.match(r"\s+(?!(?:is|and|or|equals|represents)\b)[A-Za-z]{2,}\b", text[end:]):
            active_italic = italic - {"a"}
        run_text = text[run[0].start():start] if run else ""
        in_script = bool(re.search(r"[\^_]\{[^}]*$", run_text))
        if is_word and not in_script and not _word_is_math(word, active_italic, section, neighbours):
            flush()
            continue
        # Only decimal punctuation belongs to a token itself.  Commas and full
        # stops in prose terminate a formula unless inside coordinate brackets.
        if word in ",.:" and not any(t[0] in "([{ " for t in run):
            flush()
            continue
        run.append(match)
    flush()
    ranges = []
    for run in candidates:
        start, end = run[0].start(), run[-1].end()
        value = text[start:end]
        # Remove hanging operators/brackets that connect to prose (x-axis).
        while value and value[-1] in "+-−–*/=<>:,.":
            value = value[:-1].rstrip()
            end = start + len(value)
        while value and value[0] in ",.:=":
            start += 1
            value = value[1:].lstrip()
            start = end - len(value)
        if not value or not re.search(r"[A-Za-z0-9\u0370-\u03ff°∘∞∠△√∛∜]", value):
            continue
        pure_number = re.fullmatch(_NUMBER, value)
        if pure_number and (start != 0 or end != len(text)):
            continue
        coordinates = re.fullmatch(r"\(\s*-?" + _NUMBER + r"\s*,\s*-?" + _NUMBER + r"\s*\)", value)
        if re.fullmatch(r"\d{4}[-–]\d{2,4}", value) and (start != 0 or end != len(text)):
            continue
        if not (_MATH_SIGNALS.search(value) or re.search(r"[A-Za-z]", value) or pure_number or coordinates):
            continue
        # A prose parenthesis around a variable is part of the formula only when
        # both delimiters were present on this source line.
        if value.count("(") != value.count(")") or value.count("[") != value.count("]"):
            warnings.append("source_formula_ambiguous:unbalanced_group")
        ranges.append((start, end, _latex(value, warnings)))
    if not ranges:
        return _escape_prose(text), list(dict.fromkeys(warnings)), 0
    if len(ranges) == 1 and ranges[0][0] == 0 and ranges[0][1] == len(text):
        return "$$" + ranges[0][2] + "$$", list(dict.fromkeys(warnings)), 1
    output, position = [], 0
    for start, end, latex in ranges:
        output.append(_escape_prose(text[position:start]))
        output.append("$" + latex + "$")
        position = end
    output.append(_escape_prose(text[position:]))
    return "".join(output), list(dict.fromkeys(warnings)), len(ranges)
