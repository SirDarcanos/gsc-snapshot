# Release gsc-snapshot

This guide separates account setup from the tag-driven release workflow. A maintainer performs the account setup. GitHub Actions verifies and publishes a tagged version.

## Human-owned prerequisites

Complete these steps before creating a release tag:

1. Confirm that `gsc-snapshot` exists on npm and that you have package write access. npm requires an existing package before you can configure a trusted publisher. If the package needs an initial registry bootstrap, follow npm's current package-creation process from a maintainer workstation. Do not put npm credentials in this repository or in a GitHub Actions secret.
2. Enable two-factor authentication on the npm maintainer account.
3. Create a GitHub environment named `npm` in `SirDarcanos/gsc-snapshot`. Add required reviewers or deployment protection rules if the repository plan supports them.
4. In the npm package settings, configure one GitHub Actions trusted publisher with these exact values:
   - Organization or user: `SirDarcanos`
   - Repository: `gsc-snapshot`
   - Workflow filename: `release.yml`
   - Environment: `npm`
   - Allowed action: `npm publish`
5. Restrict traditional token-based publishing in the npm package settings after trusted publishing works.
6. Protect release tags or restrict who can create them in GitHub.

The workflow uses a GitHub-hosted runner, Node.js 24, npm's OIDC exchange, and the `id-token: write` permission. It does not read an npm publishing token. Trusted publishing requires npm 11.5.1 or newer and Node.js 22.14.0 or newer; the release runner satisfies both requirements.

Google Cloud setup belongs to each person who runs `gsc-snapshot`. It has no role in publishing the npm package. See the ADC instructions in the [README](../README.md#set-up-google-credentials).

## Prepare a release

1. Start from a clean `main` branch after CI passes.
2. Choose the version according to the project's release policy.
3. Update `version` in both `package.json` and `package-lock.json` without creating a tag:

   ```sh
   npm version 1.0.0 --no-git-tag-version
   ```

4. Run the same checks as CI:

   ```sh
   npm ci
   npm run format:check
   npm run typecheck
   npm test
   npm pack --dry-run
   ```

5. Inspect the dry-run file list. It must contain the license, README, package manifest, executable runtime files, and source maps. It must not contain source files, tests, local snapshots, credentials, or repository-only scripts.
6. Commit the version change and merge it to `main`.

`npm pack --dry-run` does not publish or create a release.

## Publish from a version tag

Create an annotated tag whose value exactly matches `package.json#version`, then push that tag:

```sh
git tag -a v1.0.0 -m "Release v1.0.0"
git push origin v1.0.0
```

`.github/workflows/release.yml` runs only for tags matching `v*.*.*`. Before publishing, it installs from `package-lock.json`, checks formatting, type-checks, runs all tests, and performs a package dry run. It then rejects a tag that differs from the package version or still uses `0.0.0`.

The final step runs:

```sh
npm publish --access public --provenance
```

npm exchanges the workflow's OIDC identity for a short-lived publishing credential. Public packages from public repositories receive provenance that links the package to the workflow and source commit.

## Verify the release

After the workflow succeeds:

1. Open the package version on npm and confirm its provenance statement links to `SirDarcanos/gsc-snapshot` and `release.yml`.
2. Compare npm's file list with the reviewed `npm pack --dry-run` output.
3. Install the exact version in a temporary project and run `npx gsc-snapshot --url example.com`. It should reject the unsupported option on stderr and exit with status 1 without requesting Google credentials.
4. Create the GitHub release notes for the same tag if the project uses GitHub Releases.

Do not rerun the workflow against a version that npm already contains. npm package versions are immutable.
