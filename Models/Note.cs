namespace Jellyfin.Plugin.Noteboard.Models;

/// <summary>A single noteboard entry.</summary>
public class Note
{
    public Guid Id { get; set; }

    public Guid UserId { get; set; }

    public string UserName { get; set; } = string.Empty;

    public string Text { get; set; } = string.Empty;

    /// <summary>True when the user flagged this note as an issue report for the admin.</summary>
    public bool IsIssueReport { get; set; }

    /// <summary>Optional attached library item.</summary>
    public Guid? ItemId { get; set; }

    public string? ItemName { get; set; }

    public string? ItemType { get; set; }

    public DateTime CreatedUtc { get; set; }

    /// <summary>Admin marked this note as handled.</summary>
    public bool Resolved { get; set; }

    public string? ResolvedByName { get; set; }

    public DateTime? ResolvedUtc { get; set; }
}

/// <summary>Payload for creating a note.</summary>
public class CreateNoteRequest
{
    public string Text { get; set; } = string.Empty;

    public bool IsIssueReport { get; set; }

    public Guid? ItemId { get; set; }
}
