"""Environment-backed configuration. Loaded once at import, validated eagerly."""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

from .bunny_token import HARD_MAX_TTL


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    # --- Bunny ---
    bunny_cdn_hostname: str = ""
    bunny_token_key: str = ""
    bunny_library_id: str = ""

    # --- Token policy ---
    token_ttl_seconds: int = 21600
    token_max_ttl_seconds: int = HARD_MAX_TTL
    token_bind_ip: bool = False
    token_directory_scope: bool = True

    # --- Referrer gating ---
    allowed_referrers: str = "localhost:8000,127.0.0.1:8000"
    require_referrer: bool = True

    # --- App auth ---
    # Turn the sign-in gate off entirely. Only honoured for requests arriving
    # from the loopback interface (see require_session in main.py), so it
    # cannot silently expose the library if the server is later bound to
    # 0.0.0.0 or put behind a tunnel.
    auth_disabled: bool = False
    app_password_hash: str = ""
    session_secret: str = ""
    session_ttl_seconds: int = 2592000
    session_cookie_secure: bool = False

    # --- Catalog ---
    catalog_path: Path = Path("data/catalog.json")
    buckets_config: Path = Path("config/buckets.yaml")

    @field_validator("bunny_cdn_hostname")
    @classmethod
    def _strip_scheme(cls, v: str) -> str:
        return v.replace("https://", "").replace("http://", "").strip().rstrip("/")

    @field_validator("token_max_ttl_seconds")
    @classmethod
    def _cap_ttl(cls, v: int) -> int:
        # The 12h ceiling is policy, not configuration — a larger value is ignored.
        return min(v, HARD_MAX_TTL)

    @property
    def referrer_hosts(self) -> list[str]:
        """Allow-list as written, ports included — used for local header checks."""
        return [h.strip().lower() for h in self.allowed_referrers.split(",") if h.strip()]

    @property
    def effective_ttl(self) -> int:
        return min(self.token_ttl_seconds, self.token_max_ttl_seconds, HARD_MAX_TTL)

    def missing_required(self) -> list[str]:
        """Config the app cannot usefully run without. Reported at startup."""
        gaps = []
        if not self.bunny_cdn_hostname:
            gaps.append("BUNNY_CDN_HOSTNAME")
        if not self.bunny_token_key:
            gaps.append("BUNNY_TOKEN_KEY")
        if not self.auth_disabled:
            if not self.session_secret:
                gaps.append("SESSION_SECRET")
            if not self.app_password_hash:
                gaps.append("APP_PASSWORD_HASH")
        return gaps


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
