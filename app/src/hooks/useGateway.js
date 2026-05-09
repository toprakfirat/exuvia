import { useEffect, useMemo, useRef, useState } from "react";
import { GatewayClient } from "../lib/gateway-client.js";

const DEFAULT_URL = "ws://127.0.0.1:18789";

export function useGateway() {
  const [settings, setSettings] = useState(null);
  const [status, setStatus] = useState("idle");
  const [helloOk, setHelloOk] = useState(null);
  const [lastError, setLastError] = useState(null);
  const clientRef = useRef(null);

  // Load settings + token on mount.
  // The scopeVersion guard invalidates device tokens issued before we asked
  // for operator.admin — old tokens are bound to their original scope set,
  // and the gateway won't auto-upgrade them.
  const SCOPE_VERSION = 2;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [stored, token] = await Promise.all([
        window.exuvia?.settings.get?.() ?? {},
        window.exuvia?.token.get?.() ?? null,
      ]);
      if (cancelled) return;
      const storedScopeVersion = stored.scopeVersion ?? 1;
      const tokenStillValid = storedScopeVersion >= SCOPE_VERSION;
      if (!tokenStillValid && token) {
        await window.exuvia?.token.set?.(null);
        await window.exuvia?.settings.set?.({ scopeVersion: SCOPE_VERSION });
      }
      setSettings({
        gatewayUrl: stored.gatewayUrl ?? DEFAULT_URL,
        sharedSecret: stored.sharedSecret ?? "",
        deviceToken: tokenStillValid ? token : null,
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Open the connection once we have settings and (a token or shared secret).
  useEffect(() => {
    if (!settings) return;
    if (!settings.deviceToken && !settings.sharedSecret) {
      setStatus("needs-setup");
      return;
    }

    const client = new GatewayClient({
      url: settings.gatewayUrl,
      token: settings.sharedSecret || null,
      deviceToken: settings.deviceToken,
      // We need operator.admin for agents.create / agents.delete /
      // sessions.reset / config.patch — anything that mutates avatar shape.
      // Read+write alone aren't enough; the gateway grants admin to the
      // shared-secret holder.
      scopes: [
        "operator.read",
        "operator.write",
        "operator.admin",
        "operator.approvals",
      ],
      onStatus: (s, detail) => {
        setStatus(s);
        if (s === "connected" && detail) setHelloOk(detail);
      },
      onDeviceToken: async (newToken) => {
        await window.exuvia?.token.set?.(newToken);
        setSettings((prev) => (prev ? { ...prev, deviceToken: newToken } : prev));
      },
      onError: (err) => {
        setLastError(err?.message ?? String(err));
      },
    });
    clientRef.current = client;
    client.connect();
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [settings?.gatewayUrl, settings?.sharedSecret, settings?.deviceToken]);

  const api = useMemo(
    () => ({
      status,
      lastError,
      helloOk,
      settings,
      saveSettings: async (patch) => {
        const merged = await window.exuvia?.settings.set?.(patch);
        setSettings((prev) => ({ ...(prev ?? {}), ...(merged ?? patch) }));
      },
      clearDeviceToken: async () => {
        await window.exuvia?.token.set?.(null);
        setSettings((prev) => (prev ? { ...prev, deviceToken: null } : prev));
      },
      request: (method, params) =>
        clientRef.current
          ? clientRef.current.request(method, params)
          : Promise.reject(new Error("not ready")),
      configPatch: (partial, opts) =>
        clientRef.current
          ? clientRef.current.configPatch(partial, opts)
          : Promise.reject(new Error("not ready")),
      on: (eventName, handler) =>
        clientRef.current ? clientRef.current.on(eventName, handler) : () => {},
    }),
    [status, lastError, helloOk, settings],
  );

  return api;
}
