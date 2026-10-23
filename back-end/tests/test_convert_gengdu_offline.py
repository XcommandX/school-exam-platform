"""Batch publishing uses only original synthetic questions and temporary folders."""
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import zipfile
import _paths


SPEC = importlib.util.spec_from_file_location("gengdu_offline_batch", _paths.ROOT / "back-end/tools/sat/convert_gengdu_offline.py")
BATCH = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BATCH)


def question(qid, section="ReadingAndWriting", response="choice"):
    return {"question_id": qid, "number": 7, "module_number": 3, "part_type": section,
            "question_type": response, "prompt_html": "<p>Original synthetic question?</p>",
            "choices": [{"label": label, "html": "Original " + label} for label in "ABCD"] if response == "choice" else [],
            "correct_answer": "A" if response == "choice" else "2/3", "selected_answer": "DO-NOT-EXPORT"}


class BatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.source = self.root / "archive/offline"
        for category in BATCH.CATEGORIES:
            (self.source / category).mkdir(parents=True)
        self.output = self.root / "converted"
        for category, q in [("测试", question("101")), ("数学", question("102", "Math", "response")), ("英语", question("103"))]:
            (self.source / category / "original.json").write_text(json.dumps({"title": "Original synthetic collection", "question_count": 1, "expected_question_count": 1, "questions": [q]}), encoding="utf-8")

    def tearDown(self):
        self.temp.cleanup()

    def run_batch(self, **kwargs):
        return BATCH.convert_batch(self.source, self.output, backup_root=self.root / "backups", **kwargs)

    def test_three_categories_are_independent_offline_packages_with_checked_zips(self):
        original = {p:p.read_bytes() for p in self.source.rglob("*.json")}
        catalog = self.run_batch()
        self.assertEqual(catalog["status"], "complete")
        self.assertEqual(catalog["validatedPacks"], 3)
        self.assertEqual(catalog["categoryDirectories"], BATCH.CATEGORY_DIRECTORIES)
        self.assertEqual(len({row["collectionId"] for row in catalog["collections"]}), 3)
        for category in BATCH.CATEGORIES:
            self.assertEqual(catalog["categories"][category]["convertedQuestions"], 1)
            self.assertEqual(catalog["categories"][category]["fullSAT"], 0)
            with zipfile.ZipFile(self.output / (BATCH.CATEGORY_DIRECTORIES[category] + ".zip")) as z:
                self.assertIsNone(z.testzip())
                manifest = json.loads(z.read("bundle-manifest.json"))
                for entry in manifest["files"]:
                    self.assertEqual(BATCH.digest(z.read(entry["path"])), entry["sha256"])
                self.assertFalse(any("active.json" in name for name in z.namelist()))
            self.assertFalse(any(p.name == "assessment.json" for p in (self.output/BATCH.CATEGORY_DIRECTORIES[category]).rglob("*")))
        self.assertTrue(all(p.read_bytes() == raw for p,raw in original.items()))
        self.assertNotIn("DO-NOT-EXPORT", "".join(p.read_text() for p in self.output.rglob("*.json")))

    def test_index_sync_repairs_manual_category_renames_without_changing_question_files(self):
        self.run_batch()
        catalog = json.loads((self.output / "catalog.json").read_text())
        identities = json.loads((self.output / "source-identities.json").read_text())
        for row in catalog["collections"]:
            category = row["category"]
            old = Path(category, *Path(row["directory"]).parts[1:]).as_posix()
            row["directory"] = old
            row["reportFile"] = old + "/conversion-report.json"
            identities["entries"][row["sourceFile"]]["directory"] = old
        for category, archive in catalog["archives"].items():
            new_name, old_name = archive["path"], category + ".zip"
            (self.output / new_name).rename(self.output / old_name)
            (self.output / (new_name + ".sha256")).rename(self.output / (old_name + ".sha256"))
            archive["path"] = old_name
        catalog.pop("categoryDirectories")
        (self.output / "catalog.json").write_bytes(BATCH.json_bytes(catalog))
        (self.output / "source-identities.json").write_bytes(BATCH.json_bytes(identities))
        untouched = {path.relative_to(self.output): path.read_bytes() for path in self.output.rglob("*")
                     if path.is_file() and path.parts[-1] in {"pack.json", "items.json", "solutions.json", "conversion-report.json"}}
        (self.output / "英语真题/.DS_Store").write_bytes(b"local metadata")
        fresh = BATCH.synchronize_catalog(self.output, backup_root=self.root / "index-backups")
        self.assertTrue(all((self.output / name).read_bytes() == data for name, data in untouched.items()))
        for row in fresh["collections"]:
            self.assertTrue((self.output / row["reportFile"]).is_file())
            with zipfile.ZipFile(self.output / fresh["archives"][row["category"]]["path"]) as bundle:
                self.assertIn(row["reportFile"], bundle.namelist())
                self.assertFalse(any(name.endswith(".DS_Store") for name in bundle.namelist()))
        self.assertEqual(len(list((self.root / "index-backups").iterdir())), 1)
        self.assertFalse(any((self.output / (category + ".zip")).exists() for category in BATCH.CATEGORIES))
        self.assertEqual(fresh["revisionChanges"], [])
        self.assertEqual(self.run_batch(replace=True)["revisionChanges"], [])

    def test_index_sync_can_move_old_directories_and_rejects_conflicting_folders(self):
        self.run_batch()
        for category, directory in BATCH.CATEGORY_DIRECTORIES.items():
            (self.output / directory).rename(self.output / category)
        (self.output / "数学真题").mkdir()
        with self.assertRaisesRegex(ValueError, "Both old and new"):
            BATCH.synchronize_catalog(self.output, backup_root=self.root / "index-backups")
        (self.output / "数学真题").rmdir()
        catalog = BATCH.synchronize_catalog(self.output, backup_root=self.root / "index-backups")
        self.assertTrue(all((self.output / row["reportFile"]).is_file() for row in catalog["collections"]))
        self.assertFalse(any((self.output / category).exists() for category in BATCH.CATEGORIES))

    def test_parent_segments_and_backup_paths_cannot_enter_original_archive(self):
        hidden = self.root / "unused" / ".." / "archive" / "generated"
        with self.assertRaisesRegex(ValueError, "separate from the original"):
            BATCH.convert_batch(self.source, hidden, backup_root=self.root / "backups")
        with self.assertRaisesRegex(ValueError, "Keep backups separate"):
            BATCH.convert_batch(self.source, self.output, backup_root=self.source / "backups")
        with self.assertRaisesRegex(ValueError, "Keep backups separate"):
            BATCH.convert_batch(self.source, self.output, backup_root=self.output / "backups")
        self.assertFalse((self.source.parent / "generated").exists())

    def test_repeat_conversion_keeps_identity_and_preserves_old_output(self):
        self.run_batch()
        identities = (self.output/"source-identities.json").read_bytes()
        package_bytes = {path.relative_to(self.output): path.read_bytes() for path in self.output.rglob("*.json")
                         if path.name in {"pack.json", "items.json", "solutions.json"}}
        with self.assertRaisesRegex(ValueError, "already exists"):
            self.run_batch()
        catalog = self.run_batch(replace=True)
        self.assertEqual(catalog["revisionChanges"], [])
        self.assertTrue(all((self.output / name).read_bytes() == data for name, data in package_bytes.items()))
        self.assertEqual((self.output/"source-identities.json").read_bytes(), identities)
        self.assertEqual(len(list((self.root/"backups").iterdir())), 1)
        file = self.source / "英语/original.json"
        file.write_text(file.read_text()+" ")
        with self.assertRaisesRegex(ValueError, "Source changed"):
            self.run_batch(replace=True)
        self.assertEqual((self.output/"source-identities.json").read_bytes(), identities)

    def test_failed_source_is_explicit_and_no_partial_question_pack_is_published(self):
        file = self.source / "英语/original.json"
        d=json.loads(file.read_text());d["questions"][0]["prompt_html"]='<img src="https://example.invalid/missing.png">'
        file.write_text(json.dumps(d))
        catalog=self.run_batch()
        self.assertEqual(catalog["status"],"partial")
        failed=next(row for row in catalog["collections"] if row["category"]=="英语")
        self.assertEqual(failed["status"],"failed")
        self.assertEqual(failed["questionCount"],0)
        self.assertFalse((self.output/failed["directory"]).exists())
        self.assertEqual(catalog["validatedPacks"],2)

    def test_changed_exported_content_advances_only_affected_item_and_pack_with_consistent_references(self):
        questions = []
        for section, length in (("ReadingAndWriting", 27), ("Math", 22)):
            for module in (1, 2):
                for number in range(1, length + 1):
                    item = question(str(10000 + len(questions)), section, "response" if section == "Math" and number == 1 else "choice")
                    item.update({"number": number, "module_number": module})
                    questions.append(item)
        source = self.source / "测试/original.json"
        source.write_text(json.dumps({"title": "Original complete synthetic assessment", "question_count": 98,
                                      "expected_question_count": 98, "questions": questions}))
        self.run_batch()
        initial_catalog = json.loads((self.output / "catalog.json").read_text())
        row = next(row for row in initial_catalog["collections"] if row["category"] == "测试")
        collection = self.output / row["directory"]
        items_path = collection / "rw-single-choice/items.json"
        old = json.loads(items_path.read_text())
        target_id = old["items"][0]["id"]
        old["items"][0]["prompt"][0]["text"] = "Previous exporter content requiring an improved conversion."
        items_path.write_bytes(BATCH.json_bytes(old))
        old_bytes = items_path.read_bytes()
        catalog = self.run_batch(replace=True)
        changes = catalog["revisionChanges"]
        self.assertEqual([change["type"] for change in changes], ["item", "pack"])
        self.assertEqual(changes[0]["itemId"], target_id)
        self.assertEqual([(change["previousRevision"], change["revision"]) for change in changes], [(1, 2), (1, 2)])
        fresh_items = json.loads(items_path.read_text())["items"]
        self.assertEqual([item["revision"] for item in fresh_items], [2] + [1] * 53)
        pack = json.loads((collection / "rw-single-choice/pack.json").read_text())
        self.assertEqual(pack["revision"], 2)
        for name in ("math-single-choice", "math-spr"):
            self.assertEqual(json.loads((collection / name / "pack.json").read_text())["revision"], 1)
        solutions = json.loads((collection / "rw-single-choice/solutions.json").read_text())["solutions"]
        self.assertEqual([solution["itemRevision"] for solution in solutions], [2] + [1] * 53)
        assessment = json.loads((collection / "assessment.json").read_text())
        report = json.loads((collection / "conversion-report.json").read_text())
        for reference in [ref for module in assessment["modules"] for ref in module["items"]] + report["sourceOrder"]:
            self.assertEqual(reference["packRevision"], 2 if reference["packId"] == pack["id"] else 1)
            self.assertEqual(reference["itemRevision"], 2 if reference["itemId"] == target_id else 1)
        self.assertEqual(report["revisionChanges"], changes)
        backup = next((self.root / "backups").iterdir())
        self.assertEqual((backup / items_path.relative_to(self.output)).read_bytes(), old_bytes)
        self.assertNotIn("Previous exporter content", items_path.read_text())
        self.assertEqual(self.run_batch(replace=True)["revisionChanges"], [])
        self.assertEqual(json.loads((collection / "rw-single-choice/pack.json").read_text())["revision"], 2)
        self.assertEqual(json.loads(items_path.read_text())["items"][0]["revision"], 2)

    def test_solution_only_change_advances_item_revision_and_original_guard_still_rejects_silent_change(self):
        self.run_batch()
        previous = self.root / "previous"
        fresh = self.root / "fresh"
        shutil.copytree(self.output, previous)
        shutil.copytree(self.output, fresh)
        solution_path = next(fresh.rglob("solutions.json"))
        solutions = json.loads(solution_path.read_text())
        answer = solutions["solutions"][0]["answer"]
        if answer["type"] == "single-choice":
            answer["optionId"] = "choice-b"
        else:
            answer["acceptedRationals"] = ["3/4"]
        solution_path.write_bytes(BATCH.json_bytes(solutions))
        with self.assertRaisesRegex(ValueError, "existing package revision"):
            BATCH.check_unchanged_revisions(previous, fresh)
        changes = BATCH.reconcile_revisions(previous, fresh)
        self.assertEqual([change["type"] for change in changes], ["item", "pack"])
        self.assertEqual(json.loads(solution_path.read_text())["solutions"][0]["itemRevision"], 2)
        BATCH.check_unchanged_revisions(previous, fresh)

    def test_unchanged_revision_guard_follows_package_identity_across_folder_renames(self):
        self.run_batch()
        previous = self.root / "previous-renamed"
        shutil.copytree(self.output, previous)
        for category, directory in BATCH.CATEGORY_DIRECTORIES.items():
            (previous / directory).rename(previous / category)
        BATCH.check_unchanged_revisions(previous, self.output)
        path = next(self.output.rglob("items.json"))
        path.write_text(path.read_text() + " ")
        with self.assertRaisesRegex(ValueError, "existing package revision"):
            BATCH.check_unchanged_revisions(previous, self.output)

    def test_referenced_resource_digest_change_advances_item_even_when_its_body_is_unchanged(self):
        source = self.source / "数学/original.json"
        document = json.loads(source.read_text())
        document["questions"][0]["passage_html"] = '<table><tr><td>x</td><td>y</td></tr><tr><td>1</td><td>2</td></tr></table>'
        source.write_bytes(BATCH.json_bytes(document))
        self.run_batch()
        previous = self.root / "previous-assets"
        fresh = self.root / "fresh-assets"
        shutil.copytree(self.output, previous)
        shutil.copytree(self.output, fresh)
        pack_path = next(path for path in (fresh / BATCH.CATEGORY_DIRECTORIES["数学"]).rglob("pack.json"))
        pack = json.loads(pack_path.read_text())
        asset = pack["assets"][0]
        asset_path = pack_path.parent / asset["path"]
        data = asset_path.read_bytes().replace(b'>x</text>', b'>z</text>')
        self.assertNotEqual(data, asset_path.read_bytes())
        asset_path.write_bytes(data)
        asset["sha256"], asset["byteLength"] = BATCH.digest(data), len(data)
        pack_path.write_bytes(BATCH.json_bytes(pack))
        items_path = pack_path.parent / pack["files"]["items"]
        before = json.loads(items_path.read_text())["items"][0]
        changes = BATCH.reconcile_revisions(previous, fresh)
        after = json.loads(items_path.read_text())["items"][0]
        self.assertEqual({key: value for key, value in before.items() if key != "revision"},
                         {key: value for key, value in after.items() if key != "revision"})
        self.assertEqual(after["revision"], 2)
        self.assertEqual([change["type"] for change in changes], ["item", "pack"])


if __name__ == "__main__":
    unittest.main()
