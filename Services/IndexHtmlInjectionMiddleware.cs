using System.Text;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Noteboard.Services;

/// <summary>
/// Shared injection markup served into the web client's index.html.
/// </summary>
internal static class InjectionMarkup
{
    public const string BeginMarker = "<!-- BEGIN jellyfin-plugin-noteboard -->";
    public const string EndMarker = "<!-- END jellyfin-plugin-noteboard -->";

    // index.html is served from "<baseurl>/web/index.html", so a relative "../" resolves to
    // the server root (with or without a configured baseurl) — the API lives there.
    public const string Snippet =
        BeginMarker + "\n"
        + "<link rel=\"stylesheet\" href=\"../Noteboard/Client/noteboard.css?v=1.2.1\" />\n"
        + "<script defer src=\"../Noteboard/Client/noteboard.js?v=1.2.1\"></script>\n"
        + EndMarker;
}

/// <summary>
/// Inserts the noteboard middleware at the very beginning of the ASP.NET Core pipeline,
/// before Jellyfin's static file middleware serves index.html.
/// </summary>
public sealed class IndexHtmlStartupFilter : IStartupFilter
{
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
        => app =>
        {
            app.UseMiddleware<IndexHtmlInjectionMiddleware>();
            next(app);
        };
}

/// <summary>
/// Injects the noteboard script/stylesheet into index.html at request time, in memory.
/// This needs no write access to the web root, so it works in Docker containers where
/// /jellyfin/jellyfin-web is read-only, and survives web client updates untouched.
/// </summary>
public sealed class IndexHtmlInjectionMiddleware
{
    private readonly RequestDelegate _next;
    private readonly ILogger<IndexHtmlInjectionMiddleware> _logger;

    public IndexHtmlInjectionMiddleware(RequestDelegate next, ILogger<IndexHtmlInjectionMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path.Value ?? string.Empty;
        var enabled = NoteboardPlugin.Instance?.Configuration.EnableHomepageInjection ?? true;

        if (!enabled || !HttpMethods.IsGet(context.Request.Method) || !IsIndexRequest(path))
        {
            await _next(context);
            return;
        }

        var originalBody = context.Response.Body;
        var buffer = new MemoryStream();
        context.Response.Body = buffer;

        try
        {
            await _next(context);

            if (context.Response.StatusCode == StatusCodes.Status200OK
                && (context.Response.ContentType?.Contains("text/html", StringComparison.OrdinalIgnoreCase) ?? false))
            {
                buffer.Position = 0;
                string html;
                using (var reader = new StreamReader(buffer, Encoding.UTF8, leaveOpen: true))
                {
                    html = await reader.ReadToEndAsync();
                }

                // Skip if the on-disk patcher already injected the snippet.
                if (!html.Contains(InjectionMarkup.BeginMarker, StringComparison.Ordinal))
                {
                    var idx = html.LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
                    if (idx >= 0)
                    {
                        html = html.Insert(idx, InjectionMarkup.Snippet + "\n");
                        _logger.LogInformation(
                            "Noteboard: injected client script into index.html served to {RemoteIp} ({UserAgent})",
                            context.Connection.RemoteIpAddress,
                            context.Request.Headers.UserAgent.ToString());
                    }
                }

                var bytes = Encoding.UTF8.GetBytes(html);
                context.Response.Body = originalBody;
                context.Response.ContentLength = bytes.Length;
                await context.Response.Body.WriteAsync(bytes);
                return;
            }

            // Not an HTML 200 — pass the buffered response through untouched.
            buffer.Position = 0;
            context.Response.Body = originalBody;
            await buffer.CopyToAsync(originalBody);
        }
        finally
        {
            context.Response.Body = originalBody;
            await buffer.DisposeAsync();
        }
    }

    /// <summary>
    /// Matches the web client entry point: /web, /web/ and /web/index.html,
    /// with or without a configured baseurl prefix. Jellyfin's default-files
    /// mapping runs after this middleware, so all three forms must be covered.
    /// </summary>
    private static bool IsIndexRequest(string path)
    {
        var trimmed = path.TrimEnd('/');
        return trimmed.EndsWith("/web", StringComparison.OrdinalIgnoreCase)
            || trimmed.EndsWith("/web/index.html", StringComparison.OrdinalIgnoreCase);
    }
}
