# Connector data access

GitHub: Slip reads issue and pull-request numbers, titles, descriptions, open/closed state, and merged state from GitHub App webhooks.

GitHub writes: Slip writes nothing to GitHub.

GitHub App permissions: Slip requests read-only **Issues** and read-only **Pull requests** repository permissions so GitHub can deliver the issue and pull-request webhook fields listed above, plus read-only **Metadata**, which GitHub Apps receive as a required base permission for repository identity.

Linear: Slip reads issue identifiers, titles, descriptions, and workflow-state types from Issue create and update webhooks.

Linear writes: Slip writes one comment containing an agent's completion summary to the corresponding Linear issue and makes no other Linear changes.

Linear OAuth scopes: Slip requests `read` to receive and identify issues and `comments:create` solely to create the completion-summary comment; it does not request `write` or `admin`.

Slip never sees source code, diffs, file contents, commit contents, or repository contents from either provider.
