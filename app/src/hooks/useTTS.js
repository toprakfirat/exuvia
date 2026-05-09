import { useCallback, useEffect, useRef, useState } from "react";

// Speak text via the openclaw gateway's tts.convert RPC.
// Pattern ported from ai-assistant/frontend/src/hooks/useTTS.js but rewired:
//   - source = gateway tts.convert (returns a server-side audioPath)
//   - we read the local file via Electron IPC (loopback-only, same machine)
//   - distribute word reveal across audio.duration so chat text reveals in
//     sync with playback
export function useTTS(gateway, opts = {}) {
  const { provider, modelId, voiceId, channel } = opts;
  const [progress, setProgress] = useState({
    messageId: null,
    wordIndex: -1,
    showFull: true,
  });
  const audioRef = useRef(null);
  const intervalRef = useRef(null);
  const lastUrlRef = useRef(null);

  const skip = useCallback(() => {
    if (audioRef.current) {
      try {
        audioRef.current.pause();
      } catch {
        /* ignore */
      }
      audioRef.current = null;
    }
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (lastUrlRef.current) {
      URL.revokeObjectURL(lastUrlRef.current);
      lastUrlRef.current = null;
    }
    setProgress({ messageId: null, wordIndex: -1, showFull: true });
  }, []);

  useEffect(() => () => skip(), [skip]);

  const speak = useCallback(
    async (text, messageId = null) => {
      const trimmed = (text ?? "").trim();
      if (!trimmed) return;
      if (gateway.status !== "connected") return;
      skip();

      let result;
      try {
        result = await gateway.request("tts.convert", {
          text: trimmed,
          provider,
          modelId,
          voiceId,
          channel,
        });
      } catch (err) {
        console.warn("[tts] tts.convert failed", err?.message ?? err);
        return;
      }
      const audioPath = result?.audioPath;
      if (!audioPath) {
        console.warn("[tts] no audioPath in response", result);
        return;
      }

      const reader = window.exuvia?.audio?.readBase64;
      if (!reader) {
        console.warn("[tts] window.exuvia.audio.readBase64 unavailable — running outside Electron?");
        return;
      }
      const base64 = await reader(audioPath);
      if (!base64) {
        console.warn("[tts] audio file read failed", audioPath);
        return;
      }

      const mime = mimeForFormat(result.outputFormat);
      const blob = base64ToBlob(base64, mime);
      const url = URL.createObjectURL(blob);
      lastUrlRef.current = url;

      const audio = new Audio(url);
      audioRef.current = audio;

      const words = trimmed.split(/\s+/).filter(Boolean);

      audio.onloadedmetadata = () => {
        const duration = Number.isFinite(audio.duration) ? audio.duration : 0;
        const timePerWord = words.length > 0 && duration > 0 ? duration / words.length : 0;
        audio
          .play()
          .then(() => {
            setProgress({ messageId, wordIndex: 0, showFull: false });
            let i = 1;
            if (timePerWord > 0) {
              intervalRef.current = setInterval(() => {
                if (i < words.length) {
                  setProgress({ messageId, wordIndex: i, showFull: false });
                  i += 1;
                } else {
                  clearInterval(intervalRef.current);
                  intervalRef.current = null;
                  setProgress({ messageId, wordIndex: words.length - 1, showFull: true });
                }
              }, timePerWord * 1000);
            } else {
              setProgress({ messageId, wordIndex: words.length - 1, showFull: true });
            }
          })
          .catch((err) => {
            console.warn("[tts] playback failed", err);
            skip();
          });
      };

      audio.onended = () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
          intervalRef.current = null;
        }
        setProgress({ messageId, wordIndex: words.length - 1, showFull: true });
        if (lastUrlRef.current === url) {
          URL.revokeObjectURL(url);
          lastUrlRef.current = null;
        }
        if (audioRef.current === audio) audioRef.current = null;
      };
    },
    [gateway, provider, modelId, voiceId, channel, skip],
  );

  return { progress, speak, skip };
}

function mimeForFormat(format) {
  const f = String(format ?? "").toLowerCase();
  if (f === "mp3") return "audio/mpeg";
  if (f === "wav" || f === "wave") return "audio/wav";
  if (f === "ogg" || f === "opus") return "audio/ogg";
  if (f === "webm") return "audio/webm";
  if (f === "flac") return "audio/flac";
  if (f === "aac" || f === "m4a") return "audio/aac";
  return "audio/mpeg";
}

function base64ToBlob(b64, mime) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
