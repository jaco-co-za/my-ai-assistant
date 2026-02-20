# mservice-file-bulk-uploader

Bulk uploads files through `ai-assistant` `/upload-file` and waits for completion before uploading the next file.

## Usage

```powershell
cd "e:\Source\LLMS\v3\micro services\mservice-file-bulk-uploader"
node src/index.mjs "E:\\absolute\\folder\\path" [limit] [Sonja] [recursive]
```

- `absolute-folder-path`: required, must be absolute.
- `limit`: optional, default `1`. Use `0` to upload all discovered supported files.
- `Sonja`: optional third arg; if present exactly as `Sonja`, uploads to Sonja owner scope.
- If third arg is omitted (or any value other than exact `Sonja`), it uses `me`, which is the same route/behavior as the UI **Upload My Files** button (`/upload-file` with `owner=me`).
- `recursive`: optional fourth arg. If `true`, scans subdirectories up to 3 levels deep. Otherwise scans only the provided folder.

## Supported files

- Images: `.jpg`, `.jpeg`, `.png`, `.webp`, `.bmp`, `.tif`, `.tiff`
- Docs: `.pdf`, `.doc`, `.docx`
- Ignored: `.xls`, `.xlsx`

## Behavior

- Uploads sequentially.
- After each upload, polls file status until summary processing is no longer `pending`.
- Prints summary text (or `(no summary)`) for each processed file.
- If status record is removed (for skipped-and-deleted files), uploader treats that as terminal and continues.
- Continues on per-file errors (upload, processing, polling), logs the failure, and moves to the next file.
- Only startup/config/path errors stop the run before processing starts.

## Config source

Reads environment values from:

- `micro services/ai-assistant/.env`

Expected keys:

- `BASE_URL` (for default upload URL)
- `AI_ASSISTANT_UI_UPLOAD_URL` (optional override)
- `FILE_MICRO_SERVICE_URL`
- `FILE_MICRO_SERVICE_AUTH` (or fallback `WEBHOOK_BEARER_TOKEN`)
