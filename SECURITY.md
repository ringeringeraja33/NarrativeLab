# Security policy

## Supported versions

Security fixes are applied to the latest published NarrativeLab release. Users should update both Obsidian and NarrativeLab before reporting a problem that may already be resolved.

## Reporting a vulnerability

Do not open a public issue for a vulnerability that could expose vault data, execute code, bypass a confirmation, or damage files.

Use GitHub's **Security → Report a vulnerability** function for this repository. Include:

- NarrativeLab and Obsidian versions;
- operating system and device type;
- a minimal reproduction using non-sensitive sample files;
- expected and observed behavior;
- impact and whether the issue has been exploited;
- relevant logs or screenshots with private paths and content removed.

If private vulnerability reporting is unavailable, contact the maintainer through the repository profile without including exploit details in a public message.

You can expect an acknowledgement within seven days. A confirmed report will be investigated, assigned a severity, fixed on a private branch when appropriate, and disclosed after a release is available. Please allow reasonable time for remediation before public disclosure.

## Security model

NarrativeLab runs with the permissions granted to Obsidian community plugins. It can read and modify files in the active vault. The desktop-only Scrivener importer can also read a folder explicitly selected by the user.

NarrativeLab has no telemetry, advertising, account system, or remote-code loader. It only makes a network request when a user-authored document references a remote image and the user requests a render or export that needs that image.
