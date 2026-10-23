"""Original synthetic PDF-library fixtures exercise conservative assembly."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

import _paths
from server.serve_platform import read_sat_library


def load_module(name, filename):
    spec = importlib.util.spec_from_file_location(name, _paths.ROOT / "back-end/tools/sat" / filename)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


ASSEMBLY = load_module("pdf_sat_assembler", "assemble_pdf_sat.py")
CONVERTER = load_module("pdf_assembly_synthetic_builder", "convert_gengdu_sat.py")


class PdfSatAssemblyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.root = self.base / "library"
        self.root.mkdir()
        self.evidence = self.base / "evidence"
        self.rows, self.entries = [], []

    def write(self, path, value):
        ASSEMBLY.write_json(path, value)

    def read(self, path):
        return ASSEMBLY.read_json(path)

    def add_source(self, identity, section, title, counts=(1,), *, answers=True, counterpart=None):
        questions = []
        for module, count in enumerate(counts, 1):
            for number in range(1, count + 1):
                spr = section == "math" and number == count
                question = {"question_id": f"m{module}-q{number}", "part_type": "Math" if section == "math" else "ReadingAndWriting",
                            "module_number": module, "number": number, "question_type": "response" if spr else "choice",
                            "prompt_html": "<p>Original synthetic assembly question: what is 1 + 1?</p>"}
                if not spr:
                    question["choices"] = [{"label": label, "html": str(value)} for label, value in zip("ABCD", (1, 2, 3, 4))]
                if answers:
                    question["correct_answer"] = "2" if spr else "B"
                questions.append(question)
        digest = hashlib.sha256(identity.encode()).hexdigest()
        report = CONVERTER.convert_document({"title": title, "questions": questions}, self.root / identity,
            collection_id=identity, source_sha256=digest, mode="bank")
        source_file = ("数学/" if section == "math" else "阅读文法/") + title + ".pdf"
        report["sourceFile"] = source_file
        self.write(self.root / identity / "conversion-report.json", report)
        row = {"collectionId": identity, "sourceFile": source_file, "sourceSha256": digest, "directory": identity,
               "title": title, "status": "converted", "category": "测试", "questionCount": len(questions),
               "fullSAT": False, "modules": report["modules"]}
        entry = {key: row[key] for key in ("collectionId", "sourceFile", "sourceSha256")}
        if counterpart is not None:
            entry["answerSource"] = {key: counterpart[key] for key in ("collectionId", "sourceFile", "sourceSha256")}
            self.write(self.evidence / (identity + ".json"), {**entry, "questions": [
                {"sourceQuestionId": question["question_id"], "pairedAnswerSource": {
                    "collectionId": counterpart["collectionId"], "sourceQuestionId": question["question_id"],
                    "contentFingerprint": "a" * 64}} for question in questions]})
        self.rows.append(row)
        self.entries.append(entry)
        return row

    def save_inventory(self):
        catalog = {"schemaVersion": "sat-offline-conversion-catalog/1", "collections": self.rows}
        self.write(self.root / "source-catalog.json", catalog)
        self.write(self.root / "catalog.json", catalog)
        self.write(self.root / "pdf-source-manifest.json", {"schemaVersion": "sat-pdf-source-manifest/1", "files": self.entries})

    def assemble(self):
        self.save_inventory()
        return ASSEMBLY.assemble(self.root, self.evidence)

    def test_complete_pair_has_four_timed_modules_and_preserves_all_source_pack_bytes(self):
        rw = self.add_source("pdf-rw", "reading-writing", "2026年10月第3套阅读语法", (27, 27))
        math = self.add_source("pdf-math", "math", "2026年10月第3套数学", (22, 22))
        pack_folder = self.root / "pdf-rw/rw-single-choice"
        asset = b'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>'
        (pack_folder / "assets").mkdir(exist_ok=True)
        (pack_folder / "assets/figure.svg").write_bytes(asset)
        pack = self.read(pack_folder / "pack.json")
        pack["assets"].append({"id": "synthetic-figure", "path": "assets/figure.svg", "mediaType": "image/svg+xml",
                               "byteLength": len(asset), "sha256": hashlib.sha256(asset).hexdigest(), "source": {"kind": "original-synthetic"}})
        self.write(pack_folder / "pack.json", pack)
        items = self.read(pack_folder / "items.json")
        items["items"][0]["content"].append({"type": "image", "assetId": "synthetic-figure", "alt": "Original synthetic square."})
        self.write(pack_folder / "items.json", items)
        source_report = self.read(self.root / "pdf-rw/conversion-report.json")
        source_report["packs"]["rw-single-choice"]["assetCount"] = 1
        self.write(self.root / "pdf-rw/conversion-report.json", source_report)
        original = {path: path.read_bytes() for row in self.rows for path in (self.root / row["directory"]).rglob("*") if path.is_file()}
        result = self.assemble()
        self.assertEqual(result["summary"]["fullSATCollections"], 1)
        self.assertEqual(result["summary"]["publishedQuestionCount"], 98)
        combined = result["combinations"][0]
        folder = self.root / combined["directory"]
        assessment = self.read(folder / "assessment.json")
        self.assertEqual(assessment["breakDurationSeconds"], 600)
        self.assertEqual([module["durationSeconds"] for module in assessment["modules"]], [1920, 1920, 2100, 2100])
        self.assertEqual([module["questionCount"] for module in assessment["modules"]], [27, 27, 22, 22])
        for path, data in original.items():
            self.assertEqual(path.read_bytes(), data)
            if path.name != "conversion-report.json":
                source_folder = next(self.root / row["directory"] for row in self.rows if path.is_relative_to(self.root / row["directory"]))
                self.assertEqual((folder / path.relative_to(source_folder)).read_bytes(), data)
        payload = read_sat_library(self.root, combined["collectionId"])
        self.assertEqual(payload["questionCount"], 98)
        self.assertTrue(payload["fullSAT"])
        self.assertEqual(len(payload["packs"]), 3)
        self.assertEqual({row["collectionId"] for row in self.read(self.root / "source-catalog.json")["collections"]},
                         {rw["collectionId"], math["collectionId"]})

    def test_partial_pair_preserves_numbering_without_full_assessment(self):
        self.add_source("pdf-rw", "reading-writing", "2025年3月第1套阅读语法（缺1题）", (27, 26))
        self.add_source("pdf-math", "math", "2025年3月第1套数学", (22, 22))
        result = self.assemble()
        combined = result["combinations"][0]
        self.assertFalse(combined["fullSAT"])
        self.assertEqual(combined["questionCount"], 97)
        self.assertFalse((self.root / combined["directory"] / "assessment.json").exists())
        self.assertTrue(all("durationSeconds" not in module for module in combined["modules"]))
        payload = read_sat_library(self.root, combined["collectionId"])
        self.assertIsNone(payload["assessment"])

    def test_ninety_eight_items_with_number_gap_are_still_partial(self):
        self.add_source("pdf-rw", "reading-writing", "2025年3月第1套阅读语法", (27, 27))
        self.add_source("pdf-math", "math", "2025年3月第1套数学", (22, 22))
        path = self.root / "pdf-rw/conversion-report.json"
        report = self.read(path)
        report["sourceOrder"][26]["number"] = 28
        self.write(path, report)
        result = self.assemble()
        self.assertEqual(result["combinations"][0]["questionCount"], 98)
        self.assertFalse(result["combinations"][0]["fullSAT"])

    def test_region_and_easy_variant_are_not_guessed(self):
        for title in ("2026年10月第3套数学(亚太)", "2026年10月第3套数学M2-Easy"):
            with self.subTest(title=title):
                rw = {"sourceFile": "阅读/2026年10月第3套阅读语法.pdf"}
                math = {"sourceFile": "数学/" + title + ".pdf"}
                self.assertNotEqual(ASSEMBLY.match_identity(rw)[0], ASSEMBLY.match_identity(math)[0])
        math = {"sourceFile": "数学/2025年10月亚太第2套数学（简单）.pdf"}
        rw = {"sourceFile": "阅读/2025年10月第2套阅读语法M2 -Easy (亚太).pdf"}
        self.assertEqual(ASSEMBLY.match_identity(rw)[0], ASSEMBLY.match_identity(math)[0])

    def test_ambiguous_and_nonofficial_identity_names_are_not_paired(self):
        for name in ("Bluebook Practice 8数学", "2023年6月第1&2&3套数学", "2025年9月第4套阅读语法去重版",
                     "2025年9月第4套阅读语法（北美B-F去重合并版）", "2024年3月第3套阅读语法Module1-版本1",
                     "2023年3月考题阅读语法"):
            with self.subTest(name=name):
                self.assertIsNone(ASSEMBLY.match_identity({"sourceFile": name + ".pdf"})[0])

    def test_multiple_candidates_leave_every_source_unmerged(self):
        self.add_source("pdf-rw-1", "reading-writing", "2026年10月第3套阅读语法")
        self.add_source("pdf-rw-2", "reading-writing", "2026年10月第3套阅读语法（缺1题）")
        self.add_source("pdf-math", "math", "2026年10月第3套数学")
        result = self.assemble()
        self.assertEqual(result["summary"]["combinedCollections"], 0)
        self.assertEqual(result["summary"]["publishedCollections"], 3)
        self.assertEqual({row["reason"] for row in result["unmatched"]}, {"multiple-candidates-for-same-subject-identity"})

    def test_question_only_duplicate_maps_through_canonical_to_combination(self):
        rw = self.add_source("pdf-rw", "reading-writing", "2026年10月第3套阅读语法")
        self.add_source("pdf-rw-pure", "reading-writing", "2026年10月第3套阅读语法（纯题目）", answers=False, counterpart=rw)
        self.add_source("pdf-math", "math", "2026年10月第3套数学")
        result = self.assemble()
        self.assertEqual(result["summary"]["questionOnlyDuplicates"], 1)
        self.assertEqual(result["summary"]["publishedCollections"], 1)
        mapping = next(row for row in result["sourceMappings"] if row["collectionId"] == "pdf-rw-pure")
        self.assertEqual(mapping["canonicalCollectionId"], "pdf-rw")
        self.assertEqual(mapping["publishedCollectionId"], result["combinations"][0]["collectionId"])
        self.assertTrue((self.root / "pdf-rw-pure").is_dir())
        self.assertFalse(result["sourcePacksMovedOrDeleted"])

    def test_unproven_question_only_pair_fails_before_public_catalog_changes(self):
        rw = self.add_source("pdf-rw", "reading-writing", "2026年10月第3套阅读语法")
        self.add_source("pdf-rw-pure", "reading-writing", "2026年10月第3套阅读语法（纯题目）", answers=False, counterpart=rw)
        path = self.evidence / "pdf-rw-pure.json"
        evidence = self.read(path)
        evidence["questions"][0].pop("pairedAnswerSource")
        self.write(path, evidence)
        self.save_inventory()
        original = (self.root / "catalog.json").read_bytes()
        with self.assertRaisesRegex(ASSEMBLY.AssemblyError, "pair-not-proven"):
            ASSEMBLY.assemble(self.root, self.evidence)
        self.assertEqual((self.root / "catalog.json").read_bytes(), original)

    def test_only_collections_whose_entire_answer_set_is_missing_are_unpublished(self):
        self.add_source("pdf-empty", "math", "2026年10月第4套数学", answers=False)
        rw = self.add_source("pdf-some", "reading-writing", "2026年10月第5套阅读语法", counts=(2,))
        report_path = self.root / rw["directory"] / "conversion-report.json"
        report = self.read(report_path)
        report["answerStatus"] = {"needs-review": 1, "missing": 1}
        self.write(report_path, report)
        solutions_path = self.root / rw["directory"] / "rw-single-choice/solutions.json"
        solutions = self.read(solutions_path)
        solutions["solutions"][0]["answer"] = {"status": "missing", "type": "single-choice"}
        self.write(solutions_path, solutions)
        result = self.assemble()
        self.assertEqual(result["summary"]["excludedNoAnswerCollections"], 1)
        self.assertEqual(result["summary"]["publishedCollections"], 1)
        self.assertEqual(self.read(self.root / "catalog.json")["collections"][0]["collectionId"], "pdf-some")

    def test_rerun_keeps_combined_identity_and_source_revisions(self):
        self.add_source("pdf-rw", "reading-writing", "2026年10月第3套阅读语法")
        self.add_source("pdf-math", "math", "2026年10月第3套数学")
        first = self.assemble()
        second = ASSEMBLY.assemble(self.root, self.evidence)
        self.assertEqual(first["combinations"], second["combinations"])
        self.assertEqual(first["sourceMappings"], second["sourceMappings"])

    def test_archived_source_folder_requires_rebuilding_in_complete_staging(self):
        self.add_source("pdf-rw", "reading-writing", "2026年10月第3套阅读语法")
        self.add_source("pdf-math", "math", "2026年10月第3套数学")
        self.assemble()
        before = (self.root / "catalog.json").read_bytes()
        shutil.rmtree(self.root / "pdf-rw")
        with self.assertRaisesRegex(ASSEMBLY.AssemblyError, "requires-complete-source-staging"):
            ASSEMBLY.assemble(self.root, self.evidence)
        self.assertEqual((self.root / "catalog.json").read_bytes(), before)

    def test_publish_export_contains_exact_catalog_and_keeps_source_staging_complete(self):
        rw = self.add_source("pdf-rw", "reading-writing", "2026年10月第3套阅读语法")
        self.add_source("pdf-rw-pure", "reading-writing", "2026年10月第3套阅读语法（纯题目）", answers=False, counterpart=rw)
        self.add_source("pdf-math", "math", "2026年10月第3套数学")
        self.add_source("pdf-unmatched", "math", "Bluebook Practice 8数学")
        self.save_inventory()
        self.write(self.root / "ignored-private-note.json", {"doNotPublish": True})
        (self.root / "合并说明.md").write_text("Synthetic assembly notes", encoding="utf-8")
        source_bytes = {path: path.read_bytes() for row in self.rows for path in (self.root / row["directory"]).rglob("*") if path.is_file()}
        target = self.base / "publish"
        summary = ASSEMBLY.assemble(self.root, self.evidence, publish_root=target)
        catalog = self.read(target / "catalog.json")
        self.assertEqual({path.parent.name for path in target.rglob("conversion-report.json")},
                         {row["directory"] for row in catalog["collections"]})
        self.assertEqual(len(catalog["collections"]), 2)
        self.assertFalse((target / "pdf-rw-pure").exists())
        self.assertFalse((target / "pdf-rw").exists())
        self.assertFalse((target / "ignored-private-note.json").exists())
        self.assertTrue((target / "合并说明.md").is_file())
        self.assertTrue(all((target / name).is_file() for name in ASSEMBLY.PUBLIC_METADATA))
        for path, data in source_bytes.items():
            self.assertEqual(path.read_bytes(), data)
        self.assertFalse(summary["sourcePacksMovedOrDeleted"])
        self.assertEqual(read_sat_library(target)["errors"], [])

    def test_publish_export_refuses_nonempty_or_overlapping_target_before_assembly_writes(self):
        self.add_source("pdf-rw", "reading-writing", "2026年10月第3套阅读语法")
        self.add_source("pdf-math", "math", "2026年10月第3套数学")
        self.save_inventory()
        before = (self.root / "catalog.json").read_bytes()
        target = self.base / "publish"
        target.mkdir()
        (target / "keep.txt").write_text("keep", encoding="utf-8")
        for destination, code in ((target, "new-or-empty"), (self.root / "inside", "overlaps-source"), (self.base, "overlaps-source")):
            with self.subTest(destination=destination):
                with self.assertRaisesRegex(ASSEMBLY.AssemblyError, code):
                    ASSEMBLY.assemble(self.root, self.evidence, publish_root=destination)
        self.assertEqual((target / "keep.txt").read_text(), "keep")
        self.assertEqual((self.root / "catalog.json").read_bytes(), before)
        self.assertFalse((self.root / "assembly-identities.json").exists())

    def test_export_review_rejects_corrupt_package_without_creating_destination(self):
        self.add_source("pdf-rw", "reading-writing", "2026年10月第3套阅读语法")
        self.add_source("pdf-math", "math", "2026年10月第3套数学")
        summary = self.assemble()
        folder = self.root / summary["combinations"][0]["directory"]
        (folder / "rw-single-choice/items.json").write_text("{}", encoding="utf-8")
        target = self.base / "publish"
        with self.assertRaisesRegex(ASSEMBLY.AssemblyError, "exported-public-library-review-failed"):
            ASSEMBLY.export_public(self.root, target)
        self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
