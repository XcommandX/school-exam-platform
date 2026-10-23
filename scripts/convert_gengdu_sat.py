#!/usr/bin/env python3
"""Convert an authorized local Gengdu export to SAT draft packs, offline.

Python 3.10+, standard library only. Reads question content and declared standard
answers, never personal answer fields. Does not execute HTML or fetch resources.
Original JSON is unchanged. Existing output is refused unless --replace is used.
"""
from __future__ import annotations

import argparse
import base64
from collections import Counter
from dataclasses import dataclass, field
from fractions import Fraction
import hashlib
import html
from html.parser import HTMLParser
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import tempfile
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
COLLECTION_ID = "gengdu-2026-03-us-a"
PACKS = ("rw-single-choice", "math-single-choice", "math-spr")
PROFILE = {"id": "sat-spr-input/0.1-draft", "status": "requires-rule-review",
           "maxNonnegativeCharacters": 5, "maxNegativeCharacters": 6,
           "allowedForms": ["integer", "decimal", "fraction"], "allowMixedNumber": False}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
FORBIDDEN = {"script", "style", "iframe", "object", "embed", "svg", "math"}
ZERO_WIDTH = re.compile("[\u200b-\u200d\ufeff]")


class ConversionError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ConversionError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, document):
    path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def source_info(collection_id, question_id=None, *, url=None, kind="gengdu-export"):
    value = {"kind": kind, "sourceSetId": collection_id}
    if question_id is not None:
        value["sourceQuestionId"] = str(question_id)
    if url:
        parts = urlsplit(url)
        require(parts.scheme in ("http", "https") and parts.hostname and not parts.username and not parts.password,
                "Source URL must be an ordinary HTTP(S) URL")
        value["url"] = url
    return value


@dataclass
class Node:
    tag: str = ""
    attrs: dict = field(default_factory=dict)
    children: list = field(default_factory=list)


class FragmentParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        require(tag not in FORBIDDEN, f"Unsupported active/foreign HTML element: {tag}")
        node = Node(tag, dict(attrs))
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)

    def handle_decl(self, decl):
        raise ConversionError("HTML declarations are not question content")


def parse_fragment(value):
    parser = FragmentParser()
    parser.feed(value)
    parser.close()
    return parser.root


def clean_text(value):
    return ZERO_WIDTH.sub("", str(value)).replace("\u2212", "-")


def escape_markdown(value):
    value = clean_text(value).replace("\xa0", " ")
    value = re.sub(r"[\t\r\n]+", " ", value)
    value = re.sub(r"([\\`*{}\[\]_$])", r"\\\1", value)
    return value.replace("<", "&lt;").replace(">", "&gt;")


def image_type(data):
    if data.startswith(b"\x89PNG\r\n\x1a\n") and len(data) >= 24 and data[12:16] == b"IHDR":
        return "image/png", ".png"
    if data.startswith(b"\xff\xd8\xff") and b"\xff\xd9" in data:
        return "image/jpeg", ".jpg"
    if data[:6] in (b"GIF87a", b"GIF89a") and len(data) >= 13:
        return "image/gif", ".gif"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp", ".webp"
    raise ConversionError("Source image is not a supported verified raster image")


class Resources:
    def __init__(self, document, archive):
        self.embedded = {}
        for image in document.get("images", []):
            url = image.get("source_url")
            require(isinstance(url, str) and url, "Image metadata has no source_url")
            require(url not in self.embedded, "Duplicate image source metadata")
            self.embedded[url] = image
        self.archive = Path(archive) if archive else None
        self.archived = {}
        if self.archive and (self.archive / "图片清单.json").is_file():
            manifest = json.loads((self.archive / "图片清单.json").read_text(encoding="utf-8"))
            self.archived = {image["source_url"]: image for image in manifest.get("images", [])}
        self.used = set()

    def read(self, url):
        require(isinstance(url, str) and url, "Image has no source")
        metadata = self.embedded.get(url, {})
        encoded = metadata.get("data_base64")
        if encoded:
            require(isinstance(encoded, str) and len(encoded) <= 48 * 1024 * 1024, "Embedded image exceeds limit")
            try:
                data = base64.b64decode(encoded, validate=True)
            except (ValueError, TypeError) as exc:
                raise ConversionError("Invalid embedded base64 image") from exc
        else:
            saved = self.archived.get(url, {})
            relative = saved.get("local_path", "")
            parts = PurePosixPath(relative).parts
            require(self.archive and parts and parts[0] == "assets" and not PurePosixPath(relative).is_absolute()
                    and not any(part in (".", "..") for part in parts) and "\\" not in relative,
                    "Missing image: no verified embedded or archived bytes")
            path = self.archive.joinpath(*parts)
            require(not any(self.archive.joinpath(*parts[:i]).is_symlink() for i in range(1, len(parts) + 1))
                    and path.is_file() and path.resolve().is_relative_to(self.archive.resolve()), "Unsafe/missing archived image")
            data = path.read_bytes()
            expected = saved.get("sha256")
            require(expected and sha(data) == expected, "Archived image SHA-256 mismatch")
        mime, extension = image_type(data)
        if metadata.get("sha256"):
            require(sha(data) == metadata["sha256"], "Embedded image SHA-256 mismatch")
        if metadata.get("mime_type"):
            require(mime == metadata["mime_type"], "Image MIME/signature mismatch")
        self.used.add(url)
        return data, mime, extension


class PackBuilder:
    def __init__(self, name, collection_id, title, resources, report, source_url):
        self.name, self.collection_id = name, collection_id
        self.resources, self.report, self.source_url = resources, report, source_url
        section = "reading-writing" if name.startswith("rw-") else "math"
        response = "student-produced-response" if name == "math-spr" else "single-choice"
        self.pack = {"schemaVersion": "sat-question-pack/0.1-draft", "documentType": "sat-question-pack", "status": "draft",
                     "exam": "sat", "id": f"sat:pack:{collection_id}-{name}", "revision": 1, "title": f"{title} · {name}",
                     "section": section, "responseType": response, "contentFormat": "markdown-latex/0.1-draft",
                     "files": {"items": "items.json", "solutions": "solutions.json"}, "assets": []}
        if response == "student-produced-response":
            self.pack["inputProfile"] = dict(PROFILE)
        self.items, self.solutions, self.asset_bytes = [], [], {}

    def asset(self, data, mime, extension, source):
        digest = sha(data)
        asset_id = "asset-" + digest
        if asset_id not in self.asset_bytes:
            path = "assets/" + digest + extension
            self.asset_bytes[asset_id] = (path, data)
            self.pack["assets"].append({"id": asset_id, "path": path, "mediaType": mime, "sha256": digest,
                                        "byteLength": len(data), "source": source})
        return asset_id

    def image(self, node, question_id):
        url = node.attrs.get("src")
        try:
            data, mime, extension = self.resources.read(url)
        except ConversionError as exc:
            raise ConversionError(f"Question {question_id}: resource {url!r}: {exc}") from exc
        asset_id = self.asset(data, mime, extension, source_info(self.collection_id, url=url, kind="gengdu-source-image"))
        self.report["imageReferences"] += 1
        alt = clean_text(node.attrs.get("alt", "")).strip()
        if not alt:
            alt = "Source question figure."
            self.report["missingSourceAltText"] += 1
        return {"type": "image", "assetId": asset_id, "role": "illustration", "alt": alt}

    def table(self, node, question_id):
        rows = []
        def cell_text(value):
            if isinstance(value, str):
                return clean_text(value).replace("\xa0", " ")
            require(value.tag not in ("img", "table", "sup", "sub") and "latex-data" not in value.attrs,
                    "Complex table needs a dedicated reviewed conversion; not flattened")
            return "".join(cell_text(child) for child in value.children)
        def scan(value):
            if not isinstance(value, Node):
                return
            if value.tag == "tr":
                cells = [child for child in value.children if isinstance(child, Node) and child.tag in ("td", "th")]
                require(cells, "Table row has no cells")
                row = []
                for cell in cells:
                    require(cell.attrs.get("rowspan", "1") == "1" and cell.attrs.get("colspan", "1") == "1",
                            "Merged table cells require reviewed conversion")
                    content = re.sub(r"\s+", " ", cell_text(cell)).strip()
                    require(content, "Empty table cell requires review")
                    italic = any(isinstance(child, Node) and child.tag in ("em", "i") for child in cell.children)
                    row.append((content, italic))
                rows.append(row)
            else:
                for child in value.children:
                    scan(child)
        scan(node)
        require(rows and len({len(row) for row in rows}) == 1, "Ragged table requires reviewed conversion")
        columns = len(rows[0])
        widths = [max(58, max(len(row[col][0]) for row in rows) * 12 + 24) for col in range(columns)]
        total_width = sum(widths)
        match = re.search(r"(?:^|;)\s*width\s*:\s*([0-9]+)px", node.attrs.get("style", ""))
        if match and total_width < int(match.group(1)) <= 1000:
            widths = [width * int(match.group(1)) / total_width for width in widths]
        width, height = sum(widths), len(rows) * 40
        parts = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:g}" height="{height:g}" viewBox="0 0 {width:g} {height:g}">',
                 '<rect width="100%" height="100%" fill="white"/>', '<g stroke="#222" stroke-width="1" fill="none">']
        x = 0
        for size in widths + [0]:
            parts.append(f'<path d="M{x:g} 0V{height:g}"/>')
            x += size
        for row_index in range(len(rows) + 1):
            parts.append(f'<path d="M0 {row_index * 40}H{width:g}"/>')
        parts.append('</g><g font-family="Times New Roman,serif" font-size="20" fill="#222" text-anchor="middle">')
        for row_index, row in enumerate(rows):
            x = 0
            for col_index, (value, italic) in enumerate(row):
                style = ' font-style="italic"' if italic else ''
                parts.append(f'<text x="{x + widths[col_index] / 2:g}" y="{row_index * 40 + 27}"{style}>{html.escape(value)}</text>')
                x += widths[col_index]
        parts.append('</g></svg>')
        data = "".join(parts).encode("utf-8")
        asset_id = self.asset(data, "image/svg+xml", ".svg", source_info(self.collection_id, question_id, url=self.source_url, kind="source-html-table-conversion"))
        cells = [[value for value, italic in row] for row in rows]
        self.report["tableConversions"].append({"sourceQuestionId": question_id, "rows": cells,
                                                  "method": "static-svg-from-explicit-html-cells", "assetId": asset_id})
        return {"type": "image", "assetId": asset_id, "role": "table", "alt": "Table: " + "; ".join(" | ".join(row) for row in cells)}

    def content(self, html_value, plain_value, question_id):
        source = html_value if isinstance(html_value, str) and html_value.strip() else html.escape(str(plain_value or ""))
        if not source.strip():
            return []
        fragment = parse_fragment(source)
        blocks, pending = [], []
        def flush():
            value = "".join(pending)
            value = re.sub(r"\n(?:[ \t]*\n){2,}", "\n\n", value).strip()
            value = re.sub(r" +$", "", value)
            pending.clear()
            if value:
                blocks.append({"type": "markdown", "text": value})
        def flatten(value):
            if isinstance(value, str):
                return clean_text(value)
            return "".join(flatten(child) for child in value.children)
        def render(value):
            if isinstance(value, str):
                pending.append(escape_markdown(value))
                return
            if "latex-data" in value.attrs:
                latex = clean_text(value.attrs["latex-data"]).strip()
                require(latex and "$" not in latex and not re.search(r"\\(?:href|url|html\w*|includegraphics|input|def|newcommand|require)\b", latex),
                        "Unsafe or empty LaTeX source")
                pending.append("$" + latex + "$")
                self.report["latexFragments"] += 1
                def count_textareas(node):
                    return (int(node.tag == "textarea") + sum(count_textareas(child) for child in node.children if isinstance(child, Node)))
                self.report["discardedEditorTextareas"] += count_textareas(value)
                return  # The whole MathQuill tree, including hidden textarea, is discarded.
            if value.tag == "textarea":
                self.report["discardedEditorTextareas"] += 1
                return
            require("mq-math-mode" not in value.attrs.get("class", ""), "MathQuill expression has no reliable latex-data")
            if value.tag == "img":
                flush()
                blocks.append(self.image(value, question_id))
                return
            if value.tag == "table":
                flush()
                blocks.append(self.table(value, question_id))
                return
            if value.tag in ("sup", "sub"):
                literal = flatten(value).strip()
                require(re.fullmatch(r"[A-Za-z0-9+() -]+", literal or ""), "Unsupported superscript/subscript")
                pending.append("$" + ("^" if value.tag == "sup" else "_") + "{" + literal + "}$")
                self.report["superscriptSubscriptFragments"] += 1
                return
            if value.tag == "br":
                pending.append("  \n")
                return
            if value.tag == "hr":
                pending.append("\n\n---\n\n")
                return
            wrappers = {"u": ("<u>", "</u>"), "b": ("**", "**"), "strong": ("**", "**"),
                        "i": ("*", "*"), "em": ("*", "*"), "var": ("*", "*")}
            opening, closing = wrappers.get(value.tag, ("", ""))
            if value.tag == "u" and not flatten(value).strip():
                pending.append("<u>" + "\xa0" * max(6, min(30, len(flatten(value)))) + "</u>")
                return
            def has_media(node):
                return isinstance(node, Node) and (node.tag in ("img", "table") or any(has_media(child) for child in node.children))
            if opening and not has_media(value):
                start = len(pending)
                for child in value.children:
                    render(child)
                inner = "".join(pending[start:])
                del pending[start:]
                leading = re.match(r"^\s*", inner).group()
                trailing = re.search(r"\s*$", inner).group()
                core = inner.strip()
                pending.append(leading + (opening + core + closing if core else "") + trailing)
                return
            opening = closing = ""  # Media remain typed blocks, never put images inside raw HTML.
            if value.tag in ("p", "div", "blockquote", "ul", "ol"):
                pending.append("\n\n")
            if value.tag == "li":
                pending.append("\n" + value.attrs.get("_conversion-list-marker", "- "))
            if value.tag == "blockquote":
                pending.append("> ")
            pending.append(opening)
            list_index = 0
            for child in value.children:
                if value.tag == "ol" and isinstance(child, Node) and child.tag == "li":
                    list_index += 1
                    child.attrs["_conversion-list-marker"] = str(list_index) + ". "
                render(child)
            pending.append(closing)
            if value.tag in ("p", "div", "blockquote", "ul", "ol"):
                pending.append("\n\n")
        render(fragment)
        flush()
        return blocks

    def save(self, root):
        root.mkdir()
        (root / "assets").mkdir()
        for path, data in self.asset_bytes.values():
            (root / path).write_bytes(data)
        write_json(root / "pack.json", self.pack)
        write_json(root / "items.json", {"items": self.items})
        write_json(root / "solutions.json", {"visibility": "authoring-only", "solutions": self.solutions})


def spr_answer(value):
    rationals, decimals = [], []
    for token in str(value).split(","):
        token = clean_text(token).strip()
        require(re.fullmatch(r"-?(?:[0-9]+(?:/[0-9]+)?|[0-9]*\.[0-9]+)", token or ""), "Unsupported SPR standard answer")
        try:
            rational = Fraction(token)
        except (ValueError, ZeroDivisionError) as exc:
            raise ConversionError("Invalid SPR standard answer") from exc
        if "." in token:
            require(len(token) <= (6 if token.startswith("-") else 5), "Source decimal answer violates draft input limit")
            if token not in decimals:
                decimals.append(token)
        else:
            canonical = str(rational)
            if canonical not in rationals:
                rationals.append(canonical)
    return {"status": "needs-review", "type": "student-produced-response", "comparison": "exact-rational-or-listed-decimal",
            "acceptedRationals": rationals, "acceptedDecimalSpellings": decimals}


def load_validator():
    path = ROOT / "docs/drafts/sat-question-packs/validate_examples.py"
    spec = importlib.util.spec_from_file_location("sat_draft_validation", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def convert_document(document, output, *, collection_id=COLLECTION_ID, archive=None, source_sha256=None, replace=False):
    require(re.fullmatch(r"[a-z0-9][a-z0-9-]*", collection_id or ""), "Unsafe collection ID")
    output = Path(output)
    require(not output.is_symlink(), "Output must not be a symbolic link")
    require(not output.exists() or replace, "Output exists; use --replace to replace this generated collection")
    questions = document.get("questions")
    require(isinstance(questions, list) and len(questions) == 98, "Full SAT conversion requires exactly 98 source questions")
    require(document.get("question_count", 98) == 98 and document.get("expected_question_count", 98) == 98,
            "Source count declarations disagree")
    title = str(document.get("title", "SAT source collection"))
    source_url = document.get("source")
    source_info(collection_id, url=source_url)
    resources = Resources(document, archive)
    report = {"collectionId": collection_id, "sourceSha256": source_sha256, "sourceUnmodified": True,
              "questionCount": 98, "imageReferences": 0, "latexFragments": 0, "superscriptSubscriptFragments": 0,
              "discardedEditorTextareas": 0, "missingSourceAltText": 0, "tableConversions": [], "reviewNotes": [],
              "answerStatus": {"needs-review": 98}, "explanationsMissing": 0, "sourceOrder": []}
    builders = {name: PackBuilder(name, collection_id, title, resources, report, source_url) for name in PACKS}
    groups = {}
    seen = set()
    for question in questions:
        question_id = str(question.get("question_id", ""))
        require(re.fullmatch(r"[A-Za-z0-9._:-]+", question_id or ""), "Missing/unsafe stable source question ID")
        require(question_id not in seen, "Duplicate source question ID")
        seen.add(question_id)
        part, module, number = question.get("part_type"), question.get("module_number"), question.get("number")
        require(part in ("ReadingAndWriting", "Math") and type(module) is int and module in (1, 2)
                and type(number) is int and number >= 1, "Unsupported section/module/question position")
        section = "reading-writing" if part == "ReadingAndWriting" else "math"
        response = question.get("question_type")
        require(response in ("choice", "response") and (section == "math" or response == "choice"), "Unsupported source response type")
        name = "rw-single-choice" if section == "reading-writing" else "math-single-choice" if response == "choice" else "math-spr"
        builder = builders[name]
        item_id = "sat:item:gengdu-" + question_id
        item = {"id": item_id, "revision": 1, "classification": {"skill": "Unclassified"},
                "content": builder.content(question.get("passage_html"), question.get("passage_text"), question_id),
                "prompt": builder.content(question.get("prompt_html"), question.get("prompt_text"), question_id),
                "source": source_info(collection_id, question_id, url=source_url)}
        require(item["prompt"], "Question prompt is empty")
        standard = question.get("correct_answer")
        answer = {"status": "missing", "type": builder.pack["responseType"]}
        if response == "choice":
            choices = question.get("choices")
            require(isinstance(choices, list) and len(choices) == 4 and [choice.get("label") for choice in choices] == list("ABCD"),
                    "Choice question needs four source labels A/B/C/D")
            item["options"] = [{"id": "choice-" + choice["label"].lower(),
                                "content": builder.content(choice.get("html"), choice.get("text"), question_id)} for choice in choices]
            require(all(option["content"] for option in item["options"]), "Empty option")
            serialized = [json.dumps(option["content"], sort_keys=True) for option in item["options"]]
            if len(set(serialized)) < len(serialized):
                report["reviewNotes"].append({"sourceQuestionId": question_id, "issue": "duplicate-converted-choice-content",
                                               "policy": "preserve-source-latex-data-do-not-guess-correction"})
            if standard is not None and str(standard).strip():
                require(str(standard).strip() in "ABCD" and len(str(standard).strip()) == 1, "Unknown standard choice label")
                answer = {"status": "needs-review", "type": "single-choice", "optionId": "choice-" + str(standard).strip().lower()}
        elif standard is not None and str(standard).strip():
            answer = spr_answer(standard)
        explanation = builder.content(question.get("explanation_html"), question.get("explanation_text"), question_id)
        if not explanation:
            report["explanationsMissing"] += 1
        builder.items.append(item)
        builder.solutions.append({"itemId": item_id, "itemRevision": 1, "answer": answer,
                                  "explanation": {"status": "needs-review" if explanation else "missing", "content": explanation},
                                  "provenance": source_info(collection_id, question_id, url=source_url, kind="gengdu-source-standard-answer")})
        ref = {"packId": builder.pack["id"], "packRevision": 1, "itemId": item_id, "itemRevision": 1}
        groups.setdefault((section, module), []).append((number, ref))
        report["sourceOrder"].append({"sourceQuestionId": question_id, "section": section, "moduleNumber": module,
                                       "number": number, **ref})
    modules = []
    for section in ("reading-writing", "math"):
        for module in (1, 2):
            entries = sorted(groups.get((section, module), []), key=lambda pair: pair[0])
            expected = 27 if section == "reading-writing" else 22
            require([number for number, ref in entries] == list(range(1, expected + 1)), "Missing/duplicate original module positions")
            modules.append({"section": section, "moduleNumber": module, "durationSeconds": 1920 if section == "reading-writing" else 2100,
                            "questionCount": len(entries), "items": [ref for number, ref in entries]})
    assessment = {"title": title, "fullSAT": True, "breakDurationSeconds": 600, "questionCount": len(questions),
                  "sections": [{"section": section, "moduleCount": 2,
                                "questionCount": sum(len(module["items"]) for module in modules if module["section"] == section)}
                               for section in ("reading-writing", "math")], "modules": modules}
    report["modules"] = [{"section": module["section"], "moduleNumber": module["moduleNumber"], "questionCount": len(module["items"]),
                            "durationSeconds": module["durationSeconds"]} for module in modules]
    report["packs"] = {name: {"questionCount": len(builder.items), "assetCount": len(builder.pack["assets"])} for name, builder in builders.items()}
    report["uniqueOriginalImages"] = len(resources.used)
    report["answerStatus"] = dict(Counter(solution["answer"]["status"] for builder in builders.values() for solution in builder.solutions))
    report["reviewNotes"].extend([
        {"issue": "all-source-standard-answers-unreviewed", "policy": "confirmed-remains-needs-review-no-certified-grading"},
        {"issue": "table-rendering-provisional", "policy": "two-or-other-simple-explicit-cell-tables-use-static-svg-no-guessed-data"},
        {"issue": "missing-original-image-alt", "count": report["missingSourceAltText"], "policy": "neutral-alt-no-inferred-answer-description"}])
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".sat-conversion-", dir=output.parent))
    try:
        for name, builder in builders.items():
            builder.save(temporary / name)
        write_json(temporary / "assessment.json", assessment)
        write_json(temporary / "conversion-report.json", report)
        load_validator().validate_packs([temporary / name for name in PACKS])
        if output.exists():
            previous = output.parent / ("." + output.name + ".previous-conversion")
            require(not previous.exists(), "Previous conversion backup exists; preserve/review it before replacing")
            output.rename(previous)
            try:
                temporary.rename(output)
            except OSError:
                previous.rename(output)
                raise
            shutil.rmtree(previous)
        else:
            temporary.rename(output)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "耕读合集/测试/26年3月美国A卷.json")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--collection-id", default=COLLECTION_ID)
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--activate", action="store_true", help="Write active.json beside the generated collection")
    args = parser.parse_args()
    data = args.source.read_bytes()
    output = args.output or ROOT / "private-data/sat-packs" / args.collection_id
    report = convert_document(json.loads(data), output, collection_id=args.collection_id,
                              archive=args.archive or args.source.parent.parent, source_sha256=sha(data), replace=args.replace)
    require(sha(args.source.read_bytes()) == sha(data), "Source changed during conversion")
    if args.activate:
        require(output.name == args.collection_id, "Active collection must use its ID as its direct directory name")
        write_json(output.parent / "active.json", {"collectionId": args.collection_id, "root": args.collection_id})
    summary = {key: report[key] for key in ("collectionId", "questionCount", "modules", "packs", "uniqueOriginalImages", "imageReferences", "latexFragments", "superscriptSubscriptFragments", "explanationsMissing", "reviewNotes")}
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
