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


if __name__ == "__main__":
    unittest.main()
