"""Minimal Airtable REST client for the reseeding utility (TASKS.md 3.1).

Uses Airtable's native `performUpsert` (PATCH .../records with
`performUpsert.fieldsToMergeOn`) so cross-run idempotency (DATA_FLOW.md §6: "re-running against the
same file twice does not create duplicate rows") is enforced server-side on the declared natural key,
rather than reimplemented as a fetch-then-diff loop here.

Retry profile is read from `config/policy_config.json`'s `retry` block (same config the live Operators
use, ARCHITECTURE.md §7 "never hardcoded") — reused here rather than re-guessed, since both cases are
"absorb Airtable rate limits and transient failures".
"""

from __future__ import annotations

import time
from typing import Sequence
from urllib.parse import quote

import requests

API_ROOT = "https://api.airtable.com/v0"
BATCH_SIZE = 10  # Airtable's per-request record limit for create/update/delete.


class AirtableError(RuntimeError):
    pass


def _chunks(items, size):
    for i in range(0, len(items), size):
        yield items[i : i + size]


class AirtableClient:
    def __init__(self, base_id: str, token: str, retry: dict | None = None, session=None):
        self.base_id = base_id
        self.token = token
        self.retry = retry or {"max_attempts": 3, "backoff_seconds": [5, 20, 60]}
        self.session = session or requests.Session()
        self.session.headers.update(
            {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
        )

    def _url(self, table: str) -> str:
        return f"{API_ROOT}/{self.base_id}/{quote(table, safe='')}"

    def _request(self, method: str, url: str, **kwargs) -> dict:
        backoffs = self.retry["backoff_seconds"]
        attempts = self.retry["max_attempts"]
        last_error = None
        for attempt in range(attempts):
            try:
                resp = self.session.request(method, url, timeout=30, **kwargs)
            except requests.RequestException as exc:
                last_error = str(exc)
            else:
                if resp.status_code < 300:
                    return resp.json() if resp.content else {}
                if resp.status_code == 429 or resp.status_code >= 500:
                    last_error = f"HTTP {resp.status_code}: {resp.text[:300]}"
                else:
                    raise AirtableError(f"HTTP {resp.status_code}: {resp.text[:500]}")
            if attempt < attempts - 1:
                time.sleep(backoffs[min(attempt, len(backoffs) - 1)])
        raise AirtableError(f"exhausted {attempts} attempts against {url}: {last_error}")

    def upsert_batch(self, table: str, key_field: str, field_rows: Sequence[dict]) -> list:
        """Upsert `field_rows` (each a flat {column: value} dict) into `table`, merging on
        `key_field`. Returns the Airtable records written."""
        written = []
        url = self._url(table)
        for chunk in _chunks(list(field_rows), BATCH_SIZE):
            if not chunk:
                continue
            body = {
                "performUpsert": {"fieldsToMergeOn": [key_field]},
                "typecast": True,
                "records": [{"fields": fields} for fields in chunk],
            }
            result = self._request("PATCH", url, json=body)
            written.extend(result.get("records", []))
            time.sleep(0.21)  # stay comfortably under Airtable's 5 req/sec per base
        return written

    def list_record_ids(self, table: str) -> list:
        ids = []
        url = self._url(table)
        params = {"fields[]": []}  # only need record IDs, not field data
        offset = None
        while True:
            if offset:
                params["offset"] = offset
            result = self._request("GET", url, params=params)
            ids.extend(r["id"] for r in result.get("records", []))
            offset = result.get("offset")
            if not offset:
                break
        return ids

    def delete_all(self, table: str) -> int:
        """Delete every record in `table`. Used only by --reset for `Cases & Audit Log`
        (DATA_FLOW.md §6: never the raw source tables unless explicitly requested)."""
        ids = self.list_record_ids(table)
        url = self._url(table)
        deleted = 0
        for chunk in _chunks(ids, BATCH_SIZE):
            params = [("records[]", rid) for rid in chunk]
            self._request("DELETE", url, params=params)
            deleted += len(chunk)
            time.sleep(0.21)
        return deleted
