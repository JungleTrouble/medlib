"""
Run with:  python -m pytest tests -q      (pip install pytest)

Covers the parts that fail silently in production: TTL policy, token scope,
signature stability, and the categorizer's tier precedence. The one thing these
cannot prove is that Bunny's edge accepts the token — that needs a live request
against the pull zone (see test_smoke_against_edge, skipped by default).
"""

from __future__ import annotations

import os
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from server.bunny_token import (
    HARD_MAX_TTL,
    TokenError,
    clamp_ttl,
    directory_scope_for,
    sign_bunny_url,
    sign_hmac_url,
    verify_bunny_token,
    verify_hmac_url,
)
from server.categorizer import BucketConfig, Categorizer, build_catalog, MediaItem

KEY = "test-security-key-do-not-use"
BASE = "https://vz-example.b-cdn.net/abc123/playlist.m3u8"
NOW = 1_700_000_000


# --------------------------------------------------------------------------
#  TTL policy
# --------------------------------------------------------------------------


def test_ttl_never_exceeds_twelve_hours():
    assert clamp_ttl(999_999) == HARD_MAX_TTL
    assert clamp_ttl(999_999, configured_max=999_999) == HARD_MAX_TTL


def test_ttl_respects_a_lower_configured_ceiling():
    assert clamp_ttl(HARD_MAX_TTL, configured_max=3600) == 3600


def test_ttl_has_a_floor():
    assert clamp_ttl(1) == 60


def test_signed_url_ttl_is_clamped_end_to_end():
    signed = sign_bunny_url(BASE, KEY, ttl=24 * 3600, now=NOW)
    assert signed.ttl == HARD_MAX_TTL
    assert signed.expires == NOW + HARD_MAX_TTL


def test_missing_key_is_refused():
    with pytest.raises(TokenError):
        sign_bunny_url(BASE, "", now=NOW)


def test_relative_url_is_refused():
    with pytest.raises(TokenError):
        sign_bunny_url("/abc123/playlist.m3u8", KEY, now=NOW)


# --------------------------------------------------------------------------
#  Bunny signature
# --------------------------------------------------------------------------


def test_roundtrip_verifies():
    signed = sign_bunny_url(BASE, KEY, ttl=3600, now=NOW)
    assert verify_bunny_token(signed.url, KEY, now=NOW)


def test_wrong_key_fails_verification():
    signed = sign_bunny_url(BASE, KEY, ttl=3600, now=NOW)
    assert not verify_bunny_token(signed.url, "some-other-key", now=NOW)


def test_expired_token_fails_verification():
    signed = sign_bunny_url(BASE, KEY, ttl=3600, now=NOW)
    assert not verify_bunny_token(signed.url, KEY, now=NOW + 3601)


def test_tampered_path_fails_verification():
    signed = sign_bunny_url(BASE, KEY, ttl=3600, now=NOW)
    tampered = signed.url.replace("/abc123/", "/someone-elses-video/")
    assert not verify_bunny_token(tampered, KEY, now=NOW)


def test_signature_is_deterministic():
    a = sign_bunny_url(BASE, KEY, ttl=3600, now=NOW)
    b = sign_bunny_url(BASE, KEY, ttl=3600, now=NOW)
    assert a.token == b.token


def test_caller_supplied_token_is_discarded_not_trusted():
    poisoned = f"{BASE}?token=attacker&expires=99999999999"
    signed = sign_bunny_url(poisoned, KEY, ttl=3600, now=NOW)
    q = parse_qs(urlsplit(signed.url).query)
    assert q["token"] == [signed.token]
    assert q["expires"] == [str(NOW + 3600)]


def test_path_style_tokens_omit_token_path():
    # A path-style token carries its scope in the path it signed, so sending
    # token_path as well makes the edge 403 — verified live. Query-style
    # tokens do need the parameter. HLS depends on the path form: players
    # resolve "360p/video.m3u8" relative to the master and do not copy the
    # parent's query string, so a query token dies at the first variant.
    scope = directory_scope_for("vid/playlist.m3u8")

    as_path = sign_bunny_url(BASE, KEY, ttl=3600, now=NOW, path_allowed=scope, is_directory=True)
    assert "token_path" not in as_path.url
    assert "/bcdn_token=" in as_path.url

    as_query = sign_bunny_url(BASE, KEY, ttl=3600, now=NOW, path_allowed=scope)
    assert "token_path" in as_query.url


def test_only_documented_bunny_parameters_are_emitted():
    # Bunny accepts exactly these token parameters. An earlier version also
    # sent `token_referer`; the edge does not recognise it and answered 403 to
    # every signed URL, while this suite stayed green because it verified our
    # signatures against our own implementation. Referrer restriction is a pull
    # zone setting, not a token field.
    supported = {
        "token", "expires", "token_path", "token_countries",
        "token_countries_blocked", "token_ignore_params", "limit",
    }
    signed = sign_bunny_url(
        BASE, KEY, ttl=3600, now=NOW,
        path_allowed="/vid/",
        countries_allowed=["US"],
        countries_blocked=["CN"],
    )
    emitted = set(parse_qs(urlsplit(signed.url).query))
    assert emitted <= supported, f"unsupported token parameters: {emitted - supported}"
    assert verify_bunny_token(signed.url, KEY, now=NOW)


def test_ip_binding_changes_the_signature():
    a = sign_bunny_url(BASE, KEY, ttl=3600, now=NOW, user_ip="203.0.113.7")
    b = sign_bunny_url(BASE, KEY, ttl=3600, now=NOW, user_ip="198.51.100.4")
    assert a.token != b.token
    assert verify_bunny_token(a.url, KEY, user_ip="203.0.113.7", now=NOW)
    assert not verify_bunny_token(a.url, KEY, user_ip="198.51.100.4", now=NOW)


def test_directory_token_covers_sibling_segments():
    scope = directory_scope_for("abc123/playlist.m3u8")
    assert scope == "/abc123/"
    signed = sign_bunny_url(BASE, KEY, ttl=3600, now=NOW, path_allowed=scope)
    assert signed.scope == "/abc123/"
    assert "token_path=%2Fabc123%2F" in signed.url or "token_path=/abc123/" in signed.url
    # The segment URL carries the same token because the signature covers the
    # directory, not the individual object.
    segment = signed.url.replace("playlist.m3u8", "seg-0042.ts")
    assert verify_bunny_token(segment, KEY, now=NOW)


def test_root_level_object_gets_no_directory_scope():
    # A "/" scope would authorise the whole pull zone; the helper refuses.
    assert directory_scope_for("lecture.mp4") is None
    assert directory_scope_for("/lecture.mp4") is None


def test_path_style_directory_token():
    signed = sign_bunny_url(BASE, KEY, ttl=3600, now=NOW, is_directory=True)
    assert "/bcdn_token=" in signed.url
    assert urlsplit(signed.url).query == ""


def test_token_is_url_safe_base64():
    for i in range(50):
        signed = sign_bunny_url(f"{BASE}?v={i}", KEY, ttl=3600, now=NOW)
        assert not set(signed.token) & set("+/=")


# --------------------------------------------------------------------------
#  Generic HMAC mode
# --------------------------------------------------------------------------


def test_hmac_roundtrip():
    signed = sign_hmac_url(BASE, KEY, ttl=600, now=NOW)
    assert verify_hmac_url(signed.url, KEY, now=NOW)
    assert not verify_hmac_url(signed.url, KEY, now=NOW + 601)


def test_hmac_field_framing_is_unambiguous():
    """Newline framing keeps a digit-trailing path from blurring into expires."""
    a = sign_hmac_url("https://h/x/1", KEY, ttl=600, now=NOW)
    b = sign_hmac_url("https://h/x/", KEY, ttl=600, now=NOW)
    assert a.token != b.token


# --------------------------------------------------------------------------
#  Categorizer
# --------------------------------------------------------------------------


@pytest.fixture(scope="module")
def cfg() -> BucketConfig:
    return BucketConfig.load(Path("config/buckets.yaml"))


@pytest.fixture(scope="module")
def cat(cfg) -> Categorizer:
    return Categorizer(cfg)


def test_config_loads_and_validates(cfg):
    assert cfg.default_bucket in cfg.buckets
    assert cfg.keyword_scanners


@pytest.mark.parametrize(
    "title,bucket,rule",
    [
        ("007 - General Topics - Informed Consent.mp4", "publichealth", "pattern:numbered-section"),
        ("014 - Arrhythmias - Atrial Fibrillation.mp4", "cardiology", "pattern:numbered-section"),
        ("Cardio_014 - Preload and Afterload.mp4", "cardiology", "prefix"),
        ("Histo - Cardiac Muscles - ATF.mp4", "histology", "prefix"),
        ("Understanding Sickle Cell Anemia.mp4", "heme", "keyword"),
        ("zzz nothing recognisable here.mp4", "uncategorized", "default"),
    ],
)
def test_tier_precedence(cat, title, bucket, rule):
    a = cat.categorize(title)
    assert (a.bucket, a.rule) == (bucket, rule)


def test_shipped_config_has_no_guessed_numeric_rules():
    """
    Regression guard. Numeric prefixes and ranges were originally populated with
    a plausible-looking scheme; on the real library that filed 355 files under
    "anatomy" purely for starting with "01 " ("01 Acute Leukemia" is not
    anatomy). They stay empty until someone maps their own numbering.
    """
    cfg = BucketConfig.load(Path("config/buckets.yaml"))
    assert cfg.ranges == []
    assert not [p for p in cfg.prefixes if p.isdigit()]


# -- numeric tiers, against a fixture that actually enables them --------------


@pytest.fixture(scope="module")
def numeric_cat() -> Categorizer:
    return Categorizer(BucketConfig.load(Path("tests/fixtures/numeric_buckets.yaml")))


@pytest.mark.parametrize(
    "title,bucket,rule",
    [
        ("01_Introduction to the Upper Limb.mp4", "anatomy", "prefix"),
        ("02 Membrane Transport.mp4", "physiology", "prefix"),
        ("230-Beta Blockers and Their Uses.mp4", "pharmacology", "range"),
        ("275 - Gram Negative Rods.mp4", "microbiology", "range"),
        ("Cardio_004 - Heart Failure.mp4", "cardiology", "prefix"),
    ],
)
def test_numeric_tiers(numeric_cat, title, bucket, rule):
    a = numeric_cat.categorize(title)
    assert (a.bucket, a.rule) == (bucket, rule)


def test_structured_title_does_not_fall_into_a_numeric_range(numeric_cat):
    """
    "220 - Other - Bacteria" has the section shape, so 220 is a section index,
    not a lecture number. It must not be read by the range tier (which would
    say pharmacology); keyword scoring should decide.
    """
    a = numeric_cat.categorize("220 - Other - Bacteria and Their Shapes.mp4")
    assert (a.bucket, a.rule) == ("microbiology", "keyword")


def test_section_label_beats_keywords(cat):
    # "Breast" is an obgyn section label even though the title mentions cancer.
    a = cat.categorize("112 - Breast - Breast Cancer Screening.mp4")
    assert a.bucket == "obgyn"


def test_other_topics_section_falls_through_to_keywords(cat):
    a = cat.categorize("088 - Other Topics - Diabetic Ketoacidosis.mp4")
    assert a.bucket == "endocrine"
    assert a.rule == "keyword"


def test_parent_directory_is_a_fallback(cat):
    a = cat.categorize("Lecture 3.mp4", parent="Neuro")
    assert a.bucket == "neurology"
    assert a.rule.endswith("@parent")


def test_extension_is_not_matched_as_a_keyword(cat):
    plain = cat.categorize("Random Lecture")
    with_ext = cat.categorize("Random Lecture.mp4")
    assert plain.bucket == with_ext.bucket


@pytest.mark.parametrize("title,bucket", [("1. Skin", "dermatology"), ("3. Gout", "rheumatology")])
def test_short_word_after_a_dot_is_not_eaten_as_an_extension(cat, title, bucket):
    """
    "1. Skin" splits into stem "1" + suffix " Skin", which is short enough to
    look like an extension by length alone. Stripping it discarded the only
    categorizable word in the title.
    """
    assert cat.categorize(title).bucket == bucket


def test_manual_overrides_are_never_recomputed(cfg):
    items = [MediaItem(id="x1", title="Cardio_001 - Something.mp4", path="a/b.mp4")]
    catalog = build_catalog(
        items, cfg, overrides={"x1": {"category": "psychiatry", "level": "Clinical", "tags": ["mine"]}}
    )
    row = catalog["items"][0]
    assert row["bucket"] == "psychiatry"
    assert row["confidence"] == "manual"
    assert catalog["stats"]["manual_overrides"] == 1


def test_auto_entries_are_recomputed(cfg):
    items = [MediaItem(id="x1", title="Cardio_001 - Something.mp4", path="a/b.mp4")]
    catalog = build_catalog(items, cfg, overrides={"x1": {"_auto": True, "category": "psychiatry"}})
    assert catalog["items"][0]["bucket"] == "cardiology"


def test_catalog_shape(cfg):
    items = [
        MediaItem(id=f"i{n}", title=f"{n:03d}-Beta Blockers.mp4", path=f"pharm/{n}.mp4")
        for n in range(200, 210)
    ]
    catalog = build_catalog(items, cfg)
    assert catalog["count"] == 10
    assert {"generated_at", "buckets", "levels", "tags", "stats", "items"} <= catalog.keys()
    assert all(i["bucket"] == "pharmacology" for i in catalog["items"])


def test_scales_to_a_large_library(cfg):
    """4k titles should categorize in well under a second, not minutes."""
    import time as _t

    items = [
        MediaItem(id=f"i{n}", title=f"{n % 1000:03d} - Cardiology - Topic {n}.mp4",
                  path=f"x/{n}.mp4")
        for n in range(4000)
    ]
    start = _t.perf_counter()
    catalog = build_catalog(items, cfg)
    elapsed = _t.perf_counter() - start
    assert catalog["count"] == 4000
    assert elapsed < 10.0, f"categorizing 4000 titles took {elapsed:.1f}s"


# --------------------------------------------------------------------------
#  Live edge smoke test — opt in with MEDLIB_SMOKE=1
# --------------------------------------------------------------------------


@pytest.mark.skipif(os.getenv("MEDLIB_SMOKE") != "1", reason="set MEDLIB_SMOKE=1 to hit the CDN")
def test_smoke_against_edge():
    """
    The only test that proves the signature is actually correct. Point it at a
    real object with real credentials from .env:

        set MEDLIB_SMOKE=1 && set SMOKE_PATH=<guid>/playlist.m3u8
        python -m pytest tests -q -k smoke
    """
    import httpx

    from server.settings import get_settings

    s = get_settings()
    path = os.environ["SMOKE_PATH"].lstrip("/")
    url = f"https://{s.bunny_cdn_hostname}/{path}"

    unsigned = httpx.get(url, timeout=15)
    assert unsigned.status_code in (401, 403), (
        f"token authentication looks disabled on the pull zone (got {unsigned.status_code})"
    )

    signed = sign_bunny_url(
        url,
        s.bunny_token_key,
        ttl=300,
        path_allowed=directory_scope_for(path),
    )
    # The pull zone's own referrer allow-list gates this too, so send the same
    # Referer the browser will — ports included, exactly as configured.
    headers = {"Referer": f"http://{s.referrer_hosts[0]}/"} if s.referrer_hosts else {}
    res = httpx.get(signed.url, headers=headers, timeout=15)
    assert res.status_code == 200, f"edge rejected the signed URL: {res.status_code} {res.text[:200]}"
