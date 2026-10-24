#!/usr/bin/env python3
"""Review converted PDF SAT collections one collection at a time.

This checks source coverage, structure, traceability and asset integrity. It does
not certify answers or replace visual inspection. Reports contain identifiers
and issue codes, never question text. The optional five-file sample is a review
worklist, not a claim that all question content has been manually checked.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import importlib.util
import json
import math
from pathlib import Path, PurePosixPath
import random
import re
import sys


ROOT = Path(__file__).resolve().parents[3]
DEFAULT_OUTPUT = ROOT / "back-end/question-banks/sat-packs/pdf-official"
DEFAULT_EVIDENCE = ROOT / "local-data/pdf-sat-conversion/extracted"
PACK_NAMES = ("rw-single-choice", "math-single-choice", "math-spr")
ANSWER_MARKER = re.compile(
    r"(?im)^\s*(?:[*_]{1,3}|<u>)*(?:【(?:参考|正确|标准)?答案】|(?:参考|正确|标准)?答案\s*[：:]|"
    r"(?:correct\s+)?answer(?:\s+key)?\s*:|【解析】|解析\s*[：:]|explanation\s*:)")


class ReviewError(ValueError):
    """A structure or source-evidence contract was violated."""


def require(condition, code):
    if not condition:
        raise ReviewError(code)


def _unique(pairs):
    value = {}
    for key, child in pairs:
        require(key not in value, "duplicate-json-key")
        value[key] = child
    return value


def read_json(path):
    try:
        with Path(path).open(encoding="utf-8") as stream:
            return json.load(stream, object_pairs_hook=_unique)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ReviewError("unreadable-json:" + Path(path).name) from exc


def relative_file(root, value, *, directory=False):
    require(isinstance(value, str) and bool(value), "missing-relative-path")
    require(not any(c in value for c in "\\\x00:%?#")
            and not PurePosixPath(value).is_absolute()
            and all(part not in ("", ".", "..") for part in value.split("/")), "unsafe-relative-path")
    path = Path(root)
    require(not path.is_symlink(), "symlink-path")
    for part in value.split("/"):
        path = path / part
        require(not path.is_symlink(), "symlink-path")
    require(path.is_dir() if directory else path.is_file(), "missing-file:" + value)
    require(path.resolve().is_relative_to(Path(root).resolve()), "path-escapes-root")
    return path


def file_digest(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_validator():
    spec = importlib.util.spec_from_file_location(
        "pdf_sat_draft_validator", ROOT / "docs/drafts/sat-question-packs/validate_examples.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def image_ids(value):
    if isinstance(value, dict):
        if value.get("type") == "image":
            yield value["assetId"]
        for child in value.values():
            yield from image_ids(child)
    elif isinstance(value, list):
        for child in value:
            yield from image_ids(child)


def markdown_text(value):
    if isinstance(value, dict):
        if value.get("type") == "markdown":
            yield value["text"]
        for child in value.values():
            yield from markdown_text(child)
    elif isinstance(value, list):
        for child in value:
            yield from markdown_text(child)


def position(record):
    number = record.get("questionNumber", record.get("number"))
    result = (record.get("section"), record.get("moduleNumber"), number)
    require(result[0] in ("reading-writing", "math"), "invalid-source-section")
    require(all(type(value) is int and value > 0 for value in result[1:]), "invalid-source-position")
    return result


def validate_regions(question, page_count):
    regions = question.get("regions")
    if regions is None and "pageNumber" in question:
        regions = [{"pageNumber": question["pageNumber"], "bbox": question.get("bbox")}]
    require(isinstance(regions, list) and bool(regions), "missing-source-regions")
    previous_page = 0
    for region in regions:
        require(isinstance(region, dict), "invalid-source-region")
        page = region.get("pageNumber")
        require(type(page) is int and 1 <= page <= page_count, "source-page-out-of-range")
        require(page >= previous_page, "source-region-page-order")
        previous_page = page
        box = region.get("bbox")
        require(isinstance(box, list) and len(box) == 4
                and all(type(value) in (int, float) and math.isfinite(value) for value in box),
                "invalid-source-bbox")
        require(0 <= box[0] < box[2] and 0 <= box[1] < box[3], "invalid-source-bbox")
    return regions[0]["pageNumber"]


def scan_source_anchors(path, row):
    """Independently scan the original PDF, retaining every candidate anchor.

    Do not import converter code or its monotonic-number filter: a dropped source
    question or an explanation number must remain visible as a mismatch. Only
    line geometry, bold fonts, module headings and printed numbers are used.
    """
    try:
        import pymupdf
    except ImportError as exc:
        raise ReviewError("source-anchor-check-requires-PyMuPDF-1.26.7") from exc
    sections = {module.get("section") for module in row.get("modules", [])}
    require(len(sections) == 1, "source-pdf-must-have-one-declared-section")
    section = next(iter(sections))
    filename_module = re.search(r"(?:M|Module\s*)([1-9])(?:\D|$)", Path(row["sourceFile"]).stem, re.I)
    module = int(filename_module.group(1)) if filename_module else 1
    anchors, module_markers = [], []
    try:
        document = pymupdf.open(path)
        with document:
            require(not document.needs_pass, "encrypted-source-pdf")
            for page_index in range(len(document)):
                page = document[page_index]
                lines = []
                for block in page.get_text("dict", flags=pymupdf.TEXTFLAGS_DICT & ~pymupdf.TEXT_PRESERVE_IMAGES)["blocks"]:
                    lines.extend(block.get("lines", []))
                lines.sort(key=lambda line: (round(line["bbox"][1], 1), line["bbox"][0]))
                for line in lines:
                    spans = line.get("spans", [])
                    value = "".join(span.get("text", "") for span in spans).strip()
                    heading = re.fullmatch(r"Module\s*([1-9])(?:\s*[-–:(].*)?", value, re.I)
                    if heading:
                        module = int(heading.group(1))
                        module_markers.append({"moduleNumber": module, "pageNumber": page_index + 1})
                        continue
                    number = re.fullmatch(r"([0-9]{1,3})\.", value)
                    bold = any(span.get("flags", 0) & 16 or "bold" in span.get("font", "").lower() for span in spans)
                    if number and line["bbox"][0] <= 115 and bold:
                        anchors.append({"section": section, "moduleNumber": module, "number": int(number.group(1)),
                                        "pageNumber": page_index + 1, "bbox": list(line["bbox"])})
            page_count = len(document)
    except ReviewError:
        raise
    except Exception as exc:
        raise ReviewError("source-pdf-anchor-read-failed:" + type(exc).__name__) from exc
    return {"pageCount": page_count, "anchors": anchors, "moduleMarkers": module_markers}


def validate_source_anchors(scan, questions, order):
    anchors = scan["anchors"]
    require(len(anchors) == len(order), "source-anchor-count-mismatch")
    require([position(anchor) for anchor in anchors] == [position(ref) for ref in order],
            "source-anchor-sequence-mismatch")
    for anchor, question in zip(anchors, questions):
        first = question.get("regions", [question])[0]
        require(first.get("pageNumber") == anchor["pageNumber"], "source-anchor-evidence-page-mismatch")
        ax0, ay0, ax1, ay1 = anchor["bbox"]
        x0, y0, x1, y1 = first["bbox"]
        require(x0 - 1 <= ax0 <= ax1 <= x1 + 1 and y0 - 1 <= ay0 <= ay1 <= y1 + 1,
                "source-anchor-not-inside-evidence-region")


def review_collection(root, row, manifest, evidence_root, validator, versions, *, source_root=None):
    """Release content references on return; only counters/identities survive."""
    identity = row["collectionId"]
    result = {"collectionId": identity, "sourceFile": row.get("sourceFile"),
              "structuralStatus": "pass", "contentReviewStatus": "needs-review",
              "questionCount": 0, "packCount": 0, "assetCount": 0,
              "sourceAnchorCheck": "not-run", "errors": [], "warnings": {}}
    warnings = Counter()
    source_warning_keys = set()
    try:
        directory = relative_file(root, row["directory"], directory=True)
        report = read_json(relative_file(directory, "conversion-report.json"))
        require(report.get("collectionId") == identity, "report-collection-mismatch")
        require(report.get("sourceSha256") == manifest["sourceSha256"], "report-source-digest-mismatch")
        require(row.get("category") == "测试", "pdf-collection-not-in-full-length-category")
        require(row.get("status") == "converted" and isinstance(row.get("title"), str) and bool(row["title"].strip()),
                "collection-missing-visible-catalog-metadata")
        require(row.get("fullSAT") is False and report.get("fullSAT") is False,
                "single-subject-pdf-must-not-claim-full-sat")
        packs = [directory / name for name in PACK_NAMES if (directory / name / "pack.json").is_file()]
        require(bool(packs), "collection-has-no-packs")
        actual_packs = set(directory.rglob("pack.json"))
        require(actual_packs == {path / "pack.json" for path in packs}, "unexpected-pack-directory")
        require(isinstance(report.get("packs"), dict) and set(report["packs"]) == {path.name for path in packs},
                "report-pack-list-mismatch")
        items_by_id, pack_metadata = {}, {}
        for path in packs:
            try:
                summary = validator.validate_pack(path)
            except ValueError as exc:
                # The validator's diagnostic describes schema fields, not stems.
                raise ReviewError("draft-validator:" + str(exc)) from exc
            for version in summary["itemVersions"]:
                key = (version["itemId"], version["itemRevision"])
                require(key not in versions or versions[key] == version["sha256"], "conflicting-item-revision")
                versions[key] = version["sha256"]
            pack = read_json(path / "pack.json")
            items = read_json(relative_file(path, pack["files"]["items"]))["items"]
            solutions = read_json(relative_file(path, pack["files"]["solutions"]))["solutions"]
            declaration = report["packs"][path.name]
            require(isinstance(declaration, dict) and declaration.get("questionCount") == len(items)
                    and declaration.get("assetCount") == len(pack["assets"]), "report-pack-count-mismatch")
            require(pack["id"] not in pack_metadata, "duplicate-pack-id")
            pack_metadata[pack["id"]] = (pack["revision"], pack["section"])
            used_assets = set(image_ids(items)) | set(image_ids(solutions))
            declared_assets = {asset["id"] for asset in pack["assets"]}
            require(used_assets == declared_assets, "unreferenced-asset-manifest-entry")
            declared_paths = {asset["path"] for asset in pack["assets"]}
            actual_paths = {resource.relative_to(path).as_posix() for resource in (path / "assets").rglob("*")
                            if resource.is_file()}
            require(actual_paths == declared_paths, "orphan-or-missing-asset-file")
            result["assetCount"] += len(declared_assets)
            for item in items:
                require(item["id"] not in items_by_id, "duplicate-collection-item")
                items_by_id[item["id"]] = (item["revision"], pack["id"], item["source"])
                require(item["source"].get("sourceSetId") == identity, "item-source-set-mismatch")
                for text in markdown_text(item):
                    require(not ANSWER_MARKER.search(text), "possible-answer-or-explanation-leak-in-item")
                    if "\ufffd" in text or re.search(r"[\ue000-\uf8ff]", text):
                        warnings["unresolved-pdf-font-glyph"] += 1
                if not set(image_ids(item)) and any(re.search(r"\b(?:graph|diagram|table|figure)\b", text, re.I)
                                                   for text in markdown_text(item)):
                    warnings["diagram-reference-without-image-review"] += 1
            for solution in solutions:
                require(solution["answer"]["status"] != "verified", "unreviewed-source-answer-marked-verified")
                warnings["answer-" + solution["answer"]["status"]] += 1
                if solution["explanation"]["status"] != "provided":
                    warnings["explanation-" + solution["explanation"]["status"]] += 1
            result["packCount"] += 1
        count = len(items_by_id)
        result["questionCount"] = count
        require(type(row.get("questionCount")) is int and count == row["questionCount"] == report.get("questionCount"),
                "collection-question-count-mismatch")
        order = report.get("sourceOrder")
        require(isinstance(order, list) and len(order) == count, "source-order-count-mismatch")
        seen_ids, seen_questions, seen_positions = set(), set(), set()
        order_ids, module_numbers = [], {}
        for ref in order:
            require(isinstance(ref, dict), "invalid-source-order-reference")
            item_id, source_id = ref.get("itemId"), ref.get("sourceQuestionId")
            require(isinstance(source_id, str) and bool(source_id) and source_id not in seen_questions,
                    "duplicate-or-missing-source-question-id")
            require(item_id in items_by_id and item_id not in seen_ids, "duplicate-or-missing-source-order-item")
            item_revision, pack_id, source = items_by_id[item_id]
            require((ref.get("itemRevision"), ref.get("packId"), ref.get("packRevision"))
                    == (item_revision, pack_id, pack_metadata[pack_id][0]), "source-order-revision-mismatch")
            require(source.get("sourceQuestionId") == source_id, "item-source-question-mismatch")
            pos = position(ref)
            require(pack_metadata[pack_id][1] == pos[0], "source-order-section-mismatch")
            require(pos not in seen_positions, "duplicate-source-module-question-position")
            module_numbers.setdefault(pos[:2], []).append(pos[2])
            seen_ids.add(item_id)
            seen_questions.add(source_id)
            seen_positions.add(pos)
            order_ids.append(source_id)
        for (section, _), numbers in module_numbers.items():
            require(numbers == sorted(numbers), "source-question-order-not-increasing")
            if numbers != list(range(1, max(numbers) + 1)):
                warnings["partial-source-module-numbering"] += 1
            if len(numbers) > (27 if section == "reading-writing" else 22):
                warnings["source-module-exceeds-standard-question-count"] += 1
        for declaration in (row.get("modules"), report.get("modules")):
            require(isinstance(declaration, list), "missing-module-counts")
            declared = {(module.get("section"), module.get("moduleNumber")): module.get("questionCount")
                        for module in declaration}
            require(len(declared) == len(declaration)
                    and declared == {key: len(numbers) for key, numbers in module_numbers.items()}, "module-count-mismatch")
        evidence = read_json(relative_file(evidence_root, identity + ".json"))
        require(evidence.get("collectionId") == identity and evidence.get("sourceFile") == manifest["sourceFile"]
                and evidence.get("sourceSha256") == manifest["sourceSha256"], "evidence-source-mismatch")
        page_count = evidence.get("pageCount")
        require(type(page_count) is int and page_count > 0, "missing-pdf-page-count")
        if "pageCount" in manifest:
            require(page_count == manifest["pageCount"], "evidence-page-count-mismatch")
        questions = evidence.get("questions")
        require(isinstance(questions, list) and len(questions) == count, "evidence-question-count-mismatch")
        require([question.get("sourceQuestionId") for question in questions] == order_ids, "evidence-source-order-mismatch")
        previous_page = 0
        for question, ref in zip(questions, order):
            require(position(question) == position(ref), "evidence-position-mismatch")
            page = validate_regions(question, page_count)
            require(page >= previous_page, "source-question-page-order")
            previous_page = page
            for issue in question.get("warnings", []):
                code = issue.get("issue", issue.get("code", "source-review-warning")) if isinstance(issue, dict) else issue
                code = code if isinstance(code, str) and re.fullmatch(r"[a-z0-9_-]+(?::[a-z0-9_-]+)*", code) else "source-review-warning"
                source_warning_keys.add((question.get("sourceQuestionId"), code))
        if source_root is not None:
            scan = scan_source_anchors(relative_file(source_root, manifest["sourceFile"]), row)
            result["sourceAnchorCheck"] = "fail"
            result["sourceAnchorCount"] = len(scan["anchors"])
            require(scan["pageCount"] == page_count, "source-pdf-page-count-mismatch")
            try:
                validate_source_anchors(scan, questions, order)
            except ReviewError:
                # Small positional diagnostics only; never include PDF text.
                differences = []
                for index in range(max(len(scan["anchors"]), len(order))):
                    actual = scan["anchors"][index] if index < len(scan["anchors"]) else None
                    expected = order[index] if index < len(order) else None
                    if actual is None or expected is None or position(actual) != position(expected):
                        differences.append({"index": index + 1,
                            "source": {key: actual[key] for key in ("moduleNumber", "number", "pageNumber")} if actual else None,
                            "converted": {"moduleNumber": expected.get("moduleNumber"),
                                          "number": expected.get("number", expected.get("questionNumber"))} if expected else None})
                    if len(differences) == 8:
                        break
                result["sourceAnchorDifferences"] = differences
                raise
            result["sourceAnchorCheck"] = "pass"
            if not scan["moduleMarkers"]:
                warnings["source-module-inferred-without-heading"] += 1
        for issue in report.get("reviewNotes", []):
            code = issue.get("issue", "conversion-review-note") if isinstance(issue, dict) else "conversion-review-note"
            code = code if isinstance(code, str) and re.fullmatch(r"[a-z0-9_-]+(?::[a-z0-9_-]+)*", code) else "conversion-review-note"
            source_warning_keys.add((issue.get("sourceQuestionId") if isinstance(issue, dict) else None, code))
        warnings.update(code for _, code in source_warning_keys)
        warnings["visual-source-comparison-still-required"] += 1
    except (ReviewError, KeyError, TypeError, AttributeError, OSError) as exc:
        result["structuralStatus"] = "fail"
        result["errors"].append(str(exc) if isinstance(exc, ReviewError) else "malformed-collection:" + type(exc).__name__)
    result["warnings"] = dict(sorted(warnings.items()))
    return result


def sample_tags(row):
    sections = {module.get("section") for module in row.get("modules", [])}
    tags = {"subject:" + section for section in sections if isinstance(section, str)}
    source_name = row.get("sourceFile", "")
    year_match = re.search(r"(?:20)?(2[0-9])(?:年|[-_. /])", source_name)
    if year_match:
        tags.add("era:" + ("2023-2024" if int(year_match.group(1)) <= 24 else "2025-plus"))
    else:
        tags.add("era:unknown")
    tags.add("coverage:partial" if row.get("fullSAT") is False else "coverage:full")
    expected_count = 44 if sections == {"math"} else 54 if sections == {"reading-writing"} else 98
    incomplete_source = (re.search(r"缺\s*\d*\s*题|仅|只录|去重|合并", source_name)
                         or type(row.get("questionCount")) is int and row["questionCount"] != expected_count)
    tags.add("source-scope:partial-or-merged" if incomplete_source else "source-scope:standard-subject")
    all_answers_missing = (type(row.get("questionCount")) is int and row["questionCount"] > 0
                           and row.get("answerStatus", {}).get("missing") == row["questionCount"])
    tags.add("answers:questions-only" if re.search(r"无答案|纯题目|题目版|题目only|question.?only|questions.?only", source_name, re.I)
             or all_answers_missing else "answers:source-may-include")
    return tags


def select_samples(rows, *, count=5, seed=20261023):
    """Seeded, deterministic coverage of subjects, eras and exceptional formats."""
    require(type(count) is int and 0 <= count <= 5, "sample-limit-is-five")
    candidates = sorted(rows, key=lambda row: row["collectionId"])
    random.Random(seed).shuffle(candidates)
    selected, covered = [], set()
    while candidates and len(selected) < count:
        row = max(candidates, key=lambda candidate: len(sample_tags(candidate) - covered))
        candidates.remove(row)
        tags = sample_tags(row)
        selected.append({"collectionId": row["collectionId"], "sourceFile": row["sourceFile"],
                         "directory": row["directory"], "tags": sorted(tags)})
        covered |= tags
    return {"schemaVersion": "sat-pdf-review-sample/1", "seed": seed, "maximumFiles": 5,
            "selection": "seeded-greedy-stratified", "contentReviewStatus": "pending",
            "instructions": "Inspect only these PDFs and their matching evidence one at a time. Compare text and images, summarize common layout and outliers. Do not load the whole question library.",
            "samples": selected}


def review_library(root, evidence_root, *, source_root=None, seed=20261023, source_catalog=None):
    root, evidence_root = Path(root), Path(evidence_root)
    catalog = read_json(source_catalog if source_catalog is not None else root / "catalog.json")
    manifest = read_json(root / "pdf-source-manifest.json")
    rows, files = catalog.get("collections"), manifest.get("files")
    require(isinstance(rows, list) and isinstance(files, list) and bool(files), "invalid-source-manifest-or-catalog")
    by_source, by_identity = {}, {}
    for entry in files:
        require(isinstance(entry, dict), "invalid-source-manifest-entry")
        source, identity, digest = entry.get("sourceFile"), entry.get("collectionId"), entry.get("sourceSha256")
        require(isinstance(source, str) and source.lower().endswith(".pdf"), "manifest-source-not-pdf")
        require(source not in by_source and identity not in by_identity, "manifest-pdf-not-exactly-one-collection")
        require(isinstance(identity, str) and re.fullmatch(r"[a-z0-9][a-z0-9-]*", identity), "unsafe-collection-id")
        require(isinstance(digest, str) and re.fullmatch(r"[0-9a-f]{64}", digest), "invalid-source-sha256")
        by_source[source], by_identity[identity] = entry, entry
    require(len(rows) == len(files), "manifest-catalog-count-mismatch")
    seen, directories = set(), set()
    for row in rows:
        require(isinstance(row, dict), "invalid-catalog-entry")
        identity = row.get("collectionId")
        require(identity in by_identity and identity not in seen, "catalog-collection-not-exactly-once")
        source = by_identity[identity]
        require(row.get("sourceFile") == source["sourceFile"] and row.get("sourceSha256") == source["sourceSha256"],
                "catalog-manifest-source-mismatch")
        require(isinstance(row.get("directory"), str) and row["directory"] not in directories, "duplicate-catalog-directory")
        require(not any(c in row["directory"] for c in "\\\x00:%?#")
                and not PurePosixPath(row["directory"]).is_absolute()
                and all(part not in ("", ".", "..") for part in row["directory"].split("/")), "unsafe-relative-path")
        seen.add(identity)
        directories.add(row["directory"])
    expected_reports = {Path(directory) / "conversion-report.json" for directory in directories}
    actual_reports = {path.relative_to(root) for path in root.rglob("conversion-report.json")}
    require(expected_reports <= actual_reports if source_catalog is not None else actual_reports == expected_reports,
            "orphan-or-missing-collection-report")
    source_checks = {"inventoryChecked": source_root is not None, "sha256Checked": 0}
    if source_root is not None:
        source_root = Path(source_root)
        actual_sources = {path.relative_to(source_root).as_posix() for path in source_root.rglob("*")
                          if path.is_file() and path.suffix.lower() == ".pdf"}
        require(actual_sources == set(by_source), "source-pdf-inventory-mismatch")
        for entry in files:
            path = relative_file(source_root, entry["sourceFile"])
            require(file_digest(path) == entry["sourceSha256"], "source-pdf-sha256-mismatch:" + entry["sourceFile"])
            source_checks["sha256Checked"] += 1
    validator = load_validator()
    versions = {}
    results = []
    for row in rows:
        results.append(review_collection(root, row, by_identity[row["collectionId"]], evidence_root, validator, versions,
                                         source_root=source_root))
    source_checks["anchorChecked"] = sum(row["sourceAnchorCheck"] == "pass" for row in results)
    errors = sum(len(row["errors"]) for row in results)
    warnings = Counter()
    for row in results:
        warnings.update(row["warnings"])
    if source_root is None:
        warnings["source-pdf-inventory-and-sha256-not-checked"] += 1
    report = {"schemaVersion": "sat-pdf-review/1", "structuralStatus": "fail" if errors else "pass",
              "contentReviewStatus": "needs-review", "sourceChecks": source_checks,
              "additionalCollectionsOutsideSourceScope": len(actual_reports - expected_reports),
              "summary": {"pdfCount": len(files), "collectionCount": len(results),
                          "questionCount": sum(row["questionCount"] for row in results),
                          "packCount": sum(row["packCount"] for row in results),
                          "assetCount": sum(row["assetCount"] for row in results), "errorCount": errors,
                          "warningCount": sum(warnings.values())},
              "warnings": dict(sorted(warnings.items())), "collections": results}
    return report, select_samples(rows, seed=seed)


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--evidence-root", type=Path, default=DEFAULT_EVIDENCE)
    parser.add_argument("--source-catalog", type=Path,
                        help="Review the original PDF index when catalog.json contains assembled tests")
    parser.add_argument("--source-root", type=Path,
                        help="Check inventory, SHA-256 and independent PDF anchors (requires PyMuPDF at runtime)")
    parser.add_argument("--report", type=Path, default=ROOT / "local-data/pdf-sat-conversion/review-report.json")
    parser.add_argument("--sample-output", type=Path, default=ROOT / "local-data/pdf-sat-conversion/review-sample.json")
    parser.add_argument("--seed", type=int, default=20261023)
    parser.add_argument("--strict-review", action="store_true", help="Return 2 for review warnings even if structure passes")
    args = parser.parse_args(argv)
    try:
        report, samples = review_library(args.root, args.evidence_root, source_root=args.source_root, seed=args.seed,
                                         source_catalog=args.source_catalog)
        write_json(args.report, report)
        write_json(args.sample_output, samples)
    except (ReviewError, KeyError, TypeError, AttributeError, OSError) as exc:
        code = str(exc) if isinstance(exc, ReviewError) else "malformed-input:" + type(exc).__name__
        write_json(args.report, {"schemaVersion": "sat-pdf-review/1", "structuralStatus": "fail", "errors": [code],
                                 "contentReviewStatus": "needs-review"})
        print("PDF SAT structural review: FAIL — " + code, file=sys.stderr)
        return 1
    summary = report["summary"]
    print(f"PDF SAT structural review: {report['structuralStatus'].upper()}; "
          f"{summary['collectionCount']} PDFs, {summary['questionCount']} questions, "
          f"{summary['errorCount']} errors. Content review: NEEDS REVIEW "
          f"({summary['warningCount']} warnings); sample: {len(samples['samples'])} PDFs.")
    if summary["errorCount"]:
        return 1
    return 2 if args.strict_review and summary["warningCount"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
