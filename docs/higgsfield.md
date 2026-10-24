# Higgsfield pictures and video

Cutline's **Generate → Video** creates video assets using a user-supplied Higgsfield API key. **Generate → Graphic**, the default, draws graphics with Claude or ChatGPT on this Mac and uses Higgsfield only as the fallback for subjects too detailed to draw. The integration supports Seedance 2.0 from text, a starting image or reference images, and Kling 3.0 Standard from text. Completed clips are downloaded locally before they are imported into Cutline. The same key makes pictures for graphics too detailed to draw as vectors (see [Pictures for detailed graphics](#pictures-for-detailed-graphics-cutline-033)).

The provider contract below was checked against official documentation on **2026-10-12**. Documentation confirms the API shape; it does not confirm access, credits, or generation quality for a particular account. No paid generation was used to verify this document.

## Credentials and request boundary

Create a key at [Open Higgsfield](https://open.higgsfield.ai/api-keys). In Cutline, open **Settings → Pictures and video** (or **Open Settings** in Generate) and paste the complete copied credential; you do not need to split the key ID and secret. A saved key is not proof that authentication has succeeded.

Authenticated requests use `https://api.higgsfield.ai` and `Authorization: Key <complete-credential>`. Electron's main process owns provider calls and encrypted credential storage. The renderer receives credential status, never the saved key. A generation intentionally sends its prompt and, when selected, its starting image to Higgsfield.

Sources: [authentication](https://docs.higgsfield.ai/docs/authentication.md), [connection guidance](https://open.higgsfield.ai/quick-start).

## Selected model contracts

All model submissions are JSON `POST` requests. Build the body for the selected operation instead of forwarding all form fields: the Seedance schemas reject additional properties.

### Seedance 2.0 from text

Endpoint: `/bytedance/seedance-2.0/text-to-video`.

| Field | Contract |
| --- | --- |
| `prompt` | Required nonblank string. Schema minimum is one character; no maximum is published in the selected model schema. Cutline applies its own 5,000-character cap. |
| `duration` | Integer 4–15 seconds; provider default 5. |
| `resolution` | `480p`, `720p`, `1080p`, or `4k`; default `720p`. |
| `aspect_ratio` | `16:9`, `4:3`, `1:1`, `3:4`, `9:16`, or `21:9`; default `16:9`. |
| `generate_audio` | Boolean; provider default `true`. |

Source: [Seedance 2.0 text schema](https://docs.higgsfield.ai/docs/models/seedance-2/text-to-video.md).

### Seedance 2.0 from an image

Endpoint: `/bytedance/seedance-2.0/image-to-video`.

The required `image_url` is a publicly accessible media URL. `duration`, `resolution`, and `generate_audio` match the text operation. The provider allows an optional nonempty `prompt`; Cutline requires a prompt for its generation workflow. The provider also documents an optional `end_image_url`, which the initial Cutline interface does not expose.

**Do not send `aspect_ratio` for this operation.** Output framing follows the starting image. Local filesystem paths and `asset://` references are not valid provider inputs.

Source: [Seedance 2.0 image schema](https://docs.higgsfield.ai/docs/models/seedance-2/image-to-video.md).

### Kling 3.0 Standard from text

Endpoint: `/kling-video/v3.0/std/text-to-video`.

| Field | Contract used by Cutline |
| --- | --- |
| `prompt` | Nonblank, at most 2,500 characters. The provider says longer text is truncated. |
| `duration` | Integer 3–15 seconds; provider default 5. |
| `aspect_ratio` | `16:9`, `9:16`, or `1:1`; default `16:9`. |
| `sound` | `on` or `off`; mapped from Cutline's audio toggle. |
| `cfg_scale` | `0.5`. The API supports 0–1 in increments of 0.01. |
| `multi_shots` | `false` for this initial single-clip workflow. |

Kling's schema lists `prompt` without a required constraint or maximum, but its usage notes explicitly require a nonempty top-level prompt and set the 2,500-character limit. Cutline follows the stricter documented usage notes. This operation does not document a `resolution` input, so Cutline must not send one.

Source: [Kling 3.0 Standard text schema and usage notes](https://docs.higgsfield.ai/docs/models/kling-3/standard-text-to-video.md).

## Reference upload

1. Main process requests `POST /files/generate-upload-url` with the matching `content_type`, such as `image/png`.
2. The response contains `upload_url`, `upload_headers`, and `public_url`.
3. Upload bytes with `PUT upload_url`, preserving every returned upload header. Do not attach Higgsfield authorization or cookies to the storage request, and do not log the signed URL.
4. Use `public_url` as `image_url` only after the PUT succeeds.

Signed upload URLs expire after one hour. Provider-supported image types include JPEG, PNG, WebP, and GIF. Cutline's initial native picker accepts PNG, JPEG, and WebP, verifies image signatures, and caps uploads at **20 MiB**. This cap is a Cutline resource limit, not a published Higgsfield limit. No image byte-size maximum was found in the selected model or shared upload documentation.

Source: [file uploads](https://docs.higgsfield.ai/docs/concepts/file-uploads.md).

## Durable job lifecycle

Persist the local job ID before sending network requests. Each intended generation gets one UUID used as its `Idempotency-Key`. Persist the final model endpoint and JSON body before generation submission, including any uploaded reference URL.

A successful submission returns `request_id`, `status_url`, and `cancel_url`. Polling the status URL returns both state and output; a separate REST result endpoint is unnecessary. Provider states are:

| State | Handling |
| --- | --- |
| `queued` | Waiting; cancellation may still succeed. |
| `in_progress` | Processing; cancellation is unavailable. |
| `completed` | Read `video.url`, download, and make the asset available for import. |
| `failed` | Terminal generation failure; preserve its history. |
| `nsfw` | Terminal moderation rejection; preserve its history. |
| `canceled` | Terminal canceled request. |

Treat transport errors separately from provider terminal failures. A timeout or app exit during submission can leave acceptance unknown. Recovery replays the **same endpoint and body with the same idempotency key**, then stores the recovered `request_id`. A deliberate new generation needs a new key. Reusing a key with changed parameters returns 422; do not silently mint another key in response. A replay receipt may still say `queued` after the original generation finished, so check status afterward.

The documented polling recommendation starts at two seconds and increases to ten seconds, with jitter for concurrent workers. Polling errors must not resubmit generation. Restarting Cutline should resume checks for accepted requests and preserve unresolved submissions for recovery.

Sources: [request lifecycle](https://docs.higgsfield.ai/docs/concepts/requests.md), [status response](https://docs.higgsfield.ai/docs/api-reference/requests/get-request-status.md), [idempotency](https://docs.higgsfield.ai/docs/concepts/idempotency.md), [polling](https://docs.higgsfield.ai/docs/concepts/polling.md).

## Cancellation and errors

Cancel an eligible queued request with `POST /requests/{request_id}/cancel`. Success is **202 with an empty response body**. A 400 means processing has already started; refresh the status instead of marking the request canceled. Stopping local polling does not cancel provider work.

Common synchronous failures are 401 for invalid credentials, 403 for insufficient credits, 404 for unavailable requests/models, 422 for invalid input or idempotency mismatch, 423 for temporary model blocking, and 503 for unavailable models. The provider's `detail` field can be a string or a validation-error array. Avoid displaying raw responses containing media URLs or request internals. Network/5xx status checks can be retried with backoff.

Sources: [cancellation](https://docs.higgsfield.ai/docs/api-reference/requests/cancel-a-queued-request.md), [errors](https://docs.higgsfield.ai/docs/concepts/errors.md).

## Output transfer and local limits

Generated video arrives as `video.url`. The official schemas show illustrative HTTPS URLs such as `https://example.com/output.mp4` and `https://cdn.example.com/video.mp4`; they do not publish a stable output-host allowlist. Public playground examples also use CloudFront, but those demo hosts are not a contract for generated results.

Accept provider-issued public HTTPS media URLs, validate the destination and every permitted download redirect, reject local/private addresses, and never attach the API key. Signed upload redirects should not forward upload headers to another destination. An output-host allowlist should only be introduced with a verified provider contract.

Cutline caps generated video downloads at **512 MiB**, checks both declared size and bytes received, and writes to a temporary file before finalizing the local asset. This is a Cutline limit, not a documented provider maximum. Keep a completed generation recoverable when downloading fails; retry the download without paying for another generation. Validate the downloaded media before adding it to the editor.

Provider output is retained for at least seven days and may be removed afterward. Download promptly for durable use. Pricing depends on model, settings, and account; avoid claiming a fixed price from marketing examples. The documented estimate endpoint is `POST /estimate/<model-path>` with the same generation parameters; it returns account-specific `credits` and `usd` values. The initial Cutline flow displays that generation uses API credits rather than presenting an unverified price.

Sources: [request outputs](https://docs.higgsfield.ai/docs/concepts/requests.md), [billing and retention](https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md).

## Reference images (Cutline 0.19)

Seedance's `POST /bytedance/seedance-2.0/reference-to-video` takes an ordered `image_urls` array of 1–9 uploaded public URLs plus `prompt`, `duration`, `resolution`, `aspect_ratio`, and `generate_audio`. Cutline supports images only in this mode. It does not mix the singular `image_url` starting-frame field into reference requests. Reference images guide appearance and style; image-to-video uses a particular opening composition and does not take `aspect_ratio`.

Story plans persist optional `referenceAssetIds` arrays on the plan and each scene. Effective references are shared images first, followed by scene images, deduplicated while retaining order, with a combined limit of nine. Generation validates every selected source, snapshots reference files locally, uploads them only after an explicit Generate action, and saves the exact request body for idempotent recovery. Public job records show reference filenames, never uploaded URLs or filesystem paths. An unresolved or missing reference fails instead of silently generating without it.

Use the numbered previews to write plain descriptions such as “Use image 1 for the character and image 2 for the forest.” The selected API schema does not specify a special image-tag grammar, so Cutline does not inject undocumented tags or role/weight fields. PNG, JPEG, and WebP under 20 MiB are Cutline's local input limits; no additional image dimensions or aspect requirements are published in these API pages.

Sources checked 2026-10-12: [reference-to-video](https://docs.higgsfield.ai/docs/models/seedance-2/reference-to-video), [image-to-video](https://docs.higgsfield.ai/docs/models/seedance-2/image-to-video), [file uploads](https://docs.higgsfield.ai/docs/concepts/file-uploads).

## Pictures for detailed graphics (Cutline 0.33)

Endpoint: `POST /recraft/v4.1/text-to-image` (Recraft V4.1, 1K). Cutline sends only documented fields: `prompt` (the description, the style's look, and "one subject, centered, on a plain flat solid <color> background, no shadow, floor, scenery or text"), `resolution` `1k`, `aspect_ratio` `1:1`, `16:9` or `9:16`, `output_format` `png`, `background_color` `{rgb}` and, with a palette, `colors` `[{rgb}]`. The schema rejects additional properties.

The backdrop is magenta unless the description or palette uses magenta, pink or purple, then green, then blue. After download Cutline measures the backdrop on the picture's border, removes it from the edges inward and from enclosed gaps of the exact color, softens the outline with the backdrop's tint taken out, and crops to the subject. A picture without a flat backdrop stays opaque and says so.

Each request is written to `generated-media/pictures/pictures.json` with its idempotency key before it is sent; the key itself is never stored there. Status polling starts at 1.5 seconds and backs off to 6 seconds, for at most five minutes. Stopping while a request is queued cancels it. Downloads follow the same public-address and redirect checks as videos, accept only image types and stop at 25 MiB. The price shown in Settings comes from `POST /estimate/recraft/v4.1/text-to-image`.

Sources checked 2026-10-24: [Recraft V4.1 text to image](https://docs.higgsfield.ai/docs/models/recraft-v4-1/text-to-image.md), [billing and estimates](https://docs.higgsfield.ai/docs/concepts/billing-and-retention.md).

## Verification boundary

Use mocked provider responses to verify field mappings, duplicate-submit prevention, ambiguous submission recovery, persistence across restarts, empty cancellation responses, upload headers, download failure recovery, invalid credentials, and private-address rejection without spending credits. A real generation and playable import require an authorized API key with account access and credits. Report that live boundary separately from successful local tests and builds.
