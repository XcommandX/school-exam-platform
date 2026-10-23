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

    def bank(self, questions=None, **kwargs):
        document = copy.deepcopy(self.document)
        document["questions"] = copy.deepcopy(questions if questions is not None else document["questions"][:3])
        document["question_count"] = document["expected_question_count"] = len(document["questions"])
        return CONVERTER.convert_document(document, self.output, collection_id="synthetic-collection", mode="bank", **kwargs)

    def test_bank_only_writes_present_types_and_retains_source_order_without_full_assessment(self):
        questions = self.document["questions"][:3]
        questions[0]["number"] = 21
        questions[0]["module_number"] = 3
        questions.reverse()
        report = self.bank(questions)
        self.assertEqual(list(report["packs"]), ["rw-single-choice"])
        self.assertFalse(report["fullSAT"])
        self.assertIsNone(report["assessmentFile"])
        self.assertFalse((self.output / "assessment.json").exists())
        self.assertFalse((self.output / "math-spr").exists())
        expected_ids = ["sat:item:gengdu-synthetic-collection-" + q["question_id"] for q in questions]
        self.assertEqual([item["id"] for item in self.read("rw-single-choice", "items.json")["items"]], expected_ids)
        self.assertEqual([entry["itemId"] for entry in report["sourceOrder"]], expected_ids)
        self.assertEqual(report["sourceOrder"][-1]["moduleNumber"], 3)
        self.assertTrue(all("durationSeconds" not in module for module in report["modules"]))
        serialized = json.dumps(report) + json.dumps(self.read("rw-single-choice", "items.json"))
        self.assertNotIn("PRIVATE-PERSONAL-MARKER", serialized)

    def test_bank_full_shape_generates_assessment_but_98_question_alternate_path_does_not(self):
        report = self.bank(self.document["questions"])
        self.assertTrue(report["fullSAT"])
        assessment = json.loads((self.output / "assessment.json").read_text())
        self.assertEqual([module["questionCount"] for module in assessment["modules"]], [27, 27, 22, 22])
        for question in self.document["questions"]:
            if question["part_type"] == "ReadingAndWriting" and question["module_number"] == 2:
                question["module_number"] = 3
        report = self.bank(self.document["questions"], replace=True)
        self.assertFalse(report["fullSAT"])
        self.assertFalse((self.output / "assessment.json").exists())

    def test_bank_math_response_type_split_no_invented_english_and_missing_answer_preserved(self):
        questions = [q for q in self.document["questions"] if q["part_type"] == "Math"][:2]
        questions[0]["correct_answer"] = ""
        report = self.bank(questions)
        self.assertEqual(set(report["packs"]), {"math-single-choice", "math-spr"})
        self.assertEqual(report["answerStatus"], {"needs-review": 1, "missing": 1})
        self.assertEqual(self.read("math-spr", "solutions.json")["solutions"][0]["answer"],
                         {"status": "missing", "type": "student-produced-response"})

    def test_bank_collection_namespace_distinguishes_conflicting_source_copies(self):
        self.bank()
        document = copy.deepcopy(self.document)
        document["questions"] = document["questions"][:3]
        document["question_count"] = document["expected_question_count"] = 3
        document["questions"][0]["prompt_html"] = "Different source revision, not silently selected."
        other = self.root / "second-collection"
        CONVERTER.convert_document(document, other, collection_id="second-collection", mode="bank")
        first_id = self.read("rw-single-choice", "items.json")["items"][0]["id"]
        second_id = json.loads((other / "rw-single-choice/items.json").read_text())["items"][0]["id"]
        self.assertNotEqual(first_id, second_id)
        CONVERTER.load_validator().validate_packs([self.output / "rw-single-choice", other / "rw-single-choice"])

    def test_bank_offline_image_uses_archive_assets_digest_and_original_http_provenance(self):
        archive = self.root / "source-archive"
        source = archive / "offline" / "english" / "original.json"
        source.parent.mkdir(parents=True)
        source.write_text("source unchanged")
        (archive / "assets").mkdir()
        data = original_png()
        digest = hashlib.sha256(data).hexdigest()
        local = "assets/" + digest + ".png"
        (archive / local).write_bytes(data)
        (archive / "图片清单.json").write_text(json.dumps({"images": [{"source_url": "https://example.org/source-figure.png",
                                                                   "local_path": local, "sha256": digest}]}))
        relative = "../../" + local
        self.document["images"] = [{"source_url": relative, "mime_type": "image/png", "sha256": digest}]
        self.document["questions"][0]["passage_html"] = '<img src="' + relative + '">'
        report = self.bank(archive=archive, source_path=source)
        asset = self.read("rw-single-choice", "pack.json")["assets"][0]
        self.assertEqual(asset["source"]["url"], "https://example.org/source-figure.png")
        self.assertEqual((self.output / "rw-single-choice" / asset["path"]).read_bytes(), data)
        self.assertEqual(source.read_text(), "source unchanged")
        self.assertEqual(report["uniqueOriginalImages"], 1)
        self.document["images"][0]["sha256"] = "0" * 64
        with self.assertRaisesRegex(CONVERTER.ConversionError, "SHA-256 mismatch"):
            self.bank(archive=archive, source_path=source, replace=True)
        self.assertEqual((self.output / "rw-single-choice" / asset["path"]).read_bytes(), data)

    def test_bank_offline_image_rejects_traversal_and_symbolic_links(self):
        archive = self.root / "archive"
        source = archive / "offline" / "questions.json"
        source.parent.mkdir(parents=True)
        source.write_text("{}")
        assets = archive / "assets"
        assets.mkdir()
        digest = hashlib.sha256(original_png()).hexdigest()
        outside = self.root / "outside.png"
        outside.write_bytes(original_png())
        for relative in ("../../outside.png", "../assets/linked.png"):
            if relative.endswith("linked.png"):
                (assets / "linked.png").symlink_to(outside)
            self.document["images"] = [{"source_url": relative, "sha256": digest, "mime_type": "image/png"}]
            self.document["questions"][0]["passage_html"] = '<img src="' + relative + '">'
            with self.assertRaises(CONVERTER.ConversionError):
                self.bank(archive=archive, source_path=source)
            self.assertFalse(self.output.exists())

    def test_static_svg_keeps_exact_bytes_and_rejects_active_or_unsupported_source(self):
        data = b'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><path d="M0 0L2 2" stroke="black"/></svg>'
        url = "https://example.org/original.svg"
        self.document["images"] = [{"source_url": url, "mime_type": "image/svg+xml", "sha256": hashlib.sha256(data).hexdigest(),
                                    "data_base64": base64.b64encode(data).decode("ascii")}]
        self.document["questions"][0]["passage_html"] = '<img src="' + url + '">'
        self.bank()
        asset = self.read("rw-single-choice", "pack.json")["assets"][0]
        self.assertEqual((self.output / "rw-single-choice" / asset["path"]).read_bytes(), data)
        for unsafe in (b'<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>',
                       b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
                       b'<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://example.org/no)"/></svg>'):
            with self.assertRaises(CONVERTER.ConversionError):
                CONVERTER.image_type(unsafe)

    def test_bank_rejects_empty_questions_and_inconsistent_declared_counts(self):
        with self.assertRaisesRegex(CONVERTER.ConversionError, "nonempty"):
            self.bank([])
        self.document["question_count"] = 1
        with self.assertRaisesRegex(CONVERTER.ConversionError, "count declarations"):
            CONVERTER.convert_document(self.document, self.output, collection_id="synthetic-collection", mode="bank")

    def test_bank_omits_only_strict_wps_tiny_absolutely_positioned_editor_placeholder(self):
        url = r"https://static.shanmaostar.com/szgditPe/default/nsat/file:///C:\Users\synthetic\AppData\Local\Temp\ksohtml123\wps1.png"
        self.document["questions"][0]["passage_html"] = '<p>Original passage.</p><span style="position:absolute;width:1px"><img src="' + url + '" style="width:1px;height:1px"></span>'
        report = self.bank()
        self.assertEqual(report["ignoredSourcePlaceholders"][0]["sourceQuestionId"], "1001")
        self.assertEqual(report["imageReferences"], 0)
        self.assertEqual(self.read("rw-single-choice", "items.json")["items"][0]["content"], [{"type": "markdown", "text": "Original passage."}])
        self.document["questions"][0]["passage_html"] = '<span style="position:absolute;width:1px"><img src="' + url + '" style="width:200px;height:200px"></span>'
        with self.assertRaises(CONVERTER.ConversionError):
            self.bank(replace=True)
        self.document["questions"][0]["passage_html"] = '<img src="' + url + '" style="width:1px;height:1px">'
        with self.assertRaises(CONVERTER.ConversionError):
            self.bank(replace=True)

    def test_bank_spr_omits_only_source_listed_exact_equivalent_overlong_decimal(self):
        questions = [q for q in self.document["questions"] if q["question_type"] == "response"][:1]
        questions[0]["correct_answer"] = "0.1250,1/8,.1250"
        report = self.bank(questions)
        answer = self.read("math-spr", "solutions.json")["solutions"][0]["answer"]
        self.assertEqual(answer["acceptedRationals"], ["1/8"])
        self.assertEqual(answer["acceptedDecimalSpellings"], [".1250"])
        notes = [note for note in report["reviewNotes"] if note.get("issue") == "uninputtable-equivalent-source-decimal-spelling"]
        self.assertEqual(notes[0]["omittedSpelling"], "0.1250")
        self.assertEqual(notes[0]["retainedEquivalentSourceSpellings"], ["1/8", ".1250"])
        questions[0]["correct_answer"] = "0.12500,.1249"
        with self.assertRaisesRegex(CONVERTER.ConversionError, "draft input limit"):
            self.bank(questions, replace=True)
        with self.assertRaisesRegex(CONVERTER.ConversionError, "draft input limit"):
            CONVERTER.spr_answer("0.1250,1/8")

    def test_bank_spr_can_shorten_only_optional_integer_zero_with_exact_same_decimal_value(self):
        questions = [q for q in self.document["questions"] if q["question_type"] == "response"][:1]
        questions[0]["correct_answer"] = "1/17,0.058,0.059,0.0588,3/51,-0.0588"
        report = self.bank(questions)
        answer = self.read("math-spr", "solutions.json")["solutions"][0]["answer"]
        self.assertEqual(answer["acceptedRationals"], ["1/17"])
        self.assertEqual(answer["acceptedDecimalSpellings"], ["0.058", "0.059", ".0588", "-.0588"])
        notes = [note for note in report["reviewNotes"] if note.get("issue") == "source-decimal-spelling-normalization"]
        self.assertEqual([(note["sourceSpelling"], note["normalizedSpelling"]) for note in notes], [("0.0588", ".0588"), ("-0.0588", "-.0588")])
        questions[0]["correct_answer"] = "1.0588"
        with self.assertRaisesRegex(CONVERTER.ConversionError, "draft input limit"):
            self.bank(questions, replace=True)

    def test_bank_latex_relations_use_equivalent_commands_without_touching_narrative_or_html_validation(self):
        self.document["questions"][0]["prompt_html"] = '<p>Text a &lt; b and c &gt; d. <span latex-data="r&lt;a\\ \\ b&lt;r&lt;a\\ r&gt;c">EDITOR-DOM</span></p>'
        report = self.bank()
        prompt = self.read("rw-single-choice", "items.json")["items"][0]["prompt"][0]["text"]
        self.assertIn("Text a &lt; b and c &gt; d.", prompt)
        self.assertIn("$r\\lt a\\ \\ b\\lt r\\lt a\\ r\\gt c$", prompt)
        notes = [note for note in report["reviewNotes"] if note.get("issue") == "source-latex-relational-operator-normalization"]
        self.assertEqual(notes[0]["sourceLatex"], "r<a\\ \\ b<r<a\\ r>c")
        validator = CONVERTER.load_validator()
        with self.assertRaisesRegex(ValueError, "raw HTML"):
            validator._markdown("<a href='https://example.org'>source</a>")

    def test_bank_trailing_latex_control_spaces_keep_spacing_without_escaping_closing_delimiter(self):
        self.document["questions"][0]["prompt_html"] = '<span class="mq-math-mode" latex-data="h(x)=x+5\\ \\ "><span class="mq-root-block">h(x)=x+5<span>&nbsp;</span><span>&nbsp;</span></span></span>'
        self.document["questions"][1]["prompt_html"] = '<span latex-data="x&gt;">x&gt;</span>'
        report = self.bank()
        items = self.read("rw-single-choice", "items.json")["items"]
        self.assertEqual(items[0]["prompt"], [{"type": "markdown", "text": "$h(x)=x+5\\space{}\\space{}$"}])
        self.assertEqual(items[1]["prompt"], [{"type": "markdown", "text": "$x\\gt$"}])
        notes = [note for note in report["reviewNotes"] if note.get("issue") == "source-latex-trailing-control-space-normalization"]
        self.assertEqual(notes[0]["sourceLatex"], "h(x)=x+5\\ \\ ")
        self.assertEqual(notes[0]["normalizedLatex"], "h(x)=x+5\\space{}\\space{}")
        self.document["questions"][0]["prompt_html"] = '<span latex-data="x\\\\ ">Original line break</span>'
        report = self.bank(replace=True)
        self.assertEqual(self.read("rw-single-choice", "items.json")["items"][0]["prompt"][0]["text"], "$x\\\\$")
        self.assertFalse(any(note.get("issue") == "source-latex-trailing-control-space-normalization" for note in report["reviewNotes"]))
        self.document["questions"][0]["prompt_html"] = '<span latex-data="x\\">Unreliable dangling escape</span>'
        with self.assertRaisesRegex(CONVERTER.ConversionError, "Dangling source LaTeX"):
            self.bank(replace=True)

    def test_bank_formula_table_keeps_math_and_reports_ambiguous_source_visual_tree(self):
        self.document["questions"][0]["prompt_html"] = '<table><tr><td>x</td><td>y</td></tr><tr><td>1</td><td><span class="mq-math-mode" latex-data="\\frac{1}{2}"><span class="mq-textarea"><textarea>PRIVATE-PERSONAL-MARKER</textarea></span></span></td></tr></table>'
        report = self.bank()
        prompt = self.read("rw-single-choice", "items.json")["items"][0]["prompt"][0]
        self.assertEqual(prompt, {"type": "markdown", "text": "| x | y |\n| --- | --- |\n| 1 | $\\frac{1}{2}$ |"})
        self.assertEqual(report["tableConversions"][0]["method"], "markdown-table-from-explicit-html-cells-with-latex")
        notes = [note for note in report["reviewNotes"] if note.get("issue") == "source-latex-and-visible-mathquill-tree-require-review"]
        self.assertEqual(notes[0]["sourceLatex"], "\\frac{1}{2}")
        self.assertEqual(notes[0]["visibleSourceText"], "")
        self.assertNotIn("PRIVATE-PERSONAL-MARKER", json.dumps(prompt))

    def test_bank_explicit_blank_table_corner_is_preserved_but_other_blank_cells_fail(self):
        self.document["questions"][0]["prompt_html"] = '<table><tr><td><br></td><td>A</td></tr><tr><td>Category</td><td>2</td></tr></table>'
        report = self.bank()
        self.assertEqual(report["tableConversions"][0]["rows"], [["", "A"], ["Category", "2"]])
        self.document["questions"][0]["prompt_html"] = '<table><tr><td>Header</td><td>A</td></tr><tr><td>Category</td><td><br></td></tr></table>'
        with self.assertRaisesRegex(CONVERTER.ConversionError, "Empty table cell"):
            self.bank(replace=True)

    def test_bank_script_keeps_nested_latex_degree_fraction_and_anomalous_source_placement(self):
        self.document["questions"][0]["prompt_html"] = '<p>Original<sup>\u200b</sup> x<sup>m/20</sup> and 30<sup>∘</sup>; a<sup>(<span latex-data="\\frac{4}{6}">NOISY</span>)t</sup>; <sup>Which ordered pair?</sup>; x<sup>2=</sup></p>'
        report = self.bank()
        prompt = self.read("rw-single-choice", "items.json")["items"][0]["prompt"][0]["text"]
        for expected in ("$^{m/20}$", "$^{\\circ}$", "$^{(\\frac{4}{6})t}$", "$^{\\text{Which ordered pair?}}$", "$^{2=}$"):
            self.assertIn(expected, prompt)
        self.assertNotIn("NOISY", prompt)
        self.assertEqual(len(report["ignoredEmptyInlineNodes"]), 1)
        self.assertEqual(len([note for note in report["reviewNotes"] if note.get("issue") == "source-script-placement-requires-review"]), 2)

    def test_explicit_svg_png_cache_checks_original_digest_derived_bytes_dimensions_and_path(self):
        original = b'<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="white"/></svg>'
        original_digest = hashlib.sha256(original).hexdigest()
        data = original_png()
        digest = hashlib.sha256(data).hexdigest()
        url = "https://example.org/original-with-xml-declaration.svg"
        self.document["images"] = [{"source_url": url, "mime_type": "image/svg+xml", "sha256": original_digest,
                                    "data_base64": base64.b64encode(original).decode("ascii")}]
        self.document["questions"][0]["passage_html"] = '<img src="' + url + '">'
        cache = self.root / "derived-cache"
        cache.mkdir()
        (cache / (original_digest + ".png")).write_bytes(data)
        entry = {"originalSha256": original_digest, "originalSourceUrls": [url], "pngPath": original_digest + ".png",
                 "sha256": digest, "byteLength": len(data), "mediaType": "image/png", "width": 2, "height": 2,
                 "method": "validated-svg-image-context-to-canvas-png"}
        manifest = cache / "manifest.json"
        manifest.write_text(json.dumps({"schemaVersion": "gengdu-svg-raster-cache/1", "entries": [entry]}))
        with self.assertRaisesRegex(CONVERTER.ConversionError, "SVG declarations"):
            self.bank()
        report = self.bank(image_cache=manifest)
        asset = self.read("rw-single-choice", "pack.json")["assets"][0]
        self.assertEqual(asset["mediaType"], "image/png")
        self.assertEqual(asset["source"]["url"], url)
        self.assertEqual((self.output / "rw-single-choice" / asset["path"]).read_bytes(), data)
        self.assertEqual(report["imageTransformations"][0]["originalSha256"], original_digest)
        self.assertEqual(report["imageTransformations"][0]["derivedSha256"], digest)
        for field, value, message in (("width", 3, "dimensions"), ("sha256", "0" * 64, "SHA-256"), ("pngPath", "../outside.png", "path")):
            invalid = {**entry, field: value}
            manifest.write_text(json.dumps({"schemaVersion": "gengdu-svg-raster-cache/1", "entries": [invalid]}))
            with self.assertRaisesRegex(CONVERTER.ConversionError, message):
                self.bank(image_cache=manifest, replace=True)
        self.assertEqual((self.output / "rw-single-choice" / asset["path"]).read_bytes(), data)


if __name__ == "__main__":
    unittest.main()
