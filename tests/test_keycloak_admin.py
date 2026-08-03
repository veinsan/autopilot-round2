from __future__ import annotations

import httpx
import pytest

from app.services.keycloak_admin import KeycloakAdminError, KeycloakAdminService


def configured_service(monkeypatch: pytest.MonkeyPatch) -> KeycloakAdminService:
    monkeypatch.setenv("KEYCLOAK_SERVER_URL", "http://keycloak.test")
    monkeypatch.setenv("KEYCLOAK_REALM", "autopilot")
    monkeypatch.setenv("KEYCLOAK_CLIENT_ID", "command-center")
    monkeypatch.setenv("KEYCLOAK_CLIENT_SECRET", "test-secret")
    return KeycloakAdminService()


def test_user_status_is_derived_from_enabled_and_governance_roles() -> None:
    assert KeycloakAdminService._status({"enabled": False}, ["admin"]) == "revoked"
    assert KeycloakAdminService._status({"enabled": True}, ["admin"]) == "admin"
    assert KeycloakAdminService._status({"enabled": True}, ["pending"]) == "pending"
    assert KeycloakAdminService._status({"enabled": True}, ["user"]) == "approved"


@pytest.mark.asyncio
async def test_service_account_token_is_cached(monkeypatch: pytest.MonkeyPatch) -> None:
    service = configured_service(monkeypatch)
    calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        assert request.url.path.endswith("/protocol/openid-connect/token")
        return httpx.Response(200, json={"access_token": "token-1", "expires_in": 60})

    await service._client.aclose()
    service._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        assert await service._access_token() == "token-1"
        assert await service._access_token() == "token-1"
        assert calls == 1
    finally:
        await service._client.aclose()


@pytest.mark.asyncio
async def test_keycloak_auth_failure_is_redacted(monkeypatch: pytest.MonkeyPatch) -> None:
    service = configured_service(monkeypatch)

    def handler(_: httpx.Request) -> httpx.Response:
        return httpx.Response(401, text="upstream-secret-details")

    await service._client.aclose()
    service._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    try:
        with pytest.raises(KeycloakAdminError) as rejected:
            await service._access_token()
        assert str(rejected.value) == "Keycloak authentication failed"
        assert "upstream-secret-details" not in str(rejected.value)
    finally:
        await service._client.aclose()


@pytest.mark.asyncio
async def test_system_role_cannot_be_deleted(monkeypatch: pytest.MonkeyPatch) -> None:
    service = configured_service(monkeypatch)
    try:
        with pytest.raises(KeycloakAdminError, match="System roles cannot be deleted"):
            await service.delete_role("people_ops_payroll")
    finally:
        await service._client.aclose()
