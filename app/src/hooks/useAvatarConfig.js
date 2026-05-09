import { useEffect, useState } from "react";

// Read the avatar metadata for a given agentId straight from the gateway's
// config.get response. The plugin owns this slot under
// plugins.entries.exuvia.config.avatars.<agentId>, but no plugin RPC is
// involved — claw exposes the same data via the standard config read.
export function useAvatarConfig(gateway, agentId, refreshKey = 0) {
  const [avatar, setAvatar] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!agentId || gateway.status !== "connected") {
      setAvatar(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await gateway.request("config.get", {});
        if (cancelled) return;
        const root = res?.config ?? res ?? {};
        const raw =
          root?.plugins?.entries?.exuvia?.config?.avatars?.[agentId] ?? null;
        if (!raw) {
          setAvatar(null);
        } else {
          // Normalize the legacy fbxPath alias to the canonical avatarPath.
          // Lights are stored without `id` fields (so openclaw's patch
          // merger replaces the array wholesale instead of merging by id).
          // Generate runtime ids here so the scene's reconciler can track
          // each light across renders.
          setAvatar({
            ...raw,
            avatarPath: raw.avatarPath ?? raw.fbxPath ?? "",
            lights: Array.isArray(raw.lights)
              ? raw.lights.map((l, i) => ({
                  ...l,
                  id: l.id ?? `light-${i}-${Math.random().toString(36).slice(2, 8)}`,
                }))
              : raw.lights,
          });
        }
      } catch (err) {
        if (!cancelled) setError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [gateway.status, agentId, refreshKey]);

  return { avatar, loading, error };
}
