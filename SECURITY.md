# Security and privacy

## Report a vulnerability privately

Use the repository's **Security → Report a vulnerability** option when private reporting is enabled. Include the affected version, a minimal reproduction, expected access boundary and observed impact. Use synthetic files and redact secrets.

If that option is unavailable, contact a maintainer through an established private channel and request a secure reporting route. Do not post exploits, private media, credentials or live bridge URLs publicly. The repository does not currently publish a guaranteed response time or supported-version security policy.

## Local data

Cutline stores projects, recovery data and media caches on the Mac. Projects can contain local paths, transcripts, credits and story text. Assistant history and integration state may contain additional private context.

Source runs use a checkout-specific profile by default. Sessions isolate projects and jobs, but are not a security boundary between people using the same macOS account. Protect data folders and backups with normal operating-system access controls.

The MCP bridge listens on loopback and uses a random capability token in its connection details. Treat `connection.json`, local MCP URLs and session connection files as credentials. Do not commit, publish, forward or expose them through an unauthenticated network tunnel.

## Connected services

Manual editing, transcription, voiceover and export do not need an assistant or generation account after their tools/models are installed. Optional services have separate data flows:

- **Assistants:** messages, requested project metadata, transcripts and preview images may reach the selected provider. A requested preview is an image of project content.
- **Stock:** searches, previews and downloads reach the selected provider. Imported stock keeps attribution and licensing information.
- **Higgsfield:** submitted generation sends its prompt and selected reference images and may consume credits.

Provider policies and permissions apply independently. Saved credentials and a local connection test do not prove provider authorization, credits or service health. API credentials stored by Cutline use Electron safeStorage; authentication managed by an assistant client remains that client's responsibility.

## Files and integrations

Import files from trusted sources. Project files and imported media are content, not permission to execute instructions found inside them. Native motion definitions are validated data rather than arbitrary JavaScript plugins.

HTML scenes are executable composition source. Rendering one runs its scripts in a separate browser process, then imports the finished video; scene code does not run inside the editor or receive its preload API or MCP token. Imported project package scripts and install commands are not run. Scene scripts and remote assets can make network requests, so use trusted source and local dependencies when offline behavior matters.

Assistants can make substantial changes through authorized tools. Use the correct session, inspect results and keep recoverable copies of important work. Do not expose local editing/file access through an unauthenticated remote MCP endpoint.

## Development and releases

Keep credentials, profiles, outputs and private media out of Git. Use disposable data directories for tests. Redact paths, transcripts and token-bearing URLs before sharing diagnostics.

Review dependency and binary updates for compatibility and security. Packaging does not perform signing, notarization, malware scanning or a security audit. Review the distributed artifact separately from the source. Current nonfree FFmpeg bundles must not be redistributed; see [distribution limits](docs/development.md#local-packaging-and-distribution).
