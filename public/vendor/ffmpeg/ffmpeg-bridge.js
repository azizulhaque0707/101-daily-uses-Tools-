/* eslint-disable */
/**
 * FFmpeg.wasm bridge worker.
 *
 * Owns the FFmpeg core and runs every command on the user's device. The core
 * script and WASM binary are served from /vendor/ffmpeg/ inside this
 * application, so no CDN or external service is ever contacted.
 *
 * Messages in:
 *   { type: "load", corePath, wasmPath }
 *   { type: "exec", args, timeout }
 *   { type: "writeFile", path, data }
 *   { type: "readFile", path }
 *   { type: "deleteFile", path }
 *   { type: "listDir", path }
 *   { type: "terminate" }
 * Messages out:
 *   { type: "ready" } | { type: "loaded" } | { type: "done", id, code }
 *   { type: "data", id, data } | { type: "entries", id, entries }
 *   { type: "error", id, message }
 */

var core = null;
var seq = 0;
var running = false;

function post(message, transfer) {
  self.postMessage(message, transfer || []);
}

self.onmessage = async function (event) {
  var data = event.data;

  try {
    if (data.type === "load") {
      if (core) {
        post({ type: "loaded", id: data.id });
        return;
      }

      // The Emscripten glue expects mainScriptUrlOrBlob as
      // "<core.js>#<base64({wasmURL, workerURL})>" and decodes it with atob.
      // Supplying that exact shape makes its internal _locateFile resolve to
      // our local files instead of a CDN.
      var descriptor = btoa(
        JSON.stringify({ wasmURL: data.wasmPath, workerURL: data.wasmPath })
      );

      // importScripts is the classic-worker mechanism the glue supports.
      importScripts(data.corePath);

      if (typeof self.createFFmpegCore !== "function") {
        throw new Error("createFFmpegCore was not defined by the core script.");
      }

      core = await self.createFFmpegCore({
        mainScriptUrlOrBlob: data.corePath + "#" + descriptor,
        locateFile: function (path) {
          if (path.endsWith(".wasm")) return data.wasmPath;
          if (path.endsWith(".worker.js")) return data.wasmPath;
          return data.corePath;
        },
        print: function (line) {
          post({ type: "log", id: null, message: String(line) });
        },
        printErr: function (line) {
          post({ type: "log", id: null, message: String(line) });
        },
      });

      post({ type: "loaded", id: data.id });
      return;
    }

    if (!core) {
      throw new Error("FFmpeg is not loaded yet. Call load first.");
    }

    if (data.type === "exec") {
      if (running) {
        // Emscripten's runtime is single-instance; queue rather than corrupt.
        await new Promise(function (resolve) {
          var wait = setInterval(function () {
            if (!running) {
              clearInterval(wait);
              resolve();
            }
          }, 50);
        });
      }
      running = true;
      try {
        // The core's exec() is variadic: exec(...args), not exec(args).
        // Passing the array as a single argument corrupts the argument table.
        var code = core.exec.apply(core, data.args);
        post({ type: "done", id: data.id, code: code });
      } finally {
        running = false;
      }
      return;
    }

    if (data.type === "writeFile") {
      core.FS.writeFile(data.path, new Uint8Array(data.data));
      post({ type: "done", id: data.id, code: 0 });
      return;
    }

    if (data.type === "readFile") {
      var bytes = core.FS.readFile(data.path);
      var copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      post({ type: "data", id: data.id, data: copy }, [copy.buffer]);
      return;
    }

    if (data.type === "deleteFile") {
      try {
        core.FS.unlink(data.path);
      } catch (e) {
        /* already removed */
      }
      post({ type: "done", id: data.id, code: 0 });
      return;
    }

    if (data.type === "listDir") {
      var entries = core.FS.readdir(data.path);
      post({ type: "entries", id: data.id, entries: entries });
      return;
    }

    if (data.type === "terminate") {
      try {
        if (core.exit) core.exit(0);
      } catch (e) {
        /* ignore */
      }
      core = null;
      post({ type: "done", id: data.id, code: 0 });
      return;
    }

    throw new Error("Unknown message type: " + data.type);
  } catch (error) {
    post({
      type: "error",
      id: data ? data.id : null,
      message: String((error && error.message) || error),
    });
  }
};
