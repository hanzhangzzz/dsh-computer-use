# dsh-tool-computer

Model-facing browser computer tools over `ctx.computer`, carrying this bundle's `cordis.patch.yml`.
The published bundle mounts the seam and the Playwright provider: it launches local Chrome or
attaches to a Chromium CDP endpoint. It does not include the repository's experimental native
macOS Accessibility provider (`packages/computer-macos`).
