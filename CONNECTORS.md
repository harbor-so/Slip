# Connector data access

GitHub: Harbor reads issue and pull-request numbers, titles, descriptions, open/closed state, and merged state from GitHub App webhooks.

GitHub writes: Harbor writes nothing to GitHub.

GitHub App permissions: Harbor requests read-only **Issues** and read-only **Pull requests** repository permissions so GitHub can deliver the issue and pull-request webhook fields listed above, plus read-only **Metadata**, which GitHub Apps receive as a required base permission for repository identity.

Linear: Harbor reads issue identifiers, titles, descriptions, and workflow-state types from Issue create and update webhooks.

Linear writes: Harbor writes one comment containing an agent's completion summary to the corresponding Linear issue and makes no other Linear changes.

Linear OAuth scopes: Harbor requests `read` to receive and identify issues and `comments:create` solely to create the completion-summary comment; it does not request `write` or `admin`.

Harbor never sees source code, diffs, file contents, commit contents, or repository contents from either provider.
