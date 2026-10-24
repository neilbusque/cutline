# Changes in 0.30.0

Cutline can now make high-quality vector graphics from a sentence, import far more real-world SVG files, and show the real logo or web page a video talks about.

## Generate a vector

Open **Motion → Vectors → Generate a vector**. Describe the graphic, choose a style (Flat, Line icon, Logo mark, Soft gradient or Badge) and a shape, and choose who draws it: **Claude** (the Claude Code you are signed in to) or **ChatGPT** (the Codex in the ChatGPT app). Cutline checks the drawing and, if something would be lost, sends the problem back once for a corrected version. A preview shows exactly what will be drawn; **Add to timeline** places it at the playhead as editable layers you can animate or give a logo reveal.

Nothing is sent anywhere except the description to the assistant you chose, under your own account.

## Real logos and pages

When a video names a product, show the product, not a card with its name typed on it.

- **Brand logos:** search a name (Claude, Cursor, Gemini, n8n…) and click it. Marks from the Simple Icons library arrive as editable vectors in the brand color, or white or black. Products the library does not carry, such as ChatGPT or LinkedIn, use the icon their own website publishes.
- **Page screenshot:** type a web address, such as a GitHub repository, choose Desktop or Phone and click **Capture and add**. The page is captured at 2× in a private window with no cookies; cookie banners and sign-in prompts are removed, and the shot is placed as a rounded card above the captions.

Assistants use the same feature through `cutline_reference`, and can capture one part of a page, such as a README (`selector: "article.markdown-body"`).

## Better SVG import

SVG files from Illustrator, Figma, Inkscape and AI tools now import as they look:

- Linear and radial gradients, including chained gradients and gradient transforms, render in preview and export.
- CSS classes in a `<style>` block, every CSS color form, `currentColor`, group opacity, `<use>` and `<symbol>`, nested `<svg>`, percentages and physical units.
- Up to 64 layers (was 24) and 64 KB per path (was 16 KB). Files with more shapes combine same-colored neighbors to fit.
- Text, embedded images, filters, masks and clipping paths are left out with a plain-language note instead of rejecting the whole file. Scripts and event handlers never reach the project.
- Stretched outlines import with an averaged width instead of failing.

See [Vector and logo workflow](vector-logo.md).
