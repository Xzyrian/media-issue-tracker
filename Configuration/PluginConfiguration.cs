using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Noteboard.Configuration;

/// <summary>
/// Plugin configuration, editable from Dashboard → Plugins → Noteboard.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Whether the plugin patches the web client index.html to load the noteboard. Requires a server restart to take effect.</summary>
    public bool EnableHomepageInjection { get; set; } = true;

    /// <summary>Title shown at the top of the noteboard.</summary>
    public string BoardTitle { get; set; } = "Media Issue Tracker";

    /// <summary>If true, non-admin users can see everyone's notes. If false, users only see their own notes (admins always see all).</summary>
    public bool UsersCanSeeAllNotes { get; set; }

    /// <summary>Maximum number of notes kept. Oldest notes are discarded beyond this.</summary>
    public int MaxNotes { get; set; } = 500;
}
