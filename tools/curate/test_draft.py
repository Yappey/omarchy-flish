"""Tests for the drafting tool's reply parsing.

Run: python3 -m unittest discover -s tools/curate -p 'test_*.py'

extract_json is the only part of draft.py that can lose data silently. A model
reply that it mis-parses is reported as "no JSON", which reads like the model
failed when in fact the answer was there and the reader dropped it -- exactly
what happened with phi-4-mini-reasoning, whose whole reasoning chain arrives
inline and mentions dozens of JSON fragments before giving the real answer last.

Stdlib unittest so this needs no dependencies; the Node suite covers the
dictionary, and these two do not overlap.
"""

import importlib.util
import pathlib
import unittest

_spec = importlib.util.spec_from_file_location(
    "draft", pathlib.Path(__file__).parent / "draft.py")
draft = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(draft)


class ExtractJson(unittest.TestCase):
    def test_bare_object(self):
        self.assertEqual(draft.extract_json('{"id":"x","body":"Why?"}')["id"], "x")

    def test_fenced(self):
        self.assertEqual(
            draft.extract_json('```json\n{"id":"y","body":"Where?"}\n```')["id"], "y")

    def test_prose_before_the_object(self):
        self.assertEqual(
            draft.extract_json('Here is my answer:\n{"id":"z","body":"What?"}')["id"], "z")

    def test_think_block_is_ignored(self):
        reply = '<think>could be {"id":"wrong"} or {"id":"alsowrong"}</think>\n{"id":"right","body":"Q?"}'
        self.assertEqual(draft.extract_json(reply)["id"], "right")

    def test_unclosed_think_block(self):
        reply = '<think>reasoning that mentions {"schema_version": 1, ...} and never closes\n{"id":"right","body":"Q?"}'
        self.assertEqual(draft.extract_json(reply)["id"], "right")

    def test_prefers_the_template_shaped_object(self):
        reply = '{"note":"scratch"}\nfinal:\n{"id":"real","match":{"command":"cd"},"body":"Q?"}'
        self.assertEqual(draft.extract_json(reply)["id"], "real")

    def test_answer_last_wins(self):
        reply = 'First draft {"id":"early","body":"a?"} but actually {"id":"late","body":"b?"}'
        self.assertEqual(draft.extract_json(reply)["id"], "late")

    def test_no_json_is_none(self):
        self.assertIsNone(draft.extract_json("Just prose, no object here."))
        self.assertIsNone(draft.extract_json(""))
        self.assertIsNone(draft.extract_json(None))

    def test_declining_with_an_empty_object(self):
        # The prompt tells a model to return {} when it has nothing useful.
        self.assertEqual(draft.extract_json("{}"), {})


class ResolveReasoning(unittest.TestCase):
    """Models disagree on what settings exist; guessing costs a failed run."""

    def test_explicit_value_must_be_supported(self):
        # Validated against the live server, so only the no-options path is
        # unit-testable here: with nothing reported, anything is passed through.
        self.assertEqual(
            draft.resolve_reasoning("http://127.0.0.1:0", "nope/nope", "high"), "high")

    def test_unreachable_server_yields_no_field(self):
        self.assertIsNone(
            draft.resolve_reasoning("http://127.0.0.1:0", "nope/nope", None))


class DegenerateReplies(unittest.TestCase):
    """An endpoint that suits one model can produce nothing usable from another,
    and that must not read as bad copy."""

    def test_generic_json_is_degenerate(self):
        self.assertTrue(draft.looks_degenerate({"ok": True}))
        self.assertTrue(draft.looks_degenerate({}))
        self.assertTrue(draft.looks_degenerate({"schema_version": 1, "id": "x"}))

    def test_a_real_attempt_is_not(self):
        self.assertFalse(draft.looks_degenerate(
            {"match": {"command": "cat"}, "title": "t", "body": "Why?"}))
        # A body alone is still an attempt -- match can be filled in later.
        self.assertFalse(draft.looks_degenerate({"body": "Which command lists it?"}))

    def test_non_dict_is_degenerate(self):
        self.assertTrue(draft.looks_degenerate(None))
        self.assertTrue(draft.looks_degenerate([1, 2]))


class ModelProfiles(unittest.TestCase):
    """Every card recommends different sampling; none match server defaults."""

    def test_prefix_match(self):
        self.assertEqual(profile_name("google/gemma-4-31b"), "Gemma 4 (26B-A4B MoE, 31B dense)")
        self.assertEqual(profile_name("google/gemma-4-26b-a4b-qat"), "Gemma 4 (26B-A4B MoE, 31B dense)")

    def test_families_are_distinguished(self):
        self.assertNotEqual(profile_name("qwen/qwen3.6-35b-a3b"), profile_name("qwen/qwen3.8-27b"))

    def test_gemma_keeps_its_high_temperature(self):
        # The card warns the family behaves oddly when this is dropped, so a
        # future "lower it for structured output" instinct should fail here.
        self.assertEqual(draft.profile_for("google/gemma-4-31b")["sampling"]["temperature"], 1.0)

    def test_unknown_model_falls_back_without_crashing(self):
        p = draft.profile_for("someone/unreleased-model")
        self.assertEqual(p["suitability"], "unknown")
        self.assertIn("temperature", p["sampling"])

    def test_out_of_scope_is_flagged(self):
        self.assertEqual(
            draft.profile_for("microsoft/phi-4-mini-reasoning")["suitability"], "out-of-scope")


class StructuredOutput(unittest.TestCase):
    def test_response_format_is_built_from_the_shipped_schema(self):
        rf = draft.hint_response_format()
        self.assertEqual(rf["type"], "json_schema")
        schema = rf["json_schema"]["schema"]
        # $schema/$id would make the API reject it; the real schema has both.
        self.assertFalse([k for k in schema if k.startswith("$")])
        self.assertIn("body", schema["properties"])
        self.assertIn("match", schema["properties"])


def profile_name(model):
    return draft.profile_for(model)["name"]


if __name__ == "__main__":
    unittest.main()


class RepairTest(unittest.TestCase):
    """Format faults are fixed; semantic ones stay rejections.

    The line matters: a repair that guesses at meaning turns a candidate the
    gate would have caught into one that passes while claiming something the
    engine cannot check.
    """

    def test_kebab_cases_an_id(self):
        fixed, notes = draft.repair({"id": "Cat_Needs_A File"})
        self.assertEqual(fixed["id"], "cat-needs-a-file")
        self.assertTrue(any("id" in n for n in notes))

    def test_leaves_a_conforming_id_alone(self):
        fixed, notes = draft.repair({"id": "cat-needs-a-file"})
        self.assertEqual(fixed["id"], "cat-needs-a-file")
        self.assertEqual([n for n in notes if "id" in n], [])

    def test_strips_backticks_but_not_the_words_in_them(self):
        fixed, _ = draft.repair({"id": "x", "body": "Which command lists a folder -- `ls`?"})
        self.assertEqual(fixed["body"], "Which command lists a folder -- ls?")

    def test_backtick_repair_does_not_smuggle_a_runnable_line_past_no_do(self):
        # Stripping the quoting must not be a way to launder "use `cd rocks`".
        # repair only removes the marks; the gate still sees the verb and the
        # argument sitting next to each other.
        fixed, _ = draft.repair({"id": "x", "body": "Try `cd rocks` instead."})
        self.assertIn("cd rocks", fixed["body"])

    def test_coerces_a_numeric_string_count(self):
        fixed, _ = draft.repair({"id": "x", "requires": {"argv_count": "0"}})
        self.assertEqual(fixed["requires"]["argv_count"], 0)

    def test_keeps_an_unknown_decorator_so_the_gate_can_reject_it(self):
        fixed, _ = draft.repair({"id": "x", "requires": {"invented_thing": True}})
        self.assertEqual(fixed["requires"], {"invented_thing": True})

    def test_drops_an_unknown_top_level_field(self):
        fixed, notes = draft.repair({"id": "x", "explanation": "why I wrote this"})
        self.assertNotIn("explanation", fixed)
        self.assertTrue(any("explanation" in n for n in notes))

    def test_defaults_only_what_is_absent(self):
        fixed, _ = draft.repair({"id": "x", "min_strike": 5})
        self.assertEqual(fixed["min_strike"], 5)
        self.assertEqual(fixed["ttl_ms"], 14000)

    def test_drops_input_metadata_echoed_into_match(self):
        fixed, notes = draft.repair(
            {"id": "x", "match": {"command": "ls", "status": "Not_Found",
                                  "concept": "the name does not exist here",
                                  "has_target": True}})
        self.assertEqual(fixed["match"], {"command": "ls", "status": "Not_Found"})
        self.assertEqual(len([n for n in notes if "match." in n]), 2)

    def test_keeps_stderr_in_match_because_the_schema_knows_it(self):
        fixed, _ = draft.repair({"id": "x", "match": {"command": "ls", "stderr": "no such"}})
        self.assertEqual(fixed["match"]["stderr"], "no such")

    def test_drops_input_metadata_echoed_into_requires(self):
        fixed, notes = draft.repair({"id": "x", "requires": {"has_target": False}})
        self.assertEqual(fixed["requires"], {})
        self.assertTrue(any("requires.'has_target'" in n for n in notes))

    def test_still_keeps_an_invented_decorator_for_the_gate(self):
        # The copy may be leaning on it, so this one is not ours to delete.
        fixed, _ = draft.repair({"id": "x", "requires": {"cwd_smells_nice": True}})
        self.assertEqual(fixed["requires"], {"cwd_smells_nice": True})

    def test_defaults_min_strike_to_the_tier_being_drafted(self):
        fixed, _ = draft.repair({"id": "x"}, min_strike=5)
        self.assertEqual(fixed["min_strike"], 5)

    def test_does_not_overwrite_a_min_strike_the_model_chose(self):
        fixed, _ = draft.repair({"id": "x", "min_strike": 7}, min_strike=5)
        self.assertEqual(fixed["min_strike"], 7)
