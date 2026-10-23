#!/usr/bin/env python3
"""Audit the deduplicated, cross-subject public PDF SAT library, one volume at a time.

No PDF library is required. Optional source-root validation hashes original PDFs.
Reports contain IDs, counts and error codes, never question or formula content.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import sys

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_ROOT = ROOT / "back-end/sat/questions/sat-packs/pdf-official"
DEFAULT_REPORT = ROOT / "local-data/pdf-sat-conversion/assembly-review.json"
PACK_NAMES = {"rw-single-choice", "math-single-choice", "math-spr"}
MAPPING_FIELDS = ("collectionId", "sourceFile", "canonicalCollectionId", "publishedCollectionId",
                  "mappedPublishedCollectionId", "mergedInto", "publicationStatus")


class ReviewError(ValueError):
    pass


def require(condition, code):
    if not condition:
        raise ReviewError(code)


def read_json(path):
    def unique(pairs):
        obj = {}
        for key, value in pairs:
            require(key not in obj, "duplicate-json-key")
            obj[key] = value
        return obj
    with Path(path).open(encoding="utf-8") as stream:
        return json.load(stream, object_pairs_hook=unique)


def local_path(root, value, *, directory=False):
    require(isinstance(value, str) and bool(value) and not PurePosixPath(value).is_absolute()
            and not any(char in value for char in "\\\x00:%?#")
            and all(part not in ("", ".", "..") for part in value.split("/")), "unsafe-relative-path")
    root = Path(root)
    require(not root.is_symlink(), "symlink-path")
    target = root
    for part in value.split("/"):
        target = target / part
        require(not target.is_symlink(), "symlink-path")
    require(target.is_dir() if directory else target.is_file(), "missing-relative-path")
    require(target.resolve().is_relative_to(root.resolve()), "relative-path-escapes-root")
    return target


def digest(path):
    hasher = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def index_rows(rows, code):
    require(isinstance(rows, list), code)
    indexed = {}
    for row in rows:
        require(isinstance(row, dict) and isinstance(row.get("collectionId"), str)
                and row["collectionId"] not in indexed, code)
        indexed[row["collectionId"]] = row
    return indexed


def inventory(root, source_root=None):
    catalog = read_json(root / "catalog.json")
    sources = read_json(root / "source-catalog.json")
    manifest = read_json(root / "pdf-source-manifest.json")
    summary = read_json(root / "assembly-summary.json")
    require(summary.get("schemaVersion") == "sat-pdf-assembly-summary/1", "unknown-assembly-summary-version")
    public = index_rows(catalog.get("collections"), "invalid-public-catalog")
    source = index_rows(sources.get("collections"), "invalid-source-catalog")
    files = index_rows(manifest.get("files"), "invalid-source-manifest")
    mappings = index_rows(summary.get("sourceMappings"), "invalid-source-mappings")
    combinations = index_rows(summary.get("combinations"), "invalid-combinations")
    unmatched = index_rows(summary.get("unmatched"), "invalid-unmatched-list")
    duplicates = index_rows(summary.get("duplicates"), "invalid-duplicate-list")
    excluded = index_rows(summary.get("excluded", []), "invalid-excluded-list")
    require(bool(public) and set(source) == set(files) == set(mappings), "source-mapping-coverage-mismatch")
    require(len({entry.get("sourceFile") for entry in files.values()}) == len(files), "duplicate-source-file")
    require(set(combinations).isdisjoint(unmatched) and set(public) == set(combinations) | set(unmatched),
            "publication-list-coverage-mismatch")
    canonical_ids = set()
    targets = defaultdict(set)
    question_only = set()
    for identity, entry in files.items():
        original = source[identity]
        require(set(MAPPING_FIELDS) <= set(entry) and set(MAPPING_FIELDS) <= set(mappings[identity]),
                "missing-publication-mapping-field")
        require(type(original.get("questionCount")) is int and original["questionCount"] > 0,
                "invalid-source-question-count")
        require((entry.get("sourceFile"), entry.get("sourceSha256")) ==
                (original.get("sourceFile"), original.get("sourceSha256")), "manifest-source-catalog-mismatch")
        require(isinstance(entry.get("sourceSha256"), str) and re.fullmatch(r"[0-9a-f]{64}", entry["sourceSha256"]),
                "invalid-source-digest")
        require({field: entry.get(field) for field in MAPPING_FIELDS} ==
                {field: mappings[identity].get(field) for field in MAPPING_FIELDS}, "summary-source-mapping-mismatch")
        canonical = entry.get("canonicalCollectionId")
        require(canonical in files and files[canonical].get("canonicalCollectionId") == canonical,
                "invalid-canonical-mapping")
        require("纯题目" not in files[canonical]["sourceFile"], "canonical-is-question-only")
        canonical_ids.add(canonical)
        target = entry.get("publishedCollectionId")
        require(entry.get("mappedPublishedCollectionId") == target, "published-target-alias-mismatch")
        require(entry.get("mergedInto") == (target if target != identity else None), "merged-into-mismatch")
        expected_status = "excluded-no-answers" if target is None else "published" if target == identity else "merged"
        require(entry.get("publicationStatus") == expected_status, "publication-status-mismatch")
        if target is None:
            require(canonical in excluded and isinstance(excluded[canonical].get("reason"), str)
                    and bool(excluded[canonical]["reason"].strip()), "excluded-source-missing-reason")
        else:
            require(target in public and canonical not in excluded, "manifest-target-missing")
            targets[target].add(canonical)
            local_path(root, public[target]["directory"], directory=True)
        require(files[canonical].get("publishedCollectionId") == target, "duplicate-target-mismatch")
        if "纯题目" in entry["sourceFile"]:
            question_only.add(identity)
            answer_source = entry.get("answerSource", {})
            require(canonical != identity and answer_source.get("collectionId") == canonical
                    and answer_source.get("sourceSha256") == files[canonical]["sourceSha256"]
                    and answer_source.get("sourceFile") == files[canonical]["sourceFile"], "question-only-answer-pair-mismatch")
            require(identity in duplicates and duplicates[identity].get("canonicalCollectionId") == canonical
                    and bool(duplicates[identity].get("reason")), "question-only-duplicate-declaration-mismatch")
            require(original.get("questionCount") == source[canonical].get("questionCount"), "duplicate-question-count-mismatch")
        else:
            require(canonical == identity and identity not in duplicates, "answered-source-not-canonical")
        if source_root is not None:
            original_path = local_path(source_root, entry["sourceFile"])
            require(digest(original_path) == entry["sourceSha256"], "source-pdf-sha256-mismatch")
    require(question_only == set(duplicates), "duplicate-list-coverage-mismatch")
    require(set(targets) == set(public), "unmapped-public-collection")
    require(set(excluded) <= canonical_ids, "excluded-source-not-canonical")
    physical = {path.parent.relative_to(root).as_posix() for path in root.rglob("conversion-report.json")}
    declared = {row.get("directory") for row in public.values()}
    require(len(declared) == len(public) and physical == declared, "physical-public-directory-mismatch")
    for pack_path in root.rglob("pack.json"):
        parts = pack_path.relative_to(root).parts
        require(len(parts) == 3 and parts[0] in declared and parts[1] in PACK_NAMES,
                "orphan-public-pack-directory")
    for asset_path in root.rglob("*"):
        if asset_path.is_file() and asset_path.suffix.lower() in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}:
            parts = asset_path.relative_to(root).parts
            require(len(parts) >= 4 and parts[0] in declared and parts[1] in PACK_NAMES and parts[2] == "assets",
                    "orphan-public-asset-file")
    if source_root is not None:
        original_files = {path.relative_to(source_root).as_posix() for path in Path(source_root).rglob("*")
                          if path.is_file() and path.suffix.lower() == ".pdf"}
        require(original_files == {entry["sourceFile"] for entry in files.values()}, "source-pdf-file-coverage-mismatch")
    expected_unpublished = set(source) - set(public)
    require(set(summary.get("unpublishedSourceCollections", [])) == expected_unpublished,
            "unpublished-source-list-mismatch")
    for identity, row in public.items():
        require(isinstance(row.get("title"), str) and bool(row["title"].strip())
                and "纯题目" not in row["title"], "question-only-public-title")
        require(row.get("category") == "测试" and row.get("status") == "converted", "public-catalog-state-mismatch")
        if identity in combinations:
            require(row == combinations[identity] and len(targets[identity]) == 2, "combination-catalog-mismatch")
        else:
            require(targets[identity] == {identity} and identity in canonical_ids
                    and bool(unmatched[identity].get("reason")), "unmatched-canonical-mismatch")
    answered_canonical = canonical_ids - set(excluded)
    counts = {
        "sourcePDFs": len(files), "canonicalCollectionsWithAnswers": len(answered_canonical),
        "questionOnlyDuplicates": len(question_only),
        "verifiedDuplicateQuestions": sum(source[identity]["questionCount"] for identity in question_only),
        "combinedCollections": len(combinations),
        "fullSATCollections": sum(public[identity].get("fullSAT") is True for identity in combinations),
        "partialCombinedCollections": sum(public[identity].get("fullSAT") is False for identity in combinations),
        "unmatchedCanonicalCollections": len(unmatched), "publishedCollections": len(public),
        "publishedQuestionCount": sum(row["questionCount"] for row in public.values()),
        "excludedNoAnswerCollections": len(excluded),
    }
    require(summary.get("summary") == counts, "assembly-summary-count-mismatch")
    canonical_questions = sum(source[identity]["questionCount"] for identity in answered_canonical)
    require(counts["publishedQuestionCount"] == canonical_questions, "canonical-public-question-count-mismatch")
    return {"public": public, "source": source, "files": files, "targets": targets,
            "combinations": combinations, "counts": counts, "canonicalQuestionCount": canonical_questions}


def image_ids(value):
    if isinstance(value, dict):
        if value.get("type") == "image":
            yield value.get("assetId")
        for child in value.values():
            yield from image_ids(child)
    elif isinstance(value, list):
        for child in value:
            yield from image_ids(child)


def review_volume(root, row, plan, validator, assembly, global_ids, global_versions):
    identity = row["collectionId"]
    result = {"collectionId": identity, "status": "pass", "questionCount": 0,
              "packCount": 0, "assetCount": 0, "fullSAT": row["fullSAT"], "errors": []}
    try:
        folder = local_path(root, row["directory"], directory=True)
        report = read_json(local_path(folder, "conversion-report.json"))
        require(report.get("collectionId") == identity and report.get("title", row["title"]) == row["title"],
                "public-report-identity-mismatch")
        require("纯题目" not in report.get("title", ""), "question-only-public-report-title")
        require(report.get("questionCount") == row["questionCount"] and report.get("fullSAT") == row["fullSAT"]
                and report.get("modules") == row["modules"], "public-report-metadata-mismatch")
        declared = report.get("packs")
        require(isinstance(declared, dict) and bool(declared) and set(declared) <= PACK_NAMES, "invalid-report-pack-list")
        actual = {p.parent.relative_to(folder).as_posix() for p in folder.rglob("pack.json")}
        require(actual == set(declared), "unexpected-pack-directory")
        items_by_id, answers, source_counts, source_modules = {}, Counter(), Counter(), Counter()
        for name in declared:
            pack_folder = local_path(folder, name, directory=True)
            require(not any(member.is_symlink() for member in pack_folder.rglob("*")), "symlink-pack-member")
            try:
                validation = validator.validate_pack(pack_folder)
            except (ValueError, KeyError, TypeError):
                raise ReviewError("draft-pack-validator-rejected") from None
            pack = read_json(local_path(pack_folder, "pack.json"))
            require("纯题目" not in pack.get("title", ""), "question-only-public-pack-title")
            items = read_json(local_path(pack_folder, pack["files"]["items"]))["items"]
            solutions = read_json(local_path(pack_folder, pack["files"]["solutions"]))["solutions"]
            require(declared[name].get("questionCount") == len(items) == validation["itemCount"]
                    and declared[name].get("assetCount") == len(pack["assets"]), "pack-report-count-mismatch")
            require(set(image_ids(items)) | set(image_ids(solutions)) == {a["id"] for a in pack["assets"]},
                    "unreferenced-asset-declaration")
            asset_paths = {asset["path"] for asset in pack["assets"]}
            actual_paths = {p.relative_to(pack_folder).as_posix() for p in (pack_folder / "assets").rglob("*") if p.is_file()}
            require(asset_paths == actual_paths, "orphan-or-missing-asset-file")
            for asset_path in asset_paths:
                local_path(pack_folder, asset_path)
            for item in items:
                item_id, source = item["id"], item["source"]
                require(item_id not in items_by_id and item_id not in global_ids, "duplicate-public-item-id")
                require(source.get("sourceSetId") in plan["targets"][identity], "item-not-from-target-canonical-source")
                items_by_id[item_id] = (pack["id"], pack["revision"], item["revision"], pack["section"], source)
                source_counts[source["sourceSetId"]] += 1
            for version in validation["itemVersions"]:
                key = (version["itemId"], version["itemRevision"])
                require(key not in global_versions or global_versions[key] == version["sha256"], "conflicting-item-revision")
                global_versions[key] = version["sha256"]
            answers.update(solution["answer"]["status"] for solution in solutions)
            result["packCount"] += 1
            result["assetCount"] += len(asset_paths)
        require(answers["needs-review"] + answers["verified"] > 0, "published-collection-has-no-answers")
        require(answers == Counter(report.get("answerStatus", {})), "report-answer-status-mismatch")
        order = report.get("sourceOrder")
        require(isinstance(order, list) and len(order) == len(items_by_id) == row["questionCount"], "source-order-count-mismatch")
        seen_items, seen_positions, ordered = set(), set(), []
        for ref in order:
            item_id = ref.get("itemId")
            require(item_id in items_by_id and item_id not in seen_items, "source-order-item-coverage-mismatch")
            pack_id, pack_revision, item_revision, section, source = items_by_id[item_id]
            require((ref.get("packId"), ref.get("packRevision"), ref.get("itemRevision"), ref.get("section")) ==
                    (pack_id, pack_revision, item_revision, section), "source-order-reference-mismatch")
            module, number = ref.get("moduleNumber"), ref.get("number")
            require(type(module) is int and module > 0 and type(number) is int and number > 0, "invalid-source-position")
            require(ref.get("sourceQuestionId") == source.get("sourceQuestionId") == f"m{module}-q{number}",
                    "source-order-original-question-mismatch")
            position = (0 if section == "reading-writing" else 1, module, number)
            require(position not in seen_positions, "duplicate-source-position")
            seen_items.add(item_id)
            seen_positions.add(position)
            ordered.append(position)
            source_modules[(source["sourceSetId"], section, module)] += 1
        require(ordered == sorted(ordered), "source-order-not-by-section-module-question")
        require(seen_items == set(items_by_id), "source-order-item-coverage-mismatch")
        for source_id in plan["targets"][identity]:
            original = plan["source"][source_id]
            require(source_counts[source_id] == original["questionCount"], "canonical-source-question-loss")
            expected = {(source_id, module["section"], module["moduleNumber"]): module["questionCount"]
                        for module in original["modules"]}
            actual = {key: value for key, value in source_modules.items() if key[0] == source_id}
            require(actual == expected, "canonical-source-module-count-mismatch")
        full, modules, _ = assembly.build_modules(order)
        require(report["fullSAT"] == full and report["modules"] == modules, "full-sat-or-duration-mismatch")
        if identity in plan["combinations"]:
            sources = report.get("sourceCollections")
            require(sources == row.get("sourceCollections") and {s["collectionId"] for s in sources} == plan["targets"][identity],
                    "combined-source-declaration-mismatch")
            keys = []
            for declaration in sources:
                original = plan["source"][declaration["collectionId"]]
                key, reason = assembly.match_identity(original)
                require(reason is None, "combination-source-identity-ambiguous")
                keys.append(key)
                require(declaration == {"collectionId": original["collectionId"], "sourceFile": original["sourceFile"],
                    "sourceSha256": original["sourceSha256"], "questionCount": original["questionCount"],
                    "section": assembly.subject(original)}, "combined-source-metadata-mismatch")
            require(len(keys) == 2 and keys[0] == keys[1] and row.get("assemblyIdentity") == list(keys[0]),
                    "cross-subject-identity-mismatch")
            require({s["section"] for s in sources} == {"reading-writing", "math"}, "combined-missing-subject")
            try:
                assembly.validate_combined(folder, report, validator)
            except (ValueError, KeyError, TypeError):
                raise ReviewError("combined-assessment-validator-rejected") from None
        else:
            original = plan["source"][identity]
            require(report.get("sourceSha256") == original["sourceSha256"] and report.get("sourceFile") == original["sourceFile"],
                    "unmatched-report-source-mismatch")
            require(not full and not (folder / "assessment.json").exists(), "single-subject-full-sat-claim")
        global_ids.update(items_by_id)
        result["questionCount"] = len(items_by_id)
    except (ReviewError, OSError, ValueError, KeyError, TypeError) as exc:
        result["status"] = "fail"
        result["errors"].append(str(exc) if isinstance(exc, ReviewError) else "unreadable-or-invalid-public-volume")
    return result


def review_assembly(root=DEFAULT_ROOT, *, source_root=None):
    root = Path(root)
    output = {"schemaVersion": "sat-pdf-assembly-review/1", "ok": False,
              "contentReviewStatus": "needs-review", "sourceHashCheck": "run" if source_root else "not-run",
              "summary": {}, "errors": [], "collections": []}
    try:
        plan = inventory(root, Path(source_root) if source_root else None)
        assembly = load_module("review_sat_assembly", ROOT / "back-end/tools/sat/assemble_pdf_sat.py")
        validator = assembly.load_validator()
        global_ids, global_versions = set(), {}
        for row in plan["public"].values():
            result = review_volume(root, row, plan, validator, assembly, global_ids, global_versions)
            output["collections"].append(result)
        counts = plan["counts"]
        output["summary"] = {**counts, "canonicalQuestionCount": plan["canonicalQuestionCount"],
            "reviewedQuestionCount": sum(r["questionCount"] for r in output["collections"]),
            "reviewedPackCount": sum(r["packCount"] for r in output["collections"]),
            "reviewedAssetCount": sum(r["assetCount"] for r in output["collections"]),
            "passedCollections": sum(r["status"] == "pass" for r in output["collections"]),
            "failedCollections": sum(r["status"] == "fail" for r in output["collections"])}
        if output["summary"]["failedCollections"] == 0:
            require(len(global_ids) == plan["canonicalQuestionCount"], "actual-canonical-question-count-mismatch")
        output["ok"] = output["summary"]["failedCollections"] == 0
    except (ReviewError, OSError, ValueError, KeyError, TypeError) as exc:
        output["errors"].append(str(exc) if isinstance(exc, ReviewError) else "unreadable-or-invalid-assembly-inventory")
    return output


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT)
    parser.add_argument("--source-root", type=Path)
    parser.add_argument("--report", type=Path, default=DEFAULT_REPORT)
    args = parser.parse_args(argv)
    report = review_assembly(args.root, source_root=args.source_root)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": report["ok"], "summary": report["summary"], "errors": report["errors"],
                      "report": str(args.report)}, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
