"""Complete SAT ZIP checks use only 98 generated anonymous fixture questions."""
from copy import deepcopy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

from test_convert_gengdu_sat import CONVERTER, synthetic_document
from scripts.serve_platform import read_sat_pack_collection


SPEC = importlib.util.spec_from_file_location("package_sat_bundle", Path(__file__).resolve().parents[1] / "scripts/package_sat_bundle.py")
BUNDLE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUNDLE)


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.private = self.root / "private-data"
        self.collection = self.private / "sat-packs/synthetic-collection"
        self.output = self.private / "exports/synthetic-full.zip"
        document = synthetic_document()
        document["questions"][0]["passage_html"] = '<img src="https://example.org/original.png" alt="Original generated white square">'
        CONVERTER.convert_document(document, self.collection, collection_id="synthetic-collection")
        self.assessment = json.loads((self.collection / "assessment.json").read_text())

    def tearDown(self):
        self.temporary.cleanup()

    def mutate(self, function):
        document = deepcopy(self.assessment)
        function(document)
        (self.collection / "assessment.json").write_text(json.dumps(document), encoding="utf-8")

    def test_bundle_unpacks_into_existing_server_with_correct_modules_and_all_assets(self):
        # Undeclared files and private browser backups must never reach the ZIP.
        (self.collection / "private-student-notes.json").write_text('"PRIVATE-SENTINEL"')
        backup = self.private / "backups/browser.json"
        backup.parent.mkdir()
        backup.write_text('"PRIVATE-SENTINEL"')
        manifest = BUNDLE.build_bundle(self.collection, self.output)
        self.assertEqual(manifest["questionCount"], 98)
        self.assertEqual([module["questionCount"] for module in manifest["modules"]], [27, 27, 22, 22])
        self.assertEqual([section["questionCount"] for section in manifest["sections"]], [54, 44])
        self.assertEqual([module["durationSeconds"] for module in manifest["modules"]], [1920, 1920, 2100, 2100])
        self.assertEqual(BUNDLE.verify_bundle(self.output), manifest)
        target = self.root / "receiving/private-data/sat-packs"
        with zipfile.ZipFile(self.output) as archive:
            self.assertNotIn("PRIVATE-SENTINEL", "".join(entry["path"] for entry in manifest["files"]))
            self.assertFalse(any("backups" in name or "private-student" in name or ".DS_Store" in name for name in archive.namelist()))
            archive.extractall(target)
        runtime = read_sat_pack_collection(target.parent)
        self.assertEqual(runtime["collectionId"], "synthetic-collection")
        self.assertEqual(runtime["assessment"]["questionCount"], 98)
        self.assertEqual(runtime["assessment"]["modules"], self.assessment["modules"])
        self.assertEqual(sum(pack["questionCount"] for pack in runtime["packs"]), 98)
        self.assertEqual(sum("dataBase64" in entry for pack in runtime["packs"] for entry in pack["files"]), 1)
        # Simulate app.js's exact reference matching and ordered module loops.
        inventory = []
        for package in runtime["packs"]:
            pack = json.loads(next(entry["text"] for entry in package["files"] if entry["path"].endswith("/pack.json")))
            items = json.loads(next(entry["text"] for entry in package["files"] if entry["path"].endswith("/items.json")))["items"]
            inventory.extend((pack["id"], pack["revision"], item["id"], item["revision"]) for item in items)
        ordered = [tuple(ref[key] for key in ("packId", "packRevision", "itemId", "itemRevision")) for module in runtime["assessment"]["modules"] for ref in module["items"]]
        self.assertEqual(len(ordered), 98)
        self.assertEqual(set(ordered), set(inventory))
        for module in runtime["assessment"]["modules"]:
            self.assertEqual(len(module["items"]), module["questionCount"])
        self.assertEqual(self.output.with_suffix(".zip.sha256").read_text().split()[0], hashlib.sha256(self.output.read_bytes()).hexdigest())

    def test_optional_count_upgrade_changes_only_assessment_and_is_reproducible(self):
        legacy = deepcopy(self.assessment)
        legacy.pop("questionCount")
        legacy.pop("sections")
        for module in legacy["modules"]:
            module.pop("questionCount")
        (self.collection / "assessment.json").write_text(json.dumps(legacy), encoding="utf-8")
        before = {path.relative_to(self.collection).as_posix(): path.read_bytes() for path in self.collection.rglob("*") if path.is_file() and path.name != "assessment.json"}
        BUNDLE.build_bundle(self.collection, self.output, update_assessment=True)
        after = {path.relative_to(self.collection).as_posix(): path.read_bytes() for path in self.collection.rglob("*") if path.is_file() and path.name != "assessment.json"}
        self.assertEqual(before, after)
        upgraded = json.loads((self.collection / "assessment.json").read_text())
        self.assertEqual(upgraded["questionCount"], 98)
        self.assertEqual([module["questionCount"] for module in upgraded["modules"]], [27, 27, 22, 22])
        first = self.output.read_bytes()
        BUNDLE.build_bundle(self.collection, self.output, replace=True)
        self.assertEqual(first, self.output.read_bytes())

    def test_wrong_counts_durations_and_section_summaries_fail(self):
        for mutation in (
            lambda doc: doc.update(questionCount=97),
            lambda doc: doc["sections"][0].update(questionCount=55),
            lambda doc: doc["modules"][0].update(questionCount=26),
            lambda doc: doc["modules"][2].update(durationSeconds=1920),
            lambda doc: doc.update(breakDurationSeconds=300),
        ):
            with self.subTest(mutation=mutation):
                self.mutate(mutation)
                with self.assertRaises(BUNDLE.BundleError):
                    BUNDLE.build_bundle(self.collection, self.output)
                self.assertFalse(self.output.exists())

    def test_wrong_revision_duplicate_missing_and_cross_section_references_fail(self):
        def cross_section(document):
            rw, math = document["modules"][0]["items"], document["modules"][2]["items"]
            rw[0], math[0] = math[0], rw[0]
        for mutation in (
            lambda doc: doc["modules"][0]["items"][0].update(itemRevision=2),
            lambda doc: doc["modules"][0]["items"].__setitem__(1, deepcopy(doc["modules"][0]["items"][0])),
            lambda doc: doc["modules"][0]["items"].pop(),
            cross_section,
        ):
            with self.subTest(mutation=mutation):
                self.mutate(mutation)
                with self.assertRaises(BUNDLE.BundleError):
                    BUNDLE.build_bundle(self.collection, self.output)
                self.assertFalse(self.output.exists())

    def test_missing_or_changed_assets_fail_before_zip_creation(self):
        image = next((self.collection / "rw-single-choice/assets").glob("*.png"))
        original = image.read_bytes()
        image.write_bytes(original + b"changed")
        with self.assertRaises(ValueError):
            BUNDLE.build_bundle(self.collection, self.output)
        self.assertFalse(self.output.exists())
        image.unlink()
        with self.assertRaises(ValueError):
            BUNDLE.build_bundle(self.collection, self.output)
        self.assertFalse(self.output.exists())

    def test_archive_corruption_and_undeclared_files_are_detected(self):
        BUNDLE.build_bundle(self.collection, self.output)
        with zipfile.ZipFile(self.output, "a") as archive:
            archive.writestr("unlisted.txt", "unexpected")
        with self.assertRaisesRegex(BUNDLE.BundleError, "Undeclared"):
            BUNDLE.verify_bundle(self.output)
        with self.assertRaisesRegex(BUNDLE.BundleError, "exists"):
            BUNDLE.build_bundle(self.collection, self.output)

    def test_runtime_unsafe_svg_is_rejected_even_with_a_matching_declared_digest(self):
        data = b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
        (self.collection / "rw-single-choice/assets/unsafe.svg").write_bytes(data)
        path = self.collection / "rw-single-choice/pack.json"
        pack = json.loads(path.read_text())
        pack["assets"].append({"id": "unsafe-svg", "path": "assets/unsafe.svg", "mediaType": "image/svg+xml",
                               "sha256": hashlib.sha256(data).hexdigest(), "byteLength": len(data), "source": {"kind": "original-synthetic"}})
        path.write_text(json.dumps(pack))
        with self.assertRaisesRegex(ValueError, "SVG"):
            BUNDLE.build_bundle(self.collection, self.output)
        self.assertFalse(self.output.exists())


if __name__ == "__main__":
    unittest.main()
