using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Noteboard.Services;

/// <summary>
/// Optional on-disk patch of the web client's index.html on server startup.
/// This is a fast path for installs where the web root is writable; when it fails
/// (e.g. read-only Docker images), the request-time <see cref="IndexHtmlInjectionMiddleware"/>
/// covers injection instead, so a failure here is harmless.
/// </summary>
public sealed class IndexHtmlInjector : IHostedService
{
    private readonly IApplicationPaths _appPaths;
    private readonly ILogger<IndexHtmlInjector> _logger;

    public IndexHtmlInjector(IApplicationPaths appPaths, ILogger<IndexHtmlInjector> logger)
    {
        _appPaths = appPaths;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        try
        {
            var indexPath = Path.Combine(_appPaths.WebPath, "index.html");
            if (!File.Exists(indexPath))
            {
                _logger.LogDebug("Noteboard: index.html not found at {Path}; request-time injection will be used", indexPath);
                return Task.CompletedTask;
            }

            var html = File.ReadAllText(indexPath);
            html = RemoveInjection(html);

            var enabled = NoteboardPlugin.Instance?.Configuration.EnableHomepageInjection ?? true;
            if (enabled)
            {
                var idx = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
                html = idx >= 0 ? html.Insert(idx, InjectionMarkup.Snippet + "\n") : html + "\n" + InjectionMarkup.Snippet + "\n";
            }

            File.WriteAllText(indexPath, html);

            if (enabled)
            {
                _logger.LogInformation("Noteboard: injected client script into {Path}", indexPath);
            }
        }
        catch (Exception ex)
        {
            _logger.LogInformation(
                ex,
                "Noteboard: could not patch index.html on disk (common in Docker) — request-time injection will be used instead, no action needed");
        }

        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private static string RemoveInjection(string html)
    {
        while (true)
        {
            var begin = html.IndexOf(InjectionMarkup.BeginMarker, StringComparison.Ordinal);
            if (begin < 0)
            {
                return html;
            }

            var end = html.IndexOf(InjectionMarkup.EndMarker, begin, StringComparison.Ordinal);
            if (end < 0)
            {
                return html;
            }

            html = html.Remove(begin, end + InjectionMarkup.EndMarker.Length - begin);
        }
    }
}
