/*
 * Jellyfin Noteboard — client script.
 * Injected into the web client index.html by the server plugin.
 * Renders a large noteboard on the home page where users write notes / report media issues,
 * attach media items (recently watched, in-progress, or searched), and where admins
 * review and resolve issue reports.
 */
(function () {
  'use strict';

  var CONTAINER_ID = 'jellyfin-noteboard';
  var SCRIPT_VERSION = '1.2.2';
  console.log('[Noteboard] client script loaded, v' + SCRIPT_VERSION);

  // Derive the API base (including any configured baseurl) from this script's own URL.
  var scriptUrl = (document.currentScript && document.currentScript.src) || '';
  var API_BASE = scriptUrl.replace(/\/Noteboard\/Client\/noteboard\.js(\?.*)?$/i, '');
  if (API_BASE === scriptUrl) API_BASE = ''; // fallback: same origin root

  var state = {
    me: null,
    config: null,
    notes: [],
    recent: [],
    searchResults: [],
    searchQuery: '',
    selectedItem: null,
    draft: '',
    filter: 'all',
    status: '',
    collapsed: localStorage.getItem('noteboard.collapsed') !== '0' // collapsed by default
  };

  // ---------------------------------------------------------------- helpers

  function creds() {
    // Best source: the web client's own authenticated ApiClient session.
    try {
      if (window.ApiClient && typeof window.ApiClient.accessToken === 'function') {
        var t = window.ApiClient.accessToken();
        if (t) return { token: t };
      }
    } catch (e) { /* fall through to localStorage */ }

    // Fallback: jellyfin_credentials in localStorage. Pick the entry for the
    // current host, else the most recently used one (Servers[0] is not reliable).
    try {
      var raw = localStorage.getItem('jellyfin_credentials');
      if (!raw) return null;
      var servers = (JSON.parse(raw).Servers || []).filter(function (s) { return s && s.AccessToken; });
      if (!servers.length) return null;
      var host = location.host;
      var match = null;
      servers.forEach(function (s) {
        var addrs = [s.ManualAddress, s.LocalAddress].filter(Boolean).join(' ');
        if (!match && addrs.indexOf(host) !== -1) match = s;
      });
      if (!match) {
        match = servers.slice().sort(function (a, b) {
          return (b.DateLastAccessed || 0) - (a.DateLastAccessed || 0);
        })[0];
      }
      return { token: match.AccessToken };
    } catch (e) {
      return null;
    }
  }

  function api(path, options) {
    options = options || {};
    // Preferred transport: the web client's own ApiClient — identical auth behavior
    // to every other request the page makes, so proxies and token quirks are avoided.
    var A = window.ApiClient;
    if (A && typeof A.getUrl === 'function' && typeof A.accessToken === 'function' && A.accessToken()) {
      return apiViaApiClient(A, path, options);
    }
    return apiViaFetch(path, options);
  }

  function apiViaApiClient(A, path, options) {
    var url = A.getUrl(path.replace(/^\//, ''));
    var type = options.method || 'GET';
    var req = { type: type, url: url };
    if (options.json !== undefined) {
      if (type === 'GET') type = 'POST';
      req.type = type;
      req.data = JSON.stringify(options.json);
      req.contentType = 'application/json';
      req.dataType = 'json';
    }
    var promise = (type === 'GET' && typeof A.getJSON === 'function') ? A.getJSON(url) : A.ajax(req);
    return promise.then(function (r) { return r === undefined ? null : r; })
      .catch(function (err) {
        console.warn('[Noteboard] API call failed:', path, err);
        throw new Error('request failed');
      });
  }

  function apiViaFetch(path, options) {
    var c = creds();
    if (!c) return Promise.reject(new Error('Not signed in'));
    options = options || {};
    // Use Jellyfin's own MediaBrowser authorization format (what the web client itself sends),
    // plus X-Emby-Token for older compatibility.
    var authHeader = 'MediaBrowser Client="Noteboard", Device="WebClient", DeviceId="noteboard-web", Version="' + SCRIPT_VERSION + '", Token="' + c.token + '"';
    var headers = Object.assign({ 'Authorization': authHeader, 'X-Emby-Token': c.token }, options.headers || {});
    var opts = Object.assign({}, options, { headers: headers });
    if (opts.json !== undefined) {
      opts.method = opts.method || 'POST';
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.json);
      delete opts.json;
    }
    return fetch(API_BASE + path, opts).then(function (r) {
      if (!r.ok) {
        console.warn('[Noteboard] API call failed:', path, 'HTTP', r.status);
        throw new Error('HTTP ' + r.status);
      }
      if (r.status === 204) return null;
      return r.json().catch(function () { return null; });
    });
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function itemTitle(item) {
    if (!item) return '';
    if (item.Type === 'Episode' && item.SeriesName) {
      var se = '';
      if (item.ParentIndexNumber != null) se += 'S' + String(item.ParentIndexNumber).padStart(2, '0');
      if (item.IndexNumber != null) se += 'E' + String(item.IndexNumber).padStart(2, '0');
      return item.SeriesName + (se ? ' ' + se + ' · ' : ' · ') + item.Name;
    }
    return item.Name || '';
  }

  function thumbUrl(item) {
    if (!item) return null;
    var tags = item.ImageTags || {};
    if (tags.Primary) {
      return API_BASE + '/Items/' + item.Id + '/Images/Primary?maxWidth=140&quality=90&tag=' + tags.Primary;
    }
    if (item.SeriesPrimaryImageTag && item.SeriesId) {
      return API_BASE + '/Items/' + item.SeriesId + '/Images/Primary?maxWidth=140&quality=90&tag=' + item.SeriesPrimaryImageTag;
    }
    return null;
  }

  function noteThumbUrl(note) {
    if (!note.ItemId) return null;
    return API_BASE + '/Items/' + note.ItemId + '/Images/Primary?maxWidth=140&quality=90';
  }

  function detailsUrl(itemId) {
    return API_BASE + '/web/index.html#!/details?id=' + itemId;
  }

  function fmtDate(iso) {
    try {
      return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    } catch (e) {
      return iso;
    }
  }

  // ---------------------------------------------------------------- data

  function loadConfig() {
    return api('/Noteboard/Config').then(function (cfg) {
      state.config = cfg;
      state.me = { userId: cfg.userId, userName: cfg.userName, isAdmin: !!cfg.isAdmin };
    });
  }

  function loadNotes() {
    return api('/Noteboard/Notes').then(function (notes) {
      state.notes = notes || [];
    });
  }

  function loadRecent() {
    var uid = state.me && state.me.userId;
    if (!uid) return Promise.resolve();
    var fields = '&Fields=PrimaryImageAspectRatio&EnableImageTypes=Primary';
    var resume = api('/Users/' + uid + '/Items/Resume?Limit=6&MediaTypes=Video' + fields)
      .then(function (r) { return (r && r.Items) || []; })
      .catch(function () { return []; });
    var played = api('/Users/' + uid + '/Items?Filters=IsPlayed&SortBy=DatePlayed&SortOrder=Descending' +
        '&Recursive=true&Limit=8&IncludeItemTypes=Movie,Episode' + fields)
      .then(function (r) { return (r && r.Items) || []; })
      .catch(function () { return []; });

    return Promise.all([resume, played]).then(function (results) {
      var seen = {};
      var merged = [];
      results[0].concat(results[1]).forEach(function (item) {
        if (item && item.Id && !seen[item.Id]) {
          seen[item.Id] = true;
          merged.push(item);
        }
      });
      state.recent = merged.slice(0, 12);
    });
  }

  function searchMedia(query) {
    var uid = state.me && state.me.userId;
    if (!uid || !query) return Promise.resolve();
    return api('/Users/' + uid + '/Items?SearchTerm=' + encodeURIComponent(query) +
        '&Recursive=true&Limit=10&IncludeItemTypes=Movie,Episode,Series,MusicAlbum,Audio,Video' +
        '&Fields=PrimaryImageAspectRatio&EnableImageTypes=Primary')
      .then(function (r) {
        state.searchResults = (r && r.Items) || [];
      })
      .catch(function () {
        state.searchResults = [];
      });
  }

  // ---------------------------------------------------------------- render

  function render(container) {
    container.innerHTML = '';
    if (!state.config) {
      container.appendChild(el('div', 'nb-status', state.status || 'Loading noteboard…'));
      return;
    }

    // Header — clicking the title (with its arrow) collapses/expands the board
    var header = el('div', 'nb-header');
    var title = el('h2', 'nb-title nb-title-toggle');
    title.title = state.collapsed ? 'Expand' : 'Collapse';
    title.appendChild(el('span', 'nb-arrow', state.collapsed ? '▸' : '▾'));
    title.appendChild(document.createTextNode(' ' + (state.config.boardTitle || 'Media Issue Tracker')));
    title.addEventListener('click', function () {
      state.collapsed = !state.collapsed;
      localStorage.setItem('noteboard.collapsed', state.collapsed ? '1' : '0');
      render(container);
    });
    header.appendChild(title);
    var actions = el('div', 'nb-header-actions');

    if (state.me && state.me.isAdmin) {
      var filter = el('select', 'nb-filter');
      [['all', 'All notes'], ['unresolved', 'Open issues'], ['mine', 'My notes']]
        .forEach(function (opt) {
          var o = el('option', '', opt[1]);
          o.value = opt[0];
          if (state.filter === opt[0]) o.selected = true;
          filter.appendChild(o);
        });
      filter.addEventListener('change', function () {
        state.filter = filter.value;
        render(container);
      });
      actions.appendChild(filter);
    }

    var refreshBtn = el('button', 'nb-btn nb-btn-ghost', '↻ Refresh');
    refreshBtn.addEventListener('click', function () { refreshAll(container); });
    actions.appendChild(refreshBtn);

    header.appendChild(actions);
    container.appendChild(header);

    container.classList.toggle('nb-collapsed', state.collapsed);
    if (state.collapsed) return;

    // Compose box
    container.appendChild(renderCompose(container));

    // Notes list
    container.appendChild(renderNotes(container));
  }

  function renderCompose(container) {
    var compose = el('div', 'nb-compose');

    var textarea = el('textarea', 'nb-textarea');
    textarea.placeholder = 'Write a note, or report a problem with the media (wrong episode, bad subtitles, playback issue…)';
    textarea.maxLength = 4000;
    textarea.rows = 3;
    textarea.value = state.draft;
    textarea.addEventListener('input', function () { state.draft = textarea.value; });
    compose.appendChild(textarea);

    // Attached item chip
    var attachRow = el('div', 'nb-attach-row');
    compose.appendChild(attachRow);
    function renderAttach() {
      attachRow.innerHTML = '';
      if (state.selectedItem) {
        var chip = el('span', 'nb-chip');
        chip.appendChild(el('span', 'nb-chip-label', '🎬 ' + itemTitle(state.selectedItem)));
        var x = el('button', 'nb-chip-x', '✕');
        x.title = 'Remove attached media';
        x.addEventListener('click', function () {
          state.selectedItem = null;
          render(container);
        });
        chip.appendChild(x);
        attachRow.appendChild(chip);
      } else {
        attachRow.appendChild(el('span', 'nb-attach-hint',
          'Attach media: pick from your recently watched below, or search the library.'));
      }
    }
    renderAttach();

    // Recently watched picker
    if (state.recent.length) {
      compose.appendChild(el('div', 'nb-section-label', 'Recently watched by you'));
      compose.appendChild(renderMediaRow(state.recent, container));
    }

    // Search picker
    var searchWrap = el('div', 'nb-search');
    var searchInput = el('input', 'nb-search-input');
    searchInput.type = 'search';
    searchInput.placeholder = '🔍 Search media to attach…';
    searchInput.value = state.searchQuery;
    searchWrap.appendChild(searchInput);
    var resultsRow = el('div', 'nb-media-row');
    searchWrap.appendChild(resultsRow);
    compose.appendChild(searchWrap);
    if (state.searchResults.length) {
      resultsRow.appendChild(renderMediaRowItems(state.searchResults, container));
    }

    var debounce = null;
    searchInput.addEventListener('input', function () {
      clearTimeout(debounce);
      var q = searchInput.value.trim();
      state.searchQuery = q;
      debounce = setTimeout(function () {
        if (q.length < 2) { state.searchResults = []; resultsRow.innerHTML = ''; return; }
        searchMedia(q).then(function () {
          resultsRow.innerHTML = '';
          if (state.searchResults.length) resultsRow.appendChild(renderMediaRowItems(state.searchResults, container));
        });
      }, 300);
    });

    // Footer: hint + submit (every post is an issue report for the admin)
    var footer = el('div', 'nb-compose-footer');
    footer.appendChild(el('span', 'nb-attach-hint', 'Posts are sent to the admin as issue reports.'));

    var submit = el('button', 'nb-btn nb-btn-primary', 'Post to board');
    submit.addEventListener('click', function () {
      var text = (state.draft || '').trim();
      if (!text) {
        textarea.focus();
        return;
      }
      submit.disabled = true;
      api('/Noteboard/Notes', {
        json: {
          text: text,
          isIssueReport: true,
          itemId: state.selectedItem ? state.selectedItem.Id : null
        }
      }).then(function () {
        state.selectedItem = null;
        state.draft = '';
        return loadNotes();
      }).then(function () {
        render(container);
      }).catch(function (err) {
        submit.disabled = false;
        alert('Could not post note: ' + err.message);
      });
    });
    footer.appendChild(submit);
    compose.appendChild(footer);

    return compose;
  }

  function renderMediaRow(items, container) {
    var row = el('div', 'nb-media-row');
    row.appendChild(renderMediaRowItems(items, container));
    return row;
  }

  function renderMediaRowItems(items, container) {
    var frag = document.createDocumentFragment();
    items.forEach(function (item) {
      var card = el('button', 'nb-media-card' +
        (state.selectedItem && state.selectedItem.Id === item.Id ? ' nb-media-card-selected' : ''));
      card.type = 'button';
      card.title = itemTitle(item);
      var url = thumbUrl(item);
      if (url) {
        var img = el('img', 'nb-media-thumb');
        img.src = url;
        img.loading = 'lazy';
        img.alt = '';
        card.appendChild(img);
      } else {
        card.appendChild(el('span', 'nb-media-thumb nb-media-thumb-empty', '🎞'));
      }
      card.appendChild(el('span', 'nb-media-name', itemTitle(item)));
      card.addEventListener('click', function () {
        state.selectedItem = (state.selectedItem && state.selectedItem.Id === item.Id) ? null : item;
        render(container);
      });
      frag.appendChild(card);
    });
    return frag;
  }

  function visibleNotes() {
    var me = state.me || {};
    return state.notes.filter(function (n) {
      if (state.filter === 'unresolved') return n.IsIssueReport && !n.Resolved;
      if (state.filter === 'mine') return n.UserId === me.userId;
      return true;
    });
  }

  function renderNotes(container) {
    var wrap = el('div', 'nb-notes');
    var notes = visibleNotes();

    if (!notes.length) {
      return wrap; // empty board — no placeholder text
    }

    var me = state.me || {};
    notes.forEach(function (note) {
      var card = el('div', 'nb-note' + (note.Resolved ? ' nb-note-resolved' : ''));

      var thumb = noteThumbUrl(note);
      if (thumb) {
        var link = el('a', 'nb-note-thumb-link');
        link.href = detailsUrl(note.ItemId);
        var img = el('img', 'nb-note-thumb');
        img.src = thumb;
        img.loading = 'lazy';
        img.alt = '';
        img.addEventListener('error', function () { link.style.display = 'none'; });
        link.appendChild(img);
        card.appendChild(link);
      }

      var body = el('div', 'nb-note-body');

      var meta = el('div', 'nb-note-meta');
      meta.appendChild(el('span', 'nb-badge ' + (note.IsIssueReport ? 'nb-badge-issue' : 'nb-badge-note'),
        note.IsIssueReport ? 'ISSUE' : 'NOTE'));
      meta.appendChild(el('span', 'nb-note-author', note.UserName || 'unknown'));
      meta.appendChild(el('span', 'nb-note-date', fmtDate(note.CreatedUtc)));
      if (note.Resolved) {
        meta.appendChild(el('span', 'nb-badge nb-badge-resolved',
          'RESOLVED' + (note.ResolvedByName ? ' by ' + note.ResolvedByName : '')));
      }
      body.appendChild(meta);

      if (note.ItemName) {
        var itemLink = el('a', 'nb-note-item', '🎬 ' + note.ItemName + (note.ItemType ? ' (' + note.ItemType + ')' : ''));
        itemLink.href = detailsUrl(note.ItemId);
        body.appendChild(itemLink);
      }

      body.appendChild(el('p', 'nb-note-text', note.Text));

      var canResolve = me.isAdmin;
      var canDelete = me.isAdmin || note.UserId === me.userId;
      if (canResolve || canDelete) {
        var btns = el('div', 'nb-note-actions');
        if (canResolve) {
          var resBtn = el('button', 'nb-btn nb-btn-ghost', note.Resolved ? 'Reopen' : '✓ Resolve');
          resBtn.addEventListener('click', function () {
            api('/Noteboard/Notes/' + note.Id + '/Resolved?value=' + (!note.Resolved), { method: 'POST' })
              .then(loadNotes)
              .then(function () { render(container); })
              .catch(function (err) { alert('Could not update note: ' + err.message); });
          });
          btns.appendChild(resBtn);
        }
        if (canDelete) {
          var delBtn = el('button', 'nb-btn nb-btn-danger', 'Delete');
          delBtn.addEventListener('click', function () {
            if (!confirm('Delete this note?')) return;
            api('/Noteboard/Notes/' + note.Id, { method: 'DELETE' })
              .then(loadNotes)
              .then(function () { render(container); })
              .catch(function (err) { alert('Could not delete note: ' + err.message); });
          });
          btns.appendChild(delBtn);
        }
        body.appendChild(btns);
      }

      card.appendChild(body);
      wrap.appendChild(card);
    });

    return wrap;
  }

  // ---------------------------------------------------------------- mount

  function refreshAll(container) {
    state.status = 'Loading noteboard…';
    loadConfig()
      .then(function () { return Promise.all([loadNotes(), loadRecent()]); })
      .then(function () { state.status = ''; render(container); })
      .catch(function (err) {
        state.status = 'Noteboard unavailable: ' + err.message;
        state.config = null;
        render(container);
      });
  }

  function findHomePage() {
    // The SPA keeps cached views in the DOM — a hidden .homePage can linger while a
    // different, visible home view is actually on screen. Only accept visible elements.
    var all = document.querySelectorAll('.homePage, #indexPage');
    var i;
    for (i = 0; i < all.length; i++) {
      if (all[i].offsetParent !== null) return all[i];
    }
    // Fallback: if the URL hash says we're on the home page, grab the visible page element.
    var hash = (location.hash || '').toLowerCase();
    if (hash.indexOf('home') !== -1 || hash === '' || hash === '#' || hash === '#/' || hash === '#!/') {
      var pages = document.querySelectorAll('.page:not(.hide), [data-role="page"]:not(.hide)');
      for (i = 0; i < pages.length; i++) {
        if (pages[i].offsetParent !== null) return pages[i];
      }
    }
    return null;
  }

  var mounted = false;
  var mountAttempts = 0;
  var mountTimer = null;

  function scheduleTryMount(delay) {
    clearTimeout(mountTimer);
    mountTimer = setTimeout(tryMount, delay || 150);
  }

  function retryMount(reason) {
    if (mountAttempts === 0) console.log('[Noteboard] waiting to mount:', reason);
    mountAttempts++;
    // Never give up — the SPA can destroy/recreate views at any time; keep polling cheaply.
    scheduleTryMount(3000);
  }

  function tryMount() {
    if (mounted) {
      var existing = document.getElementById(CONTAINER_ID);
      if (existing && document.contains(existing)) {
        // The view we mounted into may have been swapped for a fresh home view by the
        // SPA (cached view hidden, new view shown). If the board isn't inside the
        // currently visible home page, move it there instead of remounting.
        var visibleHome = findHomePage();
        if (visibleHome && !visibleHome.contains(existing)) {
          insertOnHomePage(visibleHome, existing);
        }
        ensurePosition();
        return;
      }
      mounted = false; // SPA removed our element; mount again
    }
    if (!creds()) { retryMount('not signed in yet'); return; }
    var page = findHomePage();
    if (!page) { retryMount('home page element not found'); return; }

    var container = el('div');
    container.id = CONTAINER_ID;
    insertOnHomePage(page, container);
    mounted = true;
    console.log('[Noteboard] mounted on the home page');
    refreshAll(container);
    startAutoRefresh();
  }

  // Place the board as its own row at the top of the home sections, above "My Media".
  function insertOnHomePage(page, container) {
    var sections = page.querySelector('.homeSectionsContainer');
    if (sections) {
      sections.insertBefore(container, sections.firstElementChild);
    } else {
      page.appendChild(container);
    }
  }

  // Home sections render asynchronously; if "My Media" appeared after we mounted,
  // make sure the board stays the first row.
  function ensurePosition() {
    var container = document.getElementById(CONTAINER_ID);
    if (!container) return;
    var sections = null;
    if (container.parentNode && container.parentNode.classList &&
        container.parentNode.classList.contains('homeSectionsContainer')) {
      sections = container.parentNode;
    } else {
      // Use the same page detection as mounting — the home element's classes vary by version.
      var page = findHomePage();
      sections = page ? page.querySelector('.homeSectionsContainer') : null;
    }
    if (sections && sections.firstElementChild !== container) {
      sections.insertBefore(container, sections.firstElementChild);
    }
  }

  var autoRefreshStarted = false;
  function startAutoRefresh() {
    if (autoRefreshStarted) return;
    autoRefreshStarted = true;
    setInterval(function () {
      if (document.hidden) return;
      var container = document.getElementById(CONTAINER_ID);
      if (!container || !container.offsetParent) return; // not mounted / home page hidden
      ensurePosition();
      loadNotes().then(function () {
        // Only re-render if the user isn't mid-compose (avoid wiping their text)
        if (state.draft && state.draft.trim()) return;
        render(container);
      }).catch(function () { /* keep old data */ });
    }, 60000);
  }

  // ------------------------------------------------- report button + issue banner on item pages

  function currentDetailsItemId() {
    var hash = location.hash || '';
    if (hash.indexOf('/details') === -1) return null;
    var m = /[?&]id=([0-9a-fA-F]{32})/.exec(hash);
    return m ? m[1] : null;
  }

  function onDetailsPage() {
    updateReportButton();
    updateIssueBanner();
  }

  function updateIssueBanner() {
    var existing = document.getElementById('nb-issue-banner');
    if (existing) existing.parentNode.removeChild(existing);

    var itemId = currentDetailsItemId();
    var page = document.getElementById('itemDetailPage');
    if (!itemId || !page || !creds()) return;

    api('/Noteboard/Notes/ForItem/' + itemId).then(function (notes) {
      if (!notes || !notes.length) return;
      // Re-check in case the user navigated away while loading
      if (currentDetailsItemId() !== itemId) return;
      renderIssueBanner(page, notes, itemId);
    }).catch(function () { /* no banner on failure */ });
  }

  function renderIssueBanner(page, notes, itemId) {
    var open = notes.filter(function (n) { return !n.Resolved; });
    var banner = el('div', 'nb-issue-banner');
    banner.id = 'nb-issue-banner';

    var head = el('div', 'nb-issue-banner-head');
    head.appendChild(el('span', 'nb-issue-banner-title',
      '⚠ ' + open.length + ' open issue' + (open.length === 1 ? '' : 's') +
      ' reported for this title' + (notes.length > open.length ? ' · ' + (notes.length - open.length) + ' resolved' : '')));
    var toggle = el('button', 'nb-btn nb-btn-ghost nb-banner-toggle', 'Hide');
    head.appendChild(toggle);
    banner.appendChild(head);

    var list = el('div', 'nb-issue-banner-list');
    notes.forEach(function (note) {
      var entry = el('div', 'nb-banner-note' + (note.Resolved ? ' nb-banner-note-resolved' : ''));
      var meta = el('div', 'nb-banner-note-meta');
      meta.appendChild(el('span', 'nb-note-author', note.UserName || 'unknown'));
      meta.appendChild(el('span', 'nb-note-date', fmtDate(note.CreatedUtc)));
      if (note.Resolved) meta.appendChild(el('span', 'nb-badge nb-badge-resolved', 'RESOLVED'));
      entry.appendChild(meta);
      entry.appendChild(el('div', 'nb-banner-note-text', note.Text));
      list.appendChild(entry);
    });
    banner.appendChild(list);

    toggle.addEventListener('click', function () {
      var hidden = list.style.display === 'none';
      list.style.display = hidden ? '' : 'none';
      toggle.textContent = hidden ? 'Hide' : 'Show';
    });

    // Insert right after the media button row — high on the page but clear of the toolbar.
    var buttons = page.querySelector('.mainDetailButtons');
    if (buttons && buttons.parentNode) {
      buttons.parentNode.insertBefore(banner, buttons.nextSibling);
    } else {
      banner.classList.add('nb-issue-banner-topspace');
      var content = page.querySelector('.detailPageContent') || page;
      content.insertBefore(banner, content.firstChild);
    }
  }

  function updateReportButton() {
    var existing = document.getElementById('nb-report-btn');
    var itemId = currentDetailsItemId();
    var page = document.getElementById('itemDetailPage');

    if (!itemId || !page || !creds()) {
      if (existing) existing.parentNode.removeChild(existing);
      return;
    }

    // Prefer sitting inline with the page's media buttons (Play, mark played, …).
    var buttonRow = page.querySelector('.mainDetailButtons');

    if (existing) {
      existing.dataset.itemId = itemId;
      if (buttonRow && existing.parentNode !== buttonRow) {
        buttonRow.appendChild(existing);
      }
      return;
    }

    var btn = el('button', 'nb-report-inline');
    btn.id = 'nb-report-btn';
    btn.type = 'button';
    btn.title = 'Report an issue with this title';
    btn.setAttribute('aria-label', 'Report an issue with this title');
    btn.dataset.itemId = itemId;
    btn.appendChild(el('span', 'nb-report-icon', '⚠'));
    btn.addEventListener('click', function () {
      openReportDialog(btn.dataset.itemId);
    });

    if (buttonRow) {
      buttonRow.appendChild(btn);
    } else {
      // Fallback: floating button if the button row wasn't found.
      btn.classList.add('nb-report-fab');
      page.appendChild(btn);
    }
  }

  function ensureConfig() {
    if (state.config) return Promise.resolve();
    return loadConfig().catch(function () { /* dialog still works without it */ });
  }

  function openReportDialog(itemId) {
    closeReportDialog();

    var overlay = el('div', 'nb-dialog-overlay');
    overlay.id = 'nb-report-dialog';

    var dialog = el('div', 'nb-dialog');
    dialog.appendChild(el('h3', 'nb-dialog-title', '⚠ Report an issue'));

    var itemLine = el('div', 'nb-dialog-item', 'Loading item…');
    dialog.appendChild(itemLine);

    var textarea = el('textarea', 'nb-textarea');
    textarea.placeholder = 'Describe the problem (wrong episode, bad subtitles, playback issue…)';
    textarea.maxLength = 4000;
    textarea.rows = 4;
    dialog.appendChild(textarea);

    var status = el('div', 'nb-dialog-status', '');
    dialog.appendChild(status);

    var btns = el('div', 'nb-dialog-actions');
    var cancel = el('button', 'nb-btn nb-btn-ghost', 'Cancel');
    cancel.addEventListener('click', closeReportDialog);
    btns.appendChild(cancel);

    var send = el('button', 'nb-btn nb-btn-primary', 'Send report');
    send.addEventListener('click', function () {
      var text = textarea.value.trim();
      if (!text) { textarea.focus(); return; }
      send.disabled = true;
      api('/Noteboard/Notes', { json: { text: text, isIssueReport: true, itemId: itemId } })
        .then(function () {
          closeReportDialog();
          updateIssueBanner();
          var container = document.getElementById(CONTAINER_ID);
          if (container) loadNotes().then(function () { render(container); });
        })
        .catch(function (err) {
          send.disabled = false;
          status.textContent = 'Could not send: ' + err.message;
        });
    });
    btns.appendChild(send);
    dialog.appendChild(btns);

    overlay.appendChild(dialog);
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) closeReportDialog();
    });
    document.body.appendChild(overlay);
    textarea.focus();

    // Show which item is being reported (server records the name regardless).
    ensureConfig().then(function () {
      var uid = state.me && state.me.userId;
      if (!uid) { itemLine.textContent = 'Attached item: ' + itemId; return; }
      return api('/Users/' + uid + '/Items/' + itemId).then(function (item) {
        if (item && document.getElementById('nb-report-dialog')) {
          itemLine.textContent = '🎬 ' + (itemTitle(item) || item.Name || itemId) +
            (item.Type ? ' (' + item.Type + ')' : '');
        }
      });
    }).catch(function () {
      itemLine.textContent = 'Attached item: ' + itemId;
    });
  }

  function closeReportDialog() {
    var dialog = document.getElementById('nb-report-dialog');
    if (dialog) dialog.parentNode.removeChild(dialog);
  }

  // Event-driven mounting: viewshow fires whenever the SPA shows a page,
  // hashchange covers direct navigation. No DOM observer — a subtree-wide
  // MutationObserver measurably slows down the Jellyfin home page.
  function onNavigate() {
    scheduleTryMount();
    onDetailsPage();
  }
  document.addEventListener('viewshow', onNavigate);
  window.addEventListener('hashchange', onNavigate);

  // Permanent cheap watchdog: self-heals if the SPA drops or reorders our element.
  setInterval(tryMount, 5000);

  scheduleTryMount();
  onDetailsPage();
})();
