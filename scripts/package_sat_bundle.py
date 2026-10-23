#!/usr/bin/env python3
"""Validate and package one complete, offline, four-module SAT collection.

Python 3.10+, standard library only. Declared question-pack files are copied
unchanged. No browser records, backups, undeclared files, or network requests.
"""
from __future__ import annotations

import argparse
from collections import Counter
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_MODULES = (("reading-writing", 1, 27, 1920), ("reading-writing", 2, 27, 1920),
                    ("math", 1, 22, 2100), ("math", 2, 22, 2100))
EXPECTED_SECTIONS = [{"section": "reading-writing", "moduleCount": 2, "questionCount": 54},
                     {"section": "math", "moduleCount": 2, "questionCount": 44}]


class BundleError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise BundleError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(document):
    return (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=unique_pairs)


def local_path(root, relative):
    require(isinstance(relative, str) and relative and not relative.startswith("/")
            and not re.search(r"[\\\x00-\x1f:%?#]", relative)
            and all(part not in ("", ".", "..") for part in relative.split("/")), "Unsafe local bundle path")
    current = root
    require(not root.is_symlink(), "Symbolic collection roots are unsupported")
    for part in relative.split("/"):
        current /= part
        require(not current.is_symlink(), "Symbolic bundle paths are unsupported")
    require(current.resolve().is_relative_to(root.resolve()), "Bundle path escapes collection")
    return current


def validator():
    path = ROOT / "docs/drafts/sat-question-packs/validate_examples.py"
    spec = importlib.util.spec_from_file_location("sat_bundle_draft_validator", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def runtime_image_validator():
    # Match the actual local service's SVG subset and image MIME checks.
    path = ROOT / "scripts/serve_platform.py"
    spec = importlib.util.spec_from_file_location("sat_bundle_runtime_validation", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module._validate_static_image


def explicit_assessment(assessment, packs):
    """Check runtime references/order and add redundant, checked count metadata."""
    require(isinstance(assessment, dict) and isinstance(assessment.get("title"), str) and assessment["title"].strip(), "Assessment title is missing")
    require(assessment.get("fullSAT") is True and assessment.get("breakDurationSeconds") == 600, "Expected a full SAT with a 600-second break")
    require(isinstance(assessment.get("modules"), list) and len(assessment["modules"]) == 4, "Full SAT requires exactly four ordered modules")
    index = {}
    identities = set()
    for pack, items, solutions in packs:
        for item in items["items"]:
            ref = (pack["id"], pack["revision"], item["id"], item["revision"])
            require(ref not in index, "Duplicate package/item revision")
            index[ref] = pack["section"]
    result = deepcopy(assessment)
    seen = set()
    for module, expected in zip(result["modules"], EXPECTED_MODULES):
        section, number, count, seconds = expected
        require(isinstance(module, dict) and module.get("section") == section
                and type(module.get("moduleNumber")) is int and module["moduleNumber"] == number,
                "Module section/order must be Reading and Writing 1/2, then Math 1/2")
        require(type(module.get("durationSeconds")) is int and module["durationSeconds"] == seconds, "Incorrect standard module duration")
        require(isinstance(module.get("items"), list) and len(module["items"]) == count, "Incorrect module question count")
        if "questionCount" in module:
            require(type(module["questionCount"]) is int and module["questionCount"] == count, "Declared module count disagrees with items")
        for ref in module["items"]:
            require(isinstance(ref, dict) and set(ref) == {"packId", "packRevision", "itemId", "itemRevision"}, "Invalid runtime item reference")
            require(type(ref["packRevision"]) is int and type(ref["itemRevision"]) is int, "Reference revisions must be integers")
            key = (ref["packId"], ref["packRevision"], ref["itemId"], ref["itemRevision"])
            require(key in index, "Assessment refers to a missing package/item revision")
            require(index[key] == section, "Assessment reference belongs to another section")
            require(key not in seen and (ref["itemId"], ref["itemRevision"]) not in identities, "Assessment repeats a question")
            seen.add(key)
            identities.add((ref["itemId"], ref["itemRevision"]))
        module["questionCount"] = count
    require(seen == set(index), "The complete assessment must use every packaged question exactly once")
    if "questionCount" in result:
        require(type(result["questionCount"]) is int and result["questionCount"] == 98, "Declared total count disagrees with modules")
    if "sections" in result:
        require(result["sections"] == EXPECTED_SECTIONS, "Declared section counts disagree with modules")
    result["questionCount"] = 98
    result["sections"] = deepcopy(EXPECTED_SECTIONS)
    return result


def inspect_collection(collection, collection_id):
    collection = Path(collection)
    require(collection.is_dir() and not collection.is_symlink(), "Collection folder is missing or symbolic")
    require(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", collection_id or ""), "Invalid collection ID")
    manifests = sorted(collection.rglob("pack.json"))
    require(len(manifests) == 3, "This full SAT bundle needs the three separate response-type packs")
    checks = validator()
    checks.validate_packs([path.parent for path in manifests])
    check_image = runtime_image_validator()
    files, packs, descriptions, answers, explanations = {}, [], [], Counter(), Counter()
    pack_ids = set()
    for path in manifests:
        relative = path.relative_to(collection).as_posix()
        local_path(collection, relative)
        pack = read_json(path)
        require((pack["id"], pack["revision"]) not in pack_ids, "Duplicate package identity/revision")
        pack_ids.add((pack["id"], pack["revision"]))
        items = read_json(local_path(path.parent, pack["files"]["items"]))
        solutions = read_json(local_path(path.parent, pack["files"]["solutions"]))
        packs.append((pack, items, solutions))
        descriptions.append({"path": path.parent.relative_to(collection).as_posix(), "id": pack["id"], "revision": pack["revision"],
                             "section": pack["section"], "responseType": pack["responseType"], "questionCount": len(items["items"]), "assetCount": len(pack["assets"])})
        answers.update(solution["answer"]["status"] for solution in solutions["solutions"])
        explanations.update(solution["explanation"]["status"] for solution in solutions["solutions"])
        for asset in pack["assets"]:
            check_image(local_path(path.parent, asset["path"]).read_bytes(), asset["mediaType"])
        declared = ["pack.json", pack["files"]["items"], pack["files"]["solutions"]] + [asset["path"] for asset in pack["assets"]]
        for name in declared:
            source = local_path(path.parent, name)
            bundle_path = collection_id + "/" + source.relative_to(collection).as_posix()
            require(bundle_path not in files, "Duplicate output path")
            files[bundle_path] = source.read_bytes()
    require({(pack["section"], pack["responseType"]) for pack, _, _ in packs} == {
        ("reading-writing", "single-choice"), ("math", "single-choice"), ("math", "student-produced-response")}, "Expected three different SAT section/response-type packs")
    assessment_path = local_path(collection, "assessment.json")
    assessment = explicit_assessment(read_json(assessment_path), packs)
    files[collection_id + "/assessment.json"] = json_bytes(assessment)
    return files, assessment, descriptions, dict(answers), dict(explanations)


def readme(collection_id, assessment, answers, explanations):
    return f"""# {assessment['title']} · SAT 完整离线题包

本包包含一整套 98 题：Reading and Writing 27 + 27 题，Math 22 + 22 题。
英语两个模块各 32 分钟，数学两个模块各 35 分钟，英语与数学之间休息 10 分钟。
三种题型包独立保存；assessment.json 的有序引用决定原卷题号与模块顺序，不能把题型包顺序当作试卷顺序。

## 目录

- active.json：本机服务读取的活动集合配置。
- {collection_id}/assessment.json：整套配置，含总题数、分科汇总、模块题数/时长和有序题目版本引用。
- {collection_id}/ 下三个题型目录：pack.json、items.json、solutions.json，以及其声明的全部 assets。
- bundle-manifest.json：除清单自身外，每个文件的 SHA-256 与字节数。

## 完整模考的加载方式

1. 使用包含 SAT 新题包功能的 school-exam-platform 源码，先停止本机服务。
2. 保留接收电脑现有的 private-data/sat-packs/active.json 和活动题包；本 ZIP 不包含浏览器历史或备份，也不替代接收电脑的备份。
3. 将 active.json 与 {collection_id}/ 解压到仓库的 private-data/sat-packs/，形成 private-data/sat-packs/active.json 与 private-data/sat-packs/{collection_id}/assessment.json。
4. 在仓库根目录运行 python3 scripts/serve_platform.py --port 8888，打开 http://127.0.0.1:8888/sat/?view=dashboard 。
5. 服务加载完整集合后点击“全套模考”。集合切换会使用平台现有的先备份后归档流程；题目、模块顺序与计时由 assessment.json 恢复。

浏览器“Choose SAT Pack Folder”只导入题型包，不能恢复 assessment 或完整试卷顺序；不要用此方式声称已加载整套模考。
独立 SAT 旧本机服务也不会自动消费 active.json；整套加载应使用上面的统一服务。

## 数据与校验

文字使用 Markdown，公式使用 LaTeX；图片来自包内清单，不依赖原站图片链接。
原 pack.json、items.json、solutions.json、资源字节与题目/题包修订均未改；只在 assessment 中补充冗余计数字段。
答案状态：{json.dumps(answers, ensure_ascii=False)}。解析状态：{json.dumps(explanations, ensure_ascii=False)}。
needs-review 表示来源答案尚未人工核验，missing 表示解析缺失；本包不宣称答案已审核、官方自适应或量尺分已实现。
已检查三包结构与资源摘要、所有题目版本引用、无重复/漏题、27/27/22/22 与 32/32/35/35 分钟。
SHA 清单校验文件完整性，不代表标准答案正确性。ZIP 及其中真实题目只保存在本机 private-data，不提交到 Git。
"""


def verify_bundle(path):
    with zipfile.ZipFile(path) as archive:
        require(archive.testzip() is None, "ZIP CRC verification failed")
        names = archive.namelist()
        require(len(names) == len(set(names)), "ZIP has duplicate entries")
        for name in names:
            require(name and not name.startswith("/") and not re.search(r"[\\\x00-\x1f:%?#]", name)
                    and all(part not in ("", ".", "..") for part in name.split("/")), "Unsafe ZIP entry")
        manifest = json.loads(archive.read("bundle-manifest.json"), object_pairs_hook=unique_pairs)
        require(manifest.get("schemaVersion") == "sat-offline-assessment-bundle/1", "Unsupported bundle manifest")
        require(isinstance(manifest.get("collectionId"), str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}", manifest["collectionId"]), "Invalid bundle collection ID")
        listed = manifest.get("files")
        require(isinstance(listed, list) and len({entry["path"] for entry in listed}) == len(listed), "Invalid bundle file inventory")
        require(set(names) == {entry["path"] for entry in listed} | {"bundle-manifest.json"}, "Undeclared/missing ZIP entry")
        for entry in listed:
            data = archive.read(entry["path"])
            require(len(data) == entry["byteLength"] and digest(data) == entry["sha256"], "Bundle file checksum mismatch")
        # Private bundles are checked beside their ZIP, so real resources never
        # need to be copied into a system-wide temporary folder.
        with tempfile.TemporaryDirectory(prefix=".sat-bundle-check-", dir=Path(path).parent) as temporary:
            archive.extractall(temporary)
            collection_id = manifest["collectionId"]
            require(json.loads(archive.read("active.json")) == {"collectionId": collection_id, "root": collection_id}, "Bundle activity configuration is inconsistent")
            _, assessment, packs, answers, explanations = inspect_collection(Path(temporary) / collection_id, collection_id)
            require(manifest["questionCount"] == assessment["questionCount"] and manifest["sections"] == assessment["sections"], "Bundle totals disagree with assessment")
            modules = [{key: module[key] for key in ("section", "moduleNumber", "questionCount", "durationSeconds")} for module in assessment["modules"]]
            require(manifest["modules"] == modules, "Bundle module summary disagrees with assessment")
            require(manifest["packs"] == packs and manifest["answerStatus"] == answers and manifest["explanationStatus"] == explanations, "Bundle pack/review summary mismatch")
        return manifest


def atomic_write(path, data):
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix="." + path.name + "-", delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def build_bundle(collection, output, *, collection_id=None, update_assessment=False, replace=False):
    collection, output = Path(collection), Path(output)
    collection_id = collection_id or collection.name
    require(not output.is_symlink() and (not output.exists() or replace), "Bundle output exists or is symbolic; use --replace for a generated ZIP")
    require(output.suffix.lower() == ".zip", "Bundle output must be a ZIP")
    files, assessment, packs, answers, explanations = inspect_collection(collection, collection_id)
    files["active.json"] = json_bytes({"collectionId": collection_id, "root": collection_id})
    files["README.zh-CN.md"] = readme(collection_id, assessment, answers, explanations).encode("utf-8")
    manifest = {"schemaVersion": "sat-offline-assessment-bundle/1", "collectionId": collection_id,
                "assessmentPath": collection_id + "/assessment.json", "questionCount": 98, "sections": assessment["sections"],
                "modules": [{key: module[key] for key in ("section", "moduleNumber", "questionCount", "durationSeconds")} for module in assessment["modules"]],
                "packs": packs, "answerStatus": answers, "explanationStatus": explanations,
                "files": [{"path": name, "byteLength": len(data), "sha256": digest(data)} for name, data in sorted(files.items())]}
    files["bundle-manifest.json"] = json_bytes(manifest)
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=output.parent, prefix=".sat-bundle-", suffix=".zip", delete=False) as stream:
            temporary = Path(stream.name)
        with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
            for name, data in sorted(files.items()):
                info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                archive.writestr(info, data, compresslevel=9)
        verify_bundle(temporary)
        os.replace(temporary, output)
        atomic_write(output.with_suffix(output.suffix + ".sha256"), (digest(output.read_bytes()) + "  " + output.name + "\n").encode("utf-8"))
        if update_assessment:
            atomic_write(collection / "assessment.json", json_bytes(assessment))
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collection", type=Path, help="Local collection directory; defaults to active.json's collection")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--update-assessment", action="store_true", help="Also save the checked count metadata in the source assessment")
    parser.add_argument("--replace", action="store_true")
    args = parser.parse_args()
    base = ROOT / "private-data/sat-packs"
    if args.collection:
        collection, collection_id = args.collection, args.collection.name
    else:
        active = read_json(local_path(base, "active.json"))
        collection_id = active["collectionId"]
        collection = local_path(base, active["root"])
    output = args.output or ROOT / "private-data/exports" / (collection_id + "-sat-full-offline.zip")
    manifest = build_bundle(collection, output, collection_id=collection_id, update_assessment=args.update_assessment, replace=args.replace)
    print(json.dumps({"output": str(output), "collectionId": collection_id, "questionCount": manifest["questionCount"],
                      "sections": manifest["sections"], "modules": manifest["modules"], "packs": manifest["packs"],
                      "zipBytes": output.stat().st_size, "zipSha256": digest(output.read_bytes())}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
