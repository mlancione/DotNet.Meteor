.NET Meteor (Local) 6.3.7 updates mobile debugging and keeps the existing extension ID and launch configurations.

- Mobile debugging defaults to CoreCLR and prefers a declared .NET 11+ target on first selection. Saved selections are preserved; Mono is still available for compatible targets.
- Bundles clrdbg 18.1.0 and its matching transport, with updated checksum and package provenance checks.
- Microsoft iOS simulator debugging follows C# Dev Kit v2's active configuration and validates the SDK and build outputs. Legacy C# Dev Kit remains supported.
- Debugger-attached C# Hot Reload did not apply edits in the tested Dev Kit v2 prerelease combination on .NET 11 and Xcode 27.2 (ENC0097). That combination was verified for breakpoint debugging.

Disable official .NET Meteor in the VS Code profile using this fork. Download the VSIX for your OS and architecture below and use **Extensions: Install from VSIX**.
