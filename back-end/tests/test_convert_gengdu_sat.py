"""Offline conversion regressions use only generated, anonymous question data."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest
import zlib
import _paths


SCRIPT = _paths.ROOT / "back-end/tools/sat/convert_gengdu_sat.py"
SPEC = importlib.util.spec_from_file_location("convert_gengdu_sat", SCRIPT)
CONVERTER = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = CONVERTER
SPEC.loader.exec_module(CONVERTER)


def original_png():
    def chunk(name, data):
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 2, 2, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(b"\x00" + b"\xff\xff\xff" * 2 + b"\x00" + b"\xff\xff\xff" * 2)) + chunk(b"IEND", b""))


def synthetic_document():
    questions = []
    sequence = 1000
    for section in ("ReadingAndWriting", "Math"):
        for module in (1, 2):
            for number in range(1, (27 if section == "ReadingAndWriting" else 22) + 1):
                sequence += 1
                spr = section == "Math" and number == 1
                questions.append({"question_id": str(sequence), "part_type": section, "module_number": module, "number": number,
                                  "question_type": "response" if spr else "choice", "passage_html": "", "passage_text": "",
                                  "prompt_html": f"<p>Original synthetic question {sequence}?</p>", "prompt_text": "",
                                  "choices": [] if spr else [{"label": label, "html": f"Choice {label}", "text": ""} for label in "ABCD"],
                                  "correct_answer": "2/3,.6667" if spr else "A", "answer_status": "confirmed",
                                  "explanation_html": "", "explanation_text": "", "selected_answer": "PRIVATE-PERSONAL-MARKER"})
    image = original_png()
    return {"title": "Original synthetic SAT conversion", "source": "https://example.org/source", "question_count": 98,
            "expected_question_count": 98, "questions": questions,
            "images": [{"source_url": "https://example.org/original.png", "mime_type": "image/png", "sha256": hashlib.sha256(image).hexdigest(),
                        "data_base64": base64.b64encode(image).decode("ascii")}], "student_name": "PRIVATE-PERSONAL-MARKER"}


class ConversionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.output = self.root / "synthetic-collection"
        self.document = synthetic_document()

    def tearDown(self):
        self.temporary.cleanup()

    def convert(self, document=None, **kwargs):
        return CONVERTER.convert_document(document or self.document, self.output, collection_id="synthetic-collection", **kwargs)

    def read(self, pack, name):
        return json.loads((self.output / pack / name).read_text(encoding="utf-8"))

    def test_split_packs_assessment_stable_references_and_no_personal_data(self):
        original = copy.deepcopy(self.document)
        self.document["questions"].reverse()
        report = self.convert()
        self.assertEqual(report["questionCount"], 98)
        self.assertEqual([report["packs"][name]["questionCount"] for name in CONVERTER.PACKS], [54, 42, 2])
        assessment = json.loads((self.output / "assessment.json").read_text())
        self.assertEqual(set(assessment), {"schemaVersion", "title", "fullSAT", "breakDurationSeconds", "questionCount", "sections", "modules"})
        self.assertEqual(assessment["schemaVersion"], "sat-assessment/0.1-draft")
        self.assertEqual(assessment["questionCount"], 98)
        self.assertEqual([section["questionCount"] for section in assessment["sections"]], [54, 44])
        self.assertEqual([module["questionCount"] for module in assessment["modules"]], [27, 27, 22, 22])
        self.assertTrue(assessment["fullSAT"])
        self.assertEqual(assessment["breakDurationSeconds"], 600)
        self.assertEqual([len(module["items"]) for module in assessment["modules"]], [27, 27, 22, 22])
        self.assertEqual([module["durationSeconds"] for module in assessment["modules"]], [1920, 1920, 2100, 2100])
        self.assertEqual(assessment["modules"][0]["items"][0]["itemId"], "sat:item:gengdu-1001")
        self.assertEqual(set(assessment["modules"][0]["items"][0]), {"packId", "packRevision", "itemId", "itemRevision"})
        for name in CONVERTER.PACKS:
            for solution in self.read(name, "solutions.json")["solutions"]:
                self.assertEqual(solution["answer"]["status"], "needs-review")
                self.assertEqual(solution["explanation"], {"status": "missing", "content": []})
        content = "".join(path.read_text() for path in self.output.rglob("*.json"))
        self.assertNotIn("PRIVATE-PERSONAL-MARKER", content)
        self.assertNotIn("selected_answer", content)
        self.assertNotIn("sourcePath", content)
        self.assertEqual(original["questions"][0], self.document["questions"][-1])

    def test_mathquill_replaces_entire_nested_dom_and_preserves_markdown(self):
        first = self.document["questions"][0]
        first["passage_html"] = '<p>First <u>underlined</u> line.</p><p><em>f </em>then<br>poem line</p><ul><li>One</li><li>Two</li></ul><p>Cost $4.</p>'
        first["prompt_html"] = '<span latex-data="\\frac{3}{4}"><span class="mq-textarea"><textarea>NOISY-EDITOR</textarea></span><span latex-data="wrong">DUPLICATED-DOM</span></span>'
        self.convert()
        item = self.read("rw-single-choice", "items.json")["items"][0]
        self.assertEqual(item["prompt"], [{"type": "markdown", "text": "$\\frac{3}{4}$"}])
        markdown = item["content"][0]["text"]
        self.assertIn("<u>underlined</u>", markdown)
        self.assertIn("*f* then  \npoem line", markdown)
        self.assertIn("- One\n- Two", markdown)
        self.assertIn("\\$4", markdown)
        self.assertNotIn("NOISY-EDITOR", json.dumps(item))
        self.assertNotIn("DUPLICATED-DOM", json.dumps(item))

    def test_original_image_bytes_and_sha_are_preserved_in_offline_asset(self):
        self.document["questions"][0]["passage_html"] = '<img src="https://example.org/original.png" alt="Original generated white square">'
        report = self.convert()
        pack = self.read("rw-single-choice", "pack.json")
        image = self.read("rw-single-choice", "items.json")["items"][0]["content"][0]
        self.assertEqual(image["type"], "image")
        self.assertEqual(image["assetId"], pack["assets"][0]["id"])
        self.assertEqual((self.output / "rw-single-choice" / pack["assets"][0]["path"]).read_bytes(), original_png())
        self.assertEqual(report["imageReferences"], 1)
        self.assertEqual(report["uniqueOriginalImages"], 1)

    def test_simple_table_preserves_explicit_cells_and_rejects_merged_table(self):
        self.document["questions"][0]["passage_html"] = '<table><tr><td><em>x</em></td><td>y</td></tr><tr><td>-3</td><td>17</td></tr></table>'
        report = self.convert()
        self.assertEqual(report["tableConversions"][0]["rows"], [["x", "y"], ["-3", "17"]])
        item = self.read("rw-single-choice", "items.json")["items"][0]
        self.assertEqual(item["content"][0]["role"], "table")
        svg = next((self.output / "rw-single-choice/assets").glob("*.svg")).read_text()
        self.assertIn('font-style="italic">x</text>', svg)
        self.assertNotIn("foreignObject", svg)
        other = self.root / "merged"
        self.document["questions"][0]["passage_html"] = '<table><tr><td colspan="2">Explicit merged cell</td></tr></table>'
        with self.assertRaisesRegex(CONVERTER.ConversionError, "Merged"):
            CONVERTER.convert_document(self.document, other, collection_id="synthetic-collection")
        self.assertFalse(other.exists())

    def test_spr_accepts_exact_rationals_and_only_explicit_decimal_spellings(self):
        answer = CONVERTER.spr_answer("4/6,2/3,.6666,.6667,0.667")
        self.assertEqual(answer["acceptedRationals"], ["2/3"])
        self.assertEqual(answer["acceptedDecimalSpellings"], [".6666", ".6667", "0.667"])
        self.assertEqual(answer["status"], "needs-review")
        with self.assertRaises(CONVERTER.ConversionError):
            CONVERTER.spr_answer("3 1/2")
        with self.assertRaises(CONVERTER.ConversionError):
            CONVERTER.spr_answer("1/0")

    def test_missing_image_and_bad_digest_fail_without_publishing_partial_collection(self):
        question = self.document["questions"][0]
        question["passage_html"] = '<img src="https://example.org/missing.png">'
        with self.assertRaisesRegex(CONVERTER.ConversionError, "missing.png"):
            self.convert()
        self.assertFalse(self.output.exists())
        question["passage_html"] = '<img src="https://example.org/original.png">'
        self.document["images"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(CONVERTER.ConversionError, "SHA-256 mismatch"):
            self.convert()
        self.assertFalse(self.output.exists())

    def test_duplicate_ids_module_positions_and_active_html_fail(self):
        self.document["questions"][0]["prompt_html"] = '<script>alert("no execution")</script>'
        with self.assertRaisesRegex(CONVERTER.ConversionError, "active/foreign"):
            self.convert()
        self.document = synthetic_document()
        self.document["questions"][1]["question_id"] = self.document["questions"][0]["question_id"]
        with self.assertRaisesRegex(CONVERTER.ConversionError, "Duplicate source"):
            self.convert()
        self.document = synthetic_document()
        self.document["questions"][1]["number"] = 1
        with self.assertRaisesRegex(CONVERTER.ConversionError, "module positions"):
            self.convert()

    def test_repeat_conversion_is_deterministic_and_existing_output_is_protected(self):
        self.convert()
        before = {str(path.relative_to(self.output)): path.read_bytes() for path in self.output.rglob("*") if path.is_file()}
        with self.assertRaisesRegex(CONVERTER.ConversionError, "Output exists"):
            self.convert()
        self.convert(replace=True)
        after = {str(path.relative_to(self.output)): path.read_bytes() for path in self.output.rglob("*") if path.is_file()}
        self.assertEqual(before, after)


if __name__ == "__main__":
    unittest.main()
