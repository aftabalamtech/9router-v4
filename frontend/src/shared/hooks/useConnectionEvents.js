import { useEffect, useRef } from "react";
import { subscribeConnectionEvents } from "@/shared/utils/connectionEvents";

/**
 * Subscribe to live provider-connection events (SSE) for the lifetime of the
 * calling component. Handlers are read through refs so callers can pass
 * inline closures without resubscribing on every render.
 *
 * Re-renders are driven by what the handlers do (patching local state,
 * invalidating the cachedJson cache), keeping this hook free of its own state.
 *
 * @param {{ onEvent?: (event: object) => void, onRevision?: (rev: number) => void, onError?: () => void }} handlers
 */
export default function useConnectionEvents({ onEvent, onRevision, onError } = {}) {
  const handlersRef = useRef({ onEvent, onRevision, onError });
  handlersRef.current = { onEvent, onRevision, onError };

  useEffect(() => {
    return subscribeConnectionEvents({
      onEvent: (event) => handlersRef.current.onEvent?.(event),
      onRevision: (rev) => handlersRef.current.onRevision?.(rev),
      onError: () => handlersRef.current.onError?.(),
    });
  }, []);
}
