# Local Keycloak

The local identity provider is imported from `import/autopilot-realm.json` and
is exposed only on `http://localhost:8080`. Runtime credentials and initial
persona passwords live in the ignored root `.env`; never copy them into source
files, screenshots, or shared logs.

Start the identity provider and application:

```powershell
docker compose up -d keycloak
docker compose up -d --build backend frontend
```

The imported realm is `autopilot`. It includes the governed HR roles and two
initial personas: Command Center Admin and Payroll Reviewer. Use Admin > Users
and Admin > Roles in the Command Center for later provisioning.

Keycloak imports a realm only when it does not already exist. Changing the JSON
does not mutate a running realm. Do not delete `keycloak_data` merely to apply a
change: that erases users, credentials, and identity history. Apply later
changes through the Admin UI/API or an explicit reviewed migration.

For shared or production deployments, replace all local credentials, use TLS,
restrict redirect origins, and move Keycloak from its development datastore to
a managed persistent database.
