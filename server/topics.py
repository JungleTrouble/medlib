"""
Same-topic matching across publishers.

`/api/related` matches normalised *exact* titles, which is precise and narrow:
564 topics, 1,438 videos — one in five. It finds "Clostridium botulinum"
taught four times and never connects it to "Botulinum Toxin atf", because no
two publishers name a lesson the same way twice.

This closes that gap without embeddings, a model, or a network hop. Titles in
this library are dense with distinctive nouns — "Glycogen Storage Disease",
"Wolff-Parkinson-White" — so inverse document frequency does most of the work
that a sentence transformer would, and does it in a millisecond, offline, and
explainably: every match can name the words it matched on.

Cosine over IDF-weighted token sets, which is what stops the obvious failure
of shared-word matching. "Pulmonary Response to Exercise" and "Labeling
Exercise for Cranial Nerves" share a rare word and nothing else, so their
vectors barely overlap and the pair scores far below threshold.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict

_WORD = re.compile(r"[a-z0-9]+")

# Publisher names, upload noise and words that appear across the whole library
# carry no topic signal. Leaving them in makes every lecture look related to
# every other one.
STOP = frozenset("""
the a an and or of in on for to from at by is are was were be as it its with
part parts overview introduction intro summary review basics conclusion
commentary questions practice lecture video videos notes slides
atf converted copy final new old gold
sketchy bootcamp osmosis pixorize pathoma physeo boards beyond bnb
step usmle high yield shelf exam
""".split())

# A word in more than this share of the library is a category, not a topic.
# "disease" and "syndrome" would otherwise link half of medicine together.
_MAX_DF_RATIO = 0.04

# ...but a share is meaningless on a small collection: at 11 videos the ratio
# rounds to zero and every word looks like a category, which excludes the
# whole vocabulary. Below this many videos nothing is common enough to be one.
_MIN_DF_CAP = 25

# Below this, the two titles share a word by coincidence rather than subject.
_MIN_SCORE = 0.55

# One shared word has to carry both titles almost entirely to count.
# "Clostridium botulinum" -> "Botulinum Toxin" scores 0.76 on `botulinum`
# alone and is right; "Wolff-Parkinson-White" -> "Parkinson Disease" scores
# 0.46 on a surname collision and is not. Two shared words are enough
# evidence on their own, one has to be overwhelming.
_MIN_SCORE_SINGLE = 0.75

# Guards a pathological query — a title of nothing but common words would
# otherwise gather every posting list in the index.
_MAX_CANDIDATES = 4000


def tokens(title: str) -> list[str]:
    """Content words only: lowercase, no stopwords, nothing under four chars."""
    title = re.sub(r"\.(mp4|m4v|mkv|mov|webm|avi)$", "", title or "", flags=re.I)
    out = []
    for w in _WORD.findall(title.lower()):
        if len(w) < 4 or w in STOP or w.isdigit():
            continue
        out.append(w)
    return out


class TopicIndex:
    """
    An inverted index over title words, weighted by rarity.

    Built once per catalogue load. Lookup only ever scores the videos that
    share a rare word with the query, so it never touches most of the library.
    """

    def __init__(self, items: list[dict]):
        self.items = items
        self.postings: dict[str, list[int]] = defaultdict(list)
        self.vectors: list[dict[str, float]] = []
        self.norms: list[float] = []

        raw: list[list[str]] = []
        df: dict[str, int] = defaultdict(int)
        for item in items:
            ts = tokens(item.get("title", ""))
            raw.append(ts)
            for w in set(ts):
                df[w] += 1

        n = max(1, len(items))
        cap = max(_MIN_DF_CAP, int(n * _MAX_DF_RATIO))
        # Words kept for matching: rare enough to mean something, common
        # enough to appear twice.
        self.idf = {
            w: math.log(n / d)
            for w, d in df.items()
            if 2 <= d <= cap
        }

        for i, ts in enumerate(raw):
            vec: dict[str, float] = {}
            for w in set(ts):
                weight = self.idf.get(w)
                if weight:
                    vec[w] = weight
            self.vectors.append(vec)
            self.norms.append(math.sqrt(sum(v * v for v in vec.values())) or 1.0)
            for w in vec:
                self.postings[w].append(i)

        self.by_id = {item["id"]: i for i, item in enumerate(items)}

    def similar(
        self,
        video_id: str,
        *,
        limit: int = 8,
        cross_publisher_only: bool = True,
    ) -> list[tuple[dict, float, list[str]]]:
        """
        Videos on the same topic, best first.

        Returns each match with its score and the words it matched on, because
        a recommendation you cannot interrogate is one you cannot trust when
        it is wrong.
        """
        at = self.by_id.get(video_id)
        if at is None:
            return []

        query = self.vectors[at]
        if not query:
            return []

        here = self.items[at].get("collection", "")
        qnorm = self.norms[at]

        # Rarest words first: they carry the most signal and the shortest
        # posting lists, so the candidate set stays small.
        words = sorted(query, key=lambda w: -query[w])

        scores: dict[int, float] = defaultdict(float)
        seen: set[int] = set()
        for w in words:
            posting = self.postings.get(w, ())
            if len(seen) >= _MAX_CANDIDATES:
                break
            weight = query[w]
            for j in posting:
                if j == at:
                    continue
                scores[j] += weight * self.vectors[j].get(w, 0.0)
                seen.add(j)

        out: list[tuple[dict, float, list[str]]] = []
        for j, dot in scores.items():
            other = self.items[j]
            if cross_publisher_only and other.get("collection", "") == here:
                continue
            score = dot / (qnorm * self.norms[j])
            if score < _MIN_SCORE:
                continue
            shared = sorted(
                (w for w in query if w in self.vectors[j]),
                key=lambda w: -self.idf.get(w, 0),
            )
            if len(shared) < 2 and score < _MIN_SCORE_SINGLE:
                continue
            out.append((other, round(score, 3), shared[:4]))

        # Score first, then a stable tiebreak so the same query does not
        # reshuffle its own results between requests.
        out.sort(key=lambda row: (-row[1], row[0].get("title", "")))
        return out[:limit]
