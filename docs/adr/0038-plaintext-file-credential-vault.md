# ADR-0038: Plaintext File Credential Vault As A Selected Alternative

- Status: Confirmed by explicit user instruction ("不是有明文吗"); ADR-0023's Credential Manager route is retained, not deleted
- Date: 2026-11-05
- Related: ADR-0023, ADR-0025; C10; V1_BASELINE.md section 8

## Context

ADR-0023 selected Windows Credential Manager via Koffi (`CredReadW`/`CredWriteW`/
`CredDeleteW`/`CredFree`). That implementation exists but is gated behind
`gateValidated`, because G03 has never been verified on this host. Effectively the
project has no working credential storage, which blocks any real use.

The user asked to check what the reference projects actually do. I read the source
rather than relying on notes, and the result was decisive:

| Project | Windows storage | Encryption |
| --- | --- | --- |
| Claude Code | `primaryApiKey` inside `~/.claude.json` | none |
| OpenCode | SQLite `credential` table, `value` column is JSON | none |
| This project | Credential Manager | DPAPI |

Two specifics worth recording because they were assumed otherwise in earlier notes:

- Claude Code's `saveApiKey` only uses Keychain on `darwin`; on every other platform
  it writes the key into the config file. The `mode: 0o600` it passes is documented
  in its own comment as applying "only to new files", and is inert on Windows.
- OpenCode's `restrictToOwner` returns immediately on `win32`, with a comment that
  Windows relies on inherited profile ACLs. Its `plainTextStorage` writes
  `.credentials.json` with a literal warning string: `"Warning: Storing credentials
  in plaintext."`

So no reference project encrypts credentials on Windows. This project was stricter
than all of them, and that strictness was the thing blocking use.

## Decision

Add a plaintext file vault as a **second** implementation of the existing
`CredentialVault` port. Do not delete the Credential Manager adapter.

`adapters/windows/file-credential-vault.ts`:

- one `credentials.json` under the application data directory, never the workspace;
- an explicit `schemaVersion` and a typed entry list, so a future format change is
  visible rather than guessed;
- one file holds all purposes, but a reference name is bound to a single purpose:
  writing `shared` as both a provider and a search key is rejected, and a search
  secret cannot answer a provider lookup;
- writes go through a same-directory temporary file and a rename;
- restrictive permissions are attempted and a failure is **reported**
  (`permissionWarning()`), not silently swallowed the way a no-op `chmod` would be;
- a corrupt, oversized, unknown-version or malformed file returns
  `vault_unavailable` rather than behaving as "no keys configured". This matters:
  treating corruption as empty would silently drop every stored key and look like
  a configuration mistake.

## Accepted Risk, Stated Plainly

The secret is **plaintext on disk**. Specifically:

- any process running as the same Windows user can read it;
- backup and cloud-sync tools that walk the user profile will copy it;
- `0o600` is largely inert on NTFS, so the real protection is the profile ACL;
- this is weaker than Credential Manager, which encrypts with DPAPI.

The one mitigation this project has that the references do not: the C10 owned-key
exit guard still applies. Even with a readable key, it is still checked at model
context, tool output, attachment and diagnostic exits.

## Consequences

- The project can now store a Provider key without G03, which removes the blocker
  that made every real-use path unreachable.
- Two vault implementations exist with different guarantees. That is a deliberate
  cost of not deleting the stricter one; a caller must choose knowingly, and the
  choice should eventually be surfaced in configuration rather than hard-coded.
- Nothing wires the vault into the entry point yet. `lycwl` still runs the demo
  runtime and has no configuration screen.
- Credential Manager remains unvalidated. If G03 is later verified, switching back
  is a configuration change, not a rewrite.

## Reassessment Conditions

Revisit if the plaintext file causes a concrete incident, or once G03 is validated
and DPAPI storage becomes usable. Do not describe this vault as secure: it is
"not encrypted", and the ADR says so.
