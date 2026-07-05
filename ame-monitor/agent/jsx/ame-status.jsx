/*
 * ame-status.jsx  (v3)
 * Inside Adobe Media Encoder. Tracks queue/encode state, captures file paths
 * robustly (scans every event for path-like strings), grabs a frame thumbnail,
 * and accepts pause/resume/stop control.
 */

(function () {
    if (!$.global.__ameMon) {
        $.global.__ameMon = {
            inited: false, ready: false, batchState: "idle",
            current: null,   // { name, source, output, phase, percent, startedAt }
            queued: 0, completed: 0, failed: 0, recent: [], lastEvent: "", lastStarted: "", lastComplete: "",
            startedAt: (new Date()).getTime()
        };
    }
    var S = $.global.__ameMon;

    // ---- JSON builder ---------------------------------------------------------
    function esc(s) {
        s = String(s); var out = "", c;
        for (var i = 0; i < s.length; i++) {
            c = s.charAt(i);
            if (c === '"') out += '\\"'; else if (c === '\\') out += '\\\\';
            else if (c === '\n') out += '\\n'; else if (c === '\r') out += '\\r';
            else if (c === '\t') out += '\\t'; else if (c < ' ') out += ' '; else out += c;
        }
        return out;
    }
    function kv(k, v, n) {
        if (n) return '"' + k + '":' + (isFinite(v) ? v : 0);
        if (v === null || v === undefined) return '"' + k + '":null';
        return '"' + k + '":"' + esc(v) + '"';
    }
    $.global.getAMEStatusJSON = function () {
        var p = [];
        p.push(kv("ready", S.ready ? 1 : 0, true));
        p.push('"batchState":"' + esc(S.batchState) + '"');
        if (S.current) {
            p.push('"current":{' + kv("name", S.current.name) + ',' + kv("source", S.current.source) + ',' +
                kv("output", S.current.output) + ',' + kv("phase", S.current.phase || "video") + ',' +
                kv("percent", Math.round(S.current.percent || 0), true) + ',' +
                kv("startedAt", S.current.startedAt || 0, true) + '}');
        } else { p.push('"current":null'); }
        p.push(kv("queued", S.queued < 0 ? 0 : S.queued, true));
        p.push(kv("completed", S.completed, true));
        p.push(kv("failed", S.failed, true));
        var r = [];
        for (var i = 0; i < S.recent.length; i++)
            r.push('{' + kv("name", S.recent[i].name) + ',' + kv("result", S.recent[i].result) + ',' + kv("ts", S.recent[i].ts, true) + '}');
        p.push('"recent":[' + r.join(',') + ']');
        p.push(kv("lastEvent", S.lastEvent));
        p.push(kv("lastStarted", S.lastStarted));
        p.push(kv("lastComplete", S.lastComplete));
        return '{' + p.join(',') + '}';
    };

    // ---- field readers + path scanning ---------------------------------------
    var KNOWN = ["type","srcFilePath","outputFile","outputPath","source","destination","result",
                 "progress","encodeProgress","itemProgress","percent","audioProgress",
                 "batchEncoderStatus","encodeCompleteStatus","encodeCompleteTime","error","groupIndex"];
    var PATH_RE = /[\/\\][^\/\\]+\.[A-Za-z0-9]{2,6}$/;

    function firstStr(e, names) {
        for (var i = 0; i < names.length; i++)
            try { var v = e[names[i]]; if (v !== undefined && v !== null && String(v) !== "") return String(v); } catch (_) {}
        return "";
    }
    function firstNum(e, names) {
        for (var i = 0; i < names.length; i++)
            try { var v = e[names[i]]; if (typeof v === "number" && isFinite(v)) return v; } catch (_) {}
        return null;
    }
    // collect every path-like string value found anywhere on the event object
    function collectPaths(e) {
        var found = [], seen = {};
        function consider(v) {
            if (typeof v === "string" && PATH_RE.test(v) && !seen[v]) { seen[v] = 1; found.push(v); }
        }
        for (var i = 0; i < KNOWN.length; i++) { try { consider(e[KNOWN[i]]); } catch (_) {} }
        for (var k in e) { try { consider(e[k]); } catch (_) {} }   // reflect unknown props
        return found;
    }
    function baseName(p) { if (!p) return p; var s = String(p).replace(/[\/\\]+$/, ""); var m = s.match(/[^\/\\]+$/); return m ? m[0] : s; }

    function dump(tag, e) {
        var d = tag + " {";
        for (var i = 0; i < KNOWN.length; i++) try { var v = e ? e[KNOWN[i]] : undefined; if (v !== undefined) d += KNOWN[i] + "=" + v + "; "; } catch (_) {}
        for (var k in e) { try { if (KNOWN.join(",").indexOf(k) < 0) d += "[" + k + "=" + e[k] + "] "; } catch (_) {} }
        S.lastEvent = d + "}";
    }
    // fill current.source/output from named props, else from scanned paths
    function fillPaths(e) {
        if (!S.current) return;
        var src = firstStr(e, ["srcFilePath", "source"]);
        var out = firstStr(e, ["outputFile", "outputPath", "destination"]);
        var scanned = collectPaths(e);
        if (!src && scanned.length) src = scanned[0];
        if (!out && scanned.length) out = scanned[scanned.length - 1];
        if (src && !S.current.source) S.current.source = src;
        if (out && !S.current.output) S.current.output = out;
        if (!S.current.name || S.current.name === "encoding…") {
            var nm = baseName(S.current.output || S.current.source);
            if (nm) S.current.name = nm;
        }
    }
    function pushRecent(name, result) {
        S.recent.unshift({ name: name || "(unknown)", result: result, ts: (new Date()).getTime() });
        if (S.recent.length > 8) S.recent.length = 8;
    }
    function readProgress(e) {
        var v = firstNum(e, ["progress", "encodeProgress", "itemProgress", "percent", "result"]);
        if (v === null) return null;
        if (v <= 1.0001) v = v * 100; if (v < 0) v = 0; if (v > 100) v = 100; return v;
    }
    function ensureCurrent() {
        if (!S.current) S.current = { name: "encoding…", source: "", output: "", phase: "video", percent: 0, startedAt: (new Date()).getTime() };
        return S.current;
    }

    // ---- handlers -------------------------------------------------------------
    function onAdded(e)   { dump("added", e); S.queued++; }
    function onStarted(e) {
        dump("started", e); S.lastStarted = S.lastEvent;
        S.current = { name: "encoding…", source: "", output: "", phase: "video", percent: 0, startedAt: (new Date()).getTime() };
        fillPaths(e);
        if (S.batchState === "idle" || S.batchState === "stopped") S.batchState = "running";
    }
    function onAudio(e) {
        dump("audio", e); ensureCurrent().phase = "audio"; fillPaths(e);
        var v = firstNum(e, ["audioProgress", "progress", "result"]);
        if (v !== null) { if (v <= 1.0001) v *= 100; S.current.percent = v; }
    }
    function onProgress(e) {
        dump("progress", e); ensureCurrent().phase = "video"; fillPaths(e);
        var p = readProgress(e); if (p !== null) S.current.percent = p;
    }
    function onComplete(e) {
        dump("complete", e); S.lastComplete = S.lastEvent;
        var name = (S.current && S.current.name && S.current.name !== "encoding…")
            ? S.current.name : baseName(firstStr(e, ["outputFile", "srcFilePath", "source"]));
        var st = firstNum(e, ["encodeCompleteStatus", "result"]);
        var ok = (st === null) ? true : (st === 0 || st === 1);
        if (ok) S.completed++; else S.failed++;
        pushRecent(name || ("item " + (S.completed + S.failed)), ok ? "done" : "failed");
        S.current = null; if (S.queued > 0) S.queued--;
    }
    function onErr(e) {
        dump("error", e);
        var name = S.current ? S.current.name : baseName(firstStr(e, ["srcFilePath", "source", "outputFile"]));
        S.failed++; pushRecent(name, "failed"); S.current = null; if (S.queued > 0) S.queued--;
    }
    function onBatchStatus(e) {
        dump("batchStatus", e);
        var st = firstStr(e, ["batchEncoderStatus"]);
        if (st) { st = st.toLowerCase();
            if (st === "running") S.batchState = "running";
            else if (st === "paused") S.batchState = "paused";
            else if (st === "stopped" || st === "stopping") { S.batchState = "stopped"; S.current = null; }
        }
    }
    function reg(o, n, f) { if (o) try { o.addEventListener(n, f, false); } catch (_) {} }

    $.global.initAMEMonitor = function () {
        if (S.inited) return "already";
        var host = null, frontend = null;
        try { host = app.getEncoderHost(); } catch (_) {}
        try { frontend = app.getFrontend(); } catch (_) {}
        if (!host && !frontend) return "not-ready";
        reg(frontend, "onItemAddedToBatch", onAdded);
        reg(host, "onItemEncodingStarted", onStarted);
        reg(host, "onAudioPreEncodeProgress", onAudio);
        reg(host, "onEncodingItemProgressUpdated", onProgress);
        reg(host, "onEncodingItemProgressUpdate", onProgress);
        reg(host, "onEncodeProgress", onProgress);
        reg(host, "onItemEncodeComplete", onComplete);
        reg(host, "onEncodeComplete", onComplete);
        reg(host, "onEncodeFinished", onComplete);
        reg(host, "onError", onErr);
        reg(host, "onBatchEncoderStatusChanged", onBatchStatus);
        S.inited = true; S.ready = true; return "ok";
    };

    // ---- control --------------------------------------------------------------
    $.global.ameControl = function (action) {
        var host = null; try { host = app.getEncoderHost(); } catch (_) {}
        if (!host) return "no-host";
        try {
            if (action === "pause")  { host.pauseBatch(); S.batchState = "paused";  return "paused"; }
            if (action === "resume") { host.runBatch();   S.batchState = "running"; return "running"; }
            if (action === "stop")   { host.stopBatch();  S.batchState = "stopped"; S.current = null; return "stopped"; }
        } catch (err) { return "error:" + err.toString(); }
        return "unknown-action";
    };

    // ---- thumbnail: render the current frame (AME writes TIFF) ---------------
    // AME versions differ: some honor the path as-is, some append/replace the
    // extension with .tif, some return the real path. Verify what actually
    // landed on disk and report it back so the panel converts the right file.
    $.global.ameThumb = function (path) {
        var host = null; try { host = app.getEncoderHost(); } catch (_) {}
        if (!host) return "no-host";
        var r;
        try { r = host.getCurrentBatchPreview(path); }
        catch (err) { return "err:" + err.toString(); }
        var stem = path.replace(/\.[A-Za-z]+$/, "");
        var cands = [String(r || ""), path,
                     stem + ".jpg", stem + ".jpeg", stem + ".png",
                     stem + ".tif", stem + ".tiff",
                     path + ".jpg", path + ".tif", path + ".tiff"];
        for (var t = 0; t < 4; t++) {                     // up to ~1s for the write to land
            for (var i = 0; i < cands.length; i++) {
                if (!cands[i]) continue;
                try { var f = new File(cands[i]); if (f.exists && f.length > 0) return "ok:" + f.fsName; } catch (_) {}
            }
            $.sleep(250);
        }
        return "ok:?" + String(r);                        // no file found; report raw return for diagnosis
    };

    // ---- is the encoder actively running? ------------------------------------
    $.global.ameIsRunning = function () {
        var host = null; try { host = app.getEncoderHost(); } catch (_) {}
        if (!host) return "0";
        try { return host.isBatchRunning() ? "1" : "0"; } catch (_) { return "0"; }
    };

    return $.global.initAMEMonitor();
})();
