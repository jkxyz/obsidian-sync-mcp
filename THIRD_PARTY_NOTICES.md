# Third-party notices

The GNU Affero General Public License in this repository applies only to original Obsidian Sync MCP code and documentation for which the project's copyright holders can grant that license. Dependencies and other third-party materials remain governed by their respective copyright and license terms.

## Obsidian Headless

The Container installs `obsidian-headless` from npm and invokes it as a separate command-line program. It is developed by Dynalist Inc. under the `obsidianmd` organization:

- Repository: <https://github.com/obsidianmd/obsidian-headless>
- npm package: <https://www.npmjs.com/package/obsidian-headless>
- Official documentation: <https://help.obsidian.md/sync/headless>

As of the pinned version 0.0.14, its package metadata declares `UNLICENSED` and its repository does not provide an open-source license. It is not licensed under this project's AGPL, and nothing in this repository grants permission to copy, redistribute, modify, or relicense it.

This project distributes source code and build instructions and does not publish prebuilt container images for third-party download. Anyone building, deploying, or redistributing an image containing Obsidian Headless is responsible for confirming that their use complies with Obsidian's applicable terms and permissions.

## Other dependencies

The runtime image also installs Git and Git LFS from Debian packages. They and other dependencies installed from npm retain their own licenses and notices. Refer to their published packages and source repositories for the controlling terms. Their inclusion does not change the license of this project's original code or cause third-party code to be relicensed under the AGPL.
