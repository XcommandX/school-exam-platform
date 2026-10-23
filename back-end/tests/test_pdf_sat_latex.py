"""Synthetic evidence and failure-boundary tests for PDF formula conversion."""
import importlib.util
from pathlib import Path
import unittest


SPEC = importlib.util.spec_from_file_location(
    "pdf_sat_latex", Path(__file__).resolve().parents[1] / "tools/sat/pdf_sat_latex.py")
LATEX = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LATEX)


def span(text, x=10, baseline=30, size=12, flags=4, font="Serif"):
    return {"text": text, "font": font, "flags": flags, "size": size,
            "origin": [x, baseline], "bbox": [x, baseline - size, x + len(text) * size / 2, baseline + 2]}


class PdfSatLatexTests(unittest.TestCase):
    def render(self, text, spans=None, section="math"):
        return LATEX.render_line({"kind": "text", "text": text, "spans": spans or [],
                                  "pageNumber": 1, "bbox": [10, 10, 100, 30]}, section=section)

    def test_inline_equations_preserve_prose_and_punctuation(self):
        output, warnings, count = self.render("If x=2, what is f(x)=3x+7?")
        self.assertEqual(output, "If $x=2$, what is $f(x)=3x+7$?")
        self.assertEqual((warnings, count), ([], 2))

    def test_numeric_option_and_numeric_fraction_are_latex(self):
        self.assertEqual(self.render("130"), ("$$130$$", [], 1))
        self.assertEqual(self.render("33/135"), (r"$$\frac{33}{135}$$", [], 1))

    def test_currency_dollars_do_not_start_math(self):
        output, warnings, count = self.render("The cost is $15,400 and $20 per month; x=5.")
        self.assertEqual(output, r"The cost is \$15,400 and \$20 per month; $x=5$.")
        self.assertEqual((warnings, count), ([], 1))

    def test_real_superscript_geometry_produces_exponent(self):
        spans = [span("x", x=10), span("2", x=16, baseline=25, size=8, flags=5),
                 span("+3=7", x=20)]
        self.assertEqual(self.render("x2+3=7", spans), ("$$x^{2}+3=7$$", [], 1))

    def test_real_subscript_geometry_produces_index(self):
        spans = [span("a", x=10), span("1", x=16, baseline=34, size=8), span("=4", x=20)]
        self.assertEqual(self.render("a1=4", spans), ("$$a_{1}=4$$", [], 1))

    def test_baseline_digits_are_not_guessed_to_be_exponents(self):
        spans = [span("x", x=10), span("2+3=7", x=16)]
        output, warnings, count = self.render("x2+3=7", spans)
        self.assertEqual(output, "$$x2+3=7$$")
        self.assertIn("source_formula_ambiguous:baseline_variable_digit", warnings)
        self.assertEqual(count, 1)

    def test_flat_source_with_large_spaces_is_not_repaired(self):
        output, warnings, count = self.render("3      x    2    +  7  x  +  14  b")
        self.assertEqual(output, "$$3 x 2+7 x+14 b$$")
        self.assertNotIn("^{2}", output)
        self.assertIn("source_formula_ambiguous:baseline_variable_digit", warnings)
        self.assertEqual(count, 1)

    def test_unicode_scripts_are_explicit_source_evidence(self):
        self.assertEqual(self.render("x²+a₁=5"), ("$$x^{2}+a_{1}=5$$", [], 1))

    def test_symbols_radicals_and_functions_use_latex(self):
        output, warnings, count = self.render("√(x+1)≤3π+sin(x)")
        self.assertEqual(output, r"$$\sqrt{x+1}\le 3\pi+\sin (x)$$")
        self.assertEqual((warnings, count), ([], 1))

    def test_geometry_labels_and_degrees_stay_visible(self):
        output, warnings, count = self.render("In △XYZ, ∠X is 55°.")
        self.assertEqual(output, r"In $\triangle XYZ$, $\angle X$ is $55^{\circ}$.")
        self.assertEqual((warnings, count), ([], 3))

    def test_ascii_inequalities_do_not_look_like_raw_html(self):
        output, warnings, count = self.render("If 0<a<1, then x>2.")
        self.assertEqual(output, r"If $0\lt a\lt 1$, then $x\gt 2$.")
        self.assertNotIn("<", output)
        self.assertNotIn(">", output)
        self.assertEqual((warnings, count), ([], 2))

    def test_coordinate_pair_and_units(self):
        output, warnings, count = self.render("The point is (1, 2), and the area is 3 cm².")
        self.assertEqual(output, r"The point is $(1, 2)$, and the area is $3 \mathrm{cm}^{2}$.")
        self.assertEqual((warnings, count), ([], 2))

    def test_ordinary_numbers_dates_and_articles_remain_prose(self):
        self.assertEqual(self.render("A line contains 20 points."), ("A line contains 20 points.", [], 0))
        self.assertEqual(self.render("In the winter of 1980-81.", section="reading-writing"),
                         ("In the winter of 1980-81.", [], 0))

    def test_explicit_equation_in_reading_section_is_also_latex(self):
        output, warnings, count = self.render("The model uses f(x)=2x+1.", section="reading-writing")
        self.assertEqual(output, "The model uses $f(x)=2x+1$.")
        self.assertEqual((warnings, count), ([], 1))

    def test_italic_variable_a_is_distinct_from_article(self):
        spans = [span("The variable ", x=10), span("a", x=88, flags=6, font="Serif-Italic"),
                 span(" is a constant.", x=94)]
        # Article 'a' shares the spelling; the renderer must not turn it into an
        # isolated formula merely because the variable is italic elsewhere.
        output, _, _ = self.render("The variable a is a constant.", spans)
        self.assertIn("variable $a$ is", output)
        self.assertTrue(output.endswith("a constant."), output)

    def test_span_mismatch_does_not_resurrect_removed_source_text(self):
        output, warnings, count = self.render("3/4", [span("A. 3/4")])
        self.assertEqual(output, r"$$\frac{3}{4}$$")
        self.assertIn("source_span_text_mismatch", warnings)
        self.assertEqual(count, 1)

    def test_overlap_is_reported_and_both_visible_values_survive(self):
        output, warnings, _ = self.render("55°", [span("55", x=10), span("°", x=15)])
        self.assertEqual(output, r"$$55^{\circ}$$")
        self.assertIn("source_overlapping_spans", warnings)

    def test_unknown_commands_cannot_become_latex_execution(self):
        output, warnings, _ = self.render(r"\input{secret}")
        self.assertNotIn(r"$\input", output)
        self.assertIn(r"\text{\textbackslash{}input}", output)
        self.assertIn("source_formula_ambiguous:unsupported_command", warnings)

    def test_reading_blank_underscores_stay_literal_prose(self):
        output, warnings, count = self.render("In _____2018, the _____ a claim.", section="reading-writing")
        self.assertEqual(output, r"In \_\_\_\_\_2018, the \_\_\_\_\_ a claim.")
        self.assertEqual((warnings, count), ([], 0))

    def test_product_in_exponent_is_not_split_out_of_formula(self):
        output, warnings, count = self.render("The model is f(x)=a*(1/0.4)^{bx}.")
        self.assertEqual(output, r"The model is $f(x)=a*(\frac{1}{0.4})^{bx}$.")
        self.assertEqual((warnings, count), ([], 1))

    def test_unpaired_printed_braces_are_visible_literals(self):
        output, warnings, count = self.render("{y≥x+3y≤-2x-3")
        self.assertEqual(output, r"$$\{y\ge x+3y\le -2x-3$$")
        self.assertIn("source_formula_ambiguous:literal_brace", warnings)
        self.assertEqual(count, 1)
        self.assertEqual(self.render("88 }")[0], r"$$88 \}$$")

    def test_detached_fahrenheit_degree_keeps_command_boundary(self):
        output, warnings, count = self.render("°F")
        self.assertEqual(output, r"$$\circ F$$")
        self.assertIn("source_formula_ambiguous:detached_degree", warnings)
        self.assertEqual(count, 1)

    def test_unclosed_source_script_is_shown_without_inventing_a_group(self):
        output, warnings, count = self.render("x^{")
        self.assertEqual(output, r"$$x\text{\textasciicircum{}}\{$$")
        self.assertIn("source_formula_ambiguous:literal_script_marker", warnings)
        self.assertEqual(count, 1)

    def test_fused_units_and_missing_radicals_are_flagged_without_guess(self):
        output, warnings, _ = self.render("is k3centimeters, where k is a constant.")
        self.assertIn("$k3$", output)
        self.assertNotIn("sqrt", output)
        self.assertIn("source_formula_ambiguous:fused_formula_and_unit", warnings)


if __name__ == "__main__":
    unittest.main()
