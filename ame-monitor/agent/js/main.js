/*
 * main.js  (v8) — CEP panel (Node.js). Runs on macOS AND Windows.
 * Platform-specific bits (disk free, thumbnail conversion, drive enumeration) branch on
 * process.platform. Everything else (watch-folder auto-discovery via Source+Output
 * signature, status, control) is shared.
 */

(function () {
    var nodeRequire = (typeof require !== "undefined") ? require : (window.cep_node && window.cep_node.require);
    var http = nodeRequire("http"), os = nodeRequire("os"), fs = nodeRequire("fs"),
        url = nodeRequire("url"), cp = nodeRequire("child_process");
    var IS_WIN = (typeof process !== "undefined" && process.platform === "win32");

    // ---- config ---------------------------------------------------------------
    var VERSION   = "1.3.4";                    // agent version (shown in panel + dashboard)
    var PORT      = 8642;
    var TOKEN     = "changeme";                 // shared secret for control (pause/stop). CHANGE THIS.
    var DISK_PATH = IS_WIN ? "C:" : "/";        // volume/drive to report free space for
    var ENABLE_THUMB = true;
    var THUMB_MS  = 4000;
    var AUTO_DISCOVER = true;
    var DISCOVER_MS = 20000;
    var SCAN_MAX_DIRS = 1800;
    var SCAN_MAX_DEPTH = 4;
    var SIPS = "/usr/bin/sips";                 // macOS only

    // ---- handles --------------------------------------------------------------
    var cs = new CSInterface();
    var machine = os.hostname().replace(/\.local$/i, "");
    var lanIP = getLanIP();
    // use a plain /tmp path on macOS — some AME builds mangle the sandboxed /var/folders paths
    var TMP = IS_WIN ? ((typeof os.tmpdir === "function" && os.tmpdir()) || "C:/Windows/Temp") : "/tmp";
    var HOME = (typeof os.homedir === "function" ? os.homedir() : TMP) || TMP;
    var confThumbDir = "";                       // optional override, set from dashboard settings
    var THUMB_DIR, THUMB_REQ, THUMB_JPG;
    function applyThumbDir() {
        THUMB_DIR = String(confThumbDir || TMP).replace(/[\/\\]+$/, "") || TMP;
        THUMB_REQ = THUMB_DIR + "/ame_preview_" + PORT + "_src.tiff"; // AME writes TIFF format
        THUMB_JPG = THUMB_DIR + "/ame_preview_" + PORT + ".jpg";      // what /thumb serves
    }
    applyThumbDir();
    var CONFIG_FILE = HOME + "/.ame-monitor-" + PORT + ".json";
    var NODE_VER = (typeof process !== "undefined" && process.version) ? process.version : "unknown";
    var PLATFORM = IS_WIN ? "windows" : "macos";

    var cache = '{"ready":0,"batchState":"starting","current":null,"queued":0,"completed":0,"failed":0,"recent":[]}';
    var lastState = {};
    var health = { cpu: 0, memPct: 0, diskFreeGB: 0, diskPath: DISK_PATH, uptimeMin: 0 };
    var manualWatch = [], discovered = [], effective = [], watch = [], watchTotal = 0;
    var recentFiles = [], currentGuess = null, watchMem = {}, thumbStatus = "idle";
    var amePrefsDir = "", ameVersions = [], prevCpu = null;
    var snap = { pct: -1, ts: 0, watchDone: 0 };   // completion reconciler state

    loadConfig();

    function loadConfig() {
        try {
            var j = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
            if (j && j.watch && j.watch.length !== undefined) manualWatch = j.watch;
            if (j && typeof j.thumbDir === "string") { confThumbDir = j.thumbDir; applyThumbDir(); }
        } catch (e) {}
    }
    function saveConfig() { try { fs.writeFileSync(CONFIG_FILE, JSON.stringify({ watch: manualWatch, thumbDir: confThumbDir })); } catch (e) {} }

    function loadJsx() {
        var jsxPath = cs.getSystemPath(SystemPath.EXTENSION) + "/jsx/ame-status.jsx";
        var src;
        try { src = fs.readFileSync(jsxPath, "utf8"); }
        catch (e) { setPanel("Could not read ame-status.jsx: " + e.message, "err"); return; }
        cs.evalScript(src, function (res) { if (res === "not-ready" || res === "EvalScript error.") setTimeout(retryInit, 2000); });
    }
    function retryInit() { cs.evalScript("initAMEMonitor()", function (res) { if (res !== "ok" && res !== "already") setTimeout(retryInit, 2000); }); }

    function poll() {
        cs.evalScript("getAMEStatusJSON()", function (res) {
            if (res && res.charAt(0) === "{") { cache = res; var o = tryParse(res); if (o) { o.running = lastState.running || 0; lastState = o; } }
            cs.evalScript("ameIsRunning()", function (r) { lastState.running = (r === "1") ? 1 : 0; reconcile(); paintPanel(); });
        });
    }

    // ---- health (cross-platform CPU via cpus() deltas) ------------------------
    function cpuPct() {
        var cpus = os.cpus(); if (!cpus || !cpus.length) return health.cpu;
        var idle = 0, total = 0;
        for (var i = 0; i < cpus.length; i++) { var t = cpus[i].times; idle += t.idle; total += t.user + t.nice + t.sys + t.idle + t.irq; }
        if (prevCpu) { var di = idle - prevCpu.idle, dt = total - prevCpu.total; prevCpu = { idle: idle, total: total }; if (dt <= 0) return health.cpu; return Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100))); }
        prevCpu = { idle: idle, total: total }; return 0;
    }
    function refreshHealth() {
        try {
            health.cpu = cpuPct();
            health.memPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);
            health.uptimeMin = Math.round(os.uptime() / 60);
        } catch (e) {}
        if (IS_WIN) {
            var drive = (String(DISK_PATH).match(/^[A-Za-z]:/) || ["C:"])[0];
            cp.exec('wmic logicaldisk where "DeviceID=\'' + drive + '\'" get FreeSpace /value', function (err, stdout) {
                if (err || !stdout) return;
                var m = String(stdout).match(/FreeSpace=(\d+)/);
                if (m) health.diskFreeGB = Math.round((parseInt(m[1], 10) / 1073741824) * 10) / 10;
            });
        } else {
            cp.exec("df -k '" + DISK_PATH + "'", function (err, stdout) {
                if (err || !stdout) return;
                var f = String(stdout).trim().split("\n").pop().split(/\s+/);
                var availK = parseInt(f[3], 10);
                if (isFinite(availK)) health.diskFreeGB = Math.round((availK / 1024 / 1024) * 10) / 10;
            });
        }
    }

    // ---- helpers --------------------------------------------------------------
    var MEDIA = { mov:1,mp4:1,m4v:1,mxf:1,avi:1,mkv:1,mts:1,m2ts:1,r3d:1,braw:1,mpg:1,mpeg:1,wmv:1,dv:1,webm:1,flv:1,ts:1,
                  wav:1,mp3:1,aac:1,m4a:1,aif:1,aiff:1,prores:1,mp2:1 };
    function isMedia(name) { var i = name.lastIndexOf("."); return i >= 0 && MEDIA[name.slice(i + 1).toLowerCase()] === 1; }
    function base(p) { return String(p).replace(/[\/\\]+$/, "").split(/[\/\\]/).pop() || p; }
    function statSafe(p) { try { return fs.statSync(p); } catch (e) { return null; } }
    function uniq(a) { var s = {}, o = []; for (var i = 0; i < a.length; i++) { var k = String(a[i]).replace(/[\/\\]+$/, ""); if (k && !s[k]) { s[k] = 1; o.push(k); } } return o; }

    // ---- auto-discovery -------------------------------------------------------
    function listVolumes() {
        var out = [];
        if (IS_WIN) {
            var L = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
            for (var i = 0; i < L.length; i++) { var d = L.charAt(i) + ":/"; if (statSafe(d)) out.push(d); }
        } else {
            try { var v = fs.readdirSync("/Volumes"); for (var k = 0; k < v.length; k++) if (v[k].charAt(0) !== ".") out.push("/Volumes/" + v[k]); } catch (e) {}
        }
        return out;
    }
    function extractPaths(txt, acc) {
        var re = IS_WIN
            ? /(?:file:\/\/\/)?([A-Za-z]:[\\\/][^\u0000-\u001f"'<>|*?]+)/g
            : /(?:file:\/\/)?(\/(?:Volumes|Users|Movies)\/[^\u0000-\u001f"'<>|*?\\]+)/g;
        var m;
        while ((m = re.exec(txt))) {
            var p = m[1].replace(/[)\]}>,;'"]+$/, "");
            try { p = decodeURIComponent(p); } catch (e) {}
            if (p.length > 3) acc.push(p);
        }
    }
    function amePrefsRoots() {
        var roots = [], paths = [];
        var docsBase = HOME + "/Documents/Adobe/Adobe Media Encoder";
        amePrefsDir = docsBase;
        var vers; try { vers = fs.readdirSync(docsBase); } catch (e) { ameVersions = []; return roots; }
        ameVersions = vers;
        for (var i = 0; i < vers.length; i++) {
            var vdir = docsBase + "/" + vers[i]; var st = statSafe(vdir); if (!st || !st.isDirectory()) continue;
            var files; try { files = fs.readdirSync(vdir); } catch (e) { continue; }
            for (var f = 0; f < files.length; f++) {
                var fp = vdir + "/" + files[f], fst = statSafe(fp);
                if (fst && fst.isFile() && fst.size < 5 * 1024 * 1024) {
                    var txt = ""; try { txt = fs.readFileSync(fp, "utf8"); } catch (e) { continue; }
                    extractPaths(txt, paths);
                }
            }
        }
        for (var p = 0; p < paths.length; p++) { var ds = statSafe(paths[p]); if (ds && ds.isDirectory()) roots.push(paths[p]); }
        return uniq(roots);
    }
    function findWatchFolders(roots) {
        var found = {}, visited = 0;
        var SKIP = { "Source":1,"Output":1,"node_modules":1,".Trashes":1,".Spotlight-V100":1,".fseventsd":1,".TemporaryItems":1,"Library":1,"Windows":1,"$Recycle.Bin":1,"System Volume Information":1 };
        var stack = []; for (var i = 0; i < roots.length; i++) stack.push({ d: roots[i], depth: 0 });
        while (stack.length && visited < SCAN_MAX_DIRS) {
            var cur = stack.pop(), dir = cur.d, entries;
            try { entries = fs.readdirSync(dir); } catch (e) { continue; }
            visited++;
            var hasSource = false, hasOutput = false, subdirs = [];
            for (var e = 0; e < entries.length; e++) {
                var nm = entries[e]; if (nm.charAt(0) === ".") continue;
                var full = dir + "/" + nm, st = statSafe(full); if (!st || !st.isDirectory()) continue;
                if (nm === "Source") hasSource = true;
                else if (nm === "Output") hasOutput = true;
                else if (!SKIP[nm]) subdirs.push(full);
            }
            if (hasSource && hasOutput) found[dir] = 1;
            if (cur.depth < SCAN_MAX_DEPTH) for (var s = 0; s < subdirs.length; s++) stack.push({ d: subdirs[s], depth: cur.depth + 1 });
        }
        return Object.keys(found);
    }
    function discover() {
        if (!AUTO_DISCOVER) { effective = uniq(manualWatch); return; }
        var prefRoots = amePrefsRoots();
        var userDirs = IS_WIN ? ["Desktop", "Documents", "Videos", "Downloads"] : ["Desktop", "Documents", "Movies", "Downloads"];
        var roots = [HOME];
        for (var i = 0; i < userDirs.length; i++) roots.push(HOME + "/" + userDirs[i]);
        roots = uniq(roots.concat(listVolumes()).concat(prefRoots)).filter(function (r) { return statSafe(r); });
        discovered = findWatchFolders(roots);
        effective = uniq(manualWatch.concat(discovered));
    }

    // ---- per-folder counts ----------------------------------------------------
    function listRoot(dir) {
        var out = [], names; try { names = fs.readdirSync(dir); } catch (_) { return out; }
        for (var i = 0; i < names.length; i++) {
            var name = names[i]; if (name.charAt(0) === "." || !isMedia(name)) continue;
            var full = dir + "/" + name, st = statSafe(full); if (!st || !st.isFile()) continue;
            out.push({ name: name, full: full, mtime: st.mtime ? st.mtime.getTime() : 0 });
        }
        return out;
    }
    function listDeepNames(dir, cap) {
        var names = [], n = 0; cap = cap || 50000; var stack = [dir];
        while (stack.length && n < cap) {
            var d = stack.pop(), entries; try { entries = fs.readdirSync(d); } catch (_) { continue; }
            for (var i = 0; i < entries.length; i++) {
                var nm = entries[i]; if (nm.charAt(0) === ".") continue;
                var full = d + "/" + nm, st = statSafe(full); if (!st) continue;
                if (st.isDirectory()) stack.push(full); else if (st.isFile() && isMedia(nm)) { names.push(nm); n++; }
            }
        }
        return names;
    }
    function listDeepFiles(dir, cap) {
        var out = [], n = 0; cap = cap || 5000; var stack = [dir];
        while (stack.length && n < cap) {
            var d = stack.pop(), entries; try { entries = fs.readdirSync(d); } catch (_) { continue; }
            for (var i = 0; i < entries.length; i++) {
                var nm = entries[i]; if (nm.charAt(0) === ".") continue;
                var full = d + "/" + nm, st = statSafe(full); if (!st) continue;
                if (st.isDirectory()) stack.push(full);
                else if (st.isFile() && isMedia(nm)) { out.push({ name: nm, full: full, mtime: st.mtime ? st.mtime.getTime() : 0 }); n++; }
            }
        }
        return out;
    }
    function stem(name) { return String(name).replace(/\.[^.]+$/, "").toLowerCase(); }
    function refreshWatch() {
        var guess = null, guessMtime = Infinity, total = 0;
        var activeGuess = null, newestOut = 0, now = Date.now();
        watch = effective.map(function (p) {
            var exists = !!statSafe(p);
            var root = exists ? listRoot(p) : [];
            var srcNames = exists ? listDeepNames(p + "/Source") : [];
            var remaining = root.length, done = srcNames.length; total += remaining;
            var wm = watchMem[p] || (watchMem[p] = { known: {}, init: false });
            if (wm.init) for (var i = 0; i < srcNames.length; i++) if (!wm.known[srcNames[i]]) recentFiles.unshift({ name: srcNames[i], folder: base(p), ts: Date.now() });
            wm.known = {}; for (var k = 0; k < srcNames.length; k++) wm.known[srcNames[k]] = 1; wm.init = true;
            for (var r = 0; r < root.length; r++) if (root[r].mtime < guessMtime) { guessMtime = root[r].mtime; guess = { name: root[r].name, full: root[r].full, more: remaining - 1, folder: base(p) }; }
            // strongest signal for "which file is being encoded RIGHT NOW":
            // the output file AME is actively writing (mtime within ~30s),
            // matched back to the waiting source with the same stem
            if (exists) {
                var outs = listDeepFiles(p + "/Output");
                for (var o = 0; o < outs.length; o++) {
                    if (outs[o].mtime <= newestOut || (now - outs[o].mtime) > 30000) continue;
                    var os = stem(outs[o].name);
                    for (var r2 = 0; r2 < root.length; r2++) {
                        var rs = stem(root[r2].name);
                        if (rs === os || os.indexOf(rs) === 0 || rs.indexOf(os) === 0) {
                            newestOut = outs[o].mtime;
                            activeGuess = { name: root[r2].name, full: root[r2].full, more: remaining - 1, folder: base(p), active: true };
                            break;
                        }
                    }
                }
            }
            return { name: base(p), path: p, exists: exists, remaining: remaining, done: done, source: (manualWatch.indexOf(p) >= 0 ? "manual" : "auto") };
        });
        if (recentFiles.length > 12) recentFiles.length = 12;
        currentGuess = activeGuess || guess; watchTotal = total;
    }
    // ---- completion reconciler: don't let a finished job hang at ~99% --------
    function reconcile() {
        var st = lastState; if (!st) { snap.pct = -1; return; }
        var doneNow = 0; for (var i = 0; i < watch.length; i++) doneNow += (watch[i].done || 0);
        var watchJustCompleted = doneNow > snap.watchDone; snap.watchDone = doneNow;

        if (st.current) {
            var p = st.current.percent || 0;
            if (p !== snap.pct) { snap.pct = p; snap.ts = Date.now(); }
            var stalledMs = Date.now() - snap.ts;
            // "it's done" signal: output landed in a watch folder, or the encoder
            // stopped running on its own (not user-paused/stopped)
            var doneSignal = watchJustCompleted ||
                (!st.running && st.batchState !== "paused" && st.batchState !== "stopped");
            // done signal -> snap to 100 no matter what percent AME last reported
            // (progress events can stop early, e.g. hanging at 77% during finalize).
            // Snap immediately when near the end; otherwise require a short stall
            // so a momentary blip can't fake a completion mid-encode.
            if (doneSignal && (p >= 99 || stalledMs > 2000)) st.current.percent = 100;
            // near the end but stuck while still "running" -> also snap to 100
            else if (p >= 99 && stalledMs > 4000) st.current.percent = 100;
            // shown 100 and the encoder isn't running -> finish it (clear to idle)
            if ((st.current.percent || 0) >= 100 && !st.running && stalledMs > 2500) st.current = null;
        } else { snap.pct = -1; }
    }

    function enrich(st) {
        if (!st) return st;
        if (!st.current && st.running && currentGuess) st.current = { name: "", source: "", output: "", phase: "video", percent: 0, startedAt: 0 };
        if (st.current) {
            var nm = st.current.name || "";
            if ((!nm || nm === "encoding…" || /^item /.test(nm)) && currentGuess) {
                st.current.name = currentGuess.name + (currentGuess.more > 0 ? "  (+" + currentGuess.more + " more)" : "");
                if (!st.current.source) st.current.source = currentGuess.full;
            }
        }
        return st;
    }

    // ---- thumbnail (TIFF -> JPEG; sips on mac, PowerShell on Windows) ---------
    function convertThumb(src, cb) {
        if (IS_WIN) {
            var ps = cs.getSystemPath(SystemPath.EXTENSION) + "/win/convert.ps1";
            cp.exec('powershell -NoProfile -ExecutionPolicy Bypass -File "' + ps + '" -inPath "' + src + '" -outPath "' + THUMB_JPG + '"', cb);
        } else {
            cp.exec('"' + SIPS + '" -s format jpeg "' + src + '" --out "' + THUMB_JPG + '"', cb);
        }
    }
    // AME may ignore the requested path and write its own (returned by the call),
    // or swap the extension. Find whichever file actually exists.
    function pickThumbSource(returned) {
        var cands = [], stem = THUMB_REQ.replace(/\.[A-Za-z]+$/, "");
        if (returned && /^([A-Za-z]:[\\\/]|\/)/.test(returned)) cands.push(returned);
        cands.push(THUMB_REQ, stem + ".jpeg", stem + ".png", stem + ".tif", stem + ".tiff",
                   THUMB_REQ + ".tif", THUMB_REQ + ".tiff");
        for (var i = 0; i < cands.length; i++) {
            var st = statSafe(cands[i]);
            if (st && st.isFile() && st.size > 0) return cands[i];
        }
        // last resort: any recent image AME dropped in the thumb dir
        // (never match our own served thumbnail — that would loop the stale image)
        var ownJpg = base(THUMB_JPG);
        try {
            var names = fs.readdirSync(THUMB_DIR), now = Date.now();
            for (var n = 0; n < names.length; n++) {
                if (names[n] === ownJpg) continue;
                if (!/\.(tiff?|png|jpe?g|bmp)$/i.test(names[n])) continue;
                if (names[n].indexOf("ame_preview") !== 0 && names[n].toLowerCase().indexOf("ame") !== 0) continue;
                var full = THUMB_DIR + "/" + names[n], fst = statSafe(full);
                if (fst && fst.isFile() && fst.size > 0 && (now - fst.mtime.getTime()) < 15000) return full;
            }
        } catch (_) {}
        return null;
    }
    // which file is being encoded right now? filesystem-derived guess beats AME
    // event paths, which are unreliable/stale for watch-folder encodes
    function activeSrc() {
        return (currentGuess && currentGuess.active && currentGuess.full) ||
               (currentGuess && currentGuess.full) ||
               (lastState && lastState.current && lastState.current.source) || "";
    }
    // fallback: some AME versions never write the preview file. Generate a poster
    // frame of the file being encoded with QuickLook (macOS) instead.
    var lastFallbackSrc = "", lastFallbackTs = 0;
    function fallbackThumb() {
        var src = activeSrc();
        if (!src || !statSafe(src)) { thumbStatus = "convert-failed:no preview and no source file"; return; }
        // regenerate whenever the file changes, and refresh every 10s regardless
        // so the preview can never get stuck on a stale frame
        if (src === lastFallbackSrc && (Date.now() - lastFallbackTs) < 10000 && statSafe(THUMB_JPG)) { thumbStatus = "ok"; return; }
        if (IS_WIN) { thumbStatus = "convert-failed:AME preview unavailable"; return; }
        var outDir = THUMB_DIR + "/ame_ql_" + PORT;
        try { fs.mkdirSync(outDir); } catch (_) {}
        cp.exec('/usr/bin/qlmanage -t -s 960 -o "' + outDir + '" "' + src.replace(/"/g, '\\"') + '"', function () {
            var png = outDir + "/" + base(src) + ".png", st = statSafe(png);
            if (!st || !st.size) { thumbStatus = "convert-failed:quicklook produced nothing"; return; }
            convertThumb(png, function (err, so, se) {
                thumbStatus = err ? ("convert-failed:" + String(se || err.message || "").slice(0, 60)) : "ok";
                if (!err) { lastFallbackSrc = src; lastFallbackTs = Date.now(); }
                try { fs.unlinkSync(png); } catch (_) {}
            });
        });
    }
    var lastJobSrc = "";
    function captureThumb() {
        if (!ENABLE_THUMB) return;
        var active = lastState && (lastState.current || lastState.running);
        if (!active) { thumbStatus = "idle"; lastFallbackSrc = ""; lastJobSrc = ""; try { fs.unlinkSync(THUMB_JPG); } catch (_) {} return; }
        // job changed -> drop the previous file's thumbnail so a stale frame never lingers
        var jobSrc = activeSrc();
        if (jobSrc && jobSrc !== lastJobSrc) {
            lastJobSrc = jobSrc; lastFallbackSrc = "";
            try { fs.unlinkSync(THUMB_JPG); } catch (_) {}
            try { fs.unlinkSync(THUMB_REQ); } catch (_) {}
        }
        cs.evalScript('ameThumb("' + THUMB_REQ.replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '")', function (r) {
            r = String(r);
            thumbStatus = r;
            if (r.indexOf("ok") !== 0) return fallbackThumb();     // AME call failed -> poster frame
            var returned = r.slice(3).replace(/^\s+|\s+$/g, "");   // path AME says it wrote
            if (returned.charAt(0) === "?") returned = "";          // JSX diagnostic, not a path
            // AME writes the file asynchronously — wait for it to land before converting
            var tries = 0;
            (function waitAndConvert() {
                var src = pickThumbSource(returned);
                if (!src) {
                    if (++tries < 5) return setTimeout(waitAndConvert, 400);
                    return fallbackThumb();                         // AME wrote nothing -> poster frame
                }
                if (/\.jpe?g$/i.test(src)) {
                    // already a JPEG — no conversion needed, just publish it
                    fs.readFile(src, function (err, buf) {
                        if (err || !buf || !buf.length) { thumbStatus = "convert-failed:read " + (err ? err.code : "empty"); return; }
                        fs.writeFile(THUMB_JPG, buf, function (werr) { thumbStatus = werr ? ("convert-failed:write " + werr.code) : "ok"; });
                    });
                    return;
                }
                convertThumb(src, function (err, so, se) { thumbStatus = err ? ("convert-failed:" + String(se || err.message || "").slice(0, 60)) : "ok"; });
            })();
        });
    }
    function serveThumb(res) {
        fs.readFile(THUMB_JPG, function (err, buf) {
            if (err || !buf || !buf.length) { res.statusCode = 404; return res.end(); }
            res.setHeader("Content-Type", "image/jpeg"); res.end(buf);
        });
    }

    // ---- http server ----------------------------------------------------------
    function startServer() {
        var server = http.createServer(function (req, res) {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Cache-Control", "no-store");
            var u = url.parse(req.url, true);

            if (u.pathname === "/config") {
                var cfgErr = "";
                if (typeof u.query.watch === "string") {
                    manualWatch = u.query.watch.split("\n").map(function (s) { return s.trim(); }).filter(Boolean);
                    watchMem = {}; discover(); refreshWatch();
                }
                if (typeof u.query.thumbdir === "string") {
                    var td = u.query.thumbdir.trim().replace(/[\/\\]+$/, "");
                    if (td && !statSafe(td)) {
                        // create nested paths too — a plain mkdir fails on e.g. /Volumes/X/a/b
                        try { fs.mkdirSync(td, { recursive: true }); }
                        catch (mkErr) { try { fs.mkdirSync(td); } catch (mk2) { cfgErr = "cannot create " + td + ": " + (mk2.code || mk2.message); } }
                    }
                    var tds = td ? statSafe(td) : null;
                    if (!td) { confThumbDir = ""; applyThumbDir(); }
                    else if (tds && tds.isDirectory()) { confThumbDir = td; applyThumbDir(); cfgErr = ""; }
                    else if (!cfgErr) cfgErr = "not a directory: " + td;
                }
                saveConfig();
                res.setHeader("Content-Type", "application/json");
                return res.end(JSON.stringify({ ok: !cfgErr, error: cfgErr || undefined, manual: manualWatch, discovered: discovered, effective: effective, thumbDir: THUMB_DIR }));
            }
            if (u.pathname === "/control") {
                if (u.query.token !== TOKEN) { res.statusCode = 403; return res.end('{"ok":false,"error":"bad token"}'); }
                var action = u.query.action;
                if (["pause", "resume", "stop"].indexOf(action) < 0) { res.statusCode = 400; return res.end('{"ok":false,"error":"bad action"}'); }
                cs.evalScript("ameControl('" + action + "')", function (r) {
                    res.setHeader("Content-Type", "application/json");
                    res.end('{"ok":true,"action":"' + action + '","result":"' + String(r).replace(/"/g, "") + '"}');
                });
                return;
            }
            if (u.pathname === "/thumb") return serveThumb(res);
            if (u.pathname === "/debug") {
                res.setHeader("Content-Type", "application/json");
                return res.end(JSON.stringify({ version: VERSION, platform: PLATFORM, nodeVersion: NODE_VER, thumbStatus: thumbStatus, thumbDir: THUMB_DIR, autoDiscover: AUTO_DISCOVER,
                                                amePrefsDir: amePrefsDir, ameVersions: ameVersions, discovered: discovered, manual: manualWatch,
                                                effective: effective, watch: watch, watchTotal: watchTotal, currentGuess: currentGuess, cache: tryParse(cache) }));
            }

            var stateObj = lastState ? tryParse(JSON.stringify(lastState)) : tryParse(cache);
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ machine: machine, platform: PLATFORM, version: VERSION, ts: Date.now(), health: health,
                                     watch: watch, watchConfigured: effective, watchTotal: watchTotal, autoDiscover: AUTO_DISCOVER,
                                     thumbStatus: thumbStatus, thumbDir: THUMB_DIR, recentFiles: recentFiles, currentGuess: currentGuess, state: enrich(stateObj) }));
        });
        server.on("error", function (e) { setPanel("HTTP error on " + PORT + ": " + e.code + (e.code === "EADDRINUSE" ? " — change PORT" : ""), "err"); });
        server.listen(PORT, "0.0.0.0", function () { setPanel("Serving on  http://" + lanIP + ":" + PORT, "ok"); });
    }

    // ---- panel UI -------------------------------------------------------------
    function setPanel(msg, cls) {
        var el = document.getElementById("serve"); if (el) { el.textContent = msg; el.className = "serve " + (cls || ""); }
        var host = document.getElementById("host"); if (host) host.textContent = machine + " (" + PLATFORM + ") · v" + VERSION;
    }
    function paintPanel() {
        var s = lastState || {};
        var nm = s.current ? s.current.name : null;
        if ((s.current || s.running) && (!nm || nm === "encoding…") && currentGuess) nm = currentGuess.name;
        set("state", s.running ? "running" : (s.batchState || "idle"));
        set("job", (s.current || s.running) ? ((nm || "encoding…") + (s.current ? "  " + s.current.percent + "%" : "")) : "—");
        set("counts", "done " + (s.completed || 0) + " · failed " + (s.failed || 0));
        set("watchline", effective.length ? (watchTotal + " file(s) across " + effective.length + " folder(s)" + (AUTO_DISCOVER ? " · auto" : "")) : "none found yet");
        set("thumbline", "preview: " + thumbStatus + " · " + THUMB_DIR);
        var ready = document.getElementById("ready"); if (ready) ready.textContent = s.ready ? "listening" : "waiting for AME…";
    }
    function set(id, t) { var el = document.getElementById(id); if (el) el.textContent = t; }

    function tryParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
    function getLanIP() {
        var ifaces = os.networkInterfaces();
        for (var name in ifaces) { var a = ifaces[name]; for (var i = 0; i < a.length; i++) if (a[i].family === "IPv4" && !a[i].internal) return a[i].address; }
        return "127.0.0.1";
    }

    setPanel("starting…", "");
    loadJsx(); startServer();
    discover(); refreshHealth(); refreshWatch();
    setInterval(discover, DISCOVER_MS);
    setInterval(refreshHealth, 3000);
    setInterval(refreshWatch, 2500);
    setInterval(captureThumb, THUMB_MS);
    setInterval(poll, 1000); poll();
})();
