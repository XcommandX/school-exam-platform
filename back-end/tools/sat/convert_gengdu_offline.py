#!/usr/bin/env python3
"""Convert the three authorized Gengdu offline folders without activating them.

Only question content, source standard answers, and declared media are read.
Source files and the current active SAT collection are never changed.
"""
from __future__ import annotations

import argparse
from collections import Counter
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
import uuid
import zipfile


ROOT = Path(__file__).resolve().parents[3]
CATEGORIES = ("测试", "数学", "英语")
CATEGORY_DIRECTORIES = {"测试": "全真模考", "数学": "数学真题", "英语": "英语真题"}


def output_directory(directory, category):
    """Keep original categories/identities while using the agreed display folders."""
    parts = Path(safe_relative(directory)).parts
    if parts[0] not in (category, CATEGORY_DIRECTORIES[category]):
        raise ValueError("Conflicting category or collection identity")
    return Path(CATEGORY_DIRECTORIES[category], *parts[1:]).as_posix()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def load_converter():
    spec = importlib.util.spec_from_file_location("gengdu_offline_converter", Path(__file__).with_name("convert_gengdu_sat.py"))
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def safe_relative(value):
    if not isinstance(value, str) or not value or re.search(r'[\\<>:"|?*\x00-\x1f]', value) or Path(value).is_absolute() or any(part in ("", ".", "..") for part in value.split("/")):
        raise ValueError("Unsafe relative collection path")
    return value


def no_symlinks(path):
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ValueError("Symbolic source/output paths are unsupported")


def folder_name(title, collection_id):
    readable = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", title).strip(" .")[:24].rstrip(" .") or "题集"
    return readable + "--" + collection_id.removeprefix("gengdu-offline-")[:8]


def category_catalog(catalog, category):
    rows = [row for row in catalog["collections"] if row["category"] == category]
    return {"schemaVersion": catalog["schemaVersion"], "category": category,
            "categoryDirectories": catalog.get("categoryDirectories", {category: category}),
            "summary": catalog["categories"][category], "collections": rows}


def make_zip(root, category, catalog, *, archive_root=None, category_root=None):
    directory = catalog.get("categoryDirectories", {}).get(category, category)
    safe_relative(directory)
    category_root = Path(category_root) if category_root else root / directory
    if not category_root.is_dir():
        raise ValueError("Category output directory is missing: " + directory)
    archive_root = Path(archive_root) if archive_root else root
    files = {(Path(directory) / path.relative_to(category_root)).as_posix(): path.read_bytes()
             for path in sorted(category_root.rglob("*")) if path.is_file() and path.name != ".DS_Store"}
    files["catalog.json"] = json_bytes(category_catalog(catalog, category))
    files["README.md"] = (
        f"# 耕读离线题包 · {directory}\n\n"
        "每个原始 JSON 独立转换，再按 SAT 科目与作答类型拆包；目录保留原分类。\n"
        "解压后可在 SAT Add Questions → Choose SAT Pack Folder 选择本分类目录或单个题集目录。\n"
        "文件夹导入只导题型包，不自动激活 assessment；本包不会替换现有模考配置。\n"
        "标准答案均待审核，缺失解析不补写；详细警告和原顺序见各题集 conversion-report.json。\n"
        "catalog.json 标出严格完整四模块试卷；其余不补题、不推定模块分支。\n"
        "真实题目和资源仅本机保存，不提交到 Git。\n"
    ).encode("utf-8")
    manifest = {"schemaVersion": "sat-offline-bundle-manifest/1", "files": [
        {"path": name, "sha256": digest(data), "byteLength": len(data)} for name, data in sorted(files.items())]}
    files["bundle-manifest.json"] = json_bytes(manifest)
    archive = archive_root / (directory + ".zip")
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as bundle:
        for name, data in sorted(files.items()):
            bundle.writestr(name, data)
    with zipfile.ZipFile(archive) as bundle:
        if bundle.testzip() is not None or set(bundle.namelist()) != set(files):
            raise ValueError("Category ZIP integrity check failed")
        for entry in manifest["files"]:
            data = bundle.read(entry["path"])
            if len(data) != entry["byteLength"] or digest(data) != entry["sha256"]:
                raise ValueError("Category ZIP hash check failed")
    checksum = digest(archive.read_bytes())
    (archive_root / (directory + ".zip.sha256")).write_text(checksum + "  " + directory + ".zip\n", encoding="utf-8")
    return {"path": archive.name, "sha256": checksum, "byteLength": archive.stat().st_size, "fileCount": len(files)}


def collection_readme(catalog):
    table = "\n".join(f"| {CATEGORY_DIRECTORIES[category]} | {s['convertedFiles']}/{s['sourceFiles']} | {s['convertedQuestions']}/{s['sourceQuestions']} | {s['packs']} | {s['fullSAT']} |" for category, s in catalog["categories"].items())
    return (
        "# 耕读离线题包 · SAT 新格式\n\n"
        "每个源 JSON 保留为独立题集，并按读写四选一、数学四选一、数学填空分别存包。\n"
        "没有删去跨不同来源 ID 的重复内容；原分类及题号、模块映射见 catalog.json 和各 conversion-report.json。\n"
        "显示目录为全真模考、数学真题、英语真题；catalog 的原分类仍为测试、数学、英语，categoryDirectories 保存目录映射。\n\n"
        "| 分类 | 成功文件/来源文件 | 转换题数/来源题数 | 题型包 | 标准完整 SAT |\n| --- | ---: | ---: | ---: | ---: |\n" + table + "\n\n"
        "三个分类 ZIP 均带全部资源与逐文件 SHA 清单，附 ZIP 的 .sha256。解压后可从 SAT Add Questions → Choose SAT Pack Folder 导入。\n"
        "文件夹导入只导题型包，不自动切换完整 assessment；当前活动卷和个人记录未变。\n"
        "仅严格符合读写27+27、数学22+22、模块1/2且源题号连续的题集生成 fullSAT assessment；其他情况不擅自映射、重编号或补题。\n"
        "答案仍待人工核对；源解析缺失则标 missing，不生成解析。源排版冲突、无信息WPS残留、资源转换等见逐题报告。\n"
        "source-identities.json 是持久身份表，重跑时保留，不能按文件名或题目内容重新生成身份。\n"
        "本目录包含真实题目，仅存本机 local-data，不进入 Git。\n")


def synchronize_catalog(output, *, backup_root=None):
    """Repair category paths and rebuild bundles without reconverting any item."""
    output = Path(output).absolute()
    no_symlinks(output)
    output = output.resolve()
    backups = Path(backup_root).absolute() if backup_root else ROOT / "local-data/backups"
    no_symlinks(backups)
    backups = backups.resolve()
    if backups.is_relative_to(output) or output.is_relative_to(backups):
        raise ValueError("Keep index backups separate from converted output")
    catalog = json.loads((output / "catalog.json").read_text(encoding="utf-8"))
    identities = json.loads((output / "source-identities.json").read_text(encoding="utf-8"))
    if catalog.get("schemaVersion") != "sat-offline-conversion-catalog/1" or identities.get("schemaVersion") != "gengdu-offline-identities/1":
        raise ValueError("Existing catalog or identity registry is invalid")
    reports = {}
    for path in output.rglob("conversion-report.json"):
        no_symlinks(path)
        report = json.loads(path.read_text(encoding="utf-8"))
        identity = report["collectionId"]
        if identity in reports:
            raise ValueError("Duplicate collection report identity")
        reports[identity] = (path, report)
    moves, roots = [], {}
    for category in CATEGORIES:
        old, new = output / category, output / CATEGORY_DIRECTORIES[category]
        if old.is_dir() and new.exists():
            raise ValueError("Both old and new category directories exist")
        roots[category] = old if old.is_dir() else new
        no_symlinks(roots[category])
        if not roots[category].is_dir():
            raise ValueError("Category output directory is missing")
        if roots[category] != new:
            moves.append((old, new))
    for row in catalog["collections"]:
        category = row["category"]
        if category not in CATEGORY_DIRECTORIES:
            raise ValueError("Unknown source category")
        identity = identities["entries"].get(row["sourceFile"])
        if not identity or (identity["collectionId"], identity["sourceSha256"]) != (row["collectionId"], row["sourceSha256"]):
            raise ValueError("Catalog and persisted source identity disagree")
        directory = output_directory(identity["directory"], category)
        if row["status"] == "converted":
            matched = reports.pop(row["collectionId"], None)
            if matched is None:
                raise ValueError("Catalog collection has no matching report")
            path, report = matched
            expected = roots[category] / Path(directory).relative_to(CATEGORY_DIRECTORIES[category]) / "conversion-report.json"
            if path != expected or (report["sourceSha256"], report["questionCount"]) != (row["sourceSha256"], row["questionCount"]):
                raise ValueError("Collection report does not match catalog path, source or count")
            row["reportFile"] = directory + "/conversion-report.json"
        row["directory"] = identity["directory"] = directory
    if reports:
        raise ValueError("Collection reports are absent from catalog")
    converter = load_converter()
    converter.load_validator().validate_packs(sorted(path.parent for path in output.rglob("pack.json")))
    old_archives = [safe_relative(archive["path"]) for archive in catalog.get("archives", {}).values()]
    catalog["categoryDirectories"] = CATEGORY_DIRECTORIES.copy()
    catalog["pathsSynchronizedAt"] = datetime.now(timezone.utc).isoformat()
    temporary = Path(tempfile.mkdtemp(prefix=".gengdu-index-", dir=output.parent))
    try:
        catalog["archives"] = {category: make_zip(output, category, catalog, archive_root=temporary, category_root=roots[category]) for category in CATEGORIES}
        (temporary / "catalog.json").write_bytes(json_bytes(catalog))
        (temporary / "source-identities.json").write_bytes(json_bytes(identities))
        (temporary / "README.md").write_text(collection_readme(catalog), encoding="utf-8")
        replace_names = [path.name for path in temporary.iterdir()]
        retire_names = [name for name in [*old_archives, *(name + ".sha256" for name in old_archives)] if name not in replace_names]
        backups.mkdir(parents=True, exist_ok=True)
        backup = backups / ("gengdu-index-before-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8])
        backup.mkdir()
        for name in set(replace_names + retire_names):
            if (output / name).is_file():
                shutil.copy2(output / name, backup / name)
        completed_moves = []
        try:
            for before, after in moves:
                before.rename(after)
                completed_moves.append((before, after))
            for name in replace_names:
                (temporary / name).replace(output / name)
            for name in retire_names:
                (output / name).unlink(missing_ok=True)
        except OSError:
            for name in set(replace_names + retire_names):
                if (backup / name).is_file():
                    shutil.copy2(backup / name, output / name)
                else:
                    (output / name).unlink(missing_ok=True)
            for before, after in reversed(completed_moves):
                after.rename(before)
            raise
        (backup / "directory-moves.json").write_bytes(json_bytes([{ "from": before.relative_to(output).as_posix(), "to": after.relative_to(output).as_posix()} for before, after in moves]))
        return catalog
    finally:
        shutil.rmtree(temporary)


def check_unchanged_revisions(previous, fresh):
    fresh_packages = {}
    for path in fresh.rglob("pack.json"):
        pack = json.loads(path.read_text(encoding="utf-8"))
        if pack["id"] in fresh_packages:
            raise ValueError("Duplicate generated package identity")
        fresh_packages[pack["id"]] = (path, pack)
    for old_path in previous.rglob("pack.json"):
        relative = old_path.relative_to(previous)
        old = json.loads(old_path.read_text(encoding="utf-8"))
        match = fresh_packages.get(old["id"])
        if match is None:
            continue
        new_path, new = match
        if (old["id"], old["revision"]) != (new["id"], new["revision"]):
            continue
        declared = ["pack.json", *old["files"].values(), *(a["path"] for a in old["assets"])]
        if any(not (new_path.parent / name).is_file() or (old_path.parent / name).read_bytes() != (new_path.parent / name).read_bytes() for name in declared):
            raise ValueError("Converted content changed for an existing package revision; review and revise explicitly: " + str(relative))


def _read_package(path):
    pack = json.loads(path.read_text(encoding="utf-8"))
    files = pack["files"]
    for name in (files["items"], files["solutions"], *(asset["path"] for asset in pack["assets"])):
        safe_relative(name)
        no_symlinks(path.parent / name)
    items = json.loads((path.parent / files["items"]).read_text(encoding="utf-8"))
    solutions = json.loads((path.parent / files["solutions"]).read_text(encoding="utf-8"))
    assets = {}
    for asset in pack["assets"]:
        actual = digest((path.parent / asset["path"]).read_bytes())
        if actual != asset["sha256"] or asset["id"] in assets:
            raise ValueError("Existing/generated resource identity or SHA-256 is invalid")
        assets[asset["id"]] = actual
    return pack, items, solutions, assets


def _versioned_items(pack, items, solutions, assets):
    by_id, solution_index = {}, {}
    for solution in solutions["solutions"]:
        if solution["itemId"] in solution_index:
            raise ValueError("Duplicate source solution identity during revision reconciliation")
        solution_index[solution["itemId"]] = solution
    for item in items["items"]:
        identity = item["id"]
        if identity in by_id or identity not in solution_index or solution_index[identity]["itemRevision"] != item["revision"]:
            raise ValueError("Invalid source item/solution revision during reconciliation")
        referenced = set()
        def images(value):
            if isinstance(value, dict):
                if value.get("type") == "image":
                    referenced.add(value["assetId"])
                for child in value.values():
                    images(child)
            elif isinstance(value, list):
                for child in value:
                    images(child)
        solution = solution_index[identity]
        images(item)
        images(solution)
        payload = {"section": pack["section"], "responseType": pack["responseType"],
                   "item": {key: value for key, value in item.items() if key != "revision"},
                   "solution": {key: value for key, value in solution.items() if key != "itemRevision"},
                   "assetDigests": {key: assets[key] for key in sorted(referenced)}}
        by_id[identity] = {"item": item, "solution": solution, "payload": payload}
    if set(solution_index) != set(by_id):
        raise ValueError("Unmatched source solution during revision reconciliation")
    return by_id


def reconcile_revisions(previous, fresh):
    """Advance only changed content while retaining persisted package/item IDs.

    This handles converter improvements for identical original source bytes.
    convert_batch's source-SHA guard still refuses changed original exports.
    """
    old_packages = {}
    for path in sorted(previous.rglob("pack.json")):
        package = _read_package(path)
        identity = package[0]["id"]
        if identity in old_packages:
            raise ValueError("Duplicate previous package identity")
        old_packages[identity] = package
    changes, references = [], {}
    for path in sorted(fresh.rglob("pack.json")):
        pack, items, solutions, assets = _read_package(path)
        identity = pack["id"]
        current = _versioned_items(pack, items, solutions, assets)
        old = old_packages.get(identity)
        if old:
            old_pack, old_items, old_solutions, old_assets = old
            previous_items = _versioned_items(*old)
            for item_id, entry in current.items():
                before = previous_items.get(item_id)
                if before:
                    revision = before["item"]["revision"] + int(before["payload"] != entry["payload"])
                    if revision != before["item"]["revision"]:
                        changes.append({"type": "item", "packId": identity, "itemId": item_id,
                                        "previousRevision": before["item"]["revision"], "revision": revision,
                                        "reason": "converted-content-changed"})
                else:
                    revision = 1
                    changes.append({"type": "item", "packId": identity, "itemId": item_id,
                                    "previousRevision": None, "revision": 1, "reason": "new-item"})
                entry["item"]["revision"] = revision
                entry["solution"]["itemRevision"] = revision
            changed = ({key: value for key, value in old_pack.items() if key != "revision"}
                       != {key: value for key, value in pack.items() if key != "revision"}
                       or old_items != items or old_solutions != solutions or old_assets != assets)
            pack["revision"] = old_pack["revision"] + int(changed)
            if changed:
                changes.append({"type": "pack", "packId": identity, "previousRevision": old_pack["revision"],
                                "revision": pack["revision"], "reason": "converted-package-changed"})
        else:
            pack["revision"] = 1
            for entry in current.values():
                entry["item"]["revision"] = entry["solution"]["itemRevision"] = 1
        for item_id, entry in current.items():
            key = identity, item_id
            if key in references:
                raise ValueError("Duplicate generated package/item identity")
            references[key] = pack["revision"], entry["item"]["revision"]
        path.write_bytes(json_bytes(pack))
        (path.parent / pack["files"]["items"]).write_bytes(json_bytes(items))
        (path.parent / pack["files"]["solutions"]).write_bytes(json_bytes(solutions))

    def update_reference(reference):
        key = reference["packId"], reference["itemId"]
        if key not in references:
            raise ValueError("Unresolved package/item reference during reconciliation")
        reference["packRevision"], reference["itemRevision"] = references[key]
    for path in fresh.rglob("assessment.json"):
        assessment = json.loads(path.read_text(encoding="utf-8"))
        for module in assessment["modules"]:
            for reference in module["items"]:
                update_reference(reference)
        path.write_bytes(json_bytes(assessment))
    for path in fresh.rglob("conversion-report.json"):
        report = json.loads(path.read_text(encoding="utf-8"))
        for reference in report["sourceOrder"]:
            update_reference(reference)
        pack_ids = {reference["packId"] for reference in report["sourceOrder"]}
        report["revisionChanges"] = [change for change in changes if change["packId"] in pack_ids]
        path.write_bytes(json_bytes(report))
    # Keep the existing byte-level guard: a package revision retained above must
    # still reproduce every declared authoring file and asset exactly.
    check_unchanged_revisions(previous, fresh)
    return changes


def convert_batch(source, output, *, archive=None, image_cache=None, replace=False, backup_root=None):
    source, output = Path(source).absolute(), Path(output).absolute()
    archive = Path(archive).absolute() if archive else source.parent
    for path in (source, output, archive):
        no_symlinks(path)
    source, output, archive = (path.resolve() for path in (source, output, archive))
    backups = Path(backup_root).absolute() if backup_root else ROOT / "local-data/backups"
    no_symlinks(backups)
    backups = backups.resolve()
    if backups.is_relative_to(archive) or backups.is_relative_to(source) or backups.is_relative_to(output):
        raise ValueError("Keep backups separate from the source/archive and converted output")
    if not source.is_dir() or any(not (source / category).is_dir() for category in CATEGORIES):
        raise ValueError("Source must contain 测试、数学、英语 offline folders")
    if output.is_relative_to(archive) or source.is_relative_to(output):
        raise ValueError("Keep converted output separate from the original source/archive")
    if output.exists() and not replace:
        raise ValueError("Output already exists; use --replace to preserve it as a backup first")
    identities = {"schemaVersion": "gengdu-offline-identities/1", "entries": {}}
    if output.exists():
        identities = json.loads((output / "source-identities.json").read_text(encoding="utf-8"))
        if identities.get("schemaVersion") != "gengdu-offline-identities/1" or not isinstance(identities.get("entries"), dict):
            raise ValueError("Existing source identity registry is invalid")
    files = sorted(path for category in CATEGORIES for path in (source / category).rglob("*.json"))
    if not files:
        raise ValueError("There are no offline question JSON files")
    converter = load_converter()
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".gengdu-offline-", dir=output.parent))
    before, seen_ids, rows = {}, set(), []
    try:
        for category in CATEGORIES:
            (temporary / CATEGORY_DIRECTORIES[category]).mkdir()
        for path in files:
            no_symlinks(path)
            relative = path.relative_to(source).as_posix()
            raw = path.read_bytes()
            before[relative] = digest(raw)
            document = json.loads(raw)
            identity = identities["entries"].get(relative)
            if identity:
                if identity.get("sourceSha256") != before[relative]:
                    raise ValueError("Source changed for an existing identity; review and revise it explicitly: " + relative)
                collection_id = identity.get("collectionId", "")
                if not re.fullmatch(r"gengdu-offline-[a-f0-9]{32}", collection_id):
                    raise ValueError("Invalid persisted collection ID")
            else:
                collection_id = "gengdu-offline-" + uuid.uuid4().hex
                directory = path.parent.relative_to(source) / folder_name(path.stem, collection_id)
                identity = {"collectionId": collection_id, "sourceSha256": before[relative], "directory": directory.as_posix()}
                identities["entries"][relative] = identity
            category = Path(relative).parts[0]
            directory = output_directory(identity["directory"], category)
            identity["directory"] = directory
            if collection_id in seen_ids:
                raise ValueError("Conflicting category or collection identity")
            seen_ids.add(collection_id)
            row = {"sourceFile": relative, "sourceSha256": before[relative], "category": Path(relative).parts[0],
                   "title": str(document.get("title", path.stem)), "collectionId": collection_id,
                   "directory": directory, "sourceQuestionCount": len(document.get("questions", []))}
            try:
                options = {"collection_id": collection_id, "archive": archive, "source_sha256": before[relative],
                           "mode": "bank", "source_path": path, "item_namespace": "collection"}
                if image_cache is not None:
                    options["image_cache"] = Path(image_cache)
                report = converter.convert_document(document, temporary / directory, **options)
                row.update({"status": "converted", "questionCount": report["questionCount"], "packs": report["packs"],
                            "fullSAT": report["fullSAT"], "assessmentFile": report.get("assessmentFile"),
                            "explanationsMissing": report["explanationsMissing"], "warningCount": len(report["reviewNotes"]),
                            "reportFile": directory + "/conversion-report.json"})
                print("Converted: " + relative, flush=True)
            except (ValueError, OSError) as error:
                row.update({"status": "failed", "questionCount": 0, "error": str(error)})
                print("Needs attention: " + relative + ": " + str(error), flush=True)
            rows.append(row)
        if any(digest((source / name).read_bytes()) != expected for name, expected in before.items()):
            raise ValueError("An original source changed during conversion")
        revision_changes = []
        if output.exists():
            revision_changes = reconcile_revisions(output, temporary)
        validator = converter.load_validator()
        summaries = validator.validate_packs(sorted(path.parent for path in temporary.rglob("pack.json")))
        if output.exists():
            validator.validate_packs(sorted(path.parent for path in output.rglob("pack.json"))
                                     + sorted(path.parent for path in temporary.rglob("pack.json")))
        categories = {}
        for category in CATEGORIES:
            members = [row for row in rows if row["category"] == category]
            categories[category] = {"sourceFiles": len(members), "convertedFiles": sum(row["status"] == "converted" for row in members),
                                    "sourceQuestions": sum(row["sourceQuestionCount"] for row in members),
                                    "convertedQuestions": sum(row["questionCount"] for row in members),
                                    "packs": sum(len(row.get("packs", {})) for row in members),
                                    "fullSAT": sum(row.get("fullSAT", False) for row in members)}
        catalog = {"schemaVersion": "sat-offline-conversion-catalog/1", "status": "complete" if all(row["status"] == "converted" for row in rows) else "partial",
                   "createdAt": datetime.now(timezone.utc).isoformat(), "sourceUnmodified": True, "activeCollectionChanged": False,
                   "identityPolicy": "Persisted UUID per original file; item IDs additionally include source question ID; no deduplication",
                   "categories": categories, "categoryDirectories": CATEGORY_DIRECTORIES.copy(),
                   "validatedPacks": len(summaries), "revisionChanges": revision_changes, "collections": rows}
        (temporary / "source-identities.json").write_bytes(json_bytes(identities))
        (temporary / "catalog.json").write_bytes(json_bytes(catalog))
        catalog["archives"] = {category: make_zip(temporary, category, catalog) for category in CATEGORIES}
        (temporary / "catalog.json").write_bytes(json_bytes(catalog))
        (temporary / "README.md").write_text(collection_readme(catalog), encoding="utf-8")
        if output.exists():
            backups.mkdir(parents=True, exist_ok=True)
            backup = backups / ("gengdu-offline-before-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S") + "-" + uuid.uuid4().hex[:8])
            output.rename(backup)
            try:
                temporary.rename(output)
            except OSError:
                backup.rename(output)
                raise
        else:
            temporary.rename(output)
        return catalog
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=ROOT / "local-data/references/Reference Folders/耕读合集/离线题包")
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "local-data/sat-packs/gengdu-offline")
    parser.add_argument("--image-cache", type=Path)
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--sync-index", action="store_true", help="Synchronize renamed category folders, catalog, identities and ZIPs without reconverting questions")
    args = parser.parse_args()
    try:
        catalog = (synchronize_catalog(args.output) if args.sync_index else
                   convert_batch(args.source, args.output, archive=args.archive, image_cache=args.image_cache, replace=args.replace))
    except (ValueError, OSError) as error:
        parser.exit(1, "Offline conversion refused: " + str(error) + "\n")
    print(json.dumps({"status": catalog["status"], "categories": catalog["categories"], "validatedPacks": catalog["validatedPacks"]}, ensure_ascii=False, indent=2))
    if catalog["status"] != "complete":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
