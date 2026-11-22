# Folders

Each project can hold a tree of folders, like a file system: `Reports/2026/Q1/summary.md`. Folders are available on every installation; you don't need App Connect for them.

## The model

- A folder has a **name** (one path segment) and a **parent**: another folder, or the project root. Its **path** is the names from the root down, joined by `/`, for example `folder1/nesteda`.
- Names are 1–80 characters, can't contain `/` or control characters, and can't be `.` or `..`. Sibling names are unique without regard to case, but the same name can appear under different parents (`a/notes` and `b/notes`).
- Folders can be nested up to 8 levels deep, and a full path can be up to 200 characters. A project can hold up to 2,000 folders.
- Every document and file is in exactly one folder or at the project root. Its `folder_id` says which, and its `folder` field is that folder's path.

## Using folders

**Browser.** Open a project to see its root: subfolders are listed first, then the documents and files at that level. Clicking a folder opens it (`#/p/<project>/f/<folder>`), and the breadcrumbs show the full path. **New document** and **Upload file** add to the folder you're viewing. Folder commands are grouped under **Folder actions**: **New folder** at the project root, and **New subfolder**, **Rename**, **Move** and **Delete folder** inside a folder. On a phone they collapse into a single **Folder actions** menu. To move a document, open it, go to **Details** and set **Folder** to a path. Existing paths are suggested, and typing a new path creates that folder when you save. Search always covers the whole project, and search results and the trash show each item's folder path.

**Writes by path.** Anywhere a `folder` is accepted (creating a document, template copies, uploads, and the Details change), you can pass a path such as `"Reports/2026/Q1"`. Any folders that don't exist yet are created. An empty string means the project root. You can pass `folder_id` (`fld_…`, or `"root"`) instead.

**Listing.** `GET …/artifacts?folder=Reports/2026` (or `folder_id=…`) lists one folder. Add `&recursive=1` to include all its subfolders. MCP `list_artifacts` and `/v1 …/files` accept the same `folder`, `folder_id` and `recursive` parameters.

| Route (owner `/api/projects/{p}` and `/v1/projects/{p}`) | Purpose |
|---|---|
| `GET folders[?parent=path \| ?parent_id=fld_… \| root]` | The whole tree, or one level: id, name, path, parent_id, `folder_count`, `item_count` |
| `POST folders` `{ "path": "a/b/c" }` or `{ "name": "c", "parent_id": "fld_…" }` | Create a folder, with missing parents. `409 folder_exists` if it's already there |
| `PATCH folders/{id}` `{ "name"?, "parent_id"? ("root"), "expected_path"? }` | Rename or move (owner only, `/api` only). The paths of all subfolders and documents follow |
| `DELETE folders/{id}` | Delete an empty folder (owner only, `/api` only) |

**Agents (MCP).** `list_folders` and `create_folder` exist on both MCP endpoints. `create_markdown`, `create_from_template`, `upload_begin` and `upload_file` take a `folder` path.

## Rules

- **Who can do what.** Anyone who can write to a project can create folders and put things in them. Renaming, moving and deleting folders is reserved for the owner, because it changes where many documents live at once, including documents an agent can't change itself.
- **Moving documents.** Moving a document to another folder is a details change, like a rename. It is versioned in History, and it becomes a proposal on documents that require review. A new folder path in a proposal is only created when the proposal is approved. If the proposed folder was renamed in the meantime, the document lands under the new name; if it was deleted, the document goes to the project root. A details change that is refused creates no folders. Renaming or moving a folder doesn't create a new version of the documents inside it: they stay in the same folder, and only the folder's path changes.
- **Moves.** A folder can't be moved into itself or into one of its subfolders. A rename or move that would collide with an existing sibling fails with `409 folder_exists`. If anything inside the folder changes while it is being renamed or moved (for example, an agent creates a subfolder), the request fails with `409 folder_conflict` and changes nothing; reload and retry. Pass `expected_path` to get `409 folder_conflict` instead if someone else renamed or moved the folder in the meantime. Concurrent renames and moves are guarded, so they can't form a cycle or leave a stale path: the losing request gets `409 folder_conflict`.
- **Deleting.** Only an empty folder can be deleted: no subfolders and no live or pending documents. Documents in the trash that were in it move to the project root, so you can still restore them. An app's destination folder can't be deleted while that app is connected (`409 folder_in_use`). An upload that starts while its folder is being deleted fails with `409 folder_conflict`.
- **Older free-text folders.** Before folders were a tree, a document's folder was a free-text label. Valid labels such as `Notes` or `Work/Ideas` become real folders the first time someone who can write to the project (the owner or a write-capable agent) lists its folders; this is audited as `folder.adopt`. A read-only listing never writes. Labels that aren't valid paths are kept as they are: they're shown, but you can't browse to them.

## App Connect

An app's upload `name` can include subfolders of its destination, for example `2026/11/screenshot.png`: up to 4 levels, each segment `[A-Za-z0-9._-]{1,64}`. The subfolders are created under the destination and marked as the app's. The file's title is the last segment. The app can never reach anything outside its destination, and the owner can't relabel an app's file into a different folder from Details (the file stays where the app put it). The owner can rename or move the destination: the app keeps writing to the same folder, and `/publisher/me` reports the new path in `destination.path`. See [app-connect.md](app-connect.md#binary-files).

## Backup

Backups include the folder tree and every document's `folder_id` (`features: ["nested_folders/1"]`). Older backups still restore; their folder labels are adopted as described above.

## Schema

Migration `0018_nested_folders.sql` is additive: it adds `folders.parent_id` and `folders.path`, plus an index. `name_key` holds the lower-cased full path, which keeps the existing per-project uniqueness. Top-level folders keep the value older Workers wrote, so rolling back the Worker is safe: an older Worker sees nested folders as extra entries named by their last segment.
