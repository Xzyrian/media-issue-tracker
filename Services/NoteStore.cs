using System.Text.Json;
using Jellyfin.Plugin.Noteboard.Models;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Noteboard.Services;

/// <summary>
/// Thread-safe JSON-file-backed storage for notes.
/// Stored in &lt;jellyfin-data&gt;/data/noteboard/notes.json.
/// </summary>
public sealed class NoteStore
{
    private static readonly JsonSerializerOptions JsonOptions = new() { WriteIndented = true };

    private readonly object _sync = new();
    private readonly ILogger<NoteStore> _logger;
    private readonly string _filePath;
    private List<Note> _notes = new();

    public NoteStore(IApplicationPaths applicationPaths, ILogger<NoteStore> logger)
    {
        _logger = logger;
        var dir = Path.Combine(applicationPaths.DataPath, "noteboard");
        Directory.CreateDirectory(dir);
        _filePath = Path.Combine(dir, "notes.json");
        Load();
    }

    public IReadOnlyList<Note> GetAll()
    {
        lock (_sync)
        {
            return _notes.ToArray();
        }
    }

    public Note? Find(Guid id)
    {
        lock (_sync)
        {
            return _notes.FirstOrDefault(n => n.Id == id);
        }
    }

    public Note Add(Note note, int maxNotes)
    {
        lock (_sync)
        {
            _notes.Insert(0, note);
            if (maxNotes > 0 && _notes.Count > maxNotes)
            {
                _notes.RemoveRange(maxNotes, _notes.Count - maxNotes);
            }

            SaveLocked();
        }

        return note;
    }

    public bool Remove(Guid id)
    {
        lock (_sync)
        {
            var removed = _notes.RemoveAll(n => n.Id == id) > 0;
            if (removed)
            {
                SaveLocked();
            }

            return removed;
        }
    }

    /// <summary>Mutates an existing note (by id) and persists.</summary>
    public bool Update(Guid id, Action<Note> mutate)
    {
        lock (_sync)
        {
            var note = _notes.FirstOrDefault(n => n.Id == id);
            if (note is null)
            {
                return false;
            }

            mutate(note);
            SaveLocked();
            return true;
        }
    }

    private void Load()
    {
        try
        {
            if (!File.Exists(_filePath))
            {
                return;
            }

            var json = File.ReadAllText(_filePath);
            _notes = JsonSerializer.Deserialize<List<Note>>(json, JsonOptions) ?? new List<Note>();
            _logger.LogInformation("Noteboard: loaded {Count} notes from {Path}", _notes.Count, _filePath);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Noteboard: failed to load {Path}; starting with an empty board", _filePath);
            _notes = new List<Note>();
        }
    }

    /// <summary>Caller must hold <see cref="_sync"/>.</summary>
    private void SaveLocked()
    {
        try
        {
            var tmp = _filePath + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(_notes, JsonOptions));
            File.Move(tmp, _filePath, true);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Noteboard: failed to save notes to {Path}", _filePath);
        }
    }
}
