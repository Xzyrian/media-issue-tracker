using Jellyfin.Plugin.Noteboard.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.Noteboard;

/// <summary>
/// Noteboard plugin — places a large note / media-issue board on the web client home page.
/// </summary>
public class NoteboardPlugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>Plugin GUID. Must match meta.json and the config page script.</summary>
    public const string PluginGuid = "b8e4a1f0-6c3d-4a2b-9e5f-1d7c8b0a3f4e";

    public NoteboardPlugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    public static NoteboardPlugin? Instance { get; private set; }

    public override string Name => "Media Issue Tracker";

    public override string Description =>
        "Adds a media issue tracker board to the web client home page so users can report media issues, with quick media picking from their recently watched items and a report button on item pages.";

    public override Guid Id => Guid.Parse(PluginGuid);

    public IEnumerable<PluginPageInfo> GetPages()
    {
        yield return new PluginPageInfo
        {
            Name = "Media Issue Tracker",
            EmbeddedResourcePath = $"{GetType().Namespace}.Configuration.configPage.html"
        };
    }
}
