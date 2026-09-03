# DSH 0.1.2 compatibility

Alpha 4.24 targets DSH `0.1.2-alpha.5` from the public npm registry and its declared pi-ai range `^0.84.2`; the verified registry installation resolves pi-ai `0.84.4`. The public compatibility record lists this exact pair while retaining Alpha 4.23 for DSH `0.1.2-alpha.2` and Alpha 4.21 for DSH `0.1.1-rc.2`.

On 2026-09-02 the npm `alpha` tag points to DSH `0.1.2-alpha.5`, while the newest upstream GitHub release remains `dsh-v0.1.2-alpha.4`, so no upstream tag commit is recorded for alpha.5. Alpha 4.24 advances the released compatibility baseline to the registry package set and records the exact pair in `verified-compatibility.json`.

## Changes

- Import client contracts from Cordis, Session Controller, Settings, Store, and Renderer instead of the removed client-runtime package.
- Keep the existing settings slots and session actions. Remove the obsolete close-label prop from the headless Modal; the gallery still owns its labeled close button.
- Adapt tool-call identifiers, card fixtures, and standard UI props to the new APIs. Settings fixtures fail if an unimplemented batch mutation is called.
- Verify image preview bytes against their normalized attachment metadata while retaining exact original-byte equality. Preview codec and raster rounding belong to DSH.
- Move the development dependency pair, diagnostic hints, installation check, and scheduled declared-version check together. The alpha.5 packages require no additional plugin API source adaptation beyond the existing alpha.4 changes. Preserve SSE, OAuth behavior, the verified-release catalog, and production configuration.

## Registry validation

The public npm packages at `0.1.2-alpha.2` support a registry-only lockfile and a clean frozen installation. `pnpm run check` passes 410 tests, `pnpm run test:browser` passes 12 tests, and `pnpm run check:dsh-install` installs the published DSH CLI into an isolated environment, preserves the default model and Web configuration, registers seven Codex models, and verifies provider disposal.

The lockfile contains no local links, workspace overrides, tarball references, or Git dependencies. The installed-runtime check resolves Host packages from the isolated DSH installation and the plugin from the profile, matching the ownership split introduced by the upstream peer-dependency changes.

For the Alpha 4.24 / alpha.5 release baseline, the registry-only lockfile and clean frozen installation pass. `pnpm run check` passes 460 tests and validates 41 packed files, `pnpm run test:browser` passes 16 tests, and `pnpm run check:dsh-install` installs DSH `0.1.2-alpha.5`, preserves default configuration, registers seven reasoning-capable Codex models, and verifies provider disposal. These keyless checks support the released compatibility record but do not replace real profile acceptance.

## Release evidence

1. The Alpha 4.24 / alpha.5 baseline has registry-only installation, automated runtime, browser, Windows, dependency-review, and CodeQL evidence.
2. The 2026-08-31 isolated full Web, OAuth, model, image, download, and network-authentication acceptance applies to Alpha 4.22 / DSH `0.1.2-alpha.2`; it is not fresh authenticated-profile evidence for alpha.5.
3. Alpha 4.24 is the selected plugin release version for DSH `0.1.2-alpha.5`, and the repository compatibility record currently classifies that pair from the keyless evidence above. Fresh authenticated alpha.5 profile acceptance remains required before treating the record as live-service validation. Merge, GitHub/npm publication, and npm dist-tag changes remain separately controlled release operations.

## Review concern

Registry installation and keyless runtime checks do not replace real authenticated browser acceptance. Until fresh alpha.5 profile acceptance is recorded, the Alpha 4.24 pairing is keyless-verified only. No dependency test is skipped or made to report success for an unavailable package.
