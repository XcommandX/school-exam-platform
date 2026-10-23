"""Validate the SAT-only draft examples, not a production import protocol.

This module does not render Markdown/LaTeX or change the existing SAT engine.
Its SPR helper demonstrates exact rational comparison and reviewed decimal
spellings; the draft input profile still requires examination-rule review.
"""

from __future__ import annotations

import argparse
import hashlib
import json
from fractions import Fraction
from html.parser import HTMLParser
from pathlib import Path, PurePosixPath
import re


class DraftValidationError(ValueError):
    """A draft example violates its declared structure or references."""


def _require(condition, message):
    if not condition:
        raise DraftValidationError(message)


def _shape(value, required, optional=(), context="object"):
    _require(isinstance(value, dict), f"{context}: expected object")
    _require(set(required) <= value.keys(), f"{context}: missing required fields")
    unknown = value.keys() - set(required) - set(optional)
    _require(not unknown, f"{context}: unsupported fields {sorted(unknown)}")


def _text(value, context):
    _require(isinstance(value, str) and bool(value.strip()), f"{context}: expected nonempty text")


def _revision(value, context):
    _require(type(value) is int and value >= 1, f"{context}: revision must be a positive integer")


def _identifier(value, prefix, context):
    _require(isinstance(value, str) and re.fullmatch(re.escape(prefix) + r"[A-Za-z0-9][A-Za-z0-9._:-]*", value),
             f"{context}: invalid stable identifier")


def _unique(pairs):
    result = {}
    for key, value in pairs:
        _require(key not in result, f"JSON: duplicate key {key}")
        result[key] = value
    return result


def _json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=_unique)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise DraftValidationError(f"Cannot read JSON {path.name}: {exc}") from exc


def _local_path(root, name, *, asset=False):
    _text(name, "file path")
    parts = name.split("/")
    _require(not any(c in name for c in "\\\x00:%?#") and all(p not in ("", ".", "..") for p in parts),
             "file path: must be a safe local relative path")
    relative = PurePosixPath(name)
    _require(not relative.is_absolute(), "file path: absolute paths are forbidden")
    if asset:
        _require(len(parts) >= 2 and parts[0] == "assets", "asset path must be under assets/")
    current = root
    for part in parts:
        current = current / part
        _require(not current.is_symlink(), "file path: symbolic links are not supported")
    _require(current.is_file(), f"file path: missing file {name}")
    _require(current.resolve().is_relative_to(root.resolve()), "file path escapes the pack")
    return current


class _MarkdownHTML(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.underlines = 0

    def handle_starttag(self, tag, attrs):
        _require(tag == "u" and not attrs and self.get_starttag_text() == "<u>",
                 "Markdown: only literal <u> and </u> raw HTML is allowed")
        self.underlines += 1

    def handle_endtag(self, tag):
        _require(tag == "u" and self.underlines > 0, "Markdown: unsupported or unbalanced HTML")
        self.underlines -= 1

    def handle_startendtag(self, tag, attrs):
        raise DraftValidationError("Markdown: self-closing HTML is unsupported")

    def handle_comment(self, data):
        raise DraftValidationError("Markdown: HTML comments are unsupported")

    def handle_decl(self, decl):
        raise DraftValidationError("Markdown: HTML declarations are unsupported")

    def handle_pi(self, data):
        raise DraftValidationError("Markdown: processing instructions are unsupported")


def _markdown(text):
    _text(text, "Markdown")
    # Images belong in typed image blocks so every reference reaches the manifest.
    _require(not re.search(r"!\s*\[", text), "Markdown: use an image block instead of Markdown images")
    # Reject case/whitespace variants too; the sole extension is the exact pair.
    for raw_tag in re.findall(r"<\s*/?\s*[A-Za-z][^>]*>", text):
        _require(raw_tag in ("<u>", "</u>"), "Markdown: unsupported raw HTML")
    parser = _MarkdownHTML()
    parser.feed(text)
    parser.close()
    _require(parser.underlines == 0, "Markdown: unclosed <u>")


def _source(value, context):
    _shape(value, {"kind"}, {"url", "sourceSetId", "sourceQuestionId"}, context=context)
    _text(value["kind"], f"{context}.kind")
    for field in ("url", "sourceSetId", "sourceQuestionId"):
        if field in value:
            _text(value[field], f"{context}.{field}")


def _content(blocks, assets, *, allow_empty=False):
    _require(isinstance(blocks, list) and (allow_empty or bool(blocks)), "content: expected block array")
    for block in blocks:
        _require(isinstance(block, dict), "content block: expected object")
        if block.get("type") == "markdown":
            _shape(block, {"type", "text"}, context="Markdown block")
            _markdown(block["text"])
        elif block.get("type") == "image":
            _shape(block, {"type", "assetId", "alt"}, {"role", "caption"}, context="image block")
            _require(isinstance(block["assetId"], str) and block["assetId"] in assets, "image: unknown assetId")
            _text(block["alt"], "image.alt")
            for field in ("role", "caption"):
                if field in block:
                    _text(block[field], f"image.{field}")
            if "role" in block:
                _require(block["role"] in ("illustration", "table", "chart", "coordinate-plane", "geometry"),
                         "image: unsupported role")
        else:
            raise DraftValidationError("content: only markdown and image blocks are supported in this draft")


def _input_profile(profile):
    _shape(profile, {"id", "status", "maxNonnegativeCharacters", "maxNegativeCharacters", "allowedForms", "allowMixedNumber"},
           context="inputProfile")
    _require(profile["id"] == "sat-spr-input/0.1-draft" and profile["status"] == "requires-rule-review",
             "inputProfile: must retain draft/requires-rule-review status")
    _require(type(profile["maxNonnegativeCharacters"]) is int and profile["maxNonnegativeCharacters"] == 5
             and type(profile["maxNegativeCharacters"]) is int and profile["maxNegativeCharacters"] == 6,
             "inputProfile: this draft uses 5 nonnegative / 6 negative characters")
    _require(profile["allowedForms"] == ["integer", "decimal", "fraction"] and profile["allowMixedNumber"] is False,
             "inputProfile: unsupported draft input forms")


def validate_spr_input(response, profile):
    """Return an exact Fraction for a syntactically valid draft SPR response."""
    _input_profile(profile)
    _require(isinstance(response, str), "SPR response must be a string")
    limit = profile["maxNegativeCharacters"] if response.startswith("-") else profile["maxNonnegativeCharacters"]
    _require(0 < len(response) <= limit, "SPR response exceeds its character limit")
    _require(re.fullmatch(r"-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+|[0-9]+/[0-9]+)", response),
             "SPR response: use one integer, decimal, or fraction without spaces/units")
    try:
        return Fraction(response)
    except (ValueError, ZeroDivisionError) as exc:
        raise DraftValidationError("SPR response: invalid numeric value") from exc


def _spr_answer(answer, profile):
    _require(answer["comparison"] == "exact-rational-or-listed-decimal", "SPR: unsupported comparison")
    rationals, decimals = answer["acceptedRationals"], answer["acceptedDecimalSpellings"]
    _require(isinstance(rationals, list) and isinstance(decimals, list) and bool(rationals or decimals),
             "SPR: at least one accepted value is required")
    values = []
    for literal in rationals:
        _require(isinstance(literal, str) and re.fullmatch(r"-?[0-9]+(?:/[0-9]+)?", literal),
                 "SPR: acceptedRationals must contain integer/fraction strings")
        try:
            values.append(Fraction(literal))
        except (ValueError, ZeroDivisionError) as exc:
            raise DraftValidationError("SPR: invalid accepted rational") from exc
    _require(len(values) == len(set(values)), "SPR: duplicate rational values")
    _require(all(isinstance(literal, str) for literal in decimals) and len(decimals) == len(set(decimals)),
             "SPR: duplicate or invalid decimal spellings")
    for literal in decimals:
        _require("." in literal, "SPR: decimal spelling must be a decimal")
        validate_spr_input(literal, profile)


def spr_response_matches(response, answer, profile):
    """Demonstrate draft comparison; this is not connected to the SAT engine."""
    if answer.get("status") != "verified":
        return False
    _spr_answer(answer, profile)
    try:
        value = validate_spr_input(response, profile)
    except DraftValidationError:
        return False
    return (value in {Fraction(v) for v in answer["acceptedRationals"]}
            or response in answer["acceptedDecimalSpellings"])


def validate_pack(path):
    """Validate one directory (or pack.json) and return its identity summary."""
    path = Path(path)
    root = path if path.is_dir() else path.parent
    pack = _json(_local_path(root, "pack.json"))
    _shape(pack, {"schemaVersion", "documentType", "status", "exam", "id", "revision", "title", "section",
                  "responseType", "contentFormat", "files", "assets"}, {"inputProfile"}, context="pack")
    _require(pack["schemaVersion"] == "sat-question-pack/0.1-draft" and pack["documentType"] == "sat-question-pack"
             and pack["status"] == "draft" and pack["exam"] == "sat", "pack: expected SAT draft protocol")
    _require(pack["contentFormat"] == "markdown-latex/0.1-draft", "pack: unsupported contentFormat")
    _identifier(pack["id"], "sat:pack:", "pack.id")
    _revision(pack["revision"], "pack")
    _text(pack["title"], "pack.title")
    _require(isinstance(pack["section"], str) and isinstance(pack["responseType"], str)
             and (pack["section"], pack["responseType"]) in {
        ("reading-writing", "single-choice"), ("math", "single-choice"), ("math", "student-produced-response")},
        "pack: unsupported section/responseType combination")
    spr = pack["responseType"] == "student-produced-response"
    _require(("inputProfile" in pack) == spr, "pack: inputProfile belongs only to SPR packs")
    if spr:
        _input_profile(pack["inputProfile"])
    _shape(pack["files"], {"items", "solutions"}, context="files")
    items = _json(_local_path(root, pack["files"]["items"]))
    solutions = _json(_local_path(root, pack["files"]["solutions"]))
    _shape(items, {"items"}, context="items document")
    _shape(solutions, {"visibility", "solutions"}, context="solutions document")
    _require(solutions["visibility"] == "authoring-only", "solutions: expected authoring-only")
    assets = set()
    asset_digests = {}
    paths = set()
    _require(isinstance(pack["assets"], list), "assets: expected array")
    for asset in pack["assets"]:
        _shape(asset, {"id", "path", "mediaType", "sha256", "byteLength", "source"}, context="asset")
        _identifier(asset["id"], "", "asset.id")
        _text(asset["path"], "asset.path")
        _require(asset["id"] not in assets and asset["path"] not in paths, "assets: duplicate id or path")
        assets.add(asset["id"])
        paths.add(asset["path"])
        extension_types = {".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                           ".webp": "image/webp", ".gif": "image/gif"}
        resource = _local_path(root, asset["path"], asset=True)
        _require(extension_types.get(resource.suffix.lower()) == asset["mediaType"], "asset: unsupported MIME/extension")
        data = resource.read_bytes()
        _require(type(asset["byteLength"]) is int and asset["byteLength"] > 0 and asset["byteLength"] == len(data),
                 "asset: byteLength mismatch")
        _require(isinstance(asset["sha256"], str) and re.fullmatch(r"[0-9a-f]{64}", asset["sha256"])
                 and hashlib.sha256(data).hexdigest() == asset["sha256"], "asset: sha256 mismatch")
        _source(asset["source"], "asset.source")
        asset_digests[asset["id"]] = asset["sha256"]
    _require(isinstance(items["items"], list) and bool(items["items"]), "items: expected nonempty array")
    item_index = {}
    for item in items["items"]:
        required = {"id", "revision", "classification", "content", "prompt", "source"} | (set() if spr else {"options"})
        _shape(item, required, context="item")
        _identifier(item["id"], "sat:item:", "item.id")
        _require(item["id"] not in item_index, "items: duplicate stable itemId")
        item_index[item["id"]] = item
        _revision(item["revision"], "item")
        _shape(item["classification"], {"skill"}, context="classification")
        _text(item["classification"]["skill"], "classification.skill")
        _source(item["source"], "item.source")
        _content(item["content"], assets, allow_empty=True)
        _content(item["prompt"], assets)
        if not spr:
            _require(isinstance(item["options"], list) and len(item["options"]) == 4, "SAT: exactly four options required")
            option_ids = set()
            for option in item["options"]:
                _shape(option, {"id", "content"}, context="option")
                _identifier(option["id"], "", "option.id")
                _require(option["id"] not in option_ids, "option: duplicate id")
                option_ids.add(option["id"])
                _content(option["content"], assets)
    _require(isinstance(solutions["solutions"], list), "solutions: expected array")
    linked = set()
    solution_index = {}
    for solution in solutions["solutions"]:
        _shape(solution, {"itemId", "itemRevision", "answer", "explanation", "provenance"}, context="solution")
        item_id = solution["itemId"]
        _require(isinstance(item_id, str) and item_id in item_index and item_id not in linked,
                 "solution: unknown or duplicate itemId")
        linked.add(item_id)
        solution_index[item_id] = solution
        item = item_index[item_id]
        _revision(solution["itemRevision"], "solution.itemRevision")
        _require(solution["itemRevision"] == item["revision"], "solution: itemRevision mismatch")
        _source(solution["provenance"], "solution.provenance")
        answer = solution["answer"]
        _require(isinstance(answer, dict), "answer: expected object")
        _require(answer.get("status") in ("verified", "needs-review", "missing"), "answer: invalid review status")
        fields = {"status", "type"}
        if answer["status"] != "missing":
            fields |= {"comparison", "acceptedRationals", "acceptedDecimalSpellings"} if spr else {"optionId"}
        _shape(answer, fields, context="answer")
        _require(answer["type"] == pack["responseType"], "answer: responseType mismatch")
        if answer["status"] != "missing":
            if spr:
                _spr_answer(answer, pack["inputProfile"])
            else:
                _require(isinstance(answer["optionId"], str) and answer["optionId"] in {o["id"] for o in item["options"]},
                         "answer: unknown optionId")
        explanation = solution["explanation"]
        _shape(explanation, {"status", "content"}, context="explanation")
        _require(explanation["status"] in ("provided", "needs-review", "missing"), "explanation: invalid status")
        if explanation["status"] == "missing":
            _require(explanation["content"] == [], "explanation: missing content must be empty")
        else:
            _content(explanation["content"], assets)
    _require(linked == item_index.keys(), "solutions: every item needs exactly one solution")
    versions = []
    for item_id, item in item_index.items():
        payload = {"section": pack["section"], "responseType": pack["responseType"],
                   "item": item, "solution": solution_index[item_id]}
        referenced_assets = set()
        def collect_images(value):
            if isinstance(value, dict):
                if value.get("type") == "image":
                    referenced_assets.add(value["assetId"])
                for child in value.values():
                    collect_images(child)
            elif isinstance(value, list):
                for child in value:
                    collect_images(child)
        collect_images(payload)
        payload["assetDigests"] = {asset_id: asset_digests[asset_id] for asset_id in sorted(referenced_assets)}
        digest = hashlib.sha256(json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")).hexdigest()
        versions.append({"itemId": item_id, "itemRevision": item["revision"], "sha256": digest})
    return {"packId": pack["id"], "itemCount": len(item_index), "assetCount": len(assets),
            "itemIds": list(item_index), "itemVersions": versions}


def validate_packs(paths):
    """Allow identical item revisions to be reused; reject conflicting copies."""
    summaries = [validate_pack(path) for path in paths]
    registry = {}
    for summary in summaries:
        for version in summary["itemVersions"]:
            key = (version["itemId"], version["itemRevision"])
            _require(key not in registry or registry[key] == version["sha256"],
                     "packs: conflicting content/answer/assets for the same itemId and revision")
            registry[key] = version["sha256"]
    return summaries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("packs", nargs="*", type=Path, help="Draft pack directories; defaults to the three sibling examples")
    args = parser.parse_args()
    roots = args.packs or [Path(__file__).parent / name for name in ("rw-single-choice", "math-single-choice", "math-spr")]
    summaries = validate_packs(roots)
    all_ids = [item_id for summary in summaries for item_id in summary["itemIds"]]
    print(f"Validated {len(summaries)} SAT draft packs, {len(all_ids)} items, "
          f"{sum(s['assetCount'] for s in summaries)} included assets. Draft structure only; no renderer/engine claim.")


if __name__ == "__main__":
    main()
