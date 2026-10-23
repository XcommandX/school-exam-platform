"""Targeted structure and numeric-boundary checks for the SAT draft examples."""

import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
import _paths


ROOT = _paths.ROOT
DRAFTS = ROOT / "docs" / "drafts" / "sat-question-packs"
SPEC = importlib.util.spec_from_file_location("sat_pack_draft_validator", DRAFTS / "validate_examples.py")
VALIDATOR = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VALIDATOR)


class SatPackDraftTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.pack = Path(self.temporary.name) / "pack"

    def copy_pack(self, name="rw-single-choice"):
        if self.pack.exists():
            shutil.rmtree(self.pack)
        shutil.copytree(DRAFTS / name, self.pack)
        return self.pack

    def document(self, name):
        return json.loads((self.pack / name).read_text(encoding="utf-8"))

    def change(self, name, mutation):
        value = self.document(name)
        mutation(value)
        (self.pack / name).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")

    def reject(self):
        with self.assertRaises(VALIDATOR.DraftValidationError):
            VALIDATOR.validate_pack(self.pack)

    def test_three_examples_have_five_distinct_items_and_two_assets(self):
        summaries = VALIDATOR.validate_packs([DRAFTS / name for name in
                                             ("rw-single-choice", "math-single-choice", "math-spr")])
        self.assertEqual(sum(s["itemCount"] for s in summaries), 5)
        self.assertEqual(sum(s["assetCount"] for s in summaries), 2)
        ids = [item_id for s in summaries for item_id in s["itemIds"]]
        self.assertEqual(len(ids), len(set(ids)))

    def test_same_item_revision_can_be_reused_with_identical_content(self):
        self.copy_pack()
        self.assertEqual(len(VALIDATOR.validate_packs([DRAFTS / "rw-single-choice", self.pack])), 2)

    def test_same_item_revision_cannot_have_conflicting_content_in_another_pack(self):
        self.copy_pack()
        self.change("items.json", lambda p: p["items"][0]["prompt"][0].update({"text": "Changed prompt"}))
        with self.assertRaises(VALIDATOR.DraftValidationError):
            VALIDATOR.validate_packs([DRAFTS / "rw-single-choice", self.pack])

    def test_rejects_unsupported_exam_section_and_response_combination(self):
        for field, value in (("exam", "toefl"), ("section", "listening"),
                             ("responseType", "student-produced-response"),
                             ("schemaVersion", "2.0-draft")):
            with self.subTest(field=field):
                self.copy_pack()
                self.change("pack.json", lambda p: p.update({field: value}))
                self.reject()

    def test_rejects_personal_fields_and_old_parts_structure(self):
        mutations = (
            ("pack.json", lambda p: p.update({"studentName": "Example"})),
            ("items.json", lambda p: p["items"][0].update({"selectedAnswer": "choice-1"})),
            ("items.json", lambda p: p["items"][0].update({"parts": []})),
            ("solutions.json", lambda p: p["solutions"][0]["provenance"].update({"attemptId": "personal"})),
        )
        for name, mutation in mutations:
            with self.subTest(name=name, mutation=mutation):
                self.copy_pack()
                self.change(name, mutation)
                self.reject()

    def test_allows_only_whitelisted_string_source_details(self):
        self.copy_pack()
        source = {"url": "https://example.invalid/source", "sourceSetId": "example-set", "sourceQuestionId": "q1"}
        self.change("items.json", lambda p: p["items"][0]["source"].update(source))
        self.change("pack.json", lambda p: p["assets"][0]["source"].update(source))
        VALIDATOR.validate_pack(self.pack)
        self.change("items.json", lambda p: p["items"][0]["source"].update({"sourceQuestionId": 1}))
        self.reject()

    def test_requires_stable_item_id_and_positive_integer_revision(self):
        for field, value in (("id", "q1"), ("revision", True), ("revision", 0)):
            with self.subTest(field=field, value=value):
                self.copy_pack()
                self.change("items.json", lambda p: p["items"][0].update({field: value}))
                self.reject()

    def test_rejects_duplicate_item_ids(self):
        self.copy_pack()
        self.change("items.json", lambda p: p["items"][1].update({"id": p["items"][0]["id"]}))
        self.reject()

    def test_requires_four_unique_options(self):
        for duplicate in (False, True):
            with self.subTest(duplicate=duplicate):
                self.copy_pack()
                def mutate(p):
                    options = p["items"][0]["options"]
                    if duplicate:
                        options[1]["id"] = options[0]["id"]
                    else:
                        options.pop()
                self.change("items.json", mutate)
                self.reject()

    def test_solution_links_and_response_type_must_match(self):
        mutations = (
            lambda p: p["solutions"][0].update({"itemId": "sat:item:absent"}),
            lambda p: p["solutions"][0].update({"itemRevision": 2}),
            lambda p: p["solutions"][0]["answer"].update({"optionId": "choice-5"}),
            lambda p: p["solutions"][0]["answer"].update({"type": "student-produced-response"}),
            lambda p: p["solutions"].pop(),
            lambda p: p["solutions"].append(p["solutions"][0]),
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.copy_pack()
                self.change("solutions.json", mutation)
                self.reject()

    def test_spr_pack_cannot_contain_choice_options(self):
        self.copy_pack("math-spr")
        self.change("items.json", lambda p: p["items"][0].update({"options": []}))
        self.reject()

    def test_missing_and_needs_review_statuses_are_honest(self):
        self.copy_pack()
        def missing(p):
            p["solutions"][0]["answer"] = {"status": "missing", "type": "single-choice"}
            p["solutions"][0]["explanation"] = {"status": "missing", "content": []}
            p["solutions"][1]["answer"]["status"] = "needs-review"
            p["solutions"][1]["explanation"]["status"] = "needs-review"
        self.change("solutions.json", missing)
        self.assertEqual(VALIDATOR.validate_pack(self.pack)["itemCount"], 2)
        self.change("solutions.json", lambda p: p["solutions"][0]["answer"].update({"optionId": "choice-1"}))
        self.reject()

    def test_missing_explanation_cannot_contain_claimed_content(self):
        self.copy_pack()
        self.change("solutions.json", lambda p: p["solutions"][0]["explanation"].update({"status": "missing"}))
        self.reject()

    def test_rejects_unreviewed_status_names(self):
        for target in ("answer", "explanation"):
            with self.subTest(target=target):
                self.copy_pack()
                self.change("solutions.json", lambda p: p["solutions"][0][target].update({"status": "complete"}))
                self.reject()

    def test_markdown_allows_plain_underline_and_math_inequalities(self):
        self.copy_pack()
        text = "<u>Underlined evidence</u> with $x<y$ and $$y=\\frac{2}{3}$$."
        self.change("items.json", lambda p: p["items"][0]["content"][0].update({"text": text}))
        VALIDATOR.validate_pack(self.pack)

    def test_rejects_other_html_and_remote_markdown_images(self):
        bad_texts = (
            "<script>alert(1)</script>", '<u class="note">word</u>', "<U>word</U>",
            "<table><tr><td>data</td></tr></table>", "<u>unclosed", "<!-- hidden -->",
            "![remote](https://example.invalid/image.png)", "![remote][figure]\n\n[figure]: https://example.invalid/a.png",
            '<img src="https://example.invalid/a.png">',
        )
        for text in bad_texts:
            with self.subTest(text=text):
                self.copy_pack()
                self.change("items.json", lambda p: p["items"][0]["content"][0].update({"text": text}))
                self.reject()

    def test_rejects_unsupported_blocks_and_unknown_image_reference(self):
        for block in ({"type": "table", "rows": []},
                      {"type": "image", "assetId": "missing", "alt": "Data"},
                      {"type": "image", "assetId": "garden-table", "alt": " "},
                      {"type": "image", "assetId": "garden-table", "alt": "Data", "role": "interactive"}):
            with self.subTest(block=block):
                self.copy_pack()
                self.change("items.json", lambda p: p["items"][0].update({"content": [block]}))
                self.reject()

    def test_asset_hash_size_and_local_path_are_verified(self):
        for field, value in (("sha256", "0" * 64), ("byteLength", 1),
                             ("path", "../garden-table.svg"), ("path", "/tmp/remote.svg"),
                             ("path", "assets/../garden-table.svg"),
                             ("path", "https://example.invalid/a.svg"), ("path", "assets\\garden-table.svg")):
            with self.subTest(field=field, value=value):
                self.copy_pack()
                self.change("pack.json", lambda p: p["assets"][0].update({field: value}))
                self.reject()

    def test_asset_file_mutation_is_detected(self):
        self.copy_pack()
        (self.pack / "assets" / "garden-table.svg").write_bytes(b"changed")
        self.reject()

    def test_duplicate_json_key_is_rejected(self):
        self.copy_pack()
        path = self.pack / "items.json"
        path.write_text('{"items": [], "items": []}', encoding="utf-8")
        self.reject()

    def spr_material(self):
        self.copy_pack("math-spr")
        return self.document("pack.json")["inputProfile"], self.document("solutions.json")["solutions"]

    def test_spr_accepts_either_root_but_only_one_input(self):
        profile, solutions = self.spr_material()
        answer = solutions[0]["answer"]
        for response in ("3", "-3", "6/2", "-6/2"):
            with self.subTest(response=response):
                self.assertTrue(VALIDATOR.spr_response_matches(response, answer, profile))
        for response in ("±3", "3,-3", "3 -3", "9"):
            with self.subTest(response=response):
                self.assertFalse(VALIDATOR.spr_response_matches(response, answer, profile))

    def test_spr_missing_or_needs_review_answer_cannot_award_credit(self):
        profile, solutions = self.spr_material()
        answer = solutions[0]["answer"]
        answer["status"] = "needs-review"
        self.assertFalse(VALIDATOR.spr_response_matches("3", answer, profile))
        self.assertFalse(VALIDATOR.spr_response_matches("3", {
            "status": "missing", "type": "student-produced-response"}, profile))

    def test_spr_uses_exact_fractions_and_enumerated_decimals_without_tolerance(self):
        profile, solutions = self.spr_material()
        answer = solutions[1]["answer"]
        for response in ("2/3", "4/6", "20/30", ".6666", ".6667", "0.666", "0.667"):
            with self.subTest(response=response):
                self.assertTrue(VALIDATOR.spr_response_matches(response, answer, profile))
        for response in (".67", "0.67", ".66", ".666", "200/300", "2 / 3", "66.7%", "2/0", 2 / 3):
            with self.subTest(response=response):
                self.assertFalse(VALIDATOR.spr_response_matches(response, answer, profile))

    def test_spr_input_limits_count_negative_sign(self):
        profile, _ = self.spr_material()
        for response in ("12345", "-12345", ".1234", "-.1234"):
            with self.subTest(response=response):
                VALIDATOR.validate_spr_input(response, profile)
        for response in ("123456", "-123456", "1 1/2", "+3", "3.", "1e2", "1,000", "3 cm"):
            with self.subTest(response=response):
                with self.assertRaises(VALIDATOR.DraftValidationError):
                    VALIDATOR.validate_spr_input(response, profile)

    def test_spr_profile_keeps_rule_review_status(self):
        self.copy_pack("math-spr")
        self.change("pack.json", lambda p: p["inputProfile"].update({"status": "official"}))
        self.reject()

    def test_spr_answer_cannot_sneak_in_tolerance_or_invalid_values(self):
        mutations = (
            lambda a: a.update({"numericTolerance": 0.1}),
            lambda a: a.update({"acceptedRationals": ["2/0"]}),
            lambda a: a.update({"acceptedRationals": ["2/3", "4/6"]}),
            lambda a: a.update({"acceptedDecimalSpellings": ["0.66667"]}),
            lambda a: a.update({"acceptedRationals": [], "acceptedDecimalSpellings": []}),
        )
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.copy_pack("math-spr")
                self.change("solutions.json", lambda p: mutation(p["solutions"][1]["answer"]))
                self.reject()


if __name__ == "__main__":
    unittest.main()
