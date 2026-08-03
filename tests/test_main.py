# tests/test_main.py
import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app

# Mark all tests in this file as async
pytestmark = pytest.mark.asyncio


async def test_health_check():
    """
    Tests the public health check endpoint.
    """
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_unauthorized_access(monkeypatch: pytest.MonkeyPatch):
    """
    Tests that protected endpoints require authentication.
    """
    monkeypatch.setattr("app.security.AUTH_BYPASS", False)
    async with AsyncClient(
        transport=ASGITransport(app=app), base_url="http://test"
    ) as ac:
        response = await ac.get("/api/test")
    assert response.status_code == 401


# Additional tests would include:
# - Database integration tests
# - Authorization engine tests
# - API endpoint tests with mocked authentication
# - Model validation tests
