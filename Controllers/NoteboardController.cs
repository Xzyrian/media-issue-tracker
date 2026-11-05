using System.Reflection;
using Jellyfin.Plugin.Noteboard.Models;
using Jellyfin.Plugin.Noteboard.Services;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Noteboard.Controllers;

/// <summary>
/// REST API for the noteboard. Endpoints authenticate manually by validating the request's
/// access token via <see cref="IAuthorizationContext"/>, so the plugin does not depend on the
/// host's authorization-policy pipeline. The static client script/style are anonymous
/// (they are loaded via a plain script tag).
/// </summary>
[ApiController]
[Route("Noteboard")]
public class NoteboardController : ControllerBase
{
    private const int MaxTextLength = 4000;

    private static readonly (string FileName, string Resource, string ContentType)[] ClientFiles =
    {
        ("noteboard.js", "Jellyfin.Plugin.Noteboard.Web.noteboard.js", "text/javascript; charset=utf-8"),
        ("noteboard.css", "Jellyfin.Plugin.Noteboard.Web.noteboard.css", "text/css; charset=utf-8")
    };

    private readonly NoteStore _store;
    private readonly ILibraryManager _libraryManager;
    private readonly IUserManager _userManager;
    private readonly IAuthorizationContext _authContext;
    private readonly ILogger<NoteboardController> _logger;

    public NoteboardController(
        NoteStore store,
        ILibraryManager libraryManager,
        IUserManager userManager,
        IAuthorizationContext authContext,
        ILogger<NoteboardController> logger)
    {
        _store = store;
        _libraryManager = libraryManager;
        _userManager = userManager;
        _authContext = authContext;
        _logger = logger;
    }

    /// <summary>Serves the embedded client script / stylesheet.</summary>
    [HttpGet("Client/{fileName}")]
    [AllowAnonymous]
    [ResponseCache(Duration = 300)]
    public ActionResult GetClientFile([FromRoute] string fileName)
    {
        var entry = ClientFiles.FirstOrDefault(f =>
            string.Equals(f.FileName, fileName, StringComparison.OrdinalIgnoreCase));
        if (entry.FileName is null)
        {
            return NotFound();
        }

        var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(entry.Resource);
        if (stream is null)
        {
            _logger.LogError("Noteboard: embedded resource {Resource} is missing", entry.Resource);
            return NotFound();
        }

        return File(stream, entry.ContentType);
    }

    /// <summary>Board settings plus info about the calling user. Used by the client on startup.</summary>
    [HttpGet("Config")]
    public async Task<ActionResult<object>> GetConfig()
    {
        var auth = await ResolveUserAsync().ConfigureAwait(false);
        if (!auth.Ok)
        {
            return Unauthorized();
        }

        var cfg = NoteboardPlugin.Instance?.Configuration;
        return new
        {
            boardTitle = cfg?.BoardTitle ?? "Media Issue Tracker",
            usersCanSeeAllNotes = cfg?.UsersCanSeeAllNotes ?? false,
            userId = auth.UserId,
            userName = auth.UserName,
            isAdmin = auth.IsAdmin
        };
    }

    /// <summary>Lists notes. Admins (and everyone, if configured) see all notes; others see their own.</summary>
    [HttpGet("Notes")]
    public async Task<ActionResult<IEnumerable<Note>>> GetNotes()
    {
        var auth = await ResolveUserAsync().ConfigureAwait(false);
        if (!auth.Ok)
        {
            return Unauthorized();
        }

        var cfg = NoteboardPlugin.Instance?.Configuration;
        var seeAll = auth.IsAdmin || (cfg?.UsersCanSeeAllNotes ?? false);

        var notes = _store.GetAll()
            .Where(n => seeAll || n.UserId == auth.UserId)
            .OrderBy(n => n.Resolved)
            .ThenByDescending(n => n.CreatedUtc);

        return Ok(notes);
    }

    /// <summary>Creates a note, optionally attached to a library item.</summary>
    [HttpPost("Notes")]
    public async Task<ActionResult<Note>> CreateNote([FromBody] CreateNoteRequest request)
    {
        var auth = await ResolveUserAsync().ConfigureAwait(false);
        if (!auth.Ok)
        {
            return Unauthorized();
        }

        if (auth.UserId == Guid.Empty)
        {
            return StatusCode(403, "Notes cannot be created with an API key; a user session is required.");
        }

        var text = (request.Text ?? string.Empty).Trim();
        if (text.Length == 0)
        {
            return BadRequest("Note text must not be empty.");
        }

        if (text.Length > MaxTextLength)
        {
            text = text[..MaxTextLength];
        }

        var note = new Note
        {
            Id = Guid.NewGuid(),
            UserId = auth.UserId,
            UserName = auth.UserName,
            Text = text,
            IsIssueReport = request.IsIssueReport,
            CreatedUtc = DateTime.UtcNow
        };

        if (request.ItemId is { } itemId && itemId != Guid.Empty)
        {
            var item = _libraryManager.GetItemById(itemId);
            if (item is not null)
            {
                note.ItemId = item.Id;
                note.ItemName = item.Name;
                note.ItemType = item.GetType().Name;
            }
        }

        var maxNotes = NoteboardPlugin.Instance?.Configuration.MaxNotes ?? 500;
        _store.Add(note, maxNotes);
        return Ok(note);
    }

    /// <summary>Lists notes attached to a specific item. Admins (and everyone in shared mode) see all; others see their own.</summary>
    [HttpGet("Notes/ForItem/{itemId:guid}")]
    public async Task<ActionResult<IEnumerable<Note>>> GetNotesForItem([FromRoute] Guid itemId)
    {
        var auth = await ResolveUserAsync().ConfigureAwait(false);
        if (!auth.Ok)
        {
            return Unauthorized();
        }

        var cfg = NoteboardPlugin.Instance?.Configuration;
        var seeAll = auth.IsAdmin || (cfg?.UsersCanSeeAllNotes ?? false);

        var notes = _store.GetAll()
            .Where(n => n.ItemId == itemId && (seeAll || n.UserId == auth.UserId))
            .OrderBy(n => n.Resolved)
            .ThenByDescending(n => n.CreatedUtc);

        return Ok(notes);
    }

    /// <summary>Marks a note resolved / unresolved. Admin only.</summary>
    [HttpPost("Notes/{id:guid}/Resolved")]
    public async Task<ActionResult> SetResolved([FromRoute] Guid id, [FromQuery] bool value = true)
    {
        var auth = await ResolveUserAsync().ConfigureAwait(false);
        if (!auth.Ok)
        {
            return Unauthorized();
        }

        if (!auth.IsAdmin)
        {
            return Forbid();
        }

        var found = _store.Update(id, note =>
        {
            note.Resolved = value;
            note.ResolvedByName = value ? auth.UserName : null;
            note.ResolvedUtc = value ? DateTime.UtcNow : null;
        });

        return found ? NoContent() : NotFound();
    }

    /// <summary>Deletes a note. Allowed for the note's author and admins.</summary>
    [HttpDelete("Notes/{id:guid}")]
    public async Task<ActionResult> DeleteNote([FromRoute] Guid id)
    {
        var auth = await ResolveUserAsync().ConfigureAwait(false);
        if (!auth.Ok)
        {
            return Unauthorized();
        }

        var note = _store.Find(id);
        if (note is null)
        {
            return NotFound();
        }

        if (!auth.IsAdmin && note.UserId != auth.UserId)
        {
            return Forbid();
        }

        _store.Remove(id);
        return NoContent();
    }

    /// <summary>
    /// Validates the request's access token directly via Jellyfin's
    /// <see cref="IAuthorizationContext"/>. Jellyfin API keys (no associated user) are treated
    /// as admin callers with an empty user id.
    /// </summary>
    private async Task<(bool Ok, Guid UserId, string UserName, bool IsAdmin)> ResolveUserAsync()
    {
        AuthorizationInfo? info = null;
        try
        {
            info = await _authContext.GetAuthorizationInfo(Request).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Noteboard: GetAuthorizationInfo threw");
        }

        if (info is not null && !string.IsNullOrEmpty(info.Token))
        {
            if (info.IsApiKey)
            {
                // API keys have full server access but no associated user.
                return (true, Guid.Empty, "API key", true);
            }

            if (info.UserId != Guid.Empty)
            {
                // The auth handler populates the claims principal for every request with a
                // valid token, so the role claim is the safest admin signal across versions.
                var isAdmin = User?.IsInRole("Administrator") ?? false;
                var userName = User?.Identity?.Name ?? "unknown";
                try
                {
                    userName = _userManager.GetUserById(info.UserId)?.Username ?? userName;
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "Noteboard: user lookup failed for {UserId}", info.UserId);
                }

                return (true, info.UserId, userName, isAdmin);
            }
        }

        _logger.LogWarning(
            "Noteboard: rejected {Method} {Path} — no valid access token found on the request (token present: {TokenPresent})",
            Request.Method,
            Request.Path,
            !string.IsNullOrEmpty(info?.Token));
        return (false, Guid.Empty, "unknown", false);
    }
}
