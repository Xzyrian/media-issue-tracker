using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.Noteboard.Services;

/// <summary>
/// Registers plugin services with the host DI container.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection services, IServerApplicationHost applicationHost)
    {
        services.AddSingleton<NoteStore>();
        services.AddHostedService<IndexHtmlInjector>();
        services.AddTransient<IStartupFilter, IndexHtmlStartupFilter>();
    }
}
