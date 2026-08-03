"""Minimal, hardened Keycloak Admin REST client for local identity management."""

from __future__ import annotations

import asyncio
import os
import time
from typing import Any
from urllib.parse import quote

import httpx


SYSTEM_ROLES = {
    "admin",
    "user",
    "pending",
    "people_ops",
    "people_ops_payroll",
    "people_ops_confidential",
    "manager",
}


class KeycloakAdminError(RuntimeError):
    """Safe upstream error that never includes credentials or raw responses."""


class KeycloakAdminService:
    def __init__(self) -> None:
        self.server_url = os.getenv("KEYCLOAK_SERVER_URL", "").rstrip("/")
        self.realm = os.getenv("KEYCLOAK_REALM", "")
        self.client_id = os.getenv("KEYCLOAK_CLIENT_ID", "")
        self.client_secret = os.getenv("KEYCLOAK_CLIENT_SECRET", "")
        self._client = httpx.AsyncClient(timeout=httpx.Timeout(10.0))
        self._token: str | None = None
        self._token_expires_at = 0.0
        self._token_lock = asyncio.Lock()

    async def _access_token(self, force: bool = False) -> str:
        if not all((self.server_url, self.realm, self.client_id, self.client_secret)):
            raise KeycloakAdminError("Keycloak admin configuration is incomplete")
        if not force and self._token and time.monotonic() < self._token_expires_at:
            return self._token
        async with self._token_lock:
            if not force and self._token and time.monotonic() < self._token_expires_at:
                return self._token
            try:
                response = await self._client.post(
                    f"{self.server_url}/realms/{quote(self.realm)}/protocol/openid-connect/token",
                    data={
                        "grant_type": "client_credentials",
                        "client_id": self.client_id,
                        "client_secret": self.client_secret,
                    },
                )
                response.raise_for_status()
                payload = response.json()
            except (httpx.HTTPError, ValueError) as exc:
                raise KeycloakAdminError("Keycloak authentication failed") from exc
            self._token = str(payload["access_token"])
            self._token_expires_at = time.monotonic() + max(
                int(payload.get("expires_in", 60)) - 15, 5
            )
            return self._token

    async def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json: Any = None,
        expected: tuple[int, ...] = (200,),
    ) -> httpx.Response:
        url = f"{self.server_url}/admin/realms/{quote(self.realm)}/{path.lstrip('/')}"
        for attempt in range(2):
            token = await self._access_token(force=attempt == 1)
            try:
                response = await self._client.request(
                    method,
                    url,
                    params=params,
                    json=json,
                    headers={"Authorization": f"Bearer {token}"},
                )
            except httpx.HTTPError as exc:
                raise KeycloakAdminError("Keycloak request failed") from exc
            if response.status_code == 401 and attempt == 0:
                continue
            if response.status_code not in expected:
                raise KeycloakAdminError(
                    f"Keycloak rejected the operation ({response.status_code})"
                )
            return response
        raise KeycloakAdminError("Keycloak authentication failed")

    @staticmethod
    def _status(user: dict[str, Any], roles: list[str]) -> str:
        if not user.get("enabled", True):
            return "revoked"
        if "admin" in roles:
            return "admin"
        if "pending" in roles and "user" not in roles:
            return "pending"
        return "approved"

    async def get_user_roles(self, user_id: str) -> list[dict[str, Any]]:
        response = await self._request(
            "GET", f"users/{quote(user_id)}/role-mappings/realm/composite"
        )
        return response.json()

    async def _with_roles(self, user: dict[str, Any]) -> dict[str, Any]:
        roles = [role["name"] for role in await self.get_user_roles(user["id"])]
        return {**user, "roles": roles, "status": self._status(user, roles)}

    async def get_users_count(self, search: str = "") -> int:
        params = {"search": search} if search else None
        response = await self._request("GET", "users/count", params=params)
        return int(response.json())

    async def get_users_with_roles(
        self, first: int = 0, max_results: int = 50, search: str = ""
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"first": first, "max": max_results}
        if search:
            params["search"] = search
        users = (await self._request("GET", "users", params=params)).json()
        return await asyncio.gather(*(self._with_roles(user) for user in users))

    async def get_all_users_with_roles_iter(self) -> list[dict[str, Any]]:
        users: list[dict[str, Any]] = []
        first = 0
        while True:
            page = await self.get_users_with_roles(first=first, max_results=100)
            users.extend(page)
            if len(page) < 100:
                return users
            first += 100

    async def get_user_by_id(self, user_id: str) -> dict[str, Any] | None:
        response = await self._request(
            "GET", f"users/{quote(user_id)}", expected=(200, 404)
        )
        return None if response.status_code == 404 else response.json()

    async def _create_user(
        self,
        *,
        email: str,
        password: str,
        first_name: str,
        last_name: str,
        temporary_password: bool,
        email_verified: bool,
    ) -> dict[str, Any]:
        payload = {
            "username": email,
            "email": email,
            "firstName": first_name,
            "lastName": last_name,
            "enabled": True,
            "emailVerified": email_verified,
            "credentials": [
                {
                    "type": "password",
                    "value": password,
                    "temporary": temporary_password,
                }
            ],
        }
        response = await self._request(
            "POST", "users", json=payload, expected=(201, 409)
        )
        if response.status_code == 409:
            raise KeycloakAdminError("A user with that email already exists")
        user_id = response.headers.get("Location", "").rstrip("/").split("/")[-1]
        if not user_id:
            raise KeycloakAdminError("Keycloak did not return the new user ID")
        return {"user_id": user_id, "email": email}

    async def create_user_by_admin(
        self,
        email: str,
        password: str,
        first_name: str,
        last_name: str,
        temporary_password: bool = True,
    ) -> dict[str, Any]:
        return await self._create_user(
            email=email,
            password=password,
            first_name=first_name,
            last_name=last_name,
            temporary_password=temporary_password,
            email_verified=True,
        )

    async def create_user(
        self,
        email: str,
        password: str,
        first_name: str,
        last_name: str,
        email_verified: bool = False,
    ) -> dict[str, Any]:
        result = await self._create_user(
            email=email,
            password=password,
            first_name=first_name,
            last_name=last_name,
            temporary_password=False,
            email_verified=email_verified,
        )
        await self.assign_role(result["user_id"], "pending")
        return {
            **result,
            "role": "pending",
            "requires_approval": True,
        }

    async def _set_enabled(self, user_id: str, enabled: bool) -> None:
        await self._request(
            "PUT",
            f"users/{quote(user_id)}",
            json={"enabled": enabled},
            expected=(204,),
        )

    async def disable_user(self, user_id: str) -> None:
        await self._set_enabled(user_id, False)

    async def enable_user(self, user_id: str) -> None:
        await self._set_enabled(user_id, True)

    async def delete_user(self, user_id: str) -> None:
        await self._request(
            "DELETE", f"users/{quote(user_id)}", expected=(204,)
        )

    async def reject_user(self, user_id: str, disable: bool = True) -> None:
        if disable:
            await self.disable_user(user_id)
        else:
            await self.delete_user(user_id)

    async def approve_user(self, user_id: str) -> None:
        await self.remove_role(user_id, "pending", missing_ok=True)
        await self.assign_role(user_id, "user")
        await self.enable_user(user_id)

    async def get_role_by_name(self, role_name: str) -> dict[str, Any] | None:
        response = await self._request(
            "GET", f"roles/{quote(role_name)}", expected=(200, 404)
        )
        return None if response.status_code == 404 else response.json()

    async def assign_role(self, user_id: str, role_name: str) -> None:
        role = await self.get_role_by_name(role_name)
        if not role:
            raise KeycloakAdminError("Role not found")
        await self._request(
            "POST",
            f"users/{quote(user_id)}/role-mappings/realm",
            json=[role],
            expected=(204,),
        )

    async def remove_role(
        self, user_id: str, role_name: str, missing_ok: bool = False
    ) -> None:
        role = await self.get_role_by_name(role_name)
        if not role:
            if missing_ok:
                return
            raise KeycloakAdminError("Role not found")
        await self._request(
            "DELETE",
            f"users/{quote(user_id)}/role-mappings/realm",
            json=[role],
            expected=(204,),
        )

    async def get_users_by_role(self, role_name: str) -> list[dict[str, Any]]:
        response = await self._request(
            "GET", f"roles/{quote(role_name)}/users", params={"max": 1000}
        )
        return response.json()

    async def get_role_users_count(self, role_name: str) -> int:
        return len(await self.get_users_by_role(role_name))

    async def get_roles_with_user_counts(self) -> list[dict[str, Any]]:
        roles = (await self._request("GET", "roles")).json()
        visible = [role for role in roles if not role["name"].startswith("default-roles-")]
        counts = await asyncio.gather(
            *(self.get_role_users_count(role["name"]) for role in visible)
        )
        return [{**role, "userCount": count} for role, count in zip(visible, counts)]

    async def create_role(self, name: str, description: str = "") -> None:
        await self._request(
            "POST",
            "roles",
            json={"name": name, "description": description},
            expected=(201, 204),
        )

    async def update_role(self, role_name: str, description: str) -> None:
        role = await self.get_role_by_name(role_name)
        if not role:
            raise KeycloakAdminError("Role not found")
        await self._request(
            "PUT",
            f"roles/{quote(role_name)}",
            json={**role, "description": description},
            expected=(204,),
        )

    async def delete_role(self, role_name: str) -> None:
        if role_name in SYSTEM_ROLES:
            raise KeycloakAdminError("System roles cannot be deleted")
        await self._request(
            "DELETE", f"roles/{quote(role_name)}", expected=(204,)
        )

    async def reset_user_password(
        self, user_id: str, new_password: str, temporary: bool = True
    ) -> None:
        await self._request(
            "PUT",
            f"users/{quote(user_id)}/reset-password",
            json={"type": "password", "value": new_password, "temporary": temporary},
            expected=(204,),
        )


keycloak_admin = KeycloakAdminService()
