"""Synthetic coverage, publication and asset-integrity tests; no real PDF data."""
from collections import Counter
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("pdf_assembly_review", ROOT / "back-end/tools/sat/review_pdf_assembly.py")
REVIEW = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REVIEW)


class PdfAssemblyReviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "public"
        self.sources = Path(self.temporary.name) / "pdf-sources"
        self.folder = self.root / "answered"
        self.pack_folder = self.folder / "rw-single-choice"
        shutil.copytree(ROOT / "docs/drafts/sat-question-packs/rw-single-choice", self.pack_folder)
        self.pack = self.read(self.pack_folder / "pack.json")
        items = self.read(self.pack_folder / "items.json")["items"]
        solutions = self.read(self.pack_folder / "solutions.json")["solutions"]
        refs = []
        for number, item in enumerate(items, 1):
            item["source"] = {"kind": "pdf-source", "sourceSetId": "answered", "sourceQuestionId": f"m1-q{number}"}
            refs.append({"sourceQuestionId": f"m1-q{number}", "section": "reading-writing", "moduleNumber": 1,
                         "number": number, "packId": self.pack["id"], "packRevision": self.pack["revision"],
                         "itemId": item["id"], "itemRevision": item["revision"]})
        for solution in solutions:
            solution["answer"]["status"] = "needs-review"
        self.write(self.pack_folder / "items.json", {"items": items})
        self.write(self.pack_folder / "solutions.json", {"visibility": "authoring-only", "solutions": solutions})
        self.count = len(items)
        modules = [{"section": "reading-writing", "moduleNumber": 1, "questionCount": self.count}]
        rows, entries = [], []
        for identity, name in [("answered", "原创阅读.pdf"), ("question-only", "原创阅读（纯题目）.pdf")]:
            source_file = "阅读文法/" + name
            content = ("synthetic-source-" + identity).encode()
            source_path = self.sources / source_file
            source_path.parent.mkdir(parents=True, exist_ok=True)
            source_path.write_bytes(content)
            sha = hashlib.sha256(content).hexdigest()
            row = {"collectionId": identity, "title": "Synthetic answered PDF" if identity == "answered" else "纯题目",
                   "category": "测试", "status": "converted", "directory": identity,
                   "sourceFile": source_file, "sourceSha256": sha, "questionCount": self.count,
                   "fullSAT": False, "modules": modules}
            rows.append(row)
            entries.append({"collectionId": identity, "sourceFile": source_file, "sourceSha256": sha,
                            "canonicalCollectionId": "answered", "publishedCollectionId": "answered",
                            "mappedPublishedCollectionId": "answered", "mergedInto": None if identity == "answered" else "answered",
                            "publicationStatus": "published" if identity == "answered" else "merged"})
        entries[1]["answerSource"] = {key: entries[0][key] for key in ("collectionId", "sourceFile", "sourceSha256")}
        report = {"collectionId": "answered", "title": rows[0]["title"], "sourceFile": rows[0]["sourceFile"],
                  "sourceSha256": rows[0]["sourceSha256"], "questionCount": self.count, "fullSAT": False,
                  "modules": modules, "sourceOrder": refs, "packs": {"rw-single-choice": {
                      "questionCount": self.count, "assetCount": len(self.pack["assets"])}},
                  "answerStatus": dict(Counter(solution["answer"]["status"] for solution in solutions))}
        self.write(self.folder / "conversion-report.json", report)
        self.write(self.root / "source-catalog.json", {"collections": rows})
        self.write(self.root / "catalog.json", {"collections": [rows[0]]})
        self.write(self.root / "pdf-source-manifest.json", {"files": entries})
        summary = {"schemaVersion": "sat-pdf-assembly-summary/1", "summary": {
            "sourcePDFs": 2, "canonicalCollectionsWithAnswers": 1, "questionOnlyDuplicates": 1,
            "verifiedDuplicateQuestions": self.count, "combinedCollections": 0, "fullSATCollections": 0,
            "partialCombinedCollections": 0, "unmatchedCanonicalCollections": 1, "publishedCollections": 1,
            "publishedQuestionCount": self.count, "excludedNoAnswerCollections": 0},
            "combinations": [], "unmatched": [{"collectionId": "answered", "reason": "single-subject-source"}],
            "duplicates": [{"collectionId": "question-only", "canonicalCollectionId": "answered", "reason": "synthetic-exact-pair"}],
            "excluded": [], "sourceMappings": [{field: entry.get(field) for field in REVIEW.MAPPING_FIELDS} for entry in entries],
            "unpublishedSourceCollections": ["question-only"]}
        self.write(self.root / "assembly-summary.json", summary)

    def read(self, path):
        return json.loads(path.read_text(encoding="utf-8"))

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def test_small_inventory_and_optional_sha_pass_without_fixed_counts(self):
        report = REVIEW.review_assembly(self.root, source_root=self.sources)
        self.assertTrue(report["ok"], report)
        self.assertEqual(report["summary"]["sourcePDFs"], 2)
        self.assertEqual(report["summary"]["reviewedQuestionCount"], self.count)
        self.assertEqual(report["sourceHashCheck"], "run")

    def test_pure_pdf_cannot_point_to_missing_public_target(self):
        manifest = self.read(self.root / "pdf-source-manifest.json")
        pure = manifest["files"][1]
        for field in ("publishedCollectionId", "mappedPublishedCollectionId", "mergedInto"):
            pure[field] = "missing"
        self.write(self.root / "pdf-source-manifest.json", manifest)
        summary = self.read(self.root / "assembly-summary.json")
        summary["sourceMappings"] = [{field: entry.get(field) for field in REVIEW.MAPPING_FIELDS} for entry in manifest["files"]]
        self.write(self.root / "assembly-summary.json", summary)
        self.assertIn("manifest-target-missing", REVIEW.review_assembly(self.root)["errors"])

    def test_extra_physical_collection_is_rejected(self):
        self.write(self.root / "unused-source/conversion-report.json", {"collectionId": "unused-source"})
        self.assertIn("physical-public-directory-mismatch", REVIEW.review_assembly(self.root)["errors"])

    def test_unreferenced_asset_file_is_rejected(self):
        (self.pack_folder / "assets/orphan.svg").write_text("<svg xmlns=\"http://www.w3.org/2000/svg\"/>")
        report = REVIEW.review_assembly(self.root)
        self.assertFalse(report["ok"])
        self.assertIn("orphan-or-missing-asset-file", report["collections"][0]["errors"])

    def test_source_order_must_preserve_original_question_order(self):
        path = self.folder / "conversion-report.json"
        value = self.read(path)
        value["sourceOrder"].reverse()
        self.write(path, value)
        report = REVIEW.review_assembly(self.root)
        self.assertIn("source-order-not-by-section-module-question", report["collections"][0]["errors"])

    def test_collection_with_no_answers_cannot_be_published(self):
        path = self.pack_folder / "solutions.json"
        value = self.read(path)
        for solution in value["solutions"]:
            solution["answer"] = {"status": "missing", "type": "single-choice"}
        self.write(path, value)
        path = self.folder / "conversion-report.json"
        value = self.read(path)
        value["answerStatus"] = {"missing": self.count}
        self.write(path, value)
        report = REVIEW.review_assembly(self.root)
        self.assertIn("published-collection-has-no-answers", report["collections"][0]["errors"])

    def test_changed_original_pdf_hash_is_rejected(self):
        next(self.sources.rglob("*.pdf")).write_bytes(b"changed synthetic bytes")
        self.assertIn("source-pdf-sha256-mismatch", REVIEW.review_assembly(self.root, source_root=self.sources)["errors"])


if __name__ == "__main__":
    unittest.main()
