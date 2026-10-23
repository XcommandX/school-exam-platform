#!/usr/bin/env python3
"""Assemble unambiguous PDF subject pairs and publish one answered catalog.

Original PDFs and source collections are never moved or deleted. The original
508-style inventory lives in source-catalog.json; catalog.json is the published
selection. Copies in combined collections retain every item/pack ID, revision,
answer status and source field. Reports contain metadata only, not stems.

Run only against a complete source staging folder. If redundant source packs
have subsequently been archived, first restore all source-catalog collections
into a separate staging folder or regenerate them with the PDF converter. This
tool does not reconstruct missing source packs from the published combinations.
Use --publish-root to export only cataloged collections into a separate empty
directory. The source staging folder stays complete for audits and retries.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import importlib.util
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tempfile
import unicodedata
import uuid

ROOT = Path(__file__).resolve().parents[3]
PACK_NAMES = ("rw-single-choice", "math-single-choice", "math-spr")
REFERENCE_FIELDS = ("packId", "packRevision", "itemId", "itemRevision")
PUBLIC_METADATA = ("catalog.json", "source-catalog.json", "pdf-source-manifest.json",
                   "assembly-identities.json", "assembly-summary.json")


class AssemblyError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise AssemblyError(message)


def read_json(path):
    with Path(path).open(encoding="utf-8") as stream:
        return json.load(stream)


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name("." + path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def local_path(root, value, *, directory=False):
    require(isinstance(value, str) and bool(value) and not PurePosixPath(value).is_absolute()
            and not any(c in value for c in "\\\x00:%?#")
            and all(part not in ("", ".", "..") for part in value.split("/")), "unsafe-relative-path")
    path = Path(root)
    for part in value.split("/"):
        path = path / part
        require(not path.is_symlink(), "symlink-path")
    require(path.is_dir() if directory else path.is_file(), "missing-source-path:" + value)
    require(path.resolve().is_relative_to(Path(root).resolve()), "source-path-escapes-root")
    return path


def load_validator():
    spec = importlib.util.spec_from_file_location("assembly_sat_validator", ROOT / "docs/drafts/sat-question-packs/validate_examples.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def subject(row):
    sections = {module.get("section") for module in row.get("modules", [])}
    require(len(sections) == 1 and sections <= {"reading-writing", "math"}, "source-collection-not-single-subject")
    return next(iter(sections))


def match_identity(row):
    """Return a conservative identity key or an explicit nonmatching reason."""
    name = re.sub(r"\s+", "", unicodedata.normalize("NFKC", Path(row["sourceFile"]).stem))
    if "纯题目" in name:
        return None, "question-only-duplicate"
    if "bluebook" in name.lower():
        return None, "bluebook-has-no-official-year-month-set"
    if re.search(r"[&＆]|合并|去重", name):
        return None, "merged-or-deduplicated-source-is-not-one-clear-set"
    if "版本" in name:
        return None, "ambiguous-module-version"
    match = re.match(r"^(20[0-9]{2})年([0-9]{1,2})月(?:亚太|北美|美国|国际)?第([0-9]+)套", name)
    if not match:
        return None, "no-explicit-year-month-single-set-number"
    year, month, number = map(int, match.groups())
    if not 1 <= month <= 12 or number < 1:
        return None, "invalid-year-month-or-set-number"
    regions = set(re.findall("亚太|北美|美国|国际", name))
    if len(regions) > 1:
        return None, "multiple-explicit-regions"
    region = next(iter(regions), "")
    variant = "Easy" if re.search(r"easy|简单", name, re.I) else "standard"
    # Do not collapse an unexplained named module variant into standard.
    if re.search(r"hard|routing", name, re.I):
        return None, "unclassified-module-variant"
    return (year, month, number, region, variant), None


def identity_text(key):
    year, month, number, region, variant = key
    return f"{year}年{month}月{region}第{number}套SAT" + (" · Easy" if variant == "Easy" else "")


def registry_key(key):
    return json.dumps(list(key), ensure_ascii=False, separators=(",", ":"))


def verified_question_only_pair(entry, row, canonical, evidence_root):
    evidence = read_json(local_path(evidence_root, row["collectionId"] + ".json"))
    require(evidence.get("collectionId") == row["collectionId"]
            and evidence.get("sourceSha256") == entry["sourceSha256"], "question-only-evidence-source-mismatch")
    questions = evidence.get("questions")
    require(isinstance(questions, list) and len(questions) == row["questionCount"] == canonical["questionCount"],
            "question-only-pair-count-mismatch")
    source_ids = set()
    for question in questions:
        proof = question.get("pairedAnswerSource", {})
        source_id = question.get("sourceQuestionId")
        require(isinstance(source_id, str) and source_id not in source_ids, "question-only-pair-duplicate-source-id")
        source_ids.add(source_id)
        require(proof.get("collectionId") == canonical["collectionId"]
                and proof.get("sourceQuestionId") == source_id
                and isinstance(proof.get("contentFingerprint"), str)
                and re.fullmatch(r"[0-9a-f]{64}", proof["contentFingerprint"]), "question-only-pair-not-proven")
    return len(questions)


def plan_assembly(root, evidence_root):
    """Read original metadata/evidence one PDF at a time; never publish yet."""
    root, evidence_root = Path(root), Path(evidence_root)
    catalog = read_json(root / "source-catalog.json")
    manifest = read_json(root / "pdf-source-manifest.json")
    rows, entries = catalog.get("collections"), manifest.get("files")
    require(isinstance(rows, list) and isinstance(entries, list) and bool(rows), "invalid-source-inventory")
    indexed = {row["collectionId"]: row for row in rows}
    sources = {entry["collectionId"]: entry for entry in entries}
    require(len(indexed) == len(rows) == len(sources) == len(entries) and set(indexed) == set(sources),
            "source-inventory-not-one-pdf-per-collection")
    canonical_map, duplicates, excluded, canonical_rows = {}, [], [], []
    proof_questions = 0
    for row in rows:
        identity = row["collectionId"]
        entry = sources[identity]
        require((row.get("sourceFile"), row.get("sourceSha256")) == (entry.get("sourceFile"), entry.get("sourceSha256")),
                "source-manifest-catalog-disagree")
        require(row.get("status") == "converted", "source-not-converted")
        try:
            source_folder = local_path(root, row["directory"], directory=True)
        except AssemblyError as exc:
            if str(exc).startswith("missing-source-path:"):
                raise AssemblyError("assembly-requires-complete-source-staging: restore every source-catalog collection "
                                    "into a staging folder before assembly") from exc
            raise
        report = read_json(local_path(source_folder, "conversion-report.json"))
        require(report.get("collectionId") == identity and report.get("questionCount") == row["questionCount"],
                "source-report-count-or-identity-mismatch")
        if "纯题目" in row["sourceFile"]:
            paired = entry.get("answerSource", {}).get("collectionId")
            require(paired in indexed and "纯题目" not in indexed[paired]["sourceFile"], "question-only-source-has-no-answer-counterpart")
            require(subject(row) == subject(indexed[paired]), "question-only-pair-section-mismatch")
            require(entry["answerSource"].get("sourceSha256") == sources[paired]["sourceSha256"],
                    "question-only-answer-source-digest-mismatch")
            proof_questions += verified_question_only_pair(entry, row, indexed[paired], evidence_root)
            canonical_map[identity] = paired
            duplicates.append({"collectionId": identity, "sourceFile": row["sourceFile"], "canonicalCollectionId": paired,
                               "reason": "all-question-content-fingerprints-match-answered-source"})
        else:
            canonical_map[identity] = identity
            answer_counts = report.get("answerStatus", {})
            actual_answers = Counter()
            for name in report["packs"]:
                require(name in PACK_NAMES, "unsupported-source-pack-directory")
                folder = local_path(root, row["directory"] + "/" + name, directory=True)
                pack = read_json(local_path(folder, "pack.json"))
                solutions = read_json(local_path(folder, pack["files"]["solutions"]))["solutions"]
                actual_answers.update(solution["answer"]["status"] for solution in solutions)
            require(actual_answers == Counter(answer_counts), "source-answer-status-count-mismatch")
            known = actual_answers["needs-review"] + actual_answers["verified"]
            if known == 0:
                excluded.append({"collectionId": identity, "sourceFile": row["sourceFile"], "reason": "all-source-answers-missing"})
            else:
                canonical_rows.append(row)
    groups = defaultdict(lambda: defaultdict(list))
    unmatched = []
    for row in canonical_rows:
        key, reason = match_identity(row)
        if reason:
            unmatched.append({"collectionId": row["collectionId"], "sourceFile": row["sourceFile"], "reason": reason})
        else:
            groups[key][subject(row)].append(row)
    pairs = []
    for key, sections in sorted(groups.items()):
        reason = ("multiple-candidates-for-same-subject-identity" if any(len(candidates) > 1 for candidates in sections.values())
                  else "no-other-subject-with-identical-region-and-variant" if set(sections) != {"reading-writing", "math"} else None)
        if reason:
            unmatched.extend({"collectionId": row["collectionId"], "sourceFile": row["sourceFile"], "reason": reason}
                             for candidates in sections.values() for row in candidates)
        else:
            pairs.append((key, sections["reading-writing"][0], sections["math"][0]))
    return {"sourceCatalog": catalog, "manifest": manifest, "indexed": indexed, "canonicalMap": canonical_map,
            "canonicalRows": canonical_rows, "duplicates": duplicates, "excluded": excluded,
            "verifiedDuplicateQuestions": proof_questions, "pairs": pairs, "unmatched": unmatched}


def build_modules(source_order):
    groups = defaultdict(list)
    seen = set()
    for ref in source_order:
        require(ref.get("section") in ("reading-writing", "math") and type(ref.get("moduleNumber")) is int
                and ref["moduleNumber"] > 0 and type(ref.get("number")) is int and ref["number"] > 0,
                "invalid-source-position")
        position = (ref["section"], ref["moduleNumber"], ref["number"])
        require(position not in seen, "duplicate-combined-source-position")
        seen.add(position)
        groups[position[:2]].append(ref)
    standard = {("reading-writing", 1): 27, ("reading-writing", 2): 27, ("math", 1): 22, ("math", 2): 22}
    full = set(groups) == set(standard) and all(sorted(ref["number"] for ref in groups[key]) == list(range(1, count + 1))
                                                  for key, count in standard.items())
    modules, assessment_modules = [], []
    for section in ("reading-writing", "math"):
        for key in sorted(key for key in groups if key[0] == section):
            refs = sorted(groups[key], key=lambda ref: ref["number"])
            module = {"section": section, "moduleNumber": key[1], "questionCount": len(refs)}
            if full:
                module["durationSeconds"] = 1920 if section == "reading-writing" else 2100
            modules.append(module)
            assessment_modules.append({**module, "items": [{field: ref[field] for field in REFERENCE_FIELDS} for ref in refs]})
    return full, modules, assessment_modules


def validate_combined(folder, report, validator):
    """Check actual copied packs, source references and full assessment parity."""
    references = {}
    paths = [folder / name for name in report["packs"]]
    summaries = validator.validate_packs(paths)
    for path, summary in zip(paths, summaries):
        pack = read_json(path / "pack.json")
        declaration = report["packs"][path.name]
        require(declaration["questionCount"] == summary["itemCount"] and declaration["assetCount"] == summary["assetCount"],
                "combined-pack-count-mismatch")
        for version in summary["itemVersions"]:
            key = (pack["id"], pack["revision"], version["itemId"], version["itemRevision"])
            require(key not in references, "duplicate-combined-item-reference")
            references[key] = pack["section"]
    seen = set()
    for ref in report["sourceOrder"]:
        key = tuple(ref[field] for field in REFERENCE_FIELDS)
        require(key not in seen and references.get(key) == ref["section"], "combined-source-reference-mismatch")
        seen.add(key)
    require(seen == set(references) and len(seen) == report["questionCount"], "combined-reference-coverage-mismatch")
    full, modules, assessment_modules = build_modules(report["sourceOrder"])
    require(report["fullSAT"] == full and report["modules"] == modules, "combined-modules-mismatch")
    assessment_path = folder / "assessment.json"
    require(assessment_path.is_file() == full, "combined-assessment-presence-mismatch")
    if full:
        assessment = read_json(assessment_path)
        require(assessment["schemaVersion"] == "sat-assessment/0.1-draft" and assessment["fullSAT"] is True
                and assessment["questionCount"] == 98 and assessment["breakDurationSeconds"] == 600
                and assessment["modules"] == assessment_modules, "combined-assessment-content-mismatch")


def build_combination(root, identity, key, sources, validator):
    title = identity_text(key)
    reports = [(row, read_json(local_path(local_path(root, row["directory"], directory=True), "conversion-report.json")))
               for row in sources]
    source_order = [dict(ref) for _, report in reports for ref in report["sourceOrder"]]
    full, modules, assessment_modules = build_modules(source_order)
    summary_sources = [{"collectionId": row["collectionId"], "sourceFile": row["sourceFile"],
                        "sourceSha256": row["sourceSha256"], "questionCount": row["questionCount"], "section": subject(row)}
                       for row in sources]
    report = {"collectionId": identity, "title": title, "conversionMode": "pdf-assembled", "sourceUnmodified": True,
              "questionCount": len(source_order), "fullSAT": full, "assessmentFile": "assessment.json" if full else None,
              "sourceCollections": summary_sources, "sourceOrder": source_order, "modules": modules, "packs": {},
              "answerStatus": dict(sum((Counter(source.get("answerStatus", {})) for _, source in reports), Counter())),
              "explanationsMissing": sum(source.get("explanationsMissing", 0) for _, source in reports),
              "reviewNotes": [{**note, "sourceCollectionId": row["collectionId"]} for row, source in reports
                              for note in source.get("reviewNotes", [])]}
    temporary = Path(tempfile.mkdtemp(prefix=".pdf-assembly-", dir=root.parent))
    try:
        for row, source in reports:
            for name, declaration in source["packs"].items():
                require(name in PACK_NAMES and name not in report["packs"], "combined-pack-type-collision")
                folder = local_path(root, row["directory"] + "/" + name, directory=True)
                validator.validate_pack(folder)
                shutil.copytree(folder, temporary / name, ignore=shutil.ignore_patterns(".DS_Store"))
                report["packs"][name] = dict(declaration)
        if full:
            assessment = {"schemaVersion": "sat-assessment/0.1-draft", "title": title, "fullSAT": True,
                          "questionCount": len(source_order), "breakDurationSeconds": 600,
                          "sections": [{"section": section, "moduleCount": 2,
                                        "questionCount": sum(module["questionCount"] for module in modules if module["section"] == section)}
                                       for section in ("reading-writing", "math")], "modules": assessment_modules}
            write_json(temporary / "assessment.json", assessment)
        write_json(temporary / "conversion-report.json", report)
        validate_combined(temporary, report, validator)
        output = root / identity
        previous = None
        if output.exists():
            old = read_json(output / "conversion-report.json")
            require(old.get("conversionMode") == "pdf-assembled" and old.get("collectionId") == identity,
                    "refuse-to-overwrite-non-assembly-collection")
            previous = root.parent / (".pdf-previous-" + uuid.uuid4().hex)
            output.rename(previous)
        try:
            temporary.rename(output)
        except OSError:
            if previous is not None:
                previous.rename(output)
            raise
        if previous is not None:
            shutil.rmtree(previous)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return {"collectionId": identity, "title": title, "category": "测试", "status": "converted", "directory": identity,
            "questionCount": report["questionCount"], "fullSAT": full, "modules": modules,
            "sourceCollections": summary_sources, "assemblyIdentity": list(key)}


def check_publish_target(root, target):
    root, target = Path(root).resolve(), Path(target)
    require(not target.is_symlink(), "publish-target-is-symlink")
    resolved = target.resolve()
    require(not resolved.is_relative_to(root) and not root.is_relative_to(resolved), "publish-target-overlaps-source-staging")
    require(not target.exists() or target.is_dir() and not any(target.iterdir()), "publish-target-must-be-new-or-empty")


def export_public(root, publish_root):
    """Copy a validated public selection without pruning the source staging."""
    root, target = Path(root), Path(publish_root)
    check_publish_target(root, target)
    catalog = read_json(root / "catalog.json")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".pdf-publish-", dir=target.parent))
    try:
        for name in PUBLIC_METADATA:
            shutil.copy2(local_path(root, name), temporary / name)
        for name in ("README.md", "合并说明.md"):
            if (root / name).exists():
                shutil.copy2(local_path(root, name), temporary / name)
        for row in catalog["collections"]:
            folder = local_path(root, row["directory"], directory=True)
            require(not any(path.is_symlink() for path in folder.rglob("*")), "symlink-public-collection-member")
            shutil.copytree(folder, temporary / row["directory"], ignore=shutil.ignore_patterns(".DS_Store"))
        spec = importlib.util.spec_from_file_location("export_pdf_assembly_review", Path(__file__).with_name("review_pdf_assembly.py"))
        reviewer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(reviewer)
        review = reviewer.review_assembly(temporary)
        require(review["ok"], "exported-public-library-review-failed")
        check_publish_target(root, target)
        if target.exists():
            target.rmdir()  # The second check requires an empty directory.
        temporary.rename(target)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return target


def assemble(root, evidence_root, *, summary_path=None, publish_root=None):
    root, evidence_root = Path(root), Path(evidence_root)
    if publish_root is not None:
        check_publish_target(root, publish_root)
    plan = plan_assembly(root, evidence_root)
    registry_path = root / "assembly-identities.json"
    registry = read_json(registry_path) if registry_path.exists() else {"schemaVersion": "sat-pdf-assembly-identities/1", "entries": {}}
    require(registry.get("schemaVersion") == "sat-pdf-assembly-identities/1" and isinstance(registry.get("entries"), dict),
            "invalid-assembly-identity-registry")
    identities = []
    for key, rw, math in plan["pairs"]:
        name, source_ids = registry_key(key), [rw["collectionId"], math["collectionId"]]
        if name not in registry["entries"]:
            registry["entries"][name] = {"collectionId": "combined-" + uuid.uuid4().hex, "sourceCollectionIds": source_ids}
        entry = registry["entries"][name]
        require(entry.get("sourceCollectionIds") == source_ids, "assembly-source-identity-changed-requires-migration")
        require(isinstance(entry.get("collectionId"), str) and re.fullmatch(r"combined-[a-f0-9]{32}", entry["collectionId"]),
                "unsafe-combined-identity")
        identities.append(entry["collectionId"])
    require(len(identities) == len(set(identities)), "duplicate-combined-identity")
    # Persist UUIDs before generating copies so retrying a partial run is stable.
    write_json(registry_path, registry)
    validator = load_validator()
    combinations, publication = [], {}
    for key, rw, math in plan["pairs"]:
        identity = registry["entries"][registry_key(key)]["collectionId"]
        combined = build_combination(root, identity, key, [rw, math], validator)
        combinations.append(combined)
        publication[rw["collectionId"]] = publication[math["collectionId"]] = identity
    unmatched_ids = {entry["collectionId"] for entry in plan["unmatched"]}
    remaining = [row for row in plan["canonicalRows"] if row["collectionId"] in unmatched_ids]
    publication.update({row["collectionId"]: row["collectionId"] for row in remaining})
    published = sorted(remaining + combinations, key=lambda row: (row["title"], row["collectionId"]))
    mappings = []
    for entry in plan["manifest"]["files"]:
        identity = entry["collectionId"]
        canonical = plan["canonicalMap"][identity]
        target = publication.get(canonical)
        entry["canonicalCollectionId"] = canonical
        entry["publishedCollectionId"] = target
        entry["mappedPublishedCollectionId"] = target
        entry["mergedInto"] = target if target != identity else None
        entry["publicationStatus"] = "excluded-no-answers" if target is None else "published" if target == identity else "merged"
        mappings.append({key: entry[key] for key in ("collectionId", "sourceFile", "canonicalCollectionId",
                                                     "publishedCollectionId", "mappedPublishedCollectionId", "mergedInto", "publicationStatus")})
    source_ids = set(plan["indexed"])
    public_ids = {row["collectionId"] for row in published}
    summary = {"schemaVersion": "sat-pdf-assembly-summary/1", "sourceFilesUnmodified": True,
               "sourcePacksMovedOrDeleted": False,
               "summary": {"sourcePDFs": len(source_ids), "canonicalCollectionsWithAnswers": len(plan["canonicalRows"]),
                           "questionOnlyDuplicates": len(plan["duplicates"]), "verifiedDuplicateQuestions": plan["verifiedDuplicateQuestions"],
                           "combinedCollections": len(combinations), "fullSATCollections": sum(row["fullSAT"] for row in combinations),
                           "partialCombinedCollections": sum(not row["fullSAT"] for row in combinations),
                           "unmatchedCanonicalCollections": len(remaining), "publishedCollections": len(published),
                           "publishedQuestionCount": sum(row["questionCount"] for row in published),
                           "excludedNoAnswerCollections": len(plan["excluded"])},
               "combinations": combinations, "unmatched": plan["unmatched"], "duplicates": plan["duplicates"],
               "excluded": plan["excluded"], "sourceMappings": mappings,
               "unpublishedSourceCollections": sorted(source_ids - public_ids)}
    catalog = {"schemaVersion": "sat-offline-conversion-catalog/1", "sourceCatalog": "source-catalog.json",
               "assemblySummary": "assembly-summary.json", "collections": published}
    write_json(root / "pdf-source-manifest.json", plan["manifest"])
    write_json(root / "assembly-summary.json", summary)
    if summary_path is not None and Path(summary_path) != root / "assembly-summary.json":
        write_json(summary_path, summary)
    # The public index switches only after every newly generated collection passes.
    write_json(root / "catalog.json", catalog)
    if publish_root is not None:
        export_public(root, publish_root)
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT / "back-end/sat/questions/sat-packs/pdf-official")
    parser.add_argument("--evidence-root", type=Path, default=ROOT / "local-data/pdf-sat-conversion/extracted")
    parser.add_argument("--summary", type=Path)
    parser.add_argument("--publish-root", type=Path,
                        help="Export cataloged collections to a separate new/empty directory; preserve source staging")
    args = parser.parse_args(argv)
    try:
        summary = assemble(args.root, args.evidence_root, summary_path=args.summary, publish_root=args.publish_root)
    except (AssemblyError, OSError, ValueError, KeyError, TypeError) as exc:
        print("PDF SAT assembly failed: " + str(exc), file=sys.stderr)
        return 1
    print(json.dumps(summary["summary"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
