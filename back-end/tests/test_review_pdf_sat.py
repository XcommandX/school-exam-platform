"""Synthetic contract checks for the streamed PDF conversion review."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

import _paths


ROOT = _paths.ROOT
SPEC = importlib.util.spec_from_file_location("pdf_sat_review", ROOT / "back-end/tools/sat/review_pdf_sat.py")
REVIEW = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REVIEW)


class PdfSatReviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.output = self.base / "library"
        self.evidence = self.base / "evidence"
        self.sources = self.base / "sources"
        self.sources.mkdir()
        self.source = self.sources / "2023年3月阅读无答案.pdf"
        self.source.write_bytes(b"%PDF-1.4\nsynthetic source digest fixture\n%%EOF\n")
        self.identity = "pdf-synthetic-example"
        self.collection = self.output / self.identity
        self.pack = self.collection / "rw-single-choice"
        shutil.copytree(ROOT / "docs/drafts/sat-question-packs/rw-single-choice", self.pack)
        items = self.read(self.pack / "items.json")
        solutions = self.read(self.pack / "solutions.json")
        pack = self.read(self.pack / "pack.json")
        order, evidence = [], []
        for number, item in enumerate(items["items"], 1):
            source_id = "m1-q" + str(number)
            item["source"] = {"kind": "synthetic-pdf", "sourceSetId": self.identity, "sourceQuestionId": source_id}
            order.append({"sourceQuestionId": source_id, "section": "reading-writing", "moduleNumber": 1,
                          "number": number, "packId": pack["id"], "packRevision": pack["revision"],
                          "itemId": item["id"], "itemRevision": item["revision"]})
            evidence.append({"sourceQuestionId": source_id, "section": "reading-writing", "moduleNumber": 1,
                             "questionNumber": number, "regions": [{"pageNumber": number, "bbox": [20, 20, 400, 500]}]})
        for solution in solutions["solutions"]:
            solution["answer"]["status"] = "needs-review"
        self.write(self.pack / "items.json", items)
        self.write(self.pack / "solutions.json", solutions)
        self.entry = {"collectionId": self.identity, "sourceFile": self.source.name,
                      "sourceSha256": REVIEW.file_digest(self.source), "pageCount": 2}
        modules = [{"section": "reading-writing", "moduleNumber": 1, "questionCount": 2}]
        row = {**self.entry, "directory": self.identity, "category": "测试", "fullSAT": False,
               "questionCount": 2, "modules": modules, "title": "2023年3月原创测试卷", "status": "converted"}
        self.write(self.output / "catalog.json", {"collections": [row]})
        self.write(self.output / "pdf-source-manifest.json", {"files": [self.entry]})
        self.write(self.collection / "conversion-report.json", {"collectionId": self.identity,
                   "sourceSha256": self.entry["sourceSha256"], "questionCount": 2, "fullSAT": False,
                   "sourceOrder": order, "modules": modules,
                   "packs": {"rw-single-choice": {"questionCount": 2, "assetCount": len(pack["assets"])}}})
        self.write(self.evidence / (self.identity + ".json"), {**self.entry, "questions": evidence})
        self.anchor_scan = {"pageCount": 2, "moduleMarkers": [{"moduleNumber": 1, "pageNumber": 1}],
                            "anchors": [{"section": "reading-writing", "moduleNumber": 1, "number": number,
                                         "pageNumber": number, "bbox": [90, 20, 100, 30]} for number in (1, 2)]}
        self.scanner_patch = mock.patch.object(REVIEW, "scan_source_anchors", return_value=self.anchor_scan)
        self.scanner_mock = self.scanner_patch.start()
        self.addCleanup(self.scanner_patch.stop)

    def read(self, path):
        return json.loads(path.read_text(encoding="utf-8"))

    def write(self, path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    def change(self, path, change):
        data = self.read(path)
        change(data)
        self.write(path, data)

    def review(self):
        return REVIEW.review_library(self.output, self.evidence, source_root=self.sources)[0]

    def assert_collection_rejected(self, fragment):
        report = self.review()
        self.assertEqual(report["structuralStatus"], "fail")
        self.assertIn(fragment, " ".join(report["collections"][0]["errors"]))

    def test_valid_structures_still_report_content_and_answers_need_review(self):
        report = self.review()
        self.assertEqual(report["structuralStatus"], "pass")
        self.assertEqual(report["contentReviewStatus"], "needs-review")
        self.assertEqual(report["sourceChecks"], {"inventoryChecked": True, "sha256Checked": 1, "anchorChecked": 1})
        self.assertEqual(report["summary"]["questionCount"], 2)
        self.assertEqual(report["warnings"]["answer-needs-review"], 2)
        self.assertNotIn("prompt", json.dumps(report))

    def test_inventory_requires_each_pdf_exactly_once(self):
        self.change(self.output / "pdf-source-manifest.json", lambda doc: doc["files"].append(dict(doc["files"][0])))
        with self.assertRaisesRegex(REVIEW.ReviewError, "exactly-one-collection"):
            self.review()

    def test_source_inventory_does_not_silently_skip_unconverted_pdf(self):
        (self.sources / "extra.PDF").write_bytes(b"%PDF extra")
        with self.assertRaisesRegex(REVIEW.ReviewError, "inventory-mismatch"):
            self.review()

    def test_changed_source_sha_is_rejected(self):
        self.source.write_bytes(b"changed original source")
        with self.assertRaisesRegex(REVIEW.ReviewError, "sha256-mismatch"):
            self.review()

    def test_structural_validator_rejects_answer_field_inside_items(self):
        self.change(self.pack / "items.json", lambda doc: doc["items"][0].update({"answer": "B"}))
        self.assert_collection_rejected("draft-validator")

    def test_answer_marker_copied_into_student_text_is_rejected(self):
        self.change(self.pack / "items.json", lambda doc: doc["items"][0]["prompt"].append(
            {"type": "markdown", "text": "**【答案】B**"}))
        self.assert_collection_rejected("answer-or-explanation-leak")

    def test_verified_flag_is_not_inferred_from_source(self):
        self.change(self.pack / "solutions.json", lambda doc: doc["solutions"][0]["answer"].update({"status": "verified"}))
        self.assert_collection_rejected("marked-verified")

    def test_source_order_and_evidence_must_match(self):
        self.change(self.evidence / (self.identity + ".json"), lambda doc: doc["questions"].reverse())
        self.assert_collection_rejected("evidence-source-order-mismatch")

    def test_source_question_number_must_match_evidence(self):
        self.change(self.evidence / (self.identity + ".json"), lambda doc: doc["questions"][0].update({"questionNumber": 9}))
        self.assert_collection_rejected("evidence-position-mismatch")

    def test_missing_bbox_and_out_of_range_page_are_rejected(self):
        path = self.evidence / (self.identity + ".json")
        original = self.read(path)
        for region, expected in (({"pageNumber": 3, "bbox": [1, 2, 3, 4]}, "source-page-out-of-range"),
                                 ({"pageNumber": 1, "bbox": [1, 2, 1, 4]}, "invalid-source-bbox"),
                                 ({"pageNumber": 1}, "invalid-source-bbox")):
            with self.subTest(region=region):
                self.write(path, original)
                self.change(path, lambda doc: doc["questions"][0].update({"regions": [region]}))
                self.assert_collection_rejected(expected)

    def test_orphan_asset_and_corrupt_declared_asset_are_rejected(self):
        orphan = self.pack / "assets/orphan.png"
        orphan.write_bytes(b"unused image")
        self.assert_collection_rejected("orphan-or-missing")
        orphan.unlink()
        asset = self.read(self.pack / "pack.json")["assets"][0]
        (self.pack / asset["path"]).write_bytes(b"corrupt")
        self.assert_collection_rejected("draft-validator")

    def test_single_subject_pdf_cannot_claim_full_sat(self):
        self.change(self.output / "catalog.json", lambda doc: doc["collections"][0].update({"fullSAT": True}))
        self.assert_collection_rejected("must-not-claim-full-sat")

    def test_revision_binding_is_verified(self):
        self.change(self.collection / "conversion-report.json", lambda doc: doc["sourceOrder"][0].update({"packRevision": 2}))
        self.assert_collection_rejected("source-order-revision-mismatch")

    def test_catalog_visibility_and_report_pack_inventory_are_validated(self):
        self.change(self.output / "catalog.json", lambda doc: doc["collections"][0].update({"status": "pending"}))
        self.assert_collection_rejected("missing-visible-catalog-metadata")
        self.change(self.output / "catalog.json", lambda doc: doc["collections"][0].update({"status": "converted"}))
        self.change(self.collection / "conversion-report.json", lambda doc: doc.update({"packs": {}}))
        self.assert_collection_rejected("report-pack-list-mismatch")

    def test_safe_source_warning_subcodes_survive_and_duplicate_locations_are_counted_once(self):
        warning = "source_formula_ambiguous:baseline_variable_digit"
        self.change(self.evidence / (self.identity + ".json"), lambda doc: doc["questions"][0].update({"warnings": [warning]}))
        self.change(self.collection / "conversion-report.json", lambda doc: doc.update({"reviewNotes": [
            {"sourceQuestionId": "m1-q1", "issue": warning}, {"sourceQuestionId": "m1-q1", "issue": warning}]}))
        self.assertEqual(self.review()["warnings"][warning], 1)

    def test_unsafe_manifest_path_is_rejected_without_reading_external_file(self):
        self.change(self.output / "catalog.json", lambda doc: doc["collections"][0].update({"directory": "../sources"}))
        with self.assertRaisesRegex(REVIEW.ReviewError, "unsafe-relative-path"):
            self.review()

    def test_unlisted_collection_report_is_not_silently_ignored(self):
        self.write(self.output / "unlisted/conversion-report.json", {})
        with self.assertRaisesRegex(REVIEW.ReviewError, "orphan-or-missing-collection-report"):
            self.review()

    def test_explicit_source_catalog_can_review_originals_beside_assembled_collections(self):
        source_catalog = self.output / "source-catalog.json"
        self.write(source_catalog, self.read(self.output / "catalog.json"))
        self.write(self.output / "combined-example/conversion-report.json", {"collectionId": "combined-example"})
        self.write(self.output / "catalog.json", {"collections": []})
        report, samples = REVIEW.review_library(self.output, self.evidence, source_root=self.sources,
                                                source_catalog=source_catalog)
        self.assertEqual(report["structuralStatus"], "pass")
        self.assertEqual(report["additionalCollectionsOutsideSourceScope"], 1)
        self.assertEqual(report["summary"]["pdfCount"], 1)

    def test_independent_source_anchors_detect_dropped_source_questions(self):
        self.anchor_scan["anchors"].append({"section": "reading-writing", "moduleNumber": 1,
                                            "number": 3, "pageNumber": 2, "bbox": [90, 100, 100, 110]})
        self.assert_collection_rejected("source-anchor-count-mismatch")

    def test_independent_source_anchors_detect_relabelled_questions_and_wrong_crop(self):
        self.anchor_scan["anchors"][1]["number"] = 3
        self.assert_collection_rejected("source-anchor-sequence-mismatch")
        self.anchor_scan["anchors"][1]["number"] = 2
        self.anchor_scan["anchors"][1]["bbox"] = [90, 600, 100, 610]
        self.assert_collection_rejected("source-anchor-not-inside-evidence-region")

    def test_independent_scanner_retains_duplicate_bold_candidates_and_ignores_wrapped_year(self):
        self.scanner_patch.stop()
        def line(value, top, flags=16):
            return {"bbox": [90, top, 110, top + 10],
                    "spans": [{"text": value, "flags": flags, "font": "Example-Bold" if flags else "Example"}]}
        lines = [line("Module 1", 10), line("1.", 20), line("81.", 30, 0), line("1.", 40),
                 line("2.", 50), line("Module 2", 60), line("1.", 70)]
        class Document:
            needs_pass = False
            def __enter__(self):
                return self
            def __exit__(self, *_):
                return False
            def __len__(self):
                return 1
            def __getitem__(self, _):
                return SimpleNamespace(get_text=lambda *_args, **_kwargs: {"blocks": [{"lines": lines}]})
        fake_pdf = SimpleNamespace(open=lambda _path: Document(), TEXTFLAGS_DICT=0, TEXT_PRESERVE_IMAGES=4)
        row = self.read(self.output / "catalog.json")["collections"][0]
        with mock.patch.dict("sys.modules", {"pymupdf": fake_pdf}):
            scan = REVIEW.scan_source_anchors(self.source, row)
        self.assertEqual([(anchor["moduleNumber"], anchor["number"]) for anchor in scan["anchors"]],
                         [(1, 1), (1, 1), (1, 2), (2, 1)])

    def test_duplicate_json_key_is_not_silently_accepted(self):
        (self.output / "catalog.json").write_text('{"collections": [], "collections": []}', encoding="utf-8")
        with self.assertRaisesRegex(REVIEW.ReviewError, "duplicate-json-key"):
            self.review()

    def test_sample_is_deterministic_small_and_covers_available_strata(self):
        rows = []
        for index in range(16):
            rows.append({"collectionId": "sample-" + str(index), "directory": "sample-" + str(index),
                         "sourceFile": f"{2023 if index % 3 else 2026}年3月{'无答案' if index % 4 == 0 else '答案'}.pdf",
                         "fullSAT": False, "modules": [{"section": "math" if index % 2 else "reading-writing"}]})
        selected = REVIEW.select_samples(rows)
        self.assertEqual(selected, REVIEW.select_samples(list(reversed(rows))))
        self.assertEqual(len(selected["samples"]), 5)
        tags = {tag for sample in selected["samples"] for tag in sample["tags"]}
        self.assertTrue({"subject:math", "subject:reading-writing", "era:2023-2024", "era:2025-plus",
                         "answers:questions-only", "answers:source-may-include"} <= tags)
        with self.assertRaisesRegex(REVIEW.ReviewError, "sample-limit-is-five"):
            REVIEW.select_samples(rows, count=6)

    def test_cli_failure_is_nonzero_and_warnings_are_never_claimed_as_content_pass(self):
        args = ["--root", str(self.output), "--evidence-root", str(self.evidence),
                "--source-root", str(self.sources), "--report", str(self.base / "review.json"),
                "--sample-output", str(self.base / "sample.json")]
        with mock.patch("builtins.print"):
            self.assertEqual(REVIEW.main(args), 0)
            self.assertEqual(REVIEW.main(args + ["--strict-review"]), 2)
            self.change(self.pack / "items.json", lambda doc: doc["items"][0]["options"].pop())
            self.assertEqual(REVIEW.main(args), 1)
        self.assertEqual(self.read(self.base / "review.json")["structuralStatus"], "fail")


if __name__ == "__main__":
    unittest.main()
