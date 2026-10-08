import { useOnlineStatus } from "./useOnlineStatus.js";

export function App() {
  const online = useOnlineStatus();
  return (
    <main>
      <h1>Cafe Loyalty Counter</h1>
      <p role="status" aria-live="polite">
        {online ? "Online" : "Offline: stamps are saved on this phone and sync when the connection returns."}
      </p>
      <p>Build {__BUILD_ID__}</p>
    </main>
  );
}
