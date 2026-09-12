/* SQLite for pages the agent builds — the part of /_kit/sqlite.js that is ours.
 *
 * The build wraps this file, sql.js (SQLite compiled to WebAssembly) and that
 * engine's binary into one script, which is why `initSqlJs` and `WASM_BASE64`
 * are in scope here without being defined. See scripts/build-panel-assets.mjs.
 *
 * Why it is shaped like this. A page has no server behind it and no network:
 * the pages CSP says `connect-src 'none'`, so `fetch` cannot reach even the
 * page's own folder, and neither can sql.js's usual way of loading its `.wasm`.
 * What a page *can* do is run a same-origin script. So the engine arrives inside
 * this script, and a page's database arrives the same way — the pages host
 * answers `data.sqlite.js` with a script carrying the bytes of `data.sqlite` —
 * and nothing here needs `connect-src` at all.
 *
 * The one CSP change this needed is `'wasm-unsafe-eval'`, which lets a page
 * compile WebAssembly and does nothing else: it is not `'unsafe-eval'`, and it
 * opens no connection. A page could already run any JavaScript it liked.
 *
 * Nothing goes back to the server, because there is no request that could carry
 * it. A visitor's changes stay in their own browser (IndexedDB) when the page
 * asks for `keep`, and leave it only as a file they choose to download.
 *
 *   const db = await Tulip.sqlite.open('data.sqlite');
 *   db.all('SELECT name, price FROM items WHERE price < ?', [10]);
 */
(function () {
  'use strict';

  var NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:sqlite3?|db)$/i;
  var HEADER = 'SQLite format 3\u0000';

  // The page's own folder, whichever way the visitor arrived: `/slug/`,
  // `/slug/index.html`, or `/slug` — where a relative URL would resolve one
  // level too high and look for the file at the root of the host.
  var slug = location.pathname.split('/').filter(Boolean)[0] || '';
  var folder = '/' + slug + '/';

  /** Every failure this file raises, named so the notice below can find it. */
  function problem(message) {
    var err = new Error(message);
    err.name = 'SqliteError';
    return err;
  }

  function describe(err) {
    return err && err.message ? err.message : String(err);
  }

  function fromBase64(text) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text);
    var binary = atob(text);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  // ── The engine ──────────────────────────────────────────────────────────────
  // Started on first use, so a page that links this file and never opens a
  // database pays for the download and nothing else.
  var engine = null;
  function ready() {
    if (engine === null) {
      var binary = fromBase64(WASM_BASE64);
      WASM_BASE64 = ''; // The decoded copy is what compiles; the text is dead weight.
      engine = initSqlJs({ wasmBinary: binary }).catch(function (err) {
        throw problem('SQLite could not start in this browser: ' + describe(err));
      });
    }
    return engine;
  }

  // ── A database that ships with the page ─────────────────────────────────────
  // The pages host defines the entry and this reads it once, then forgets it:
  // the bytes are the page's to keep, not the window's.
  var arrived = window.__tulipSqlite || (window.__tulipSqlite = {});
  var pending = {};

  function shipped(name) {
    if (!NAME.test(name)) {
      return Promise.reject(problem('"' + name + '" is not a database in this page’s folder — ' +
        'name the file like data.sqlite, data.sqlite3 or data.db, with no slashes'));
    }
    if (!pending[name]) {
      pending[name] = new Promise(function (resolve, reject) {
        var tag = document.createElement('script');
        tag.src = folder + name + '.js';
        tag.onload = function () {
          tag.remove();
          var text = arrived[name];
          delete arrived[name];
          if (typeof text !== 'string') {
            reject(problem(name + ' did not arrive'));
            return;
          }
          resolve(fromBase64(text));
        };
        tag.onerror = function () {
          tag.remove();
          reject(problem(name + ' could not be loaded — it is not in this page’s folder, ' +
            'or it is larger than a page may hold'));
        };
        document.head.appendChild(tag);
      });
      // A failure is not remembered, so trying again tries again.
      pending[name].catch(function () { delete pending[name]; });
    }
    return pending[name];
  }

  /** A copy SQLite will open, or an error saying why these are not a database. */
  function usable(bytes, label) {
    for (var i = 0; i < HEADER.length; i++) {
      if (bytes[i] !== HEADER.charCodeAt(i)) throw problem(label + ' is not a SQLite database');
    }
    var copy = bytes.slice();
    // A file last written in WAL mode says so in bytes 18 and 19, and an
    // in-memory copy has nowhere to keep a write-ahead log, so SQLite refuses
    // it outright. 1 is the ordinary rollback journal — what switching a
    // database out of WAL mode writes there. Anything still sitting in a -wal
    // file never reached these bytes either way; publishing says so.
    if (copy[18] === 2) copy[18] = 1;
    if (copy[19] === 2) copy[19] = 1;
    return copy;
  }

  /** Which version of the page's file a kept copy started from. Not a secret. */
  function fingerprint(bytes) {
    if (bytes === null) return '';
    var hash = 0x811c9dc5;
    for (var i = 0; i < bytes.length; i++) {
      hash ^= bytes[i];
      hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16) + ':' + bytes.length;
  }

  // ── Where a visitor's changes are kept ──────────────────────────────────────
  // IndexedDB rather than localStorage: a database is bytes, often megabytes,
  // and localStorage holds a few megabytes of strings. Keyed by page, because
  // every page shares one hostname and therefore one origin — which also means
  // this keeps things apart by convention, not by any boundary.
  var shelf = null;
  function store(mode, act) {
    if (shelf === null) {
      shelf = new Promise(function (resolve, reject) {
        var req = indexedDB.open('tulip-sqlite', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('databases'); };
        req.onsuccess = function () { resolve(req.result); };
        req.onerror = function () { reject(req.error); };
      });
      shelf.catch(function () { shelf = null; });
    }
    return shelf.then(function (idb) {
      return new Promise(function (resolve, reject) {
        var tx = idb.transaction('databases', mode);
        var req = act(tx.objectStore('databases'));
        tx.oncomplete = function () { resolve(req.result); };
        tx.onerror = tx.onabort = function () { reject(tx.error || req.error); };
      });
    });
  }

  // ── Parameters ──────────────────────────────────────────────────────────────
  // sql.js binds `{ ':id': 5 }` and silently binds NULL for `{ id: 5 }`, which
  // is the spelling everybody reaches for first. Binding a name the statement
  // does not use is ignored, so offering all three prefixes is harmless.
  function value(v) {
    if (v === undefined) return null;
    if (v instanceof Date) return v.toISOString();
    return v;
  }

  function parameters(params) {
    if (params === undefined || params === null) return null;
    if (Array.isArray(params)) return params.map(value);
    if (typeof params !== 'object' || ArrayBuffer.isView(params) || params instanceof Date) return [value(params)];
    var named = {};
    Object.keys(params).forEach(function (key) {
      var v = value(params[key]);
      if (/^[:$@]/.test(key)) named[key] = v;
      else named[':' + key] = named['$' + key] = named['@' + key] = v;
    });
    return named;
  }

  // ── Showing results ─────────────────────────────────────────────────────────
  // textContent throughout. A kept database holds whatever visitors typed into
  // it, and a page that rendered it as HTML would be running their markup.
  function table(rows, columns) {
    rows = rows || [];
    columns = columns || (rows.length > 0 ? Object.keys(rows[0]) : []);
    var wrap = document.createElement('div');
    wrap.className = 'rows';
    var grid = document.createElement('table');
    var head = grid.createTHead().insertRow();
    columns.forEach(function (name) {
      var th = document.createElement('th');
      th.textContent = name;
      head.appendChild(th);
    });
    var body = grid.createTBody();
    rows.forEach(function (row) {
      var tr = body.insertRow();
      columns.forEach(function (name) {
        var td = tr.insertCell();
        var v = row[name];
        if (v === null || v === undefined) {
          td.className = 'null';
          td.textContent = '—';
        } else if (v instanceof Uint8Array) {
          td.className = 'null';
          td.textContent = v.length + ' bytes';
        } else {
          if (typeof v === 'number') td.className = 'num';
          td.textContent = String(v);
        }
      });
    });
    if (rows.length === 0) {
      var none = body.insertRow().insertCell();
      none.className = 'none';
      none.colSpan = Math.max(columns.length, 1);
      none.textContent = 'No rows';
    }
    wrap.appendChild(grid);
    return wrap;
  }

  // ── One open database ───────────────────────────────────────────────────────
  function wrap(SQL, raw, state) {
    var functions = {};
    var timer = 0;
    var seen = 0;
    var dirty = false;
    var saving = Promise.resolve(true);

    function total() {
      return raw.exec('SELECT total_changes()')[0].values[0][0];
    }
    seen = total();

    /** Note a write, and save it shortly if this database is kept. */
    function after() {
      var now = total();
      if (now === seen) return;
      seen = now;
      dirty = true;
      if (state.kept) {
        clearTimeout(timer);
        timer = setTimeout(function () { flush(false); }, 300);
      }
    }

    // sql.js has one way to get the bytes out, and it closes and reopens the
    // connection: prepared statements, temp tables, functions and pragmas do not
    // survive it. Put back the two a page is likely to rely on.
    function snapshot() {
      var keys = raw.exec('PRAGMA foreign_keys')[0].values[0][0];
      var bytes = raw.export();
      if (keys) raw.exec('PRAGMA foreign_keys = ON');
      Object.keys(functions).forEach(function (name) { raw.create_function(name, functions[name]); });
      seen = total();
      return bytes;
    }

    // Closing the connection mid-transaction would roll it back, so a save waits
    // until the page commits. `BEGIN` is refused inside a transaction, which is
    // the only way sql.js lets anybody ask.
    function inTransaction() {
      try {
        raw.exec('BEGIN');
      } catch (err) {
        return true;
      }
      raw.exec('COMMIT');
      return false;
    }

    function flush(force) {
      clearTimeout(timer);
      timer = 0;
      if (!state.kept || (!dirty && !force)) return saving;
      if (inTransaction()) {
        timer = setTimeout(function () { flush(force); }, 300);
        return saving;
      }
      dirty = false;
      var bytes = snapshot();
      saving = saving.then(function () {
        return store('readwrite', function (s) {
          return s.put({ bytes: bytes, base: state.base, at: Date.now() }, state.key);
        });
      }).then(function () {
        return true;
      }, function (err) {
        dirty = true;
        console.warn('[sqlite] could not keep changes in this browser: ' + describe(err));
        return false;
      });
      return saving;
    }

    // A phone backgrounds a tab and may never bring it back. Hidden is the last
    // moment a save is sure to be allowed to run.
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush(false);
    });

    function statement(sql, params, visit) {
      var st;
      try {
        st = raw.prepare(sql);
        var bound = parameters(params);
        if (bound !== null) st.bind(bound);
        while (st.step()) {
          if (visit(st) === false) break;
        }
      } catch (err) {
        throw problem(describe(err) + ' — in: ' + String(sql).trim().slice(0, 160));
      } finally {
        if (st) st.free();
      }
      after();
    }

    var db = {
      /** Every row, as objects keyed by column name. */
      all: function (sql, params) {
        var rows = [];
        statement(sql, params, function (st) { rows.push(st.getAsObject()); });
        return rows;
      },
      /** The first row, or undefined. */
      get: function (sql, params) {
        var row;
        statement(sql, params, function (st) { row = st.getAsObject(); return false; });
        return row;
      },
      /** The first column of the first row, or undefined. */
      value: function (sql, params) {
        var v;
        statement(sql, params, function (st) { v = st.get()[0]; return false; });
        return v;
      },
      /** One statement that changes something. */
      run: function (sql, params) {
        statement(sql, params, function () {});
        return {
          changes: raw.getRowsModified(),
          lastId: raw.exec('SELECT last_insert_rowid()')[0].values[0][0],
        };
      },
      /** Several statements at once, with no parameters: a schema, a migration. */
      exec: function (sql) {
        try {
          raw.exec(sql);
        } catch (err) {
          throw problem(describe(err) + ' — in: ' + String(sql).trim().slice(0, 160));
        }
        after();
      },
      /** Names of the tables, for a page that wants to show what it holds. */
      tables: function () {
        return db.all("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
          .map(function (row) { return row.name; });
      },
      /** A styled table of a query's rows, safe to append whatever it holds. */
      table: function (sql, params) {
        var rows = [];
        var columns = null;
        statement(sql, params, function (st) {
          if (columns === null) columns = st.getColumnNames();
          rows.push(st.getAsObject());
        });
        if (columns === null) {
          // No rows, but a header still says what was asked for.
          var st = raw.prepare(sql);
          try { columns = st.getColumnNames(); } finally { st.free(); }
        }
        return table(rows, columns);
      },
      /** A JavaScript function callable from SQL, kept across saves. */
      fn: function (name, impl) {
        functions[name] = impl;
        raw.create_function(name, impl);
        return db;
      },
      /** Keep changes now rather than in a moment. Resolves true once they are. */
      save: function () {
        if (!state.kept) return Promise.resolve(false);
        if (inTransaction()) return Promise.reject(problem('finish the open transaction before saving'));
        return flush(false);
      },
      /** Back to the page's own file, forgetting this visitor's changes. */
      reset: function () {
        clearTimeout(timer);
        var forget = state.key === null || !state.kept
          ? Promise.resolve()
          : store('readwrite', function (s) { return s.delete(state.key); }).catch(function () {});
        return forget.then(function () {
          raw.close();
          raw = new SQL.Database(state.original === null ? undefined : usable(state.original, state.label));
          if (state.schema) raw.exec(state.schema);
          Object.keys(functions).forEach(function (name) { raw.create_function(name, functions[name]); });
          seen = total();
          dirty = false;
          db.outdated = false;
          return db;
        });
      },
      /** The database as it is now, as a file. */
      bytes: function () {
        return snapshot();
      },
      /** Hand the visitor the database as a file — the only way anything leaves. */
      download: function (filename) {
        var url = URL.createObjectURL(new Blob([snapshot()], { type: 'application/vnd.sqlite3' }));
        var link = document.createElement('a');
        link.href = url;
        link.download = filename || state.fileName || 'data.sqlite';
        link.hidden = true;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      },
      /** Whether changes survive a reload, in this browser. */
      kept: state.kept,
      /** Kept, and the page's own file has changed since this copy was taken. */
      outdated: state.outdated,
    };
    // The sql.js Database itself, for anything above does not cover. It is
    // replaced by reset(), so this is a getter rather than a copy.
    Object.defineProperty(db, 'raw', { get: function () { return raw; }, enumerable: true });
    return { db: db, flush: flush };
  }

  /**
   * Open a database.
   *
   *   open('data.sqlite')                   the file in this page's folder
   *   open('data.sqlite', { keep: true })   …and keep the visitor's changes
   *   open({ keep: 'notes', schema: '…' })  a database of their own, from nothing
   *   open(file)                            a File the visitor chose
   *
   * `keep` stores changes in this browser, under this page, and a kept copy is
   * what later visits open — unless the page hands `open` the bytes itself.
   * `schema` runs on every open, so write it with IF NOT EXISTS.
   */
  async function open(source, options) {
    if (source !== null && typeof source === 'object' && Object.getPrototypeOf(source) === Object.prototype &&
        options === undefined) {
      options = source;
      source = null;
    }
    options = options || {};

    var SQL = await ready();
    var fileName = typeof source === 'string' ? source : (source && typeof source.name === 'string' ? source.name : null);
    var label = fileName || 'that database';
    var original = null;
    var handed = false;
    if (typeof source === 'string') {
      original = await shipped(source);
    } else if (source instanceof Blob) {
      original = new Uint8Array(await source.arrayBuffer());
      handed = true;
    } else if (source instanceof ArrayBuffer) {
      original = new Uint8Array(source);
      handed = true;
    } else if (ArrayBuffer.isView(source)) {
      original = new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      handed = true;
    } else if (source !== null && source !== undefined) {
      throw problem('open() takes the name of a database in this page’s folder, a File, or nothing');
    }
    if (original !== null && original.length === 0) original = null;
    if (original !== null) usable(original, label);

    var keep = options.keep === true ? fileName
      : typeof options.keep === 'string' && options.keep.length > 0 ? options.keep : null;
    if (options.keep === true && keep === null) {
      throw problem('keep: true needs a name to keep the database under — use keep: "something"');
    }

    var state = {
      key: keep === null ? null : slug + '/' + keep,
      kept: false,
      outdated: false,
      base: fingerprint(original),
      original: original,
      label: label,
      fileName: fileName,
      schema: typeof options.schema === 'string' ? options.schema : '',
    };

    var saved = null;
    if (state.key !== null) {
      try {
        saved = await store('readonly', function (s) { return s.get(state.key); });
        state.kept = true;
      } catch (err) {
        console.warn('[sqlite] this browser will not keep changes: ' + describe(err));
      }
    }

    var first = original;
    if (!handed && saved && saved.bytes) {
      first = saved.bytes;
      state.outdated = saved.base !== state.base;
    }
    var raw = new SQL.Database(first === null ? undefined : usable(first, label));
    if (state.schema) {
      try {
        raw.exec(state.schema);
      } catch (err) {
        raw.close();
        throw problem('the schema did not run: ' + describe(err));
      }
    }

    var opened = wrap(SQL, raw, state);
    // Bytes the page handed over replace whatever was kept before: the visitor
    // chose that file, and a stale copy winning over it would be a surprise.
    if (handed && state.kept) await opened.flush(true);
    return opened.db;
  }

  // ── Saying so when it fails ─────────────────────────────────────────────────
  // A page that never catches its errors would otherwise fail as an empty box,
  // and the agent that built it reads pages as text and screenshots, not
  // consoles. Only errors raised here, and only when nothing else handled them.
  function notice(message) {
    var show = function () {
      var box = document.createElement('p');
      box.className = 'card sqlite-problem';
      box.setAttribute('role', 'alert');
      box.textContent = 'This page’s data could not be loaded: ' + message;
      (document.querySelector('main') || document.body).prepend(box);
    };
    if (document.body) show();
    else document.addEventListener('DOMContentLoaded', show);
  }
  window.addEventListener('unhandledrejection', function (event) {
    if (event.reason && event.reason.name === 'SqliteError') notice(event.reason.message);
  });
  window.addEventListener('error', function (event) {
    if (event.error && event.error.name === 'SqliteError') notice(event.error.message);
  });

  // ── Writing a change back to the page's own database ────────────────────────
  // The page cannot fetch — connect-src is 'none' — but it may submit a form to
  // its own host, and that is how a change reaches the server. This builds the
  // form the bridge expects and submits it, which navigates: the server applies
  // the change and redirects back, so the page reloads showing the new data.
  //
  // It only works on a page the operator has given a password, and the visitor
  // is asked for it once by the browser. Without one, the server refuses — a
  // page with no password cannot be written, by anyone.
  //
  //   Tulip.sqlite.submit({ db: 'roster.sqlite', table: 'shifts',
  //                         set: { status: 'Confirmed' }, where: { id: 7 } });
  //
  // Omit `where` to insert a row instead of updating one.
  function submit(options) {
    options = options || {};
    if (!options.table) throw problem('submit needs a table');
    var form = document.createElement('form');
    form.method = 'POST';
    form.action = folder; // the page's own directory; the host keys off the slug
    form.style.display = 'none';
    function field(name, value) {
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value == null ? '' : String(value);
      form.appendChild(input);
    }
    field('db', options.db || 'data.sqlite');
    field('table', options.table);
    var set = options.set || {};
    Object.keys(set).forEach(function (k) { field('set[' + k + ']', value(set[k])); });
    var where = options.where || {};
    Object.keys(where).forEach(function (k) { field('where[' + k + ']', value(where[k])); });
    document.body.appendChild(form);
    form.submit();
  }

  window.Tulip = window.Tulip || {};
  window.Tulip.sqlite = {
    open: open,
    table: table,
    /** Send a change to the page's own database. Needs the page to have a password. */
    submit: submit,
    /** The sql.js module itself, for anything open() does not cover. */
    engine: ready,
  };
})();
