/*
 * VK Music Fix — встроенная панель (кнопка «Fix» внизу слева, или Alt+Shift+D).
 */
(() => {
  'use strict';
  const api = window.__vkfix;
  if (!api || window.__vkfixPanel) return;
  Object.defineProperty(window, '__vkfixPanel', { value: true });

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; }
  .wrap { --bg:#1f1f21; --bg2:#29292c; --line:#38383c; --text:#e3e4e8; --muted:#94969c;
          --accent:#71aaeb; --ok:#4bb34b; --warn:#ffa000; --err:#ff5c5c;
          color-scheme: dark; font: 13px/1.45 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: var(--text); }
  .pill { position: fixed; left: 12px; bottom: 12px; display: flex; align-items: center; gap: 6px;
          padding: 6px 11px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg);
          color: var(--text); font: 600 12px/1 inherit; cursor: pointer; opacity: .85;
          box-shadow: 0 2px 10px rgba(0,0,0,.35); font-family: inherit; }
  .pill:hover { opacity: 1; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--ok); }
  .dot.warn { background: var(--warn); } .dot.off { background: var(--muted); }
  .rec { font-size: 10px; font-weight: 700; color: var(--err); letter-spacing: .04em; }
  .rec.paused { color: var(--warn); } .rec[hidden] { display: none; }
  .panel { position: fixed; left: 12px; bottom: 54px; width: min(470px, calc(100vw - 24px));
           max-height: min(82vh, 760px); display: flex; flex-direction: column; background: var(--bg);
           border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.5); overflow: hidden; }
  .panel[hidden] { display: none; }
  header { display: flex; align-items: center; gap: 8px; padding: 11px 14px; border-bottom: 1px solid var(--line); }
  header b { font-size: 14px; } .ver { color: var(--muted); font-size: 12px; flex: 1; }
  .x { background: none; border: 0; color: var(--muted); font-size: 16px; cursor: pointer; padding: 2px 6px; border-radius: 6px; }
  .x:hover { color: var(--text); background: var(--bg2); }
  .body { padding: 10px 14px 12px; overflow: auto; display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1; }
  .row { display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 2px 0; }
  .row input { position: absolute; opacity: 0; pointer-events: none; }
  .sw { width: 30px; height: 18px; border-radius: 9px; background: var(--line); position: relative; flex: none; transition: background .15s; }
  .sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; transition: transform .15s; }
  .row input:checked + .sw { background: var(--accent); }
  .row input:checked + .sw::after { transform: translateX(12px); }
  .row input:focus-visible + .sw { outline: 2px solid var(--accent); outline-offset: 2px; }
  .name { font-weight: 600; } .val { margin-left: auto; color: var(--muted); font-size: 12px; text-align: right; }
  .small .name { font-weight: 400; font-size: 12px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 2px 0 0; font-size: 12px; }
  dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
  .hint { margin: 0; padding: 8px 10px; border-radius: 8px; background: rgba(255,160,0,.12); color: #ffcc80; font-size: 12px; }
  .hint[hidden] { display: none; }
  .box { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
  .box .title { font-weight: 600; font-size: 12px; } .fstate { color: var(--muted); font-size: 12px; font-weight: 400; }
  .fstate.on { color: var(--ok); } .fstate.paused { color: var(--warn); } .fstate.error { color: var(--err); }
  details { font-size: 12px; } summary { cursor: pointer; color: var(--muted); padding: 2px 0; }
  details[open] summary { margin-bottom: 4px; }
  .btns { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .act { background: var(--accent); color: #0b1a2c; border: 0; border-radius: 8px; padding: 6px 12px;
         font: 600 12px/1.2 inherit; cursor: pointer; font-family: inherit; }
  .act.ghost { background: var(--bg2); color: var(--text); border: 1px solid var(--line); }
  .act[hidden] { display: none; }
  .act:hover { filter: brightness(1.08); }
  .msg { color: var(--ok); font-size: 12px; }
  .log { background: #151517; border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; min-height: 130px;
         max-height: 280px; overflow: auto; font: 11.5px/1.45 ui-monospace, Consolas, "Cascadia Mono", monospace; white-space: pre-wrap; }
  .l { color: var(--muted); } .l .tm { color: #6b6d73; } .l .n { color: var(--warn); }
  .l.err, .l.vk, .l.jserr { color: var(--err); } .l.warn, .l.res { color: var(--warn); } .l.fix { color: var(--ok); }
  .l.track { color: var(--accent); } .l.cache { color: #4dd0c4; } .l.net { color: #e6c35c; } .l.info, .l.ctx { color: var(--text); }
  textarea { width: 100%; height: 120px; background: #151517; color: var(--text); border: 1px solid var(--line);
             border-radius: 8px; font: 11px ui-monospace, Consolas, monospace; }
  `;

  const HTML = `
  <div class="wrap">
    <button class="pill" title="VK Music Fix — Alt+Shift+D"><span class="dot"></span>Fix<span class="rec" hidden>REC</span></button>
    <section class="panel" hidden role="dialog" aria-label="VK Music Fix">
      <header><b>VK Music Fix</b><span class="ver"></span><button class="x" title="Закрыть">✕</button></header>
      <div class="body">
        <label class="row"><input type="checkbox" data-k="undoSkip"><span class="sw"></span><span class="name">Возврат трека после сбоя ВК</span><span class="val" data-v="undo"></span></label>
        <label class="row"><input type="checkbox" data-k="playFix"><span class="sw"></span><span class="name">Фикс AbortError</span><span class="val" data-v="fix"></span></label>
        <label class="row"><input type="checkbox" data-k="cache"><span class="sw"></span><span class="name">Кеш трека целиком</span><span class="val" data-v="cache"></span></label>
        <dl>
          <dt>Сейчас</dt><dd data-v="track">—</dd>
          <dt>Сбои ВК</dt><dd data-v="vk"></dd>
          <dt>Буфер</dt><dd data-v="buffer"></dd>
          <dt>Сеть</dt><dd data-v="net"></dd>
          <dt>Как грузит ВК</dt><dd data-v="how"></dd>
        </dl>
        <p class="hint" hidden></p>
        <div class="box">
          <div class="title">Лог в файл <span class="fstate" data-v="fstate"></span></div>
          <div class="btns">
            <button class="act" data-a="file-start">Писать в файл…</button>
            <button class="act" data-a="file-resume" hidden>Продолжить запись</button>
            <button class="act ghost" data-a="file-stop" hidden>Остановить</button>
            <button class="act ghost" data-a="download">Скачать весь лог</button>
          </div>
        </div>
        <details><summary>Отладка</summary>
          <label class="row small"><input type="checkbox" data-k="verbose"><span class="sw"></span><span class="name">Подробный лог: кто вызывает play / pause / load, каждый запрос</span></label>
          <label class="row small"><input type="checkbox" data-k="workerHook"><span class="sw"></span><span class="name">Перехват в воркерах (эксперимент, после включения — F5)</span></label>
        </details>
        <div class="btns"><button class="act ghost" data-a="copy">Скопировать отчёт</button><button class="act ghost" data-a="clear">Очистить лог</button><span class="msg"></span></div>
        <div class="log" role="log"></div>
      </div>
    </section>
  </div>`;

  function init() {
    const host = document.createElement('div');
    host.id = 'vkfix-root';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>${HTML}`;
    const $ = s => root.querySelector(s);
    const panel = $('.panel'), pill = $('.pill'), dot = $('.dot'), rec = $('.rec'), logEl = $('.log'), hint = $('.hint'), msg = $('.msg');
    $('.ver').textContent = 'v' + api.VERSION;

    const mount = () => { if (!host.isConnected) (document.body || document.documentElement).appendChild(host); };
    mount();
    setInterval(mount, 2000);

    for (const cb of root.querySelectorAll('input[data-k]')) {
      cb.checked = !!api.settings[cb.dataset.k];
      cb.addEventListener('change', () => { api.setSetting(cb.dataset.k, cb.checked); render(true); });
    }

    function setOpen(open) {
      panel.hidden = !open;
      api.setSetting('panel', open);
      if (open) render(true);
    }
    pill.addEventListener('click', () => setOpen(panel.hidden));
    $('.x').addEventListener('click', () => setOpen(false));
    document.addEventListener('keydown', e => {
      if (e.altKey && e.shiftKey && e.code === 'KeyD') { e.preventDefault(); setOpen(panel.hidden); }
    }, true);

    async function copy(text) {
      try { await navigator.clipboard.writeText(text); return true; } catch {}
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;left:-9999px;top:0';
        root.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
      } catch { return false; }
    }
    const flash = (t, ms = 4000) => { msg.textContent = t; setTimeout(() => { if (msg.textContent === t) msg.textContent = ''; }, ms); };

    root.addEventListener('click', e => {
      const b = e.target.closest && e.target.closest('[data-a]');
      if (!b) return;
      const a = b.dataset.a;
      // файловые API требуют «живого» клика — вызываем их синхронно, без await перед ними
      if (a === 'file-start') {
        api.pickLogFile().then(() => render(true), err => { if (err && err.name !== 'AbortError') flash('не вышло: ' + err.message, 8000); });
      } else if (a === 'file-resume') {
        api.resumeLogFile().then(ok => { flash(ok ? 'запись продолжена ✓' : 'браузер не дал доступ к файлу'); render(true); });
      } else if (a === 'file-stop') {
        api.stopLogFile().then(() => render(true));
      } else if (a === 'download') {
        api.downloadLog().then(() => flash('файл сохранён в загрузки ✓'), err => flash('не вышло: ' + err.message, 8000));
      } else if (a === 'copy') {
        const text = api.report();
        copy(text).then(ok => {
          if (ok) { flash('скопировано ✓'); return; }
          flash('не скопировалось — выдели текст ниже и Ctrl+C', 8000);
          let ta = root.querySelector('textarea.manual');
          if (!ta) { ta = document.createElement('textarea'); ta.className = 'manual'; b.parentNode.after(ta); }
          ta.value = text;
          ta.select();
        });
      } else if (a === 'clear') {
        api.clearLog();
        render(true);
      }
    });

    const p2 = n => String(n).padStart(2, '0');
    const tm = ms => { const d = new Date(ms); return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`; };
    const setV = (k, v) => { const el = root.querySelector(`[data-v="${k}"]`); if (el.textContent !== v) el.textContent = v; };
    const fmtSize = b => (b > 1048576 ? (b / 1048576).toFixed(1) + ' МБ' : Math.ceil(b / 1024) + ' КБ');

    let lastLogKey = '';
    let troubleSeen = 0, troubleAt = 0;

    function render(force) {
      const st = api.stats, n = api.netTotals(), s = api.settings, f = api.file;

      const trouble = st.autoSkips + st.fastSkips;
      if (trouble > troubleSeen) { troubleSeen = trouble; troubleAt = Date.now(); }
      dot.className = 'dot' + (!s.playFix && !s.cache && !s.undoSkip ? ' off' : Date.now() - troubleAt < 60000 ? ' warn' : '');
      rec.hidden = f.state === 'off';
      rec.className = 'rec' + (f.state === 'on' ? '' : ' paused');
      rec.textContent = f.state === 'on' ? 'REC' : f.state === 'paused' ? 'REC ⏸' : 'REC !';
      if (panel.hidden && force !== true) return;

      setV('undo', `возвращено ${st.undone}` + (st.restoredPos ? ` · с позиции ${st.restoredPos}` : ''));
      const aborts = st.abortLoad + st.abortPause;
      setV('fix', s.playFix ? `поймано ${aborts}` : `поймано ${aborts}, не спасаем`);
      setV('cache', `треков ${n.fullTracks} · из кеша ${n.hits}` + (n.retries ? ` · повторов ${n.retries}` : ''));
      const tr = api.track();
      setV('track', tr ? tr.text : '—');
      setV('vk', `ошибок плеера ${st.vkErrors} · авто-пропусков ${st.autoSkips}` + (st.fastSkips ? ` · странных скипов ${st.fastSkips}` : '') + ` · смен трека ${st.trackChanges}`);
      setV('buffer', `ожиданий ${st.waiting} · подвисаний ${st.stalled}` + (st.stuck ? ` · стояний на месте ${st.stuck}` : '') +
        ` · ошибок медиа ${st.mediaErrors}` + (st.mseErrors ? ` · MSE ${st.mseErrors}` : ''));
      const cut = (n.blocked || 0) + st.resFails;
      setV('net', `аудио: ок ${n.reqOk} · сбоев ${n.reqFail + n.failed} · медленных ${n.reqSlow} · отменено ${n.reqAbort}` +
        (cut ? ` · сторонних отрезано ${cut} (реклама/стата — на музыку не влияет)` : ''));
      const types = Object.entries(st.resTypes).map(([k, v]) => `${k} ${v}`).join(', ');
      const via = [n.viaXhr && `xhr ${n.viaXhr}`, n.viaFetch && `fetch ${n.viaFetch}`, types].filter(Boolean).join(', ');
      setV('how', `m3u8 ${n.m3u8} · плеер: ${via || 'аудио-запросов не видно'} · MSE: ${st.mse.join(', ') || 'нет'}` +
        (st.workers.length ? ` · воркеров ${st.workers.length}` : '') + (st.directSrc ? ` · прямых ссылок ${st.directSrc}` : ''));

      const fs = root.querySelector('[data-v="fstate"]');
      fs.className = 'fstate ' + f.state;
      fs.textContent = f.state === 'on' ? `— пишется в ${f.name} (${fmtSize(f.size)})`
        : f.state === 'paused' ? `— ${f.name} на паузе после перезагрузки`
        : f.state === 'error' ? `— ошибка: ${f.err}` : '— выключен';
      $('[data-a="file-start"]').hidden = f.state === 'on' || f.state === 'paused';
      $('[data-a="file-start"]').textContent = f.state === 'error' ? 'Выбрать файл заново…' : 'Писать в файл…';
      $('[data-a="file-resume"]').hidden = f.state !== 'paused';
      $('[data-a="file-stop"]').hidden = f.state === 'off';

      let h = '';
      const bad = Object.entries(n.badHosts || {}).sort((a, b) => b[1] - a[1]);
      if (st.autoSkips && !s.undoSkip) h = 'ВК сам перескакивает на следующий трек после своих ошибок — включи «Возврат трека после сбоя ВК».';
      else if (f.state === 'paused') h = 'Запись лога в файл на паузе — нажми «Продолжить запись».';
      else if (bad.length) h = `Сервер с музыкой тормозит или не отвечает: ${bad.slice(0, 3).map(([k, v]) => `${k} (${v})`).join(', ')}. ` +
        'Это на стороне ВК или провайдера — из-за таких серверов плеер ВК и падает. Расширение их обходит: остальные треки их не ждут.';
      else if (st.fastSkips && !s.playFix) h = 'Видны самопроизвольные скипы — включи «Фикс AbortError».';
      else if (st.trackChanges >= 2 && !n.m3u8 && st.directSrc && s.cache)
        h = 'ВК играет файл по прямой ссылке через <audio> — кеш этот поток не перехватывает.';
      else if (st.trackChanges >= 2 && !n.m3u8 && st.workers.length && !s.workerHook && s.cache)
        h = 'Плейлисты не видно в основном потоке, а воркеры есть — попробуй «Перехват в воркерах» в «Отладке» и F5.';
      hint.hidden = !h;
      if (h && hint.textContent !== h) hint.textContent = h;

      const logs = api.logs;
      const last = logs[logs.length - 1];
      const key = logs.length + ':' + (last ? last.t + ':' + last.n : '');
      if (key !== lastLogKey || force === true) {
        lastLogKey = key;
        const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
        const frag = document.createDocumentFragment();
        for (const l of logs.slice(-300)) {
          const div = document.createElement('div');
          div.className = 'l ' + l.kind;
          const t = document.createElement('span');
          t.className = 'tm';
          t.textContent = tm(l.t) + ' ';
          div.append(t, l.msg);
          if (l.n > 1) {
            const c = document.createElement('span');
            c.className = 'n';
            c.textContent = `  ×${l.n}`;
            div.append(c);
          }
          frag.appendChild(div);
        }
        logEl.replaceChildren(frag);
        if (atBottom || force === true) logEl.scrollTop = logEl.scrollHeight;
      }
    }

    setInterval(render, 1000);
    if (api.settings.panel) { panel.hidden = false; render(true); } else render(true);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
