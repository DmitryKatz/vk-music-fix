/*
 * VK Music Fix — ядро. Работает в контексте страницы ВК (world: MAIN, document_start).
 *
 * 1. Фикс скипов от AbortError: прерванный play() не считается «битым треком».
 * 2. Возврат трека после сбоя ВК: когда HlsAudioNode падает и ВК сам включает следующий
 *    трек (autoPlayNextAsRecovery), расширение возвращает упавший трек на ту же позицию.
 * 3. Кеш трека целиком: все сегменты плейлиста .m3u8 качаются заранее (параллельно, с повторами),
 *    плееру ВК отдаются те же байты из памяти. Ничего не расшифровываем, на диск не пишем.
 * 4. Отладка: ошибки ВК из консоли (с содержимым), сетевые запросы плеера, MediaSource,
 *    медиа-события, смены треков. Лог хранится в IndexedDB и может параллельно писаться в файл.
 */
(() => {
  'use strict';
  if (window.__vkfix) return;

  const VERSION = '1.2.0';
  const SESSION = Math.random().toString(36).slice(2, 7);
  const LS_KEY = 'vkfix:settings';
  const DEFAULTS = { playFix: true, undoSkip: true, cache: true, verbose: false, workerHook: false, panel: false };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch {}
  const settings = Object.assign({}, DEFAULTS, saved);
  const saveSettings = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(settings)); } catch {} };

  // ------------------------------------------------------------------ утилиты

  const p2 = n => String(n).padStart(2, '0');
  const ts = ms => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  };
  const fmtPos = s => (s == null || !isFinite(s) ? '?' : `${Math.floor(s / 60)}:${p2(Math.floor(s % 60))}`);
  // из логов вырезаем query-строки: там подписи и токены
  const redact = s => String(s).replace(/(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>)\]]*/g, '$1?…');

  function short(u) {
    try {
      const x = new URL(String(u), location.href);
      if (x.protocol === 'blob:') return 'blob:…' + x.pathname.slice(-6);
      if (x.protocol === 'data:') return 'data:…';
      return x.host + '/…/' + (x.pathname.split('/').filter(Boolean).pop() || '');
    } catch { return String(u).slice(0, 60); }
  }

  /** Аккуратно превращает что угодно (Error, объект ошибки hls, Event…) в читаемую строку. */
  function ser(v, depth = 0, seen = new WeakSet()) {
    try {
      if (v == null || typeof v === 'number' || typeof v === 'boolean') return String(v);
      if (typeof v === 'string') return v.length > 1000 ? v.slice(0, 1000) + '…' : v;
      if (typeof v === 'function') return `ƒ ${v.name || 'anonymous'}`;
      if (typeof v !== 'object') return String(v);
      if (seen.has(v)) return '[цикл]';
      seen.add(v);
      const get = k => { try { return v[k]; } catch { return '[getter упал]'; } };
      if (v instanceof Error || (typeof v.message === 'string' && typeof v.stack === 'string')) {
        let s = `${v.name || 'Error'}: ${v.message}`;
        const st = String(v.stack || '').split('\n').slice(1, 8).map(l => '        ' + l.trim()).join('\n');
        if (st) s += '\n' + st;
        const own = Object.getOwnPropertyNames(v).filter(k => !['stack', 'message', 'name'].includes(k));
        if (own.length && depth < 3) s += '\n        поля: ' + own.slice(0, 20).map(k => k + '=' + ser(get(k), depth + 1, seen)).join(', ');
        if (v.cause !== undefined && !own.includes('cause') && depth < 3) s += '\n        cause → ' + ser(v.cause, depth + 1, seen);
        return s;
      }
      if (typeof Event !== 'undefined' && v instanceof Event) {
        const t = v.target;
        return `Event(${v.type}${t && t.tagName ? ' на <' + t.tagName.toLowerCase() + '>' : ''})`;
      }
      if (typeof MediaError !== 'undefined' && v instanceof MediaError) return `MediaError(code=${v.code}, ${v.message})`;
      if (typeof Node !== 'undefined' && v instanceof Node) return `<${String(v.nodeName).toLowerCase()}>`;
      if (v instanceof ArrayBuffer) return `ArrayBuffer(${v.byteLength})`;
      if (ArrayBuffer.isView(v)) return `${v.constructor.name}(${v.byteLength} байт)`;
      if (depth >= 4) return Array.isArray(v) ? `[…${v.length}]` : '{…}';
      if (Array.isArray(v)) return '[' + v.slice(0, 20).map(x => ser(x, depth + 1, seen)).join(', ') + (v.length > 20 ? ', …' : '') + ']';
      const keys = Object.keys(v);
      const cn = v.constructor && v.constructor.name;
      const name = cn && cn !== 'Object' ? cn + ' ' : '';
      return name + '{' + keys.slice(0, 30).map(k => k + ': ' + ser(get(k), depth + 1, seen)).join(', ') + (keys.length > 30 ? ', …' : '') + '}';
    } catch { return '[не сериализуется]'; }
  }

  // ------------------------------------------------------------------ лог + приёмники (IndexedDB, файл)

  const logs = [];
  const sinks = [];
  let lastEntry = null;
  const lineOf = e => `${ts(e.t)} [${e.kind}] ${e.msg}`;
  const toSinks = line => { for (const s of sinks) { try { s(line); } catch {} } };

  function log(kind, msg) {
    msg = redact(String(msg)).slice(0, 6000);
    const now = Date.now();
    if (lastEntry && lastEntry.kind === kind && lastEntry.msg === msg && now - lastEntry.t2 < 5000) {
      lastEntry.n++;
      lastEntry.t2 = now;
      return;
    }
    if (lastEntry && lastEntry.n > 1) toSinks(`${ts(lastEntry.t2)} [${lastEntry.kind}]   ↑ повторилось ×${lastEntry.n}`);
    const e = { t: now, t2: now, kind, msg, n: 1 };
    logs.push(e);
    if (logs.length > 2500) logs.splice(0, logs.length - 2500);
    lastEntry = e;
    toSinks(lineOf(e));
  }

  const Persist = (() => {
    const MAX_LINES = 50000;
    let dbp = null;
    const pendingDb = [];
    const file = { handle: null, name: '', size: 0, state: 'off', queue: [], err: '', busy: false };

    function db() {
      if (!dbp) {
        dbp = new Promise((res, rej) => {
          const r = indexedDB.open('vkfix', 1);
          r.onupgradeneeded = () => {
            r.result.createObjectStore('log', { autoIncrement: true });
            r.result.createObjectStore('kv');
          };
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        dbp.catch(() => {});
      }
      return dbp;
    }
    const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
    async function kvGet(k) { const d = await db(); return req(d.transaction('kv').objectStore('kv').get(k)); }
    async function kvSet(k, v) { const d = await db(); return req(d.transaction('kv', 'readwrite').objectStore('kv').put(v, k)); }
    async function kvDel(k) { const d = await db(); return req(d.transaction('kv', 'readwrite').objectStore('kv').delete(k)); }

    let flushCount = 0;
    async function flushDb() {
      if (!pendingDb.length) return;
      const lines = pendingDb.splice(0, pendingDb.length);
      try {
        const d = await db();
        const tx = d.transaction('log', 'readwrite');
        const st = tx.objectStore('log');
        let lastKey = 0;
        for (const l of lines) st.add(l).onsuccess = ev => { lastKey = ev.target.result; };
        await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
        if (++flushCount % 30 === 0 && lastKey > MAX_LINES) {
          const tx2 = d.transaction('log', 'readwrite');
          tx2.objectStore('log').delete(IDBKeyRange.upperBound(lastKey - MAX_LINES));
        }
      } catch {}
    }

    const enc = new TextEncoder();
    async function flushFile() {
      if (file.state !== 'on' || file.busy || !file.queue.length) return;
      file.busy = true;
      const chunk = file.queue.splice(0, file.queue.length).join('\n') + '\n';
      try {
        const w = await file.handle.createWritable({ keepExistingData: true });
        await w.seek(file.size);
        await w.write(chunk);
        await w.close();
        file.size += enc.encode(chunk).length;
      } catch (e) {
        file.queue.unshift(chunk.replace(/\n$/, ''));
        file.state = 'error';
        file.err = e && e.message || String(e);
        log('err', 'запись лога в файл остановилась: ' + file.err);
      } finally {
        file.busy = false;
      }
    }

    sinks.push(line => {
      pendingDb.push(line);
      if (file.state !== 'off') {
        file.queue.push(line);
        if (file.queue.length > 30000) file.queue.splice(0, file.queue.length - 30000);
      }
    });
    setInterval(() => { flushDb(); flushFile(); }, 2000);
    window.addEventListener('pagehide', () => { flushDb(); flushFile(); });

    async function startFile(handle, fresh) {
      file.handle = handle;
      file.name = handle.name;
      file.size = fresh ? 0 : (await handle.getFile()).size;
      file.err = '';
      if (fresh) {
        file.queue = [`=== VK Music Fix ${VERSION} · лог начат ${ts(Date.now())} · ${navigator.userAgent} ===`]
          .concat(logs.map(lineOf));
      } else {
        file.queue.unshift(`=== VK Music Fix ${VERSION} · сессия ${SESSION} · ${ts(Date.now())} · страница перезагружена ===`);
      }
      file.state = 'on';
      await flushFile();
    }

    /** Кнопка «Писать в файл…» — вызывать прямо из обработчика клика. */
    async function pickFile() {
      if (typeof window.showSaveFilePicker !== 'function') throw new Error('браузер не умеет писать в файлы (нужен Chrome/Edge)');
      const d = new Date();
      const handle = await window.showSaveFilePicker({
        suggestedName: `vkfix-log-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.txt`,
        types: [{ description: 'Текстовый лог', accept: { 'text/plain': ['.txt'] } }],
      });
      await kvSet('fileHandle', handle);
      await startFile(handle, true);
      log('info', `лог пишется в файл ${handle.name}`);
    }

    /** «Продолжить запись» после перезагрузки страницы — тоже из клика. */
    async function regrant() {
      if (!file.handle) return false;
      const p = await file.handle.requestPermission({ mode: 'readwrite' });
      if (p !== 'granted') { file.state = 'paused'; return false; }
      await startFile(file.handle, false);
      log('info', `запись в ${file.name} продолжена`);
      return true;
    }

    async function stopFile() {
      await flushFile();
      file.state = 'off';
      file.queue = [];
      file.handle = null;
      try { await kvDel('fileHandle'); } catch {}
      log('info', 'запись лога в файл выключена');
    }

    async function resume() {
      try {
        const h = await kvGet('fileHandle');
        if (!h) return;
        file.handle = h;
        file.name = h.name;
        const p = await h.queryPermission({ mode: 'readwrite' });
        if (p === 'granted') {
          await startFile(h, false);
        } else {
          file.state = 'paused';
          // первый же клик по странице — просим разрешение продолжить запись
          const once = () => { window.removeEventListener('pointerdown', once, true); if (file.state === 'paused') regrant().catch(() => {}); };
          window.addEventListener('pointerdown', once, true);
        }
      } catch {}
    }

    async function allLines() {
      await flushDb();
      try {
        const d = await db();
        return await req(d.transaction('log').objectStore('log').getAll());
      } catch { return logs.map(lineOf); }
    }

    async function clearAll() {
      pendingDb.length = 0;
      try { const d = await db(); await req(d.transaction('log', 'readwrite').objectStore('log').clear()); } catch {}
    }

    return { file, pickFile, regrant, stopFile, resume, allLines, clearAll };
  })();

  log('info', `=== VK Music Fix ${VERSION} · сессия ${SESSION} · ${location.host}${location.pathname} ===`);
  Persist.resume();

  // ------------------------------------------------------------------ статистика

  const stats = {
    abortLoad: 0, abortPause: 0, saved: 0, resumed: 0, playErrors: 0,
    vkErrors: 0, autoSkips: 0, undone: 0, restoredPos: 0, fastSkips: 0, trackChanges: 0,
    mediaEls: 0, mediaErrors: 0, waiting: 0, stalled: 0,
    directSrc: 0, blobSrc: 0, mse: [], mseErrors: 0, workers: [],
    resFails: 0, jsErrors: 0, resTypes: {}, seeks: 0, stuck: 0,
  };

  // ------------------------------------------------------------------ консоль: ошибки ВК

  let lastVkError = null;   // { t, text }
  let failSnap = null;      // состояние плеера в момент сбоя
  let activeEl = null;      // медиа-элемент, который сейчас играет

  function bufferAhead(el) {
    try {
      const b = el.buffered, t = el.currentTime;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= t + 0.3 && b.end(i) >= t) return b.end(i) - t;
    } catch {}
    return 0;
  }

  function ranges(el) {
    try {
      const b = el.buffered, out = [];
      for (let i = 0; i < b.length && i < 5; i++) out.push(`${b.start(i).toFixed(2)}–${b.end(i).toFixed(1)}`);
      return out.length ? '[' + out.join(', ') + (b.length > 5 ? ', …' : '') + ']' : '[пусто]';
    } catch { return '[?]'; }
  }

  function snapshot(el) {
    if (!el) return 'медиа-элемент не найден';
    let s = '';
    try {
      s = `позиция ${fmtPos(el.currentTime)} (${el.currentTime.toFixed(2)}), буфер впереди ${bufferAhead(el).toFixed(1)} с, загружено ${ranges(el)}, ` +
        `paused=${el.paused}, readyState=${el.readyState}, networkState=${el.networkState}` +
        (el.error ? `, error=${el.error.code} ${el.error.message || ''}` : '');
    } catch {}
    return s;
  }

  function onVkError(text) {
    stats.vkErrors++;
    const now = Date.now();
    lastVkError = { t: now, text: text.split('\n')[0].slice(0, 200) };
    const title = lastTrack ? lastTrack.text : '';
    let pos = 0;
    try { pos = activeEl ? activeEl.currentTime : 0; } catch {}
    // если по позиции видно, что трек уже сменился на начало — берём позицию из последнего timeupdate
    if (lastPos.title === title && lastPos.t > pos) pos = lastPos.t;
    failSnap = { t: now, title, pos };
    log('ctx', `в момент ошибки ВК: «${title || '—'}», ${snapshot(activeEl)}`);
  }

  let inConsoleHook = false, conCount = 0, conWindow = Date.now();
  for (const level of ['error', 'warn']) {
    const orig = console[level];
    if (typeof orig !== 'function') continue;
    console[level] = function () {
      if (!inConsoleHook) {
        inConsoleHook = true;
        try {
          const now = Date.now();
          if (now - conWindow > 60000) { conWindow = now; conCount = 0; }
          if (++conCount <= 300) {
            const text = Array.from(arguments).map(a => ser(a)).join(' ');
            const isVk = level === 'error' && /ErrorLogger|Unknown error|HlsAudio|audioplayer|AudioNode/i.test(text);
            if (isVk) onVkError(text);
            log(isVk ? 'vk' : 'console', (level === 'warn' ? 'warn: ' : '') + text);
          }
        } catch {}
        inConsoleHook = false;
      }
      return orig.apply(this, arguments);
    };
  }

  const resSeen = new Set();
  window.addEventListener('error', e => {
    const t = e.target;
    if (t && t !== window && t.tagName) {
      if (t.tagName === 'IMG') return;
      stats.resFails++;
      const u = short(t.src || t.href || '');
      if (resSeen.has(u) && !settings.verbose) return;
      resSeen.add(u);
      log('res', `не загрузился <${t.tagName.toLowerCase()}>: ${u}`);
    } else if (e.message) {
      stats.jsErrors++;
      log('jserr', `${e.message} @ ${short(e.filename || '')}:${e.lineno}${e.error ? '\n' + ser(e.error) : ''}`);
    }
  }, true);
  window.addEventListener('unhandledrejection', e => {
    stats.jsErrors++;
    log('jserr', 'необработанный reject: ' + ser(e.reason));
  });

  // ------------------------------------------------------------------ медиа-элементы

  const MP = HTMLMediaElement.prototype;
  const origPlay = MP.play, origPause = MP.pause, origLoad = MP.load;
  const seen = new WeakMap();
  const lastPos = { title: '', t: 0 };

  function stackTop() {
    const lines = (new Error().stack || '').split('\n').slice(3, 8)
      .map(l => l.trim().replace(/^at\s+/, '').replace(/https?:\/\/[^/\s)]+\//g, '').slice(0, 120))
      .filter(l => !l.includes('chrome-extension'));
    return lines.length ? '\n        ← ' + lines.join('\n        ← ') : '';
  }

  const allEls = new Set();
  const anotherPlaying = el => [...allEls].some(x => x !== el && !x.paused && !x.ended);

  function watch(el) {
    if (seen.has(el)) return seen.get(el);
    const tag = el.tagName.toLowerCase() + '#' + (++stats.mediaEls);
    seen.set(el, tag);
    allEls.add(el);
    log('media', `найден ${tag}${el.isConnected ? '' : ' (создан в памяти)'}`);
    const quiet = new Set(['loadstart', 'loadedmetadata', 'canplay', 'seeking', 'seeked']);
    for (const ev of ['loadstart', 'loadedmetadata', 'canplay', 'play', 'playing', 'pause', 'waiting',
                      'stalled', 'seeking', 'seeked', 'ended', 'error', 'emptied', 'abort']) {
      el.addEventListener(ev, () => {
        if (ev === 'play' || ev === 'playing') activeEl = el;
        // предзагрузка следующего трека тоже шлёт loadstart — активным её не считаем, пока что-то играет
        if (ev === 'loadstart' && (!activeEl || activeEl.paused) && !anotherPlaying(el)) activeEl = el;
        if (ev === 'waiting') stats.waiting++;
        if (ev === 'stalled') stats.stalled++;
        if (ev === 'playing') onPlaying(el, tag);
        if (ev === 'error') {
          const er = el.error;
          if (er && /empty src/i.test(er.message || '')) {     // ВК создаёт пустые элементы — это не сбой
            if (settings.verbose) log('media', `${tag}: пустой src (штатно)`);
            return;
          }
          stats.mediaErrors++;
          log('err', `${tag}: ошибка медиа code=${er && er.code} ${er && er.message || ''} · ${snapshot(el)}`);
          return;
        }
        if (ev === 'play') return;
        if (quiet.has(ev) && !settings.verbose) return;
        let extra = '';
        try {
          extra = ` t=${el.currentTime.toFixed(1)}`;
          if (ev === 'waiting' || ev === 'stalled') extra += `, буфер впереди ${bufferAhead(el).toFixed(1)} с, загружено ${ranges(el)}`;
        } catch {}
        log(ev === 'waiting' || ev === 'stalled' ? 'warn' : 'media', `${tag}: ${ev}${extra}`);
      });
    }
    el.addEventListener('timeupdate', () => {
      if (el !== activeEl || !lastTrack) return;
      lastPos.title = lastTrack.text;
      lastPos.t = el.currentTime;
    });
    return tag;
  }

  function noteSrc(el, v) {
    const tag = watch(el);
    const s = String(v || '');
    let full = s;
    try { full = s ? new URL(s, location.href).href : ''; } catch {}
    if (full.startsWith('blob:')) stats.blobSrc++;
    else if (/^https?:/i.test(full)) stats.directSrc++;
    log('media', `${tag}: src = ${s ? short(full) : '(пусто)'}${settings.verbose ? stackTop() : ''}`);
  }

  MP.play = function () {
    const el = this;
    const tag = watch(el);
    if (settings.verbose) log('call', `${tag}.play()${stackTop()}`);
    const p = origPlay.apply(el, arguments);
    if (!p || typeof p.catch !== 'function') return p;
    return p.catch(e => {
      if (e && e.name === 'AbortError') {
        const byLoad = /load/i.test(e.message);
        if (byLoad) stats.abortLoad++; else stats.abortPause++;
        if (!settings.playFix) {
          log('warn', `${tag}: AbortError (фикс выключен): ${e.message}`);
          throw e;
        }
        stats.saved++;
        log('fix', `${tag}: прерванный play() не даём считать ошибкой (${byLoad ? 'новый load()' : 'pause()'})`);
        if (!byLoad) return undefined;
        return new Promise(resolve => {
          let done = false;
          const finish = () => { if (!done) { done = true; el.removeEventListener('canplay', go); resolve(); } };
          const go = () => {
            if (done) return;
            if (anotherPlaying(el)) { finish(); return; }        // уже играет другой элемент — не мешаем
            origPlay.call(el).then(() => {
              stats.resumed++;
              log('fix', `${tag}: трек запущен после прерывания`);
              finish();
            }, finish);
          };
          el.addEventListener('canplay', go, { once: true });
          setTimeout(finish, 4000);
        });
      }
      stats.playErrors++;
      log('err', `${tag}: play() → ${ser(e)}`);
      throw e;
    });
  };
  MP.pause = function () {
    if (settings.verbose) log('call', `${watch(this)}.pause()${stackTop()}`);
    return origPause.apply(this, arguments);
  };
  MP.load = function () {
    if (settings.verbose) log('call', `${watch(this)}.load()${stackTop()}`);
    return origLoad.apply(this, arguments);
  };
  const srcDesc = Object.getOwnPropertyDescriptor(MP, 'src');
  if (srcDesc && srcDesc.set) {
    Object.defineProperty(MP, 'src', {
      configurable: true,
      enumerable: srcDesc.enumerable,
      get() { return srcDesc.get.call(this); },
      set(v) { noteSrc(this, v); srcDesc.set.call(this, v); },
    });
  }
  const ctDesc = Object.getOwnPropertyDescriptor(MP, 'currentTime');
  if (ctDesc && ctDesc.set) {
    Object.defineProperty(MP, 'currentTime', {
      configurable: true,
      enumerable: ctDesc.enumerable,
      get() { return ctDesc.get.call(this); },
      set(v) {
        try {
          const from = ctDesc.get.call(this);
          if (Math.abs(from - v) > 1 || settings.verbose) {
            stats.seeks++;
            log('media', `${watch(this)}: перемотка ${from.toFixed(2)} → ${(+v).toFixed(2)}${settings.verbose ? stackTop() : ''}`);
          }
        } catch {}
        ctDesc.set.call(this, v);
      },
    });
  }

  // детектор «играет, но стоит на месте»
  let stuckEl = null, stuckT = -1, stuckFor = 0, stuckLogged = false;
  setInterval(() => {
    const el = activeEl;
    if (!el) return;
    if (el !== stuckEl) { stuckEl = el; stuckT = -1; stuckFor = 0; stuckLogged = false; }
    let t;
    try { t = el.currentTime; } catch { return; }
    if (el.paused || el.ended || el.seeking || t !== stuckT) {
      if (stuckLogged) log('info', `${seen.get(el)}: поехало дальше после ${stuckFor} с стояния`);
      stuckT = t; stuckFor = 0; stuckLogged = false;
      return;
    }
    stuckFor++;
    if (stuckFor >= 5 && !stuckLogged) {
      stuckLogged = true;
      stats.stuck++;
      let extra = '';
      try { extra = `, rate=${el.playbackRate}, muted=${el.muted}, volume=${el.volume.toFixed(2)}`; } catch {}
      log('warn', `${seen.get(el)}: «играет», но стоит на месте уже 5 с — ${snapshot(el)}${extra}`);
    }
  }, 1000);

  const origSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if (this instanceof HTMLMediaElement && String(name).toLowerCase() === 'src') noteSrc(this, value);
    return origSetAttr.apply(this, arguments);
  };

  // ------------------------------------------------------------------ MediaSource

  if (window.MediaSource && MediaSource.prototype.addSourceBuffer) {
    const watchedMs = new WeakSet();
    const asb = MediaSource.prototype.addSourceBuffer;
    MediaSource.prototype.addSourceBuffer = function (mime) {
      if (!stats.mse.includes(mime)) stats.mse.push(mime);
      log('mse', `addSourceBuffer(${mime})`);
      if (!watchedMs.has(this)) {
        watchedMs.add(this);
        this.addEventListener('sourceended', () => log('mse', 'MediaSource: sourceended'));
        this.addEventListener('sourceclose', () => { if (settings.verbose) log('mse', 'MediaSource: sourceclose'); });
      }
      let sb;
      try { sb = asb.apply(this, arguments); } catch (e) { stats.mseErrors++; log('err', `addSourceBuffer(${mime}) → ${ser(e)}`); throw e; }
      sb.addEventListener('error', () => { stats.mseErrors++; log('err', `SourceBuffer(${mime}): событие error`); });
      return sb;
    };
    const eos = MediaSource.prototype.endOfStream;
    MediaSource.prototype.endOfStream = function (err) {
      if (err) { stats.mseErrors++; log('err', `MediaSource.endOfStream("${err}")`); }
      return eos.apply(this, arguments);
    };
    if (window.SourceBuffer) {
      for (const name of ['appendBuffer', 'remove', 'changeType']) {
        const orig = SourceBuffer.prototype[name];
        if (typeof orig !== 'function') continue;
        SourceBuffer.prototype[name] = function () {
          try { return orig.apply(this, arguments); } catch (e) {
            stats.mseErrors++;
            log('err', `SourceBuffer.${name} → ${ser(e)}`);
            throw e;
          }
        };
      }
    }
  }

  // ------------------------------------------------------------------ сеть: кеш трека целиком
  // Функция самодостаточная (ничего не берёт снаружи) — её же текст вставляется в воркеры.

  function installNetHook(G, cfg, report) {
    const S = { m3u8: 0, playlists: 0, files: 0, filesOk: 0, bytes: 0, hits: 0, waits: 0, misses: 0,
                retries: 0, failed: 0, fullTracks: 0, reqOk: 0, reqFail: 0, reqSlow: 0, reqAbort: 0, otherFail: 0,
                viaXhr: 0, viaFetch: 0 };
    const PL_RE = /\.m3u8(?:[?#]|$)/i;
    const THREADS = 3;            // всего фоновых загрузок одновременно
    const PER_HOST = 2;           // с одного сервера — не больше двух: зависший узел не съест всё
    const TRIES = 3;
    const ATTEMPT_TIMEOUT = 15000; // одна попытка скачать файл
    const PLAYER_WAIT = 3000;      // плеер ждёт нашу загрузку максимум 3 с, потом качает сам
    const HOST_PAUSE = 120000;     // сервер, который дважды не ответил, 2 минуты не трогаем
    const MAX_PL = 4;
    const cache = new Map();
    const known = new Set();            // все адреса из увиденных плейлистов (для лога, даже при выключенном кеше)
    const playlists = [];
    let queue = [];
    let active = 0;
    const hostActive = new Map();
    const hostHealth = new Map();       // host → { fails: [время], pausedUntil }
    S.badHosts = {};                    // host → сколько раз тормозил/падал (для панели)
    S.blocked = 0;                      // сторонние запросы, отрезанные за доли секунды (обычно блокировщик рекламы)
    let blockedNoted = false, otherLogged = 0;
    const realFetch = typeof G.fetch === 'function' ? G.fetch : null;
    const XP = G.XMLHttpRequest && G.XMLHttpRequest.prototype;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const base = () => { try { return G.location.href; } catch { return undefined; } };
    const abs = (u, b) => { try { return new URL(String(u), b).href; } catch { return null; } };
    const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };
    const short = u => {
      try { const x = new URL(u); return x.host + '/…/' + (x.pathname.split('/').filter(Boolean).pop() || ''); }
      catch { return String(u).slice(0, 60); }
    };
    const isAudio = u => {
      if (!u) return false;
      if (PL_RE.test(u) || known.has(u)) return true;
      try { return /audio/i.test(new URL(u).host); } catch { return false; }
    };

    function noteBadHost(h) { S.badHosts[h] = (S.badHosts[h] || 0) + 1; }

    function noteResult(url, status, ms, how) {
      const audio = isAudio(url);
      if (how === 'abort') {
        if (audio) { S.reqAbort++; report('net', `плеер отменил запрос ${short(url)} через ${ms} мс`); }
        return;
      }
      const ok = status >= 200 && status < 400;
      if (!audio) {
        if (ok || (status !== 0 && status < 500)) return;
        if (status === 0 && ms < 400) {
          S.blocked++;
          if (!blockedNoted) {
            blockedNoted = true;
            report('info', `сторонние запросы (реклама/статистика) обрываются за доли секунды — похоже на блокировщик рекламы, на музыку не влияет. Пример: ${short(url)}`);
          } else if (cfg.verbose) report('net', `заблокирован: ${short(url)} за ${ms} мс`);
        } else {
          S.otherFail++;
          if (cfg.verbose || otherLogged++ < 10) report('net', `сбой запроса сайта: ${short(url)} → ${status || 'нет ответа'} за ${ms} мс`);
        }
        return;
      }
      if (ok) {
        S.reqOk++;
        if (ms > 4000) {
          S.reqSlow++;
          noteBadHost(hostOf(url));
          report('net', `медленно: ${short(url)} → ${status} за ${ms} мс`);
        } else if (cfg.verbose || PL_RE.test(url)) report('net', `${short(url)} → ${status} за ${ms} мс`);
      } else {
        S.reqFail++;
        noteBadHost(hostOf(url));
        report('err', `запрос плеера не прошёл: ${short(url)} → ${status || 'нет ответа (сеть/CORS)'}${how === 'timeout' ? ' (таймаут)' : ''} за ${ms} мс`);
      }
    }

    function hostPaused(h) {
      const hh = hostHealth.get(h);
      return !!(hh && hh.pausedUntil > Date.now());
    }

    function hostFailed(h) {
      const now = Date.now();
      const hh = hostHealth.get(h) || { fails: [], pausedUntil: 0 };
      hh.fails = hh.fails.filter(t => now - t < HOST_PAUSE).concat(now);
      hostHealth.set(h, hh);
      noteBadHost(h);
      if (hh.fails.length >= 2 && hh.pausedUntil < now) {
        hh.pausedUntil = now + HOST_PAUSE;
        report('warn', `сервер ${h} не отвечает — 2 минуты не качаю с него заранее, плеер берёт файлы сам`);
        for (const [, e] of cache) {
          if (e.host === h && e.state === 'queued') { e.state = 'skip'; e.resolve(); }
        }
      }
    }

    async function download(url, e) {
      let delay = 500, last;
      for (let i = 0; i < TRIES; i++) {
        if (hostPaused(e.host)) { const x = new Error('сервер на паузе'); x.skip = true; throw x; }
        if (e.state !== 'loading') { const x = new Error('уже не нужен'); x.skip = true; throw x; }
        const ac = typeof AbortController === 'function' ? new AbortController() : null;
        const timer = ac ? setTimeout(() => ac.abort(), ATTEMPT_TIMEOUT) : null;
        try {
          const r = await realFetch.call(G, url, { credentials: e.creds ? 'include' : 'omit', signal: ac ? ac.signal : undefined });
          if ([401, 403, 404, 410].includes(r.status)) {
            const x = new Error('HTTP ' + r.status);
            x.fatal = true;
            throw x;
          }
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const buf = await r.arrayBuffer();
          const len = +r.headers.get('content-length');
          if (len && buf.byteLength < len) throw new Error(`обрыв на ${buf.byteLength}/${len} байт`);
          return { buf, type: r.headers.get('content-type') || '' };
        } catch (err) {
          if (err.fatal) throw err;
          last = err && err.name === 'AbortError' ? new Error(`нет ответа ${ATTEMPT_TIMEOUT / 1000} с`) : err;
          S.retries++;
          if (!/^HTTP /.test(last.message)) hostFailed(e.host);
          report('net', `кеш: попытка ${i + 1}/${TRIES} для ${short(url)} не удалась (${last.message})`);
        } finally {
          if (timer) clearTimeout(timer);
        }
        await sleep(delay);
        delay = Math.min(delay * 2, 4000);
      }
      throw last || new Error('сеть не отвечает');
    }

    function entry(url, creds) {
      let e = cache.get(url);
      if (!e) {
        let resolve;
        const done = new Promise(r => { resolve = r; });
        e = { state: 'queued', done, resolve, data: null, type: '', creds: !!creds, host: hostOf(url) };
        cache.set(url, e);
      }
      return e;
    }

    function startDownload(url, e) {
      e.state = 'loading';
      active++;
      hostActive.set(e.host, (hostActive.get(e.host) || 0) + 1);
      download(url, e).then(({ buf, type }) => {
        e.data = buf;
        e.type = type;
        e.state = 'ok';
        S.filesOk++;
        S.bytes += buf.byteLength;
        checkFull();
      }, err => {
        if (err.skip) { if (e.state === 'loading') e.state = 'skip'; return; }
        e.state = 'fail';
        S.failed++;
        report('err', `кеш: не скачался ${short(url)}: ${err.message} — плеер возьмёт его из сети сам`);
      }).finally(() => {
        active--;
        hostActive.set(e.host, hostActive.get(e.host) - 1);
        e.resolve();
        pump();
      });
    }

    function pump() {
      for (let i = 0; i < queue.length && active < THREADS;) {
        const url = queue[i];
        const e = cache.get(url);
        if (!e || e.state !== 'queued') { queue.splice(i, 1); continue; }
        if (hostPaused(e.host)) { e.state = 'skip'; e.resolve(); queue.splice(i, 1); continue; }
        if ((hostActive.get(e.host) || 0) >= PER_HOST) { i++; continue; }
        queue.splice(i, 1);
        startDownload(url, e);
      }
    }

    function checkFull() {
      for (const p of playlists) {
        if (p.full) continue;
        if (p.items.every(u => { const e = cache.get(u); return e && e.state === 'ok'; })) {
          p.full = true;
          S.fullTracks++;
          const mb = p.items.reduce((a, u) => a + cache.get(u).data.byteLength, 0) / 1048576;
          report('cache', `трек целиком в кеше: ${p.items.length} файлов, ${mb.toFixed(1)} МБ за ${((Date.now() - p.t0) / 1000).toFixed(1)} с`);
        }
      }
    }

    function evict(p) {
      const keep = new Set();
      for (const x of playlists) for (const u of x.items) keep.add(u);
      for (const u of p.items) {
        if (keep.has(u)) continue;
        const e = cache.get(u);
        if (e) {
          if (e.data) S.bytes -= e.data.byteLength;
          if (e.state === 'queued' || e.state === 'loading') e.state = 'skip';
          e.resolve();
          cache.delete(u);
        }
      }
      queue = queue.filter(u => cache.has(u));
    }

    function onPlaylist(url, text, withCreds) {
      S.m3u8++;
      if (!/#EXTINF/.test(text)) return;     // мастер-плейлист
      const items = [];
      let dur = 0;
      for (const raw of text.split(/\r?\n/)) {
        const l = raw.trim();
        if (!l) continue;
        if (l[0] === '#') {
          if (l.startsWith('#EXTINF:')) dur += parseFloat(l.slice(8)) || 0;
          if (/^#EXT-X-(KEY|MAP):/.test(l)) {
            const m = /URI="([^"]+)"/.exec(l);
            if (m && !/^(data|skd):/i.test(m[1])) {
              const k = abs(m[1], url);
              if (k && !items.includes(k)) items.push(k);
            }
          }
        } else {
          const s = abs(l, url);
          if (s) items.push(s);
        }
      }
      if (known.size > 20000) known.clear();
      for (const u of items) known.add(u);
      report('net', `плейлист ${short(url)}: ${items.length} файлов, ${Math.round(dur)} с`);
      if (!cfg.cache || !items.length) return;
      const h = hostOf(items[items.length - 1]);
      if (hostPaused(h)) { report('net', `кеш: ${h} на паузе — этот трек плеер грузит сам`); return; }
      const prev = playlists.find(p => p.url === url);
      if (prev) { playlists.splice(playlists.indexOf(prev), 1); playlists.push(prev); }
      else {
        playlists.push({ url, items, t0: Date.now(), full: false });
        S.playlists++;
        S.files += items.length;
        while (playlists.length > MAX_PL) evict(playlists.shift());
        report('cache', `кеш: качаю трек целиком (${items.length} файлов)`);
      }
      // свежий плейлист — это трек, который сейчас нужен: его файлы встают в начало очереди
      const fresh = [];
      for (const u of items) {
        const e = entry(u, withCreds);
        if (e.state === 'queued') fresh.push(u);
      }
      const set = new Set(fresh);
      queue = fresh.concat(queue.filter(u => !set.has(u)));
      pump();
      checkFull();
    }

    /** Что делать с запросом плеера: отдать из кеша, подождать нашу загрузку или пустить в сеть. */
    function decide(e) {
      if (!e) return 'net';
      if (e.state === 'ok') return 'hit';
      if (e.state === 'loading') return 'wait';
      if (e.state === 'queued') {          // мы до файла ещё не дошли — пусть плеер берёт сам, не ждём очередь
        e.state = 'player';
        e.resolve();
      }
      return 'net';
    }
    const waitShort = e => Promise.race([e.done, sleep(PLAYER_WAIT)]);

    function abortable(p, signal) {
      if (!signal) return p;
      return new Promise((res, rej) => {
        const ab = () => rej(new DOMException('The operation was aborted.', 'AbortError'));
        if (signal.aborted) return ab();
        signal.addEventListener('abort', ab, { once: true });
        p.then(res, res);
      });
    }

    // --- fetch
    if (realFetch) {
      G.fetch = function (input, init) {
        const args = arguments;
        let url = null, method = 'GET', range = false, creds = 'same-origin', signal = null;
        try {
          const isReq = typeof Request !== 'undefined' && input instanceof Request;
          url = abs(isReq ? input.url : (input && input.href) || input, base());
          method = String((init && init.method) || (isReq && input.method) || 'GET').toUpperCase();
          range = new Headers((init && init.headers) || (isReq ? input.headers : undefined)).has('range');
          creds = (init && init.credentials) || (isReq && input.credentials) || 'same-origin';
          signal = (init && init.signal) || (isReq && input.signal) || null;
        } catch {}
        const t0 = Date.now();
        if (url && isAudio(url)) S.viaFetch++;
        const tracked = () => realFetch.apply(G, args).then(r => {
          if (url) noteResult(url, r.status, Date.now() - t0);
          return r;
        }, err => {
          if (url) noteResult(url, 0, Date.now() - t0, err && err.name === 'AbortError' ? 'abort' : 'fail');
          throw err;
        });
        if (!url || method !== 'GET' || range) return tracked();

        if (PL_RE.test(url)) {
          return tracked().then(async r => {
            try { if (r.ok) onPlaylist(r.url || url, await r.clone().text(), creds === 'include'); } catch {}
            return r;
          });
        }
        const e = cfg.cache ? cache.get(url) : null;
        const d = decide(e);
        if (d === 'net') { if (e) S.misses++; return tracked(); }
        return (async () => {
          if (d === 'wait') {
            S.waits++;
            await abortable(waitShort(e), signal);
          }
          if (e.state === 'ok') {
            S.hits++;
            if (cfg.verbose) report('hit', `из кеша (fetch): ${short(url)}`);
            const r = new Response(e.data.slice(0), {
              status: 200, statusText: 'OK',
              headers: { 'Content-Type': e.type || 'application/octet-stream', 'Content-Length': String(e.data.byteLength) },
            });
            try { Object.defineProperty(r, 'url', { value: url }); } catch {}
            return r;
          }
          S.misses++;
          if (cfg.verbose) report('net', `кеш не успел (${short(url)}) — плеер качает сам`);
          return tracked();
        })();
      };
    }

    // --- XMLHttpRequest
    if (XP) {
      const xOpen = XP.open, xSend = XP.send, xAbort = XP.abort, xSetHeader = XP.setRequestHeader;
      const OVR = ['readyState', 'status', 'statusText', 'response', 'responseText', 'responseURL',
                   'getResponseHeader', 'getAllResponseHeaders'];

      XP.open = function (method, url) {
        if (this.__vf && this.__vf.faked) for (const k of OVR) delete this[k];
        const st = this.__vf = {
          method: String(method).toUpperCase(),
          url: abs(url, base()),
          async: arguments.length < 3 || !!arguments[2],
          range: false, aborted: false, faked: false,
        };
        if (st.url && st.method === 'GET' && PL_RE.test(st.url)) {
          // слушатель ставится ДО обработчиков плеера → плейлист разбираем раньше,
          // чем плеер успеет запросить первый сегмент
          this.addEventListener('readystatechange', () => {
            if (this.__vf !== st || this.readyState !== 4 || this.status < 200 || this.status >= 300) return;
            try {
              const rt = this.responseType;
              const txt = rt === '' || rt === 'text' ? this.responseText
                : rt === 'arraybuffer' ? new TextDecoder().decode(this.response) : null;
              if (txt) onPlaylist(this.responseURL || st.url, txt, this.withCredentials);
            } catch {}
          });
        }
        return xOpen.apply(this, arguments);
      };
      XP.setRequestHeader = function (k) {
        if (this.__vf && /^range$/i.test(String(k))) this.__vf.range = true;
        return xSetHeader.apply(this, arguments);
      };
      XP.abort = function () {
        if (this.__vf) this.__vf.aborted = true;
        return xAbort.apply(this, arguments);
      };

      function fakeXhr(xhr, st, e) {
        const rt = xhr.responseType;
        let resp;
        if (rt === 'arraybuffer') resp = e.data.slice(0);
        else if (rt === 'blob') resp = new Blob([e.data], { type: e.type });
        else if ((rt === '' || rt === 'text') && /text|mpegurl/i.test(e.type)) resp = new TextDecoder().decode(e.data);
        else return false;
        const total = e.data.byteLength;
        const hdrs = { 'content-type': e.type || 'application/octet-stream', 'content-length': String(total) };
        const val = (k, v) => Object.defineProperty(xhr, k, { configurable: true, get: () => v });
        const fn = (k, f) => Object.defineProperty(xhr, k, { configurable: true, writable: true, value: f });
        const fire = (type, init) => xhr.dispatchEvent(init ? new ProgressEvent(type, init) : new Event(type));
        st.faked = true;
        fn('getResponseHeader', n => (Object.prototype.hasOwnProperty.call(hdrs, String(n).toLowerCase()) ? hdrs[String(n).toLowerCase()] : null));
        fn('getAllResponseHeaders', () => Object.entries(hdrs).map(([k, v]) => k + ': ' + v).join('\r\n') + '\r\n');
        val('status', 200);
        val('statusText', 'OK');
        val('responseURL', st.url);
        const pe = { lengthComputable: true, loaded: total, total };
        fire('loadstart', { lengthComputable: true, loaded: 0, total });
        val('readyState', 2); fire('readystatechange');
        if (st.aborted) return true;
        val('readyState', 3); fire('readystatechange');
        fire('progress', pe);
        val('response', resp);
        if (typeof resp === 'string') val('responseText', resp);
        val('readyState', 4); fire('readystatechange');
        fire('load', pe);
        fire('loadend', pe);
        return true;
      }

      function nativeSend(xhr, st, args) {
        if (st.url) {
          const t0 = Date.now();
          let how = 'fail';
          xhr.addEventListener('timeout', () => { how = 'timeout'; });
          xhr.addEventListener('loadend', () => {
            if (xhr.__vf !== st || st.faked) return;
            noteResult(st.url, xhr.status, Date.now() - t0, st.aborted ? 'abort' : how);
          });
        }
        return xSend.apply(xhr, args);
      }

      XP.send = function () {
        const st = this.__vf;
        const args = arguments;
        if (st && st.url && isAudio(st.url)) S.viaXhr++;
        if (!st || !cfg.cache || st.method !== 'GET' || !st.async || st.range || !st.url) return nativeSend(this, st || {}, args);
        const e = cache.get(st.url);
        const d = decide(e);
        if (d === 'net') { if (e) S.misses++; return nativeSend(this, st, args); }
        const xhr = this;
        const finish = () => {
          if (st.aborted || xhr.__vf !== st) return;
          if (e.state === 'ok' && fakeXhr(xhr, st, e)) {
            S.hits++;
            if (cfg.verbose) report('hit', `из кеша (xhr): ${short(st.url)}`);
            return;
          }
          S.misses++;
          if (cfg.verbose) report('net', `кеш не успел (${short(st.url)}) — плеер качает сам`);
          nativeSend(xhr, st, args);    // запрос всё ещё в состоянии OPENED — отправляем как было
        };
        if (d === 'hit') { setTimeout(finish, 0); return undefined; }
        S.waits++;
        waitShort(e).then(finish);
        return undefined;
      };
    }

    return { S, isAudio, setCfg: c => Object.assign(cfg, c) };
  }

  const net = installNetHook(window, { cache: settings.cache, verbose: settings.verbose }, (k, m) => log(k, m));

  // какие ресурсы аудио грузит страница и каким способом (fetch/xhr/audio/…)
  try {
    if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(10000);
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        if (!net.isAudio(e.name) || e.initiatorType === 'xmlhttprequest' || e.initiatorType === 'fetch') continue;
        stats.resTypes[e.initiatorType] = (stats.resTypes[e.initiatorType] || 0) + 1;
        if (e.initiatorType !== 'xmlhttprequest' && e.initiatorType !== 'fetch' && settings.verbose)
          log('net', `ресурс ${short(e.name)} (${e.initiatorType}) ${Math.round(e.duration)} мс, статус ${e.responseStatus || '?'}`);
      }
    }).observe({ type: 'resource', buffered: true });
  } catch {}

  // ------------------------------------------------------------------ воркеры

  const workerStats = new Map();
  let bc = null;
  try {
    bc = new BroadcastChannel('vkfix');
    bc.onmessage = ev => {
      const d = ev.data || {};
      if (d.t === 'log') log(d.kind, '[воркер] ' + d.msg);
      else if (d.t === 'stats') workerStats.set(d.id, d.S);
    };
  } catch {}

  if (typeof window.Worker === 'function') {
    const W = window.Worker;
    const hookWorkers = settings.workerHook;
    const Wrapped = function Worker(url, opts) {
      let u = String(url);
      try { u = new URL(u, location.href).href; } catch {}
      const isModule = !!(opts && opts.type === 'module');
      stats.workers.push(short(u) + (isModule ? ' (module)' : ''));
      if (hookWorkers && !isModule) {
        try {
          const cfg = JSON.stringify({ cache: settings.cache, verbose: settings.verbose });
          const code =
            '(function(){try{var bc=new BroadcastChannel("vkfix");var id=Math.random().toString(36).slice(2,7);' +
            'var h=(' + installNetHook.toString() + ')(self,' + cfg + ',function(k,m){bc.postMessage({t:"log",kind:k,msg:m});});' +
            'bc.onmessage=function(e){if(e.data&&e.data.t==="cfg")h.setCfg(e.data.cfg);};' +
            'setInterval(function(){bc.postMessage({t:"stats",id:id,S:h.S});},1000);}catch(e){}})();\n' +
            'importScripts(' + JSON.stringify(u) + ');';
          const w = new W(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), opts);
          log('info', 'воркер перехвачен: ' + short(u));
          return w;
        } catch (e) {
          log('err', 'перехват воркера не удался: ' + e.message);
        }
      }
      if (settings.verbose) log('info', 'создан воркер: ' + short(u) + (isModule ? ' (module)' : ''));
      return new W(url, opts);
    };
    Wrapped.prototype = W.prototype;
    try { Object.setPrototypeOf(Wrapped, W); } catch {}
    window.Worker = Wrapped;
  }

  // ------------------------------------------------------------------ треки, авто-пропуски, возврат трека

  let lastTrack = null, lastTrackAt = 0, lastUserAction = 0;
  let pendingRestore = null;          // { title, pos, at } — ждём старта, чтобы перемотать
  let lastRestore = null;             // { title, at } — смена на этот трек сделана нами
  const undoHistory = new Map();      // title → [время возвратов]
  let undoTimes = [];

  function readTrack() {
    const top = document.querySelector('[data-testid="TopAudioPlayer_Title"]');
    const block = document.querySelector('[data-testid="AudioPlayerBlock_AudioTitle"]');
    const text = ((top && top.textContent) || (block && block.textContent) || '').replace(/\s+/g, ' ').trim();
    return text || null;
  }

  function recentTrouble(now) {
    const out = [];
    for (let i = logs.length - 1; i >= 0 && out.length < 6; i--) {
      const l = logs[i];
      if (now - l.t2 > 5000) break;
      if (['err', 'vk', 'net', 'mse', 'res', 'jserr', 'ctx'].includes(l.kind)) out.unshift(`[${l.kind}] ${l.msg.split('\n')[0].slice(0, 180)}`);
    }
    return out.length ? '\n        перед этим:\n        · ' + out.join('\n        · ') : '';
  }

  function backButton() {
    return document.querySelector('[data-testid="TopAudioPlayer_BackwardAction"]') ||
      document.querySelector('[data-testid="audio-player-controls-backward-button"]');
  }

  function maybeUndo(title, now) {
    if (!settings.undoSkip) return;
    const h = (undoHistory.get(title) || []).filter(x => now - x < 120000);
    undoTimes = undoTimes.filter(x => now - x < 60000);
    if (h.length >= 2) { log('info', `«${title}» падает уже третий раз — не возвращаю, пусть играет следующий`); return; }
    if (undoTimes.length >= 6) { log('info', 'слишком много сбоев за минуту — возврат треков на паузе'); return; }
    h.push(now);
    undoHistory.set(title, h);
    undoTimes.push(now);
    const pos = failSnap && failSnap.title === title && now - failSnap.t < 6000 ? failSnap.pos : 0;
    pendingRestore = { title, pos, at: now };
    lastRestore = { title, at: now };
    setTimeout(() => {
      const btn = backButton();
      if (!btn) { log('err', 'не нашёл кнопку «предыдущий трек» — вернуть не могу'); pendingRestore = null; return; }
      btn.click();
      stats.undone++;
      log('fix', `возвращаю «${title}»${pos > 3 ? ' на ' + fmtPos(pos) : ''} (попытка ${h.length}/2)`);
    }, 350);
  }

  function onPlaying(el) {
    if (!pendingRestore) return;
    const now = Date.now();
    if (now - pendingRestore.at > 15000) { pendingRestore = null; return; }
    if (readTrack() !== pendingRestore.title) return;
    const pos = pendingRestore.pos;
    pendingRestore = null;
    if (pos > 3) {
      try {
        if (el.currentTime < pos - 3) {
          el.currentTime = Math.max(0, pos - 1);
          stats.restoredPos++;
          log('fix', `позиция восстановлена: ${fmtPos(pos - 1)}`);
        }
      } catch (e) { log('err', 'не удалось перемотать: ' + e.message); }
    }
  }

  function trackTick() {
    const text = readTrack();
    if (!text) return;
    if (lastTrack && lastTrack.key === text) return;
    const now = Date.now();
    const byUser = now - lastUserAction < 1500;
    const byUs = !!(lastRestore && lastRestore.title === text && now - lastRestore.at < 10000);
    const afterVkError = lastVkError && now - lastVkError.t < 4000;
    if (lastTrack && !lastTrack.initial && !byUser && !byUs) {
      const dt = (now - lastTrackAt) / 1000;
      if (afterVkError) {
        stats.autoSkips++;
        log('warn', `ВК сам переключил трек после своей ошибки (autoPlayNextAsRecovery): «${lastTrack.text}» играл ${dt.toFixed(1)} с${recentTrouble(now)}`);
        maybeUndo(lastTrack.text, now);
      } else if (dt < 4) {
        stats.fastSkips++;
        log('warn', `самопроизвольная смена трека через ${dt.toFixed(1)} с после старта${recentTrouble(now)}`);
      }
    }
    stats.trackChanges++;
    lastTrack = { key: text, text, initial: !lastTrack };
    lastTrackAt = now;
    log('track', `▶ ${text}${byUser ? ' (выбрал ты)' : byUs ? ' (возврат)' : ''}`);
  }

  document.addEventListener('click', e => {
    if (!e.isTrusted) return;     // наши программные клики — не «действие пользователя»
    const el = e.target && e.target.closest && e.target.closest(
      '[data-testid="audiorow-tappable"],[data-testid$="ForwardAction"],[data-testid$="BackwardAction"],' +
      '[data-testid="audio-player-controls-forward-button"],[data-testid="audio-player-controls-backward-button"],' +
      '[data-testid="MusicTrackRow"],[data-testid="TopAudioPlayer"],[data-testid*="Audio"],[data-testid*="Music"]');
    if (el) lastUserAction = Date.now();
  }, true);
  document.addEventListener('keydown', e => { if (e.isTrusted) lastUserAction = Date.now(); }, true);
  setInterval(trackTick, 300);

  // раз в минуту — сводка в лог (для файла)
  let lastSummary = '';
  setInterval(() => {
    const s = JSON.stringify({ p: stats, n: netTotals() });
    if (s === lastSummary) return;
    lastSummary = s;
    log('stat', `сводка: ошибок ВК ${stats.vkErrors}, авто-пропусков ${stats.autoSkips}, возвратов ${stats.undone}, ` +
      `ожиданий буфера ${stats.waiting}, запросов плеера ok/сбой/медл/отмена ${netTotals().reqOk}/${netTotals().reqFail}/${netTotals().reqSlow}/${netTotals().reqAbort}, ` +
      `треков в кеше ${netTotals().fullTracks}, из кеша ${netTotals().hits}`);
  }, 60000);

  // ------------------------------------------------------------------ API для панели

  function netTotals() {
    const t = Object.assign({}, net.S);
    t.badHosts = Object.assign({}, net.S.badHosts);
    for (const s of workerStats.values()) {
      for (const k in t) if (typeof t[k] === 'number') t[k] += s[k] || 0;
      for (const h in s.badHosts || {}) t.badHosts[h] = (t.badHosts[h] || 0) + s.badHosts[h];
    }
    return t;
  }

  function setSetting(k, v) {
    settings[k] = v;
    saveSettings();
    if (k === 'cache' || k === 'verbose') {
      const c = { cache: settings.cache, verbose: settings.verbose };
      net.setCfg(c);
      try { bc && bc.postMessage({ t: 'cfg', cfg: c }); } catch {}
    }
    const names = { playFix: 'фикс AbortError', undoSkip: 'возврат трека после сбоя', cache: 'кеш трека',
                    verbose: 'подробный лог', workerHook: 'перехват в воркерах' };
    if (names[k]) log('info', `${names[k]}: ${v ? 'вкл' : 'выкл'}${k === 'workerHook' ? ' (сработает после перезагрузки страницы)' : ''}`);
  }

  function header() {
    const c = navigator.connection;
    return [
      `VK Music Fix ${VERSION} — отчёт, сессия ${SESSION}`,
      new Date().toString(),
      navigator.userAgent,
      'сеть: ' + (c ? `${c.effectiveType}, rtt ${c.rtt} мс, ${c.downlink} Мбит/с` : 'неизвестно'),
      'страница: ' + location.host + location.pathname,
      'текущий трек: ' + (lastTrack ? lastTrack.text : '—'),
      'настройки: ' + JSON.stringify(settings),
      'плеер: ' + JSON.stringify(stats),
      'сеть (основной поток): ' + JSON.stringify(net.S),
      ...[...workerStats].map(([id, s]) => `сеть (воркер ${id}): ` + JSON.stringify(s)),
    ];
  }

  function report() {
    return header().concat(['', 'лог (эта вкладка):'], logs.map(e => lineOf(e) + (e.n > 1 ? `  ×${e.n}` : ''))).join('\n');
  }

  async function downloadLog() {
    const lines = await Persist.allLines();
    const text = header().concat(['', `полный лог (последние ${lines.length} строк, включая прошлые сессии):`], lines).join('\r\n');
    const d = new Date();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' }));
    a.download = `vkfix-log-${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}.txt`;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  Object.defineProperty(window, '__vkfix', {
    value: Object.freeze({
      VERSION, settings, setSetting, logs, stats, net, netTotals, workerStats, report, log,
      file: Persist.file,
      pickLogFile: Persist.pickFile, resumeLogFile: Persist.regrant, stopLogFile: Persist.stopFile,
      downloadLog,
      clearLog: () => { logs.length = 0; lastEntry = null; Persist.clearAll(); },
      track: () => lastTrack,
    }),
    enumerable: false,
  });

  log('info', `фикс AbortError ${settings.playFix ? 'вкл' : 'выкл'}, возврат трека ${settings.undoSkip ? 'вкл' : 'выкл'}, кеш ${settings.cache ? 'вкл' : 'выкл'}`);
})();
