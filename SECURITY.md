# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately with
GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Include steps to reproduce.
Expect an acknowledgement within a few working days.

## What this extension handles

- It reads the Claude Code OAuth access token from `~/.claude/.credentials.json` on the local machine.
- The only outbound network request is `GET https://api.anthropic.com/api/oauth/usage` with that
  token in the `Authorization` header. It never sends the token anywhere else, and it does not
  write the token to any file, log or IPC message.
- It does not refresh tokens. A token that is missing or nearly expired is simply not used.

If you suspect the token has been exposed, sign out and back in to Claude Code to rotate it,
then review `~/.claude/.credentials.json` permissions.
