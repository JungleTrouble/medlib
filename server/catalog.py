"""
In-memory catalog index.

Holds the output of `server.categorizer` and answers two questions the API
needs: "what's in the library" and "is this path something I am willing to
sign". The second one matters — the token endpoint only ever signs a path that
appears verbatim in the catalog, so a request cannot walk out of the library
with `../` or coax a signature for an arbitrary object on the pull zone.

The file is re-read when its mtime moves, so re-running the categorizer picks
up without a restart.
"""

from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any


class CatalogError(RuntimeError):
    pass


class Catalog:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()
        self._mtime: float = -1.0
        self._data: dict[str, Any] = {}
        self._by_id: dict[str, dict] = {}
        self._by_path: dict[str, dict] = {}

    # -- loading -----------------------------------------------------------

    def load(self, force: bool = False) -> None:
        with self._lock:
            if not self.path.exists():
                raise CatalogError(
                    f"{self.path} not found — run: python -m server.categorizer --root <library>"
                )
            mtime = self.path.stat().st_mtime
            if not force and mtime == self._mtime:
                return
            data = json.loads(self.path.read_text(encoding="utf-8"))
            items = data.get("items", [])
            self._data = data
            self._by_id = {i["id"]: i for i in items}
            self._by_path = {i["path"].lstrip("/"): i for i in items}
            self._mtime = mtime

    def refresh_if_stale(self) -> None:
        try:
            if not self.path.exists() or self.path.stat().st_mtime != self._mtime:
                self.load()
        except CatalogError:
            raise
        except OSError:
            pass

    # -- reads -------------------------------------------------------------

    @property
    def loaded(self) -> bool:
        return bool(self._by_id)

    @property
    def generated_at(self) -> str:
        return self._data.get("generated_at", "")

    @property
    def buckets(self) -> list[dict]:
        return self._data.get("buckets", [])

    @property
    def levels(self) -> list[str]:
        return self._data.get("levels", [])

    @property
    def tags(self) -> list[str]:
        return self._data.get("tags", [])

    @property
    def tag_facets(self) -> list[dict]:
        """Tags with labels and counts, rebuilt from the items by
        scripts/reconcile-bunny.mjs. Falls back to bare ids."""
        facets = self._data.get("tagFacets")
        if facets:
            return facets
        return [{"id": t, "label": t, "count": 0} for t in self.tags]

    @property
    def folders(self) -> list[dict]:
        """Nested folder tree mirroring the source library, for the Sources tab.
        Written by scripts/reconcile-bunny.mjs; absent until that has run."""
        return self._data.get("folders", [])

    @property
    def collections(self) -> list[dict]:
        """Source collections with their sections, for the sidebar's Source tab.
        Written by scripts/reconcile-bunny.mjs; absent until that has run."""
        return self._data.get("collections", [])

    @property
    def stats(self) -> dict:
        return self._data.get("stats", {})

    def get(self, key: str) -> dict | None:
        """Resolve by item id first, then by exact library-relative path."""
        return self._by_id.get(key) or self._by_path.get(key.lstrip("/"))

    def query(
        self,
        *,
        bucket: str | None = None,
        level: str | None = None,
        tags: list[str] | None = None,
        collection: str | None = None,
        section: str | None = None,
        folder: str | None = None,
        search: str | None = None,
        offset: int = 0,
        limit: int | None = None,
    ) -> tuple[list[dict], int]:
        rows = self._data.get("items", [])
        if bucket:
            rows = [r for r in rows if r["bucket"] == bucket]
        if level:
            rows = [r for r in rows if r.get("level") == level]
        if tags:
            # AND, not OR: each tag you add narrows the result. Picking
            # "pixorize" then "neurology" should mean both, which is what
            # anyone combining two filters expects.
            wanted = set(tags)
            rows = [r for r in rows if wanted.issubset(set(r.get("tags", [])))]
        if collection:
            rows = [r for r in rows if r.get("collection") == collection]
        if section:
            rows = [r for r in rows if r.get("section") == section]
        if folder:
            # Prefix match on the folder path, on a separator boundary so
            # "Sketchy/Micro" cannot also pull in "Sketchy/Microbiology".
            prefix = folder.rstrip("/")
            rows = [
                r for r in rows
                if (f := r.get("folder", "")) == prefix or f.startswith(prefix + "/")
            ]
        if search:
            needle = search.lower().strip()
            if needle:
                rows = [
                    r for r in rows
                    if needle in r["title"].lower()
                    or needle in r.get("path", "").lower()
                    or any(needle in t for t in r.get("tags", []))
                ]
        total = len(rows)
        if offset:
            rows = rows[offset:]
        if limit is not None:
            rows = rows[:limit]
        return rows, total
