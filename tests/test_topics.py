"""
Same-topic matching.

The thresholds *are* the design here, so these are mostly precision tests:
the easy part is finding "Clostridium botulinum" four times, and the hard
part is not offering "Parkinson Disease" to someone watching
Wolff-Parkinson-White. Each case below is a real pair from the catalogue
that the first cut got wrong.
"""

from __future__ import annotations

import pytest

from server.topics import TopicIndex, tokens


def vid(i, title, collection, bucket="microbiology"):
    return {"id": f"v{i}", "title": title, "collection": collection,
            "bucket": bucket, "duration": "5:00", "folder": collection}


# --------------------------------------------------------------------------
#  Tokenising
# --------------------------------------------------------------------------


def test_publisher_names_are_not_topic_words():
    assert "sketchy" not in tokens("Sketchy Clostridium botulinum")
    assert "bootcamp" not in tokens("Clostridium Botulinum Bootcamp")


def test_upload_noise_is_dropped():
    assert tokens("Clostridium botulinum atf") == ["clostridium", "botulinum"]


def test_short_words_and_numbers_carry_no_signal():
    assert tokens("2.3 - The Big Toe") == []


def test_extension_is_not_a_word():
    assert "mp4" not in tokens("Tetralogy of Fallot.MP4")


# --------------------------------------------------------------------------
#  Matching
# --------------------------------------------------------------------------


@pytest.fixture
def library():
    rows = [
        vid(1, "Clostridium botulinum", "Sketchy"),
        vid(2, "Clostridium Botulinum atf", "Bootcamp"),
        vid(3, "Botulinum Toxin atf", "Pixorize"),
        vid(4, "Clostridium difficile", "Osmosis"),
        vid(5, "Wolff-Parkinson-White Syndrome", "Bootcamp", "cardiology"),
        vid(6, "Parkinson Disease atf", "Osmosis", "neurology"),
        vid(7, "Pulmonary Response to Exercise", "Sketchy", "pulmonology"),
        vid(8, "Labeling Exercise for Cranial Nerves", "Bootcamp", "anatomy"),
        vid(9, "Glycogen Storage Diseases", "Sketchy", "biochemistry"),
        vid(10, "Overview of Glycogen Storage Diseases", "Bootcamp", "biochemistry"),
        # Same publisher as v1 — must never be offered as an alternative.
        vid(11, "Clostridium botulinum revisited", "Sketchy"),
    ]
    return TopicIndex(rows), {r["id"]: r for r in rows}


def titles(index, vid_id):
    return [o["title"] for o, _s, _w in index.similar(vid_id)]


def test_the_same_publisher_is_never_an_alternative(library):
    index, _ = library
    assert "Clostridium botulinum revisited" not in titles(index, "v1")


def test_a_video_is_not_related_to_itself(library):
    index, _ = library
    assert "Clostridium botulinum" not in titles(index, "v1")


def test_matches_report_the_words_they_matched_on(library):
    index, _ = library
    rows = index.similar("v1")
    assert rows, "expected at least one match"
    for _other, _score, shared in rows:
        assert shared, "a match with no shared words cannot be explained"


def test_scores_come_back_ordered(library):
    index, _ = library
    scores = [s for _o, s, _w in index.similar("v1")]
    assert scores == sorted(scores, reverse=True)


def test_an_unknown_id_is_empty_not_an_error(library):
    index, _ = library
    assert index.similar("nope") == []


def test_a_title_of_only_stopwords_matches_nothing(library):
    index, rows = library
    lonely = TopicIndex(list(rows.values()) + [vid(99, "Part One Overview", "Osmosis")])
    assert lonely.similar("v99") == []


# --------------------------------------------------------------------------
#  Precision, against the real catalogue
#
#  These cannot be tested on a fixture. The thresholds are tuned against
#  inverse document frequency, and IDF over a dozen invented titles is
#  statistically meaningless — every word looks equally rare, so a single
#  coincidental match scores 1.0 and the fixture "proves" the opposite of
#  what production does. data/catalog.json is committed precisely so this
#  can be checked against the distribution the thresholds were chosen for.
# --------------------------------------------------------------------------


@pytest.fixture(scope="module")
def real():
    import json
    from pathlib import Path

    path = Path("data/catalog.json")
    if not path.exists():
        pytest.skip("data/catalog.json not present")
    items = json.loads(path.read_text(encoding="utf-8"))["items"]
    return TopicIndex(items), items


def find(items, needle):
    hit = next((i for i in items if needle.lower() in i["title"].lower()), None)
    if hit is None:
        pytest.skip(f"no video matching {needle!r} in this catalogue")
    return hit


def matches(index, items, needle, limit=8):
    return [o["title"] for o, _s, _w in index.similar(find(items, needle)["id"], limit=limit)]


def test_finds_the_same_lesson_under_another_name(real):
    index, items = real
    # The whole point. Exact-title matching cannot see this one.
    found = matches(index, items, "Clostridium botulinum")
    assert any("Botulinum Toxin" in t for t in found), found


def test_a_different_species_is_not_the_same_topic(real):
    index, items = real
    found = matches(index, items, "Clostridium botulinum")
    assert not any("difficile" in t.lower() for t in found), found


def test_a_shared_surname_is_not_a_shared_topic(real):
    index, items = real
    # Wolff-Parkinson-White is a conduction disorder; Parkinson's is not.
    found = matches(index, items, "Wolff-Parkinson-White")
    assert not any(t.lower().startswith("parkinson") for t in found), found


def test_one_incidental_shared_word_is_not_enough(real):
    index, items = real
    found = matches(index, items, "Pulmonary Response to Exercise")
    assert not any("Cranial Nerves" in t for t in found), found


def test_two_shared_content_words_are_enough(real):
    index, items = real
    found = matches(index, items, "Glycogen Storage Diseases")
    assert any("Glycogen Storage" in t for t in found), found


def test_reaches_far_more_than_exact_titles_did(real):
    index, items = real
    # Exact-title matching reached 1,438 of 7,333. Anything near that means
    # the thresholds have been tightened into uselessness.
    reach = sum(1 for i in items if index.similar(i["id"], limit=1))
    assert reach > len(items) * 0.4, f"only {reach} of {len(items)} reachable"
