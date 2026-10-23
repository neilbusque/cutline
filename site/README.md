# Cutline website

The public landing page is https://neilbusque.github.io/cutline/.

This directory contains the complete static website. HTML, CSS, JavaScript and reviewed local media are sufficient; no framework build, account, analytics script or backend is required. The root application dependencies are not needed to serve it.

The dedicated Pages workflow publishes only this directory on changes to `site/` or `.github/workflows/pages.yml`. It does not package or distribute the Mac application. The application source release remains separate.

## Editing and checks

- Keep content readable without JavaScript and asset paths relative to this project URL.
- Preserve the canonical URL, social metadata, factual structured data, sitemap and caption track when editing.
- Preview at 1440 and 390 pixels; test navigation, FAQ, video controls/captions, keyboard focus and links.
- The MP4 loads only when requested. Keep its poster and dimensions in HTML to prevent layout shifts.
- Keep source-only release and macOS 15+ Apple Silicon requirements accurate. Do not invent app downloads, pricing, reviews or unrestricted dependency-license claims.

## Search indexing

The sitemap is https://neilbusque.github.io/cutline/sitemap.xml. It lists canonical public HTML pages only.

A project-level `/cutline/robots.txt` does not govern this GitHub Pages host. The authoritative robots file, if present, is at https://neilbusque.github.io/robots.txt. Do not change other sites or the account-level robots file as part of routine Cutline edits.

Submit the sitemap using an authorized Search Console property covering the URL prefix. Metadata and crawlability do not guarantee indexing or a particular ranking.
