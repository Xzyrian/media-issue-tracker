# Jellyfin Noteboard Plugin

Places a large **noteboard window on the Jellyfin web client's home page**. Users can:

- **Write notes** — every post is treated as an issue report for the admin.
- **Report from the item page** — a floating amber ⚠ button on any media details page opens a report dialog with that item pre-attached.
- **Attach media with one click** — the compose box shows the user's **recently watched and in-progress items** as thumbnails, plus a **library search** to find anything else. The attached item is shown to the admin with its poster and a direct link.

Admins see every note, can filter (All / Open issues / Mine), **resolve** reports, and delete notes. Regular users see (and can delete) their own notes — or everyone's, if you enable the shared-board option.

Notes are stored on the server in `<jellyfin-data>/data/noteboard/notes.json` and survive restarts.

## Compatibility

| Jellyfin version | Target framework | Package versions |
|---|---|---|
| 10.11.x / 12.x | `net9.0` | `Jellyfin.Controller` / `Jellyfin.Model` **10.11.\*** (default in the csproj) |
| 10.9.x / 10.10.x | `net8.0` | `Jellyfin.Controller` / `Jellyfin.Model` **10.10.7** |

The default targets current Jellyfin (10.11+). To build for 10.9/10.10, edit
`Jellyfin.Plugin.Noteboard.csproj`: set `<TargetFramework>net8.0</TargetFramework>` and pin both
package versions to `10.10.7`, and set `targetAbi` in `meta.json` to `10.9.0.0`.

## Build

Requires the [.NET 9 SDK](https://dotnet.microsoft.com/download) (or .NET 8 if retargeting).

```powershell
dotnet build -c Release
```

The plugin DLL lands in `bin\Release\net9.0\Jellyfin.Plugin.Noteboard.dll`.

## Install via repository (auto-update)

1. In Jellyfin: **Dashboard → Plugins → Repositories → +** and add:
   `https://raw.githubusercontent.com/<owner>/<repo>/manifest/manifest.json`
2. Install **Media Issue Tracker** from the Catalog, restart Jellyfin, hard-refresh (Ctrl+F5).
3. New versions appear as plugin updates automatically whenever a release is tagged
   (`git tag vX.Y.Z.W && git push origin vX.Y.Z.W` — CI builds, releases, and updates the manifest).

## Install manually

1. Create a folder `Noteboard` inside Jellyfin's **plugins** directory:
   - Windows: `C:\Program Files\Jellyfin\Server\plugins\Noteboard` (or `%LOCALAPPDATA%\jellyfin\plugins\Noteboard` for per-user installs)
   - Docker/Linux: `<config>/plugins/Noteboard`
2. Copy in **`Jellyfin.Plugin.Noteboard.dll`** and **`meta.json`**.
3. Restart Jellyfin.
4. Hard-refresh the web client (**Ctrl+F5**) so the injected script is picked up.

On startup the plugin tries to patch `index.html` on disk, and additionally injects the snippet
**at request time** via an ASP.NET Core middleware — so it works even where the web root is
read-only (e.g. Docker) without any extra steps, survives web client updates, and respects the
enable/disable toggle on the next page load.

## Settings

Dashboard → Plugins → Noteboard:

- **Show noteboard on the web home page** — toggle injection (takes effect on the next page load).
- **Board title** — heading text shown on the board.
- **Let all users see everyone's notes** — shared bulletin board mode.
- **Maximum number of notes kept** — oldest notes are pruned beyond this.

## How it works

- `Services/IndexHtmlInjectionMiddleware.cs` — injects the client script into `index.html` at request time (works with read-only web roots / Docker).
- `Services/IndexHtmlInjector.cs` — optional on-disk patch of `index.html` at startup where the web root is writable (harmless if it fails).
- `Controllers/NoteboardController.cs` — authenticated REST API under `/Noteboard/*`
  (`GET /Notes`, `POST /Notes`, `POST /Notes/{id}/Resolved`, `DELETE /Notes/{id}`, `GET /Config`),
  plus anonymous static serving of the client script/style. Admin rights are read from the
  Jellyfin auth claims; notes/deletes are permission-checked server-side.
- `Services/NoteStore.cs` — thread-safe JSON storage, atomic writes.
- `Web/noteboard.js` — mounts the board on the home page, pulls *recently watched* (`Items?Filters=IsPlayed&SortBy=DatePlayed`)
  and *in-progress* (`Items/Resume`) items for one-click attach, debounced library search,
  60 s background refresh that never clobbers a note you're typing.

## API summary (for tinkering)

All data endpoints need a normal user token (`X-Emby-Token`):

| Endpoint | Who | What |
|---|---|---|
| `GET /Noteboard/Config` | any user | board settings + caller info (`isAdmin`) |
| `GET /Noteboard/Notes` | any user | own notes; all notes for admins / shared mode |
| `GET /Noteboard/Notes/ForItem/{itemId}` | any user | notes attached to one item (drives the item-page banner) |
| `POST /Noteboard/Notes` | any user | create `{ text, isIssueReport, itemId? }` |
| `POST /Noteboard/Notes/{id}/Resolved?value=true` | admin | resolve / reopen |
| `DELETE /Noteboard/Notes/{id}` | author or admin | delete |
| `GET /Noteboard/Client/{file}` | anonymous | embedded `noteboard.js` / `noteboard.css` |
