import { useCallback, useEffect, useState } from "react";
import type { QueryClient } from "@tanstack/react-query";
import {
  openResources,
  type AppResources,
  type CoreResources,
} from "./resources";

// Settings opens with `core`; the chat needs every resource. A failure keeps
// the original error, with its stack and causes, for display.
export type Startup =
  | { status: "opening"; core: CoreResources | null }
  | { status: "ready"; core: CoreResources; resources: AppResources }
  | { status: "failed"; error: unknown };

const opening: Startup = { status: "opening", core: null };

// Resource scopes never overlap: each opening starts after the previous scope,
// including a late or failed opening, has been disposed.
let settled: Promise<unknown> = Promise.resolve();

// The single startup owner: retry by remounting the attempt, and disposal even
// when opening completes after unmount.
export function useResources(queryClient: QueryClient) {
  const [startup, setStartup] = useState<Startup>(opening);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let mounted = true;
    const opened = settled.then(() =>
      openResources(queryClient, (core) => {
        if (mounted) setStartup({ status: "opening", core });
      }),
    );
    opened.then(
      ({ resources }) => {
        if (mounted)
          setStartup({
            status: "ready",
            core: {
              connection: resources.connection,
              preferences: resources.preferences,
            },
            resources,
          });
      },
      (error: unknown) => {
        console.error("Could not open app data", error);
        if (mounted) setStartup({ status: "failed", error });
      },
    );
    return () => {
      mounted = false;
      // The disposed resources never show again, including when the effect
      // restarts under Fast Refresh.
      setStartup(opening);
      settled = opened
        .then(
          (scope) => scope.dispose(),
          () => undefined,
        )
        .catch((cause: unknown) => {
          console.error("Could not close app resources", cause);
        });
    };
  }, [queryClient, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { startup, retry };
}
