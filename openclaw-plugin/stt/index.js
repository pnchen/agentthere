import { buildRealtimeVoiceProvider } from "./src/index.js";

export default function (api) {
  if (api.registrationMode !== "cli-metadata") {
    api.registerRealtimeVoiceProvider(buildRealtimeVoiceProvider());
  }
}
