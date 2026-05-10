import { useCallback, useEffect, useRef, useState } from "react";

// Push-to-talk voice input. The consumer wires up `start()` to a button or
// hotkey-down event and `stop()` to the matching button-up. While recording,
// we capture from the default microphone via getUserMedia + MediaRecorder
// (webm/opus, the format Chromium gives us by default in Electron). On stop,
// the blob is shipped to the Electron main process which shells out to
// `openclaw audio transcribe`. The resolved transcript is delivered via the
// `onTranscript` callback so the consumer can drop it into a composer or
// auto-send.
//
// State machine:
//   idle    → waiting for start()
//   recording → MediaRecorder is running
//   transcribing → waiting on the openclaw CLI
//   error   → last attempt failed; auto-clears on next start()
//
// Failure modes we handle gracefully:
//   - mic permission denied → stays in `error` with a useful message
//   - no audio captured (released too fast) → no-op, returns to idle
//   - openclaw not on PATH or no provider configured → surface the CLI's
//     stderr verbatim so the user knows what to fix
export function useVoiceInput({ onTranscript, minRecordMs = 250, errorTtlMs = 6000 } = {}) {
  const [state, setState] = useState("idle"); // idle | recording | transcribing | error
  const [error, setError] = useState(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const streamRef = useRef(null);
  const startedAtRef = useRef(0);
  const errorTimerRef = useRef(null);

  const cleanup = useCallback(() => {
    try {
      recorderRef.current?.stream?.getTracks?.().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    try {
      streamRef.current?.getTracks?.().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    recorderRef.current = null;
    streamRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => () => {
    cleanup();
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
  }, [cleanup]);

  // Auto-dismiss the voice error after `errorTtlMs` so a failed transcription
  // doesn't leave a permanent banner. Cleared on the next start() too.
  useEffect(() => {
    if (state !== "error" || !error) return;
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => {
      setState((s) => (s === "error" ? "idle" : s));
      setError(null);
      errorTimerRef.current = null;
    }, errorTtlMs);
    return () => {
      if (errorTimerRef.current) {
        clearTimeout(errorTimerRef.current);
        errorTimerRef.current = null;
      }
    };
  }, [state, error, errorTtlMs]);

  const start = useCallback(async () => {
    if (state === "recording" || state === "transcribing") return;
    setError(null);
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      setState("error");
      setError(`mic permission denied: ${String(err?.message ?? err)}`);
      return;
    }
    streamRef.current = stream;

    // Pick the most-reliable mime type Chromium offers; Electron 33's
    // Chromium ships webm/opus reliably.
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "",
    ];
    const mime =
      candidates.find((m) => !m || MediaRecorder.isTypeSupported(m)) ?? "";

    let recorder;
    try {
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    } catch (err) {
      cleanup();
      setState("error");
      setError(`recorder init failed: ${String(err?.message ?? err)}`);
      return;
    }
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.addEventListener("dataavailable", (e) => {
      if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
    });

    recorder.addEventListener("stop", async () => {
      const blob = new Blob(chunksRef.current, {
        type: recorder.mimeType || mime || "audio/webm",
      });
      cleanup();
      const elapsedMs = Date.now() - startedAtRef.current;
      if (blob.size === 0 || elapsedMs < minRecordMs) {
        // Released too quickly to have anything useful — bail without
        // calling the transcribe CLI so we don't spam the user with
        // "no transcript returned" errors.
        setState("idle");
        return;
      }

      setState("transcribing");
      try {
        const buffer = await blob.arrayBuffer();
        // Pull the extension off the recorded mime so the temp file
        // matches what openclaw's CLI expects.
        const subtype = (recorder.mimeType || mime || "audio/webm").split("/")[1] ?? "webm";
        const ext = subtype.split(";")[0] || "webm";
        console.log(
          `[voice] recorded ${buffer.byteLength} bytes, mime=${recorder.mimeType || mime}, ext=${ext}, durationMs=${elapsedMs}`,
        );
        const result = await window.exuvia?.audio?.transcribe?.({
          bytes: new Uint8Array(buffer),
          ext,
        });
        if (!result) {
          setState("error");
          setError("transcribe IPC unavailable (running outside Electron?)");
          return;
        }
        if (!result.ok) {
          console.warn("[voice] transcribe failed", result);
          setState("error");
          setError(
            result.tempPath
              ? `${result.error ?? "transcription failed"} (audio kept at ${result.tempPath} for inspection)`
              : result.error ?? "transcription failed",
          );
          return;
        }
        const text = String(result.text ?? "").trim();
        setState("idle");
        if (text) onTranscript?.(text);
      } catch (err) {
        setState("error");
        setError(String(err?.message ?? err));
      }
    });

    startedAtRef.current = Date.now();
    setState("recording");
    recorder.start();
  }, [state, cleanup, onTranscript, minRecordMs]);

  const stop = useCallback(() => {
    if (state !== "recording") return;
    try {
      recorderRef.current?.stop();
    } catch (err) {
      cleanup();
      setState("error");
      setError(String(err?.message ?? err));
    }
  }, [state, cleanup]);

  const cancel = useCallback(() => {
    try {
      recorderRef.current?.stop();
    } catch {
      /* ignore */
    }
    cleanup();
    setState("idle");
    setError(null);
  }, [cleanup]);

  return { state, error, start, stop, cancel };
}
