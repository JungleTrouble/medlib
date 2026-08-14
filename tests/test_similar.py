"""
Covers the shaping either side of the two network hops.

The hops themselves are not mocked — a fake that returns what we already
believe Hugging Face returns proves nothing about Hugging Face. What is worth
pinning is the part that will silently produce wrong-but-plausible output:
the response shapes MiniLM comes back in, and the metadata key spellings the
index may or may not have been written with. Both fail as empty strings and
bad rankings rather than as errors.
"""

from __future__ import annotations

import math

import pytest

from server.similar import (
    SimilarityError,
    _as_vector,
    _first_str,
    _l2_normalize,
    shape_matches,
)


# --------------------------------------------------------------------------
#  Embedding shapes
# --------------------------------------------------------------------------


def test_pooled_vector_passes_through():
    assert _as_vector([1.0, 2.0, 3.0]) == [1.0, 2.0, 3.0]


def test_batch_of_one_is_unwrapped():
    assert _as_vector([[1.0, 2.0, 3.0]]) == [1.0, 2.0, 3.0]


def test_token_matrix_is_mean_pooled():
    # (1, 2 tokens, 3 dims) -> the mean of the two token vectors.
    assert _as_vector([[[0.0, 2.0, 4.0], [2.0, 4.0, 6.0]]]) == [1.0, 3.0, 5.0]


def test_ragged_dimensions_are_refused_not_averaged():
    with pytest.raises(SimilarityError):
        _as_vector([[1.0, 2.0], [1.0, 2.0, 3.0]])


def test_empty_response_is_refused():
    with pytest.raises(SimilarityError):
        _as_vector([])


def test_booleans_are_not_mistaken_for_a_vector():
    # bool is a subclass of int; without the guard [True, False] would embed.
    with pytest.raises(SimilarityError):
        _as_vector([True, False])


def test_normalisation_gives_a_unit_vector():
    vec = _l2_normalize([3.0, 4.0])
    assert math.isclose(math.sqrt(sum(x * x for x in vec)), 1.0)
    assert math.isclose(vec[0], 0.6)


def test_zero_vector_is_refused_rather_than_dividing_by_zero():
    with pytest.raises(SimilarityError):
        _l2_normalize([0.0, 0.0, 0.0])


# --------------------------------------------------------------------------
#  Metadata shaping
# --------------------------------------------------------------------------


def test_either_capitalisation_of_a_key_is_accepted():
    assert _first_str({"Title": "Botulism"}, "title", "Title") == "Botulism"
    assert _first_str({"title": "Botulism"}, "title", "Title") == "Botulism"


def test_first_non_empty_key_wins():
    assert _first_str({"title": "   ", "name": "Botulism"}, "title", "name") == "Botulism"


def test_missing_keys_give_an_empty_string_not_a_crash():
    assert _first_str({}, "title", "Title") == ""


def test_matches_are_shaped_to_id_title_category():
    rows = shape_matches([
        {"id": "abc", "score": 0.91234, "metadata": {"title": "Botulism", "category": "Micro"}},
    ])
    assert rows == [{"id": "abc", "title": "Botulism", "category": "Micro", "score": 0.9123}]


def test_a_match_with_no_id_is_dropped():
    assert shape_matches([{"score": 0.9, "metadata": {"title": "Orphan"}}]) == []


def test_catalogue_fills_gaps_in_index_metadata():
    lookup = {"abc": {"title": "Clostridium botulinum", "bucket": "Microbiology"}}.get
    rows = shape_matches([{"id": "abc", "metadata": {}}], lookup=lookup)
    assert rows[0]["title"] == "Clostridium botulinum"
    assert rows[0]["category"] == "Microbiology"


def test_index_metadata_beats_the_catalogue():
    # The indexed value is what was actually searched; the catalogue only
    # fills gaps, or a re-titled video would stop matching its own vector.
    lookup = {"abc": {"title": "Renamed since", "bucket": "Pathology"}}.get
    rows = shape_matches([{"id": "abc", "metadata": {"title": "As indexed"}}], lookup=lookup)
    assert rows[0]["title"] == "As indexed"
    assert rows[0]["category"] == "Pathology"


def test_an_unknown_id_survives_a_failed_lookup():
    rows = shape_matches([{"id": "ghost", "metadata": {}}], lookup=lambda _: None)
    assert rows == [{"id": "ghost", "title": "", "category": ""}]


def test_a_scoreless_match_omits_the_field_rather_than_faking_one():
    assert "score" not in shape_matches([{"id": "abc", "metadata": {"title": "X"}}])[0]
